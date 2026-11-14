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
RRF_K = 60  # reciprocal rank fusion: an article scores 1 / (RRF_K + rank) in each list it is in


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


SHORT_QUERY_WORDS = 2  # a query of this many words or fewer is usually a name: its title matches lead
SHORT_QUERY_VECTOR_WEIGHT = 0.25


def vector_weight(word_count):
    """How much the vector rank counts next to the keyword rank (1). For a name, the vectors mostly add the articles
    the keywords miss; for a question in words, and across languages, they count as much as the keywords."""
    return SHORT_QUERY_VECTOR_WEIGHT if word_count <= SHORT_QUERY_WORDS else 1.0


def hybrid_sql(keyword_sql):
    """One statement that fuses a keyword ranking and the vector ranking with weighted reciprocal rank fusion.

    keyword_sql selects page_id and a keyword_rank (1 = best) and takes its own parameters; then come (vector,
    candidates, vector weight, query, limit). Each article scores 1 / (RRF_K + rank) in the keyword list plus
    weight / (RRF_K + rank) in the vector list. The article titled as the query (in any case or accent) comes
    first; equal scores go to the article nearer by meaning."""
    return f"""WITH keyword AS ({keyword_sql}),
     meaning AS (SELECT page_id, ROW_NUMBER() OVER (ORDER BY distance) AS vector_rank FROM ({NEAREST}) v)
SELECT page_id, MIN(keyword_rank) AS keyword_rank, MIN(vector_rank) AS vector_rank,
       SUM(IF(keyword_rank IS NULL, %s, 1) / ({RRF_K} + IFNULL(keyword_rank, vector_rank))) AS score,
       MAX(title = %s) AS exact
FROM (SELECT page_id, keyword_rank, NULL AS vector_rank FROM keyword
      UNION ALL SELECT page_id, NULL, vector_rank FROM meaning) ranks
JOIN m_article_stats USING (page_id)
GROUP BY page_id ORDER BY exact DESC, score DESC, vector_rank IS NULL, vector_rank, page_id LIMIT %s"""
