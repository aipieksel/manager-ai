"use client";

import { useState } from "react";

type DocumentationProps = {
  openConnections: () => void;
  openWebhooks: () => void;
  openSetup: () => void;
};

const managerContract = `POST <MANAGER_RUNTIME_URL>
Authorization: Bearer <MANAGER_RUNTIME_TOKEN>
Content-Type: application/json

{
  "ticketId": "tkt_...",
  "instruction": "Validate and triage this issue...",
  "ticket": {
    "title": "Health check failed",
    "details": "...",
    "priority": "high",
    "status": "new"
  },
  "requestedBy": "owner@example.com"
}`;

const webhookContract = `POST /api/webhooks/intake
X-Agent-Id: infra.agent
X-Timestamp: <unix-seconds>
X-Signature: sha256=<hex-hmac>

{
  "type": "issue.created",
  "idempotency_key": "evt_unique_value",
  "priority": "high",
  "title": "Health check failed",
  "details": { "service": "checkout" }
}`;

const signingExample = `const timestamp = Math.floor(Date.now() / 1000).toString();
const rawBody = JSON.stringify(payload);
const signed = timestamp + "." + rawBody;
const signature = createHmac("sha256", WEBHOOK_SECRET)
  .update(signed)
  .digest("hex");`;

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { setCopied(false); }
  }
  return <div className="docs-code-block"><button onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button><pre><code>{value}</code></pre></div>;
}

