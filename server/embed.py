"""bge-m3 vectors on the GPU: the query service the app calls, and the batch job that embeds articles.

    uv run --with torch --with transformers python server/embed.py serve   # http://127.0.0.1:8020 ($EMBED_PORT)
    uv run --with torch --with transformers --with pymysql --with pyarrow python server/embed.py articles   # articles without a vector

The vectors match S's ready-made ones: BAAI/bge-m3, the [CLS] output normalized to length 1, from
"title\\n\\ntext" of the current version, cut at 8,192 tokens. The batch job is resumable: it embeds only
articles that have no row in article_vector yet.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import itertools
import json
import os
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModel, AutoTokenizer

MODEL = "bge-m3"
HF_MODEL = "BAAI/bge-m3"
MAX_TOKENS = 8192
BATCH_TOKENS = 160_000  # padded tokens per GPU batch; texts are sorted by length, so little is padding
CHUNK = 5_000  # articles read, embedded and committed together, so search improves while the job runs
IDLE_S, MAX_IDLE_S = 60, 3600
MAX_QUERY_TEXTS = 32


class Encoder:
    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.tokenizer = AutoTokenizer.from_pretrained(HF_MODEL, model_max_length=sys.maxsize)
        dtype = torch.float16 if self.device == "cuda" else torch.float32
        self.model = AutoModel.from_pretrained(HF_MODEL, dtype=dtype, attn_implementation="sdpa")
        self.model.to(self.device).eval()

    def tokenize(self, texts):
        """Token ids of each text, cut at MAX_TOKENS, and whether it was cut."""
        ids = self.tokenizer(texts, add_special_tokens=True, truncation=False)["input_ids"]
        return [i[: MAX_TOKENS - 1] + [i[-1]] if len(i) > MAX_TOKENS else i for i in ids], [len(i) > MAX_TOKENS for i in ids]

    @torch.inference_mode()
    def encode_ids(self, ids):
        """Vectors (normalized [CLS] outputs, float32) for token id lists of similar length."""
        width = max(map(len, ids))
        pad = self.tokenizer.pad_token_id
        input_ids = torch.tensor([i + [pad] * (width - len(i)) for i in ids], device=self.device)
        mask = torch.tensor([[1] * len(i) + [0] * (width - len(i)) for i in ids], device=self.device)
        cls = self.model(input_ids=input_ids, attention_mask=mask).last_hidden_state[:, 0]
        return torch.nn.functional.normalize(cls.float(), dim=-1).cpu().tolist()

    def encode(self, texts):
        """Vectors and truncated flags, in the order of texts."""
        ids, cut = self.tokenize(texts)
        order = sorted(range(len(ids)), key=lambda n: len(ids[n]))
        vectors = [None] * len(ids)
        batch = []
        for n in order + [None]:
            # A batch is full when one more (longest so far) text would pass BATCH_TOKENS once padded.
            if batch and (n is None or len(ids[n]) * (len(batch) + 1) > BATCH_TOKENS):
                for k, v in zip(batch, self.encode_ids([ids[k] for k in batch])):
                    vectors[k] = v
                batch = []
            if n is not None:
                batch.append(n)
        return vectors, cut, sum(map(len, ids))


# --- The query service ---------------------------------------------------------------------------------

def serve(port):
    encoder = Encoder()
    lock = threading.Lock()  # one GPU call at a time; a query takes a few milliseconds

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            try:
                texts = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))["texts"]
                if not (isinstance(texts, list) and 0 < len(texts) <= MAX_QUERY_TEXTS and all(isinstance(t, str) for t in texts)):
                    raise ValueError(f"texts must be 1 to {MAX_QUERY_TEXTS} strings")
            except (ValueError, KeyError, TypeError) as error:
                return self.reply(400, {"error": str(error)})
            started = time.perf_counter()
            with lock:
                vectors, _, _ = encoder.encode(texts)
            self.reply(200, {"model": MODEL, "vectors": vectors, "ms": round((time.perf_counter() - started) * 1000, 1)})

        def do_GET(self):
            self.reply(200, {"model": MODEL, "device": encoder.device})

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    encoder.encode(["warm-up"])
    print(f"embed: {HF_MODEL} on {encoder.device}, http://127.0.0.1:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


# --- The batch job -------------------------------------------------------------------------------------

def connect():
    import pymysql
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "127.0.0.1"), port=int(os.environ.get("DB_PORT", 3309)),
        user=os.environ.get("DB_USER", "wiki"), password=os.environ.get("DB_PASSWORD", "wiki"),
        database=os.environ["DB_NAME"], charset="utf8mb4", max_allowed_packet=64 << 20, autocommit=True,
    )


def packed(vector):
    """MariaDB takes a VECTOR as raw bytes: little-endian float32."""
    return struct.pack(f"<{len(vector)}f", *vector)


def missing(cur, after):
    """The ids of the next CHUNK articles after page id `after` without a Finnish vector, and their
    (page_id, title + current text).

    Markdown (articles loaded from L) is embedded as it is, like S's vectors; wikitext is made plain first."""
    from learn import wikitext_plain
    cur.execute("""SELECT s.page_id FROM m_article_stats s
                   LEFT JOIN article_vector v ON v.lang = 'fi' AND v.page_id = s.page_id
                   WHERE v.page_id IS NULL AND s.page_id > %s ORDER BY s.page_id LIMIT %s""", (after, CHUNK))
    ids = [p for (p,) in cur.fetchall()]
    if not ids:
        return [], []
    cur.execute("SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() "
                "AND table_name = 'm_article' AND column_name = 'format'")
    form = "format" if cur.fetchone() else "'wikitext'"
    # Without FOR SYSTEM_TIME, m_article returns only each article's current version.
    cur.execute(f"SELECT page_id, title, text, {form} FROM m_article WHERE page_id IN %s", (ids,))
    return ids, [(p, f"{title}\n\n{text if kind == 'markdown' else wikitext_plain(text)}") for p, title, text, kind in cur.fetchall()]


