"""The reader app and its JSON API on MariaDB.

    uv run --with pymysql python server/app.py      # http://127.0.0.1:8010 ($PORT)
"""
import difflib
import html
import json
import os
import queue
import re
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import pymysql

import ask

READER = Path(__file__).resolve().parent.parent / "reader"
TYPES = {".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css",
         ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".gz": "application/gzip", ".ico": "image/x-icon"}
# The infobox picture (| kuva = X.jpg), else the first [[File:...]] in the text.
IMAGES = [re.compile(r"\|\s*(?:kuva|image)\s*=\s*(?:\[\[\s*(?:File|Image|Tiedosto|Kuva)\s*:)?\s*"
                     r"([^|\]\n{}<>=]+\.(?:jpe?g|png|gif|svg|tiff?|webp))", re.I),
          re.compile(r"\[\[\s*(?:File|Image|Tiedosto|Kuva)\s*:\s*([^|\]]+)", re.I)]


class BadRequest(Exception):
    pass


def connect():
    con = pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", 3309)),
        user=os.environ.get("DB_USER", "wiki"), password=os.environ.get("DB_PASSWORD", "wiki"), database="wiki",
        charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor, autocommit=True,
        # The server's certificate is self-signed, so the connection is encrypted but not verified.
        ssl={"verify_mode": False} if os.environ.get("DB_SSL") == "1" else None,
    )
    con.cursor().execute("SET time_zone = '+00:00'")
    return con


# Connections kept open between requests: opening one takes ~30 ms, more than most queries.
IDLE = queue.SimpleQueue()
IDLE_MAX = 16


def borrow():
    try:
        con = IDLE.get_nowait()
    except queue.Empty:
        return connect()
    try:
        con.ping(reconnect=False)
    except pymysql.Error:  # closed by the server; dropping it closes the socket
        return connect()
    return con


def give_back(con):
    if IDLE.qsize() < IDLE_MAX:
        IDLE.put(con)
    else:
        con.close()


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
    cur.execute("""SELECT a.page_id, a.title, v.versions, v.first FROM m_article a
                   JOIN (SELECT page_id, COUNT(*) AS versions, UNIX_TIMESTAMP(MIN(row_start)) AS first
                         FROM m_article FOR SYSTEM_TIME ALL GROUP BY page_id) v USING (page_id)
                   ORDER BY a.title""")
    return [{**r, "first": int(r["first"])} for r in cur.fetchall()]


