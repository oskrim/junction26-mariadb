# Server

A small Python API on MariaDB for the reader app in `../reader/`. Run every command from the repo root.

## Quick start: everything on your machine

```bash
server/local.sh                  # downloads S and M, loads all of M (~20-30 min the first time), runs the app
ARTICLES=200 server/local.sh     # a quicker partial load
L=1 server/local.sh              # also the rest of Finnish Wikipedia (dataset L, ~15 min more)
```

Then open <http://127.0.0.1:8010>. Later runs start in seconds. It needs Docker, `uv` and `curl`. Ask, Find
and Learn need `GEMINI_API_KEY` in your environment. The steps below are what the script does.

## 1. Start the database

```bash
docker compose -f server/compose.yml up -d --wait
```

MariaDB listens on `127.0.0.1:3309`. Database, user and password are all `wiki`.

## 2. Load the data

The datasets are in `~/datasets/mariadb-wikipedia`. Set `WIKI_DATA` to use another folder.

```bash
uv run --with pymysql --with pyarrow python server/load.py s   # S: fi, sv, en articles and categories (~3 s)
uv run --with pymysql --with pyarrow python server/load.py m   # M: 20 articles with every version (~50 s)
```

The M slice is "Suomen sisällissota" (page 1150) and the 19 most-edited articles that it links to.
Use `--articles N` to load a different number.
Each version is stored with its real Wikipedia edit time, so `FOR SYSTEM_TIME AS OF` shows the article on any date.
The loader also fills `m_link`: the links of each version, with the time each link was added and removed.

You can run the loader again. It skips the articles that are already loaded.
`--reset` drops the dataset's tables and loads them from the start.

## 3. Run the app

```bash
uv run --with pymysql python server/app.py
```

Open <http://127.0.0.1:8010>. Set `PORT` to use another port.
The app and the loader use the database `wiki`; set `DB_NAME` to use another one.
The JSON API is under `/api/`. See the functions in `app.py` and `reader/api.js`.

## Scale up M

```bash
uv run --with pymysql --with pyarrow python server/load.py m --articles all
```

This loads all 19,742 articles and their 862,076 versions (11.8 GB of text): about 21 minutes and 6.3 GB on the cloud box.
You can stop it and run it again: it continues where it stopped.
Links from earlier articles to articles loaded later are kept only when the target is also an S article.

## Add the rest of Finnish Wikipedia (L)

```bash
uv run --with pymysql --with pyarrow python server/load.py l
```

L is every Finnish article as it is now (568,416, Markdown). The loader adds each one that M does not have
to the main table `m_article` as a single current version, with `format = 'markdown'` and its
`date_modified` as the edit time, and to `m_article_stats` and `m_search`. So every Finnish article opens
in the app: the Article view renders the Markdown (`reader/markdown.js`), History shows one version, and
Explore shows the article with the links M articles make to it. It commits every 2,000 articles, so the
articles appear in the app while it runs, and a second run skips the ones already in. Load M first: `load.py m`
skips the articles that L already added.

## Search

`/api/search` ranks with MariaDB FULLTEXT indexes on `m_article_stats.title` and `m_search.text` (one row
per article: its Finnish S text, else its current `m_article` text). `keyword_ranking()` in `app.py`
is one SQL statement, and `vector.hybrid_sql` fuses it with the vector ranking.

- Boolean mode, every word required. Finnish inflects words and changes their stem (talvisota,
  talvisodan, talvisodassa), so each word of 7 or more letters also matches any word that starts with
  it minus its last two letters: `+(talvisota talviso*)`. Natural-language mode finds only the exact
  form, and `talvisota*` misses `talvisodan`.
- The article titled exactly as the query comes first, then the other title matches, then the text matches.
  Title matches are ordered by their text score.
- The `utf8mb4_uca1400_ai_ci` collation makes the index ignore case and accents, so `sisallissota` finds
  `sisällissota` without a folded copy of the text.
- MariaDB has no `ngram` parser (`Function 'ngram' is not defined`); it is MySQL only. The stem prefix
  covers the inflected forms that n-grams would.
