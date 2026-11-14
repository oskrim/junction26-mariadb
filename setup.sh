#!/usr/bin/env bash
# One-time setup: start MariaDB, download the Wikipedia history, load it. Safe to run again.
set -euo pipefail
cd "$(dirname "$0")"

for tool in docker uv curl bzcat; do
  command -v "$tool" >/dev/null || { echo "Missing: $tool. See 'What you need' in README.md."; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "Docker is installed but not running. Start it, then run this again."; exit 1; }

echo "1/5 Starting MariaDB..."
docker compose up -d --wait

echo "2/5 Creating the table..."
docker compose exec -T mariadb mariadb -uwiki -pwiki wiki < schema.sql

echo "3/5 Getting the Wikipedia history (100 MB)..."
[ -s data/simplewiki-head.xml.bz2 ] || ./fetch.sh 100

echo "4/5 Loading every article in the download (about 2 minutes)..."
# bzcat ends with an error on the partial file; only the loader's result counts.
uv run -q --with pymysql python -I load.py --pages 100000 < <(bzcat data/simplewiki-head.xml.bz2 2>/dev/null)

echo "5/5 Building the link graph (about 30 seconds)..."
uv run -q --with pymysql python -I build_graph.py | tail -1

echo
echo "Done. Start the page with:"
echo "  uv run --with pymysql python app.py"
echo "Then open http://127.0.0.1:8010"
