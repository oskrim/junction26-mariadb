#!/usr/bin/env bash
# Download the first N MB (default 100) of the Simple English Wikipedia full-history dump.
# The dump is ordered by page id, so the head of the file holds the oldest articles.
set -euo pipefail
MB="${1:-100}"
DUMP=20261101
mkdir -p data
curl --fail -A 'wiki-history-demo/0.1' -r "0-$((MB * 1024 * 1024 - 1))" \
  -o data/simplewiki-head.xml.bz2 \
  "https://dumps.wikimedia.org/simplewiki/$DUMP/simplewiki-$DUMP-pages-meta-history.xml.bz2"
