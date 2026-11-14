"""POST /api/ask: answers about one article as it was at a moment, with Gemini.

ask   streams the answer as Server-Sent Events (data: <JSON string>).
find  returns JSON {text, attachment}: quotes that answer the prompt, when the top one first appeared,
      and other articles that mention the key term.
"""
import bisect
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone

MODEL = "gemini-3.8-flash"
API = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL
TIMEOUT_S = 60
MAX_TEXT = 400_000
MAX_HISTORY = 12

ASK_RULES = """You answer questions about one Wikipedia article for a reader.
- Answer in the language of the question, not the language of the article.
- Ground every claim in the article text and edit facts given below. If they do not say, say so plainly.
- Keep it short: 3 to 6 sentences, plain prose, no Markdown, no lists.
- Say which version you read, by its date (for example "In the version of 12 September 2026, ...")."""

FIND_RULES = """You find where one Wikipedia article says something. Read the article wikitext and return:
- quotes: up to 5 passages that best answer the request, most relevant first. Each "text" is copied
  character for character from the wikitext (one sentence or clause, 40 to 300 characters, no <ref> tags).
  Prefer prose sentences; use a table row or template only when no sentence says it. "section" is the heading it is under ("" for the lead).
- term: the key word or name from the request, in the article's language, cut to its stem so that a substring
  search also finds inflected forms (for example "vankileir" for "vankileirit", "Mannerhei" for "Mannerheimin").
- summary: one sentence, in the language of the request, saying what the quotes show."""

FIND_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "quotes": {"type": "ARRAY", "items": {"type": "OBJECT", "properties": {
            "text": {"type": "STRING"}, "section": {"type": "STRING"}}, "required": ["text", "section"]}},
        "term": {"type": "STRING"},
        "summary": {"type": "STRING"},
    },
    "required": ["quotes", "term", "summary"],
}


class AskError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def serve(handler, connect):
    """Handles one POST /api/ask on a BaseHTTPRequestHandler."""
    try:
        request = parse(handler)
        con = connect()
        try:
            cur = con.cursor()
            version = version_at(cur, request["page_id"], request["at"])
            if request["mode"] == "find":
                result = find(cur, request, version)
            else:
                facts = edit_facts(cur, request["page_id"], version["row_start"])
                facts["passage_first"] = passage_first(cur, request, version)
        finally:
            con.close()
    except AskError as error:
        return send_json(handler, error.status, {"error": str(error)})
    if request["mode"] == "find":
        return send_json(handler, 200, result)
    stream_answer(handler, request, version, facts)


def parse(handler):
    try:
        body = json.loads(handler.rfile.read(int(handler.headers.get("Content-Length", 0))))
        mode = body.get("mode", "ask")
        prompt = str(body["prompt"]).strip()
        page_id = int(body["page_id"])
        at = datetime.fromtimestamp(float(body["at"]), timezone.utc).replace(tzinfo=None)
    except (ValueError, KeyError, TypeError) as error:
        raise AskError(400, f"bad request: {error}")
    if mode not in ("ask", "find") or not prompt:
        raise AskError(400, "mode must be ask or find, and prompt must not be empty")
    history = [h for h in body.get("history") or [] if isinstance(h, dict) and h.get("text")][-MAX_HISTORY:]
    return {"mode": mode, "prompt": prompt, "context": body.get("context") or None,
            "page_id": page_id, "at": at, "history": history}


def version_at(cur, page_id, at):
    # Text is read by primary key only: selecting it in the AS OF scan reads every later version's text.
    cur.execute("SELECT row_start FROM m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s WHERE page_id = %s",
                (at.strftime("%Y-%m-%d %H:%M:%S.%f"), page_id))
    found = cur.fetchone()
    if not found:
        raise AskError(404, "the article has no version at that moment")
    cur.execute("""SELECT title, rev_id, IFNULL(user, '') AS user, IFNULL(comment, '') AS comment, row_start, text
                   FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start = %s""",
                (page_id, found["row_start"]))
    version = cur.fetchone()
    version["clean"] = Cleaned(version["text"])
    return version


def edit_facts(cur, page_id, until):
    """Edit counts up to and including the version being read. A repeated sha1 is a revert to an earlier text."""
    cur.execute("""SELECT COUNT(*) AS versions, COUNT(DISTINCT user) AS editors, MIN(row_start) AS first,
                          COUNT(*) - COUNT(DISTINCT sha1) AS reverts
                   FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start <= %s""", (page_id, until))
    return cur.fetchone()


