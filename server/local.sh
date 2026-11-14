#!/usr/bin/env bash
# The whole app on your own machine: MariaDB in Docker with datasets S and M, and the app at
# http://127.0.0.1:8010. Needs Docker (Docker Desktop or OrbStack on a Mac), uv and curl.
#
#     server/local.sh                  # first run downloads ~450 MB and loads all of M (~20-30 min)
#     ARTICLES=200 server/local.sh     # a quicker partial load; run again later without it to load the rest
#     L=1 server/local.sh              # also the rest of Finnish Wikipedia (L, ~500 MB download, ~15 min)
#     VECTORS=1 server/local.sh        # also the vectors the cloud box computed, and bge-m3 for the questions;
#                                      # run again later to pick up newer ones
#
# Safe to run again: downloads, loaded articles and the database are kept, so later runs start the app
# in seconds. Ask, Find and Learn need GEMINI_API_KEY in your environment; without it the other views work.
set -euo pipefail
cd "$(dirname "$0")/.."

export WIKI_DATA=${WIKI_DATA:-$HOME/.cache/junction26-wiki}
export DB_PORT=${DB_PORT:-3309} DB_NAME=${DB_NAME:-wiki} PORT=${PORT:-8010}
RELEASES=https://api.github.com/repos/MariaDB/mariadb-wikipedia-datasets/releases/tags
EXPORTS=${EXPORTS:-https://65-109-75-60.sslip.io/exports}

sha256_check() {  # in the current directory, against SHA256SUMS
  if command -v sha256sum >/dev/null; then sha256sum -c --quiet SHA256SUMS; else shasum -a 256 -c --quiet SHA256SUMS; fi
}

# The vectors the cloud box computed for the articles S has none for, when their SHA256SUMS changed.
download_vectors() {
  local dir=$WIKI_DATA/exports
  mkdir -p "$dir"
  curl -fsSL "$EXPORTS/SHA256SUMS" -o "$dir/SHA256SUMS.new"
  if cmp -s "$dir/SHA256SUMS.new" "$dir/SHA256SUMS" && (cd "$dir" && sha256_check); then
    rm "$dir/SHA256SUMS.new"
    return
  fi
  echo "local: downloading the extra vectors"
  mv "$dir/SHA256SUMS.new" "$dir/SHA256SUMS"
  awk '{print $2}' "$dir/SHA256SUMS" | while read -r name; do curl -fL --retry 3 -o "$dir/$name" "$EXPORTS/$name"; done
  (cd "$dir" && sha256_check)
}

download() {  # one dataset release into $WIKI_DATA/<tag>, checked against its SHA256SUMS
  local tag=$1 dir=$WIKI_DATA/$1
  mkdir -p "$dir"
  if [ -f "$dir/.verified" ]; then return; fi
  echo "local: downloading $tag"
  curl -fsSL "$RELEASES/$tag" | python3 -c 'import json,sys; print("\n".join(a["browser_download_url"] for a in json.load(sys.stdin)["assets"]))' |
    while read -r url; do curl -fL --retry 3 -C - -o "$dir/${url##*/}" "$url"; done
  (cd "$dir" && sha256_check)
  touch "$dir/.verified"
}
download s-2026-10
download m-2026-10

if [ "${L:-}" = 1 ]; then download l-2026-10; fi
if [ "${VECTORS:-}" = 1 ]; then download_vectors; fi

# DB_CACHE (default 2G) is MariaDB's buffer pool: a bigger one makes the load and the queries much faster.
docker compose -f server/compose.yml up -d --wait

uv run -q --with pymysql --with pyarrow python -u server/load.py s --vectors
uv run -q --with pymysql --with pyarrow python -u server/load.py m --articles "${ARTICLES:-all}"
if [ "${L:-}" = 1 ]; then uv run -q --with pymysql --with pyarrow python -u server/load.py l; fi

if [ -z "${GEMINI_API_KEY:-}" ] && command -v gcloud >/dev/null; then
  GEMINI_API_KEY=$(gcloud secrets versions access latest --project nimble-valve-390508 --secret google-aistudio-api-key 2>/dev/null || true)
  export GEMINI_API_KEY
fi
if [ "${VECTORS:-}" = 1 ]; then
  # Questions are embedded with the same model as the articles: ~2 GB of model the first time, on the CPU here.
  export EMBED_PORT=${EMBED_PORT:-8020}
  export EMBED_URL=http://127.0.0.1:$EMBED_PORT
  uv run -q --with torch --with transformers python -u server/embed.py serve > "$WIKI_DATA/embed.log" 2>&1 &
  embed_pid=$!
  trap 'kill $embed_pid 2>/dev/null || true' EXIT
  echo "local: bge-m3 for the questions on $EMBED_URL (log: $WIKI_DATA/embed.log); search uses keywords until it is up"
  echo "local: http://127.0.0.1:$PORT"
  uv run -q --with pymysql python server/app.py
else
  echo "local: http://127.0.0.1:$PORT"
  exec uv run -q --with pymysql python server/app.py
fi