def l_dataset(cur):
    """Chunks of (page_id, title + text) from dataset L's file for the articles without a Finnish vector.

    L holds the current text of every Finnish article under the same page ids as m_article, so the GPU can start
    before the articles are loaded into the main table."""
    import pyarrow.parquet as pq
    from pathlib import Path
    path = Path(os.environ.get("WIKI_DATA", "~/datasets/mariadb-wikipedia")).expanduser() / "l-2026-10/articles-fi.parquet"
    if not path.exists():
        return
    cur.execute("SELECT page_id FROM article_vector WHERE lang = 'fi'")
    done = {p for (p,) in cur.fetchall()}
    for batch in pq.ParquetFile(path).iter_batches(batch_size=CHUNK, columns=["page_id", "title", "text"]):
        rows = [(r["page_id"], f"{r['title']}\n\n{r['text'] or ''}") for r in batch.to_pylist() if r["page_id"] not in done]
        if rows:
            yield rows


def main_table(cur):
    """Chunks of the articles in m_article_stats without a Finnish vector, as they are loaded."""
    after, in_pass, idle_since = 0, 0, None
    while True:
        ids, rows = missing(cur, after)
        if not ids:  # the end of a pass
            if in_pass:
                idle_since = None
            else:
                idle_since = idle_since or time.time()
                if time.time() - idle_since > MAX_IDLE_S:
                    return
                time.sleep(IDLE_S)
            after, in_pass = 0, 0
            continue
        after = ids[-1]
        if rows:
            in_pass += len(rows)
            yield rows


def embed_job():
    """Embeds every Finnish article that has no 'fi' row in article_vector, CHUNK at a time: first dataset L,
    then whatever else is in m_article_stats. Articles may still be loading into it: after a pass that found
    none, it looks again every IDLE_S, for at most MAX_IDLE_S."""
    con = connect()
    cur = con.cursor()
    cur.execute("SELECT DATABASE()")
    print(f"embed: database {cur.fetchone()[0]}", flush=True)
    encoder = Encoder()
    print(f"embed: {HF_MODEL} on {encoder.device}", flush=True)
    # The vectors of one chunk are written while the GPU embeds the next, on a connection of their own.
    writer, writes = ThreadPoolExecutor(1), connect().cursor()
    saving = None
    started, articles, tokens, gpu_s = time.time(), 0, 0, 0.0
    for rows in itertools.chain(l_dataset(cur), main_table(cur)):
        t0 = time.time()
        vectors, cut, n_tokens = encoder.encode([text for _, text in rows])
        gpu_s += time.time() - t0
        if saving:
            saving.result()  # raises the last write's error
        saving = writer.submit(writes.executemany, """INSERT IGNORE INTO article_vector (lang, page_id, model, truncated, embedding)
                                                      VALUES (%s, %s, %s, %s, %s)""",
                               [("fi", p, MODEL, c, packed(v)) for (p, _), v, c in zip(rows, vectors, cut)])
        articles += len(rows)
        tokens += n_tokens
        elapsed = time.time() - started
        print(f"embed: {time.strftime('%H:%M:%S')} {articles:,} embedded, {articles / elapsed:.0f} articles/s, {tokens / elapsed:,.0f} tokens/s, "
              f"{sum(cut)} cut in this chunk, {elapsed:.0f} s (GPU {gpu_s:.0f} s), last page {rows[-1][0]}", flush=True)
    if saving:
        saving.result()
    print(f"embed: done, {articles:,} articles and {tokens:,} tokens in {time.time() - started:.0f} s "
          f"(GPU {gpu_s:.0f} s)", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("what", choices=["serve", "articles"])
    args = parser.parse_args()
    if args.what == "serve":
        serve(int(os.environ.get("EMBED_PORT", 8020)))
    else:
        embed_job()


if __name__ == "__main__":
    sys.exit(main())
