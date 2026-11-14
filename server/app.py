"""The reader app and its JSON API on MariaDB.

    uv run --with pymysql python server/app.py      # http://127.0.0.1:8010 ($PORT)
"""
import difflib
import hashlib
import html
import json
import os
import re
import time
import unicodedata
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import pymysql

import ask
import learn
import vector

READER = Path(__file__).resolve().parent.parent / "reader"
LANDER = Path(__file__).resolve().parent.parent / "lander"
TYPES = {".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css",
         ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".gz": "application/gzip", ".ico": "image/x-icon", ".woff2": "font/woff2"}
# The infobox picture (| kuva = X.jpg), else the first [[File:...]] in the text.
IMAGES = [re.compile(r"\|\s*(?:kuva|image)\s*=\s*(?:\[\[\s*(?:File|Image|Tiedosto|Kuva)\s*:)?\s*"
                     r"([^|\]\n{}<>=]+\.(?:jpe?g|png|gif|svg|tiff?|webp))", re.I),
          re.compile(r"\[\[\s*(?:File|Image|Tiedosto|Kuva)\s*:\s*([^|\]]+)", re.I)]


class BadRequest(Exception):
    pass


def connect():
    con = pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", 3309)),
        user=os.environ.get("DB_USER", "wiki"), password=os.environ.get("DB_PASSWORD", "wiki"),
        database=os.environ.get("DB_NAME", "wiki"),
        charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor, autocommit=True,
        # The server's certificate is self-signed, so the connection is encrypted but not verified.
        ssl={"verify_mode": False} if os.environ.get("DB_SSL") == "1" else None,
    )
    con.cursor().execute("SET time_zone = '+00:00'")
    return con


db = None  # this worker's connection, kept between requests: opening one costs ~35 ms


def database():
    """This worker's MariaDB connection, opened again when the last one broke."""
    global db
    if db is not None:
        try:
            db.ping(reconnect=False)
            return db
        except pymysql.Error:
            pass  # a failed ping has already closed the socket
    db = None
    db = connect()
    return db


def number(params, name, default=None, kind=int):
    value = params.get(name, [default])[0]
    try:
        return kind(value)
    except (TypeError, ValueError):
        raise BadRequest(f"{name} must be a number")


def moment(params):
    return datetime.fromtimestamp(number(params, "at", kind=float), timezone.utc).replace(tzinfo=None)


def stamp(value):
    return value.strftime("%Y-%m-%d %H:%M:%S.%f")


def normalize(title):
    title = " ".join(title.replace("_", " ").split()).lstrip(":")
    return title[:1].upper() + title[1:]


def articles(cur, params):
    """Every M article, or only the one given as id, with its version count and first edit."""
    page_id = number(params, "id") if "id" in params else None
    cur.execute("""SELECT page_id, title, versions, UNIX_TIMESTAMP(first) AS first FROM m_article_stats
                   WHERE %s IS NULL OR page_id = %s ORDER BY title""", (page_id, page_id))
    return [{**r, "first": int(r["first"])} for r in cur.fetchall()]


def article(cur, params):
    # The ORDER BY makes MariaDB read start_key backwards; without it, it may walk the (page_id, row_end)
    # index and decompress the text of every version that ended later.
    sql = cur.mogrify("""SELECT title, rev_id, IFNULL(user, '') AS user, IFNULL(comment, '') AS comment, row_start, text,
       format
FROM m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s
ORDER BY row_start DESC LIMIT 1""", (stamp(moment(params)), number(params, "id")))
    cur.execute(sql)
    version = cur.fetchone()
    if version:
        version["row_start"] = stamp(version["row_start"])
    return {"sql": sql, "version": version}


def history(cur, params):
    cur.execute("""SELECT rev_id, IFNULL(user, '') AS user, IFNULL(comment, '') AS comment, row_start,
                          bytes AS chars, sha1
                   FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s ORDER BY row_start""",
                (number(params, "id"),))
    return [{**r, "row_start": stamp(r["row_start"])} for r in cur.fetchall()]


