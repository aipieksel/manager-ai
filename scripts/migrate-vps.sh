#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="${MANAGERAI_STATE_DIR:-$HOME/.local/share/managerai}"
config="$project_root/dist/server/wrangler.json"
wrangler="$project_root/node_modules/.bin/wrangler"

if [[ ! -x "$wrangler" || ! -f "$config" ]]; then
  echo "Build output and locked dependencies are required before migration." >&2
  exit 1
fi

mkdir -p "$state_dir"

execute_sql() {
  "$wrangler" d1 execute DB \
    --config "$config" \
    --local \
    --persist-to "$state_dir" \
    --yes \
    "$@"
}

execute_sql --command "CREATE TABLE IF NOT EXISTS managerai_schema_migrations (name TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)"

# Adopt databases created before the migration ledger existed without replaying
# their already-applied baseline migrations.
execute_sql --command "INSERT OR IGNORE INTO managerai_schema_migrations (name, sha256, applied_at) SELECT '0000_opposite_the_executioner.sql', 'legacy-baseline', CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='tickets')"
execute_sql --command "INSERT OR IGNORE INTO managerai_schema_migrations (name, sha256, applied_at) SELECT '0001_strange_betty_brant.sql', 'legacy-baseline', CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='setup_job_runs')"

for migration in "$project_root"/drizzle/*.sql; do
  name="$(basename "$migration")"
  hash="$(sha256sum "$migration" | awk '{print $1}')"
  rows="$(execute_sql --command "SELECT name, sha256 FROM managerai_schema_migrations WHERE name = '$name'" --json)"
  state="$(node -e '
    const payload = JSON.parse(process.argv[1]);
    const expected = process.argv[2];
    const results = payload.flatMap((entry) => entry.results || []);
    if (!results.length) process.stdout.write("missing");
    else if (results[0].sha256 === expected || results[0].sha256 === "legacy-baseline") process.stdout.write("applied");
    else process.stdout.write("changed");
  ' "$rows" "$hash")"

  if [[ "$state" == "applied" ]]; then
    continue
  fi
  if [[ "$state" == "changed" ]]; then
    echo "Refusing changed applied migration: $name" >&2
    exit 1
  fi

  migration_tmp="$(mktemp)"
  trap 'rm -f "${migration_tmp:-}"' EXIT
  {
    sed '/^--> statement-breakpoint$/d' "$migration"
    printf '\nINSERT INTO managerai_schema_migrations (name, sha256, applied_at) VALUES ('"'"'%s'"'"', '"'"'%s'"'"', CAST(strftime('"'"'%%s'"'"','"'"'now'"'"') AS INTEGER) * 1000);\n' "$name" "$hash"
  } > "$migration_tmp"
  execute_sql --file "$migration_tmp"
  rm -f "$migration_tmp"
  trap - EXIT
done

seed_tmp="$(mktemp)"
trap 'rm -f "${seed_tmp:-}"' EXIT
node "$project_root/scripts/seed-vps-projects.mjs" > "$seed_tmp"
execute_sql --file "$seed_tmp"
rm -f "$seed_tmp"
trap - EXIT

seed_tmp="$(mktemp)"
trap 'rm -f "${seed_tmp:-}"' EXIT
node "$project_root/scripts/seed-example-agent.mjs" > "$seed_tmp"
execute_sql --file "$seed_tmp"
rm -f "$seed_tmp"
trap - EXIT

execute_sql --command "SELECT name, applied_at FROM managerai_schema_migrations ORDER BY name"
