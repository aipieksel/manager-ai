#!/usr/bin/env bash
set -Eeuo pipefail

echo "Agent Command Center preflight"
echo "OS: $(. /etc/os-release && printf '%s %s' "$NAME" "$VERSION_ID")"
echo "Kernel: $(uname -sr)"
echo "Architecture: $(uname -m)"
echo "Disk free: $(df -h / | awk 'NR==2 {print $4}')"
command -v systemctl >/dev/null
command -v sudo >/dev/null
test "$(id -u)" -eq 0
echo "Systemd, sudo and privileged job execution are available."