def change(cur, params):
    # Text is read by primary key only: selecting it in a scan would read every version's text.
    cur.execute("SELECT page_id, row_start FROM m_article FOR SYSTEM_TIME ALL WHERE rev_id = %s",
                (number(params, "rev"),))
    edit = cur.fetchone()
    if not edit:
        return None
    cur.execute("SELECT text FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start = %s",
                (edit["page_id"], edit["row_start"]))
    edit["text"] = cur.fetchone()["text"]
    cur.execute("""SELECT text FROM m_article FOR SYSTEM_TIME ALL WHERE page_id = %s AND row_start < %s
                   ORDER BY row_start DESC LIMIT 1""", (edit["page_id"], edit["row_start"]))
    before = (cur.fetchone() or {"text": ""})["text"].splitlines()
    after = edit["text"].splitlines()
    added, removed = [], []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, before, after, autojunk=False).get_opcodes():
        if op != "equal":
            removed += before[i1:i2]
            added += after[j1:j2]
    return {"added": [line for line in added if line.strip()], "removed": [line for line in removed if line.strip()]}


MAX_NEAR = 60  # linked articles on the map
MAX_FURTHER = 70  # articles two steps away


def graph(cur, params):
    """The link graph as of at. With id, only that article's neighborhood: the articles it links with and the
    best-connected articles they link with, with each one's topic, version count and first edit."""
    at = stamp(moment(params))
    if "id" in params:
        return neighborhood(cur, number(params, "id"), at)
    cur.execute("SELECT page_id AS id, title, bytes AS chars FROM m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s", (at,))
    nodes = cur.fetchall()
    cur.execute("""SELECT DISTINCT l.src AS source, a.page_id AS target
                   FROM m_link FOR SYSTEM_TIME AS OF TIMESTAMP %s AS l
                   JOIN m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s AS a ON a.title = l.dst
                   WHERE a.page_id <> l.src""", (at, at))
    return {"nodes": nodes, "edges": cur.fetchall()}


def links_touching(cur, ids, at, incoming=True):
    """The links as of at from (and to) the given articles, as (source, target) page ids. Link targets are
    matched to the articles' current titles, and only articles that existed at `at` count."""
    sql = """SELECT l.src, s.page_id FROM m_link FOR SYSTEM_TIME AS OF TIMESTAMP %s AS l
             JOIN m_article_stats s ON s.title = l.dst
             WHERE l.src IN %s AND s.first <= %s"""
    args = [at, ids, at]
    if incoming:
        sql += """ UNION
             SELECT l.src, s.page_id FROM m_article_stats s
             STRAIGHT_JOIN m_link FOR SYSTEM_TIME AS OF TIMESTAMP %s AS l ON l.dst = s.title
             WHERE s.page_id IN %s AND s.first <= %s"""
        args += [at, ids, at]
    cur.execute(sql, args)
    return {(r["src"], r["page_id"]) for r in cur.fetchall() if r["src"] != r["page_id"]}


def neighborhood(cur, center, at):
    edges = links_touching(cur, [center], at)
    adjacent = {n for edge in edges for n in edge}
    near = adjacent - {center}
    if len(near) > 2 * MAX_NEAR:
        # A much-linked article (1150 has ~1,900): first the ones it links to, then the most edited.
        linked = {target for source, target in edges if source == center}
        cur.execute("SELECT page_id, versions FROM m_article_stats WHERE page_id IN %s", (sorted(near),))
        versions = {r["page_id"]: r["versions"] for r in cur.fetchall()}
        near = set(sorted(near, key=lambda n: (n not in linked, -versions[n]))[: 2 * MAX_NEAR])
    if near:
        edges |= links_touching(cur, sorted(near), at)
    degree = {}
    for source, target in edges:
        if source in near or source == center:
            degree[target] = degree.get(target, 0) + 1
        if target in near or target == center:
            degree[source] = degree.get(source, 0) + 1
    # The linked articles that link most with the rest of them, then the articles two steps away that most
    # of the kept ones link with.
    near = set(sorted(near, key=lambda n: -degree[n])[:MAX_NEAR])
    via = {}
    for source, target in edges:
        for n, other in ((source, target), (target, source)):
            if n not in adjacent and other in near:
                via[n] = via.get(n, 0) + 1
    kept = [center, *near, *sorted(via, key=lambda n: -via[n])[:MAX_FURTHER]]
    # Each article's size as of at: its last version that started by then, found with start_key.
    cur.execute("""SELECT s.page_id AS id, s.title, a.bytes AS chars, s.versions, UNIX_TIMESTAMP(s.first) AS first,
                          s.topic
                   FROM m_article_stats s JOIN m_article FOR SYSTEM_TIME ALL a
                     ON a.page_id = s.page_id
                    AND a.row_start = (SELECT MAX(row_start) FROM m_article FOR SYSTEM_TIME ALL
                                       WHERE page_id = s.page_id AND row_start <= %s)
                   WHERE s.page_id IN %s""", (at, kept))
    nodes = cur.fetchall()
    ids = {n["id"] for n in nodes}
    for n in nodes:
        n["first"] = int(n["first"])
    further = sorted(ids - near - {center})
    if further:  # links between two articles two steps away
        edges |= links_touching(cur, further, at, incoming=False)
    return {"nodes": nodes, "edges": [{"source": s, "target": t} for s, t in sorted(edges) if s in ids and t in ids]}


