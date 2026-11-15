"""POST /api/ask: answers about one article as it was at a moment, with Gemini.

Both modes stream Server-Sent Events, the same as /api/learn:
  step      {id, text, done}: one piece of work; a later event with the same id updates its text or ends it
  thinking  a piece of Gemini's thought summary (a JSON string)
  message   ask: a piece of the answer text, with markers [1], [2], ... after its claims
  sources   ask, after the answer: {type: "quotes", here, items: [{n, title, section, quote, link}]}, the passages
            the markers cite, each found word for word in a text Gemini was given; link (null for the version
            being read) opens the related article or the other version it is in; a marker without an item
            cites nothing
  result    find: {text, attachment, version}: quotes that answer the prompt, when the top one first appeared,
            and other articles that mention the key term
  error     the message of the failure that ended the request; the step running at that moment failed
  done      the end
"""
import bisect
import difflib
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import search
import tracelog
import vector

MODEL = "gemini-3.8-flash"
API = "https://generativelanguage.googleapis.com/v1beta/models/"
TIMEOUT_S = 60
MAX_TEXT = 400_000
MAX_HISTORY = 12
# Gemini sends thought summaries only at "medium" or higher, which delays the first words by ~6 s; at "low"
# includeThoughts costs nothing and usually returns none.
THINKING = {"thinkingLevel": "low", "includeThoughts": True}

NARROW_W = 700
ASK_RULES = """You answer questions about one Wikipedia article for a reader.
- Answer in the language of the question, not the language of the article.
- Ground every claim in the article text and edit facts given below. If they do not say, say so plainly.
- Keep it short: {length}, plain prose, no Markdown, no lists.
- Say which version you read, by its date (for example "In the version of 12 September 2026, ...").
- End each claim that rests on the article text with a marker like [1] or [1][2], numbering the passages you
  cite: at most 4 passages, and a claim that rests on a passage already cited reuses its number."""
QUOTE_RULES = """- After the answer, write <quotes> on its own line, then one line per marker you used: the marker, then
  the words of the passage it rests on, copied character for character from a prose sentence of the article
  text (one sentence or clause, 30 to 200 characters; not the infobox, a table or markup). Write nothing after
  the last quote."""
QUOTES_TAG = "<quotes>"
RELATED_RULES = """- Other articles, found by searching Wikipedia for this question (Finnish Wikipedia, or Swedish or English where the
  title says so), follow the article: some in
  full ("Found article"), the rest as a title and its first words ("Also found"). Use them for what the article
  itself does not say, and then name the article ("The article on X says ..."). Cite their passages like the
  article's; here up to 6 passages may be cited.
- When the reader asks for related articles or further reading, name the 4 to 6 found articles that matter most for
  this article's subject, each with a clause on how it relates and a marker of its own. Do not name an article that
  was not found."""
THEN_NOW_RULES = """- You are given two versions of the article, THEN and NOW. Say what the THEN version said about the question,
  what the NOW version says, and what changed between them (or that nothing did), each with its date. Cite
  passages from both versions."""
DISPUTE_RULES = """- The edit facts list "Disputed edits": the text that reverted edits had added or removed. When asked about an edit
  war, a dispute or vandalism, say concretely what was fought over: quote the disputed wording (translated into
  the answer's language, the original in brackets when short), say who added it and who reverted it and when, and
  tell vandalism (insults, nonsense, blanking) apart from a dispute over content. Describe insults and invented
  private or sexual claims about a person by their kind, without repeating them word for word. Cite these to the
  edit history."""
THEN_NOW_QUOTE_RULES = """- In the quotes block, write THEN or NOW between the marker and a quote from those versions, for the version the
  claim is about, as in: [1] THEN the quoted words. A sentence that both versions have takes the tag of the
  version your claim describes."""
FACTS_QUOTE_RULES = """- For a marker whose claim rests on the edit facts (versions, editors, reverts, edit comments) and not on the
  article text, write the two words edit history in place of the quote."""
EDIT_HISTORY = "edit history"
FOUND_QUOTE_RULES = """- For a marker that stands for a found article as a whole, write the article's title, exactly as given,
  in place of the quote."""

SEARCH_ROUNDS = 2  # turns in which Gemini may search before it must choose what to read (a third added ~5 s, rarely an article)
SEARCH_CALLS = 6  # searches run in the first turn
GAP_CALLS = 2  # and in a later one, which only fills a gap
SEARCH_LIMIT, SEARCH_MAX = 8, 12  # articles per search: the default and the most
READ = 5  # found articles given to Gemini in full
READ_CHARS = 12_000  # of each: its lead and first sections
LISTED = 24  # other found articles given as a title and a lead
ARTICLE_START = 6_000  # characters of the article shown while searching; the answer gets all of it
# Searching is two or three short turns before the answer starts, so the fast model: measured on page 498, a turn
# takes ~1 s on 3.5 Flash and ~3 s on 3.8 Flash, and both write the same kind of queries.
RESEARCH_MODEL, RESEARCH_THINKING = os.environ.get("RESEARCH_MODEL", "gemini-3.5-flash"), {"thinkingLevel": "minimal"}
RESEARCH_RULES = f"""You find what else to read before a question about one Wikipedia article is answered.
You get the start of the article, its section headings and the reader's question. The writer of the answer gets the
whole article; your work is to find the OTHER articles the answer needs, among all 568,873 articles of Finnish
Wikipedia.
- search_articles is a hybrid search (BM25 keywords and vector meaning) over the articles' titles and texts. Write the
  queries yourself, from the article's subject and what the question is after; never pass the reader's words like
  "this" or "related articles". Good queries are Finnish article titles or names ("Elias Lönnrot", "Kanteletar"),
  keywords ("kansanrunouden keruu") and short descriptive phrases ("Kalevalan vaikutus kuvataiteeseen"). Queries in
  Finnish find the most.
- In your FIRST turn call search_articles 4 to {SEARCH_CALLS} times at once, each with a different query from a
  different angle, so that one round covers the question: the key people, the places, the concepts and terms, the
  works and what they influenced, the history before and the aftermath, whichever fit the question. Do not repeat
  an angle in other words. A narrow question about one named thing may take 2 or 3.
- A second round (the last, at most {GAP_CALLS} searches) is only for one specific gap you can name: a person, work or event the
  results mention that the answer needs and no result covers. Never use it to broaden further; when the first
  round covers the question, go straight to read_articles.
- Leave lang out: Finnish Wikipedia is the one with every article. Search Swedish (lang "sv") or English ("en")
  Wikipedia, with the query in that language, only when the question is about what another language's Wikipedia
  says or how its coverage differs, or when the reader writes in Swedish or English and the Finnish searches found
  little for the question. Their ids are negative numbers; pass them to read_articles as they are.
- Then call read_articles with the ids of the found articles the answer needs, the most useful first, at most {READ}.
  Prefer the article on a subject itself over lists and narrow sub-articles.
- Do not search when the article itself is what answers: a fact about its own subject that its text states (a
  number, a date, a name, a definition, what it says about something in its sections), its wording, what an
  earlier version of it said, or its edit history. Then call read_articles with an empty list at once. Search when
  the question reaches past the article: related or further reading, influence, causes, what came before or after,
  comparisons, or people, works and events the article only mentions."""
