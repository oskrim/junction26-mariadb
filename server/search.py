"""The article search behind /api/search and the assistant's search tool: which articles answer a query, in order.

ranked() is the hybrid ranking (vector.hybrid: BM25 + Voyage cosine + prior); titled() adds each article's title
and the start of its text, which is what the assistant reads to choose. rerank() has Gemini order the hybrid top
RERANK_POOL: on search_eval.py's 56 queries hit@1 0.77 -> 0.88, hit@5 0.93 -> 0.95, MRR 0.83 -> 0.91, for 0.8 s
more (p50; 1.2 s p95) on 3.5 Flash Lite. 3.5 Flash gave 0.91 / 0.96 / 0.93 for 1.3 s more. So it is asked for
(/api/search?rerank=1), not done on every key press.
"""
import json
import os
import re
import time
import urllib.request

import bm25
import tracelog
import vector

MAX_WORDS = 8
LEAD_CHARS = 240  # of each article's plain text, for the assistant


def words(q):
    """The words of a search query, at most MAX_WORDS of them."""
    return re.findall(r"\w+", q)[:MAX_WORDS]


def by(scored):
    """What found a hybrid search result: its words, its meaning, or both."""
    lexical = scored["exact"] or scored["body"] or scored["title"]
    return "both" if lexical and scored["meaning"] else "keyword" if lexical else "meaning"


def ranked(cur, q, limit, lang="fi"):
    """[{page_id, by}] of the limit articles of lang that best match q, best first; by is "keyword", "meaning" or
    "both". Without the embedding service, the BM25 ranking alone. Recorded in the request's trace (tracelog.py)."""
    started = time.perf_counter()
    results = _ranked(cur, q, limit, lang)
    tracelog.event("search", q=q, lang=lang, limit=limit, ms=round((time.perf_counter() - started) * 1000), results=results)
    return results


def _ranked(cur, q, limit, lang="fi"):
    found = words(q)
    if not found:
        return []
    if lang in vector.S_LANGS:
        ids = bm25.term_ids_s(cur, lang, " ".join(found))
        try:
            return [{**r, "by": by(r)} for r in vector.hybrid_s(cur, lang, q, ids, vector.embed_s(lang, q), limit)]
        except vector.Unavailable as error:
            print(f"search: keywords only: {error}", flush=True)
            return [{"page_id": p, "by": "keyword"} for p in vector.lexical_only_s(cur, lang, q, ids, limit)]
    # The words written together too: Finnish compounds are often searched apart ("Lapuan liike" for Lapuanliike).
    ids = bm25.term_ids(cur, " ".join(found) + (" " + "".join(found) if len(found) > 1 else ""))
    try:
        return [{**r, "by": by(r)} for r in vector.hybrid(cur, q, ids, vector.embed(q), limit)]
    except vector.Unavailable as error:
        print(f"search: keywords only: {error}", flush=True)
        return [{"page_id": p, "by": "keyword"} for p in vector.lexical_only(cur, q, ids, limit)]


def titled(cur, q, limit):
    """ranked() over the Finnish articles as [{page_id, title, lead, by}]; lead is the start of the plain text."""
    found = ranked(cur, q, limit)
    if not found:
        return []
    cur.execute("""SELECT s.page_id, s.title, LEFT(m.text, %s) AS lead FROM m_article_stats s
                   LEFT JOIN m_search m USING (page_id) WHERE s.page_id IN %s""", (LEAD_CHARS, [r["page_id"] for r in found]))
    rows = {r["page_id"]: r for r in cur.fetchall()}
    return [{"page_id": r["page_id"], "title": rows[r["page_id"]]["title"],
             "lead": lead(rows[r["page_id"]]["title"], rows[r["page_id"]]["lead"] or ""), "by": r["by"]}
            for r in found if r["page_id"] in rows]


def lead(title, text):
    """The start of an article's text on one line, without the "# Title" heading a Markdown text opens with."""
    text = " ".join(text.split())
    heading = f"# {title} "
    return text[len(heading):] if text.startswith(heading) else text


RERANK_POOL = 40  # hybrid results Gemini orders
RERANK_MODEL = "gemini-3.5-flash-lite"
RERANK_TIMEOUT_S = 6
RERANK_RULES = """You rank Wikipedia search results. You get a search query and numbered results (title: first words).
Return the numbers of the 10 results that best answer the query, best first. The best result is the article a
reader typing this query most wants to open: the main article on the person, place, work or event meant, or the
article that answers the question; then closely related ones. Lists, sub-articles and same-named minor subjects
come after the main article."""
RERANK_SCHEMA = {"type": "OBJECT", "properties": {"order": {"type": "ARRAY", "items": {"type": "INTEGER"}}},
                 "required": ["order"]}


def rerank(q, results):
    """results ([{title, snippet, ...}], in hybrid order) with the ones Gemini puts first moved to the front, in its
    order. Unchanged when Gemini does not answer in RERANK_TIMEOUT_S."""
    key = os.environ.get("GEMINI_API_KEY")
    if not key or len(results) < 2:
        return results
    listing = "\n".join(f"{i}. {r['title']}: {r['snippet'][:160]}" for i, r in enumerate(results, 1))
    body = {"systemInstruction": {"parts": [{"text": RERANK_RULES}]},
            "contents": [{"role": "user", "parts": [{"text": f"Query: {q}\n\nResults:\n{listing}"}]}],
            "generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal"}, "responseMimeType": "application/json",
                                 "responseSchema": RERANK_SCHEMA}}
    request = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{RERANK_MODEL}:generateContent",
                                     data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", "x-goog-api-key": key})
    try:
        with urllib.request.urlopen(request, timeout=RERANK_TIMEOUT_S) as response:
            parts = json.loads(response.read())["candidates"][0]["content"]["parts"]
        order = json.loads("".join(p.get("text", "") for p in parts if not p.get("thought")))["order"]
        first = list(dict.fromkeys(i for i in order if isinstance(i, int) and 1 <= i <= len(results)))
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        print(f"search: not reranked: {error}", flush=True)
        return results
    return [results[i - 1] for i in first] + [r for i, r in enumerate(results, 1) if i not in first]
