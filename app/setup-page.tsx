"use client";

import { useEffect, useState } from "react";

type Health = {
  status?: string;
  version?: string;
  codexInstalled?: boolean;
  codexAuthenticated?: boolean;
  workspaceReady?: boolean;
  codexStatus?: string;
  activeSetupJob?: string | null;
};

type SetupRun = {
  id: string;
  job: string;
  status: string;
  output: string;
  createdAt: number;
  completedAt: number | null;
};

type SetupStatus = {
  configured: boolean;
  runnerUrl: string;
  tokenConfigured: boolean;
  connected: boolean;
  health: Health | null;
  jobs: SetupRun[];
};

const bootstrapCommand = "sudo bash agent-command-center-bootstrap.sh";
const authenticationCommand = "sudo -u agentmgr -H codex login";
const proxyExample = `# Example reverse-proxy target
# Terminate valid public TLS at runner.example.com
# and forward only /v1/ to:
http://127.0.0.1:8787`;

const setupJobs = [
  { id: "preflight", title: "Run server preflight", description: "Checks the operating system, systemd, sudo, disk and architecture without installing packages." },
  { id: "install_dependencies", title: "Install prerequisites", description: "Installs the required Ubuntu/Debian packages and verifies Node.js 18+, Python, Git and npm." },
  { id: "install_codex", title: "Install or update Codex", description: "Installs the official Codex CLI package globally and records its installed version." },
  { id: "verify_codex", title: "Verify Codex authentication", description: "Checks the CLI and its saved login state. It never asks the browser for your OpenAI credential." },
  { id: "prepare_manager", title: "Prepare manager workspace", description: "Creates the allowlisted Git workspace and its default read-only-first AGENTS.md policy." },
  { id: "health_check", title: "Run final health check", description: "Verifies the runner service, Codex executable and manager workspace." },
];

