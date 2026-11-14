# Deploy

One Verda CPU instance (`junction-wiki`, Ubuntu 24.04) runs everything.

| What | Where |
|---|---|
| MariaDB 12.3 (`server/compose.yml` + `deploy/compose.prod.yml`, project `wiki`) | Docker; `127.0.0.1:3309` for the app, `0.0.0.0:3306` for teammates (TLS) |
| Web app and API (`server/app.py`) | systemd `wiki-app.service` on `127.0.0.1:8010` |
| HTTPS | Caddy, `https://<ip-with-dashes>.sslip.io` -> `127.0.0.1:8010` |
| Datasets S, M, L (checksums verified) | `/data/mariadb-wikipedia/<tag>/` |
| Repo checkout | `/srv/junction26-mariadb` |
| Box config and passwords | `/etc/junction-wiki.env` (root only) |

Firewall (ufw) allows TCP 22, 80, 443 and 3306, and UDP 443 for HTTP/3.

## Provision (once)

```bash
./deploy/provision.sh
```

Needs `gcloud` (project `nimble-valve-390508`) and `gh` logged in. It creates the passwords and the
deploy SSH key in Secret Manager, finds or creates the instance, sets the GitHub secrets
(`DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DB_PASSWORD`, `DB_ROOT_PASSWORD`), writes
`/etc/junction-wiki.env` and runs `deploy/bootstrap.sh` on the box. Re-running it is safe. Set
`INSTANCE_TYPE` to use another type when `CPU.4V.16G` has no capacity.

## Deploy

Every push to `main` runs `.github/workflows/deploy.yml`, which runs `deploy/deploy.sh` on the box:
reset to `origin/main`, start MariaDB, run the loaders, restart the app, check
`/api/articles` returns 200. Run it by hand with "Run workflow" in the Actions tab.

## Databases

| Database | What it holds |
|---|---|
| `wiki_full` | S and all of M: 19,742 articles, 862,076 versions. The app uses it. |
| `wiki` | S and the 20-article M slice. The fallback. |

`DB_NAME` in `/etc/junction-wiki.env` picks the database for the app and for the loaders that
`deploy.sh` runs. `deploy.sh` creates that database if it is missing and grants `wiki`, `oskari` and
`veeti` access to it. `provision.sh` keeps the `DB_NAME` that the box has.

Switch the app to the other database (a few seconds; the app restarts):

```bash
sed -i 's/^DB_NAME=.*/DB_NAME=wiki/' /etc/junction-wiki.env   # or wiki_full
systemctl restart wiki-app
```

Load all of M into a new database (21 minutes; 6.3 GB), without stopping the app:

```bash
systemd-run --unit=wiki-load-full --setenv=HOME=/root --setenv=UV_CACHE_DIR=/var/cache/uv \
  --working-directory=/srv/junction26-mariadb -p StandardOutput=append:/var/log/wiki-load/full.log \
  -p StandardError=append:/var/log/wiki-load/full.log /bin/bash -c 'set -a; . /etc/junction-wiki.env; set +a;
  export DB_NAME=wiki_full; uv run --with pymysql --with pyarrow python -u server/load.py s &&
  uv run --with pymysql --with pyarrow python -u server/load.py m --articles all'
```

Set `DB_NAME` inside the command: values in the env file override systemd's `--setenv`. Create the
database and its grants first (as root in the container) or let a deploy with that `DB_NAME` do it.

## Connect to the database

```bash
pw=$(gcloud secrets versions access latest --secret=junction-wiki-db-oskari --project=nimble-valve-390508)
mariadb --ssl -h <ip> -P 3306 -u oskari -p"$pw" wiki
```

Users `oskari` and `veeti` have all privileges on `wiki` and `wiki_full` and must use TLS. Passwords are in Secret
Manager: `junction-wiki-db-oskari`, `junction-wiki-db-veeti`. The certificate is the one MariaDB
generates itself; the MariaDB 11.4+ client accepts it with `--ssl`, other clients need server
certificate verification turned off. `root` logs in only from inside the container:
`docker compose -p wiki -f server/compose.yml -f deploy/compose.prod.yml exec mariadb mariadb -uroot -p`.

SSH: `ssh root@<ip>` with the key in Secret Manager `junction-wiki-deploy-ssh-key` (or the
`oskari@mylly` key).
