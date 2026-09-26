#!/usr/bin/env bash
set -Eeuo pipefail

install -d -o agentmgr -g agentmgr -m 0750 /srv/agent-command-center/workspace
if [ ! -d /srv/agent-command-center/workspace/.git ]; then
  runuser -u agentmgr -- git -C /srv/agent-command-center/workspace init
fi
if [ ! -f /srv/agent-command-center/workspace/AGENTS.md ]; then
  install -o agentmgr -g agentmgr -m 0640 /dev/null /srv/agent-command-center/workspace/AGENTS.md
  printf '%s\n' \
    '# Manager runtime policy' \
    '' \
    '- Gather read-only evidence before proposing changes.' \
    '- Do not deploy, delete, spend money, or change production without explicit owner approval.' \
    '- Work only inside this allowlisted workspace.' \
    > /srv/agent-command-center/workspace/AGENTS.md
fi
chown -R agentmgr:agentmgr /srv/agent-command-center/workspace
echo "Manager workspace ready at /srv/agent-command-center/workspace"
