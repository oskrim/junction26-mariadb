# Wikipedia through time

Pick a Wikipedia article, drag a date slider, and read the article as it was on that day.

The data is the full edit history of 50 Simple English Wikipedia articles (about 18,000
versions, 2003 to 2026). It lives in one MariaDB table. MariaDB keeps every old version by
itself, so "the article in 2012" is a single query.

## What you need

| Tool | Why | Install |
|---|---|---|
| Docker | Runs the database | [Docker Desktop](https://www.docker.com/products/docker-desktop/), then start it |
| uv | Runs the Python scripts, no Python setup needed | `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh` |

Mac and Linux work as they are. On Windows, use WSL.

## Set it up

```bash
git clone https://github.com/oskrim/junction26-mariadb.git
cd junction26-mariadb
./setup.sh
```

`setup.sh` starts the database, downloads 100 MB of Wikipedia history and loads it. It takes
about a minute on a fast connection. You can run it again at any time: it skips what is already
done.

## Open the page

```bash
uv run --with pymysql python app.py
```

Then open <http://127.0.0.1:8010>. Stop it with Ctrl+C.

## Build your own UI on it

The page talks to two URLs. Both return JSON.

| URL | Returns |
|---|---|
| `/api/articles` | Every article: `page_id`, `title`, number of `versions`, and `first` (when it was created, in Unix seconds) |
| `/api/article?id=13&at=1325376000` | Article 13 as it was at that moment (`at` is Unix seconds): text, who saved it, when, and the SQL that was run |

The API is in `app.py` and the page is `index.html`. Both are short.

## Look at the data yourself

Open a SQL prompt:

```bash
docker compose exec mariadb mariadb -uwiki -pwiki wiki
```

Or connect an app such as TablePlus or DBeaver:

| Setting | Value |
|---|---|
| Host | `127.0.0.1` |
| Port | `3308` |
| User, password and database | `wiki` |

Three queries to try:

```sql
-- The article today
SELECT title, rev_id, user FROM article WHERE title = 'Alan Turing';

-- The same article on 1 January 2012
SELECT title, rev_id, user FROM article
FOR SYSTEM_TIME AS OF TIMESTAMP '2012-01-01 00:00:00'
WHERE title = 'Alan Turing';

-- Every version it ever had
SELECT rev_id, row_start, user, comment FROM article
FOR SYSTEM_TIME ALL
WHERE title = 'Alan Turing' ORDER BY row_start;
```

`demo.sql` has a longer tour. Run it with:

```bash
docker compose exec -T mariadb mariadb -uwiki -pwiki wiki -t -v < demo.sql
```

## If something goes wrong

| Problem | Fix |
|---|---|
| `Missing: docker` or `Missing: uv` | Install it from the table above |
| `Docker is installed but not running` | Start Docker Desktop and wait until it is ready |
| `port is already allocated` | Another program uses port 3308. Stop it, then run `./setup.sh` again |
| The page shows no articles | Run `./setup.sh` again |
| You want a clean start | `docker compose down -v`, then `./setup.sh` |

## Files

| File | What it does |
|---|---|
| `setup.sh` | Does the whole setup |
| `fetch.sh` | Downloads the start of the Wikipedia history dump into `data/` |
| `load.py` | Reads the dump and stores every version with its real edit time |
| `schema.sql` | The one table |
| `app.py`, `index.html` | The API and the page |
| `demo.sql` | A tour of time-travel queries |

## License

Code: MIT. Wikipedia text: [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
