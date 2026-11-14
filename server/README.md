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

`/api/search` scores each candidate with a linear sum of saturated scores, in one statement
(`vector.hybrid_sql`). The candidates are the union of the FULLTEXT title top 50, the FULLTEXT text top 50 and
the vector index top 50 (`ef_search` 80). Then every candidate gets all its component scores:

```text
score = 2 · sat(title MATCH, 30) + sat(text MATCH, 80) + 3 · (title = query)
        + 4 · max(0, cosine(query, article) − 0.4)

sat(x, κ) = x / (κ + x)        0 at x = 0, 0.5 at x = κ, below 1
```

- Both MATCH scores use the boolean query of the FULLTEXT search (every word required, as itself or by its stem).
- κ is about the median MATCH score of the top 50 candidates over the example queries below. In boolean mode
  every title that matches a query gets the same score (14 to 44, depending on how rare the words are), so the
  title term is a weighted "the title matches". Text scores spread from about 15 to 2,000; their medians are 37
  to 154.
- Title weight 2: a word in the title says more than the same word in the text.
- The exact-title bonus 3 is more than all other terms together, so the article titled as the query (in any
  case or accent) comes first.
- Cosine floor 0.4, not the 0.05 of the slides: with bge-m3, unrelated articles still score about 0.4 and the
  best matches 0.5 to 0.65. Above the floor, w = 4 gives a vector match up to ~1, the size of a good lexical match.

```sql
WITH candidates AS (
  (SELECT page_id FROM m_article_stats WHERE title = :q)
  UNION (SELECT page_id FROM m_article_stats WHERE MATCH (title) AGAINST (:boolean IN BOOLEAN MODE)
         ORDER BY MATCH (title) AGAINST (:boolean IN BOOLEAN MODE) DESC, CHAR_LENGTH(title) LIMIT 50)
  UNION (SELECT page_id FROM m_search WHERE MATCH (text) AGAINST (:boolean IN BOOLEAN MODE)
         ORDER BY MATCH (text) AGAINST (:boolean IN BOOLEAN MODE) DESC LIMIT 50)
  UNION (SELECT page_id FROM (SELECT page_id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(:vector)) AS distance
                              FROM article_vector WHERE lang = 'fi' ORDER BY distance LIMIT 50) nearest)),
scored AS (
  SELECT c.page_id, s.title = :q AS exact,
         MATCH (s.title) AGAINST (:boolean IN BOOLEAN MODE) AS title_score,
         IFNULL(MATCH (x.text) AGAINST (:boolean IN BOOLEAN MODE), 0) AS body_score,
         IFNULL(1 - VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(:vector)), 0) AS cosine
  FROM candidates c JOIN m_article_stats s USING (page_id)
  LEFT JOIN m_search x USING (page_id)
  LEFT JOIN article_vector v ON v.lang = 'fi' AND v.page_id = c.page_id)
SELECT page_id, 2 * title_score / (30 + title_score) + body_score / (80 + body_score)
         + 3 * exact + 4 * GREATEST(0, cosine - 0.4) AS score
FROM scored ORDER BY score DESC, page_id LIMIT 20
```

The vector search stands alone in its subquery (`ORDER BY distance LIMIT`): that is the shape in which MariaDB
uses the vector index. `EXPLAIN` names the index with the `lang = 'fi'` filter too. Without the embedding
service, the search uses the FULLTEXT ranking alone.

Top 5 on `wiki_full` (all 568,873 Finnish articles). Before: reciprocal rank fusion of the FULLTEXT and vector
ranks (1 / (60 + rank) each, the vector rank weighted 0.25 for 1-2 word queries, the exact title first). After:
the saturated sum above.

| Query | Before (RRF) | After (saturated sum) |
|---|---|---|
| sisällissota | Sisällissota; Suomen sisällissota; Venäjän sisällissota; Espanjan sisällissota; Kiinan sisällissota | Sisällissota; Suomen sisällissota; Venäjän sisällissota; Espanjan sisällissota; Suomen sisällissota Etelä-Pohjanmaalla |
| Mannerheim | Carl Gustaf Emil Mannerheim; Mannerheim (suku); Carl Erik Mannerheim; Carl Gustaf Mannerheim; Johan Mannerheim | Carl Gustaf Emil Mannerheim; Mannerheim (suku); Johan Mannerheim; Carl Mannerheim (pankinjohtaja); Carl Gustaf Mannerheim |
| Tampereen taistelu | Tampereen taistelu; Tampereen historia; Luettelo punakaartilaisista; Luettelo Suomen sisällissodan taisteluista; Tampere | Tampereen taistelu; Luettelo Suomen sisällissodan taisteluista; Tampereen historia; Tampere; Luettelo punakaartilaisista |
| punakaarti | Punakaarti; Helsingin punakaarti; Suomen punakaarti; Pietarin suomalainen punakaarti; Sahalahden punakaarti | same |
| talvisota | Talvisota; Talvisota (elokuva); Talvisota (videopeli); Talvisota (kirja); Kevyt osasto 8 (talvisota) | Talvisota; Talvisota (elokuva); Talvisota (videopeli); 4. divisioona (talvisota); 1. divisioona (talvisota) |
| 1918 | 1918; Uhrit 1918; Raja 1918; Virrat 1918; Kunnallisvaalit 1918 | 1918; NHL-kausi 1918–1919; Kunnallisvaalit 1918; Uhrit 1918; Beretta 1918 |
| battle of Tampere | Tampereen taistelu; Luettelo … science fiction -novelleista; Talvisodan pommitukset Tampereella; Five Finger Death Punch; Taipaleenkylän taistelu | Tampereen taistelu; Talvisodan pommitukset Tampereella; Taipaleenkylän taistelu; Tampereen punakaarti; Punainen Tampere |
| who led the Reds in 1918 | Cincinnati Reds; NHL-kausi 1927–1928; Luettelo Stanley Cupin voittaneista pelaajista; 1918; NHL-kausi 1918–1919 | same |
| why did Finland lose Karelia | Karjala; Karjalan historia; ProKarelia; Friedrich Karl; 1848 | same |
| how did Finland become independent | 1821; Suomen itsenäistyminen; Luettelo itsenäisyyspäivistä; 1848; Ruotsin vapaussota | same |

- Short title queries: the exact title is first in both. The saturated sum puts articles with the query in the
  title ahead of text-only matches, and orders them by text and meaning.
- "battle of Tampere": RRF mixed in keyword-only noise (every word somewhere in a long list article); the sum
  keeps the five Tampere battle and Red Guard articles, because two weak text matches add up to less than one
  good vector match.
- The three questions have no keyword match (every word is required, and they are in English), so only the
  vectors rank them, the same in both. They find the topic, not the fact, and with all of Finnish Wikipedia,
  "Reds" finds sports teams: one vector per article sums up a whole article (MariaDB's RAG starter saw the same).
- `/api/search` takes 175-400 ms with the sum (73-310 ms with RRF): MATCH runs again for each candidate, so that
  a candidate found by its vector also gets its exact lexical scores.

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
| Hybrid statement, reciprocal rank fusion (before) | 29 ms |
| Hybrid statement, saturated sum (now; 8 queries, all 568,873 articles) | 136 ms (84-299) |
| `/api/search` (embedding, SQL, texts and snippets), saturated sum | 175-400 ms |

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