TOOLS = [{"functionDeclarations": [
    {"name": "search_articles",
     "description": "Searches Finnish Wikipedia by keywords and meaning. Returns the best articles: id, title and first words.",
     "parameters": {"type": "OBJECT", "properties": {
         "query": {"type": "STRING", "description": "A title, name, keywords or a short descriptive phrase, best in Finnish."},
         "limit": {"type": "INTEGER", "description": f"How many articles to return: {SEARCH_LIMIT} by default, at most {SEARCH_MAX}."},
         "lang": {"type": "STRING", "enum": ["fi", "sv", "en"],
                  "description": "Which Wikipedia: fi (default, all articles), or sv or en (about 5,000 articles each; write the query in that language)."}},
         "required": ["query"]}},
    {"name": "read_articles",
     "description": "Ends the search: the found articles to read in full for the answer. An empty list when none is needed.",
     "parameters": {"type": "OBJECT", "properties": {
         "ids": {"type": "ARRAY", "items": {"type": "INTEGER"}, "description": "Ids of found articles, most useful first."}},
         "required": ["ids"]}}]}]
YEAR = re.compile(r"\b(1[89]\d\d|20\d\d)\b")
REVERTS_SHOWN = 30  # reverts listed in the edit facts, the latest ones
# A question about how the article changed, in English, Finnish or Swedish.
CHANGE = re.compile(r"chang|evolv|over time|over the years|earlier version|older version|used to say|originally|edit histor"
                    r"|muuttu|muutoks|kehitty|aiemm|aikaisem|alun ?perin|muokkaushistoria|vuosien (?:varrella|mittaan|aikana)"
                    r"|förändr|ändrats|tidigare version|ursprungligen|genom åren", re.I)
# A question about the edits themselves: the edit facts answer it, no other article does.
EDITS = re.compile(r"edit war|fought over|kiistelty|edit histor|revert|vandal|who (?:has |have )?edited|editors?\b"
                   r"|muokkausso|muokkaushistoria|muokkaaj|vandalis|kumottu|kumouks|ketkä .*muoka|kuka .*muoka"
                   r"|redigeringskrig|redigeringshistorik|återställ|vem har redigerat", re.I)
OLD_DAYS = 30  # a version this much older than the current one is an old version

FIND_RULES = """You find where one Wikipedia article says something. Read the article wikitext and return:
- quotes: up to 5 passages that best answer the request, most relevant first. Each "text" is copied
  character for character from the wikitext (one sentence or clause, 40 to 300 characters, no <ref> tags).
  Prefer prose sentences; use a table row or template only when no sentence says it. "section" is the heading it is under ("" for the lead).
- term: the key word or name from the request, in the article's language, cut to its stem so that a substring
  search also finds inflected forms (for example "vankileir" for "vankileirit", "Mannerhei" for "Mannerheimin").
- summary: one sentence saying what the quotes show, written in the language of the request, not of the
  article: an English request gets an English summary even though the quotes stay in Finnish."""

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


def serve(handler, database):
    """Handles one POST /api/ask on a BaseHTTPRequestHandler."""
    try:
        request = parse(handler)
    except AskError as error:
        return send_json(handler, error.status, {"error": str(error)})
    with Progress(handler) as progress:
        cur = database().cursor()
        version = read_version(cur, progress, request)
        if request["mode"] == "find":
            result = find(cur, progress, request, version)
        else:
            facts = edit_facts(cur, progress, request["page_id"], version["row_start"])
            if EDITS.search(request["prompt"]):
                disputed_edits(cur, progress, request["page_id"], facts)
            facts["passage_first"] = passage_first(cur, progress, request, version)
            then_now = versions_to_compare(cur, progress, request, version, facts)
            related, listed = research(cur, progress, request, version)
        if request["mode"] == "find":
            event(handler, "result", result)
        else:
            stream_answer(progress, request, version, facts, then_now, related, listed)


