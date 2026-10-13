#!/usr/bin/env bash
set -euo pipefail
test -r /etc/chat-agent-network.env || { echo 'Configure /etc/chat-agent-network.env first.' >&2; exit 1; }
cd /opt/chat-agent
install -d /var/tmp/chat-agent-install
cd /var/tmp/chat-agent-install
if ! command -v node >/dev/null; then
  curl --connect-timeout 20 --retry 3 -fsSLo SHASUMS256.txt https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
  NODE_ARCHIVE=$(awk '$2 ~ /^node-v24\..*-linux-x64.tar.xz$/ {print $2}' SHASUMS256.txt)
  test -n "$NODE_ARCHIVE"
  curl --connect-timeout 20 --retry 3 -fsSLO "https://nodejs.org/dist/latest-v24.x/$NODE_ARCHIVE"
  grep " $NODE_ARCHIVE$" SHASUMS256.txt | sha256sum -c -
  tar -xJf "$NODE_ARCHIVE" -C /usr/local --strip-components=1
fi
if ! command -v ollama >/dev/null; then
  curl --connect-timeout 20 --retry 3 -fsSLo ollama.tar.zst https://ollama.com/download/ollama-linux-amd64.tar.zst
  # CPU-only VPS: omit large GPU backends.
  tar --zstd -xf ollama.tar.zst -C /usr --exclude='lib/ollama/cuda*' --exclude='lib/ollama/vulkan*'
fi
id ollama >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -U -m -d /usr/share/ollama ollama
id chat-agent >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -U -d /opt/chat-agent chat-agent
cat > /etc/systemd/system/ollama.service <<'EOF'
[Unit]
Description=Local Ollama inference
After=network-online.target
[Service]
ExecStart=/usr/bin/ollama serve
User=ollama
Group=ollama
Restart=on-failure
RestartSec=5
Environment="HOME=/usr/share/ollama"
[Install]
WantedBy=multi-user.target
EOF
install -d /etc/systemd/system/ollama.service.d
install -m 644 /opt/chat-agent/deploy/vps/ollama-override.conf /etc/systemd/system/ollama.service.d/private.conf
systemctl daemon-reload
systemctl enable --now ollama
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:11434/api/version; then break; fi
  sleep 1
done
ollama pull qwen3:0.6b
cd /opt/chat-agent
npm exec --yes --package=pnpm@10 -- pnpm install --frozen-lockfile --prod --ignore-scripts
install -d -o chat-agent -g chat-agent -m 700 /opt/chat-agent/data
if ! test -e /etc/chat-agent.env; then
  install -m 600 deploy/vps/chat-agent.env.example /etc/chat-agent.env
fi
install -m 644 deploy/vps/chat-agent.service /etc/systemd/system/chat-agent.service
install -m 644 deploy/vps/chat-agent-network.service /etc/systemd/system/chat-agent-network.service
systemctl daemon-reload
systemctl enable --now chat-agent-network
systemctl enable --now chat-agent
node --version
ollama --version
df -h /