export default function Documentation({ openConnections, openWebhooks, openSetup }: DocumentationProps) {
  return (
    <section className="docs-page">
      <div className="docs-hero">
        <div>
          <span className="eyebrow">IMPLEMENTATION AND SETUP GUIDE</span>
          <h1>What is real, what is missing, and how to finish it</h1>
          <p>
            This page documents the system as it exists today. It deliberately
            separates deployed functionality from planned infrastructure.
          </p>
        </div>
        <span className="docs-version">AUDITED · 24 AUG 2026</span>
      </div>

      <nav className="docs-index" aria-label="Documentation sections">
        <a href="#reality-check">Reality check</a>
        <a href="#architecture">Architecture</a>
        <a href="#setup">Setup</a>
        <a href="#webhook-setup">Webhook</a>
        <a href="#security">Security</a>
        <a href="#testing">Testing</a>
        <a href="#official-sources">Sources</a>
      </nav>

      <div className="docs-layout">
        <main className="docs-main">
          <section id="reality-check" className="docs-section">
            <span className="docs-kicker">01 · REALITY CHECK</span>
            <h2>Will it work?</h2>
            <p className="docs-lead">
              The control portal works. The agent execution system does not run
              yet because it still needs a separate trusted manager runtime and
              its protected credentials.
            </p>
            <div className="truth-table">
              <article className="truth-ready">
                <span>DEPLOYED</span>
                <h3>Working now</h3>
                <ul>
                  <li>Owner-only ChatGPT sign-in and server-side identity checks</li>
                  <li>Persistent issue creation and retrieval</li>
                  <li>Database-backed audit events for real portal actions</li>
                  <li>Protected HTTPS bridge contract for a manager runtime</li>
                  <li>HMAC validation and replay checks in the intake handler</li>
                </ul>
              </article>
              <article className="truth-wired">
                <span>WIRED, NOT ACTIVE</span>
                <h3>Needs configuration</h3>
                <ul>
                  <li>Manager runtime URL and bearer token</li>
                  <li>Webhook signing secret</li>
                  <li>External MCP server URLs and authentication</li>
                  <li>Repository and tool allowlists for Codex</li>
                </ul>
              </article>
              <article className="truth-missing">
                <span>NOT INSTALLED YET</span>
                <h3>Still required on your server</h3>
                <ul>
                  <li>The allowlisted runner and manager service</li>
                  <li>Codex CLI authenticated on the trusted machine</li>
                  <li>A public intake gateway for external agents</li>
                  <li>Real approval callbacks and execution-result streaming</li>
                </ul>
              </article>
            </div>
            <div className="docs-warning">
              <strong>Why the Configure button stopped</strong>
              <p>
                API keys, MCP tokens and Codex credentials must never be saved
                in browser state. The old button only displayed that boundary;
                it did not offer the required server-side setup. The connection
                screen now reports the actual configuration and links here.
              </p>
            </div>
          </section>

          <section id="architecture" className="docs-section">
            <span className="docs-kicker">02 · RECOMMENDED ARCHITECTURE</span>
            <h2>Use three isolated parts</h2>
            <p>
              Keeping the public intake, private control portal and code-running
              agent separate limits the damage if any one part is compromised.
            </p>
            <div className="architecture-flow">
              <article><b>1</b><span><strong>Public intake gateway</strong><small>Accepts signed agent events only</small></span></article>
              <i>→</i>
              <article><b>2</b><span><strong>Private command centre</strong><small>Stores tickets and owner decisions</small></span></article>
              <i>→</i>
              <article><b>3</b><span><strong>Trusted manager runtime</strong><small>Runs Agents SDK, Codex and MCP clients</small></span></article>
            </div>
            <div className="docs-note">
              <strong>Important:</strong> this Site is owner-only. That protects
              the dashboard, but it also means external agents cannot call its
              webhook route. Do not make the whole dashboard public just to
              expose one endpoint. Deploy a small, separate public intake
              service and forward verified events into the private workflow.
            </div>
          </section>

          <section id="setup" className="docs-section">
            <span className="docs-kicker">03 · MANAGER RUNTIME SETUP</span>
            <h2>Build the component that actually runs the agents</h2>
            <p>
              The recommended runtime is a private Ubuntu VPS or trusted CI
              runner with the repository mounted locally. The hosted portal is
              not the correct place to run Codex CLI because Codex needs a local
              process, workspace and sandbox.
            </p>
            <div className="docs-note"><strong>Guided installation is now available:</strong> use the Setup page to download the one-time bootstrap installer and run the remaining allowlisted jobs from the dashboard.</div>
            <button className="docs-action" onClick={openSetup}>Open guided setup</button>

            <ol className="setup-steps">
              <li>
                <span>01</span>
                <div>
                  <h3>Prepare a trusted host</h3>
                  <p>Use a dedicated non-root Linux user, a fixed workspace directory, outbound HTTPS and no unnecessary inbound ports.</p>
                  <CodeBlock value={`node --version   # Node 18 or newer
python3 --version # Python 3.10 or newer
codex --version`} />
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Choose the Codex integration</h3>
                  <p>
                    Use the Codex SDK when the manager sends coding jobs directly
                    to Codex. Use Codex as an MCP server when Codex is one
                    specialist inside a broader Agents SDK workflow. This system
                    is designed for the second option.
                  </p>
                  <CodeBlock value={`npm install --global @openai/codex@latest
codex exec --ephemeral --sandbox read-only "Triage this issue"`} />
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>Authenticate the runtime</h3>
                  <p>
                    For programmatic automation, use a project-scoped OpenAI API
                    key or an eligible Codex access token on the trusted host.
                    Portal sign-in authenticates you to this website; it does not
                    transfer your browser session to the runtime.
                  </p>
                  <CodeBlock value={`sudo -u agentmgr -H codex login
sudo -u agentmgr -H codex login status`} />
                </div>
              </li>
              <li>
                <span>04</span>
                <div>
                  <h3>Expose one authenticated HTTPS endpoint</h3>
                  <p>
                    The portal already sends the following request. The runtime
                    must verify the bearer token before it starts any job.
                  </p>
                  <CodeBlock value={managerContract} />
                  <p className="code-caption">
                    Return a 2xx response only after the job is accepted. Return
                    a non-2xx response for invalid authentication, unknown
                    repositories, policy violations or capacity limits.
                  </p>
                </div>
              </li>
              <li>
                <span>05</span>
                <div>
                  <h3>Add MCP servers to the manager runtime</h3>
                  <p>
                    Configure remote MCP clients on the runtime, not in the
                    browser. Start with read-only tools. Require owner approval
                    for writes, deployments, billing, deletion and production
                    operations.
                  </p>
                </div>
              </li>
              <li>
                <span>06</span>
                <div>
                  <h3>Configure the portal runtime values</h3>
                  <div className="env-grid">
                    <code>OWNER_EMAIL</code><span>Exact owner email allowed by the API</span>
                    <code>MANAGER_RUNTIME_URL</code><span>Fixed HTTPS job endpoint</span>
                    <code>MANAGER_RUNTIME_TOKEN</code><span>Random bearer token shared with the runtime</span>
                    <code>AGENT_WEBHOOK_SECRET</code><span>Random secret used only for signed intake</span>
                  </div>
                  <p className="code-caption">
                    These are protected production runtime values. Do not paste
                    them into source files, browser forms, tickets or logs.
                  </p>
                  <div className="docs-note">
                    <strong>For this Site:</strong> production values are managed
                    in the Site runtime settings, separately from the source
                    code. If the settings screen is not available to you, ask
                    Codex in this private workspace to apply the values. Secret
                    values must be marked as secrets and should never be placed
                    in a normal message, screenshot or documentation page.
                  </div>
                </div>
              </li>
            </ol>
          </section>

          <section id="webhook-setup" className="docs-section">
            <span className="docs-kicker">04 · AGENT WEBHOOK SETUP</span>
            <h2>How another agent submits an issue</h2>
            <p>
              This is a custom agent-intake protocol, not an OpenAI webhook.
              The sender signs the exact raw JSON body together with the current
              Unix timestamp.
            </p>
            <CodeBlock value={webhookContract} />
            <h3 className="docs-subheading">Signature calculation</h3>
            <CodeBlock value={signingExample} />
            <div className="docs-checks">
              <div><strong>5-minute window</strong><span>Old timestamps are rejected</span></div>
              <div><strong>100 KB maximum</strong><span>Oversized bodies are rejected</span></div>
              <div><strong>Idempotency key</strong><span>Duplicate events do not create duplicate tickets</span></div>
              <div><strong>Raw-body signature</strong><span>Do not reformat JSON after signing</span></div>
            </div>
            <button className="docs-action" onClick={openWebhooks}>Open webhook status</button>
          </section>

          <section id="security" className="docs-section">
            <span className="docs-kicker">05 · SECURITY MODEL</span>
            <h2>Controls required before production use</h2>
            <div className="security-grid">
              <article><h3>Identity</h3><p>Keep the portal owner-only, enforce the exact owner email server-side and enable MFA on the OpenAI account.</p></article>
              <article><h3>Secrets</h3><p>Use protected runtime variables or a secrets manager. Rotate tokens after suspected exposure and on a schedule.</p></article>
              <article><h3>Codex sandbox</h3><p>Default to read-only. Grant workspace write only for approved repositories. Do not use unrestricted host access.</p></article>
              <article><h3>MCP tools</h3><p>Allowlist servers and tools. Validate every argument server-side. Require approval for consequential calls.</p></article>
              <article><h3>Network</h3><p>Use HTTPS, firewall the runtime, restrict source IPs where possible and keep the runtime off the public dashboard host.</p></article>
              <article><h3>Audit</h3><p>Record intake, assignment, approval, tool call and outcome. The current audit table is attributed history, not an immutable ledger.</p></article>
            </div>
          </section>

          <section id="testing" className="docs-section">
            <span className="docs-kicker">06 · ACCEPTANCE TESTS</span>
            <h2>Do not call it operational until all tests pass</h2>
            <ol className="test-list">
              <li><span>1</span><p><strong>Authentication:</strong> an unapproved user cannot open the portal or call owner APIs.</p></li>
              <li><span>2</span><p><strong>Persistence:</strong> create an issue, reload, and confirm it remains in the inbox.</p></li>
              <li><span>3</span><p><strong>Webhook rejection:</strong> invalid signatures, expired timestamps and oversized payloads fail.</p></li>
              <li><span>4</span><p><strong>Replay protection:</strong> the same idempotency key creates only one ticket.</p></li>
              <li><span>5</span><p><strong>Runtime authentication:</strong> missing or incorrect bearer tokens never start a Codex job.</p></li>
              <li><span>6</span><p><strong>Repository boundary:</strong> Codex cannot read or write outside the allowlisted workspace.</p></li>
              <li><span>7</span><p><strong>Approval boundary:</strong> production, deletion and financial MCP tools pause for owner approval.</p></li>
              <li><span>8</span><p><strong>Recovery:</strong> failed jobs time out safely, record an outcome and can be retried without duplication.</p></li>
            </ol>
            <button className="docs-action" onClick={openConnections}>Open connection status</button>
          </section>

          <section id="official-sources" className="docs-section">
            <span className="docs-kicker">07 · OFFICIAL OPENAI DOCUMENTATION</span>
            <h2>Sources used to verify this design</h2>
            <div className="source-list">
              <a href="https://learn.chatgpt.com/docs/codex-sdk" target="_blank" rel="noreferrer"><strong>Codex SDK</strong><span>Programmatic, server-side Codex threads</span></a>
              <a href="https://learn.chatgpt.com/docs/mcp-server" target="_blank" rel="noreferrer"><strong>Codex with Agents SDK</strong><span>Run Codex CLI as an MCP server</span></a>
              <a href="https://developers.openai.com/api/docs/guides/tools-connectors-mcp" target="_blank" rel="noreferrer"><strong>MCP and connectors</strong><span>Remote MCP tools and approval controls</span></a>
              <a href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noreferrer"><strong>Codex authentication</strong><span>ChatGPT sign-in, API keys and trusted automation</span></a>
              <a href="https://developers.openai.com/api/reference/overview" target="_blank" rel="noreferrer"><strong>API authentication</strong><span>Keep API credentials server-side</span></a>
            </div>
          </section>
        </main>

        <aside className="docs-aside">
          <div>
            <span>CURRENT VERDICT</span>
            <strong>Portal deployed</strong>
            <strong>Runtime not connected</strong>
            <strong>Webhook not externally reachable</strong>
          </div>
          <div>
            <span>RECOMMENDED NEXT BUILD</span>
            <p>Create the trusted manager runtime first. Then connect one read-only MCP server and complete the acceptance tests before enabling action tools.</p>
          </div>
        </aside>
      </div>
    </section>
  );
}
