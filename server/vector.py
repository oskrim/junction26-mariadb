"""Vector search in MariaDB: the question embedded, then the nearest article vectors.

VECTOR_MODEL picks the vectors: bge (default) embeds the question with embed.py's service and searches article_vector,
voyage embeds it with Voyage (voyage.py) and searches article_vector_voyage, none searches without vectors. When
Voyage does not answer, the question goes to bge-m3 and article_vector instead.

Only Finnish vectors are searched: every article the app can open has one. Swedish and English vectors stay
for cross-language features; both models are multilingual, so an English question already finds Finnish text.
"""
import json
import math
import os
from typing import NamedTuple
import urllib.error
import urllib.request

import pymysql

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
# of 0.05 and a 95th percentile of 0.07-0.23, and its best matches 0.4-0.6; its weight is tuned with search_eval.py.
BGE = Space("article_vector", "lang = 'fi'", 4, 0.4)
VOYAGE = Space("article_vector_voyage", "TRUE", 8, 0.15)
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


# Hybrid search: a plain weighted sum (server/README.md, tuned with search_eval.py)
#
#     body / (KAPPA_BODY + body) + W_TITLE * title / (KAPPA_TITLE + title) + EXACT_BONUS * exact
#         + space.weight * max(0, cosine - space.floor) + near * prior
#
# over the union of the best LEXICAL_CANDIDATES of the BM25 index and the nearest HYBRID_CANDIDATES of the vector
# index; every candidate gets both its BM25 scores and its cosine. Each raw BM25 score x is saturated to
# x / (kappa + x), 0.5 at x = kappa: about the median BM25 score of the top 50 articles. The prior says how much of
# an article there is (its length and, for the articles with history, how often it was edited): among articles that
# match alike, the main one on the subject comes first ("Mannerheim" finds the marshal, not the film project).
# near is 1 for an article with a word of the query in its title, else the square root of its cosine next to the
# best one's (0 to 1), so that a large article far from the query in meaning is not carried up by its size.
#
# Measured on the 42 Finnish queries of search_eval.py (hit@1 / hit@5 / MRR), candidates 200 + 200:
#     the sum without the prior, vector weight 3    0.43 / 0.60 / 0.49   (+ the old keyword gate: 0.45 / 0.64 / 0.55)
#     the sum without the prior, vector weight 8    0.55 / 0.69 / 0.60   (+ the gate: 0.55 / 0.74 / 0.61)
#     with the prior, near = 1                      0.76 / 0.95 / 0.83   (+ the gate: 0.74 / 0.93 / 0.81)
#     with the prior and near, as here              0.76 / 0.90 / 0.82
# so there is no gate. near = 1 scores the same on that set, which asks mostly for large articles, but puts them
# into unrelated results too ("Punakaarti" for "Kanteletar"). 50 vector candidates instead of 200 cost 0.03 MRR;
# 400 + 400 gave nothing over 200 + 200.
KAPPA_BODY, KAPPA_TITLE = 10, 8
W_TITLE = 0.5
EXACT_BONUS = 3  # more than every other term together: the article titled as the query comes first
LEXICAL_CANDIDATES = 200  # from the BM25 index
HYBRID_CANDIDATES = 200  # from the vector index; no more than EF_SEARCH
W_LENGTH = 1.0  # for a text of 100,000 characters or more; 0 for 1,000 or fewer, by the logarithm between
W_VERSIONS = 0.3  # for each power of ten of versions in the edit history
WORD_CHARS = 7  # about the characters per word, where only the word count is known


def lexical(body, title, exact):
    """The lexical score of an article from its BM25 scores in its text and its title, and whether its title is
    the query."""
    return body / (KAPPA_BODY + body) + W_TITLE * title / (KAPPA_TITLE + title) + EXACT_BONUS * exact


def prior(chars, versions=1):
    """The score an article gets for its size alone: its text length in characters and its number of versions."""
    return (W_LENGTH * min(1.0, max(0.0, (math.log10(max(chars or 0, 1)) - 3) / 2))
            + W_VERSIONS * math.log10(max(versions or 1, 1)))


_no_lengths = False  # m_search_length is missing: lengths are not asked for again


def priors(cur, page_ids):
    """{page_id: prior} of Finnish articles, from m_search_length and m_article_stats.versions."""
    global _no_lengths
    if not page_ids:
        return {}
    if not _no_lengths:
        try:
            cur.execute("""SELECT s.page_id, s.versions, l.chars FROM m_article_stats s
                           LEFT JOIN m_search_length l USING (page_id) WHERE s.page_id IN %s""", (list(page_ids),))
            return {r["page_id"]: prior(r["chars"], r["versions"]) for r in cur.fetchall()}
        except pymysql.err.ProgrammingError as error:  # built by `load.py bm25`; without it, versions alone
            print(f"vector: no article lengths: {error}", flush=True)
            _no_lengths = True
    cur.execute("SELECT page_id, versions FROM m_article_stats WHERE page_id IN %s", (list(page_ids),))
    return {r["page_id"]: prior(0, r["versions"]) for r in cur.fetchall()}


