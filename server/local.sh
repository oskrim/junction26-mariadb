#!/usr/bin/env bash
# The whole app on your own machine: MariaDB in Docker with datasets S and M, and the app at
# http://127.0.0.1:8010. Needs Docker (Docker Desktop or OrbStack on a Mac), uv and curl.
#
#     server/local.sh                  # first run downloads ~450 MB and loads all of M (~20-30 min)
#     ARTICLES=200 server/local.sh     # a quicker partial load; run again later without it to load the rest
#     L=1 server/local.sh              # also the rest of Finnish Wikipedia (L, ~500 MB download, ~15 min)
#     VECTORS=1 server/local.sh        # also the Voyage article vectors from the cloud box (with L=1 the L
#                                      # articles' too); run again later to pick up newer ones
#
# Search by meaning needs the Voyage key (Secret Manager voyage-api-key-global, read with gcloud, or
# VOYAGE_API_KEY): with it, questions are embedded with Voyage; without it, search, Ask and Learn use keywords.
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

# The Voyage vectors of the M articles, and with L=1 the L articles' (~4.5 GB). A file is downloaded again only
# when its checksum in SHA256SUMS changed.
download_vectors() {
  local dir=$WIKI_DATA/exports name
  local names=(vectors-voyage-4-lite-m-fi.parquet)
  if [ "${L:-}" = 1 ]; then names+=(vectors-voyage-4-lite-l-fi.parquet); fi
  mkdir -p "$dir"
  curl -fsSL "$EXPORTS/SHA256SUMS" -o "$dir/SHA256SUMS.all"
  for name in "${names[@]}"; do
    if ! grep -q "  $name\$" "$dir/SHA256SUMS.all"; then
      echo "local: $name is not exported yet"
      continue
    fi
    grep "  $name\$" "$dir/SHA256SUMS.all" > "$dir/SHA256SUMS"
    if [ -f "$dir/$name" ] && (cd "$dir" && sha256_check 2>/dev/null); then continue; fi
    echo "local: downloading $name"
    curl -fL --retry 3 -o "$dir/$name" "$EXPORTS/$name"
    (cd "$dir" && sha256_check)
  done
  rm -f "$dir/SHA256SUMS"
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

if [ -z "${VOYAGE_API_KEY:-}" ] && command -v gcloud >/dev/null; then
  VOYAGE_API_KEY=$(gcloud secrets versions access latest --project nimble-valve-390508 --secret voyage-api-key-global 2>/dev/null || true)
fi
if [ -n "${VOYAGE_API_KEY:-}" ]; then
  export VOYAGE_API_KEY VECTOR_MODEL=voyage
  if [ "${VECTORS:-}" = 1 ]; then download_vectors; fi
else
  export VECTOR_MODEL=none
  echo "local: no Voyage key, so search, Ask and Learn use keywords only"
fi

# DB_CACHE (default 2G) is MariaDB's buffer pool: a bigger one makes the load and the queries much faster.
docker compose -f server/compose.yml up -d --wait

uv run -q --with pymysql --with pyarrow python -u server/load.py s
uv run -q --with pymysql --with pyarrow python -u server/load.py m --articles "${ARTICLES:-all}"
if [ "${L:-}" = 1 ]; then uv run -q --with pymysql --with pyarrow python -u server/load.py l; fi
# The BM25 index search uses, built again when articles were added (~6 min with L).
uv run -q --with pymysql --with pyarrow --with numpy --with snowballstemmer --with PyStemmer python -u server/load.py bm25
if [ "$VECTOR_MODEL" = voyage ] && [ "${VECTORS:-}" = 1 ]; then
  uv run -q --with pymysql --with pyarrow python -u server/voyage.py import
fi

if [ -z "${GEMINI_API_KEY:-}" ] && command -v gcloud >/dev/null; then
  GEMINI_API_KEY=$(gcloud secrets versions access latest --project nimble-valve-390508 --secret google-aistudio-api-key 2>/dev/null || true)
  export GEMINI_API_KEY
fi
echo "local: http://127.0.0.1:$PORT"
exec uv run -q --with pymysql --with snowballstemmer --with PyStemmer python server/app.py
