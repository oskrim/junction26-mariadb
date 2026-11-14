#!/usr/bin/env bash
# Runs on the box as root, once after provisioning (provision.sh pipes it over SSH). Safe to re-run.
# Expects /etc/junction-wiki.env, which provision.sh writes first.
set -euo pipefail

REPO_URL=https://github.com/oskrim/junction26-mariadb.git
REPO_DIR=/srv/junction26-mariadb
DATASETS_REPO=MariaDB/mariadb-wikipedia-datasets
DATASET_TAGS=(s-2026-10 m-2026-10 l-2026-10)

set -a
# shellcheck source=/dev/null
. /etc/junction-wiki.env
set +a
export DEBIAN_FRONTEND=noninteractive

install_packages() {
  apt-get update -q
  apt-get install -y -q ca-certificates curl git jq ufw gnupg debian-keyring debian-archive-keyring apt-transport-https
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sh
  fi
  if ! command -v uv >/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
  fi
  if ! command -v caddy >/dev/null; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -q
    apt-get install -y -q caddy
  fi
}

# The NVIDIA driver from Ubuntu's prebuilt modules for the running kernel: it loads without a reboot. The query
# embedding service and embed.py's batch job run bge-m3 on the GPU; without one they run on the CPU.
install_gpu_driver() {
  if ! lspci | grep -qi nvidia || nvidia-smi >/dev/null 2>&1; then
    return 0
  fi
  apt-get install -y -q --no-install-recommends "linux-modules-nvidia-580-server-open-$(uname -r)" \
    nvidia-utils-580-server libnvidia-compute-580-server
  printf 'nvidia\nnvidia-uvm\n' > /etc/modules-load.d/nvidia.conf
  modprobe nvidia
  modprobe nvidia-uvm
  nvidia-smi -pm 1
}

# Docker publishes ports through its own iptables chains, so ufw does not gate 3306; the only
# public Docker port is 3306, which is allowed anyway.
setup_firewall() {
  ufw default deny incoming
  ufw default allow outgoing
  local port
  for port in 22 80 443 3306; do ufw allow "$port/tcp"; done
  ufw allow 443/udp  # HTTP/3: Caddy serves QUIC on it
  ufw --force enable
}

# Visitors on slow mobile links wait a round trip (~300 ms) for every doubling of TCP's send window: a
# larger first window sends a cold page's code and data in fewer of them, and an idle connection keeps its.
tune_tcp() {
  echo "net.ipv4.tcp_slow_start_after_idle = 0" > /etc/sysctl.d/60-wiki-tcp.conf
  sysctl -q -p /etc/sysctl.d/60-wiki-tcp.conf
  cat > /etc/systemd/system/wiki-initcwnd.service <<'UNIT'
[Unit]
Description=Larger initial TCP window on the default route
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'ip route change $(ip route show default | head -1 | sed "s/ init[cr]wnd [0-9]*//g") initcwnd 32 initrwnd 32'

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now wiki-initcwnd
}

clone_repo() {
  if [ ! -d "$REPO_DIR/.git" ]; then
    git clone --quiet "$REPO_URL" "$REPO_DIR"
  fi
}

download_datasets() {
  local tag dir url
  for tag in "${DATASET_TAGS[@]}"; do
    dir="$WIKI_DATA/$tag"
    if [ -f "$dir/.verified" ]; then
      echo "bootstrap: dataset $tag already verified"
      continue
    fi
    mkdir -p "$dir"
    for url in $(curl -fsSL "https://api.github.com/repos/$DATASETS_REPO/releases/tags/$tag" | jq -r '.assets[].browser_download_url'); do
      curl -fsSL --retry 3 -o "$dir/${url##*/}" "$url"
    done
    (cd "$dir" && sha256sum --quiet -c SHA256SUMS)
    touch "$dir/.verified"
    echo "bootstrap: dataset $tag downloaded and verified"
  done
}

write_app_unit() {
  cat > /etc/systemd/system/wiki-app.service <<EOF
[Unit]
Description=junction26 wiki web app and API
After=docker.service network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$REPO_DIR
EnvironmentFile=/etc/junction-wiki.env
Environment=HOME=/root UV_CACHE_DIR=/var/cache/uv
ExecStart=/usr/local/bin/uv run --with pymysql --with snowballstemmer --with PyStemmer python server/app.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable wiki-app
}

write_embed_unit() {
  cat > /etc/systemd/system/wiki-embed.service <<EOF
[Unit]
Description=junction26 wiki query embeddings (bge-m3) on 127.0.0.1:8020
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$REPO_DIR
Environment=HOME=/root UV_CACHE_DIR=/var/cache/uv HF_HOME=/var/cache/huggingface
ExecStart=/usr/local/bin/uv run --with torch --with transformers python server/embed.py serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable wiki-embed
}

write_caddyfile() {
  mkdir -p /data/exports
  cat > /etc/caddy/Caddyfile <<EOF
${PUBLIC_IP//./-}.sslip.io {
	encode zstd gzip
	# Files for teammates' local copies, such as the vectors embed.py computed (load.py export-vectors).
	handle_path /exports/* {
		root * /data/exports
		file_server browse
	}
	reverse_proxy 127.0.0.1:${PORT}
}
EOF
  systemctl enable caddy
  systemctl reload-or-restart caddy
}

install_packages
install_gpu_driver
setup_firewall
tune_tcp
clone_repo
download_datasets
write_app_unit
write_embed_unit
write_caddyfile
if [ -f "$REPO_DIR/deploy/deploy.sh" ]; then
  bash "$REPO_DIR/deploy/deploy.sh"
else
  echo "bootstrap: deploy/ is not on main yet; push it, then run the deploy workflow"
fi
echo "bootstrap: done; https://${PUBLIC_IP//./-}.sslip.io"
