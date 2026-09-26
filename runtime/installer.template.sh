#!/usr/bin/env bash
set -Eeuo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "A systemd-based Ubuntu or Debian server is required." >&2
  exit 1
fi

install -d -m 0755 /opt/agent-command-center/jobs /etc/agent-command-center
install -d -m 0750 /var/lib/agent-command-center/jobs /srv/agent-command-center/workspace
if ! id agentmgr >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/agentmgr --shell /usr/sbin/nologin agentmgr
fi

__EMBEDDED_FILES__

cat > /etc/agent-command-center/runner.env <<'ENV'
ACC_RUNNER_TOKEN=__ACC_RUNNER_TOKEN__
ACC_RUNNER_HOST=127.0.0.1
ACC_RUNNER_PORT=8787
ACC_STATE_DIR=/var/lib/agent-command-center/jobs
ACC_WORKSPACE=/srv/agent-command-center/workspace
ENV
chmod 0600 /etc/agent-command-center/runner.env

cat > /etc/sudoers.d/agent-command-center-runner <<'SUDOERS'
agentmgr ALL=(root) NOPASSWD: /opt/agent-command-center/jobs/preflight.sh, /opt/agent-command-center/jobs/install-dependencies.sh, /opt/agent-command-center/jobs/install-codex.sh, /opt/agent-command-center/jobs/verify-codex.sh, /opt/agent-command-center/jobs/prepare-manager.sh, /opt/agent-command-center/jobs/health-check.sh
SUDOERS
chmod 0440 /etc/sudoers.d/agent-command-center-runner
visudo -cf /etc/sudoers.d/agent-command-center-runner

chown -R agentmgr:agentmgr /var/lib/agent-command-center /srv/agent-command-center /home/agentmgr
systemctl daemon-reload
systemctl enable --now agent-command-center-runner.service
systemctl --no-pager --full status agent-command-center-runner.service

echo
echo "Bootstrap complete. The runner listens only on 127.0.0.1:8787."
echo "Put it behind an HTTPS reverse proxy or private tunnel, then enter that HTTPS URL on the dashboard Setup page."
