"""Vector search in MariaDB: the question embedded, then the nearest article vectors.

VECTOR_MODEL picks the vectors: bge (default) embeds the question with embed.py's service and searches article_vector,
voyage embeds it with Voyage (voyage.py) and searches article_vector_voyage, none searches without vectors. When
Voyage does not answer, the question goes to bge-m3 and article_vector instead.

Only Finnish vectors are searched: every article the app can open has one. Swedish and English vectors stay
for cross-language features; both models are multilingual, so an English question already finds Finnish text.
"""
import json
import os
from typing import NamedTuple
import urllib.error
import urllib.request

import bm25
import voyage

EMBED_URL = os.environ.get("EMBED_URL", "http://127.0.0.1:8020")
TIMEOUT_S = 5
# Candidates one index search looks at (default 20). With M=16 and 568,873 vectors, 80 found 86% of the exact
# top 10 and 200 found 95.5%, in ~6 ms (server/README.md).
EF_SEARCH = 200


class Unavailable(Exception):
    """The embedding service did not answer: callers search without vectors."""


class Space(NamedTuple):
    """One model's article vectors: the table and rows to search, and how its cosines map to a hybrid score."""
    table: str
    rows: str  # which rows, unqualified: only the vector table has a lang column
    weight: float
    floor: float  # about the cosine of an unrelated article


# bge-m3 gives unrelated texts a cosine of about 0.4. A voyage-4-large question gives 200 random articles a median
# of 0.05 and a 95th percentile of 0.07-0.23, and its best matches 0.4-0.6; the weight gives those what bge-m3's get.
BGE = Space("article_vector", "lang = 'fi'", 4, 0.4)
VOYAGE = Space("article_vector_voyage", "TRUE", 3, 0.15)
VECTOR_MODEL = os.environ.get("VECTOR_MODEL", "bge")
SPACE = VOYAGE if VECTOR_MODEL == "voyage" else BGE


class Query(NamedTuple):
    vector: str  # '[x, y, ...]', as VEC_FromText reads it
    space: Space


def embed(text):
    """The Query for text: its vector from the model VECTOR_MODEL names, else from bge-m3."""
    if VECTOR_MODEL == "none":
        raise Unavailable("vector search is off (VECTOR_MODEL=none)")
    if VECTOR_MODEL == "voyage":
        try:
            return Query(voyage.embed_query(text), VOYAGE)
        except voyage.Error as error:
            print(f"vector: bge-m3 instead: {error}", flush=True)
    return Query(embed_bge(text), BGE)


