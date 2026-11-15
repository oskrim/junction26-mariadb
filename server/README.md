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
uv run --with pymysql --with pyarrow --with numpy --with snowballstemmer --with PyStemmer \
  python server/load.py bm25                                   # the search index (seconds; ~6 min with L)
```

The M slice is "Suomen sisällissota" (page 1150) and the 19 most-edited articles that it links to.
Use `--articles N` to load a different number.
Each version is stored with its real Wikipedia edit time, so `FOR SYSTEM_TIME AS OF` shows the article on any date.
The loader also fills `m_link`: the links of each version, with the time each link was added and removed.

You can run the loader again. It skips the articles that are already loaded.
`--reset` drops the dataset's tables and loads them from the start.

## 3. Run the app

```bash
uv run --with pymysql --with snowballstemmer --with PyStemmer python server/app.py
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

## BM25 in MariaDB

`/api/search` ranks words with true BM25, computed inside MariaDB from an impact index: one row per (term,
article) with the term's BM25 weight already in it, so a query's score is a `SUM` over its terms' rows.
`server/bm25.py` holds the tokenizer and the queries; `load.py bm25` builds the tables.

| Table | What it holds | wiki_full |
|---|---|---:|
| `bm25_term` | `term_id` (PK), `term VARCHAR(48) COLLATE utf8mb4_bin` (UNIQUE), `df`: articles with the term | 2,620,195 rows, 0.17 GB |
| `bm25_posting` | `(term_id, page_id)` (PK), `wb`, `wt` (FLOAT): the term's BM25 weight in the text and in the title | 85.4M rows, 3.2 GB |
| `bm25_stats` | `articles`, `avg_body`, `avg_title`: 568,873, 265 and 2.2 terms | 1 row |

