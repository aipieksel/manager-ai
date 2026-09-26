"use client";

import { ReportSettingsPanel } from "./reports/settings";
import { useCallback, useEffect, useState } from "react";

type Notify = (message: string) => void;
type SlackInstallation = { id: string; team_id: string; workspace_name: string; bot_user_id?: string; status: string; installed_at: number };
type SlackChannel = { id: string; channel_id: string; channel_name: string; allowed: number | boolean; defaultProjectName?: string };
type SlackState = { installations: SlackInstallation[]; channels: SlackChannel[]; worker: { configured?: boolean; connected?: boolean; lastConnectedAt?: number; lastEventAt?: number; lastErrorCode?: string; pendingRuns?: number; allowedUsers?: string[]; apiAppId?: string } };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function dateTime(value?: number) { return value ? new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never"; }

function safeBotHandleText(setupUrl: string) {
  return `Run exactly one GET request using this private setup URL:\n\n\`${setupUrl}\``;
}

export function SlackWorkspace({ notify }: { notify: Notify }) {
  const [data, setData] = useState<SlackState>({ installations: [], channels: [], worker: {} });
  const [editingSlack, setEditingSlack] = useState(false);
  const [copying, setCopying] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setData(await api<SlackState>("/api/slack")); } catch (error) { notify(error instanceof Error ? error.message : "Slack status could not load"); } }, [notify]);
  useEffect(() => { let cancelled = false; void api<SlackState>("/api/slack").then((value) => { if (!cancelled) setData(value); }).catch((error) => notify(error instanceof Error ? error.message : "Slack status could not load")); return () => { cancelled = true; }; }, [notify]);

  async function configureSlack(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const lines = String(form.get("channels") || "").split(/\n|,/).map((line) => line.trim()).filter(Boolean);
    const channels = lines.map((line) => { const [id, ...name] = line.split(":"); return { id: id.trim(), name: name.join(":").trim() || id.trim() }; });
    const allowedUsers=String(form.get("allowedUsers")||"").split(/[\s,]+/).filter(Boolean);
    const apiAppId=String(form.get("apiAppId")||"").trim();
    setBusy(true);
    try { await api("/api/slack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botToken: form.get("botToken"), appToken: form.get("appToken"), channels, ...(allowedUsers.length?{allowedUsers}:{}), ...(apiAppId?{apiAppId}:{}) }) }); setEditingSlack(false); await load(); notify("Slack workspace validated and connected"); }
    catch (error) { notify(error instanceof Error ? error.message : "Slack could not connect"); }
    finally { setBusy(false); }
  }

  async function copyBotHandle() {
    if (copying) return;
    setCopying(true);
    try {
      const result = await api<{ setupUrl: string }>("/api/slack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create_bot_handle" }) });
      await navigator.clipboard.writeText(safeBotHandleText(result.setupUrl));
      notify("Fresh bot handle copied safely. Paste the complete message to the recipient.");
    } catch (error) { notify(error instanceof Error ? error.message : "The bot handle could not be copied"); }
    finally { setCopying(false); }
  }

  const installation = data.installations[0];
  const canCopy = data.channels.some((channel) => Boolean(channel.allowed));
  return <section className="page-section ops-page">
    <div className="section-title"><div><span className="eyebrow">SOCKET MODE · BOT HANDOFF</span><h1>Slack & Assistant</h1><p>Copy one private setup URL. The recipient opens it once and receives a reusable bot key, complete instructions, and a blank message canvas.</p></div><div className="section-actions"><button className="secondary-button" onClick={() => void load()}>Refresh</button><button className="primary-button" onClick={() => setEditingSlack(true)}>{installation ? "Rotate or reconfigure" : "Connect Slack"}</button></div></div>
    <section className="ops-summary-strip"><div><strong>{data.worker.connected ? "Online" : "Offline"}</strong><span>Assistant</span></div><div><strong>{data.channels.filter((channel) => Boolean(channel.allowed)).length}</strong><span>Allowed channels</span></div><div><strong>One GET</strong><span>Bot setup</span></div><div><strong>{installation?.workspace_name || "—"}</strong><span>Workspace</span></div></section>
    <div className="slack-ops-grid">
      <section className="panel slack-status-card"><div className="panel-head"><div><span className="eyebrow">BOT HANDOFF</span><h2>Assistant</h2><span>No contracts to choose and no hidden key to find.</span></div><span className={`connection-state ${data.worker.connected ? "connected" : ""}`}><i/>{data.worker.connected ? "Connected" : data.worker.lastErrorCode || "Not connected"}</span></div><div className="bot-handle-action"><p>The copied URL works once. Its response contains everything the bot needs for future messages.</p><button className="primary-button" onClick={() => void copyBotHandle()} disabled={copying || !canCopy}>{copying ? "Creating…" : "Copy bot handle"}</button></div><dl><div><dt>Workspace</dt><dd>{installation?.workspace_name || "Not installed"}</dd></div><div><dt>Bot user</dt><dd>{installation?.bot_user_id || "—"}</dd></div><div><dt>Last socket connection</dt><dd>{dateTime(data.worker.lastConnectedAt)}</dd></div><div><dt>Last Slack request</dt><dd>{dateTime(data.worker.lastEventAt)}</dd></div></dl></section>
      <section className="panel"><div className="panel-head"><div><h2>Allowed channels</h2><span>Bot messages go to the first allowed channel. Assistant remains limited to this list.</span></div><b>{data.channels.length}</b></div>{data.channels.length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>Channel</th><th>Slack ID</th><th>Default project</th></tr></thead><tbody>{data.channels.map((channel) => <tr key={channel.id}><td><strong>#{channel.channel_name}</strong></td><td><code>{channel.channel_id}</code></td><td>{channel.defaultProjectName || "Named agent decides"}</td></tr>)}</tbody></table></div> : <div className="ops-table-empty">Connect Slack and allow a channel before copying a bot handle.</div>}</section>
      <section className="panel slack-workflow"><div className="panel-head"><div><h2>Simple bot handoff</h2><span>One setup request, then the saved bot key is reused.</span></div><button onClick={() => void copyBotHandle()} disabled={copying || !canCopy}>Copy bot handle</button></div><ol><li><b>01</b><span><strong>Copy the handle</strong><small>Every click creates a fresh private URL. Paste the complete copied message so chat previews cannot spend it.</small></span></li><li><b>02</b><span><strong>The bot performs one GET</strong><small>The URL returns the reusable key, complete sending instructions, and blank canvas together.</small></span></li><li><b>03</b><span><strong>The URL expires immediately</strong><small>A second GET cannot retrieve the reusable key or instructions again.</small></span></li><li><b>04</b><span><strong>The bot sends its canvas</strong><small>It saves the reusable key, fills in the blank message, and sends whenever needed.</small></span></li></ol></section>
    </div>
    <ReportSettingsPanel notify={notify}/>
    {editingSlack && <div className="ops-modal-backdrop" onMouseDown={() => setEditingSlack(false)}><form className="ops-modal" onSubmit={configureSlack} onMouseDown={(event) => event.stopPropagation()}><div className="ops-modal-head"><div><span className="eyebrow">ASSISTANT · SLACK SOCKET MODE</span><h2>Validate and connect</h2></div><button type="button" onClick={() => setEditingSlack(false)}>×</button></div><label>Bot token<input type="password" name="botToken" required autoComplete="new-password" placeholder="xoxb-…"/></label><label>App-level token<input type="password" name="appToken" required autoComplete="new-password" placeholder="xapp-… with connections:write"/></label><label>Slack app ID<input name="apiAppId" defaultValue={data.worker.apiAppId||""} placeholder="A0123456789"/></label><label>General-agent users<textarea name="allowedUsers" rows={3} defaultValue={(data.worker.allowedUsers||[]).join("\n")} placeholder="One Slack user ID per line"/><small>Blank preserves the current list. Report-only users belong in Report access.</small></label><label>Allowed channels<textarea name="channels" required rows={5} placeholder={"C0123456789:work-planning\nC9876543210:client-delivery"}/><small>One Slack channel ID and display name per line. Assistant must already be invited.</small></label><div className="form-notice"><span><strong>One-way secret submission</strong>Tokens are validated with Slack, written mode 600 by the VPS worker, and never stored in D1.</span></div><div className="drawer-actions"><button type="button" onClick={() => setEditingSlack(false)}>Cancel</button><button className="primary-button" disabled={busy}>{busy ? "Validating…" : "Connect workspace"}</button></div></form></div>}
  </section>;
}
