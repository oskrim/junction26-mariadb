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

Firewall (ufw) allows 22, 80, 443 and 3306 only.

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

## Connect to the database

```bash
pw=$(gcloud secrets versions access latest --secret=junction-wiki-db-oskari --project=nimble-valve-390508)
mariadb --ssl -h <ip> -P 3306 -u oskari -p"$pw" wiki
```

Users `oskari` and `veeti` have all privileges on `wiki` and must use TLS. Passwords are in Secret
Manager: `junction-wiki-db-oskari`, `junction-wiki-db-veeti`. The certificate is the one MariaDB
generates itself; the MariaDB 11.4+ client accepts it with `--ssl`, other clients need server
certificate verification turned off. `root` logs in only from inside the container:
`docker compose -p wiki -f server/compose.yml -f deploy/compose.prod.yml exec mariadb mariadb -uroot -p`.

SSH: `ssh root@<ip>` with the key in Secret Manager `junction-wiki-deploy-ssh-key` (or the
`oskari@mylly` key).