class Progress:
    """Opens the event stream and reports the steps of the work on it, one running step at a time.

    As a context manager it ends the stream: `done` on success, `error` for a failure inside the block."""

    def __init__(self, handler, headers=()):
        self.handler, self.id, self.text = handler, 0, None
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        for name, value in headers:
            handler.send_header(name, value)
        handler.end_headers()

    def step(self, text):
        self.finish()
        self.id += 1
        self.update(text)

    def update(self, text):
        self.text = text
        event(self.handler, "step", {"id": self.id, "text": text, "done": False})

    def finish(self, text=None):
        if self.text is not None:
            event(self.handler, "step", {"id": self.id, "text": text or self.text, "done": True})
            self.text = None

    def think(self, text):
        event(self.handler, "thinking", text)

    def __enter__(self):
        return self

    def __exit__(self, kind, error, trace):
        if kind is None:
            self.finish()
            event(self.handler, "done", "")
            return False
        if issubclass(kind, (BrokenPipeError, ConnectionResetError)):  # the reader left
            return True
        if issubclass(kind, AskError):
            event(self.handler, "error", str(error))
            return True
        if issubclass(kind, Exception):
            self.handler.log_error("%s failed: %r", self.handler.path, error)
            event(self.handler, "error", f"the server failed: {error}")
            return True
        return False


def read_version(cur, progress, request):
    progress.step(f"Reading the article as it was on {day(request['at'])}")
    version = version_at(cur, request["page_id"], request["at"])
    progress.finish(f"Reading {version['title']} as it was on {day(request['at'])} (version {version['rev_id']})")
    return version


def parse(handler):
    try:
        body = json.loads(handler.rfile.read(int(handler.headers.get("Content-Length", 0))))
        tracelog.request_body(body)
        mode = body.get("mode", "ask")
        prompt = str(body["prompt"]).strip()
        page_id = int(body["page_id"])
        at = datetime.fromtimestamp(float(body["at"]), timezone.utc).replace(tzinfo=None)
    except (ValueError, KeyError, TypeError) as error:
        raise AskError(400, f"bad request: {error}")
    if mode not in ("ask", "find") or not prompt:
        raise AskError(400, "mode must be ask or find, and prompt must not be empty")
    history = [h for h in body.get("history") or [] if isinstance(h, dict) and h.get("text")][-MAX_HISTORY:]
    try:
        width = int((body.get("viewport") or {}).get("w") or 1200)
    except (ValueError, TypeError, AttributeError) as error:
        raise AskError(400, f"bad request: {error}")
    return {"mode": mode, "prompt": prompt, "context": body.get("context") or None,
            "page_id": page_id, "at": at, "history": history, "narrow": width < NARROW_W}


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


def is_current(cur, page_id, version):
    cur.execute("SELECT row_start FROM m_article WHERE page_id = %s", (page_id,))
    row = cur.fetchone()
    return bool(row) and row["row_start"] == version["row_start"]


def versions_to_compare(cur, progress, request, version, facts):
    """(then, now) when the question names an earlier year, or when the reader is on an old version: the last
    version of that year (or the one being read) and the current one. None otherwise."""
    now_moment = datetime.now(timezone.utc).replace(tzinfo=None)
    years = [int(y) for y in YEAR.findall(request["prompt"]) if int(y) < now_moment.year]
    if years:
        moment, label = datetime(years[0] + 1, 1, 1), f"the version of {years[0]}"
    elif (now_moment - version["row_start"]).days > OLD_DAYS and not is_current(cur, request["page_id"], version):
        moment, label = None, f"the version of {day(version['row_start'])}"
    elif CHANGE.search(request["prompt"]) and facts["versions"] > 1:
        # No year named: the article halfway through its life so far, against today's.
        moment = facts["first"] + (version["row_start"] - facts["first"]) / 2
        label = f"a version from halfway through the article's history ({moment.year})"
    else:
        return None
    progress.step(f"Reading {label} and today's version")
    try:
        then = version if moment is None else version_at(cur, request["page_id"], moment)
    except AskError:
        progress.finish(f"The article did not exist yet in {years[0]}, so there is no earlier version to compare")
        return None
    now = version if moment is not None and is_current(cur, request["page_id"], version) else version_at(
        cur, request["page_id"], now_moment)
    if then["rev_id"] == now["rev_id"]:
        progress.finish(f"Reading {label}: it is also today's version, so there is nothing to compare")
        return None
    progress.finish(f"Reading the version of {day(then['row_start'])} (then) and of {day(now['row_start'])} (now)")
    return then, now


_count = {"n": None, "at": 0.0}  # openable articles with a vector, counted at most once a minute per worker


def vector_count(cur):
    if time.time() - _count["at"] > 60:
        _count.update(n=vector.count(cur), at=time.time())
    return _count["n"]


