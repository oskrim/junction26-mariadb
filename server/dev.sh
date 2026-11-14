#!/usr/bin/env bash
# Runs the app locally against the cloud database: an SSH tunnel to the server's MariaDB, then app.py.
# Every secret is read from GCP Secret Manager at start (project nimble-valve-390508); none is stored here.
#     server/dev.sh            # http://127.0.0.1:8011
set -euo pipefail
cd "$(dirname "$0")/.."
secret() { gcloud secrets versions access latest --project nimble-valve-390508 --secret "$1"; }

HOST=${DEPLOY_HOST:-65.109.75.60}
KEY=$(mktemp)
trap 'rm -f "$KEY"; kill "${TUNNEL:-}" 2>/dev/null || true' EXIT
secret junction-wiki-deploy-ssh-key > "$KEY"
chmod 600 "$KEY"
ssh -i "$KEY" -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -N -L 127.0.0.1:3310:127.0.0.1:3309 "root@$HOST" &
TUNNEL=$!
sleep 2

export DB_PORT=3310 PORT=${PORT:-8011}
export DB_NAME=${DB_NAME:-$(ssh -i "$KEY" -o BatchMode=yes "root@$HOST" "sed -n 's/^DB_NAME=//p' /etc/junction-wiki.env" || true)}
export DB_NAME=${DB_NAME:-wiki}
DB_PASSWORD=$(secret junction-wiki-db-password)
GEMINI_API_KEY=$(secret google-aistudio-api-key)
export DB_PASSWORD GEMINI_API_KEY
uv run -q --with pymysql --with snowballstemmer --with PyStemmer python server/app.py
