# Manager AI

Maintained by [aipieksel](https://github.com/aipieksel). Upstream credits and licenses remain with their respective authors.

Manager AI is an owner-facing command center for receiving operational issues, reviewing what happened, and deciding which triage work to dispatch. The web interface currently displays **Agent Command Center**. It keeps tickets, audit events, setup jobs, and runtime settings in Cloudflare D1, and connects to a constrained Codex manager runtime for approved work.

An issue can arrive manually or through a signed webhook. The owner reviews it in the dashboard before dispatching a named job to the bundled Linux runner or a dedicated HTTPS manager endpoint. Creating a ticket does not execute tools. The runner limits the available jobs and runs manager triage with a read-only sandbox.

## Main workflow

1. Sign in to the owner dashboard and review the incoming issue and audit trail.
2. Configure the protected runner connection through Setup.
3. Dispatch an approved triage job and inspect its bounded result before taking further action.

The repository also contains a separately configured Slack workflow for historical AI referral reports. Its permissions, data, and delivery controls are described below; it is not required for basic issue triage.

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

### Self-hosted deployment

The bundled [service unit](deploy/managerai.service) can run the Cloudflare worker under Wrangler/Workerd with persistent D1 state outside the checkout. Put it behind an HTTPS reverse proxy that authenticates the owner. The application requires a private proxy secret on identity-bearing requests, so a client cannot become the owner by forging an identity header. Apply migrations with `scripts/migrate-vps.sh` and keep runtime state and secrets outside Git. Review the service and proxy configuration for your own host before enabling it.

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

An optional Slack workflow produces a historical AI referral workbook for an authorized requester. A `/ai-referrals` command or an Assistant mention starts a fixed six-sheet report, then posts the reviewed XLSX in the originating thread. The requester receives one completion mention; custom date ranges are not supported.

This workflow has its own requester grants and channel policy, separate from general Assistant access. Configure allowed channels and membership checks before enabling it. The Slack app needs `commands`, `files:write`, `files:read`, `channels:read`, and `groups:read`; changed scopes require reauthorization. Report jobs, source snapshots, reviews, and delivery state are stored durably so a retry does not blindly upload a second workbook.

The report service uses `runtime/report-server.py` and the `deploy/managerai-reports.service` unit. Keep its runtime URL, token, inbox, configuration, and credentials in private service settings. Workbook execution uses openpyxl, LibreOffice, and pdftoppm; Bubblewrap confines it to read-only sources and a writable job directory. An independent review checks package evidence before release.

Run `npm run test:reports` and, after building, `npm run test:reports:api` for the focused local checks. Live Slack delivery still needs separate verification in your configured environment.

## Starter registry and fresh data

Copy `config/vps-projects.example.json` to the ignored `config/vps-projects.json` and replace the example paths and endpoints. `node scripts/seed-vps-projects.mjs config/vps-projects.example.json` emits SQL to stdout; inspect it before applying it to a database. The included migrations target a fresh database and do not migrate an earlier private installation automatically.

The owner-original source is licensed under [MIT](LICENSE). Preserve dependency and font notices.

`SITE_URL` configures absolute share-card URLs. `.openai/hosting.json` contains generic binding names only; attach your own hosting project before any separately authorized deployment.

## Verification boundaries

The included tests cover app/auth rendering, report API integration, intake, report packaging, and seeded examples. They do not establish live Slack delivery or validate a production portal configured for your environment.

See [asset provenance](ASSET-NOTICES.md). Bundled fonts are Geist under the SIL Open Font License.
