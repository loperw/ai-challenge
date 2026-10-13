#!/usr/bin/env bash
set -euo pipefail
cd /opt/chat-agent
source /etc/chat-agent-network.env
: "${PRIVATE_ALLOWED_CIDR:?Set PRIVATE_ALLOWED_CIDR}"
[[ "$PRIVATE_ALLOWED_CIDR" =~ ^[0-9a-fA-F.:/]+$ ]] || exit 1
bash deploy/vps/vpn-access.sh
install -d /etc/systemd/system/chat-agent.service.d
printf '[Service]\nIPAddressAllow=%s\n' "$PRIVATE_ALLOWED_CIDR" > /etc/systemd/system/chat-agent.service.d/network.conf
install -m 644 deploy/vps/chat-agent.service /etc/systemd/system/chat-agent.service
install -m 644 deploy/vps/ollama-override.conf /etc/systemd/system/ollama.service.d/private.conf
install -m 644 deploy/vps/ollama-offline.conf /etc/systemd/system/ollama.service.d/offline.conf
# Open the listener only after the private-access rules have been applied.
sed -i 's/^HOST=.*/HOST=0.0.0.0/' /etc/chat-agent.env
systemctl daemon-reload
systemctl restart ollama chat-agent
for attempt in $(seq 1 30); do
  if curl --max-time 3 -fsS http://127.0.0.1:3000/api/health; then break; fi
  sleep 1
done
curl --max-time 3 -fsS http://127.0.0.1:3000/api/health
ss -lnt
