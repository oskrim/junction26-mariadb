"""Load article histories from a Wikipedia XML dump on stdin into the system-versioned table.

    bzcat data/simplewiki-head.xml.bz2 2>/dev/null | uv run --with pymysql python -I load.py --pages 50

Each version is stored with the time it was saved on Wikipedia, so FOR SYSTEM_TIME AS OF a date
returns the article as Wikipedia showed it on that date.
"""
import argparse
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import pymysql

parser = argparse.ArgumentParser()
parser.add_argument("--pages", type=int, default=50, help="stop after this many articles")
args = parser.parse_args()

con = pymysql.connect(host="127.0.0.1", port=3308, user="wiki", password="wiki", database="wiki")
cur = con.cursor()
cur.execute("SET time_zone = '+00:00'")  # Wikipedia's times are UTC
# Lets this session write row_start and row_end itself. Without it MariaDB stamps "now".
cur.execute("SET system_versioning_insert_history = 1")
cur.execute("SELECT DISTINCT page_id FROM article FOR SYSTEM_TIME ALL")
loaded = {row[0] for row in cur.fetchall()}

COLUMNS = "page_id, title, rev_id, user, comment, sha1, text, row_start"


def child_text(element, name):
    child = element.find("{*}" + name)
    return child.text if child is not None else None


def save(page_id, title, versions):
    versions.sort(key=lambda v: (v["time"], v["rev_id"]))
    for earlier, later in zip(versions, versions[1:]):
        if later["time"] <= earlier["time"]:  # two edits in the same second: keep the order
            later["time"] = earlier["time"] + timedelta(microseconds=1)
    rows = [(page_id, title, v["rev_id"], v["user"], v["comment"], v["sha1"], v["text"], v["time"])
            for v in versions]
    # A history row ends at the moment the next version starts.
    history = [row + (versions[i + 1]["time"],) for i, row in enumerate(rows[:-1])]
    cur.executemany(f"INSERT INTO article ({COLUMNS}, row_end) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", history)
    # The newest version gets no row_end, so MariaDB treats it as the current row.
    cur.execute(f"INSERT INTO article ({COLUMNS}) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)", rows[-1])
    con.commit()


page, keep, versions, done = None, False, [], 0
try:
    for event, el in ET.iterparse(sys.stdin.buffer, events=("start", "end")):
        name = el.tag.rsplit("}", 1)[-1]
        if event == "start":
            if name == "page":
                page, keep, versions = el, None, []
            elif name == "revision" and keep is None:
                # title, ns, id and redirect come before the first revision, so they are complete here
                keep = (child_text(page, "ns") == "0" and page.find("{*}redirect") is None
                        and int(child_text(page, "id")) not in loaded)
        elif name == "revision":
            if keep:
                contributor = el.find("{*}contributor")
                versions.append({
                    "rev_id": int(child_text(el, "id")),
                    "time": datetime.strptime(child_text(el, "timestamp"), "%Y-%m-%dT%H:%M:%SZ"),
                    "user": None if contributor is None else
                            child_text(contributor, "username") or child_text(contributor, "ip"),
                    "comment": child_text(el, "comment"),
                    "sha1": child_text(el, "sha1"),
                    "text": child_text(el, "text") or "",
                })
            el.clear()
        elif name == "page":
            if keep and versions:
                title = child_text(el, "title")
                save(int(child_text(el, "id")), title, versions)
                done += 1
                print(f"{title}: {len(versions)} versions", flush=True)
            el.clear()
            if done >= args.pages:
                break
except ET.ParseError:
    print("dump ended in the middle of a page (expected for a partial download)")

cur.execute("SELECT COUNT(DISTINCT page_id), COUNT(*) FROM article FOR SYSTEM_TIME ALL")
print("in the table: %d articles, %d versions" % cur.fetchone())
