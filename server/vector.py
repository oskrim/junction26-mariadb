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


# Hybrid search: a linear sum of saturated scores. Each raw MATCH score x becomes x / (kappa + x), 0.5 at x = kappa;
# the kappas are about the median MATCH score of the top 50 candidates over the example queries in server/README.md.
KAPPA_TITLE, KAPPA_BODY = 30, 80
TITLE_WEIGHT = 2  # a word in the title says more than the same word in the text
EXACT_BONUS = 3  # more than every other term together: the article titled as the query comes first
HYBRID_CANDIDATES = 50  # from each of the title, text and vector searches


def hybrid_sql(space):
    """One statement: the candidates from the title and text FULLTEXT searches and the vector index, each scored

        TITLE_WEIGHT * sat(title MATCH) + sat(text MATCH) + EXACT_BONUS * (title = q)
          + space.weight * max(0, cosine - space.floor)

    with meaning = cosine > space.floor. Parameters by name: q (the query), boolean (its FULLTEXT boolean form), vector, limit."""
    n = HYBRID_CANDIDATES
    return f"""WITH candidates AS (
  (SELECT page_id FROM m_article_stats WHERE title = %(q)s)
  UNION
  (SELECT page_id FROM m_article_stats WHERE MATCH (title) AGAINST (%(boolean)s IN BOOLEAN MODE)
   ORDER BY MATCH (title) AGAINST (%(boolean)s IN BOOLEAN MODE) DESC, CHAR_LENGTH(title) LIMIT {n})
  UNION
  (SELECT page_id FROM m_search WHERE MATCH (text) AGAINST (%(boolean)s IN BOOLEAN MODE)
   ORDER BY MATCH (text) AGAINST (%(boolean)s IN BOOLEAN MODE) DESC LIMIT {n})
  UNION
  (SELECT page_id FROM (SELECT page_id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(%(vector)s)) AS distance
                        FROM {space.table} WHERE {space.rows} ORDER BY distance LIMIT {n}) nearest)),
scored AS (
  SELECT c.page_id, s.title = %(q)s AS exact,
         MATCH (s.title) AGAINST (%(boolean)s IN BOOLEAN MODE) AS title_score,
         IFNULL(MATCH (x.text) AGAINST (%(boolean)s IN BOOLEAN MODE), 0) AS body_score,
         IFNULL(1 - VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(%(vector)s)), 0) AS cosine
  FROM candidates c JOIN m_article_stats s USING (page_id)
  LEFT JOIN m_search x USING (page_id)
  LEFT JOIN {space.table} v ON v.page_id = c.page_id AND {space.rows})
SELECT page_id, exact, title_score, body_score, cosine, cosine > {space.floor} AS meaning,
       {TITLE_WEIGHT} * title_score / ({KAPPA_TITLE} + title_score) + body_score / ({KAPPA_BODY} + body_score)
         + {EXACT_BONUS} * exact + {space.weight} * GREATEST(0, cosine - {space.floor}) AS score
FROM scored ORDER BY score DESC, page_id LIMIT %(limit)s"""
