"""Load the MariaDB Finnish Wikipedia datasets into the tables in schema.sql.

    uv run --with pymysql --with pyarrow python server/load.py s                  # S: fi, sv, en + categories
    uv run --with pymysql --with pyarrow python server/load.py s --vectors        # ... and the bge-m3 vectors
    uv run --with pymysql --with pyarrow python server/load.py m                  # M: Suomen sisällissota + 19 more
    uv run --with pymysql --with pyarrow python server/load.py m --articles all   # M: every article
    uv run --with pymysql --with pyarrow python server/load.py l                  # L: the rest of Finnish Wikipedia

Safe to run again: articles already in the tables are skipped. --reset empties the dataset's tables first.
Data comes from $WIKI_DATA (default ~/datasets/mariadb-wikipedia).
"""
import argparse
import csv
import os
import re
import sys
import time
from collections import Counter
from datetime import timedelta
from pathlib import Path

import pyarrow.compute as pc
import pyarrow.parquet as pq
import pymysql

DATA = Path(os.environ.get("WIKI_DATA", "~/datasets/mariadb-wikipedia")).expanduser()
SCHEMA = Path(__file__).with_name("schema.sql")
DEMO_ARTICLE = 1150  # Suomen sisällissota
BATCH_BYTES = 16_000_000  # rows sent together; the server allows 64 MB packets
LINK = re.compile(r"\[\[([^\[\]|#]+)")
# article_vector is not dropped by --reset: it also holds the vectors embed.py computed on the GPU.
TABLES = {"s": ["s_article", "s_category"], "m": ["m_article", "m_link", "m_article_stats", "m_search"], "l": []}
L_BATCH = 2000  # L articles per transaction


def connect():
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", 3309)),
        user="wiki", password=os.environ.get("DB_PASSWORD", "wiki"), database=os.environ.get("DB_NAME", "wiki"),
        charset="utf8mb4",
    )


def normalize(title):
    title = " ".join(title.replace("_", " ").split()).lstrip(":")
    return title[:1].upper() + title[1:]


def create_tables(cur, dataset, reset):
    if reset:
        for table in TABLES[dataset]:
            cur.execute(f"DROP TABLE IF EXISTS {table}")
    # m_search once held lowercased text without accents as bytes, for INSTR; fill_search writes it again.
    cur.execute("""SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'm_search' AND COLUMN_NAME = 'text' AND DATA_TYPE = 'mediumblob'""")
    if dataset in ("m", "l") and cur.fetchone():
        cur.execute("DROP TABLE m_search")
    sql = "\n".join(line for line in SCHEMA.read_text().splitlines() if not line.startswith("--"))
    for statement in filter(str.strip, sql.split(";")):
        cur.execute(statement)
    # Tables created before these keys were in schema.sql.
    if dataset == "s":
        cur.execute("ALTER TABLE s_article ADD INDEX IF NOT EXISTS title (lang, title)")
    if dataset in ("m", "l"):
        cur.execute("SET system_versioning_alter_history = KEEP")
        cur.execute("ALTER TABLE m_article ADD COLUMN IF NOT EXISTS format ENUM('wikitext', 'markdown') "
                    "NOT NULL DEFAULT 'wikitext' AFTER text")
        cur.execute("ALTER TABLE m_article ADD INDEX IF NOT EXISTS start_key (page_id, row_start), "
                    "ADD INDEX IF NOT EXISTS rev_id (rev_id), ADD INDEX IF NOT EXISTS title (title)")
        cur.execute("ALTER TABLE m_link ADD INDEX IF NOT EXISTS dst (dst)")
        cur.execute("ALTER TABLE m_article_stats ADD COLUMN IF NOT EXISTS topic VARCHAR(255), "
                    "ADD INDEX IF NOT EXISTS title (title)")
        cur.execute("ALTER TABLE m_article_stats ADD FULLTEXT INDEX IF NOT EXISTS title_ft (title)")
        # Articles loaded before m_article_stats existed.
        cur.execute("SELECT EXISTS (SELECT 1 FROM m_article_stats)")
        if not cur.fetchone()[0]:
            cur.execute("""INSERT INTO m_article_stats (page_id, title, versions, first)
                           SELECT v.page_id, a.title, v.versions, v.first FROM m_article a
                           JOIN (SELECT page_id, COUNT(*) AS versions, MIN(row_start) AS first
                                 FROM m_article FOR SYSTEM_TIME ALL GROUP BY page_id) v USING (page_id)""")
            cur.connection.commit()