- `innodb_ft_min_token_size=2` (default 3), in `compose.yml`, so `YK` and `EU` are words. It is a server
  start option and applies to indexes built after it. InnoDB's default stopword list is English, which
  removes little Finnish.

## Vector search

Every article has one [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) vector of its current version (1024
numbers, from title + text, cut at 8,192 tokens). bge-m3 is multilingual, so an English question finds Finnish
articles.

| Table | What it holds |
|---|---|
| `article_vector` | `(lang, page_id)`, `model`, `truncated`, `embedding VECTOR(1024) NOT NULL`, `VECTOR INDEX (embedding) M=16 DISTANCE=cosine` |

- S's ready-made vectors (fi, sv, en): `load.py s --vectors`, 29,460 rows in 40 s, index included. It also
  loads the files in `$WIKI_DATA/exports/` when present: the vectors the cloud box computed, exported with
  `load.py export-vectors --scope m --out /data/exports` (`vectors-bge-m3-extra-fi.parquet`, the 457 M articles S
  lacks, 2.3 MB) and `--scope l` (`vectors-bge-m3-l-fi.parquet`, the L articles), served at
  <https://65-109-75-60.sslip.io/exports/> with `SHA256SUMS`.
- On your machine: `VECTORS=1 server/local.sh` downloads the M file (with `L=1` also the L file) when its
  checksum changed, loads it, and runs `embed.py serve` for the questions (CPU: ~55 ms a question on 12 cores;
  GPU: ~7 ms).
- Every other Finnish article: `embed.py articles`, a GPU batch job (below). The search uses only the `fi` rows.
- `M=16`, not the default 6: with 1024 dimensions `M=6` found only 79% of the true top 10 (MariaDB's RAG
  starter). The app sets `mhnsw_ef_search = 80`; `deploy.sh` sets `mhnsw_max_cache_size` to 4 GB, so the
  index graph stays in memory.
- `embed.py serve` (systemd `wiki-embed`, `127.0.0.1:8020`) embeds questions with the same model. Its vectors
  agree with S's at cosine 0.9999. When it does not answer, search uses keywords only.

### Hybrid search

`/api/search` combines the FULLTEXT ranking and the vector ranking with weighted reciprocal rank fusion, in one
statement (`vector.hybrid_sql`): each article scores 1 / (60 + rank) in the FULLTEXT list plus w / (60 + rank) in
the vector list. For a query of 1 or 2 words, usually a name, w = 0.25: the title matches lead and the vectors add
what the keywords miss. For longer queries, and across languages ("battle of Tampere"), w = 1. The article titled
as the query (in any case or accent) comes first; equal scores go to the article nearer by meaning.

```sql
WITH keyword AS (<FULLTEXT ranking: page_id, keyword_rank>),
     meaning AS (SELECT page_id, ROW_NUMBER() OVER (ORDER BY distance) AS vector_rank
                 FROM (SELECT page_id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS distance
                       FROM article_vector WHERE lang = 'fi' ORDER BY distance LIMIT 50) v)
SELECT page_id, MIN(keyword_rank) AS keyword_rank, MIN(vector_rank) AS vector_rank,
       SUM(IF(keyword_rank IS NULL, :w, 1) / (60 + IFNULL(keyword_rank, vector_rank))) AS score,
       MAX(title = :q) AS exact
FROM (SELECT page_id, keyword_rank, NULL AS vector_rank FROM keyword
      UNION ALL SELECT page_id, NULL, vector_rank FROM meaning) ranks
JOIN m_article_stats USING (page_id)
GROUP BY page_id ORDER BY exact DESC, score DESC, vector_rank IS NULL, vector_rank, page_id LIMIT 20
```

The vector search stands alone in its subquery (`ORDER BY distance LIMIT`): that is the shape in which MariaDB
uses the vector index. `EXPLAIN` names the index with the `lang = 'fi'` filter too.

### Ask and Learn

- Ask embeds the question and gives Gemini the 3 nearest articles, each as it was at the moment being read
  (`FOR SYSTEM_TIME AS OF`), next to the article: "Finding related articles by meaning: 3 of N".
- Then and now: when the question names an earlier year, or the reader is on an old version, Ask reads that
  year's last version and today's, and says what each said and what changed.
