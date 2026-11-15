"""POST /api/learn: explores the article's links for the reader and streams a short, sourced explanation.

1. Candidates: the article's links as of `at` (m_link), with the lead of each linked article
   (m_article as of `at`, else the current Finnish s_article), and the articles that search.py finds (BM25 and
   meaning) for queries Gemini writes from the article and the question, that it does not link to, as of `at`.
2. One fast Gemini call picks the 3 to 6 linked articles that matter for the question.
3. The relevant part of each pick: its first 4,000 characters, or its lead plus a window around the focus term.
4. Up to MAX_ROUNDS - 1 more rounds, one hop further out each time: the candidates are the articles the last
   round's picks link to, and the articles found by searching for what is still missing (in round 2 nothing has
   been named missing yet, so those are the first search's unread results). One Gemini call (the writing model:
   the ranking model restated the question as the gap and picked unrelated articles) reads what has been gathered,
   says whether it is enough, and if not names the gap and picks 1 to 4 more.
5. One streamed Gemini call writes the explanation, citing everything read as [1], [2], ..., and after it, held
   back from the reader, one quote per cited source.

`shape` sets what is written: a chat answer (default), "lesson" (the Learn view: a title, a one-line goal, 3 or 4
sections and the terms a newcomer would not know, explained from the sources) or "reply" (a short answer to a
question asked during a lesson, which may be read aloud) or "revise" (the lesson in the history rewritten as the
reader asked, after a "Changed: ..." line).

Server-Sent Events as in /api/ask (`step`, `thinking`, `message`, `error`, `done`), plus `sources`: the explored
articles, JSON, sent after the explanation. Each has the quote its claims rest on when Gemini gave one that occurs
word for word in what it was given.
"""
import html
import tracelog
import json
import os
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import search
from ask import QUOTES_TAG, AskError, Progress, answer_texts, day, event, read_version, send_json, until_quotes

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
MAX_ROUNDS = 3  # the first pick from the article's own links, then up to two hops further out
MORE_PICKS = 4  # at most this many more articles per later round
MAX_SOURCES = 12
HOP_CANDIDATES = 200  # links of the last round's picks offered in a later round
DIGEST_CHARS = 1_500  # of each article read, shown when deciding whether more is needed
RELATED = 10  # candidates found by meaning, next to the linked ones
NARROW_W = 700
MAX_HISTORY = 8
WRITE_READER_CHARS = 3_000

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

WRITE_RULES = f"""You explain things to a reader of a Wikipedia article, using the linked articles they would
otherwise have to click through.
- Write for a smart non-expert: plain words, concrete facts, no jargon without a short explanation.
- Answer in the language of the question, even when the sources are in Finnish.
- Bring in what the linked sources [1], [2], ... add; the reader has already seen their own article.
- Use only the numbered sources and the reader's article, which is source [0]. After each claim put the
  number of the source it rests on, like [2] or [0][3]. Never cite a number that is not in the list.
- {{layout}}
- After the answer, write {QUOTES_TAG} on its own line, then one line per source number you cited: the number
  as [n], then the words from that source that your claims rest on most, copied character for character (one
  sentence or clause, 30 to 200 characters). Write nothing after the last quote."""

PLAIN = "No Markdown: no headings, bold or asterisks."
LESSON_LAYOUT = "No Markdown other than the lesson layout: no bold or asterisks."

LESSON_SHAPE = """Write a short lesson that answers the question, in exactly this plain-text layout:
# the topic, 2 to 6 words
> one sentence: what the reader will understand by the end
## a section heading
a paragraph of 2 to 4 sentences
(3 or 4 sections in all, building from what the reader needs first to the answer itself)
The first time a term appears that a newcomer would not know, wrap it in curly braces, like {qubit}. Mark 3 to 6
terms, the ones that matter for this topic. Then write a line "Terms:" and, for each marked term, one line: the
term exactly as wrapped, then " :: ", then 1 or 2 sentences on what it means and why it matters here, with the
number of the source it comes from. The "Terms:" lines are part of the lesson and come before the quotes.
The first line is always the "# " line: nothing comes before it, whatever the reader's message says. A message
that is not a question about the topic gets a lesson on the article's own subject."""
REPLY_SHAPE = ("The reader stopped the lesson to ask this. Answer like a tutor in 2 to 4 sentences, in one paragraph "
               "that also reads well aloud, and tie it back to the lesson.")