def insert_batched(cur, sql, rows, size_of):
    """executemany in batches that stay under the packet limit."""
    batch, size = [], 0
    for row in rows:
        if batch and size + size_of(row) > BATCH_BYTES:
            cur.executemany(sql, batch)
            batch, size = [], 0
        batch.append(row)
        size += size_of(row)
    if batch:
        cur.executemany(sql, batch)


def load_s(con, cur):
    for lang in ("fi", "sv", "en"):
        started = time.time()
        cur.execute("SELECT page_id FROM s_article WHERE lang = %s", (lang,))
        loaded = {p for (p,) in cur.fetchall()}
        table = pq.read_table(DATA / f"s-2026-10/articles-{lang}.parquet")
        rows = [
            (r["lang"], r["page_id"], r["rev_id"], r["wikidata_id"], r["title"], r["url"],
             (r["date_modified"] or "").replace("T", " ").rstrip("Z")[:19] or None, r["text"] or "")
            for r in table.to_pylist() if r["page_id"] not in loaded
        ]
        insert_batched(cur, """INSERT INTO s_article (lang, page_id, rev_id, wikidata_id, title, url,
                                date_modified, text) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                       rows, lambda r: len(r[7]) * 2 + 500)
        con.commit()
        print(f"s_article {lang}: {len(rows)} new, {len(loaded)} already loaded, {time.time() - started:.1f} s")
    started = time.time()
    with open(DATA / "s-2026-10/article-categories-fi.tsv", newline="") as f:
        rows = sorted({(int(r["page_id"]), r["category"]) for r in csv.DictReader(f, delimiter="\t")})
    insert_batched(cur, "INSERT IGNORE INTO s_category (page_id, category) VALUES (%s,%s)", rows, lambda r: 300)
    con.commit()
    print(f"s_category: {len(rows)} rows, {time.time() - started:.1f} s")


# embed.py's vectors, exported by `load.py export-vectors`: the M articles S has none for, and the L articles.
EXPORTED_VECTORS = {"m": "exports/vectors-bge-m3-extra-fi.parquet", "l": "exports/vectors-bge-m3-l-fi.parquet"}
VECTOR_BATCH = 2_000


def vector_files():
    """S's vector files, then the exported ones that have been downloaded."""
    files = [DATA / f"s-2026-10/vectors-bge-m3-{lang}.parquet" for lang in ("fi", "sv", "en")]
    return files + [DATA / name for name in EXPORTED_VECTORS.values() if (DATA / name).exists()]


def vector_bytes(column):
    """Each vector of a fixed-size float32 list column as raw bytes, which is how MariaDB takes a VECTOR:
    1024 little-endian float32 numbers. Arrow stores the numbers the same way, one after another."""
    values = column.flatten()
    data, start, size = values.buffers()[1], values.offset * 4, column.type.list_size * 4
    return [data[start + i * size : start + (i + 1) * size].to_pybytes() for i in range(len(column))]


def load_s_vectors(con, cur):
    """S's ready-made bge-m3 vectors and the exported ones. Each row goes into the vector index as it is inserted."""
    cur.execute("SELECT lang, page_id FROM article_vector")
    loaded = set(cur.fetchall())
    for path in vector_files():
        started, new = time.time(), 0
        for batch in pq.ParquetFile(path).iter_batches(batch_size=VECTOR_BATCH):
            vectors = vector_bytes(batch.column("embedding"))
            rows = [(lang, page_id, model, truncated, vector)
                    for lang, page_id, model, truncated, vector in zip(
                        batch.column("lang").to_pylist(), batch.column("page_id").to_pylist(),
                        batch.column("model").to_pylist(), batch.column("truncated").to_pylist(), vectors)
                    if (lang, page_id) not in loaded]
            if rows:
                insert_batched(cur, """INSERT INTO article_vector (lang, page_id, model, truncated, embedding)
                                       VALUES (%s,%s,%s,%s,%s)""", rows, lambda r: 8_400)
                con.commit()
                new += len(rows)
        print(f"article_vector from {path.name}: {new} new, {time.time() - started:.1f} s", flush=True)


def export_vectors(cur, out_dir, scope):
    """The Finnish vectors that S's file lacks, of the M articles (scope m, wikitext) or the L articles (scope l,
    Markdown), into a Parquet file shaped like S's in out_dir, and its line in out_dir/SHA256SUMS."""
    import hashlib
    import pyarrow as pa
    started = time.time()
    in_s = set(pq.read_table(DATA / "s-2026-10/vectors-bge-m3-fi.parquet", columns=["page_id"])["page_id"].to_pylist())
    schema = pq.read_schema(DATA / "s-2026-10/vectors-bge-m3-fi.parquet")
    out = out_dir / Path(EXPORTED_VECTORS[scope]).name
    # Without FOR SYSTEM_TIME, m_article has one row per article: its current version.
    cur.execute("""SELECT v.page_id FROM article_vector v JOIN m_article a ON a.page_id = v.page_id AND a.format = %s
                   WHERE v.lang = 'fi' ORDER BY v.page_id""", ("wikitext" if scope == "m" else "markdown",))
    ids = [p for (p,) in cur.fetchall() if p not in in_s]
    out_dir.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    with pq.ParquetWriter(part, schema, compression="zstd") as writer:
        for i in range(0, len(ids), VECTOR_BATCH):
            cur.execute("""SELECT page_id, model, truncated, embedding FROM article_vector
                           WHERE lang = 'fi' AND page_id IN %s ORDER BY page_id""", (ids[i : i + VECTOR_BATCH],))
            rows = cur.fetchall()
            flat = pa.Array.from_buffers(pa.float32(), len(rows) * 1024, [None, pa.py_buffer(b"".join(r[3] for r in rows))])
            writer.write_table(pa.table({
                "lang": ["fi"] * len(rows), "page_id": pa.array([r[0] for r in rows], pa.uint32()),
                "model": [r[1] for r in rows], "truncated": [bool(r[2]) for r in rows],
                "embedding": pa.FixedSizeListArray.from_arrays(flat, 1024)}, schema=schema))
    part.rename(out)
    digest = hashlib.sha256()
    with open(out, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            digest.update(block)
    sums = out_dir / "SHA256SUMS"
    lines = [line for line in (sums.read_text().splitlines() if sums.exists() else []) if not line.endswith(f"  {out.name}")]
    sums.write_text("".join(f"{line}\n" for line in sorted(lines + [f"{digest.hexdigest()}  {out.name}"], key=lambda l: l[66:])))
    print(f"{out}: {len(ids)} vectors, {out.stat().st_size / 1e6:.1f} MB, {time.time() - started:.0f} s")


def m_files():
    """Each M file with the page_id range of each row group (files are sorted by page_id)."""
    files = []
    for path in sorted((DATA / "m-2026-10").glob("versions-*.parquet")):
        f = pq.ParquetFile(path)
        stats = [f.metadata.row_group(i).column(0).statistics for i in range(f.metadata.num_row_groups)]
        files.append((f, [(s.min, s.max) for s in stats]))
    return files


def read_versions(files, page_id, columns=None):
    for f, ranges in files:
        groups = [i for i, (low, high) in enumerate(ranges) if low <= page_id <= high]
        if groups:
            table = f.read_row_groups(groups, columns=columns)
            return table.filter(pc.equal(table["page_id"], page_id)).to_pylist()
    return []


def pick_articles(files, count):
    """The demo article plus the count-1 most-edited M articles its current version links to,
    with every title each M article has had."""
    versions, title, titles = Counter(), {}, {}
    for f, _ in files:
        table = f.read(columns=["page_id", "title"])
        for page_id, t in zip(table["page_id"].to_pylist(), table["title"].to_pylist()):
            versions[page_id] += 1
            title[page_id] = t  # rows are oldest first, so the last one is the current title
            titles.setdefault(page_id, set()).add(normalize(t))
    if count == "all":
        return sorted(versions), titles
    by_title = {normalize(t): p for p, t in title.items()}
    current = read_versions(files, DEMO_ARTICLE, ["page_id", "text"])[-1]["text"]
    linked = {by_title[t] for t in map(normalize, LINK.findall(current)) if t in by_title} - {DEMO_ARTICLE}
    return [DEMO_ARTICLE] + sorted(linked, key=lambda p: -versions[p])[: count - 1], titles


def save_m(cur, page_id, versions, link_targets):
    """One article: every version into m_article and the links of each version into m_link."""
    versions.sort(key=lambda v: (v["timestamp"], v["rev_id"]))
    times = []
    for v in versions:
        t = v["timestamp"].replace(tzinfo=None)  # UTC; the session time zone is +00:00
        if times and t <= times[-1]:  # two edits in the same second: keep the order, 1 µs apart
            t = times[-1] + timedelta(microseconds=1)
        times.append(t)
    rows = [(page_id, v["title"], v["rev_id"], v["user"], v["anonymous"], v["comment"], v["minor"], v["sha1"],
             v["bytes"], v["text"] or "", times[i]) for i, v in enumerate(versions)]
    columns = "page_id, title, rev_id, user, anonymous, comment, minor, sha1, bytes, text, row_start"
    insert_batched(cur, f"INSERT INTO m_article ({columns}, row_end) VALUES ({', '.join(['%s'] * 12)})",
                   [r + (times[i + 1],) for i, r in enumerate(rows[:-1])], lambda r: len(r[9]) * 2 + 500)
    cur.execute(f"INSERT INTO m_article ({columns}) VALUES ({', '.join(['%s'] * 11)})", rows[-1])
    cur.execute("REPLACE INTO m_article_stats (page_id, title, versions, first) VALUES (%s,%s,%s,%s)",
                (page_id, versions[-1]["title"], len(versions), times[0]))

    # A link is current from the version that adds it until the version that removes it.
    history, opened = [], {}
    for v, start in zip(versions, times):
        own = normalize(v["title"])
        targets = {t for t in map(normalize, LINK.findall(v["text"] or "")) if t in link_targets and t != own}
        for target in opened.keys() - targets:
            history.append((page_id, target, opened.pop(target), start))
        for target in targets - opened.keys():
            opened[target] = start
    insert_batched(cur, "INSERT INTO m_link (src, dst, row_start, row_end) VALUES (%s,%s,%s,%s)",
                   history, lambda r: 300)
    insert_batched(cur, "INSERT INTO m_link (src, dst, row_start) VALUES (%s,%s,%s)",
                   sorted((page_id, t, s) for t, s in opened.items()), lambda r: 300)
    return len(history) + len(opened)


def load_m(con, cur, count):
    started = time.time()
    files = m_files()
    wanted, titles = pick_articles(files, count)
    cur.execute("SELECT DISTINCT page_id FROM m_article FOR SYSTEM_TIME ALL")
    loaded = {p for (p,) in cur.fetchall()}
    todo = [p for p in wanted if p not in loaded]
    print(f"{len(wanted)} articles picked, {len(wanted) - len(todo)} already loaded, {time.time() - started:.1f} s")

    # Link targets: Finnish S articles and every M article loaded before or in this run.
    link_targets = {normalize(t) for t in pq.read_table(DATA / "s-2026-10/articles-fi.parquet", columns=["title"])["title"].to_pylist()}
    cur.execute("SELECT DISTINCT title FROM m_article FOR SYSTEM_TIME ALL")
    link_targets |= {normalize(t) for (t,) in cur.fetchall()}
    for page_id in todo:
        link_targets |= titles[page_id]

    versions_total = links_total = 0
    for number, page_id in enumerate(todo, 1):
        t0 = time.time()
        versions = read_versions(files, page_id)
        links = save_m(cur, page_id, versions, link_targets)
        con.commit()
        versions_total += len(versions)
        links_total += links
        print(f"  {number}/{len(todo)} {versions[-1]['title']}: {len(versions)} versions, {links} link rows, "
              f"{time.time() - t0:.1f} s", flush=True)
    print(f"m: {len(todo)} articles, {versions_total} versions, {links_total} link rows, {time.time() - started:.0f} s")
    fill_search(con, cur)
    cur.execute("SELECT EXISTS (SELECT 1 FROM m_article_stats WHERE topic IS NULL)")
    if todo or cur.fetchone()[0]:
        fill_topics(con, cur)


def fill_topics(con, cur):
    """Each article's topic: its S category that the most M articles share."""
    cur.execute("""UPDATE m_article_stats st JOIN (
                     SELECT page_id, category FROM (
                       SELECT c.page_id, c.category,
                              ROW_NUMBER() OVER (PARTITION BY c.page_id ORDER BY n.articles DESC, c.category) AS rank
                       FROM s_category c
                       JOIN (SELECT c2.category, COUNT(*) AS articles FROM s_category c2
                             JOIN m_article_stats s ON s.page_id = c2.page_id GROUP BY c2.category) n
                         USING (category)) ranked
                     WHERE rank = 1) t USING (page_id)
                   SET st.topic = t.category""")
    con.commit()


def fill_search(con, cur):
    """m_search for the articles that have no row yet: the current Finnish S text, else the current M text."""
    started = time.time()
    cur.execute("""SELECT s.page_id FROM m_article_stats s LEFT JOIN m_search x USING (page_id)
                   WHERE x.page_id IS NULL ORDER BY s.page_id""")
    missing = [p for (p,) in cur.fetchall()]
    for i in range(0, len(missing), 500):
        cur.execute("""SELECT a.page_id, IF(s.page_id IS NULL, a.text, s.text) FROM m_article a
                       LEFT JOIN s_article s ON s.lang = 'fi' AND s.page_id = a.page_id
                       WHERE a.page_id IN %s""", (missing[i : i + 500],))
        rows = cur.fetchall()
        insert_batched(cur, "INSERT INTO m_search (page_id, text) VALUES (%s,%s)", rows, lambda r: len(r[1]) * 4 + 100)
        con.commit()
    print(f"m_search: {len(missing)} new, {time.time() - started:.1f} s")


def load_l(con, cur):
    """The L articles that M does not have, into m_article as one current Markdown version each (stored
    with its date_modified), with their m_article_stats and m_search rows. Committed every batch, so the
    app finds them while the load runs."""
    fill_search(con, cur)  # M's own rows first, when m_search has just been made again
    started = time.time()
    cur.execute("SELECT page_id FROM m_article_stats")
    loaded = {p for (p,) in cur.fetchall()}
    f = pq.ParquetFile(DATA / "l-2026-10/articles-fi.parquet")
    new = 0
    for group in range(f.metadata.num_row_groups):
        table = f.read_row_group(group, columns=["page_id", "rev_id", "title", "date_modified", "text"])
        rows = [r for r in table.to_pylist() if r["page_id"] not in loaded]
        for i in range(0, len(rows), L_BATCH):
            save_l(cur, rows[i : i + L_BATCH])
            con.commit()
        new += len(rows)
        print(f"  row group {group + 1}/{f.metadata.num_row_groups}: {len(rows)} new, {time.time() - started:.0f} s",
              flush=True)
    print(f"l: {new} new articles, {len(loaded)} already in M, {time.time() - started:.0f} s")
    if new:
        fill_topics(con, cur)


def save_l(cur, rows):
    rows = sorted(rows, key=lambda r: r["page_id"])
    for r in rows:
        r["text"] = r["text"] or ""
        r["at"] = r["date_modified"].replace("T", " ").rstrip("Z")
    insert_batched(cur, """INSERT INTO m_article (page_id, title, rev_id, anonymous, minor, bytes, text, format,
                           row_start) VALUES (%s,%s,%s,0,0,%s,%s,'markdown',%s)""",
                   [(r["page_id"], r["title"], r["rev_id"], len(r["text"].encode()), r["text"], r["at"]) for r in rows],
                   lambda r: len(r[4]) * 4 + 500)
    cur.executemany("INSERT INTO m_article_stats (page_id, title, versions, first) VALUES (%s,%s,1,%s)",
                    [(r["page_id"], r["title"], r["at"]) for r in rows])
    insert_batched(cur, "INSERT INTO m_search (page_id, text) VALUES (%s,%s)",
                   [(r["page_id"], r["text"]) for r in rows], lambda r: len(r[1]) * 4 + 100)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", choices=["s", "m", "l", "export-vectors"])
    parser.add_argument("--articles", default="20", help="how many M articles to load, or 'all'")
    parser.add_argument("--reset", action="store_true", help="drop and recreate the dataset's tables first")
    parser.add_argument("--vectors", action="store_true",
                        help="s: also load S's ready-made vectors and the downloaded exports/ files into article_vector")
    parser.add_argument("--out", type=Path, help="export-vectors: the directory to write to")
    parser.add_argument("--scope", choices=list(EXPORTED_VECTORS), help="export-vectors: the M or the L articles")
    args = parser.parse_args()
    count = "all" if args.articles == "all" else int(args.articles)
    con = connect()
    cur = con.cursor()
    cur.execute("SET time_zone = '+00:00'")  # Wikipedia's times are UTC
    cur.execute("SET system_versioning_insert_history = 1")
    if args.dataset == "export-vectors":
        return export_vectors(cur, args.out, args.scope)
    create_tables(cur, args.dataset, args.reset)
    started = time.time()
    if args.dataset == "s":
        load_s(con, cur)
        if args.vectors:
            load_s_vectors(con, cur)
    elif args.dataset == "m":
        load_m(con, cur, count)
    else:
        load_l(con, cur)
    for table in TABLES[args.dataset]:
        versioned = table in ("m_article", "m_link")
        cur.execute(f"SELECT COUNT(*) FROM {table}" + (" FOR SYSTEM_TIME ALL" if versioned else ""))
        print(f"{table}: {cur.fetchone()[0]} rows")
    print(f"done in {time.time() - started:.0f} s")
    con.close()


if __name__ == "__main__":
    sys.exit(main())
