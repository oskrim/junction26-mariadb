"""Voyage vectors for one machine's own database, in two separate processes that meet on disk.

    # 1. every article in the local database to shard files (resumes: articles already on disk are skipped)
    uv run --with pymysql --with snowballstemmer python server/voyage_disk.py embed --dir ~/.cache/junction26-wiki/voyage
    # 2. the shard files into the local article_vector_voyage, in page id order (resumes: fed shards are listed)
    uv run --with pymysql --with snowballstemmer python server/voyage_disk.py feed --dir ~/.cache/junction26-wiki/voyage --watch

embed reads the articles of the local database (DB_NAME, port 3309 by default) in page id order and sends them
to Voyage in requests of consecutive articles. Each answered request is written at once as one shard file,
shard-<first page id>-<last page id>.vec, through a temporary name, so a file is either whole or absent: a stop
loses only the requests in flight. A shard is a 4-byte length, a JSON header {model, dims, ids, tokens}, then
the vectors as little-endian float32, one after another in the order of ids. The text and the model are the same
as voyage.py's, so the vectors match the cloud's. When every article has a shard, embed writes DONE.

feed loads the shards it has not loaded yet into article_vector_voyage, oldest page ids first, and appends each
loaded name to fed.txt. With --watch it keeps waiting for new shards until DONE is written and all are loaded.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import queue
import struct
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).parent))
import voyage  # noqa: E402

TABLE = """CREATE TABLE IF NOT EXISTS article_vector_voyage (
  page_id   INT UNSIGNED NOT NULL,
  model     VARCHAR(50)  NOT NULL,
  tokens    INT          NOT NULL,
  embedding VECTOR(2048) NOT NULL,
  PRIMARY KEY (page_id),
  VECTOR INDEX (embedding) M=16 DISTANCE=cosine
)"""
READ = 2_000  # articles read from the database at a time
INSERT = 100  # rows per INSERT while feeding (100 x 8 KB)
BYTES = voyage.DIMENSIONS * 4


def shards(folder):
    """The finished shard files in folder, in page id order."""
    return sorted(folder.glob("shard-*.vec"))


def header(path):
    with open(path, "rb") as f:
        (size,) = struct.unpack("<I", f.read(4))
        return json.loads(f.read(size))


def write_shard(folder, ids, tokens, vectors):
    head = json.dumps({"model": voyage.DOC_MODEL, "dims": voyage.DIMENSIONS, "ids": ids, "tokens": tokens}).encode()
    path = folder / f"shard-{ids[0]:09d}-{ids[-1]:09d}.vec"
    tmp = path.with_suffix(".tmp")
    with open(tmp, "wb") as f:
        f.write(struct.pack("<I", len(head)) + head + b"".join(vectors))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# --- embed ---------------------------------------------------------------------------------------------------

def embed(folder, concurrency, batch_tokens, limit_articles=None):
    from learn import wikitext_plain
    folder.mkdir(parents=True, exist_ok=True)
    for tmp in folder.glob("*.tmp"):
        tmp.unlink()
    done = set()
    for path in shards(folder):
        done.update(header(path)["ids"])
    cur = voyage.connect().cursor()
    cur.execute("SELECT page_id FROM m_article_stats ORDER BY page_id")
    todo = [p for (p,) in cur.fetchall() if p not in done][:limit_articles]
    total = len(done) + len(todo)
    print(f"embed: {len(done):,} of {total:,} articles already on disk in {folder}; {len(todo):,} to go", flush=True)
    voyage.api_key()

    work = queue.Queue(maxsize=concurrency * 2)  # requests read ahead of the workers
    limit = voyage.RateLimit(1e12)
    stats = {"articles": 0, "tokens": 0, "failed": 0}
    lock = threading.Lock()
    started = time.time()

    def reader():
        try:
            read()
        except Exception as error:
            print(f"embed: reading the articles failed: {error}", flush=True)
            stats["failed"] += 1
        finally:  # the workers stop once the read-ahead is used up
            for _ in range(concurrency):
                work.put(None)

    def read():
        batch, size = [], 0
        for at in range(0, len(todo), READ):
            ids = todo[at:at + READ]
            cur.execute("SELECT page_id, title, text, format FROM m_article WHERE page_id IN %s", (ids,))
            texts = {p: f"{t}\n\n{x if kind == 'markdown' else wikitext_plain(x)}"[:voyage.MAX_CHARS]
                     for p, t, x, kind in cur.fetchall()}
            for p in ids:
                if p not in texts:
                    continue
                cost = voyage.estimate(texts[p])
                if batch and (len(batch) == voyage.MAX_INPUTS or size + cost > batch_tokens):
                    work.put(batch)
                    batch, size = [], 0
                batch.append((p, texts[p]))
                size += cost
        if batch:
            work.put(batch)

    def worker():
        while (batch := work.get()) is not None:
            try:
                vectors, used = voyage.call_with_retries(limit, [t for _, t in batch])
                chars = sum(len(t) for _, t in batch)
                write_shard(folder, [p for p, _ in batch], [round(used * len(t) / chars) for _, t in batch], vectors)
            except Exception as error:  # this request is left for the next run
                with lock:
                    stats["failed"] += len(batch)
                print(f"embed: gave up on pages {batch[0][0]}-{batch[-1][0]} for now: {error}", flush=True)
                continue
            with lock:
                stats["articles"] += len(batch)
                stats["tokens"] += used

    threads = [threading.Thread(target=reader, daemon=True)]
    threads += [threading.Thread(target=worker, daemon=True) for _ in range(concurrency)]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads[1:]):
        time.sleep(30)
        with lock:
            n, tokens, failed = stats["articles"], stats["tokens"], stats["failed"]
        elapsed = time.time() - started
        print(f"embed: {time.strftime('%H:%M:%S')} {len(done) + n:,}/{total:,} on disk, {n / elapsed:.0f} articles/s, "
              f"{tokens / elapsed * 60 / 1e6:.1f}M tokens/min, {tokens:,} tokens this run, {failed:,} left for a rerun",
              flush=True)
    if limit_articles is not None:
        print(f"embed: stopped after the {limit_articles:,} asked for", flush=True)
        return 0
    if stats["failed"]:
        print(f"embed: {stats['failed']:,} articles failed; run embed again to finish them", flush=True)
        return 1
    (folder / "DONE").write_text(time.strftime("%Y-%m-%d %H:%M:%S\n"))
    print(f"embed: done, {total:,} articles on disk", flush=True)
    return 0


# --- feed ----------------------------------------------------------------------------------------------------

def feed(folder, watch, workers=1):
    """Loads the shards not in fed.txt; with workers > 1, that many connections load different shards at once."""
    con = voyage.connect(autocommit=False)
    cur = con.cursor()
    cur.execute(TABLE)
    con.commit()
    ledger = folder / "fed.txt"
    fed = set(ledger.read_text().split()) if ledger.exists() else set()
    print(f"feed: {len(fed):,} shards already loaded into {os.environ['DB_NAME']}.article_vector_voyage", flush=True)
    lock = threading.Lock()
    stats = {"rows": 0}
    started = time.time()
    local = threading.local()

    def load(path):
        c = getattr(local, "con", None)
        if c is None:
            c = local.con = voyage.connect(autocommit=False)
        k = c.cursor()
        data = path.read_bytes()
        (size,) = struct.unpack("<I", data[:4])
        head = json.loads(data[4:4 + size])
        body = data[4 + size:]
        rows = [(p, head["model"], t, body[i * BYTES:(i + 1) * BYTES])
                for i, (p, t) in enumerate(zip(head["ids"], head["tokens"]))]
        for at in range(0, len(rows), INSERT):
            k.executemany("""INSERT IGNORE INTO article_vector_voyage (page_id, model, tokens, embedding)
                             VALUES (%s, %s, %s, %s)""", rows[at:at + INSERT])
        c.commit()
        with lock:
            with open(ledger, "a") as f:
                f.write(path.name + "\n")
            fed.add(path.name)
            stats["rows"] += len(rows)
            n = stats["rows"]
        print(f"feed: {time.strftime('%H:%M:%S')} {path.name}: {len(rows)} rows; {n:,} this run, "
              f"{n / (time.time() - started):.0f} rows/s", flush=True)

    with ThreadPoolExecutor(max(1, workers)) as pool:
        while True:
            finished = (folder / "DONE").exists()  # read before listing, so no shard written before DONE is missed
            new = [p for p in shards(folder) if p.name not in fed]
            list(pool.map(load, new))
            if not watch or (finished and not new):
                break
            if not new:
                time.sleep(10)
    cur.execute("SELECT COUNT(*) FROM article_vector_voyage")
    print(f"feed: done, {cur.fetchone()[0]:,} vectors in article_vector_voyage", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("what", choices=["embed", "feed"])
    parser.add_argument("--dir", type=Path, required=True, help="the folder of shard files")
    parser.add_argument("--concurrency", type=int, default=64, help="embed: Voyage requests at once")
    parser.add_argument("--batch-tokens", type=int, default=120_000, help="embed: estimated tokens per request")
    parser.add_argument("--limit", type=int, help="embed: only this many more articles (a test run)")
    parser.add_argument("--watch", action="store_true", help="feed: keep loading new shards until embed is done")
    parser.add_argument("--workers", type=int, default=1, help="feed: connections loading shards at once")
    args = parser.parse_args()
    os.environ.setdefault("DB_NAME", "wiki")
    folder = args.dir.expanduser()
    if args.what == "embed":
        return embed(folder, args.concurrency, args.batch_tokens, args.limit)
    feed(folder, args.watch, args.workers)
    return 0


if __name__ == "__main__":
    sys.exit(main())