def research(cur, progress, request, version):
    """What Gemini found for the question by searching: (the articles it chose to read, each as it was at the moment
    being read, and the other articles found as [{page_id, title, lead}]). Gemini writes the queries itself, several
    per turn, for at most SEARCH_ROUNDS turns. Nothing is found when Gemini does not answer."""
    found, chosen = {}, []
    if EDITS.search(request["prompt"]):
        progress.step("Answering from this article and its edit history")
        progress.finish()
        return [], []
    contents = [{"role": "user", "parts": [{"text": research_block(request, version)}]}]
    try:
        for turn in range(SEARCH_ROUNDS + 1):
            progress.step("Choosing what to read" if found else "Deciding what to search for")
            allowed = ["read_articles"] if turn == SEARCH_ROUNDS else ["search_articles", "read_articles"]
            reply = gemini_tools(RESEARCH_RULES, contents, allowed)
            calls = [p["functionCall"] for p in reply.get("parts", []) if p.get("functionCall")]
            queries = [c for c in calls if c.get("name") == "search_articles"
                       and str((c.get("args") or {}).get("query") or "").strip()][:GAP_CALLS if turn else SEARCH_CALLS]
            if not queries or turn == SEARCH_ROUNDS:
                chosen = [i for c in calls if c.get("name") == "read_articles" for i in (c.get("args") or {}).get("ids") or []]
                break
            names = [LANG_NAMES[lang] for lang in LANG_NAMES if any(call_lang(c) == lang for c in queries)]
            progress.finish(f"Searching {' and '.join(names)} Wikipedia")
            contents += [reply, {"role": "user", "parts": run_searches(cur, progress, request, queries, found)}]
    except AskError as error:
        progress.finish(f"Searching other articles: stopped, {error}")
    read = []
    if progress.text is None:
        progress.step("Choosing what to read")
    opened = set()
    for key in dict.fromkeys(i for i in chosen if i in found):
        hit = found[key]
        try:
            read.append(foreign_article(cur, hit) if hit["lang"] != "fi"
                        else {**version_at(cur, hit["page_id"], request["at"]), "page_id": hit["page_id"], "lang": "fi"})
        except AskError:  # the article did not exist yet at that moment
            continue
        opened.add(key)
        if len(read) == READ:
            break
    listed = [f for key, f in found.items() if key not in opened][:LISTED]
    if not found:
        progress.finish("Answering from this article alone" if not chosen else None)
    elif read:
        progress.finish(f"Reading {len(read)} of the {len(found)} articles found: " + "; ".join(r["title"] for r in read))
    else:
        progress.finish(f"Found {len(found)} articles; none needs reading in full")
    return read, listed


LANG_NAMES = {"fi": "Finnish", "sv": "Swedish", "en": "English"}


def call_lang(call):
    lang = str((call.get("args") or {}).get("lang") or "fi").strip().lower()
    return lang if lang in ("sv", "en") else "fi"


def foreign_titled(cur, lang, query, limit):
    """search.titled() for the Swedish or English articles: the same ranking (search.ranked), their titles marked
    with the language. page_id is that wiki's own, so it can equal a Finnish article's."""
    ranked = search.ranked(cur, query, limit, lang)
    if not ranked:
        return []
    cur.execute("SELECT page_id, title, LEFT(text, %s) AS lead FROM s_article WHERE lang = %s AND page_id IN %s",
                (search.LEAD_CHARS + 260, lang, [r["page_id"] for r in ranked]))
    rows = {r["page_id"]: r for r in cur.fetchall()}
    hits = []
    for r in ranked:
        row = rows.get(r["page_id"])
        if row:
            lead = " ".join(row["lead"].split()).removeprefix(f"# {row['title']} ")[:search.LEAD_CHARS]
            hits.append({"page_id": row["page_id"], "lang": lang, "lead": lead,
                         "title": f"{row['title']} ({LANG_NAMES[lang]} Wikipedia)"})
    return hits


def foreign_article(cur, hit):
    """A found Swedish or English article (current text, Markdown) in the shape of a version."""
    cur.execute("SELECT rev_id, date_modified, text FROM s_article WHERE lang = %s AND page_id = %s",
                (hit["lang"], hit["page_id"]))
    row = cur.fetchone()
    if not row:
        raise AskError(404, "no such article")
    text = row["text"].removeprefix(f"# {hit['title'].rsplit(' (', 1)[0]}\n")
    return {"title": hit["title"], "rev_id": row["rev_id"], "row_start": row["date_modified"], "clean": Cleaned(text),
            "page_id": hit["page_id"], "lang": hit["lang"]}


def research_block(request, version):
    """What Gemini sees while it searches: the start of the article, its headings, the talk so far, the question."""
    clean = version["clean"].text
    headings = "; ".join(plain(m.group(2)) for m in HEADING.finditer(clean))
    passage = f"\n\nThe reader selected this passage and asks about it:\n<<<\n{request['context']}\n>>>" if request["context"] else ""
    earlier = "".join(f"\n{'Reader' if h.get('role') == 'user' else 'Answer'}: {shorten(str(h['text']), 600)}"
                      for h in request["history"])
    return (f"Article: {version['title']} (id {request['page_id']}), read as it was on {day(version['row_start'])}\n\n"
            f"Start of the article:\n<<<\n{clean[:ARTICLE_START]}\n>>>\n\nIts sections: {headings or 'none'}{passage}"
            + (f"\n\nThe conversation so far:{earlier}" if earlier else "")
            + f"\n\nThe reader's question: {request['prompt']}")


def run_searches(cur, progress, request, calls, found):
    """Runs Gemini's search calls, adding new articles to found ({page_id: {page_id, title, lead}}); returns the
    functionResponse parts. The questions are embedded together; MariaDB is asked one search at a time."""
    queries = [str(c["args"]["query"]).strip()[:200] for c in calls]
    with ThreadPoolExecutor(len(queries)) as pool:  # fills voyage's cache, so search.titled() below does not wait
        list(pool.map(warm_embedding, queries, [call_lang(c) for c in calls]))
    parts = []
    for call, query in zip(calls, queries):
        try:
            limit = max(1, min(SEARCH_MAX, int(call["args"].get("limit") or SEARCH_LIMIT)))
        except (ValueError, TypeError):
            limit = SEARCH_LIMIT
        progress.step(f"Searching “{shorten(query, 70)}”")
        lang = call_lang(call)
        if lang == "fi":
            hits = [{**h, "lang": "fi", "id": h["page_id"]} for h in search.titled(cur, query, limit + 1)
                    if h["page_id"] != request["page_id"]][:limit]
        else:  # their page ids are another wiki's: Gemini gets a negative number of this request's own
            hits = foreign_titled(cur, lang, query, limit)
            ids = {(f["lang"], f["page_id"]): key for key, f in found.items()}
            for hit in hits:
                hit["id"] = ids.get((lang, hit["page_id"])) or -(1 + sum(1 for key in found if key < 0))
                found.setdefault(hit["id"], hit)
        new = sum(1 for h in hits if h["id"] not in found or found[h["id"]] is h)
        for hit in hits:
            found.setdefault(hit["id"], hit)
        names = "; ".join(h["title"] for h in hits[:6]) + ("…" if len(hits) > 6 else "")
        progress.finish(f"Searched “{shorten(query, 70)}” → {len(hits)} article{'s' if len(hits) != 1 else ''}"
                        + (f" ({new} new)" if new != len(hits) else "") + (f": {names}" if names else ""))
        response = {"articles": [{"id": h["id"], "title": h["title"], "start": h["lead"]} for h in hits]}
        parts.append({"functionResponse": {"name": "search_articles", "response": response,
                                           **({"id": call["id"]} if call.get("id") else {})}})
    return parts


