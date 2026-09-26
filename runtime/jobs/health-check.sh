#!/usr/bin/env bash
set -Eeuo pipefail

systemctl is-active agent-command-center-runner.service
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8787/ >/dev/null || true
test -d /srv/agent-command-center/workspace/.git
command -v codex
echo "Runner service, workspace and Codex executable are present."
