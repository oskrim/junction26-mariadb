#!/usr/bin/env bash
# Run once from a machine with gcloud and gh logged in. Safe to re-run: it reuses every secret,
# the SSH key and the instance it finds, then (re)bootstraps the box.
set -euo pipefail

GCP_PROJECT=nimble-valve-390508
GH_REPO=oskrim/junction26-mariadb
VERDA=https://api.verda.com/v1
HOSTNAME_=junction-wiki
INSTANCE_TYPE=${INSTANCE_TYPE:-CPU.4V.16G}
IMAGE=24.04.base
DISK_GB=100
LOCATIONS=(FIN-01 FIN-02 FIN-03)
DEPLOY_KEY_NAME=junction-wiki-deploy
# Personal keys from the Verda account that may also log in as root, if present.
EXTRA_KEY_NAMES=("oskari@mylly")
APP_PORT=8010

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

secret_exists() { gcloud secrets describe "$1" --project="$GCP_PROJECT" >/dev/null 2>&1; }
secret_read() { gcloud secrets versions access latest --secret="$1" --project="$GCP_PROJECT"; }
# Creates secret $1 from file $2 unless it already exists.
secret_create_from() {
  gcloud secrets create "$1" --project="$GCP_PROJECT" --replication-policy=automatic --data-file="$2" >/dev/null
  echo "provision: created secret $1"
}
ensure_password_secret() {
  if ! secret_exists "$1"; then
    openssl rand -hex 24 | tr -d '\n' > "$WORK/pw"
    secret_create_from "$1" "$WORK/pw"
  fi
}

ensure_deploy_key() {
  if secret_exists junction-wiki-deploy-ssh-key; then
    secret_read junction-wiki-deploy-ssh-key > "$WORK/id_ed25519"
    chmod 600 "$WORK/id_ed25519"
  else
    ssh-keygen -q -t ed25519 -N '' -C "$DEPLOY_KEY_NAME" -f "$WORK/id_ed25519"
    secret_create_from junction-wiki-deploy-ssh-key "$WORK/id_ed25519"
  fi
  ssh-keygen -y -f "$WORK/id_ed25519" > "$WORK/id_ed25519.pub"
}

verda_token() {
  jq -n --arg id "$(secret_read verda-cloud-client-id)" --arg secret "$(secret_read verda-cloud-client-secret)" \
    '{grant_type: "client_credentials", client_id: $id, client_secret: $secret}' |
    curl -fsS -X POST "$VERDA/oauth2/token" -H 'Content-Type: application/json' -d @- |
    jq -er .access_token
}
verda() { curl -fsS --retry 2 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

# Prints the Verda id of the deploy key, registering it first if needed.
ensure_verda_key() {
  local id
  id=$(verda "$VERDA/ssh-keys" | jq -r --arg n "$DEPLOY_KEY_NAME" '[.[] | select(.name == $n)][0].id // empty')
  if [ -z "$id" ]; then
    jq -n --arg n "$DEPLOY_KEY_NAME" --arg k "$(cat "$WORK/id_ed25519.pub")" '{name: $n, key: $k}' |
      verda -X POST "$VERDA/ssh-keys" -d @- >/dev/null
    id=$(verda "$VERDA/ssh-keys" | jq -er --arg n "$DEPLOY_KEY_NAME" '[.[] | select(.name == $n)][0].id')
    echo "provision: registered SSH key $DEPLOY_KEY_NAME" >&2
  fi
  echo "$id"
}

find_instance() {
  verda "$VERDA/instances" |
    jq -r --arg h "$HOSTNAME_" '[.[] | select(.hostname == $h and (.status | IN("discontinued", "deleting", "error") | not))][0].id // empty'
}

create_instance() {
  local key_ids location="" loc
  key_ids=$(verda "$VERDA/ssh-keys" | jq -c --arg d "$DEPLOY_KEY_NAME" --args \
    '[.[] | select(.name == $d or (.name | IN($ARGS.positional[]))) | .id]' "${EXTRA_KEY_NAMES[@]}")
  for loc in "${LOCATIONS[@]}"; do
    if [ "$(verda "$VERDA/instance-availability/$INSTANCE_TYPE?is_spot=false&location_code=$loc")" = true ]; then
      location=$loc
      break
    fi
  done
  if [ -z "$location" ]; then
    echo "provision: no on-demand capacity for $INSTANCE_TYPE in ${LOCATIONS[*]}; try later or set INSTANCE_TYPE" >&2
    exit 2
  fi
  jq -n --arg t "$INSTANCE_TYPE" --arg img "$IMAGE" --arg h "$HOSTNAME_" --arg loc "$location" \
    --argjson keys "$key_ids" --argjson disk "$DISK_GB" \
    '{instance_type: $t, image: $img, hostname: $h, description: "junction26 wiki backend",
      location_code: $loc, is_spot: false, ssh_key_ids: $keys,
      os_volume: {name: "\($h)-os", size: $disk}}' |
    verda -X POST "$VERDA/instances" -d @- | tr -d '"[:space:]'
}

