#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git jq nodejs npm python3 python3-venv sudo

node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$node_major" -lt 18 ]; then
  echo "Node.js 18 or newer is required; this operating-system repository supplied $(node --version)." >&2
  exit 1
fi

node --version
npm --version
python3 --version
git --version