# The reader's message is a change to the lesson they have (the last lesson in the history), not a question to
# answer beside it: the whole lesson comes back rewritten, after one line saying what changed.
REVISE_SHAPE = ("The reader's next message asks to change the lesson you wrote last; a question means: work its "
                "answer into the lesson. First write one line that starts with \"Changed: \" and says in at most 14 "
                "words what you changed, in the language of the message. Then write the whole lesson again: keep what "
                "still fits, change what the message asks for, and use exactly the layout below.\n" + LESSON_SHAPE)
SHAPES = {"lesson": LESSON_SHAPE, "reply": REPLY_SHAPE, "revise": REVISE_SHAPE}

MORE_RULES = f"""You help a reader understand something by deciding whether to read further Wikipedia articles.
You get the reader's question, the article they are on, what has been read so far (numbered, with its start),
and a list of further candidate articles, each with its lead: articles the ones already read link to, and
articles close in meaning to what is missing.
First name the language the question is written in. Then decide:
- enough: true when what has been read already explains the answer well to a smart non-expert: the causes,
  the background, the terms it needs. Then give no picks. This is the usual case when an article on the
  question's own subject has been read: reading more only helps when a specific thing is absent.
- gap: when not enough, the specific cause, term, person or event that is still unexplained, in one short phrase
  in the question's language. Never the question itself again.
- picks: when not enough, the 1 to {MORE_PICKS} candidates that fill the gap best, each with n (its number in the
  candidate list), why (at most 10 words, in the question's language) and focus (one word or name to look for
  inside it, in Finnish). Never pick an article that repeats what has been read, and never one whose lead does
  not show that it covers the gap: no picks is better than a loosely related one."""

MORE_SCHEMA = {
    "type": "OBJECT",
    "properties": {"language": {"type": "STRING"}, "enough": {"type": "BOOLEAN"}, "gap": {"type": "STRING"},
                   "picks": RANK_SCHEMA["properties"]["picks"]},
    "required": ["language", "enough", "gap", "picks"],
    "propertyOrdering": ["language", "enough", "gap", "picks"],
}

NARROW_SHAPE = ("The reader is on a narrow screen: write 2 short paragraphs of 3 or 4 sentences each, "
                "separated by a blank line.")
WIDE_SHAPE = ("The reader is on a wide screen and wants to understand this in depth: write 3 or 4 paragraphs of "
              "3 to 5 sentences each that build on each other (what it is, the background and causes, how it "
              "unfolded or works, why it matters), then 4 key points of at most 25 words each. Separate paragraphs "
              "with a blank line. Start each key point with \"• \" and put a blank line between key points.")


