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