def warm_embedding(query, lang="fi"):
    try:
        vector.embed(query) if lang == "fi" else vector.embed_s(lang, query)
    except vector.Unavailable:
        pass  # the search itself goes on with keywords


def gemini_tools(system, contents, allowed):
    """Gemini's next turn, which must call one of the allowed functions of TOOLS: its content {role, parts}, to
    append to contents as it is (the parts carry the thought signatures Gemini asks back)."""
    extra = {"tools": TOOLS, "toolConfig": {"functionCallingConfig": {"mode": "ANY", "allowedFunctionNames": allowed}}}
    with gemini_request("generateContent", system, contents, {"thinkingConfig": RESEARCH_THINKING}, extra,
                        RESEARCH_MODEL) as response:
        reply = json.loads(response.read())
    tracelog.event("gemini_reply", reply=reply)
    try:
        content = reply["candidates"][0]["content"]
    except (KeyError, IndexError):
        raise AskError(502, "Gemini returned no search plan")
    return {"role": "model", "parts": content.get("parts", [])}


def edit_facts(cur, progress, page_id, until):
    """Edit counts up to and including the version being read. A repeated sha1 is a revert to an earlier text."""
    progress.step("Counting the edit history")
    cur.execute("""SELECT row_start, user, IFNULL(comment, '') AS comment, sha1
                   FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start <= %s ORDER BY row_start""",
                (page_id, until))
    rows = cur.fetchall()
    seen, reverted, years, months, editors = set(), [], {}, {}, {}
    for before, row in zip([None] + rows, rows):
        # A version with the text of the one before it (a protection, a null edit) restores nothing.
        if row["sha1"] in seen and before["sha1"] != row["sha1"]:
            reverted.append({**row, "before": before, "undone": f"; undid the edit of {before['user'] or 'anonymous'}"
                             + (f" ({shorten(plain(before['comment']), 80)})" if before["comment"] else "")})
        seen.add(row["sha1"])
        years[row["row_start"].year] = years.get(row["row_start"].year, 0) + 1
        month = f"{row['row_start']:%B %Y}"
        months[month] = months.get(month, 0) + 1
        if row["user"]:
            editors[row["user"]] = editors.get(row["user"], 0) + 1
    busiest = sorted(months.items(), key=lambda m: -m[1])[:3]
    most = sorted(editors.items(), key=lambda e: -e[1])[:5]
    log = ("Versions per year: " + ", ".join(f"{y}: {n}" for y, n in years.items())
           + "\nBusiest months: " + ", ".join(f"{m} ({n} versions)" for m, n in busiest)
           + "\nMost active editors: " + ", ".join(f"{u} ({n})" for u, n in most))
    if reverted:
        log += (f"\nThe last {min(len(reverted), REVERTS_SHOWN)} of the {len(reverted)} reverts (date, editor, edit comment; the edit it undid):\n"
                + "\n".join(f"- {day(r['row_start'])}, {r['user'] or 'anonymous'}: {shorten(plain(r['comment']), 140) or 'no comment'}{r['undone']}"
                            for r in reverted[-REVERTS_SHOWN:]))
    facts = {"versions": len(rows), "editors": len(editors), "first": rows[0]["row_start"], "reverts": len(reverted),
             "log": log, "reverted": reverted}
    progress.finish(f"Counting the edit history: {facts['versions']:,} version{'s' if len(rows) != 1 else ''}"
                    + (f" by {facts['editors']:,} editor{'s' if len(editors) != 1 else ''}" if editors else ""))
    return facts


DISPUTES = 8  # reverted edits whose changes are read
DISPUTE_CHARS = 350  # of the text each added, and of the text each removed


def disputed_edits(cur, progress, page_id, facts):
    """Adds to the edit facts what the most fought-over reverted edits changed: for each, the text the edit added and
    removed, which the revert took back. The most fought-over are the texts reverted most often, in the densest
    runs of reverts."""
    reverted = facts["reverted"]
    if not reverted:
        return
    progress.step("Reading what the reverted edits changed")
    times, weight = [r["row_start"] for r in reverted], {}
    for r in reverted:
        near = sum(1 for t in times if abs((t - r["row_start"]).total_seconds()) < 3 * 86400)
        again = sum(1 for o in reverted if o["before"]["sha1"] == r["before"]["sha1"])
        weight.setdefault(r["before"]["sha1"], (again * 3 + near, r["row_start"], r, again))
    chosen = sorted(sorted(weight.values(), key=lambda w: w[:2], reverse=True)[:DISPUTES], key=lambda w: w[1])
    lines = []
    for _, _, r, again in chosen:
        texts = []
        for start in (r["row_start"], r["before"]["row_start"]):  # the restored text, the text with the edit
            cur.execute("SELECT text FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start = %s",
                        (page_id, start))
            texts.append(cur.fetchone()["text"])
        added, removed = changed(*texts)
        if not added and not removed:
            continue
        lines.append(f"- {day(r['row_start'])}: {r['user'] or 'anonymous'} reverted {r['before']['user'] or 'anonymous'}"
                     + (f" (this same text was reverted {again} times)" if again > 1 else "")
                     + (f"\n  the reverted edit had added: «{added}»" if added else "")
                     + (f"\n  the reverted edit had removed: «{removed}»" if removed else ""))
    if lines:
        facts["log"] += ("\nDisputed edits: what the most fought-over reverted edits had changed in the article text "
                         "(… joins separate places):\n" + "\n".join(lines))
    progress.finish(f"Read what {len(lines)} reverted edit{'s' if len(lines) != 1 else ''} changed")


