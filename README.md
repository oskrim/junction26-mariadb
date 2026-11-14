# Wikipedia as of

Edit history of 50 Simple English Wikipedia articles in one MariaDB system-versioned table.

```bash
docker compose up -d --wait                       # MariaDB on 127.0.0.1:3308, user/password/db: wiki
docker compose exec -T mariadb mariadb -uwiki -pwiki wiki < schema.sql
./fetch.sh 100                                    # first 100 MB of the history dump -> data/
bzcat data/simplewiki-head.xml.bz2 2>/dev/null | uv run --with pymysql python -I load.py --pages 50
docker compose exec -T mariadb mariadb -uwiki -pwiki wiki -t -v < demo.sql   # SQL tour
uv run --with pymysql python app.py               # http://127.0.0.1:8010
```

`bzcat` reports an error at the end of the partial file. That is expected.

Wikipedia text is CC BY-SA 4.0.