- Text: `m_search.text` (the article's Finnish S text, else its current `m_article` text). Title:
  `m_article_stats.title`.
- Terms: the words (`[^\W_]+`) lowercased, NFC, with ä, ö and å kept (they are letters of their own in Finnish),
  then the Finnish Snowball stem (`snowballstemmer`; with `PyStemmer` installed it runs the C stemmer), cut at
  48 characters.
- Weights, per field: `idf · tf · (k1 + 1) / (tf + k1 · (1 − b + b · length / average length))`, with
  `idf = ln(1 + (N − df + 0.5) / (df + 0.5))`, k1 = 1.2, b = 0.75, df counted in that field.
- The query is stemmed the same way. Its words written together are one more term ("Lapuan liike" also looks
  for `lapuanliik`), because Finnish compounds are often typed apart.

```sql
SET SESSION tmp_table_size = 536870912, max_heap_table_size = 536870912;  -- app.connect, every worker

SELECT page_id, SUM(wb) AS body, SUM(wt) AS title FROM bm25_posting
WHERE term_id IN (:term_ids)
GROUP BY page_id
ORDER BY SUM(wb) / (10 + SUM(wb)) + SUM(wt) / (8 + SUM(wt)) DESC, page_id
LIMIT 200
```

The primary key `(term_id, page_id)` makes each term's rows one range read. The GROUP BY of a common word holds
~300,000 articles: with the default 16 MB temporary tables it goes to disk and takes 17 s; with 512 MB, 440 ms
for `ja` (510,000 articles).

**Build.** `load.py bm25` reads every text in page_id order, counts terms in Python, computes the weights with
numpy, sorts the rows by term (stable, so primary key order) and loads them with `LOAD DATA LOCAL INFILE` into
`bm25_*_new`. One `RENAME TABLE` swaps all three in, so a search sees the old index or the new one, never half
of one. It does nothing when `bm25_stats.articles` equals the number of `m_search` rows (`--reset` builds
anyway); `deploy.sh` and `local.sh` run it after the other loaders.

On the box (22 vCPU, while the GPU embedding job ran), all 568,873 articles: 386 s, about 5 GB of memory.

| Step | Time |
|---|---:|
| Read, tokenize and stem (4.74M distinct words) | 152 s |
| Weights and sort | 12 s |
| Write the TSV files | 25 s |
| `LOAD DATA` `bm25_term` | 8 s |
| `LOAD DATA` `bm25_posting`, 85.4M rows in primary key order | 188 s |

For the S and M data of `local.sh` it takes seconds; with `L=1`, about 6 minutes once.

**Run on the box:**

```bash
systemd-run --unit=wiki-bm25 --setenv=HOME=/root --setenv=UV_CACHE_DIR=/var/cache/uv \
  --working-directory=/srv/junction26-mariadb -p StandardOutput=append:/var/log/wiki-load/bm25.log \
  -p StandardError=append:/var/log/wiki-load/bm25.log /bin/bash -c 'set -a; . /etc/junction-wiki.env; set +a;
  export DB_NAME=wiki_full; exec uv run --with pymysql --with pyarrow --with numpy --with snowballstemmer \
  --with PyStemmer python -u server/load.py bm25'
```

**Latency** on `wiki_full`, 20 queries (the ones below and jatkosota, suojeluskunta, Viipurin taistelu, Helsinki,
Lapuan liike, Suomen sisällissota, battle of Tampere, Kekkonen, jääkiekko, Turun linna, why did Finland lose
Karelia, ja), warm, 40 runs:

| What | p50 | p95 |
|---|---:|---:|
| BM25 top 200 (`vector.lexical_ranking`, SQL) | 11 ms | 75 ms |
| Hybrid scoring (`vector.hybrid`: BM25, vector top 50, cosines, BM25 of the vector hits) | 96 ms | 164 ms |
| `/api/search`, server time from the request log (with embedding, texts and snippets) | 155 ms | 255 ms |

The slowest are words in most articles: `ja` 410-515 ms end to end.

**Stemming caveats.** Snowball removes endings but does not undo Finnish consonant gradation, so one word can
get two stems: sota → `sota` but sodan, sodassa → `soda`; talvisota → `talviso` but talvisodan → `talvisod`;
kaupunki → `kaupunk` but kaupungin → `kaupung`. A search for the base form misses the gradated forms and the other way round (the vector side often
finds them). Stems also join unrelated words now and then, and English words get Finnish stems.

The old InnoDB FULLTEXT indexes (`title_ft`, `text_ft`, 4.4 GB) are no longer used by search.

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
- `embed.py serve` on a laptop CPU takes ~55 ms a question on 12 cores (GPU: ~7 ms). `server/local.sh` does not
  run it: on your machine search uses the Voyage vectors or keywords only ("Voyage vectors" below).
- Every other Finnish article: `embed.py articles`, a GPU batch job (below). The search uses only the `fi` rows.
- `M=16`, not the default 6: with 1024 dimensions `M=6` found only 79% of the true top 10 (MariaDB's RAG
  starter). The app sets `mhnsw_ef_search = 200` on each connection (measured below); `deploy.sh` sets
  `mhnsw_max_cache_size` to 4 GB, so the
  index graph stays in memory.
- `embed.py serve` (systemd `wiki-embed`, `127.0.0.1:8020`) embeds questions with the same model. Its vectors
  agree with S's at cosine 0.9999. When it does not answer, search uses keywords only.

### Hybrid search

`/api/search` (`search.ranked`, `vector.hybrid`) scores the union of the BM25 top 200 and the vector index top 200
(`ef_search` 200). Every candidate gets all its component scores: BM25 by primary key for the vector hits
(`bm25.scores`), the cosine by primary key for the BM25 hits. It is a plain weighted sum:

```text
score = sat(BM25 text, 10) + 0.5 · sat(BM25 title, 8) + 3 · (title = query)
        + space.weight · max(0, cosine(query, article) − space.floor)
        + near · prior

sat(x, κ) = x / (κ + x)        0 at x = 0, 0.5 at x = κ, below 1
prior     = clamp((log10(characters) − 3) / 2, 0, 1) + 0.3 · log10(versions)
near      = 1 when a word of the query is in the title, else
            sqrt(clamp((cosine − floor) / (best cosine − floor), 0, 1))
```

Tuned with `server/search_eval.py` (56 queries with known answers: Finnish titles and names, Finnish and English
questions over the Finnish articles, Swedish and English articles). Its numbers, hit@1 / hit@5 / MRR:

| Ranking | all 56 | the 42 Finnish |
|---|---|---|
| before: vector weight 3, top 50 vectors, keyword gate, no prior | 0.54 / 0.73 / 0.62 | 0.43 / 0.67 / 0.54 |
| plain sum, vector weight 8, 200 + 200 candidates, no prior | | 0.55 / 0.69 / 0.60 |
| the same with the keyword gate | | 0.55 / 0.74 / 0.61 |
| with the prior, near = 1 | 0.79 / 0.95 / 0.84 | 0.76 / 0.95 / 0.83 |
| with the prior and near (what runs) | 0.77 / 0.91 / 0.83 | 0.74 / 0.90 / 0.81 |
| `rerank=1`: Gemini 3.5 Flash Lite orders the top 40, ~0.8 s more | 0.88 / 0.95 / 0.91 | 0.86 / 0.93 / 0.89 |

- The prior is what the corpus has for "the main article on a subject": text length for every article
  (`m_search_length`, built by `load.py bm25`) and the number of versions for the articles with history. Without
  it "Mannerheim" put the film project and the family first and the marshal (Carl Gustaf Emil Mannerheim, 2,400
  versions) nowhere in the top 10. `near` keeps a large article that is far from the query in meaning from being
  carried up by its size.
- The keyword gate (keyword scores scaled by relative cosine) gave nothing once the vector weight was 8, so it is
  gone. 50 vector candidates instead of 200 cost 0.03 MRR; 400 + 400 gave nothing more.
- One vector stands for a whole article, so a very long one is far from every short query: Helsinki's vector has
  cosine 0.27 with "Helsinki" and 0.31 with "capital of Finland". Such articles are found by their title and the
  prior, not by meaning; the two queries the evaluation still misses ("capital of Finland", "Suomen
  kansalliseepos") are of this kind.
- κ is about the median BM25 score of the BM25 top 50 over the example queries: text 7 to 15, title 6 to 9.
  The slides' κ = 25 gave the best field scores (7 to 13) only 0.2 to 0.35, so the vectors decided the order.
- The exact-title bonus 3 is more than all other terms together, so the article titled as the query (in any
  case or accent, or with the query's words written together) comes first. BM25 alone does not do that: the
  canonical article is long, so its text score is low (Talvisota 5.2 against 10.6 for Talvisota (kirja)).
- The vector term, per `VECTOR_MODEL` (`vector.Space`): bge-m3 weight 4, floor 0.4; Voyage weight 8, floor 0.15.
  With `VECTOR_MODEL=none` or no embedding, the BM25 ranking alone, exact title first.

Top 5 on `wiki_full` (all 568,873 Finnish articles, bge-m3). BM25 alone is `vector.lexical_ranking`, exact
title first.

| Query | BM25 alone | Hybrid |
|---|---|---|
| sisällissota | Sisällissota; Burundin sisällissota; Pahangin sisällissota; Norsunluurannikon sisällissota; Sudanin sisällissota | Sisällissota; Venäjän sisällissota; Kiinan sisällissota; Rhodesian sisällissota; Yhdysvaltain sisällissota |
| Mannerheim | Mannerheim (suku); Johan Mannerheim; Mannerheim-säätiö; Lillemor Mannerheim; Anastasia Mannerheim | Johan Mannerheim; Mannerheim-museo; Sophie Mannerheim; Mannerheim (elokuvahanke); Mannerheim (suku) |
| Tampereen taistelu | Tampereen taistelu; Tampereen naiskaarti; Tampereen teloitukset; Punainen Tampere; Tie Tampereelle | Tampereen taistelu; Länkipohjan taistelu; Tampereen teloitukset; Tampereen punakaarti; Taipaleenkylän taistelu |
| punakaarti | Punakaarti; Sahalahden punakaarti; Suomen punakaarti; Punakaarti (kulttuurivallankumous); Helsingin punakaarti | Punakaarti; Punakaarti (kulttuurivallankumous); Suomen punakaarti; Helsingin punakaarti; Sahalahden punakaarti |
| talvisota | Talvisota; Talvisota (kirja); Talvisota (videopeli); Talvisota: Icy Hell; Lohjan miesten talvisota | Talvisota; Talvisota (videopeli); Talvisota (kirja); Talvisota (elokuva); Talvisota: Icy Hell |
| 1918 | 1918; Keyaki (1918); Kuwa (1918); Tsubaki (1918); Virrat 1918 | 1918; Elokuvavuosi 1918; Kirjallisuusvuosi 1918; Kunnallisvaalit 1918; Beretta 1918 |
| helsingin kaupunki | Helsingin kaupunginarkisto; Maanalainen kaupunki; Helsingin vaakuna; Helsingin historia; Helsingin käräjäoikeus | Helsingin kulttuuri; Helsingin yleiskaava; Helsingin historia; Helsingin alueellinen laajeneminen; Helsingin kaupunginarkisto |
| Lapuan liike | Lapuanliike; Lapuanliikkeen valtuuskunta; Lapuanliikkeen johto; Lapuan työväentalo; Lapuan päiväkäsky | Lapuanliike; Lapuanliikkeen valtuuskunta; Lapuanliikkeen johto; Maakuntain liike; Lapuan laki |
| who led the Reds in 1918 | The Who; Cincinnati Reds; The Guess Who; Led Zeppelin; REDS Helsinki | Cincinnati Reds; Boston Reds (1890–1891); Cincinnati Reds (1876–1880); Major League Baseball -kausi 1918; REDS Helsinki |

- Every short title query has its exact title first, alone and in the hybrid.
- Mannerheim: no article is titled "Mannerheim", and Carl Gustaf Emil Mannerheim is not in the top 5 (the
  FULLTEXT ranking had it first). BM25 prefers the short articles that are all about the name; the long
  biography gets a low text score. A lower b (0.3) helps long articles in general but did not lift it either.
- English questions: BM25 matches the English words (who, led, Reds) in band and team articles, and the vectors
  find the topic, not the fact.

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
| BM25 top 200 | 11 ms (p95 75 ms) |
| Hybrid statement, reciprocal rank fusion (before) | 29 ms |
| Hybrid scoring with BM25 (now; 20 queries) | 96 ms (p95 164 ms) |
| `/api/search` (embedding, SQL, texts and snippets) with BM25 | 155 ms (p95 255 ms) |

### Recall of the vector index

The MariaDB mentors' setting is `M=16` with `mhnsw_ef_search = 80`, which found 100% of the exact top 10 in
MariaDB's RAG starter (28,345 vectors). With all 568,873 Finnish vectors it does not. 20 questions (English and
Finnish), the index's top 10 (`WHERE lang = 'fi' ORDER BY VEC_DISTANCE_COSINE(...) LIMIT 10`) against the
exact top 10 (every vector compared, with numpy over the exported files), median of 5 runs:

| `mhnsw_ef_search` | recall@10 | worst question | median | slowest |
|---|---|---|---|---|
| 20 (default) | 82.5% | 0% | 2.0 ms | 30 ms |
| 80 (mentors) | 86.0% | 0% | 2.9 ms | 36 ms |
| **200 (the app)** | **95.5%** | 60% | 6.1 ms | 47 ms |
| 400 | 98.0% | 80% | 9.2 ms | 62 ms |

- The miss is a whole region, not a few rows: for "Sibelius Finlandia" the search at 80 stays among articles at
  cosine distance 0.59, while the true nearest ("Finlandia (sävelruno)", "Jean Sibelius") are at 0.35-0.44.
  The graph was built one row at a time as the vectors arrived (S, then L in page-id order), and some regions
  are reached only by a wider search.
- Not the `lang = 'fi'` filter: without it the search finds the same rows.
- 200 costs ~3 ms a search more than 80. A rebuilt index (`ALTER TABLE ... DROP INDEX, ADD VECTOR INDEX`) may
  need less; not measured.

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

Measured on the A100 80 GB, 14 November 2026, into `wiki_full`:

| | |
|---|---|
| Articles embedded | 549,588: the 457 M articles S lacks, and 549,131 L articles; with S's 19,285, all 568,873 Finnish articles have a vector |
| Tokens read | 329 million; 2,439 articles (0.4%) were cut at 8,192 tokens |
| Job time | 58 min (3,454 s, of which the GPU 2,954 s), in 63 min of wall clock with restarts |
| Steady state | 213 articles/s, 111,000 tokens/s: the last run, 474,297 articles in 37 min, the GPU busy 97% of the time |

Committing each chunk in one transaction matters: with a commit per statement the vector index took only 60-70
rows/s, and four parallel writers were slower still (45 rows/s), as they wait for each other in the index.
The exports for local copies: `vectors-bge-m3-extra-fi.parquet` (457 M articles, 2.3 MB) and
`vectors-bge-m3-l-fi.parquet` (549,131 L articles, 2.25 GB), written by `load.py export-vectors` in 24 s.
The NVIDIA driver comes from Ubuntu's prebuilt modules for the running kernel (`bootstrap.sh`), loaded with
`modprobe`, without a reboot.

## Voyage vectors

A second set of article vectors: [voyage-4-lite](https://docs.voyageai.com/docs/embeddings) for the articles,
voyage-4-large for the questions. The Voyage 4 models share one embedding space ("All embeddings created with the
4 series are compatible with each other"), so a large-model question is compared with lite-model articles. Both
give 2048 numbers, their largest `output_dimension`; nothing is truncated.

| Table | What it holds |
|---|---|
| `article_vector_voyage` | `page_id`, `model`, `tokens`, `embedding VECTOR(2048) NOT NULL`, `VECTOR INDEX (embedding) M=16 DISTANCE=cosine` |

- The text is the one `embed.py` gives bge-m3: title + current text, Markdown as it is, wikitext made plain.
  Voyage cuts it at 32,000 tokens (bge-m3: 8,192). `tokens` is the article's share of its request's token count.
- The key is the Secret Manager secret `voyage-api-key-global`, a MongoDB Atlas key: it works only at
  `https://ai.mongodb.com/v1/embeddings` (`api.voyageai.com` answers 403). Price: voyage-4-lite $0.02 and
  voyage-4-large $0.12 per million tokens (Voyage's list price; the first 200M tokens of each are free on a Voyage
  account). The whole corpus is roughly 450M tokens, about $9; a test run of the first 300 page ids counted
  1.77M tokens.
- `VECTOR_MODEL` picks the vectors search, Ask and Learn use: `bge` (default, `article_vector` and `embed.py
  serve`), `voyage` (`article_vector_voyage`, questions to Voyage with a 3 s timeout, then bge-m3 if Voyage fails)
  or `none` (keywords only). The box has `VOYAGE_API_KEY` and `VECTOR_MODEL=bge` in `/etc/junction-wiki.env`
  (`provision.sh` keeps both).
- A voyage-4-large question takes 215 ms from the box (p50 of 20; p90 235 ms), against ~7 ms for bge-m3 on the GPU.
- Hybrid search maps cosines with `vector.VOYAGE`: floor 0.15, weight 3. A voyage-4-large question gives 200
  random articles a median cosine of 0.05 (95th percentile 0.07-0.23) and its best matches 0.4-0.6; bge-m3 gives
  unrelated text about 0.4. These two numbers are first estimates, not tuned on the full corpus yet.

### How to run the embedding from another machine

The job reads the texts from the live database over TLS, embeds the articles that have no row yet, and writes the
vectors in one transaction per chunk while the next chunk is embedded. Stop it at any time; the next run continues.

```bash
export DB_HOST=65.109.75.60 DB_PORT=3306 DB_SSL=1 DB_USER=oskari DB_NAME=wiki_full
export DB_PASSWORD=$(gcloud secrets versions access latest --secret=junction-wiki-db-oskari --project=nimble-valve-390508)
# VOYAGE_API_KEY is read from Secret Manager (voyage-api-key-global) when it is not set.
uv run -q --with pymysql python -u server/voyage.py articles --limit 300            # a test run
uv run -q --with pymysql python -u server/voyage.py articles \
  --tokens-per-minute 20000000 --concurrency 24 --batch-tokens 300000 --chunk 20000
```

| Flag | Default | What it does |
|---|---|---|
| `--tokens-per-minute` | 20,000,000 | Token budget, spent from an estimate (3 characters a token) before each request. Keep it at or under 20M: production uses the same key. |
| `--concurrency` | 24 | Requests at once |
| `--batch-tokens` | 300,000 | Estimated tokens per request (the API allows 1,000 texts and 1M tokens for voyage-4-lite); a request Voyage finds too large is split in two |
| `--chunk` | 20,000 | Articles read and written together |
| `--limit` | none | Stop after this many articles |

429, 5xx and network errors are retried 8 times with exponential backoff and jitter. Each progress line shows the
articles done, articles/s, tokens a minute and the seconds spent writing: if writing grows to the whole time, the
vector index is the limit, not Voyage.

### Copies for local machines

On the box, once the vectors are in: `uv run -q --with pymysql --with pyarrow python server/voyage.py export --out
/data/exports --scope m` (and `--scope l`) writes `vectors-voyage-4-lite-m-fi.parquet` and
`vectors-voyage-4-lite-l-fi.parquet` (~8 KB an article, so ~4.5 GB for L) with their `SHA256SUMS` lines.
`server/local.sh` reads the Voyage key with gcloud; with it, `VECTORS=1` downloads the M file (with `L=1` also the
L file) and loads it with `voyage.py import`, and the app runs with `VECTOR_MODEL=voyage`. Without the key it runs
with `VECTOR_MODEL=none`: search, Ask and Learn use keywords, and no embedding model is downloaded.

### Switch the box to Voyage

When the job has covered every article (`SELECT COUNT(*) FROM article_vector_voyage` = 568,873):

```bash
sed -i 's/^VECTOR_MODEL=.*/VECTOR_MODEL=voyage/' /etc/junction-wiki.env && systemctl restart wiki-app
```

### bge-m3 against Voyage

Vector-only top 3 for 15 questions. bge-m3 searched all 568,873 vectors through the index. Voyage ranked only a
pool per question (bge-m3's top 60 + the FULLTEXT text top 40 + title top 20, ~110 articles), because the corpus
was not embedded yet: it shows Voyage's ordering, not what it would find outside that pool.

| Question | bge-m3 | Voyage (lite articles, large question) |
|---|---|---|
| sisällissota | Suomen sisällissodan aikajana; Venäjän sisällissota; Yhdysvaltain sisällissota | Sisällissota; Luettelo sisällissodista; Suomen sisällissodan nimet |
| Mannerheim | Johan Mannerheim; Mannerheim-museo; Mannerheiminpuisto | Marsalkka Mannerheimille myönnetyt kunnianosoitukset; Mannerheim (elokuvahanke); Augustin Mannerheim |
| Tampereen taistelu | Tampereen taistelu; Taipaleenkylän taistelu; Länkipohjan taistelu | Tampereen taistelu; Hämeen rintama; Punainen Tampere |
| punakaarti | Punakaarti (kulttuurivallankumous); Punakaarti; Suomen Punainen Kaarti | Suomen Punainen Kaarti; Punakaarti, kuningas, vehnäpulla ja porvari; Punakaarti (kulttuurivallankumous) |
| talvisota | Talvisota; Operaatio Barbarossa; Operaatio Talvimyrsky | Neuvostoliiton divisioonat talvisodassa; Talvisodan tausta; Talvisota (videopeli) |
| battle of Tampere | Tampereen taistelu; Talvisodan pommitukset Tampereella; Taipaleenkylän taistelu | Tampereen taistelu; Hämeen rintama; Punainen Tampere |
| who led the Reds in 1918 | Major League Baseball -kausi 1918; Cincinnati Reds; Boston Reds (1890–1891) | Luettelo punakaartilaisista; Punaisten ja valkoisten taistelu Suomessa 1918; Tampereen punakaarti |
| why did Finland lose Karelia | Karjala; Karjalan historia; ProKarelia | Suur-Suomi; Karjala; Karjalan historia |
| Finnish independence declaration | Yhdysvaltain itsenäisyysjulistus; Viron itsenäisyysjulistus; Emancipation Proclamation | Suomen itsenäistyminen; Suomen itsenäisyysjulistus; Viron itsenäisyysjulistus |
| famine years 1860s | 1860-luku; Kirjallisuusvuosi 1860; Suuret nälkävuodet | Suuret nälkävuodet; 1860-luku; Irlannin suuri nälänhätä |
| Lapuan liike | Lapuanliikkeen valtuuskunta; Lapuanliikkeen johto; Lapuanliike | Lapua; Lapuanliikkeen johto; Lapua-Seura |
| Paavo Nurmi olympialaiset | Paavo Nurmi; Yleisurheilu kesäolympialaisissa 1924 – miesten 5 000 m; Paavo Nurmi Marathon | Paavo Nurmi; Luettelo suomalaisista kestävyysjuoksun arvokisamitalisteista; Yleisurheilu kesäolympialaisissa 1924 – miesten 5 000 m |
| ruotsin kielen asema Suomessa | Ruotsin kielipolitiikka; Ruotsin kieli; Suomen kielipolitiikka | Pakkoruotsi; Ruotsin kielipolitiikka; Toinen kotimainen kieli |
| vankileirit 1918 | Beretta 1918; Uhrit 1918; Suomen sisällissodan vankileirit | Kuopion vankileiri; Oulun vankileiri; Santahaminan vankileiri |
| Kalevala and Elias Lönnrot | Lönnrotin hengessä 2002; Kalevala; Elias Lönnrot | Elias Lönnrot; Suomalainen kansanrunous; Kalevalainen runous |

Voyage is clearly better on the English and natural questions: "who led the Reds in 1918" (bge-m3 returns
baseball teams), "Finnish independence declaration" (bge-m3 ranks the US and Estonian declarations first),
"famine years 1860s", "vankileirit 1918". On short Finnish names it is mixed: bge-m3 ranks "Talvisota" and
"Lapuanliike" first, and Voyage leaves both out of its top 5 for list-like or similar-sounding titles. In hybrid
search the exact-title bonus puts "Talvisota" first anyway, but not "Lapuanliike" for "Lapuan liike". Overall Voyage
looks better; the switch waits for a check of hybrid search on the full corpus. A lite-model question instead of the large one agrees on 4-10 of the top 10 and is
also sensible; the large one is slightly better on the natural questions.

## Other tellings: Finnish, Swedish and English side by side

`server/tellings.py` compares an article with its Swedish and English versions in S (linked by `wikidata_id`).
The reader shows it in the Article view (`reader/tellings.js`): a line under the title when another language is
much longer ("Swedish Wikipedia has 5× more on this"), and a chip in each section heading that another language
tells at 2× the length or more ("EN 2.3× more in English"), which opens those paragraphs in a card.

It only adds three tables and only reads `s_article`:

| Table | What it holds | Filled by |
|---|---|---|
| `article_language` | each S article's title, address and words (outside tables), per language | `tellings.py languages`, every S article, ~4 s |
| `passage` | the fi, sv and en texts split into paragraphs, each with a bge-m3 vector (`VECTOR INDEX`) | `tellings.py build <wikidata ids>` |
| `passage_match` | each sv and en paragraph's closest Finnish paragraph of the same article, and the cosine distance | `build`, with the passages |

```bash
DB_NAME=wiki uv run --with pymysql python server/tellings.py languages
DB_NAME=wiki uv run --with torch --with transformers --with pymysql python server/tellings.py build Q130924 Q139549
DB_NAME=wiki uv run --with pymysql python server/tellings.py show Q139549     # the matches, in the terminal
```

- `GET /api/tellings?id=<Finnish page id>` returns the languages and, for built articles, the matches per Finnish
  section. Without the tables it returns empty lists, so the reader shows nothing.
- Matching compares one article's paragraphs directly (`VEC_DISTANCE_COSINE` over the rows found by the `article`
  key), not through the vector index, which would search every article and filter afterwards.
- The distance says which Finnish paragraph is about the same thing, not whether it says the same facts: the
  Winter War in English had 127 of 145 paragraphs farther than 0.35 from any Finnish one although both cover the
  same ground. So the reader counts words per section (reliable) and does not claim "only told in English".
  Finding missing facts and conflicts (Poltava: Finnish says Peter had 45,000 men, English 75,000–80,000) needs
  an LLM pass over the matched pairs: not built yet; it needs `GEMINI_API_KEY`.
- Built so far on the local database only: Kalevala, Zachris Topelius, Kesäolympialaiset 1952, Pultavan taistelu,
  Narvan taistelu, Suomen sisällissota, Talvisota, Kustaa III, Viikinkien hyökkäykset Englantiin (~1,800
  paragraphs, ~10 min on a laptop CPU). All 7,256 Finnish articles with a pair would be roughly 400–600k
  paragraphs: hours on a CPU, minutes on the box's GPU.

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
| BM25 index (`bm25_posting`, `bm25_term`) | 568,873 | | | 3.4 GB |

`load.py l` took 23 minutes (549,131 articles, FULLTEXT indexes updated as it went).

Search latency, 10 typical queries (sisällissota, Mannerheim, Tampereen taistelu, punakaarti, talvisota,
1918, jatkosota, suojeluskunta, Viipurin taistelu, Helsinki), 5 rounds each:

| What | Articles searched | p50 | p95 |
|---|---:|---:|---:|
| FULLTEXT keyword ranking (`keyword_ranking`), SQL time | 568,873 | 51 ms | 314 ms |
| `/api/search` (FULLTEXT + vectors + snippets), server time from the request log | 568,873 | 147 ms | 493 ms |
| BM25 top 200 (`vector.lexical_ranking`), SQL time, 20 queries | 568,873 | 11 ms | 75 ms |
| `/api/search` (BM25 + vectors + snippets), server time, 20 queries | 568,873 | 155 ms | 255 ms |
| The earlier substring search (`LOCATE` in every text) | 19,742 (M only) | 130 ms | 794 ms |

The slowest query is `Helsinki`: 64,074 articles match, 309 ms. The substring search does not scale to L: one
`LOCATE('talvisota', text)` over all 568,873 texts takes 17.9 s and finds 1,941 articles; FULLTEXT takes
28 ms and finds 5,135, with the inflected forms.