def topics(cur, params):
    cur.execute("SELECT page_id, topic FROM m_article_stats WHERE topic IS NOT NULL")
    return {r["page_id"]: r["topic"] for r in cur.fetchall()}


def extract(markdown):
    """The first real paragraph of an S article, as short HTML."""
    for line in markdown.splitlines():
        line = line.strip()
        if len(line) < 40 or line[0] in "#|!<>*-[{`":
            continue
        text = " ".join(re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", line).split())
        if len(text) > 300:
            text = text[:300].rsplit(" ", 1)[0] + " …"
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text).replace("**", "")
    return ""


THUMB_WIDTH = 330  # a standard Wikimedia thumbnail width (others answer 400), wider than every place that shows one


def thumbnail_url(name):
    """The direct upload.wikimedia.org thumbnail of a Commons file: Special:FilePath costs two redirects.

    Mirrors fileUrl in reader/api.js."""
    name = name.replace(" ", "_")
    digest = hashlib.md5(name.encode()).hexdigest()
    suffix = ".png" if name.lower().endswith(".svg") else ".jpg" if name.lower().endswith((".tif", ".tiff")) else ""
    prefix = "lossy-page1-" if suffix == ".jpg" else ""
    return (f"https://upload.wikimedia.org/wikipedia/commons/thumb/{digest[0]}/{digest[:2]}/{quote(name)}/"
            f"{prefix}{THUMB_WIDTH}px-{quote(name)}{suffix}")


def preview_of(cur, title):
    title = normalize(title)
    if not title:
        raise BadRequest("title is required")
    # Find the page_id first and read text by primary key: selecting text in a scan reads all of it.
    cur.execute("SELECT page_id, title FROM s_article WHERE lang = 'fi' AND title = %s", (title,))
    found = cur.fetchone()
    if not found:
        cur.execute("SELECT page_id, title FROM m_article WHERE title = %s", (title,))
        found = cur.fetchone()
    if not found:
        return None
    cur.execute("SELECT text FROM s_article WHERE lang = 'fi' AND page_id = %s", (found["page_id"],))
    s = cur.fetchone()
    cur.execute("SELECT text, format FROM m_article WHERE page_id = %s", (found["page_id"],))
    m = cur.fetchone()
    lead_text = s["text"] if s else m["text"] if m and m["format"] == "markdown" else None
    image = next(filter(None, (pattern.search(m["text"]) for pattern in IMAGES)), None) if m else None
    thumbnail = None
    if image:
        thumbnail = {"url": thumbnail_url(normalize(image.group(1).strip())), "width": THUMB_WIDTH, "height": None}
    # id is set only for articles the app can open (they have versions in m_article).
    return {"title": found["title"], "id": found["page_id"] if m else None,
            "extract": extract(lead_text) if lead_text else "", "thumbnail": thumbnail}


def preview(cur, params):
    return preview_of(cur, params.get("title", [""])[0])


MAX_PREVIEWS = 100


def previews(cur, params):
    """Many previews in one request: {title: preview | null} for titles=a|b|c (titles cannot hold "|")."""
    titles = list(dict.fromkeys(t for t in params.get("titles", [""])[0].split("|") if t.strip()))
    if not titles or len(titles) > MAX_PREVIEWS:
        raise BadRequest(f"titles must name 1 to {MAX_PREVIEWS} articles")
    return {title: preview_of(cur, title) for title in titles}