def article(cur, params):
    # The ORDER BY makes MariaDB read start_key backwards; without it, it may walk the (page_id, row_end)
    # index and decompress the text of every version that ended later.
    sql = cur.mogrify("""SELECT title, rev_id, IFNULL(user, '') AS user, IFNULL(comment, '') AS comment, row_start, text
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


def graph(cur, params):
    at = stamp(moment(params))
    cur.execute("SELECT page_id AS id, title, bytes AS chars FROM m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s", (at,))
    nodes = cur.fetchall()
    cur.execute("""SELECT DISTINCT l.src AS source, a.page_id AS target
                   FROM m_link FOR SYSTEM_TIME AS OF TIMESTAMP %s AS l
                   JOIN m_article FOR SYSTEM_TIME AS OF TIMESTAMP %s AS a ON a.title = l.dst
                   WHERE a.page_id <> l.src""", (at, at))
    return {"nodes": nodes, "edges": cur.fetchall()}


def topics(cur, params):
    cur.execute("""SELECT c.page_id, c.category, n.articles FROM s_category c
                   JOIN m_article a ON a.page_id = c.page_id
                   JOIN (SELECT c2.category, COUNT(*) AS articles FROM s_category c2
                         JOIN m_article a2 ON a2.page_id = c2.page_id GROUP BY c2.category) n
                     ON n.category = c.category
                   ORDER BY c.page_id, n.articles DESC, c.category""")
    result = {}
    for r in cur.fetchall():
        result.setdefault(r["page_id"], r["category"])
    return result


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


def preview(cur, params):
    title = normalize(params.get("title", [""])[0])
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
    cur.execute("SELECT text FROM m_article WHERE page_id = %s", (found["page_id"],))
    m = cur.fetchone()
    image = next(filter(None, (pattern.search(m["text"]) for pattern in IMAGES)), None) if m else None
    thumbnail = None
    if image:
        name = normalize(image.group(1).strip())
        thumbnail = {"url": f"https://commons.wikimedia.org/wiki/Special:FilePath/{quote(name)}?width=640",
                     "width": 640, "height": None}
    return {"title": found["title"], "extract": extract(s["text"]) if s else "", "thumbnail": thumbnail}


def plain(wikitext):
    """Wiki markup as plain text, roughly: for search snippets."""
    text = "\n".join(line for line in wikitext.splitlines() if not line.lstrip().startswith(("|", "{", "}", "!")))
    text = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<[^>]+>|\{\{[^{}]*\}\}|'{2,}", "", html.unescape(text), flags=re.S)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]*)\]\]", r"\1", text)
    return " ".join(re.sub(r"[\[\]{}|=*#]", " ", text).split())


def snippet(text, q, width=160):
    at = max(0, text.lower().find(q.lower()))
    start = max(0, at - width // 3)
    return ("…" if start else "") + text[start:start + width] + ("…" if start + width < len(text) else "")


def search(cur, params):
    """The current M articles whose title, then text, contains q (any case). ?in=s searches S instead."""
    q = params.get("q", [""])[0].strip()
    if not q:
        raise BadRequest("q is required")
    like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    limit = number(params, "limit", 20)
    if params.get("in", ["m"])[0] == "s":
        cur.execute("""SELECT lang, page_id, title, url,
                              SUBSTRING(text, GREATEST(1, LOCATE(%s, text) - 80), 200) AS snippet
                       FROM s_article WHERE title LIKE %s OR text LIKE %s
                       ORDER BY title LIKE %s DESC, title LIMIT %s""", (q, like, like, like, limit))
        return cur.fetchall()
    # Current rows are reached by key: a plain WHERE on m_article decompresses the text of every version.
    cur.execute("""SELECT a.page_id, a.title, SUBSTRING(a.text, GREATEST(1, LOCATE(%s, a.text) - 300), 800) AS around
                   FROM (SELECT page_id FROM m_article) c STRAIGHT_JOIN m_article a USING (page_id)
                   WHERE a.title LIKE %s OR a.text LIKE %s
                   ORDER BY a.title LIKE %s DESC, a.title LIMIT %s""", (q, like, like, like, limit))
    return [{"page_id": r["page_id"], "title": r["title"], "snippet": snippet(plain(r["around"]), q)}
            for r in cur.fetchall()]


ROUTES = {"/api/articles": articles, "/api/article": article, "/api/history": history, "/api/change": change,
          "/api/graph": graph, "/api/topics": topics, "/api/preview": preview, "/api/search": search}
# POST handlers write their own response, so they can stream.
POST_ROUTES = {"/api/ask": ask.serve}


class Handler(BaseHTTPRequestHandler):
    status = "-"

    def do_GET(self):
        started = time.perf_counter()
        try:
            self.route()
        finally:
            self.log_message('"%s" %s %.0f ms', self.requestline, self.status, (time.perf_counter() - started) * 1000)

    def do_POST(self):
        started = time.perf_counter()
        try:
            route = POST_ROUTES.get(urlparse(self.path).path)
            if not route:
                return self.send(404, "application/json", b'{"error": "not found"}')
            route(self, connect)
        finally:
            self.log_message('"%s" %s %.0f ms', self.requestline, self.status, (time.perf_counter() - started) * 1000)

    def log_request(self, code="-", size="-"):
        self.status = getattr(code, "value", code)  # logged with the duration once the request is done

    def route(self):
        url = urlparse(self.path)
        if url.path.startswith("/api/"):
            return self.api(url)
        path = (READER / url.path.lstrip("/")).resolve()
        if path.is_dir():
            path = path / "index.html"
        if READER not in path.parents or not path.is_file():
            return self.send(404, "application/json", b'{"error": "not found"}')
        self.send(200, TYPES.get(path.suffix, "application/octet-stream"), path.read_bytes())

    def api(self, url):
        route = ROUTES.get(url.path)
        if not route:
            return self.send(404, "application/json", b'{"error": "not found"}')
        con = borrow()
        try:
            status, result = 200, route(con.cursor(), parse_qs(url.query))
        except BadRequest as error:
            status, result = 400, {"error": str(error)}
        give_back(con)
        self.send(status, "application/json", json.dumps(result, ensure_ascii=False, default=str).encode())

    def send(self, status, kind, body):
        self.send_response(status)
        self.send_header("Content-Type", f"{kind}; charset=utf-8" if kind.startswith(("text", "application/json")) else kind)
        self.send_header("Content-Length", str(len(body)))
        if self.path.startswith("/api/"):
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8010))
    print(f"http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
