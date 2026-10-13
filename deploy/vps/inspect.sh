#!/usr/bin/env bash
# Read-only inventory. No VPN configs, secrets, or private keys are printed.
printf '\n--- OS ---\n'
cat /etc/os-release
printf '\n--- Resources ---\n'
free -m
df -h /
printf '\n--- Addresses ---\n'
ip -brief address
printf '\n--- Routes ---\n'
ip route
printf '\n--- TCP listeners ---\n'
ss -lnt
printf '\n--- SSH ---\n'
systemctl is-active ssh
printf '\n--- Containers ---\n'
if command -v docker >/dev/null; then
  docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
fi