def prose(markdown):
    """The running text of an S article's Markdown: no headings or table rows, on one line."""
    lines = (line for line in markdown.splitlines() if not line.lstrip().startswith(("#", "|")))
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", " ".join(lines)).replace("**", "")
    return " ".join(text.split())


FILE_LINK = re.compile(r"\[\[\s*(?:File|Image|Tiedosto|Kuva|Luokka|Category)\s*:[^\[\]]*(?:\[\[[^\[\]]*\]\][^\[\]]*)*\]\]", re.I)
INNERMOST_BLOCK = re.compile(r"\{\{[^{}]*\}\}|\{\|(?:(?!\{\||\|\}).)*\|\}", re.S)


def unwiki(wikitext):
    """Wiki markup as plain text, roughly: the snippet source for M articles that have no S text."""
    text = re.sub(r"<!--.*?-->|<(timeline|gallery)[^>]*>.*?</\1>|<ref[^>]*/>|<ref[^>]*>.*?</ref>", "", wikitext, flags=re.S | re.I)
    for _ in range(100):  # templates and tables nest; each pass removes the innermost ones
        text, removed = INNERMOST_BLOCK.subn("", text)
        if not removed:
            break
    text = FILE_LINK.sub("", text)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"\[(?:https?:)?//[^\s\]]*\s*([^\]]*)\]", r"\1", text)
    text = re.sub(r"'{2,}|<[^>]+>|^=+.*?=+\s*$", "", text, flags=re.M)
    return " ".join(html.unescape(text).split())


def lead(text, width):
    """The first sentence of at least 40 characters, cut to width."""
    end = next((m.end() for m in re.finditer(r"[.!?](?=\s+[A-ZÅÄÖ0-9]|\s*$)", text) if m.end() >= 40), len(text))
    sentence = text[:end]
    return sentence if len(sentence) <= width else sentence[:width].rsplit(" ", 1)[0] + "…"