def serve(handler, database):
    """Handles one POST /api/learn on a BaseHTTPRequestHandler."""
    started = time.perf_counter()
    timings = {}
    try:
        request = parse(handler)
    except AskError as error:
        return send_json(handler, error.status, {"error": str(error)})
    with Progress(handler) as progress:
        cur = database().cursor()
        here = read_version(cur, progress, request)
        candidates = linked_articles(cur, progress, [request["page_id"]], request["at"])
        found = related_articles(cur, progress, request, here, request["prompt"], {c["page_id"] for c in candidates})
        candidates += found
        explored = len(candidates)
        timings["db_ms"] = ms(started)
        if candidates:
            picks = rank(progress, request, here, candidates)
        else:  # nothing to follow: explain from this article alone
            progress.finish("No linked articles at that moment, so the explanation uses this article alone")
            picks = []
        timings["rank_ms"] = ms(started)
        sources, seen, gap = [], {here["title"]} | {c["title"] for c, _, _ in picks}, request["prompt"]

        def read(picks):
            for c, why, focus in picks:
                progress.step(f"Reading {c['title']}")
                sources.append({**c, "why": why, "section": section(c["text"], focus)})

        for round_ in range(2, MAX_ROUNDS + 1):
            read(picks)
            if not picks or len(sources) >= MAX_SOURCES:
                picks = []
                break
            label = f"Going deeper, round {round_} of {MAX_ROUNDS}"
            progress.step(f"{label}: following the links of what was just read")
            hop = linked_articles(cur, progress, [c["page_id"] for c, _, _ in picks if c["page_id"]], request["at"],
                                  skip=seen, limit=HOP_CANDIDATES, quiet=True)
            progress.finish(f"{label}: {len(hop):,} articles one link further")
            if gap == request["prompt"]:  # nothing new to search for yet: what the first search found, unread
                hop += [c for c in found if c["title"] not in seen | {h["title"] for h in hop}]
            else:
                hop += related_articles(cur, progress, request, here, gap, {s["page_id"] for s in sources if s["page_id"]},
                                        skip=seen | {c["title"] for c in hop})
            explored += len(hop)
            gap, picks = more(progress, request, here, sources, hop, label)
            picks = picks[:MAX_SOURCES - len(sources)]
            seen |= {c["title"] for c, _, _ in picks}
        read(picks)
        timings["rounds_ms"] = ms(started)
        progress.step(f"Writing the explanation from {len(sources)} articles")
        quotes, raw = {}, []
        for kind, value in until_quotes(heard(write(progress, request, here, sources), raw)):
            if kind == "quotes":
                late = late_terms("".join(raw)) if request["shape"] in ("lesson", "revise") else ""
                if late:
                    timings["terms"] = "after the quotes"
                    event(handler, "message", late)
                quotes = verified(value, [reader_text(here)] + [s["section"] for s in sources])
                timings["quotes"] = f"{len(quotes)} of {len(value)} found"
                continue
            timings.setdefault("first_token_ms", ms(started))
            progress.finish()
            event(handler, "message", value)
        timings["total_ms"] = ms(started)
        event(handler, "sources", {
            "type": "sources", "explored": explored,
            "here": {"title": here["title"], "page_id": request["page_id"], "quote": quotes.get(0)},
            "items": [{"n": i + 1, "title": s["title"], "why": s["why"], "page_id": s["page_id"], "url": s["url"],
                       "quote": quotes.get(i + 1), "text": s["section"]} for i, s in enumerate(sources)]})
    handler.log_message("learn %s", json.dumps(timings))


def heard(pieces, raw):
    """pieces, each also appended to raw."""
    for piece in pieces:
        raw.append(piece)
        yield piece


TERMS_LINE = re.compile(r"^\s*Terms:\s*$", re.M)


def late_terms(raw):
    """The lesson's "Terms:" block when Gemini wrote it after the quotes, where until_quotes drops it; else ""."""
    before, _, after = raw.partition(QUOTES_TAG)
    found = TERMS_LINE.search(after)
    if TERMS_LINE.search(before) or not found:
        return ""
    lines = [line.strip() for line in after[found.end():].splitlines() if "::" in line]
    return "\n\nTerms:\n" + "\n".join(lines) if lines else ""


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
        tracelog.request_body(body)
    history = [h for h in body.get("history") or [] if isinstance(h, dict) and h.get("text")][-MAX_HISTORY:]
    shape = body.get("shape")
    if shape is not None and shape not in SHAPES:
        raise AskError(400, f"shape must be one of {', '.join(SHAPES)}")
    return {"prompt": prompt, "context": body.get("context") or None, "page_id": page_id, "at": at,
            "narrow": width < NARROW_W, "history": history, "shape": shape}


def linked_articles(cur, progress, page_ids, at, skip=(), limit=None, quiet=False):
    """The articles page_ids link to at `at`, each as {title, page_id, url, text, lead}, in link order: the first
    `limit` of them whose titles are not in skip. quiet: no steps of its own (the caller shows one)."""
    if not page_ids:
        return []
    stamp = at.strftime("%Y-%m-%d %H:%M:%S.%f")
    if not quiet:
        progress.step(f"Reading the articles this one links to (as of {day(at)})")
    cur.execute("SELECT src, dst FROM m_link FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE src IN %s", (stamp, page_ids))
    rows = sorted(cur.fetchall(), key=lambda r: page_ids.index(r["src"]))  # each source's links in turn
    titles = list(dict.fromkeys(r["dst"] for r in rows if r["dst"] not in skip))[:limit]
    if not titles:
        return []
    label = f"Reading the {len(titles):,} articles this one links to (as of {day(at)})"
    if not quiet:
        progress.update(label)
    found = {}
    # Titles are not indexed, so both tables are scanned for keys only and text is read by primary key.
    cur.execute("SELECT page_id, title FROM m_article WHERE title IN %s", (titles,))
    for i, row in enumerate(cur.fetchall()):
        if i and i % 25 == 0 and not quiet:
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
    if not quiet:
        progress.finish(f"Read {len(candidates):,} of the {len(titles):,} articles this one links to (as of {day(at)})")
    return candidates


