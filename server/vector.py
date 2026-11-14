"""Vector search in MariaDB: the question embedded by embed.py's service, then the nearest article_vector rows.

Only Finnish vectors are searched: every article the app can open has one. Swedish and English vectors stay
for cross-language features; bge-m3 is multilingual, so an English question already finds Finnish text.
"""
import json
import os
import urllib.error
import urllib.request

EMBED_URL = os.environ.get("EMBED_URL", "http://127.0.0.1:8020")
TIMEOUT_S = 5
# Candidates one index search looks at (default 20). With M=16, 80 found 100% of the exact top 10 in MariaDB's
# RAG starter.
EF_SEARCH = 80


class Unavailable(Exception):
    """The embedding service did not answer: callers search without vectors."""


def embed(text):
    """The bge-m3 vector of text, as the '[x, y, ...]' that VEC_FromText reads."""
    request = urllib.request.Request(EMBED_URL, data=json.dumps({"texts": [text]}).encode(),
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_S) as response:
            return json.dumps(json.loads(response.read())["vectors"][0])
    except (OSError, ValueError, KeyError, IndexError) as error:
        raise Unavailable(f"the embedding service did not answer: {error}")


# The vector search stands alone in a subquery on article_vector, ORDER BY distance LIMIT: the shape in which
# MariaDB uses the vector index. A join in the same SELECT makes it compare every vector.
NEAREST = """SELECT page_id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS distance
             FROM article_vector WHERE lang = 'fi' ORDER BY distance LIMIT %s"""


CANDIDATES = 4  # vectors read per result wanted: some are of articles not loaded into the main table yet


def nearest(cur, vector, limit, exclude=()):
    """[(page_id, distance)] of the openable articles closest to vector, nearest first."""
    wanted = (limit + len(exclude)) * CANDIDATES
    if wanted > EF_SEARCH:  # an index search looks at no more than ef_search candidates
        cur.execute(f"SET mhnsw_ef_search = {wanted}")
    cur.execute(f"""SELECT v.page_id, v.distance FROM ({NEAREST}) v
                    JOIN m_article_stats s USING (page_id) ORDER BY v.distance""", (vector, wanted))
    if wanted > EF_SEARCH:
        cur.execute(f"SET mhnsw_ef_search = {EF_SEARCH}")
    return [(r["page_id"], r["distance"]) for r in cur.fetchall() if r["page_id"] not in exclude][:limit]


def count(cur):
    """How many openable articles have a vector."""
    cur.execute("SELECT COUNT(*) AS n FROM article_vector v JOIN m_article_stats s USING (page_id) WHERE v.lang = 'fi'")
    return cur.fetchone()["n"]


# Hybrid search: a linear sum of saturated scores. Each raw MATCH score x becomes x / (kappa + x), 0.5 at x = kappa;
# the kappas are about the median MATCH score of the top 50 candidates over the example queries in server/README.md.
KAPPA_TITLE, KAPPA_BODY = 30, 80
TITLE_WEIGHT = 2  # a word in the title says more than the same word in the text
EXACT_BONUS = 3  # more than every other term together: the article titled as the query comes first
VECTOR_WEIGHT, COSINE_FLOOR = 4, 0.4  # bge-m3 gives unrelated texts a cosine of about 0.4
HYBRID_CANDIDATES = 50  # from each of the title, text and vector searches


def hybrid_sql():
    """One statement: the candidates from the title and text FULLTEXT searches and the vector index, each scored

        TITLE_WEIGHT * sat(title MATCH) + sat(text MATCH) + EXACT_BONUS * (title = q)
          + VECTOR_WEIGHT * max(0, cosine - COSINE_FLOOR)

    Parameters by name: q (the query), boolean (its FULLTEXT boolean form), vector, limit."""
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
                        FROM article_vector WHERE lang = 'fi' ORDER BY distance LIMIT {n}) nearest)),
scored AS (
  SELECT c.page_id, s.title = %(q)s AS exact,
         MATCH (s.title) AGAINST (%(boolean)s IN BOOLEAN MODE) AS title_score,
         IFNULL(MATCH (x.text) AGAINST (%(boolean)s IN BOOLEAN MODE), 0) AS body_score,
         IFNULL(1 - VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(%(vector)s)), 0) AS cosine
  FROM candidates c JOIN m_article_stats s USING (page_id)
  LEFT JOIN m_search x USING (page_id)
  LEFT JOIN article_vector v ON v.lang = 'fi' AND v.page_id = c.page_id)
SELECT page_id, exact, title_score, body_score, cosine,
       {TITLE_WEIGHT} * title_score / ({KAPPA_TITLE} + title_score) + body_score / ({KAPPA_BODY} + body_score)
         + {EXACT_BONUS} * exact + {VECTOR_WEIGHT} * GREATEST(0, cosine - {COSINE_FLOOR}) AS score
FROM scored ORDER BY score DESC, page_id LIMIT %(limit)s"""
