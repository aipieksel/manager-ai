#!/usr/bin/env bash
set -Eeuo pipefail

npm install --global @openai/codex@latest
codex --version
echo "Codex CLI installed. Authentication remains a separate protected-credential step."