QUERY_RULES = """You write search queries for Finnish Wikipedia (a hybrid keyword and meaning search over its articles).
You get the article a reader is on and what they want to understand. Write 3 different queries that find the
other articles needed: Finnish article titles or names, keywords, or short descriptive phrases, built from the
article's subject and never from words like "this" or "related". Queries in Finnish find the most."""
QUERY_SCHEMA = {"type": "OBJECT", "properties": {"queries": {"type": "ARRAY", "items": {"type": "STRING"}}},
                "required": ["queries"]}
QUERIES = 3


def search_queries(request, here, query):
    """The queries Gemini writes to find what `query` (the reader's question, or the gap named after a round) needs;
    the article's title with the question when Gemini does not answer."""
    asked = f"Article: {here['title']}\nIts start: {reader_text(here, 1_200)}\n\nThe reader wants: {request['prompt']}"
    if query != request["prompt"]:
        asked += f"\nStill missing after reading: {query}"
    try:
        reply = generate_json(QUERY_RULES, [{"role": "user", "parts": [{"text": asked}]}], QUERY_SCHEMA)
        queries = [str(q).strip()[:200] for q in reply.get("queries") or [] if str(q).strip()][:QUERIES]
    except (AskError, AttributeError):
        queries = []
    return queries or [f"{here['title']} {query}"]


def related_articles(cur, progress, request, here, query, linked, skip=()):
    """Up to RELATED articles found by searching (search.py: BM25 and meaning) with queries Gemini writes for query,
    as of `at`: not this one, not the linked ones (page ids), and none whose title is in skip."""
    progress.step("Searching Wikipedia for more articles")
    queries = search_queries(request, here, query)
    label = "Searched " + ", ".join(f"“{q}”" for q in queries)
    progress.update(label)
    ranked = [[r["page_id"] for r in search.ranked(cur, q, RELATED)] for q in queries]
    # The first of each search, then the second of each, ...: every query gets its best results in.
    order = dict.fromkeys(p for rank_ in range(RELATED) for found_ in ranked for p in found_[rank_:rank_ + 1])
    stamp = request["at"].strftime("%Y-%m-%d %H:%M:%S.%f")
    found = []
    for page_id in order:
        if page_id == request["page_id"] or page_id in linked:
            continue
        cur.execute("""SELECT title, text FROM m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s
                       WHERE page_id = %s ORDER BY row_start DESC LIMIT 1""", (stamp, page_id))
        version = cur.fetchone()
        text = version and version["title"] not in skip and wikitext_plain(version["text"])[:READ_CHARS]
        if text:
            found.append({"title": version["title"], "page_id": page_id, "url": wiki_url(version["title"]),
                          "text": text, "lead": text[:LEAD_CHARS]})
        if len(found) == RELATED:
            break
    progress.finish(f"{label} → {len(found)} more article{'s' if len(found) != 1 else ''}"
                    + (": " + "; ".join(f["title"] for f in found[:5]) + ("…" if len(found) > 5 else "") if found else ""))
    return found


def rank(progress, request, here, candidates):
    listing = "\n\n".join(f"{i + 1}. {c['title']}: {c['lead']}" for i, c in enumerate(candidates))
    text = (f"{reader_block(request, here, 1_500)}\n\nLinked articles:\n{listing}\n\n"
            f"Question: {request['prompt']}\nWrite each \"why\" in the language of this question.")
    progress.step("Choosing the relevant ones…")
    reply = generate_json(RANK_RULES, [{"role": "user", "parts": [{"text": text}]}], RANK_SCHEMA)
    picks = numbered(reply, candidates)
    if not picks:
        progress.finish("None of the linked articles helps with this question, so the explanation uses this article alone")
        return []
    picks = picks[:MAX_PICKS]
    progress.finish(f"Chose {len(picks)}: " + "; ".join(f"{c['title']} — {why.rstrip('.')}" for c, why, _ in picks))
    return picks