- Every quote is checked word for word against the text it came from; a quote from a related article or another
  version links to it.
- Learn adds the 10 nearest articles to the linked articles it chooses from.

### Measured

On the cloud box (A100 80 GB, 22 vCPU), `wiki_full`, while the batch job was running; medians over 5 queries:

| Step | Time |
|---|---|
| Embedding the question (GPU) | 24 ms |
| Vector top 50 (`article_vector`, index) | 19 ms |
| FULLTEXT top 50 | 7 ms |
| Hybrid statement (both, fused) | 29 ms |
| `/api/search` (embedding, SQL, texts and snippets) | 207 ms |

### The GPU batch job

```bash
systemd-run --unit=wiki-embed-articles -p Nice=10 -p IOSchedulingClass=idle -p Restart=on-failure \
  --setenv=HOME=/root --setenv=UV_CACHE_DIR=/var/cache/uv --setenv=HF_HOME=/var/cache/huggingface \
  --working-directory=/srv/junction26-mariadb \
  -p StandardOutput=append:/var/log/wiki-embed/articles.log -p StandardError=append:/var/log/wiki-embed/articles.log \
  /bin/bash -c 'set -a; . /etc/junction-wiki.env; set +a; export DB_NAME=wiki_full;
  exec uv run --with torch --with transformers --with pymysql --with pyarrow python -u server/embed.py articles'
```

It embeds every Finnish article that has no `fi` row yet: first from dataset L's file (the same page ids and
current text as the main table), then whatever else is in `m_article_stats`. It writes 5,000 articles at a time,
so search improves while it runs, and on a second connection while the GPU embeds the next chunk. Stopped, it
continues where it stopped. Texts are sorted by length and batched by 160,000 padded tokens, in float16.

Measured on the A100: 145 articles/s, 100,000 tokens/s, the GPU busy ~90% of the time. Committing each chunk in
one transaction matters: with a commit per statement the vector index took only 60-70 rows/s, and four parallel
writers were slower still (45 rows/s), as they wait for each other in the index.
The NVIDIA driver comes from Ubuntu's prebuilt modules for the running kernel (`bootstrap.sh`), loaded with
`modprobe`, without a reboot.

## Scale

Measured on the cloud box (22 vCPU, 117 GB RAM, 32 GB buffer pool), database `wiki_full`, 14 November 2026.

| Dataset | Articles | Versions | Text | Where, on disk |
|---|---:|---:|---:|---|
| S | 29,460 (fi 19,285, sv 4,921, en 5,254) | 1 each | 114 MB | `s_article`, 0.16 GB |
| M | 19,742 | 862,076 | 11.8 GB | `m_article`, 6.0 GB (compressed) |
| L | 549,131 added (568,416 in L; the rest are in M) | 1 each | 1.41 GB | `m_article`, +0.9 GB |
| Search text | 568,873 | | | `m_search`, 2.1 GB |
| FULLTEXT on `m_search.text` | | | | 4.25 GB |
| FULLTEXT on `m_article_stats.title` | | | | 0.11 GB |

`load.py l` took 23 minutes (549,131 articles, FULLTEXT indexes updated as it went).

Search latency, 10 typical queries (sisällissota, Mannerheim, Tampereen taistelu, punakaarti, talvisota,
1918, jatkosota, suojeluskunta, Viipurin taistelu, Helsinki), 5 rounds each:

| What | Articles searched | p50 | p95 |
|---|---:|---:|---:|
| FULLTEXT keyword ranking (`keyword_ranking`), SQL time | 568,873 | 51 ms | 314 ms |
| `/api/search` (FULLTEXT + vectors + snippets), server time from the request log | 568,873 | 147 ms | 493 ms |
| The earlier substring search (`LOCATE` in every text) | 19,742 (M only) | 130 ms | 794 ms |

The slowest query is `Helsinki`: 64,074 articles match, 309 ms. The substring search does not scale to L: one
`LOCATE('talvisota', text)` over all 568,873 texts takes 17.9 s and finds 1,941 articles; FULLTEXT takes
28 ms and finds 5,135, with the inflected forms.
