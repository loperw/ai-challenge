#!/usr/bin/env bash
set -euo pipefail
# Deployment-specific values are stored outside the repository.
source /etc/chat-agent-network.env
: "${PRIVATE_INTERFACE:?Set PRIVATE_INTERFACE}"
: "${PRIVATE_SOURCE:?Set PRIVATE_SOURCE}"
: "${PRIVATE_DESTINATION:?Set PRIVATE_DESTINATION}"
# This chain affects only our chat port; SSH and VPN rules remain untouched.
iptables -N CHAT_AGENT_IN 2>/dev/null || true
iptables -F CHAT_AGENT_IN
iptables -A CHAT_AGENT_IN -i lo -j ACCEPT
iptables -A CHAT_AGENT_IN -i "$PRIVATE_INTERFACE" -s "$PRIVATE_SOURCE" -d "$PRIVATE_DESTINATION" -j ACCEPT
iptables -A CHAT_AGENT_IN -j REJECT
iptables -C INPUT -p tcp --dport 3000 -j CHAT_AGENT_IN 2>/dev/null ||
  iptables -I INPUT 1 -p tcp --dport 3000 -j CHAT_AGENT_IN