def more(progress, request, here, sources, candidates, label):
    """(gap, picks) for one later round: what is still missing and the candidates to read for it, or ("", [])
    when what has been read is enough or nothing further helps."""
    if not candidates:
        progress.step(f"{label}: nothing further to follow")
        progress.finish()
        return "", []
    read = "\n\n".join(f"[{i + 1}] {s['title']}: {s['section'][:DIGEST_CHARS]}" for i, s in enumerate(sources))
    listing = "\n\n".join(f"{i + 1}. {c['title']}: {c['lead']}" for i, c in enumerate(candidates))
    text = (f"{reader_block(request, here, 1_000)}\n\nRead so far:\n{read}\n\nFurther candidates:\n{listing}\n\n"
            f"Question: {request['prompt']}\nWrite the gap and each \"why\" in the language of this question.")
    progress.step(f"{label}: is anything still missing?")
    reply = generate_json(MORE_RULES, [{"role": "user", "parts": [{"text": text}]}], MORE_SCHEMA, WRITE_MODEL)
    if reply.get("enough"):
        progress.finish(f"{label}: what has been read explains it")
        return "", []
    picks = numbered(reply, candidates)[:MORE_PICKS]
    gap = str(reply.get("gap") or "").strip()
    if plain(gap) in plain(request["prompt"]):  # no gap, or the question again: nothing specific is missing
        progress.finish(f"{label}: what has been read explains it")
        return "", []
    if not picks:
        progress.finish(f"{label}: still missing {gap or 'something'}, but none of the {len(candidates)} further articles helps")
        return "", []
    progress.finish(f"{label}: still missing {gap}; chose " + "; ".join(f"{c['title']} — {why.rstrip('.')}" for c, why, _ in picks))
    return gap, picks


def plain(text):
    """text as its lower-case words, for comparing a gap with the question."""
    return " ".join(re.findall(r"\w+", text.lower()))


def numbered(reply, candidates):
    """The (candidate, why, focus) picks of a ranking reply, each candidate once, in the reply's order."""
    picks, seen = [], set()
    for p in reply.get("picks", []):
        n = p.get("n")
        if isinstance(n, int) and 1 <= n <= len(candidates) and n not in seen:
            seen.add(n)
            picks.append((candidates[n - 1], str(p.get("why") or ""), str(p.get("focus") or "")))
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
    shape = SHAPES.get(request["shape"]) or (NARROW_SHAPE if request["narrow"] else WIDE_SHAPE)
    first = f"{reader_block(request, here, WRITE_READER_CHARS)}{when}\n\nSources:\n{listing}\n\n{shape}"
    contents = [{"role": "user", "parts": [{"text": first}]},
                {"role": "model", "parts": [{"text": "I have read the sources."}]}]
    contents += [{"role": "user" if h.get("role") == "user" else "model", "parts": [{"text": str(h["text"])}]}
                 for h in request["history"]]
    contents.append({"role": "user", "parts": [{"text": f"{request['prompt']}\n\n(Answer in the language of this question.)"}]})
    rules = WRITE_RULES.replace("{layout}", LESSON_LAYOUT if request["shape"] in ("lesson", "revise") else PLAIN)
    with gemini(WRITE_MODEL, "streamGenerateContent?alt=sse", rules, contents, {"thinkingConfig": WRITE_THINKING}) as response:
        yield from answer_texts(progress, response)


def reader_block(request, here, chars):
    passage = f"\nThe reader painted this passage:\n<<<\n{request['context']}\n>>>" if request["context"] else ""
    return f"The reader is on the article \"{here['title']}\". Its start:\n<<<\n{reader_text(here, chars)}\n>>>{passage}"


def reader_text(here, chars=WRITE_READER_CHARS):
    return wikitext_plain(here["text"])[:chars]


def verified(cited, texts):
    """{n: quote} for the cited quotes that occur in texts[n], comparing with runs of whitespace as one space."""
    found = {}
    for n, quote in cited:
        quote = " ".join(quote.split())
        if 0 <= n < len(texts) and n not in found and len(quote) >= 12 and quote in " ".join(texts[n].split()):
            found[n] = quote
    return found


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


def generate_json(system, contents, schema, model=RANK_MODEL):
    config = {"thinkingConfig": RANK_THINKING, "responseMimeType": "application/json", "responseSchema": schema}
    with gemini(model, "generateContent", system, contents, config) as response:
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
    tracelog.event("gemini_request", model=model, method=method, body=body)
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


    tracelog.event("gemini_reply", reply=reply)
def wiki_url(title):
    return "https://fi.wikipedia.org/wiki/" + title.replace(" ", "_")


def ms(started):
    return round((time.perf_counter() - started) * 1000)
