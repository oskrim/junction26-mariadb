"""POST /api/learn: explores the article's links for the reader and streams a short, sourced explanation.

1. Candidates: the article's links as of `at` (m_link), with the lead of each linked article
   (m_article as of `at`, else the current Finnish s_article).
2. One fast Gemini call picks the 3 to 6 linked articles that matter for the question.
3. The relevant part of each pick: its first 4,000 characters, or its lead plus a window around the focus term.
4. One streamed Gemini call writes the explanation, citing the picks as [1], [2], ...

Server-Sent Events as in /api/ask (`step`, `thinking`, `message`, `error`, `done`), plus `sources`: the explored
articles, JSON, sent before the explanation.
"""
import html
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from ask import AskError, Progress, answer_texts, day, event, read_version, send_json

# Measured on page 1150 with 150 links: ranking takes ~1.4 s on 3.5 Flash Lite and ~4 s on 3.8 Flash; writing
# takes ~3 s on 3.5 Flash and ~5.5 s on 3.8 Flash, and 3.5 Flash Lite ignores the language of the question.
RANK_MODEL, RANK_THINKING = "gemini-3.5-flash-lite", {"thinkingLevel": "minimal"}
WRITE_MODEL, WRITE_THINKING = "gemini-3.5-flash", {"thinkingLevel": "minimal", "includeThoughts": True}
API = "https://generativelanguage.googleapis.com/v1beta/models/"
TIMEOUT_S = 30
LEAD_CHARS = 500
READ_CHARS = 20_000
SECTION_CHARS = 4_000
SECTION_LEAD = 1_200
MIN_PICKS, MAX_PICKS = 3, 6
NARROW_W = 700
MAX_HISTORY = 8

RANK_RULES = f"""You help a reader understand a Wikipedia article by choosing which linked articles to read.
You get the reader's question, the article they are on, and its linked articles, each with its lead.
Pick the {MIN_PICKS} to {MAX_PICKS} linked articles that best explain the answer to a smart non-expert:
causes, prerequisites, definitions, key people and events. Prefer substance over lists, films or places.
First name the language the question is written in. Then, for each pick, give:
- n: its number in the list,
- why: why it helps, at most 10 words, written in the question's language (not the articles' language),
- focus: one word or name to look for inside that article (in Finnish, as the article would write it)."""

RANK_SCHEMA = {
    "type": "OBJECT",
    "properties": {"language": {"type": "STRING"}, "picks": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
        "n": {"type": "INTEGER"}, "why": {"type": "STRING"}, "focus": {"type": "STRING"}},
        "required": ["n", "why", "focus"]}}},
    "required": ["language", "picks"],
    "propertyOrdering": ["language", "picks"],
}

WRITE_RULES = """You explain things to a reader of a Wikipedia article, using the linked articles they would
otherwise have to click through.
- Write for a smart non-expert: plain words, concrete facts, no jargon without a short explanation.
- Answer in the language of the question, even when the sources are in Finnish.
- Bring in what the linked sources [1], [2], ... add; the reader has already seen their own article.
- Use only the numbered sources and the reader's article, which is source [0]. After each claim put the
  number of the source it rests on, like [2] or [0][3]. Never cite a number that is not in the list.
- No Markdown: no headings, bold or asterisks."""

NARROW_SHAPE = "The reader is on a narrow screen: write about 4 sentences in one paragraph."
WIDE_SHAPE = ("The reader is on a wide screen: write 2 short paragraphs of 2 or 3 sentences each, then 3 "
              "key points of at most 20 words each. Separate paragraphs with a blank line. Start each key point "
              "with \"• \" and put a blank line between key points.")


def serve(handler, connect):
    """Handles one POST /api/learn on a BaseHTTPRequestHandler."""
    started = time.perf_counter()
    timings = {}
    try:
        request = parse(handler)
    except AskError as error:
        return send_json(handler, error.status, {"error": str(error)})
    with Progress(handler, [("Access-Control-Allow-Origin", "*")]) as progress:
        con = connect()
        try:
            cur = con.cursor()
            here = read_version(cur, progress, request)
            candidates = linked_articles(cur, progress, request["page_id"], request["at"])
        finally:
            con.close()
        timings["db_ms"] = ms(started)
        if not candidates:
            raise AskError(404, "the article has no linked articles at that moment")
        picks = rank(progress, request, here, candidates)
        timings["rank_ms"] = ms(started)
        sources = []
        for c, why, focus in picks:
            progress.step(f"Reading {c['title']}")
            sources.append({**c, "why": why, "section": section(c["text"], focus)})
        event(handler, "sources", {
            "type": "sources", "explored": len(candidates), "here": {"title": here["title"], "page_id": request["page_id"]},
            "items": [{"n": i + 1, "title": s["title"], "why": s["why"], "page_id": s["page_id"], "url": s["url"]}
                      for i, s in enumerate(sources)]})
        progress.step("Writing the explanation")
        for piece in write(progress, request, here, sources):
            timings.setdefault("first_token_ms", ms(started))
            progress.finish()
            event(handler, "message", piece)
        timings["total_ms"] = ms(started)
    handler.log_message("learn %s", json.dumps(timings))