# Of EXACT_BONUS, for an article whose title the query is an inflected form of. All of it: the main article on a
# large subject is far from a one-word query in meaning (Helsinki: cosine 0.17 for "Helsingin"), and with less its
# sub-articles ("Helsingin historia") stay above it.
INFLECTED = 1.0
# Finnish case endings a searched title carries ("talvisodan", "Helsingissä", "Kalevalasta", "Mannerheimin").
CASE_ENDINGS = ("ssa", "ssä", "sta", "stä", "lla", "llä", "lta", "ltä", "lle", "ksi", "na", "nä", "ta", "tä",
                "in", "en", "n", "a", "ä", "t")
# Consonant gradation, weak grade (before the ending) to strong (in the title): sodan - sota, Helsingin - Helsinki.
GRADES = (("d", "t"), ("ng", "nk"), ("mm", "mp"), ("nn", "nt"), ("ll", "lt"), ("rr", "rt"), ("v", "p"),
          ("k", "kk"), ("p", "pp"), ("t", "tt"))
GRADE_CHARS = 4  # the grade changes this close to the end of the stem


def base_forms(q):
    """The titles q may be an inflected form of, lowercase: q without a case ending, with the stem's end as in the
    nominative (Suome-n: Suomi, Kekkose-n: Kekkonen, Sibeliukse-n: Sibelius) and its consonants in the strong
    grade. A guess by rules: only the ones that are titles matter."""
    asked = " ".join(q.lower().split())
    forms = set()
    for ending in CASE_ENDINGS:
        stem = asked[:-len(ending)]
        if not asked.endswith(ending) or len(stem) < 3:
            continue
        stems = {stem}
        if stem.endswith("kse"):
            stems.add(stem[:-3] + "s")
        if stem.endswith("se"):
            stems.add(stem[:-2] + "nen")
        if stem.endswith("e"):
            stems.add(stem[:-1] + "i")
        for one in list(stems):
            head, tail = one[:-GRADE_CHARS], one[-GRADE_CHARS:]
            for weak, strong in GRADES:
                at = tail.rfind(weak)
                if at >= 0:
                    stems.add(head + tail[:at] + strong + tail[at + len(weak):])
        forms |= stems
    return forms - {asked}


def inflected(cur, q):
    """The page ids of the articles q is an inflected form of the title of: Talvisota for "talvisodan", Helsinki
    for "Helsingissä". The Snowball stems differ where the consonants change (sota, sodan), so BM25 alone finds
    the sub-articles titled "Talvisodan …" and not the article itself."""
    forms = base_forms(q)
    if not forms:
        return []
    cur.execute("SELECT page_id, title FROM m_article_stats WHERE title IN %s", (sorted(forms),))
    return [r["page_id"] for r in cur.fetchall() if r["title"].lower() in forms]  # the collation also finds "Türki"


def lexical_ranking(cur, q, ids, limit):
    """{page_id: (bm25_body, bm25_title, exact)} of the article titled q (any case or accent, or with q's words
    written together; exact is True), else the ones q is an inflected form of (exact is INFLECTED), and the limit
    articles with the highest lexical score for the terms ids, best first."""
    cur.execute("SELECT page_id FROM m_article_stats WHERE title IN %s", ([q, "".join(q.split())],))
    exact = {r["page_id"]: True for r in cur.fetchall()} or {p: INFLECTED for p in inflected(cur, q)}
    found = {p: (b, t, exact[p]) for p, (b, t) in bm25.scores(cur, ids, list(exact)).items()}
    found.update((p, (0.0, 0.0, how)) for p, how in exact.items() if p not in found)
    for page_id, body, title in bm25.ranking(cur, ids, KAPPA_BODY, W_TITLE, KAPPA_TITLE, limit):
        found.setdefault(page_id, (body, title, False))
    return found


def lexical_only(cur, q, ids, limit):
    """Without vectors: the page ids of the limit best by lexical score and prior."""
    found = lexical_ranking(cur, q, ids, LEXICAL_CANDIDATES)
    return [r["page_id"] for r in combine(found, {}, SPACE, limit, priors(cur, found))]


