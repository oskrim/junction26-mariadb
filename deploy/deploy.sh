#!/usr/bin/env bash
# Runs on the box as root (CI over SSH, and at the end of bootstrap.sh). Safe to re-run.
set -euo pipefail

REPO_DIR=/srv/junction26-mariadb
ENV_FILE=/etc/junction-wiki.env

main() {
  cd "$REPO_DIR"
  if [ "${1:-}" != --updated ]; then
    git fetch --quiet origin main
    git reset --quiet --hard origin/main
    # Re-run the script as it is on main, not the copy bash already has open.
    exec bash "$REPO_DIR/deploy/deploy.sh" --updated
  fi
  echo "deploy: at $(git log -1 --format='%h %s')"
  if [ "${GEMINI_API_KEY_ON_STDIN:-}" = 1 ]; then
    local key
    IFS= read -r key || true
    if [ -n "$key" ]; then set_env GEMINI_API_KEY "$key"; fi
  fi

  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a

  if [ ! -f server/compose.yml ]; then
    echo "deploy: server/compose.yml is not on main yet; nothing to start"
    return 0
  fi
  local compose=(docker compose -p wiki -f server/compose.yml -f deploy/compose.prod.yml)
  "${compose[@]}" up -d --wait
  ensure_db_users "${compose[@]}"

  # The loaders and the app use the database named by DB_NAME in the env file.
  if [ -f server/load.py ]; then
    uv run --with pymysql --with pyarrow python server/load.py s --vectors
    uv run --with pymysql --with pyarrow python server/load.py m --articles 20
  else
    echo "deploy: server/load.py is not on main yet; skipping loaders"
  fi

  restart_embed_if_changed

  if [ -f server/app.py ]; then
    systemctl restart wiki-app
    smoke_test
  else
    echo "deploy: server/app.py is not on main yet; skipping app"
  fi
}

# The query embedding service takes ~25 s to load the model, so it restarts only when its code changed.
restart_embed_if_changed() {
  local sum
  if ! systemctl cat wiki-embed >/dev/null 2>&1; then
    echo "deploy: no wiki-embed unit (bootstrap.sh writes it); vector search is off"
    return 0
  fi
  sum=$(sha256sum server/embed.py | cut -d' ' -f1)
  if [ "$sum" != "$(cat /run/wiki-embed.sha 2>/dev/null)" ] || ! systemctl is-active --quiet wiki-embed; then
    systemctl restart wiki-embed
    echo "$sum" > /run/wiki-embed.sha
  fi
}

# Sets NAME=value in the env file, replacing an earlier value.
set_env() {
  local tmp
  tmp=$(mktemp)
  grep -v "^$1=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  install -m 600 "$tmp" "$ENV_FILE"
  rm -f "$tmp"
}

# The app's database ($DB_NAME) next to wiki, and teammate logins with access to both, TLS required.
# Also asserts the server has TLS on.
ensure_db_users() {
  local db="${DB_NAME:-wiki}" sql="" user pw pw_var
  sql+="CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4;"
  sql+="GRANT ALL PRIVILEGES ON \`${db}\`.* TO 'wiki'@'%';"
  for user in oskari veeti; do
    pw_var="DB_${user^^}_PASSWORD"
    pw="${!pw_var}"
    sql+="CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${pw}' REQUIRE SSL;"
    sql+="ALTER USER '${user}'@'%' IDENTIFIED BY '${pw}' REQUIRE SSL;"
    sql+="GRANT ALL PRIVILEGES ON wiki.* TO '${user}'@'%';"
    sql+="GRANT ALL PRIVILEGES ON \`${db}\`.* TO '${user}'@'%';"
  done
  # The vector index's graph cache (default 16 MB) must hold the index for fast searches; set per server start.
  sql+="SET GLOBAL mhnsw_max_cache_size = 4294967296;"
  printf '%s' "$sql" | "$@" exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD"'
  local have_ssl
  have_ssl=$("$@" exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -N -e "SELECT @@have_ssl"')
  if [ "$have_ssl" != YES ]; then
    echo "deploy: MariaDB TLS is not enabled (have_ssl=$have_ssl)" >&2
    return 1
  fi
}

smoke_test() {
  local url="http://127.0.0.1:${PORT}/api/articles" code="" _
  for _ in $(seq 1 30); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)
    if [ "$code" = 200 ]; then
      echo "deploy: smoke test ok ($url)"
      return 0
    fi
    sleep 2
  done
  echo "deploy: smoke test failed: $url returned '$code' after 60 s" >&2
  journalctl -u wiki-app -n 50 --no-pager >&2 || true
  return 1
}

main "$@"
