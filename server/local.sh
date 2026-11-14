#!/usr/bin/env bash
# The whole app on your own machine: MariaDB in Docker with datasets S and M, and the app at
# http://127.0.0.1:8010. Needs Docker (Docker Desktop or OrbStack on a Mac), uv and curl.
#
#     server/local.sh                  # first run downloads ~450 MB and loads all of M (~20-30 min)
#     ARTICLES=200 server/local.sh     # a quicker partial load; run again later without it to load the rest
#
# Safe to run again: downloads, loaded articles and the database are kept, so later runs start the app
# in seconds. Ask, Find and Learn need GEMINI_API_KEY in your environment; without it the other views work.
set -euo pipefail
cd "$(dirname "$0")/.."

export WIKI_DATA=${WIKI_DATA:-$HOME/.cache/junction26-wiki}
export DB_PORT=${DB_PORT:-3309} DB_NAME=${DB_NAME:-wiki} PORT=${PORT:-8010}
RELEASES=https://api.github.com/repos/MariaDB/mariadb-wikipedia-datasets/releases/tags

download() {  # one dataset release into $WIKI_DATA/<tag>, checked against its SHA256SUMS
  local tag=$1 dir=$WIKI_DATA/$1
  mkdir -p "$dir"
  if [ -f "$dir/.verified" ]; then return; fi
  echo "local: downloading $tag"
  curl -fsSL "$RELEASES/$tag" | python3 -c 'import json,sys; print("\n".join(a["browser_download_url"] for a in json.load(sys.stdin)["assets"]))' |
    while read -r url; do curl -fL --retry 3 -C - -o "$dir/${url##*/}" "$url"; done
  if command -v sha256sum >/dev/null; then (cd "$dir" && sha256sum -c --quiet SHA256SUMS); else (cd "$dir" && shasum -a 256 -c --quiet SHA256SUMS); fi
  touch "$dir/.verified"
}
download s-2026-10
download m-2026-10

docker compose -f server/compose.yml up -d --wait
# A bigger cache makes the load and the queries much faster; it lasts until the container restarts.
docker compose -f server/compose.yml exec -T mariadb \
  mariadb -uroot -p"${DB_ROOT_PASSWORD:-wiki}" -e "SET GLOBAL innodb_buffer_pool_size = ${DB_CACHE:-2147483648}"

uv run -q --with pymysql --with pyarrow python -u server/load.py s --vectors
uv run -q --with pymysql --with pyarrow python -u server/load.py m --articles "${ARTICLES:-all}"

if [ -z "${GEMINI_API_KEY:-}" ] && command -v gcloud >/dev/null; then
  GEMINI_API_KEY=$(gcloud secrets versions access latest --project nimble-valve-390508 --secret google-aistudio-api-key 2>/dev/null || true)
  export GEMINI_API_KEY
fi
echo "local: http://127.0.0.1:$PORT"
exec uv run -q --with pymysql python server/app.py