def parse(handler):
    try:
        body = json.loads(handler.rfile.read(int(handler.headers.get("Content-Length", 0))))
        prompt = str(body["prompt"]).strip()
        page_id = int(body["page_id"])
        at = datetime.fromtimestamp(float(body["at"]), timezone.utc).replace(tzinfo=None)
        width = int((body.get("viewport") or {}).get("w") or 1200)
    except (ValueError, KeyError, TypeError, AttributeError) as error:
        raise AskError(400, f"bad request: {error}")
    if not prompt:
        raise AskError(400, "prompt must not be empty")
    history = [h for h in body.get("history") or [] if isinstance(h, dict) and h.get("text")][-MAX_HISTORY:]
    return {"prompt": prompt, "context": body.get("context") or None, "page_id": page_id, "at": at,
            "narrow": width < NARROW_W, "history": history}


def linked_articles(cur, progress, page_id, at):
    """The articles page_id links to at `at`, each as {title, page_id, url, text, lead}, in link order."""
    stamp = at.strftime("%Y-%m-%d %H:%M:%S.%f")
    progress.step(f"Reading the articles this one links to (as of {day(at)})")
    cur.execute("SELECT dst FROM m_link FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE src = %s", (stamp, page_id))
    titles = [r["dst"] for r in cur.fetchall()]
    if not titles:
        return []
    label = f"Reading the {len(titles):,} articles this one links to (as of {day(at)})"
    progress.update(label)
    found = {}
    # Titles are not indexed, so both tables are scanned for keys only and text is read by primary key.
    cur.execute("SELECT page_id, title FROM m_article WHERE title IN %s", (titles,))
    for i, row in enumerate(cur.fetchall()):
        if i and i % 25 == 0:
            progress.update(f"{label}: {i} read")
        cur.execute("""SELECT title, text FROM m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s
                       WHERE page_id = %s ORDER BY row_start DESC LIMIT 1""", (stamp, row["page_id"]))
        version = cur.fetchone()
        if version:
            found[row["title"]] = {"title": row["title"], "page_id": row["page_id"], "url": wiki_url(row["title"]),
                                   "text": wikitext_plain(version["text"])[:READ_CHARS]}
    rest = [t for t in titles if t not in found]
    if rest:
        cur.execute("SELECT page_id FROM s_article WHERE lang = 'fi' AND title IN %s", (rest,))
        ids = [r["page_id"] for r in cur.fetchall()] or [0]
        cur.execute("""SELECT title, url, SUBSTRING(text, 1, %s) AS text FROM s_article
                       WHERE lang = 'fi' AND page_id IN %s""", (READ_CHARS * 2, ids))
        for row in cur.fetchall():
            found[row["title"]] = {"title": row["title"], "page_id": None, "url": row["url"],
                                   "text": markdown_plain(row["text"])[:READ_CHARS]}
    candidates = [{**found[t], "lead": found[t]["text"][:LEAD_CHARS]} for t in titles if t in found and found[t]["text"]]
    progress.finish(f"Read {len(candidates):,} of the {len(titles):,} articles this one links to (as of {day(at)})")
    return candidates


def rank(progress, request, here, candidates):
    listing = "\n\n".join(f"{i + 1}. {c['title']}: {c['lead']}" for i, c in enumerate(candidates))
    text = (f"{reader_block(request, here, 1_500)}\n\nLinked articles:\n{listing}\n\n"
            f"Question: {request['prompt']}\nWrite each \"why\" in the language of this question.")
    progress.step("Choosing the relevant ones…")
    reply = generate_json(RANK_RULES, [{"role": "user", "parts": [{"text": text}]}], RANK_SCHEMA)
    picks, seen = [], set()
    for p in reply.get("picks", []):
        n = p.get("n")
        if isinstance(n, int) and 1 <= n <= len(candidates) and n not in seen:
            seen.add(n)
            picks.append((candidates[n - 1], str(p.get("why") or ""), str(p.get("focus") or "")))
    if not picks:
        raise AskError(502, "Gemini picked no linked articles")
    picks = picks[:MAX_PICKS]
    progress.finish(f"Chose {len(picks)}: " + "; ".join(f"{c['title']} — {why.rstrip('.')}" for c, why, _ in picks))
    return picks


