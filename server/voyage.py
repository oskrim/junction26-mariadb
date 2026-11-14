"""Voyage AI vectors: articles embedded with voyage-4-lite into article_vector_voyage, questions with voyage-4-large.

    # every article without a Voyage vector, from any machine (see server/README.md, "Voyage vectors")
    uv run --with pymysql python server/voyage.py articles --tokens-per-minute 20000000
    uv run --with pymysql --with pyarrow python server/voyage.py export --out /data/exports --scope m   # or l
    uv run --with pymysql --with pyarrow python server/voyage.py import   # the downloaded exports/ files

The Voyage 4 models share one embedding space, so a voyage-4-large question vector is compared with voyage-4-lite
article vectors. Both use the full 2048 dimensions. The text of an article is the one embed.py gives bge-m3:
"title\\n\\ntext" of the current version, Markdown as it is and wikitext made plain; Voyage cuts it at 32,000 tokens.
The key is VOYAGE_API_KEY, else the Secret Manager secret voyage-api-key-global (read with gcloud).
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

URL = os.environ.get("VOYAGE_URL", "https://ai.mongodb.com/v1/embeddings")  # MongoDB Atlas keys; Voyage's own: api.voyageai.com
DOC_MODEL, QUERY_MODEL = "voyage-4-lite", "voyage-4-large"
DIMENSIONS = 2048  # the largest output_dimension of both models
QUERY_TIMEOUT_S = 3
MAX_INPUTS = 1000  # inputs per request (API limit)
MAX_CHARS = 200_000  # well past 32,000 tokens of Finnish; Voyage cuts the rest, so this only saves upload
CHARS_PER_TOKEN = 3  # a low estimate for Finnish, so a request stays under the 1M-token limit
RETRIES = 8
DATA = Path(os.environ.get("WIKI_DATA", "~/datasets/mariadb-wikipedia")).expanduser()
EXPORTED = {"m": "exports/vectors-voyage-4-lite-m-fi.parquet", "l": "exports/vectors-voyage-4-lite-l-fi.parquet"}

_key = None


class Error(Exception):
    """Voyage did not return vectors."""


def api_key():
    global _key
    if _key is None:
        _key = os.environ.get("VOYAGE_API_KEY") or subprocess.run(
            ["gcloud", "secrets", "versions", "access", "latest", "--secret=voyage-api-key-global",
             "--project=nimble-valve-390508"], capture_output=True, text=True, check=True).stdout.strip()
    return _key


def request(model, texts, input_type, timeout):
    """(vectors as raw little-endian float32 bytes, tokens counted by Voyage) for texts, in order."""
    body = json.dumps({"model": model, "input": texts, "input_type": input_type, "output_dimension": DIMENSIONS,
                       "encoding_format": "base64", "truncation": True}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Authorization": f"Bearer {api_key()}",
                                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        reply = json.loads(response.read())
    data = sorted(reply["data"], key=lambda d: d["index"])
    vectors = [base64.b64decode(d["embedding"]) for d in data]
    if len(vectors) != len(texts) or any(len(v) != DIMENSIONS * 4 for v in vectors):
        raise Error(f"{len(vectors)} vectors for {len(texts)} texts")
    return vectors, reply["usage"]["total_tokens"]


def embed_query(text):
    """The voyage-4-large vector of a question, as the '[x, y, ...]' that VEC_FromText reads. One try, short timeout."""
    import struct
    try:
        (vector,), _ = request(QUERY_MODEL, [text], "query", QUERY_TIMEOUT_S)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, Error) as error:
        raise Error(f"Voyage did not answer: {error}")
    return json.dumps(struct.unpack(f"<{DIMENSIONS}f", vector))


# --- The batch job -------------------------------------------------------------------------------------

def connect(autocommit=True):
    """The database named by DB_NAME: local by default, or the box with DB_HOST, DB_PORT=3306, DB_SSL=1."""
    import pymysql
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", 3309)),
        user=os.environ.get("DB_USER", "wiki"), password=os.environ.get("DB_PASSWORD", "wiki"),
        database=os.environ["DB_NAME"], charset="utf8mb4", max_allowed_packet=64 << 20, autocommit=autocommit,
        # The box's certificate is self-signed, so the connection is encrypted but not verified.
        ssl={"verify_mode": False} if os.environ.get("DB_SSL") == "1" else None,
    )


class RateLimit:
    """At most `per_minute` tokens a minute, spent before each request from an estimate and corrected with the
    count Voyage returns."""

    def __init__(self, per_minute):
        self.rate, self.lock = per_minute / 60, threading.Lock()
        self.allowance, self.at = 0.0, time.monotonic()

    def spend(self, tokens):
        with self.lock:
            now = time.monotonic()
            self.allowance = min(self.allowance + (now - self.at) * self.rate, self.rate * 5)
            self.at = now
            self.allowance -= tokens
            wait = -self.allowance / self.rate
        if wait > 0:
            time.sleep(wait)


def estimate(text):
    return min(len(text) // CHARS_PER_TOKEN + 1, 32_000)


def call_with_retries(limit, texts):
    """Vectors and tokens for one request: exponential backoff on 429, 5xx and network errors; a request that
    Voyage finds too large is split in two."""
    estimated = sum(map(estimate, texts))
    limit.spend(estimated)
    for attempt in range(RETRIES):
        try:
            vectors, used = request(DOC_MODEL, texts, "document", 300)
            limit.spend(used - estimated)
            return vectors, used
        except urllib.error.HTTPError as error:
            detail = error.read()[:300].decode(errors="replace")
            if error.code == 400 and len(texts) > 1 and "token" in detail.lower():
                limit.spend(-estimated)  # the halves spend their own
                half = len(texts) // 2
                (a, ta), (b, tb) = call_with_retries(limit, texts[:half]), call_with_retries(limit, texts[half:])
                return a + b, ta + tb
            if error.code != 429 and error.code < 500:
                raise Error(f"HTTP {error.code}: {detail}")
            reason = f"HTTP {error.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            reason = str(error)
        delay = min(2 ** attempt, 120) * (0.5 + random.random())
        print(f"voyage: {reason}, retry {attempt + 1}/{RETRIES} in {delay:.0f} s", flush=True)
        time.sleep(delay)
    raise Error(f"no answer after {RETRIES} tries")


def batches(rows, batch_tokens):
    """rows split into requests of at most MAX_INPUTS texts and about batch_tokens estimated tokens."""
    batch, size = [], 0
    for row in rows:
        if batch and (len(batch) == MAX_INPUTS or size + estimate(row[1]) > batch_tokens):
            yield batch
            batch, size = [], 0
        batch.append(row)
        size += estimate(row[1])
    if batch:
        yield batch


def missing(cur, after, chunk):
    """The next `chunk` articles after page id `after` without a Voyage vector: their ids, and (page_id, text)."""
    from learn import wikitext_plain
    cur.execute("""SELECT s.page_id FROM m_article_stats s LEFT JOIN article_vector_voyage v USING (page_id)
                   WHERE v.page_id IS NULL AND s.page_id > %s ORDER BY s.page_id LIMIT %s""", (after, chunk))
    ids = [p for (p,) in cur.fetchall()]
    if not ids:
        return [], []
    # Without FOR SYSTEM_TIME, m_article returns only each article's current version.
    cur.execute("SELECT page_id, title, text, format FROM m_article WHERE page_id IN %s", (ids,))
    return ids, [(p, f"{title}\n\n{text if kind == 'markdown' else wikitext_plain(text)}"[:MAX_CHARS])
                 for p, title, text, kind in cur.fetchall()]


def save(cur, rows):
    """Writes rows in one transaction and returns the seconds it took."""
    started = time.time()
    cur.executemany("""INSERT IGNORE INTO article_vector_voyage (page_id, model, tokens, embedding)
                       VALUES (%s, %s, %s, %s)""", rows)
    cur.connection.commit()
    return time.time() - started


def embed_job(per_minute, concurrency, batch_tokens, chunk, limit_articles):
    """Embeds every article in m_article_stats that has no row in article_vector_voyage, `chunk` at a time; a run
    that stops is continued by the next. The vectors of one chunk are written while the next is embedded. Stops
    after about limit_articles, when given."""
    con = connect()
    cur = con.cursor()
    cur.execute("SELECT DATABASE(), (SELECT COUNT(*) FROM m_article_stats), (SELECT COUNT(*) FROM article_vector_voyage)")
    name, total, done = cur.fetchone()
    print(f"voyage: database {name}, {done:,} of {total:,} articles have a vector; {DOC_MODEL} at {URL}", flush=True)
    api_key()
    limit, pool = RateLimit(per_minute), ThreadPoolExecutor(concurrency)
    writer, writes = ThreadPoolExecutor(1), connect(autocommit=False).cursor()
    saving, after, write_s = None, 0, 0.0
    started, articles, tokens = time.time(), 0, 0
    while limit_articles is None or articles < limit_articles:
        ids, rows = missing(cur, after, chunk if limit_articles is None else min(chunk, limit_articles - articles))
        if not ids:
            break
        after = ids[-1]
        parts = list(batches(sorted(rows, key=lambda r: len(r[1])), batch_tokens))
        results = list(pool.map(lambda part: call_with_retries(limit, [t for _, t in part]), parts))
        # Tokens per article are not returned one by one; each gets its request's tokens shared by text length.
        values = []
        for part, (vectors, used) in zip(parts, results):
            chars = sum(len(t) for _, t in part)
            values += [(p, DOC_MODEL, round(used * len(t) / chars), v) for (p, t), v in zip(part, vectors)]
            tokens += used
        if saving:
            write_s += saving.result()  # raises the last write's error
        saving = writer.submit(save, writes, sorted(values))
        articles += len(values)
        elapsed = time.time() - started
        print(f"voyage: {time.strftime('%H:%M:%S')} {done + articles:,}/{total:,}, {articles / elapsed:.0f} articles/s, "
              f"{tokens / elapsed * 60 / 1e6:.1f}M tokens/min, {tokens:,} tokens this run, writes {write_s:.0f} s, last page {after}", flush=True)
    if saving:
        saving.result()
    print(f"voyage: done, {articles:,} articles and {tokens:,} tokens in {time.time() - started:.0f} s", flush=True)


# --- Copies for local machines ---------------------------------------------------------------------------

def export(cur, out_dir, scope):
    """The Voyage vectors of the M articles (scope m, wikitext) or the L articles (scope l, Markdown) into
    out_dir as Parquet, and its line in out_dir/SHA256SUMS."""
    import hashlib
    import pyarrow as pa
    import pyarrow.parquet as pq
    started = time.time()
    out = out_dir / Path(EXPORTED[scope]).name
    cur.execute("""SELECT v.page_id FROM article_vector_voyage v JOIN m_article a ON a.page_id = v.page_id
                   AND a.format = %s ORDER BY v.page_id""", ("wikitext" if scope == "m" else "markdown",))
    ids = [p for (p,) in cur.fetchall()]
    schema = pa.schema([("page_id", pa.uint32()), ("model", pa.string()), ("tokens", pa.int32()),
                        ("embedding", pa.list_(pa.float32(), DIMENSIONS))])
    out_dir.mkdir(parents=True, exist_ok=True)
    part = out.with_name(out.name + ".part")
    with pq.ParquetWriter(part, schema, compression="zstd") as writer:
        for i in range(0, len(ids), 2000):
            cur.execute("SELECT page_id, model, tokens, embedding FROM article_vector_voyage WHERE page_id IN %s "
                        "ORDER BY page_id", (ids[i : i + 2000],))
            rows = cur.fetchall()
            flat = pa.Array.from_buffers(pa.float32(), len(rows) * DIMENSIONS, [None, pa.py_buffer(b"".join(r[3] for r in rows))])
            writer.write_table(pa.table({"page_id": [r[0] for r in rows], "model": [r[1] for r in rows],
                                         "tokens": [r[2] for r in rows],
                                         "embedding": pa.FixedSizeListArray.from_arrays(flat, DIMENSIONS)}, schema=schema))
    part.rename(out)
    digest = hashlib.sha256()
    with open(out, "rb") as f:
        for block in iter(lambda: f.read(1 << 24), b""):
            digest.update(block)
    sums = out_dir / "SHA256SUMS"
    lines = [line for line in (sums.read_text().splitlines() if sums.exists() else []) if not line.endswith(f"  {out.name}")]
    sums.write_text("".join(f"{line}\n" for line in sorted(lines + [f"{digest.hexdigest()}  {out.name}"], key=lambda l: l[66:])))
    print(f"{out}: {len(ids)} vectors, {out.stat().st_size / 1e6:.1f} MB, {time.time() - started:.0f} s")


def import_exports(con, cur):
    """The downloaded exports/ files into article_vector_voyage, skipping the vectors already there."""
    import pyarrow.parquet as pq
    cur.execute("SELECT page_id FROM article_vector_voyage")
    loaded = {p for (p,) in cur.fetchall()}
    for path in [DATA / name for name in EXPORTED.values() if (DATA / name).exists()]:
        started, new = time.time(), 0
        for batch in pq.ParquetFile(path).iter_batches(batch_size=1000):
            values = batch.column("embedding").flatten()
            data, start, size = values.buffers()[1], values.offset * 4, DIMENSIONS * 4
            rows = [(p, m, t, data[start + i * size : start + (i + 1) * size].to_pybytes())
                    for i, (p, m, t) in enumerate(zip(batch.column("page_id").to_pylist(), batch.column("model").to_pylist(),
                                                      batch.column("tokens").to_pylist())) if p not in loaded]
            if rows:
                save(cur, rows)
                new += len(rows)
        print(f"article_vector_voyage from {path.name}: {new} new, {time.time() - started:.0f} s", flush=True)
    con.commit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("what", choices=["articles", "export", "import"])
    parser.add_argument("--tokens-per-minute", type=float, default=20e6, help="articles: Voyage tokens a minute")
    parser.add_argument("--concurrency", type=int, default=24, help="articles: requests at once")
    parser.add_argument("--batch-tokens", type=int, default=300_000, help="articles: estimated tokens per request (max 1M)")
    parser.add_argument("--chunk", type=int, default=20_000, help="articles: articles read and written together")
    parser.add_argument("--limit", type=int, help="articles: stop after this many (a test run)")
    parser.add_argument("--out", type=Path, help="export: the directory to write to")
    parser.add_argument("--scope", choices=list(EXPORTED), help="export: the M or the L articles")
    args = parser.parse_args()
    if args.what == "articles":
        return embed_job(args.tokens_per_minute, args.concurrency, args.batch_tokens, args.chunk, args.limit)
    con = connect(autocommit=False)
    if args.what == "export":
        return export(con.cursor(), args.out, args.scope)
    return import_exports(con, con.cursor())


if __name__ == "__main__":
    sys.exit(main())