def changed(before, after):
    """(added, removed): the words after has and before lacks, and the reverse, each with a few words around them."""
    old, new = before.splitlines(), after.splitlines()
    added, removed = [], []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        a, b = " ".join(old[i1:i2]).split(), " ".join(new[j1:j2]).split()
        for op2, a1, a2, b1, b2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
            if op2 in ("replace", "delete"):
                removed.append(" ".join(a[max(0, a1 - 5):a2 + 5]))
            if op2 in ("replace", "insert"):
                added.append(" ".join(b[max(0, b1 - 5):b2 + 5]))
    tidy = lambda parts: shorten(plain(Cleaned(" … ".join(dict.fromkeys(parts))).text), DISPUTE_CHARS)
    return tidy(added), tidy(removed)


def passage_first(cur, progress, request, version):
    """The first version with the painted passage, or None when there is none or it is not found verbatim."""
    original = version["clean"].find(request["context"] or "")
    if not original:
        return None
    return first_version_with(cur, progress, "the selected passage", request["page_id"], version["row_start"],
                              longest_stretch(original))


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


def related_block(related, listed):
    blocks = [f"Found article: {r['title']}" + (f" (version of {day(r['row_start'])})" if r["row_start"] else "") + f"\n<<<\n{r['clean'].text[:READ_CHARS]}\n>>>"
              for r in related]
    if listed:
        blocks.append("Also found (title: first words):\n" + "\n".join(f"- {f['title']}: {f['lead']}" for f in listed))
    return "\n\n".join(blocks)


def then_now_block(then, now):
    half = MAX_TEXT // 2
    return (f"THEN: the version of {day(then['row_start'])} (revision {then['rev_id']}):\n<<<\n{then['clean'].text[:half]}\n>>>"
            f"\n\nNOW: the version of {day(now['row_start'])} (revision {now['rev_id']}):\n<<<\n{now['clean'].text[:half]}\n>>>")


def quotable(request, version, then_now, related, listed):
    """The texts Gemini was given, as (title, Cleaned, link): a link opens a text other than the version being read."""
    def link(page_id, row_start):
        return f"./?id={page_id}&at={int(row_start.replace(tzinfo=timezone.utc).timestamp())}"
    texts, tagged = [(version["title"], version["clean"], None)], {}
    for tag, v in zip(("THEN", "NOW"), then_now or ()):
        if v["rev_id"] != version["rev_id"]:
            texts.append((f"{v['title']} ({day(v['row_start'])})", v["clean"], link(request["page_id"], v["row_start"])))
        tagged[tag] = texts[-1] if v["rev_id"] != version["rev_id"] else texts[0]
    texts += [(r["title"], r["clean"], link(r["page_id"], r["row_start"]) if r["lang"] == "fi"
               else f"./?id={r['page_id']}&lang={r['lang']}") for r in related]
    texts += [(f["title"], Cleaned(f["lead"]), f"./?id={f['page_id']}" + (f"&lang={f['lang']}" if f["lang"] != "fi" else ""))
              for f in listed]
    return texts, tagged


def stream_answer(progress, request, version, facts, then_now, related, listed):
    facts_text = (f"Edit facts up to this version: first version {day(facts['first'])}; {facts['versions']} versions; "
                  f"{facts['editors']} different editors; {facts['reverts']} versions restored an earlier text exactly "
                  f"(reverts); last edit {day(version['row_start'])} by {version['user'] or 'an anonymous editor'}, "
                  f"comment: \"{version['comment']}\".\n{facts['log']}")
    facts_line = (f"{facts['versions']:,} versions by {facts['editors']:,} editors since {day(facts['first'])}; "
                  f"{facts['reverts']:,} of them reverts to an earlier text")
    first = facts["passage_first"]
    if first:
        facts_line += f"; the selected passage is there since {day(first['row_start'])}"
        facts_text += (f"\nThe selected passage first appears in the version of {day(first['row_start'])} "
                       f"by {first['user'] or 'an anonymous editor'}, comment: \"{first['comment']}\".")
    given = then_now_block(*then_now) if then_now else article_block(version, request["context"])
    if related or listed:
        given += "\n\n" + related_block(related, listed)
    contents = [{"role": "user", "parts": [{"text": given + "\n\n" + facts_text}]},
                {"role": "model", "parts": [{"text": "I have read that version and its edit facts."}]}]
    contents += [{"role": "user" if h.get("role") == "user" else "model", "parts": [{"text": str(h["text"])}]}
                 for h in request["history"]]
    contents.append({"role": "user", "parts": [{"text": request["prompt"]}]})
    length = "2 or 3 sentences" if request["narrow"] else "3 to 6 sentences"
    rules = "\n".join([ASK_RULES.format(length=length), *([THEN_NOW_RULES] if then_now else []),
                       *([RELATED_RULES] if related or listed else []), *([DISPUTE_RULES] if "Disputed edits" in facts["log"] else []), QUOTE_RULES,
                       *([THEN_NOW_QUOTE_RULES] if then_now else []), FACTS_QUOTE_RULES,
                       *([FOUND_QUOTE_RULES] if related or listed else [])])
    progress.step("Asking Gemini…")
    started = time.perf_counter()
    cited = []
    for kind, value in until_quotes(gemini_stream(progress, rules, contents)):
        if kind == "quotes":
            cited = value
            continue
        progress.finish(f"Asked Gemini: first words after {time.perf_counter() - started:.1f} s")
        event(progress.handler, "message", value)
    texts, tagged = quotable(request, version, then_now, related, listed)
    event(progress.handler, "sources", {"type": "quotes", "here": {"title": version["title"], "page_id": request["page_id"]},
                                        "items": article_quotes(texts, cited, facts_line, tagged)})


