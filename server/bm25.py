"""BM25 in MariaDB: an impact index of every article's search text and title.

Each (term, article) row holds the term's BM25 weight in the article's text (wb) and title (wt), with idf and
length normalization already in it, so an article's BM25 score for a query is a SUM over the query's rows.
Built by `load.py bm25`; read by `ranking` and `scores` for /api/search.
"""
import re
import unicodedata

import snowballstemmer

K1, B = 1.2, 0.75
TERM_LENGTH = 48  # longer stems are cut: they are URLs and markup, not words
WORD = re.compile(r"[^\W_]+")
# Uses PyStemmer's C stemmer when it is installed (the loader), else the pure Python one (same stems).
STEMMER = snowballstemmer.stemmer("finnish")
TMP_TABLE_BYTES = 512 << 20  # the GROUP BY of a common word holds ~300,000 articles; smaller spills to disk (17 s)


def words(text):
    """The lowercased words of text. Accents stay: ä, ö and å are letters of their own in Finnish."""
    return WORD.findall(unicodedata.normalize("NFC", text).lower())


def terms(text, cache):
    """The Finnish Snowball stem of each word of text, in order. cache maps word -> stem."""
    out = []
    for word in words(text):
        stem = cache.get(word)
        if stem is None:
            stem = cache[word] = STEMMER.stemWord(word)[:TERM_LENGTH]
        out.append(stem)
    return out


def session_sql():
    """Run once per connection that searches."""
    return f"SET SESSION tmp_table_size = {TMP_TABLE_BYTES}, max_heap_table_size = {TMP_TABLE_BYTES}"


def term_ids(cur, q):
    """The bm25_term ids of the query's distinct stems; stems no article has are left out."""
    stems = sorted(set(terms(q, {})))
    if not stems:
        return []
    cur.execute("SELECT term_id FROM bm25_term WHERE term IN %s ORDER BY term_id", (stems,))
    return [r["term_id"] for r in cur.fetchall()]


def ranking(cur, ids, kappa_body, kappa_title, limit):
    """[(page_id, bm25_body, bm25_title)] of the limit articles with the highest
    bm25_body / (kappa_body + bm25_body) + bm25_title / (kappa_title + bm25_title) for the terms ids."""
    if not ids:
        return []
    cur.execute(f"""SELECT page_id, SUM(wb) AS body, SUM(wt) AS title FROM bm25_posting WHERE term_id IN %s
                    GROUP BY page_id
                    ORDER BY SUM(wb) / ({kappa_body:g} + SUM(wb)) + SUM(wt) / ({kappa_title:g} + SUM(wt)) DESC, page_id
                    LIMIT %s""", (ids, limit))
    return [(r["page_id"], r["body"], r["title"]) for r in cur.fetchall()]


def scores(cur, ids, page_ids):
    """{page_id: (bm25_body, bm25_title)} of the given articles, by primary key; articles without any of the
    terms are left out."""
    if not ids or not page_ids:
        return {}
    cur.execute("""SELECT page_id, SUM(wb) AS body, SUM(wt) AS title FROM bm25_posting
                   WHERE term_id IN %s AND page_id IN %s GROUP BY page_id""", (ids, list(page_ids)))
    return {r["page_id"]: (r["body"], r["title"]) for r in cur.fetchall()}
