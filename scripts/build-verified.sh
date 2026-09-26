#!/usr/bin/env bash
set -euo pipefail

node scripts/build-setup-bundle.mjs

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=posix-tools.sh
source "${script_dir}/posix-tools.sh"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

echo "Running bounded vinext build..."
posix_timeout "${SITES_BUILD_TIMEOUT:-3m}" "${vinext}" build