def hybrid(cur, q, ids, query, limit):
    """The limit best of the lexical top LEXICAL_CANDIDATES and the vector top HYBRID_CANDIDATES by the sum above,
    as [{page_id, body, title, exact, cosine, meaning, score}], with meaning = cosine > space.floor. ids are q's
    bm25_term ids, query its Query."""
    space = query.space
    found = lexical_ranking(cur, q, ids, LEXICAL_CANDIDATES)
    cur.execute(f"""SELECT v.page_id, 1 - v.distance AS cosine FROM ({NEAREST.format(table=space.table, rows=space.rows)}) v
                    JOIN m_article_stats s USING (page_id)""", (query.vector, HYBRID_CANDIDATES))
    cosines = {r["page_id"]: r["cosine"] for r in cur.fetchall()}
    found.update((p, (b, t, False)) for p, (b, t) in bm25.scores(cur, ids, [p for p in cosines if p not in found]).items())
    unmeasured = [p for p in found if p not in cosines]
    if unmeasured:
        cur.execute(f"""SELECT page_id, 1 - VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS cosine
                        FROM {space.table} WHERE {space.rows} AND page_id IN %s""", (query.vector, unmeasured))
        cosines.update((r["page_id"], r["cosine"]) for r in cur.fetchall())
    guessed = guess(cosines, unmeasured)
    return combine(found, cosines, space, limit, priors(cur, found.keys() | cosines.keys()), guessed)


def guess(cosines, unmeasured):
    """The lexical candidates (unmeasured: those outside the vector top) that have no vector yet, after giving each
    in cosines the median cosine of the lexical candidates that have one. Without it such an article counts as
    cosine 0, far below every candidate with a vector (0.25-0.6), and its words alone cannot make that up."""
    known = sorted(cosines[p] for p in unmeasured if p in cosines) or sorted(cosines.values())
    guessed = {p for p in unmeasured if p not in cosines}
    if known:
        cosines.update(dict.fromkeys(guessed, known[len(known) // 2]))
    return guessed


def combine(found, cosines, space, limit, priors, guessed=()):
    """The sum above for the articles in found ({page_id: (body, title, exact)}), cosines ({page_id: cosine}) and
    priors ({page_id: prior}), the limit best. guessed are the articles whose cosine is guess()'s: not found by
    meaning."""
    top = max(cosines.values(), default=0.0)
    scored = []
    for page_id in found.keys() | cosines.keys():
        body, title, exact = found.get(page_id, (0.0, 0.0, False))
        cosine = cosines.get(page_id, 0.0)
        named = title > 0 or exact or top <= space.floor  # the query is in the title, or there are no vectors
        near = 1.0 if named else math.sqrt(min(1.0, max(0.0, (cosine - space.floor) / (top - space.floor))))
        score = (lexical(body, title, exact) + space.weight * max(0.0, cosine - space.floor)
                 + near * priors.get(page_id, 0.0))
        scored.append({"page_id": page_id, "body": body, "title": title, "exact": exact, "cosine": cosine,
                       "meaning": cosine > space.floor and page_id not in guessed, "score": score})
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
    for page_id, body, title in bm25.ranking_s(cur, lang, ids, KAPPA_BODY, W_TITLE, KAPPA_TITLE, limit):
        found.setdefault(page_id, (body, title, False))
    return found


def priors_s(cur, lang, page_ids):
    """{page_id: prior} of lang's S articles, from their word counts in article_language."""
    if not page_ids:
        return {}
    cur.execute("SELECT page_id, words FROM article_language WHERE lang = %s AND page_id IN %s", (lang, list(page_ids)))
    return {r["page_id"]: prior(r["words"] * WORD_CHARS) for r in cur.fetchall()}


def lexical_only_s(cur, lang, q, ids, limit):
    """lexical_only() over lang's S articles."""
    found = lexical_ranking_s(cur, lang, q, ids, LEXICAL_CANDIDATES)
    return [r["page_id"] for r in combine(found, {}, SPACE, limit, priors_s(cur, lang, found))]


def hybrid_s(cur, lang, q, ids, query, limit):
    """hybrid() over lang's S articles: bm25s ids of q, query from embed_s(lang, q)."""
    space = query.space
    found = lexical_ranking_s(cur, lang, q, ids, LEXICAL_CANDIDATES)
    cur.execute(NEAREST.format(table=space.table, rows=space.rows), (query.vector, HYBRID_CANDIDATES))
    cosines = {r["page_id"]: 1 - r["distance"] for r in cur.fetchall()}
    found.update((p, (b, t, False)) for p, (b, t) in bm25.scores_s(cur, lang, ids, [p for p in cosines if p not in found]).items())
    unmeasured = [p for p in found if p not in cosines]
    if unmeasured:
        cur.execute(f"""SELECT page_id, 1 - VEC_DISTANCE_COSINE(embedding, VEC_FromText(%s)) AS cosine
                        FROM {space.table} WHERE {space.rows} AND page_id IN %s""", (query.vector, unmeasured))
        cosines.update((r["page_id"], r["cosine"]) for r in cur.fetchall())
    guessed = guess(cosines, unmeasured)
    return combine(found, cosines, space, limit, priors_s(cur, lang, found.keys() | cosines.keys()), guessed)
