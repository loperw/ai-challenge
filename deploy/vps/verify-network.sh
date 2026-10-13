#!/usr/bin/env bash
set -euo pipefail
cd /opt/chat-agent
# Run from a machine connected to the private network.
: "${CHAT_URL:?Set CHAT_URL to your private service URL}"
export CHAT_URL
/usr/local/bin/node scripts/verify-vps-limits.mjs > data/limits-results.json
cat data/limits-results.json