def embed_bge(text):
    """The bge-m3 vector of text, as the '[x, y, ...]' that VEC_FromText reads."""
    request = urllib.request.Request(EMBED_URL, data=json.dumps({"texts": [text]}).encode(),
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.dumps(json.loads(response.read())["vectors"][0])
    except (OSError, ValueError, KeyError, IndexError) as error:
        raise Unavailable(f"the embedding service did not answer: {error}")


# The vector search stands alone in a subquery on the vector table, ORDER BY distance LIMIT: the shape in which
# MariaDB uses the vector index. A join in the same SELECT makes it compare every vector.
NEAREST = """SELECT page_id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS distance
             FROM {table} WHERE {rows} ORDER BY distance LIMIT %s"""


CANDIDATES = 4  # vectors read per result wanted: some are of articles not loaded into the main table yet


def nearest(cur, query, limit, exclude=()):
    """[(page_id, distance)] of the openable articles closest to the Query's vector, nearest first."""
    wanted = (limit + len(exclude)) * CANDIDATES
    if wanted > EF_SEARCH:  # an index search looks at no more than ef_search candidates
        cur.execute(f"SET mhnsw_ef_search = {wanted}")
    nearest_sql = NEAREST.format(table=query.space.table, rows=query.space.rows)
    cur.execute(f"""SELECT v.page_id, v.distance FROM ({nearest_sql}) v
                    JOIN m_article_stats s USING (page_id) ORDER BY v.distance""", (query.vector, wanted))
    if wanted > EF_SEARCH:
        cur.execute(f"SET mhnsw_ef_search = {EF_SEARCH}")
    return [(r["page_id"], r["distance"]) for r in cur.fetchall() if r["page_id"] not in exclude][:limit]


def count(cur):
    """How many openable articles have a vector of the model VECTOR_MODEL names."""
    cur.execute(f"SELECT COUNT(*) AS n FROM {SPACE.table} v JOIN m_article_stats s USING (page_id) WHERE {SPACE.rows}")
    return cur.fetchone()["n"]


# Hybrid search: a linear sum of saturated scores (server/README.md). Each raw BM25 score x becomes x / (kappa + x),
# 0.5 at x = kappa: about the median BM25 score of the top 50 articles over the example queries in server/README.md.
KAPPA_BODY, KAPPA_TITLE = 10, 8
EXACT_BONUS = 3  # more than every other term together: the article titled as the query comes first
LEXICAL_CANDIDATES = 200  # from the BM25 index
HYBRID_CANDIDATES = 50  # from the vector index
MIN_GATE = 0.1  # the share of its keyword score an article unrelated in meaning keeps


def lexical(body, title, exact):
    """The lexical score of an article from its BM25 scores in its text and its title, and whether its title is
    the query."""
    return body / (KAPPA_BODY + body) + title / (KAPPA_TITLE + title) + EXACT_BONUS * exact


def lexical_ranking(cur, q, ids, limit):
    """{page_id: (bm25_body, bm25_title, exact)} of the article titled q (any case or accent, or with q's words
    written together) and the limit articles with the highest lexical score for the terms ids, best first."""
    cur.execute("SELECT page_id FROM m_article_stats WHERE title IN %s", ([q, "".join(q.split())],))
    exact = [r["page_id"] for r in cur.fetchall()]
    found = {p: (b, t, True) for p, (b, t) in bm25.scores(cur, ids, exact).items()}
    found.update((p, (0.0, 0.0, True)) for p in exact if p not in found)
    for page_id, body, title in bm25.ranking(cur, ids, KAPPA_BODY, KAPPA_TITLE, limit):
        found.setdefault(page_id, (body, title, False))
    return found


def hybrid(cur, q, ids, query, limit):
    """The limit best of the lexical top LEXICAL_CANDIDATES and the vector top HYBRID_CANDIDATES, each scored

        gate * lexical(bm25_body, bm25_title) + EXACT_BONUS * exact + space.weight * max(0, cosine - space.floor)

    where gate (0.1 to 1) is the article's cosine next to the best one's

    as [{page_id, body, title, exact, cosine, meaning, score}], with meaning = cosine > space.floor. ids are q's
    bm25_term ids, query its Query."""
    space = query.space
    found = lexical_ranking(cur, q, ids, LEXICAL_CANDIDATES)
    cur.execute(f"""SELECT v.page_id, 1 - v.distance AS cosine FROM ({NEAREST.format(table=space.table, rows=space.rows)}) v
                    JOIN m_article_stats s USING (page_id)""", (query.vector, HYBRID_CANDIDATES))
    cosines = {r["page_id"]: r["cosine"] for r in cur.fetchall()}
    found.update((p, (b, t, False)) for p, (b, t) in bm25.scores(cur, ids, [p for p in cosines if p not in found]).items())
    lexical_only = [p for p in found if p not in cosines]
    if lexical_only:
        cur.execute(f"""SELECT page_id, 1 - VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS cosine
                        FROM {space.table} WHERE {space.rows} AND page_id IN %s""", (query.vector, lexical_only))
        cosines.update((r["page_id"], r["cosine"]) for r in cur.fetchall())
    return combine(found, cosines, space, limit)


def combine(found, cosines, space, limit):
    """hybrid()'s scores of the articles in found ({page_id: (body, title, exact)}) and cosines ({page_id: cosine}),
    the limit best."""
    # Keyword matches count in proportion to how close in meaning they are, next to the closest article: a title
    # that only shares a word with the question ("Epica" for "epic poems", "The Who" for "who led the Reds") keeps
    # a tenth of its keyword score. An exact title keeps its bonus, and an article without a vector is not judged.
    top = max(cosines.values(), default=0.0)
    scored = []
    for page_id in found.keys() | cosines.keys():
        body, title, exact = found.get(page_id, (0.0, 0.0, False))
        cosine = cosines.get(page_id, 0.0)
        if page_id in cosines and top > space.floor:
            gate = MIN_GATE + (1 - MIN_GATE) * min(1.0, max(0.0, (cosine - space.floor) / (top - space.floor)))
        else:
            gate = 1.0
        score = gate * lexical(body, title, False) + EXACT_BONUS * exact + space.weight * max(0.0, cosine - space.floor)
        scored.append({"page_id": page_id, "body": body, "title": title, "exact": exact, "cosine": cosine,
                       "meaning": cosine > space.floor, "score": score})
    scored.sort(key=lambda r: (-r["score"], r["page_id"]))
    return scored[:limit]


# --- Swedish and English: the S articles, by lang (bm25s_* and article_vector_voyage_s) --------------------------
# Their page ids are their own wikis', so every query names lang; the Finnish tables are not read.

S_LANGS = ("sv", "en")


def voyage_s(lang):
    """The Space of lang's S article vectors (voyage-4-lite, compared with voyage-4-large questions, as VOYAGE)."""
    if lang not in S_LANGS:
        raise ValueError(lang)
    return Space("article_vector_voyage_s", f"lang = '{lang}'", VOYAGE.weight, VOYAGE.floor)


def embed_s(lang, text):
    """The Query for text in lang's S space: its voyage-4-large vector. Unavailable when Voyage does not answer."""
    try:
        return Query(voyage.embed_query(text), voyage_s(lang))
    except voyage.Error as error:
        raise Unavailable(str(error))


def lexical_ranking_s(cur, lang, q, ids, limit):
    """lexical_ranking() over lang's S articles: the article titled q (any case or accent, or with q's words
    written together) and the limit best by bm25s, as {page_id: (bm25_body, bm25_title, exact)}."""
    cur.execute("SELECT page_id FROM s_article WHERE lang = %s AND title IN %s", (lang, [q, "".join(q.split())]))
    exact = [r["page_id"] for r in cur.fetchall()]
    found = {p: (b, t, True) for p, (b, t) in bm25.scores_s(cur, lang, ids, exact).items()}
    found.update((p, (0.0, 0.0, True)) for p in exact if p not in found)
    for page_id, body, title in bm25.ranking_s(cur, lang, ids, KAPPA_BODY, KAPPA_TITLE, limit):
        found.setdefault(page_id, (body, title, False))
    return found


def hybrid_s(cur, lang, q, ids, query, limit):
    """hybrid() over lang's S articles: bm25s ids of q, query from embed_s(lang, q)."""
    space = query.space
    found = lexical_ranking_s(cur, lang, q, ids, LEXICAL_CANDIDATES)
    cur.execute(NEAREST.format(table=space.table, rows=space.rows), (query.vector, HYBRID_CANDIDATES))
    cosines = {r["page_id"]: 1 - r["distance"] for r in cur.fetchall()}
    found.update((p, (b, t, False)) for p, (b, t) in bm25.scores_s(cur, lang, ids, [p for p in cosines if p not in found]).items())
    lexical_only = [p for p in found if p not in cosines]
    if lexical_only:
        cur.execute(f"""SELECT page_id, 1 - VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS cosine
                        FROM {space.table} WHERE {space.rows} AND page_id IN %s""", (query.vector, lexical_only))
        cosines.update((r["page_id"], r["cosine"]) for r in cur.fetchall())
    return combine(found, cosines, space, limit)
