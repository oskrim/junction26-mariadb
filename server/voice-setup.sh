#!/usr/bin/env bash
# One-time setup for Learn's voice: copy the ElevenLabs API key, then run server/voice-setup.sh.
# Saves the key from the clipboard as GCP secret elevenlabs-api-key, creates the Learn voice agent and
# saves its id as elevenlabs-agent-id. Safe to run again: existing secrets get a new version.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=nimble-valve-390508

save() {  # secret $1 from stdin
  if gcloud secrets describe "$1" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets versions add "$1" --project "$PROJECT" --data-file=- >/dev/null
  else
    gcloud secrets create "$1" --project "$PROJECT" --replication-policy=automatic --data-file=- >/dev/null
  fi
  echo "voice-setup: saved $1"
}

KEY=$(pbpaste | tr -d '[:space:]')
if [[ ! "$KEY" =~ ^sk_[A-Za-z0-9]{20,}$ ]]; then
  # Not on the clipboard: ask in a dialog that hides what is typed.
  KEY=$(osascript -e 'text returned of (display dialog "Paste your ElevenLabs API key (sk_...)" default answer "" with hidden answer with title "Learn voice setup")' 2>/dev/null | tr -d '[:space:]' || true)
fi
if [[ ! "$KEY" =~ ^sk_[A-Za-z0-9]{20,}$ ]]; then
  echo "voice-setup: that isn't an ElevenLabs key (it starts with sk_). Run this again." >&2
  exit 1
fi
printf %s "$KEY" | save elevenlabs-api-key

AGENT=$(ELEVENLABS_API_KEY=$KEY uv run -q python server/voice.py create-agent)
echo "voice-setup: created agent $AGENT"
printf %s "$AGENT" | save elevenlabs-agent-id
