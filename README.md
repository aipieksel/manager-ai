# Manager AI

The repository is `manager-ai`; the application currently displays **Agent Command Center**.
Maintained by [aipieksel](https://github.com/aipieksel). Upstream credits and licenses remain with their respective authors.

An owner-only operations dashboard for receiving issues, reviewing an audit
trail, and dispatching approved triage work to a constrained Codex manager
runtime. The web application runs on OpenAI Sites/Cloudflare, stores operational
data in D1, and can connect either to the bundled Linux runner or to a dedicated
HTTPS manager endpoint.

## What is included

- ChatGPT sign-in with an optional exact-email owner allowlist
- Manual and HMAC-signed webhook issue intake
- D1-backed tickets, audit events, execution requests, setup jobs, and runtime settings
- An in-product setup guide and configuration status checks
- A downloadable, token-personalized installer for the allowlisted Linux runner
- A read-only manager triage path with bounded concurrency and output

The runner deliberately exposes an allowlist of jobs rather than arbitrary
shell execution. Its manager invocation uses Codex's read-only sandbox.

## Requirements

- Node.js `>=22.13.0`
- `bash`, `curl`, and either GNU `timeout`/`flock`/`sha256sum` or the portable fallbacks in `scripts/posix-tools.sh` (macOS `shasum` and Python)
- An OpenAI Sites project with the `DB` D1 binding declared in [`.openai/hosting.json`](.openai/hosting.json)
- For the bundled runner: a systemd-based Ubuntu or Debian host reachable through HTTPS

## Local development

Install the locked dependencies and start the Vite/Vinext development server:

```bash
npm run install:ci
npm run dev
```

The Cloudflare plugin creates a local D1 binding. Runtime values belong in the
hosting environment (or an ignored local environment file), never in source.
The production page requires the identity headers supplied by OpenAI Sites, so
the automated tests are the simplest local check of authenticated rendering.

Useful commands:

```bash
npm run lint
npm test
npm run build
npm run db:generate
```

`npm test` builds the application and verifies authentication, owner rendering,
the personalized bootstrap response, and same-origin write protection.

## Production configuration

Apply the migrations in [`drizzle/`](drizzle/) to the bound D1 database, then
configure these protected runtime values in the Site settings:

| Value | Required | Purpose |
| --- | --- | --- |
| `OWNER_EMAIL` | Recommended | Restricts API access to one exact signed-in email. Without it, any authenticated user is treated as an owner. |
| `SETUP_RUNNER_TOKEN` | For bundled runner | Shared bearer token embedded in the owner-only bootstrap download; use at least 32 random characters. |
| `AGENT_WEBHOOK_SECRET` | For webhook intake | HMAC-SHA256 secret used by `/api/webhooks/intake`. |
| `MANAGER_RUNTIME_URL` | For dedicated runtime | Full HTTPS manager job endpoint. Takes precedence over the bundled runner URL. |
| `MANAGER_RUNTIME_TOKEN` | For dedicated runtime | Bearer token paired with `MANAGER_RUNTIME_URL`. |

Generate independent secrets, for example with `openssl rand -hex 32`. Do not
commit secrets or put them in tickets, screenshots, logs, or documentation.

After deployment, sign in as the owner and open **Setup**:

1. Download the personalized bootstrap script.
2. Copy it to the Linux runtime host and run it with `sudo`.
3. Put the loopback-only service (`127.0.0.1:8787`) behind an authenticated HTTPS reverse proxy or private tunnel.
4. Enter that public HTTPS origin in Setup and run the guided checks.
5. Authenticate Codex on the runtime host using the protected credential flow.

The runner URL is stored in D1. Its shared token remains a protected Site
runtime value and is not stored through the browser.

### VPS deployment

The VPS deployment runs the Cloudflare worker locally under Wrangler/Workerd,
which preserves the D1 API and stores its state outside the checkout. The
provided [`deploy/managerai.service`](deploy/managerai.service) listens only on
the Docker bridge at `172.17.0.1:13006`; the public reverse proxy must provide
TLS and owner authentication.

Set `LOCAL_PROXY_SECRET` in the private application environment and inject the
same value as `x-managerai-proxy-secret` only after the reverse proxy has
authenticated the owner. The proxy also injects
`oai-authenticated-user-email`. Requests with a forged identity header but no
matching proxy secret remain unauthenticated.

Apply local D1 migrations with `scripts/migrate-vps.sh`. Persistent state belongs
under `~/.local/share/managerai`, and the mode-`600` application environment
belongs under `~/.config/managerai`; neither location is committed.

## Webhook contract

`POST /api/webhooks/intake` expects `x-agent-id`, `x-timestamp`, and
`x-signature: sha256=<hex>`. Compute the signature as HMAC-SHA256 over
`<unix-timestamp>.<raw-json-body>` with `AGENT_WEBHOOK_SECRET`. Timestamps have a
five-minute acceptance window; `idempotency_key` prevents duplicate intake.
The application documentation page contains a complete payload and signing
example.

## Architecture and safety notes

- Browser writes require the authenticated owner and a matching `Origin` header.
- Runtime and webhook secrets are server-only.
- The configured runner origin must be public HTTPS; loopback and private-network origins are rejected.
- The runner binds to loopback, validates bearer authentication, limits request/output sizes, and runs only named jobs.
- Creating an issue does not execute tools. Dispatch is a separate owner action.

The Sites lifecycle uses the locked `npm ci` helper and a bounded build. Generated
`.sites-runtime/`, Wrangler state, and local environment files are disposable and
ignored by Git.

## Main project areas

- [`app/`](app/) — dashboard, setup experience, documentation, and API routes
- [`db/`](db/) and [`drizzle/`](drizzle/) — D1 schema and migrations
- [`runtime/`](runtime/) — runner service, installer template, and allowlisted jobs
- [`tests/`](tests/) — rendered integration checks
- [`worker/`](worker/) — Cloudflare worker entry

Built with [Vinext](https://github.com/cloudflare/vinext), Cloudflare D1, and
Drizzle ORM.

## Assistant AI referral reports

The report-only workflow accepts `/ai-referrals` without arguments or a Assistant
mention containing `generate AI referral report`. It generates the fixed
Website six-sheet historical workbook, refreshes complete source snapshots,
requires independent package and visual review, then uploads the XLSX in the
originating Slack thread. The workbook completion message @mentions the original
requester for both mentions and slash commands, using the persisted Slack user ID.
Upload reconciliation does not send a second notification. Custom date ranges are not supported.

Report configuration, requester grants, channel policy, jobs and delivery state
use additive migration `drizzle/0008_ai_referral_reports.sql`. These permissions
are separate from general Assistant channel/user access. Current deployment is
restricted to members of the Slack channel you configure (for example, `C0123456789`). Membership is checked
at admission, reconciliation and delivery using paginated Slack membership data.
An example channel-scoped grant is `channel:C0123456789`; configure grants for your own environment. There are no bundled
individual requester grants. Settings expose these grants through
`memberChannelIds`, restricted to configured report channels. Enablement verifies the
pinned runtime/reference/configuration and current internal channel membership.
The Slack app requires `commands`, `files:write`, `files:read`, `channels:read`
and `groups:read` in addition to its existing bot scopes; scope changes require
reauthorizing the existing installation.

`deploy/managerai-reports.service` runs `runtime/report-server.py` on a private
listener (installed port 13019). Set `MANAGERAI_REPORT_RUNTIME_URL` and
`MANAGERAI_REPORT_RUNTIME_TOKEN` in the private application environment, and
`MANAGERAI_REPORT_INBOX` in the Slack worker environment. The inbox value is a
directory containing its SQLite spool. Report configuration and credentials
belong under the service account's `.config/managerai-reports`; jobs and review
evidence belong under `.local/share/managerai-reports`. Keep secrets mode600.
No WordPress/LocalWP database migration is involved.

The production executor uses openpyxl, LibreOffice and pdftoppm. Bubblewrap
restricts workbook execution to read-only sources and a writable job directory,
without network or private configuration access. On the installed Ubuntu host,
additional systemd user filesystem namespaces conflict with nested Bubblewrap;
the unit keeps process restrictions and uses Bubblewrap for workbook isolation.
Independent review uses the existing authenticated Codex runtime and signs a
hash-bound review receipt. Executor hashes and complete source provenance are
checked before release.

Report HTTP calls use manual redirect handling and reject non-success responses;
Workerd does not support the `error` redirect mode used by ordinary Node fetch.
Durable invocation keys, leases and upload reconciliation prevent blind duplicate
publication. Uncertain exhausted requests remain held for explicit recovery.
An unchanged enabled configuration does not expire between daily requests.
Use `npm run test:reports` and, after building, `npm run test:reports:api` for the
focused regression suites. Actual Slack delivery remains a separate acceptance
check from those fixtures.

## Starter registry and fresh data

Copy `config/vps-projects.example.json` to the ignored `config/vps-projects.json` and replace the synthetic paths and endpoints. `node scripts/seed-vps-projects.mjs config/vps-projects.example.json` emits SQL to stdout only; inspect it before applying it to a database. The example reads no private environment files. The sample Slack persona is Assistant, and the generic website report contract is `site.ai_referrals`. These sanitized migrations target a fresh database; this package does not claim an automatic migration from an earlier private installation.

The owner-original source is licensed under [MIT](LICENSE). Preserve dependency and font notices.

`SITE_URL` configures absolute share-card URLs. `.openai/hosting.json` contains generic binding names only; attach your own hosting project before any separately authorized deployment.

## Local verification and remaining work

Compilation, report suites, app/auth rendering, report API integration, intake gateway tests, and synthetic registry seeding have been checked locally. Live Slack/provider delivery and a configured production portal have not been verified.

See [asset provenance](ASSET-NOTICES.md). Bundled fonts are Geist under the SIL Open Font License.