export default function SetupPage({ notify }: { notify: (message: string) => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [runnerUrl, setRunnerUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeRun, setActiveRun] = useState<SetupRun | null>(null);

  async function loadStatus(showMessage = false) {
    setLoading(true);
    try {
      const response = await fetch("/api/setup/status", { cache: "no-store" });
      if (!response.ok) throw new Error("status request failed");
      const next = await response.json() as SetupStatus;
      setStatus(next);
      setRunnerUrl(next.runnerUrl);
      if (showMessage) notify(next.connected ? "Runner connection verified" : "Runner is not reachable yet");
    } catch {
      if (showMessage) notify("Setup status could not be loaded");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/setup/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("status request failed");
        return response.json() as Promise<SetupStatus>;
      })
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        setRunnerUrl(next.runnerUrl);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label} copied`);
    } catch {
      notify("Copy was blocked by the browser");
    }
  }

  async function saveRunner(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/setup/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runnerUrl }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) { notify(result.error ?? "Runner URL could not be saved"); return; }
      notify("Runner URL saved; testing connection");
      await loadStatus();
    } catch {
      notify("Runner URL could not be saved");
    } finally {
      setSaving(false);
    }
  }

  async function runJob(job: string) {
    if (activeRun) return;
    const response = await fetch("/api/setup/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job }) });
    const result = await response.json() as { runId?: string; error?: string; details?: { error?: string } };
    if (!response.ok || !result.runId) { notify(result.details?.error ?? result.error ?? "Setup job could not start"); return; }
    const initial: SetupRun = { id: result.runId, job, status: "running", output: "Job accepted by the runner…", createdAt: 0, completedAt: null };
    setActiveRun(initial);
    notify("Setup job started");
    for (let attempt = 0; attempt < 450; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const poll = await fetch(`/api/setup/job?runId=${encodeURIComponent(result.runId)}`, { cache: "no-store" });
      if (!poll.ok) continue;
      const data = await poll.json() as { run?: SetupRun };
      if (!data.run) continue;
      setActiveRun(data.run);
      if (data.run.status === "succeeded" || data.run.status === "failed") {
        notify(data.run.status === "succeeded" ? "Setup job completed" : "Setup job failed; review the output");
        await loadStatus();
        return;
      }
    }
    notify("The job is still running; refresh Setup to check it later");
  }

  const connected = Boolean(status?.connected);
  const health = status?.health;

  return (
    <section className="setup-page">
      <div className="section-title setup-heading">
        <div><span className="eyebrow">GUIDED SERVER INSTALLATION</span><h1>Setup and runtime controls</h1><p>Bootstrap the trusted server once, then run every allowlisted installation and verification job from this page.</p></div>
        <button className="secondary-button" onClick={() => void loadStatus(true)} disabled={loading}>{loading ? "Checking…" : "Recheck connection"}</button>
      </div>

      <div className="setup-boundary">
        <strong>One manual action is unavoidable</strong>
        <p>A website cannot execute commands on a new server before that server trusts it. Download and run the bootstrap installer once. After the runner is reachable over HTTPS, the controls below perform the remaining setup.</p>
      </div>

      <div className="setup-progress" aria-label="Setup status">
        <article className="complete"><span>01</span><div><strong>Portal secret</strong><small>{status?.tokenConfigured ? "Protected token ready" : "Token missing"}</small></div></article>
        <article className={status?.configured ? "complete" : ""}><span>02</span><div><strong>Runner URL</strong><small>{status?.configured ? "Saved" : "Not connected"}</small></div></article>
        <article className={connected ? "complete" : ""}><span>03</span><div><strong>Server runner</strong><small>{connected ? "Online" : "Waiting for server"}</small></div></article>
        <article className={health?.codexAuthenticated ? "complete" : ""}><span>04</span><div><strong>Codex</strong><small>{health?.codexAuthenticated ? "Authenticated" : health?.codexInstalled ? "Login required" : "Not installed"}</small></div></article>
      </div>

      <div className="setup-grid">
        <section className="panel setup-panel">
          <div className="setup-panel-head"><span>STEP 1</span><h2>Install the server runner</h2><p>The downloaded file is generated for your portal and contains its protected runner token. Treat it like a password.</p></div>
          <div className="setup-button-row"><a className="primary-button" href="/api/setup/bootstrap" download>Download bootstrap installer</a><button className="secondary-button" onClick={() => void copy(bootstrapCommand, "Install command")}>Copy install command</button></div>
          <div className="setup-code"><code>{bootstrapCommand}</code><button onClick={() => void copy(bootstrapCommand, "Install command")}>Copy</button></div>
          <p className="setup-help">Transfer the downloaded file to the Ubuntu/Debian server, then run this single command there. The installer creates a dedicated service user, root-owned allowlisted scripts, a systemd service and a private workspace.</p>
        </section>

        <section className="panel setup-panel">
          <div className="setup-panel-head"><span>STEP 2</span><h2>Expose only the runner API over HTTPS</h2><p>The runner listens on <code>127.0.0.1:8787</code>. Put it behind your existing TLS reverse proxy or a private HTTPS tunnel; do not open port 8787 publicly.</p></div>
          <div className="setup-code multiline"><pre>{proxyExample}</pre><button onClick={() => void copy(proxyExample, "Proxy example")}>Copy</button></div>
          <form className="runner-form" onSubmit={saveRunner}><label>Runner HTTPS origin<input type="url" value={runnerUrl} onChange={(event) => setRunnerUrl(event.target.value)} placeholder="https://runner.example.com" required/></label><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Save and connect"}</button></form>
          <p className="setup-help">Only a public HTTPS origin is accepted. Paths, embedded credentials, localhost and private-network IP addresses are rejected.</p>
        </section>
      </div>

      <section className="setup-jobs">
        <div className="setup-jobs-head"><div><span className="eyebrow">STEP 3 · ALLOWLISTED JOBS</span><h2>Complete the installation from the dashboard</h2></div><span className={`connection-state ${connected ? "connected" : ""}`}><i/>{connected ? "Runner online" : "Runner offline"}</span></div>
        <div className="job-list">{setupJobs.map((job, index) => {
          const previous = status?.jobs.find((run) => run.job === job.id);
          return <article key={job.id}><span className="job-index">{String(index + 1).padStart(2, "0")}</span><div><h3>{job.title}</h3><p>{job.description}</p></div><span className={`job-state ${previous?.status ?? "not-run"}`}>{previous?.status?.replaceAll("_", " ") ?? "Not run"}</span><button className="secondary-button" onClick={() => void runJob(job.id)} disabled={!connected || Boolean(activeRun)}>{activeRun?.job === job.id ? "Running…" : "Run"}</button></article>;
        })}</div>
      </section>

      <section className="panel credential-step">
        <div><span className="eyebrow">PROTECTED CREDENTIAL CHECKPOINT</span><h2>Authenticate Codex on the trusted server</h2><p>The dashboard deliberately does not accept an OpenAI API key. Sign in directly as the dedicated runtime user, then return here and run “Verify Codex authentication.”</p></div>
        <div className="setup-code"><code>{authenticationCommand}</code><button onClick={() => void copy(authenticationCommand, "Authentication command")}>Copy</button></div>
      </section>

      <section className="panel job-console">
        <div className="panel-head"><div><h2>Job output</h2><span>{activeRun ? `${activeRun.job} · ${activeRun.status}` : "Run a setup job to see its verified server output"}</span></div>{activeRun && <span className={`job-state ${activeRun.status}`}>{activeRun.status}</span>}</div>
        <pre>{activeRun?.output || "No setup job selected."}</pre>
      </section>

      <section className="setup-security-grid">
        <article><strong>No arbitrary terminal</strong><p>The API accepts six fixed job IDs. It cannot receive a shell command, script body or user-supplied arguments.</p></article>
        <article><strong>Least privilege</strong><p>The runner uses a dedicated account. Only exact root-owned setup scripts are allowed through sudo.</p></article>
        <article><strong>Credentials isolated</strong><p>The runner token is a protected Site secret and never enters Codex’s process environment.</p></article>
        <article><strong>Real job history</strong><p>Every requested job and its bounded output are stored in the database for review.</p></article>
      </section>
    </section>
  );
}
