"""Time-machine API and page.

    uv run --with pymysql python app.py     # http://127.0.0.1:8010
"""
import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pymysql

ARTICLES = """SELECT page_id, title, COUNT(*) AS versions, CAST(UNIX_TIMESTAMP(MIN(row_start)) AS UNSIGNED) AS first
FROM article FOR SYSTEM_TIME ALL
GROUP BY page_id, title ORDER BY title"""

AS_OF = """SELECT title, rev_id, user, comment, row_start, text
FROM article FOR SYSTEM_TIME AS OF TIMESTAMP %s
WHERE page_id = %s"""

PAGE = Path(__file__).with_name("index.html").read_bytes()


def query(sql, params=()):
    con = pymysql.connect(host="127.0.0.1", port=3308, user="wiki", password="wiki", database="wiki",
                          cursorclass=pymysql.cursors.DictCursor, init_command="SET time_zone = '+00:00'")
    try:
        with con.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall(), cur.mogrify(sql, params)
    finally:
        con.close()


class Handler(BaseHTTPRequestHandler):
    def send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, value):
        self.send(status, json.dumps(value, default=str).encode(), "application/json")

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/":
            self.send(200, PAGE, "text/html; charset=utf-8")
        elif url.path == "/api/articles":
            rows, _ = query(ARTICLES)
            self.send_json(200, rows)
        elif url.path == "/api/article":
            params = parse_qs(url.query)
            try:
                page_id = int(params["id"][0])
                moment = datetime.fromtimestamp(int(params["at"][0]), timezone.utc)
            except (KeyError, ValueError, OverflowError, OSError):
                self.send_json(400, {"error": "id and at (unix seconds) are required"})
                return
            rows, sql = query(AS_OF, (moment.strftime("%Y-%m-%d %H:%M:%S"), page_id))
            self.send_json(200, {"sql": sql, "version": rows[0] if rows else None})
        else:
            self.send_json(404, {"error": "not found"})


ThreadingHTTPServer(("127.0.0.1", 8010), Handler).serve_forever()