def section(text, focus):
    """The first SECTION_CHARS of text, or its lead plus a window around the focus term when that comes later."""
    at = text.lower().find(focus.lower(), SECTION_CHARS // 2) if len(focus) >= 3 else -1
    if at < 0:
        return text[:SECTION_CHARS]
    start = max(SECTION_LEAD, at - (SECTION_CHARS - SECTION_LEAD) // 3)
    return text[:SECTION_LEAD] + " … " + text[start:start + SECTION_CHARS - SECTION_LEAD]


def write(progress, request, here, sources):
    listing = "\n\n".join(f"[{i + 1}] {s['title']}\n{s['section']}" for i, s in enumerate(sources))
    when = ("" if (datetime.now(timezone.utc).replace(tzinfo=None) - request["at"]).days < 2 else
            f"\nThe reader is looking at the article as it was on {request['at']:%d %B %Y}.")
    first = (f"{reader_block(request, here, 3_000)}{when}\n\nSources:\n{listing}\n\n"
             f"{NARROW_SHAPE if request['narrow'] else WIDE_SHAPE}")
    contents = [{"role": "user", "parts": [{"text": first}]},
                {"role": "model", "parts": [{"text": "I have read the sources."}]}]
    contents += [{"role": "user" if h.get("role") == "user" else "model", "parts": [{"text": str(h["text"])}]}
                 for h in request["history"]]
    contents.append({"role": "user", "parts": [{"text": f"{request['prompt']}\n\n(Answer in the language of this question.)"}]})
    with gemini(WRITE_MODEL, "streamGenerateContent?alt=sse", WRITE_RULES, contents, {"thinkingConfig": WRITE_THINKING}) as response:
        yield from answer_texts(progress, response)


def reader_block(request, here, chars):
    passage = f"\nThe reader painted this passage:\n<<<\n{request['context']}\n>>>" if request["context"] else ""
    return f"The reader is on the article \"{here['title']}\". Its start:\n<<<\n{wikitext_plain(here['text'])[:chars]}\n>>>{passage}"


def gemini(model, method, system, contents, config):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise AskError(503, "GEMINI_API_KEY is not set on the server")
    body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents, "generationConfig": config}
    request = urllib.request.Request(f"{API}{model}:{method}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        return urllib.request.urlopen(request, timeout=TIMEOUT_S)
    except urllib.error.HTTPError as error:
        raise AskError(502, f"Gemini returned {error.code}: {error.read()[:300].decode(errors='replace')}")
    except OSError as error:
        raise AskError(502, f"Gemini is unreachable: {error}")


def generate_json(system, contents, schema):
    config = {"thinkingConfig": RANK_THINKING, "responseMimeType": "application/json", "responseSchema": schema}
    with gemini(RANK_MODEL, "generateContent", system, contents, config) as response:
        reply = json.loads(response.read())
    try:
        return json.loads("".join(texts(reply)))
    except ValueError as error:
        raise AskError(502, f"Gemini returned no usable answer: {error}")


def texts(chunk):
    for candidate in chunk.get("candidates", []):
        for part in candidate.get("content", {}).get("parts", []):
            if part.get("text") and not part.get("thought"):
                yield part["text"]


def wikitext_plain(wikitext):
    """Wiki markup as readable text: no infobox, tables, templates, refs or link brackets."""
    text = "\n".join(line for line in wikitext.splitlines() if not line.lstrip().startswith(("|", "{|", "!", "}")))
    text = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->|<[^>]+>", "", html.unescape(text), flags=re.S)
    for _ in range(4):  # nested templates, innermost first
        text = re.sub(r"\{\{[^{}]*\}\}", "", text)
    text = re.sub(r"\[\[(?:Tiedosto|Kuva|File|Image|Luokka|Category):[^\[\]]*(?:\[\[[^\]]*\]\][^\[\]]*)*\]\]", "", text, flags=re.I)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[https?://\S+ ([^\]]*)\]", r"\1", text)
    text = re.sub(r"'{2,}|^=+\s*|\s*=+$", "", text, flags=re.M)
    return re.sub(r"\n{2,}", "\n", re.sub(r"[ \t]+", " ", text)).strip()


def markdown_plain(markdown):
    """S-article Markdown as readable text: no images, tables or link targets."""
    lines = [line for line in markdown.splitlines() if not line.lstrip().startswith(("|", "!["))]
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", "\n".join(lines))
    text = re.sub(r"^#+\s*|\*\*|__", "", text, flags=re.M)
    return re.sub(r"\n{2,}", "\n", re.sub(r"[ \t]+", " ", text)).strip()


def wiki_url(title):
    return "https://fi.wikipedia.org/wiki/" + title.replace(" ", "_")


def ms(started):
    return round((time.perf_counter() - started) * 1000)