def until_quotes(pieces):
    """Splits a stream that ends in a QUOTES_TAG block: yields ("text", piece) for the answer, then one
    ("quotes", [(n, quote)]). What may be the start of the tag, and trailing whitespace, waits for more text."""
    buffer, block = "", None
    for piece in pieces:
        if block is not None:
            block += piece
            continue
        buffer += piece
        at = buffer.find(QUOTES_TAG)
        if at >= 0:
            block, buffer = buffer[at + len(QUOTES_TAG):], buffer[:at]
            continue
        hold = buffer.rfind("<")
        keep = len(buffer[:hold if hold >= 0 and QUOTES_TAG.startswith(buffer[hold:]) else None].rstrip())
        if keep:
            yield "text", buffer[:keep]
            buffer = buffer[keep:]
    if buffer.strip():
        yield "text", buffer.rstrip()
    found = re.findall(r"^\s*\[(\d+)\]\s*(?:(THEN|NOW)\b[:,]?\s*)?(.+)$", block or "", re.M)
    yield "quotes", [(int(n), q.strip().strip("\"'„“”«»"), tag) for n, tag, q in found]


# A heading line of the wikitext, as in "== Taustaa ==".
HEADING = re.compile(r"^(={2,6})\s*(.*?)\s*\1\s*$", re.M)


def article_quotes(texts, cited, facts=None, tagged=None):
    """The cited quotes that occur word for word in one of texts [(title, Cleaned, link)], each with the heading
    of its section there. A quote that is the title of a linked text cites that article by its first sentence."""
    items, seen = [], set()
    titles = {title.casefold(): (title, clean, link) for title, clean, link in reversed(texts) if link}
    first, tagged = texts[0], tagged or {}
    for n, quote, tag in cited:
        # A quote tagged THEN or NOW is looked for in that version first: both may have the sentence.
        texts = [tagged[tag]] + [t for t in texts if t is not tagged[tag]] if tag in tagged else texts
        needle = Cleaned(quote).text.strip()
        if n not in seen and facts and needle.casefold().strip(" .:") in (EDIT_HISTORY, "edit facts"):
            seen.add(n)
            items.append({"n": n, "title": f"Edit history of {first[0]}", "section": "Version history", "quote": facts, "link": None})
            continue
        if n not in seen and needle.casefold() in titles:
            title, clean, link = titles[needle.casefold()]
            seen.add(n)
            items.append({"n": n, "title": title, "section": "", "quote": shorten(first_sentence(clean.text), 200) or title, "link": link})
            continue
        if len(needle) < 12 or n in seen:
            continue
        # The whole quote, or else its longest sentence that is in a text: Gemini sometimes joins two sentences
        # across a reference or shortens with an ellipsis.
        pieces = sorted(re.split(r"(?<=[.!?])\s+|\s*(?:…|\.\.\.)\s*", needle), key=len, reverse=True)
        for piece in [needle] + [p for p in pieces if len(p) >= 30 and p != needle]:
            hit = next(((title, clean, link, clean.text.find(piece)) for title, clean, link in texts
                        if piece in clean.text), None)
            if hit:
                title, clean, link, at = hit
                seen.add(n)
                headings = [m.group(2) for m in HEADING.finditer(clean.text, 0, at)]
                items.append({"n": n, "title": title, "section": plain(headings[-1]) if headings else "",
                              "quote": plain(piece), "link": link})
                break
        else:
            print(f"ask: quote not found: [{n}] {quote!r}", flush=True)
    return items


NOT_SENTENCE = re.compile(r"^[{|}!=*#<\[:;]|^\w{2,20}\||^(thumb|pienoiskuva|right|left|oikea|vasen|Tiedosto|Kuva|File|Image)\b|\d+\s*px\|", re.I)


def first_sentence(text):
    """The first prose sentence of an article's text: past its infobox, pictures and headings."""
    for line in text.splitlines():
        line = plain(line).strip()
        if len(line) > 60 and not NOT_SENTENCE.search(line):
            # A sentence ends before a capital or a digit: "(isl. fornaldarsögur)" does not end one.
            parts = re.split(r"(?<=[a-zåäö\)]\.)\s+(?=[A-ZÅÄÖ0-9”\"])", line)
            sentence = parts.pop(0)
            while parts and len(sentence) < 60:  # "Muinaissaagat (isl. Fornaldarsögur) ovat ..." goes on
                sentence += " " + parts.pop(0)
            return sentence
    return shorten(plain(" ".join(text.split())), 200)