def snippet(text, span, width=160):
    """About width characters around span, a [start, end) in text, and where span sits in what is shown;
    the lead if span is None."""
    if span is None:
        return lead(text, width), None
    at, stop = span
    start = max(0, at - (width - (stop - at)) // 3)
    if start:
        start = text.find(" ", start, at) + 1 or start
    end = max(stop, start + width)
    if end < len(text):
        space = text.rfind(" ", stop, end)
        end = space if space > 0 else end
    prefix = "…" if start else ""
    shown = prefix + text[start:end] + ("…" if end < len(text) else "")
    return shown, [len(prefix) + at - start, len(prefix) + stop - start]


def words(q):
    """The words of a search query, at most MAX_WORDS of them."""
    return re.findall(r"\w+", q)[:MAX_WORDS]


def stem(word):
    """The start that Finnish inflections of word share: "talvisota" -> "talviso", which finds "talvisodan"
    too. Short words and numbers are kept whole."""
    return word if len(word) < STEM_FROM or word.isdigit() else word[:-2]


def boolean_query(q):
    """q as a FULLTEXT boolean query: every word is required, as itself or as any word that starts with
    its stem. The exact word counts more than the inflected forms."""
    return " ".join(f"+({w} {stem(w)}*)" if stem(w) != w else f"+{w}*" for w in words(q))


def find(text, q):
    """Where q, else the first word that starts with the stem of one of its words, is in text, as
    [start, end); None if neither is (any case or accent)."""
    folded = words(fold(q))
    patterns = [r"\b" + r"\W+".join(map(re.escape, folded)) + r"\w*"] + [r"\b" + re.escape(stem(w)) + r"\w*" for w in folded]
    for pattern in patterns:
        found = re.search(pattern, fold(text))
        if found:
            return list(found.span())
    return None


def fold(text):
    """Lowercase without accents, one character for each one in text, so positions in it are positions in text."""
    return "".join((unicodedata.normalize("NFKD", c.lower()) or c)[0] for c in text)


MAX_WORDS = 8
STEM_FROM = 7  # words this long or longer are also searched by their stem
SEARCH_CANDIDATES = 50  # articles each ranking gives to the fusion


def keyword_ranking(q):
    """SQL ranking the articles that match q with the FULLTEXT indexes, and its parameters: the article titled q
    first, then the other title matches, then the text matches. Title matches are ordered by how well their text
    matches, then shortest title first. MATCH ... AGAINST scores by how often the words occur in a row and how
    rare they are overall.

    The text is an article's S Markdown (Finnish), else its current m_article text: wikitext for M articles,
    Markdown for the rest of Finnish Wikipedia (L)."""
    query = boolean_query(q)
    # The exact title by its own key: hundreds of titles can match as well as it does ("... (talvisota)").
    sql = """SELECT page_id, ROW_NUMBER() OVER (ORDER BY MAX(exact) DESC, MAX(in_title) DESC, MAX(text_score) DESC,
                                                       MIN(title_length), page_id) AS keyword_rank
             FROM ((SELECT page_id, 1 AS exact, 1 AS in_title, 0 AS text_score, 0 AS title_length
                    FROM m_article_stats WHERE title = %s)
                   UNION ALL
                   (SELECT page_id, 0, 1, 0, CHAR_LENGTH(title) FROM m_article_stats
                    WHERE MATCH (title) AGAINST (%s IN BOOLEAN MODE)
                    ORDER BY MATCH (title) AGAINST (%s IN BOOLEAN MODE) DESC, CHAR_LENGTH(title) LIMIT %s)
                   UNION ALL
                   (SELECT page_id, 0, 0, MATCH (text) AGAINST (%s IN BOOLEAN MODE), 255 FROM m_search
                    WHERE MATCH (text) AGAINST (%s IN BOOLEAN MODE) ORDER BY 4 DESC LIMIT %s)) hits
             GROUP BY page_id ORDER BY keyword_rank LIMIT %s"""
    return sql, (q, query, query, SEARCH_CANDIDATES, query, query, SEARCH_CANDIDATES, SEARCH_CANDIDATES)


def search(cur, params):
    """Articles that match q by keyword or by meaning, fused by rank in one statement (vector.hybrid_sql).

    Without the embedding service, the keyword ranking alone."""
    q = params.get("q", [""])[0].strip()
    if not q:
        raise BadRequest("q is required")
    limit = number(params, "limit", 20)
    if not words(q):
        return []
    keyword_sql, keyword_args = keyword_ranking(q)
    try:
        query_vector = vector.embed(q)
        cur.execute(f"SET mhnsw_ef_search = {vector.EF_SEARCH}")
        cur.execute(vector.hybrid_sql(keyword_sql), (*keyword_args, query_vector, SEARCH_CANDIDATES, limit))
    except vector.Unavailable as error:
        print(f"search: keywords only: {error}", flush=True)
        cur.execute(f"SELECT page_id, keyword_rank, NULL AS vector_rank FROM ({keyword_sql}) k "
                    "ORDER BY keyword_rank LIMIT %s", (*keyword_args, limit))
    ranked = cur.fetchall()
    if not ranked:
        return []
    # Text by primary key; IF reads the m_article text only for articles without S text.
    cur.execute("""SELECT a.page_id, a.title, IF(s.page_id IS NULL, a.format, 'markdown') AS format,
                          IF(s.page_id IS NULL, a.text, s.text) AS text
                   FROM m_article a LEFT JOIN s_article s ON s.lang = 'fi' AND s.page_id = a.page_id
                   WHERE a.page_id IN %s""", ([r["page_id"] for r in ranked],))
    rows = {r["page_id"]: r for r in cur.fetchall()}
    results = []
    for r in ranked:
        article = rows[r["page_id"]]
        text = prose(article["text"]) if article["format"] == "markdown" else unwiki(article["text"])
        shown, match = snippet(text, find(text, q))
        results.append({"page_id": r["page_id"], "title": article["title"], "snippet": shown, "match": match,
                        "by": "both" if r["keyword_rank"] and r["vector_rank"] else "keyword" if r["keyword_rank"] else "meaning"})
    return results


ROUTES = {"/api/articles": articles, "/api/article": article, "/api/history": history, "/api/change": change,
          "/api/graph": graph, "/api/topics": topics, "/api/preview": preview, "/api/previews": previews, "/api/search": search}
# POST handlers write their own response, so they can stream.
POST_ROUTES = {"/api/ask": ask.serve, "/api/learn": learn.serve}


# Each API answer's browser cache life in seconds. A change by rev never changes; the rest only when the data
# is reloaded.
IMMUTABLE = {"/api/change"}
MAX_AGE = 300
WORKERS = int(os.environ.get("WORKERS", 16))  # ask and learn hold a worker while Gemini answers


class Server(HTTPServer):
    # The proxy opens a connection per request. The default backlog of 5 drops the rest of a burst, and the
    # client's TCP retries back off for up to a minute.
    request_queue_size = 256


class Handler(BaseHTTPRequestHandler):
    status = "-"

    def do_GET(self):
        started = time.perf_counter()
        try:
            self.route()
        finally:
            self.log_message('"%s" %s %.0f ms', self.requestline, self.status, (time.perf_counter() - started) * 1000)

    def end_headers(self):
        # The designer's static dev server (another origin) reads this API, including the streamed POSTs.
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_POST(self):
        started = time.perf_counter()
        try:
            route = POST_ROUTES.get(urlparse(self.path).path)
            if not route:
                return self.send(404, "application/json", b'{"error": "not found"}')
            route(self, database)
        finally:
            self.log_message('"%s" %s %.0f ms', self.requestline, self.status, (time.perf_counter() - started) * 1000)

    def log_request(self, code="-", size="-"):
        self.status = getattr(code, "value", code)  # logged with the duration once the request is done

    def route(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self.api(url)
        # The landing page is the home page at /home/; the bare address, with no article picked, opens it.
        if (url.path == "/" and not url.query) or url.path == "/home":
            return self.send(302, None, b"", (("Location", "/home/"),))
        root, rel = (LANDER, url.path[len("/home/"):]) if url.path.startswith("/home/") else (READER, url.path.lstrip("/"))
        path = (root / rel).resolve()
        if path.is_dir():
            path = path / "index.html"
        if root not in path.parents or not path.is_file():
            return self.send(404, "application/json", b'{"error": "not found"}')
        body = path.read_bytes()
        # Files change on deploy, so the browser asks every time, and a revisit costs a 304 without a body.
        # A file under vendor/ never changes: a new version gets a new name.
        etag = f'"{hashlib.sha1(body).hexdigest()}"'
        cache = "public, max-age=31536000, immutable" if rel.startswith("vendor/") else "no-cache"
        headers = (("ETag", etag), ("Cache-Control", cache))
        if etag in self.headers.get("If-None-Match", ""):
            return self.send(304, None, b"", headers)
        self.send(200, TYPES.get(path.suffix, "application/octet-stream"), body, headers)

    def api(self, url):
        route = ROUTES.get(url.path)
        if not route:
            return self.send(404, "application/json", b'{"error": "not found"}')
        try:
            status, result = 200, route(database().cursor(), parse_qs(url.query))
        except BadRequest as error:
            status, result = 400, {"error": str(error)}
        body = json.dumps(result, ensure_ascii=False, default=str).encode()
        if status != 200:
            return self.send(status, "application/json", body)
        cache = "public, max-age=31536000, immutable" if url.path in IMMUTABLE else f"public, max-age={MAX_AGE}"
        etag = f'"{hashlib.sha1(body).hexdigest()}"'
        headers = (("ETag", etag), ("Cache-Control", cache))
        if etag in self.headers.get("If-None-Match", ""):
            return self.send(304, None, b"", headers)
        self.send(200, "application/json", body, headers)

    def send(self, status, kind, body, headers=()):
        self.send_response(status)
        if kind:
            self.send_header("Content-Type", f"{kind}; charset=utf-8" if kind.startswith(("text", "application/json")) else kind)
            self.send_header("Content-Length", str(len(body)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)


def fork_worker(server):
    pid = os.fork()
    if pid == 0:
        try:
            try:
                database()  # before the first request, not during it
            except pymysql.Error as error:
                print(f"worker {os.getpid()}: no database yet: {error}", flush=True)
            server.serve_forever()
        finally:
            os._exit(1)
    return pid


def serve(port, workers):
    """WORKERS processes take turns accepting on one socket, each with its own database connection.

    A shared socket, not SO_REUSEPORT: the kernel then gives each new request to an idle worker, never to
    one that is streaming an answer. A worker that dies is replaced."""
    server = Server(("127.0.0.1", port), Handler)
    print(f"http://127.0.0.1:{port} ({workers} workers)", flush=True)
    for _ in range(workers):
        fork_worker(server)
    while True:
        pid, status = os.wait()
        print(f"worker {pid} exited ({status}); starting another", flush=True)
        fork_worker(server)


if __name__ == "__main__":
    serve(int(os.environ.get("PORT", 8010)), WORKERS)