# Waits up to 30 minutes for the instance to run with a public IP, then prints the IP.
wait_for_ip() {
  local i info status ip
  for i in $(seq 1 180); do
    info=$(verda "$VERDA/instances/$1")
    status=$(jq -r .status <<<"$info")
    ip=$(jq -r '.ip | if type == "string" then . elif type == "object" then ([.. | strings | select(test("^[0-9]+(\\.[0-9]+){3}$"))][0] // empty) else empty end' <<<"$info")
    if [ "$status" = running ] && [ -n "$ip" ]; then
      echo "$ip"
      return 0
    fi
    case $status in error | installation_failed | no_capacity | discontinued)
      echo "provision: instance $1 is $status" >&2
      return 1 ;;
    esac
    echo "provision: instance $1 is $status; waiting" >&2
    sleep 10
  done
  echo "provision: instance $1 not running after 30 minutes" >&2
  return 1
}

ssh_box() {
  ssh -i "$WORK/id_ed25519" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$WORK/known_hosts" -o ConnectTimeout=10 "root@$IP" "$@"
}

set_github_secrets() {
  gh secret set DEPLOY_SSH_KEY -R "$GH_REPO" < "$WORK/id_ed25519"
  printf '%s' "$IP" | gh secret set DEPLOY_HOST -R "$GH_REPO"
  secret_read junction-wiki-db-password | gh secret set DB_PASSWORD -R "$GH_REPO"
  secret_read junction-wiki-db-root-password | gh secret set DB_ROOT_PASSWORD -R "$GH_REPO"
}

write_box_env() {
  {
    echo "PUBLIC_IP=$IP"
    echo "PORT=$APP_PORT"
    echo "WIKI_DATA=/data/mariadb-wikipedia"
    echo "DB_HOST=127.0.0.1"
    echo "DB_PORT=3309"
    echo "DB_NAME=wiki"
    echo "DB_USER=wiki"
    echo "DB_PASSWORD=$(secret_read junction-wiki-db-password)"
    echo "DB_ROOT_PASSWORD=$(secret_read junction-wiki-db-root-password)"
    echo "DB_OSKARI_PASSWORD=$(secret_read junction-wiki-db-oskari)"
    echo "DB_VEETI_PASSWORD=$(secret_read junction-wiki-db-veeti)"
    echo "GEMINI_API_KEY=$(secret_read google-aistudio-api-key)"
  } | ssh_box 'umask 077 && cat > /etc/junction-wiki.env'
}

for name in junction-wiki-db-password junction-wiki-db-root-password junction-wiki-db-oskari junction-wiki-db-veeti; do
  ensure_password_secret "$name"
done
ensure_deploy_key
TOKEN=$(verda_token)
ensure_verda_key >/dev/null

INSTANCE_ID=$(find_instance)
if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID=$(create_instance)
  echo "provision: created instance $INSTANCE_ID ($INSTANCE_TYPE)"
else
  echo "provision: found instance $INSTANCE_ID"
fi
IP=$(wait_for_ip "$INSTANCE_ID")
echo "provision: instance $INSTANCE_ID running at $IP"

for i in $(seq 1 30); do
  if ssh_box true 2>/dev/null; then break; fi
  if [ "$i" = 30 ]; then echo "provision: SSH to $IP not reachable" >&2; exit 1; fi
  sleep 10
done

set_github_secrets
write_box_env
ssh_box 'bash -s' < "$(dirname "$0")/bootstrap.sh"
echo "provision: done; IP $IP, https://${IP//./-}.sslip.io"
