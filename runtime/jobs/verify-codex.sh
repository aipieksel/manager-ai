#!/usr/bin/env bash
set -Eeuo pipefail

command -v codex
codex --version
runuser -u agentmgr -- codex login status
