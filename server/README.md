# Server

A small Python API on MariaDB for the reader app in `../reader/`. Run every command from the repo root.

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
