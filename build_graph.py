"""Build the versioned page and link tables from the article history.

    uv run --with pymysql python -I build_graph.py

page has one row per article (title and length), link one row per [[link]] between two loaded
articles. Both carry Wikipedia's edit times as system time, so the graph can be read AS OF a date
without touching the article text.
"""
import re
import time

import pymysql

LINK = re.compile(r"\[\[([^\[\]|#]+)")
CURRENT_FROM_YEAR = 2100  # MariaDB marks a current row with row_end in 2106

SCHEMA = [
    """CREATE OR REPLACE TABLE page (
         page_id   INT UNSIGNED NOT NULL,
         title     VARCHAR(255) NOT NULL,
         chars     INT UNSIGNED NOT NULL,
         row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
         row_end   TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
         PERIOD FOR SYSTEM_TIME (row_start, row_end),
         PRIMARY KEY (page_id),
         KEY (title)
       ) CHARACTER SET utf8mb4 WITH SYSTEM VERSIONING""",
    """CREATE OR REPLACE TABLE link (
         src       INT UNSIGNED NOT NULL,
         dst       VARCHAR(255) NOT NULL,
         row_start TIMESTAMP(6) GENERATED ALWAYS AS ROW START INVISIBLE,
         row_end   TIMESTAMP(6) GENERATED ALWAYS AS ROW END INVISIBLE,
         PERIOD FOR SYSTEM_TIME (row_start, row_end),
         PRIMARY KEY (src, dst)
       ) CHARACTER SET utf8mb4 WITH SYSTEM VERSIONING""",
]


def normalize(title):
    title = " ".join(title.replace("_", " ").split()).lstrip(":")
    return title[:1].upper() + title[1:]


con = pymysql.connect(host="127.0.0.1", port=3308, user="wiki", password="wiki", database="wiki")
cur = con.cursor()
cur.execute("SET time_zone = '+00:00'")
cur.execute("SET system_versioning_insert_history = 1")
for statement in SCHEMA:
    cur.execute(statement)

cur.execute("SELECT DISTINCT page_id, title FROM article FOR SYSTEM_TIME ALL ORDER BY page_id")
pages = cur.fetchall()
titles = {title for _, title in pages}
started, link_rows = time.time(), 0


def insert(table, columns, history, current):
    """history rows end with row_start, row_end; current rows end with row_start only."""
    names = ",".join(columns)
    if history:
        marks = ",".join(["%s"] * (len(columns) + 2))
        cur.executemany(f"INSERT INTO {table} ({names}, row_start, row_end) VALUES ({marks})", history)
    if current:
        marks = ",".join(["%s"] * (len(columns) + 1))
        cur.executemany(f"INSERT INTO {table} ({names}, row_start) VALUES ({marks})", current)


for number, (page_id, title) in enumerate(pages, 1):
    cur.execute("""SELECT row_start, row_end, text FROM article FOR SYSTEM_TIME ALL
                   WHERE page_id = %s ORDER BY row_start""", (page_id,))
    versions = cur.fetchall()
    page_history, page_current, link_history, link_current = [], [], [], []
    opened = {}  # link target -> when it appeared
    for start, end, text in versions:
        is_current = end.year >= CURRENT_FROM_YEAR
        if is_current:
            page_current.append((page_id, title, len(text), start))
        else:
            page_history.append((page_id, title, len(text), start, end))
        targets = {t for t in map(normalize, LINK.findall(text)) if t in titles and t != title}
        for target in opened.keys() - targets:
            link_history.append((page_id, target, opened.pop(target), start))
        for target in targets - opened.keys():
            opened[target] = start
    last_end = versions[-1][1]
    for target, since in opened.items():
        if last_end.year >= CURRENT_FROM_YEAR:
            link_current.append((page_id, target, since))
        else:
            link_history.append((page_id, target, since, last_end))
    insert("page", ("page_id", "title", "chars"), page_history, page_current)
    insert("link", ("src", "dst"), link_history, link_current)
    con.commit()
    link_rows += len(link_history) + len(link_current)
    if number % 50 == 0 or number == len(pages):
        print(f"{number}/{len(pages)} articles, {link_rows} link rows, {time.time() - started:.0f} s", flush=True)

cur.execute("SELECT COUNT(*) FROM page")
current_pages = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM link")
print(f"done: {current_pages} pages and {cur.fetchone()[0]} links today, {link_rows} link rows in all")