def event(handler, name, data):
    tracelog.event("sse", name=name, data=data)
    handler.wfile.write(f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
    handler.wfile.flush()


def gemini_request(method, system, contents, config, extra=None, model=MODEL):
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise AskError(503, "GEMINI_API_KEY is not set on the server")
    body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
            "generationConfig": {"thinkingConfig": THINKING, **config}, **(extra or {})}
    tracelog.event("gemini_request", model=model, method=method, body=body)
    request = urllib.request.Request(f"{API}{model}:{method}", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        return urllib.request.urlopen(request, timeout=TIMEOUT_S)
    except urllib.error.HTTPError as error:
        raise AskError(502, f"Gemini returned {error.code}: {error.read()[:300].decode(errors='replace')}")
    except OSError as error:
        raise AskError(502, f"Gemini is unreachable: {error}")


def answer_texts(progress, response):
    """The answer text pieces of a streamed Gemini response; thought summaries go to progress."""
    for line in response:
        if not line.startswith(b"data: "):
            continue
        for candidate in json.loads(line[6:]).get("candidates", []):
            for part in candidate.get("content", {}).get("parts", []):
                if part.get("text") and part.get("thought"):
                    progress.think(part["text"])
                elif part.get("text"):
                    yield part["text"]


def gemini_stream(progress, system, contents):
    with gemini_request("streamGenerateContent?alt=sse", system, contents, {}) as response:
        yield from answer_texts(progress, response)


def gemini_json(progress, system, contents, schema):
    """Streamed, so that the thought summary shows while the JSON is being written."""
    config = {"responseMimeType": "application/json", "responseSchema": schema}
    with gemini_request("streamGenerateContent?alt=sse", system, contents, config) as response:
        text = "".join(answer_texts(progress, response))
    tracelog.event("gemini_reply", text=text)
    try:
        return json.loads(text)
    except ValueError as error:
        raise AskError(502, f"Gemini returned no usable answer: {error}")


def find(cur, progress, request, version):
    contents = [{"role": "user", "parts": [{"text": article_block(version, request["context"])
                                            + "\n\nRequest: " + request["prompt"]}]}]
    progress.step(f"Searching the article for “{shorten(request['prompt'], 60)}”")
    reply = gemini_json(progress, FIND_RULES, contents, FIND_SCHEMA)
    proposed = reply.get("quotes", [])
    checking = f"Checking {len(proposed)} quote{'s' if len(proposed) != 1 else ''} against the text"
    progress.step(checking)
    quotes = [{**q, "original": version["clean"].find(q.get("text") or "")} for q in proposed]
    quotes = [q for q in quotes if q["original"]][:5]
    progress.finish(f"{checking}: {len(quotes)} found word for word")
    groups = []
    if quotes:
        groups.append({"label": "In this article", "items": [
            {"title": plain(Cleaned(q["text"]).text), "meta": q.get("section") or "Introduction", "note": ""} for q in quotes]})
        first = first_version_with(cur, progress, "the top quote", request["page_id"], version["row_start"],
                                   longest_stretch(quotes[0]["original"]))
        if first:
            groups.append({"label": "Since when", "items": [{
                "title": f"First added {day(first['row_start'])}",
                "meta": f"{first['user'] or 'anonymous'} · “{first['comment'] or 'no edit summary'}”",
                "note": f"First version containing “{shorten(plain(quotes[0]['text']), 70)}”"}]})
    others = other_articles(cur, progress, request["page_id"], (reply.get("term") or "").strip())
    if others:
        groups.append({"label": "In other articles", "items": others})
    text = reply.get("summary") or ""
    if not quotes:
        text = (text + " " if text else "") + "No exact passage in this version answers that."
    return {"text": text.strip(), "attachment": {"type": "results", "groups": groups} if groups else None,
            "version": day(version["row_start"])}


def first_version_with(cur, progress, what, page_id, until, quote):
    """Earliest version containing quote, by binary search over the version list; assumes it stayed once added."""
    label = f"Finding when {what} first appeared"
    progress.step(label)
    cur.execute("""SELECT row_start FROM m_article FOR SYSTEM_TIME ALL
                   WHERE page_id = %s AND row_start <= %s ORDER BY row_start""", (page_id, until))
    starts = [r["row_start"] for r in cur.fetchall()]
    low, high, checked = 0, len(starts) - 1, 0
    while low < high:
        middle = (low + high) // 2
        cur.execute("""SELECT LOCATE(%s, text) > 0 AS found FROM m_article FOR SYSTEM_TIME ALL
                       WHERE page_id = %s AND row_start = %s""", (quote, page_id, starts[middle]))
        if cur.fetchone()["found"]:
            high = middle
        else:
            low = middle + 1
        checked += 1
        progress.update(f"{label}: checked {checked} of {len(starts):,} versions")
    cur.execute("""SELECT IFNULL(user, '') AS user, IFNULL(comment, '') AS comment, row_start
                   FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start = %s""",
                (page_id, starts[low]))
    first = cur.fetchone()
    progress.finish(f"{label}: {day(first['row_start'])}, after checking {checked} of {len(starts):,} versions")
    return first


def other_articles(cur, progress, page_id, term):
    if len(term) < 3:
        return []
    progress.step(f"Searching other articles for “{term}”")
    like = "%" + term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    # The current Finnish text in s_article: reading m_article's text would also read every old version.
    cur.execute("""SELECT s.title, (CHAR_LENGTH(s.text) - CHAR_LENGTH(REPLACE(s.text, %s, ''))) DIV CHAR_LENGTH(%s) AS hits
                   FROM s_article s JOIN (SELECT page_id FROM m_article) m ON m.page_id = s.page_id
                   WHERE s.lang = 'fi' AND s.page_id <> %s AND s.text LIKE %s ORDER BY hits DESC LIMIT 5""",
                (term, term, page_id, like))
    rows = cur.fetchall()
    found = "none mention it" if not rows else f"{len(rows)} mention it" if len(rows) < 5 else "the 5 that mention it most"
    progress.finish(f"Searching other articles for “{term}”: {found}")
    return [{"title": r["title"], "meta": f"{r['hits']} mention{'s' if r['hits'] != 1 else ''} of “{term}”",
             "note": ""} for r in rows]


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