def passage_first(cur, request, version):
    """The first version with the painted passage, or None when there is none or it is not found verbatim."""
    original = version["clean"].find(request["context"] or "")
    if not original:
        return None
    return first_version_with(cur, request["page_id"], version["row_start"], longest_stretch(original))


def longest_stretch(original):
    """References inside a sentence change more often than the sentence, so only the longest stretch between them is traced."""
    return max(re.split(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->", original, flags=re.S), key=len)


def day(value):
    return f"{value.day} {value:%B %Y}"


# References, comments, link targets and bold/italic quotes are dropped; runs of spaces become one space.
NOISE = re.compile(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->|\[\[[^\[\]|\n]*\||\[\[|\]\]|'{2,}"
                   r"|(?:&nbsp;|&#160;|[ \t ])+", re.S)


class Cleaned:
    """Wikitext as the reader sees its words, with a map from its positions back to the original."""

    def __init__(self, original):
        self.original = original
        parts, self.marks, pos, size, last = [], [(0, 0)], 0, 0, ""
        for match in NOISE.finditer(original):
            kept = original[pos:match.start()]
            last = kept[-1:] or last
            space = " " if match.group()[0] in " \t &" and last != " " else ""
            last = space or last
            parts += [kept, space]
            size += len(kept)
            self.marks.append((size, match.start()))
            size += len(space)
            self.marks.append((size, match.end()))
            pos = match.end()
        parts.append(original[pos:])
        self.text = "".join(parts)
        self.starts = [m[0] for m in self.marks]

    def origin(self, index, end=False):
        """A start skips removed text at index; an end stops before it."""
        found = bisect.bisect_left(self.starts, index) if end and index else bisect.bisect_right(self.starts, index)
        clean_pos, orig_pos = self.marks[found - 1]
        return orig_pos + index - clean_pos

    def find(self, quote):
        """The original wikitext of quote, or None when the text does not contain it."""
        needle = Cleaned(quote).text.strip()
        start = self.text.find(needle) if needle else -1
        return self.original[self.origin(start):self.origin(start + len(needle), end=True)] if start >= 0 else None


def article_block(version, context):
    text = version["clean"].text[:MAX_TEXT]
    passage = f"\n\nThe reader selected this passage and asks about it:\n<<<\n{context}\n>>>" if context else ""
    return (f"Article: {version['title']}\nVersion read: {day(version['row_start'])} "
            f"(revision {version['rev_id']} by {version['user'] or 'an anonymous editor'})"
            f"{passage}\n\nArticle wikitext of that version:\n<<<\n{text}\n>>>")


def stream_answer(handler, request, version, facts):
    facts_text = (f"Edit facts up to this version: first version {day(facts['first'])}; {facts['versions']} versions; "
                  f"{facts['editors']} different editors; {facts['reverts']} versions restored an earlier text exactly "
                  f"(reverts); last edit {day(version['row_start'])} by {version['user'] or 'an anonymous editor'}, "
                  f"comment: \"{version['comment']}\".")
    first = facts["passage_first"]
    if first:
        facts_text += (f"\nThe selected passage first appears in the version of {day(first['row_start'])} "
                       f"by {first['user'] or 'an anonymous editor'}, comment: \"{first['comment']}\".")
    contents = [{"role": "user", "parts": [{"text": article_block(version, request["context"]) + "\n\n" + facts_text}]},
                {"role": "model", "parts": [{"text": "I have read that version and its edit facts."}]}]
    contents += [{"role": "user" if h.get("role") == "user" else "model", "parts": [{"text": str(h["text"])}]}
                 for h in request["history"]]
    contents.append({"role": "user", "parts": [{"text": request["prompt"]}]})

    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    handler.end_headers()
    try:
        for piece in gemini_stream(ASK_RULES, contents):
            event(handler, "message", piece)
        event(handler, "done", "")
    except AskError as error:
        event(handler, "error", str(error))


def event(handler, name, data):
    handler.wfile.write(f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
    handler.wfile.flush()


def gemini_request(method, system, contents, config):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise AskError(503, "GEMINI_API_KEY is not set on the server")
    body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
            "generationConfig": {"thinkingConfig": {"thinkingLevel": "low"}, **config}}
    request = urllib.request.Request(f"{API}:{method}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        return urllib.request.urlopen(request, timeout=TIMEOUT_S)
    except urllib.error.HTTPError as error:
        raise AskError(502, f"Gemini returned {error.code}: {error.read()[:300].decode(errors='replace')}")
    except OSError as error:
        raise AskError(502, f"Gemini is unreachable: {error}")


def gemini_stream(system, contents):
    with gemini_request("streamGenerateContent?alt=sse", system, contents, {}) as response:
        for line in response:
            if not line.startswith(b"data: "):
                continue
            chunk = json.loads(line[6:])
            for candidate in chunk.get("candidates", []):
                for part in candidate.get("content", {}).get("parts", []):
                    if part.get("text") and not part.get("thought"):
                        yield part["text"]


def gemini_json(system, contents, schema):
    with gemini_request("generateContent", system, contents,
                        {"responseMimeType": "application/json", "responseSchema": schema}) as response:
        reply = json.loads(response.read())
    try:
        parts = reply["candidates"][0]["content"]["parts"]
        return json.loads("".join(p.get("text", "") for p in parts if not p.get("thought")))
    except (KeyError, IndexError, ValueError) as error:
        raise AskError(502, f"Gemini returned no usable answer: {error}")


def find(cur, request, version):
    contents = [{"role": "user", "parts": [{"text": article_block(version, request["context"])
                                            + "\n\nRequest: " + request["prompt"]}]}]
    reply = gemini_json(FIND_RULES, contents, FIND_SCHEMA)
    quotes = [{**q, "original": version["clean"].find(q.get("text") or "")} for q in reply.get("quotes", [])]
    quotes = [q for q in quotes if q["original"]][:5]
    groups = []
    if quotes:
        groups.append({"label": "In this article", "items": [
            {"title": plain(Cleaned(q["text"]).text), "meta": q.get("section") or "Introduction", "note": ""} for q in quotes]})
        first = first_version_with(cur, request["page_id"], version["row_start"], longest_stretch(quotes[0]["original"]))
        if first:
            groups.append({"label": "Since when", "items": [{
                "title": f"First added {day(first['row_start'])}",
                "meta": f"{first['user'] or 'anonymous'} · “{first['comment'] or 'no edit summary'}”",
                "note": f"First version containing “{shorten(plain(quotes[0]['text']), 70)}”"}]})
    others = other_articles(cur, request["page_id"], (reply.get("term") or "").strip())
    if others:
        groups.append({"label": "In other articles", "items": others})
    text = reply.get("summary") or ""
    if not quotes:
        text = (text + " " if text else "") + "No exact passage in this version answers that."
    return {"text": text.strip(), "attachment": {"type": "results", "groups": groups} if groups else None,
            "version": day(version["row_start"])}


def first_version_with(cur, page_id, until, quote):
    """Earliest version containing quote, by binary search over the version list; assumes it stayed once added."""
    cur.execute("""SELECT row_start FROM m_article FOR SYSTEM_TIME ALL
                   WHERE page_id = %s AND row_start <= %s ORDER BY row_start""", (page_id, until))
    starts = [r["row_start"] for r in cur.fetchall()]
    low, high = 0, len(starts) - 1
    while low < high:
        middle = (low + high) // 2
        cur.execute("""SELECT LOCATE(%s, text) > 0 AS found FROM m_article FOR SYSTEM_TIME ALL
                       WHERE page_id = %s AND row_start = %s""", (quote, page_id, starts[middle]))
        if cur.fetchone()["found"]:
            high = middle
        else:
            low = middle + 1
    cur.execute("""SELECT IFNULL(user, '') AS user, IFNULL(comment, '') AS comment, row_start
                   FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start = %s""",
                (page_id, starts[low]))
    return cur.fetchone()


def other_articles(cur, page_id, term):
    if len(term) < 3:
        return []
    like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    # The current Finnish text in s_article: reading m_article's text would also read every old version.
    cur.execute("""SELECT s.title, (CHAR_LENGTH(s.text) - CHAR_LENGTH(REPLACE(s.text, %s, ''))) DIV CHAR_LENGTH(%s) AS hits
                   FROM s_article s JOIN (SELECT page_id FROM m_article) m ON m.page_id = s.page_id
                   WHERE s.lang = 'fi' AND s.page_id <> %s AND s.text LIKE %s ORDER BY hits DESC LIMIT 5""",
                (term, term, page_id, like))
    return [{"title": r["title"], "meta": f"{r['hits']} mention{'s' if r['hits'] != 1 else ''} of “{term}”",
             "note": ""} for r in cur.fetchall()]


def plain(wikitext):
    """Readable text of a wikitext quote: link labels, no bold/italic quotes or templates."""
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", wikitext)
    text = re.sub(r"\{\{[^{}]*\}\}", "", text)
    return " ".join(text.replace("&nbsp;", " ").replace("'''", "").replace("''", "").split())


def shorten(text, limit):
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def send_json(handler, status, result):
    body = json.dumps(result, ensure_ascii=False, default=str).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)
