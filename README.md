# Wikipedia Through Time

Junction 2026, MariaDB challenge "Wikipedia Through Time." Live at <https://65-109-75-60.sslip.io>.
Challenge context and our plan: the [wiki](https://github.com/oskrim/junction26-mariadb/wiki).

## Run it

| You want | Command | Needs |
|---|---|---|
| Everything on your machine: MariaDB with the datasets, and the app at <http://127.0.0.1:8010> | `server/local.sh` (first run ~20–30 min; `ARTICLES=200 server/local.sh` for a quick partial load) | Docker, `uv`, `curl`; `GEMINI_API_KEY` for Ask, Find and Learn |
| Only the front end, against the cloud backend | `python3 -m http.server 5130 -d reader`, then <http://localhost:5130> | Python |
| Local app code against the cloud database | `server/dev.sh`, then <http://127.0.0.1:8011> | Access to the team's GCP secrets |

Details: [server/README.md](server/README.md) (database, loading, API), [reader/README.md](reader/README.md)
(front end), [deploy/README.md](deploy/README.md) (cloud server and deploys).

## Data and licence

The code is MIT-licensed (see [LICENSE](LICENSE)). The data is Finnish Wikipedia, prepared by the MariaDB
Foundation in [mariadb-wikipedia-datasets](https://github.com/MariaDB/mariadb-wikipedia-datasets). Wikipedia's
text is by Wikipedia's authors under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
