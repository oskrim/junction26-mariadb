"""The article search behind /api/search and the assistant's search tool: which articles answer a query, in order.

ranked() is the hybrid ranking (vector.hybrid: BM25 + Voyage cosine + prior); titled() adds each article's title
and the start of its text, which is what the assistant reads to choose.
"""
import re

import bm25
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
    "both". Without the embedding service, the BM25 ranking alone."""
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
             "lead": " ".join((rows[r["page_id"]]["lead"] or "").split()), "by": r["by"]}
            for r in found if r["page_id"] in rows]
