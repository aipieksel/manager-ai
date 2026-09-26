#!/usr/bin/env node
import { homedir } from "node:os";
import { isChannelMember } from "./report-membership.mjs";
import { advanceDelivery } from "./report-delivery.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appHomeView, classifySlackEvent, isAllowedSlackUser, SUGGESTED_PROMPTS, stripBotMentions } from "./event-routing.mjs";

import { ReportInbox } from "./report-inbox.mjs";
import { intakeReport, drainReportInbox } from "./report-intake.mjs";
let reportInbox = null;
let reportDrainActive = false;

const host = process.env.MANAGERAI_SLACK_HOST || "172.17.0.1";
const port = Number(process.env.MANAGERAI_SLACK_PORT || 13008);
const configPath = process.env.MANAGERAI_SLACK_CONFIG || `${homedir()}/.config/managerai-slack/installation.json`;
const bridgeUrl = process.env.MANAGERAI_SLACK_BRIDGE_URL || "http://172.17.0.1:13006/api/slack/bridge";
const bridgeSecret = process.env.MANAGERAI_SLACK_BRIDGE_SECRET || "";
const managementToken = process.env.MANAGERAI_SLACK_MANAGEMENT_TOKEN || "";
let socket = null;
let reconnectTimer = null;
let installation = null;
const pendingRuns = new Map();
const postedNotifications = new Map();
const state = { connected: false, lastConnectedAt: null, lastEventAt: null, lastErrorCode: null };

function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return null; }
}

function saveConfig(value) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, configPath); fs.chmodSync(configPath, 0o600);
}

async function slackApi(method, token, body = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  const usesQuery = ["conversations.replies", "conversations.info", "conversations.members", "files.info", "files.getUploadURLExternal"].includes(method);
  if (usesQuery) for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
  const response = await fetch(url, usesQuery
    ? { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }
    : { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`slack_${method.replaceAll(".", "_")}_${data.error || response.status}`);
  return data;
}

async function bridge(payload) {
  const body = JSON.stringify(payload); const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", bridgeSecret).update(`${timestamp}.${body}`).digest("hex");
  const response = await fetch(bridgeUrl, { method: "POST", headers: { "content-type": "application/json", "x-managerai-timestamp": timestamp, "x-managerai-signature": `sha256=${signature}` }, body, signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(`bridge_${data.error || response.status}`), { status: response.status });
  return data;
}

async function reply(channel, threadTs, text) {
  return slackApi("chat.postMessage", installation.botToken, { channel, thread_ts: threadTs, text: text.slice(0, 3500), unfurl_links: false, unfurl_media: false });
}

export function clientMessageId(value) {
  const hex = crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export async function processNotification({ payload, currentInstallation, replayStore, postMessage }) {
  const channel = String(payload?.channel || "").slice(0, 120);
  const text = String(payload?.text || "").trim().slice(0, 3500);
  const idempotencyKey = String(payload?.idempotencyKey || "").trim().slice(0, 180);
  if (!currentInstallation || !currentInstallation.allowedChannels?.includes(channel) || !text || !idempotencyKey) {
    return { status: 400, payload: { error: "Allowed channel, text, and idempotency key are required" } };
  }
  if (replayStore.has(idempotencyKey)) {
    return { status: 200, payload: { posted: true, duplicate: true, ts: replayStore.get(idempotencyKey) } };
  }
  try {
    const result = await postMessage({ channel, text, client_msg_id: clientMessageId(idempotencyKey), unfurl_links: false, unfurl_media: false });
    replayStore.set(idempotencyKey, String(result.ts || ""));
    if (replayStore.size > 500) replayStore.delete(replayStore.keys().next().value);
    return { status: 202, payload: { posted: true, ts: result.ts } };
  } catch (error) {
    return { status: 502, payload: { error: String(error.message).slice(0, 160) } };
  }
}

async function readJsonBody(request, response) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_000) { jsonResponse(response, 413, { error: "Payload too large" }); return null; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { jsonResponse(response, 400, { error: "Invalid JSON" }); return null; }
}

async function bestEffortSlack(method, body) {
  try { await slackApi(method, installation.botToken, body); }
  catch (error) { state.lastErrorCode = String(error.message).slice(0, 160); }
}

async function setAssistantPrompts(channelId, threadTs) {
  const body = { channel_id: channelId, prompts: SUGGESTED_PROMPTS };
  if (threadTs) body.thread_ts = threadTs;
  await bestEffortSlack("assistant.threads.setSuggestedPrompts", body);
}

async function handleAppHome(event) {
  if (!isAllowedSlackUser(event.user, installation?.allowedUsers)) return;
  if (event.tab === "messages") return setAssistantPrompts(event.channel);
  if (event.tab === "home" && event.user) await bestEffortSlack("views.publish", { user_id: event.user, view: appHomeView() });
}

async function handleAssistantThread(event) {
  const thread = event.assistant_thread || {};
  const userId = event.user_id || event.user || thread.user_id;
  if (!isAllowedSlackUser(userId, installation?.allowedUsers)) return;
  if (thread.channel_id) await setAssistantPrompts(thread.channel_id, thread.thread_ts);
}

async function handleAgentRequest(envelope, classification) {
  const event = envelope.payload?.event || {};
  if (!installation) return;
  if (!isAllowedSlackUser(event.user, installation.allowedUsers)) return;
  const isDirectMessage = classification.eventType === "direct_message";
  if (!isDirectMessage && !installation.allowedChannels?.includes(event.channel)) return;
  const threadTs = event.thread_ts || event.ts;
  const context = await slackApi("conversations.replies", installation.botToken, { channel: event.channel, ts: threadTs, limit: 100 });
  const messages = (context.messages || []).map((message) => ({ ts: String(message.ts || ""), user: String(message.user || ""), text: String(message.text || "").slice(0, 12_000) }));
  if (classification.explicit) await bestEffortSlack("reactions.add", { channel: event.channel, timestamp: event.ts, name: "eyes" });
  if (isDirectMessage) await bestEffortSlack("assistant.threads.setStatus", { channel_id: event.channel, thread_ts: threadTs, status: "Routing to the right agent…" });
  const accepted = await bridge({ action: "event", eventType: classification.eventType, eventId: envelope.payload?.event_id, teamId: envelope.payload?.team_id, channelId: event.channel, threadTs, messageTs: event.ts, userId: event.user, text: stripBotMentions(event.text), messages, isDirectMessage });
  state.lastEventAt = Date.now();
  if (isDirectMessage) await bestEffortSlack("assistant.threads.setStatus", { channel_id: event.channel, thread_ts: threadTs, status: "" });
  if (accepted.duplicate) return;
  if (accepted.ignored) return;
  if (accepted.needsAgent) {
    await reply(event.channel, threadTs, String(accepted.message || "Tell me which Agent Command Center agent should handle this thread."));
    return;
  }
  await reply(event.channel, threadTs, `I’ve routed this thread to ${accepted.agentName || "the selected agent"}. I’ll return the result here. ${accepted.projectUrl || ""}`.trim());
  pendingRuns.set(accepted.runId, { channel: event.channel, threadTs, projectUrl: accepted.projectUrl, agentName: accepted.agentName, replied: false });
}

async function pollReportDelivery() {
  const { delivery } = await bridge({ action: "report.delivery.claim" });
  if (!delivery) return;
  const claim = { runId: delivery.runId, fence: delivery.fence };
  try {
    await advanceDelivery(delivery, {
      authorize: () => bridge({ action: "report.delivery.authorize", claim }),
      save: (patch) => bridge({ action: "report.delivery.save", claim, patch }),
      slack: (method, body) => slackApi(method, installation.botToken, body),
      artifact: async () => Buffer.from((await bridge({ action: "report.delivery.artifact", claim })).base64, "base64"),
      upload: (url, bytes) => fetch(url, { method: "POST", body: bytes, redirect: "error", signal: AbortSignal.timeout(30_000) }),
    });
  } finally { await bridge({ action: "report.delivery.release", claim }); }
}

function scheduleReconnect() {
  if (reconnectTimer || !installation) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connectSocket(); }, 5000);
}

async function connectSocket() {
  if (!installation?.appToken || !installation?.botToken) return;
  try {
    const opened = await slackApi("apps.connections.open", installation.appToken);
    socket = new WebSocket(opened.url);
    socket.addEventListener("open", () => { state.connected = true; state.lastConnectedAt = Date.now(); state.lastErrorCode = null; });
    socket.addEventListener("message", (message) => {
      void handleSocketMessage(message).catch(() => { state.lastErrorCode = "report_intake_unavailable"; });
    });
    async function handleSocketMessage(message) {
      let envelope; try { envelope = JSON.parse(String(message.data)); } catch { return; }
      if (await intakeReport(envelope, installation, reportInbox, async (incoming, text) => {
        if (!text && incoming.type === "slash_commands") text = "Request received. Checking report access.";
        if (text && !incoming.accepts_response_payload && incoming.payload?.event?.channel && incoming.payload?.event?.user) {
          await slackApi("chat.postEphemeral", installation.botToken, { channel: incoming.payload.event.channel, user: incoming.payload.event.user, text });
        }
        if (incoming.envelope_id) socket.send(JSON.stringify({ envelope_id: incoming.envelope_id,
          ...(text && incoming.accepts_response_payload ? { payload: { text, response_type: "ephemeral" } } : {}) }));
      })) return;
      if (envelope.envelope_id) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
      if (envelope.type === "events_api") {
        const event = envelope.payload?.event || {};
        if (event.type === "app_home_opened") void handleAppHome(event);
        else if (event.type === "assistant_thread_started") void handleAssistantThread(event);
        else {
          const classification = classifySlackEvent(event);
          if (classification.kind === "agent_request") void handleAgentRequest(envelope, classification).catch((error) => { state.lastErrorCode = String(error.message).slice(0, 160); });
        }
      }
      if (envelope.type === "disconnect") socket.close();
    }
    socket.addEventListener("close", () => { state.connected = false; scheduleReconnect(); });
    socket.addEventListener("error", () => { state.connected = false; state.lastErrorCode = "socket_error"; });
  } catch (error) { state.connected = false; state.lastErrorCode = String(error.message).slice(0, 160); scheduleReconnect(); }
}

async function pollRuns() {
  for (const [runId, target] of pendingRuns) {
    try {
      const result = await bridge({ action: "status", runId });
      if (!result.terminal) continue;
      const text = result.status === "succeeded" ? `${target.agentName || "The selected agent"} is done: ${result.summary || "The result is available for review."}\n${target.projectUrl || ""}` : `${target.agentName || "The selected agent"} could not finish: ${result.failureMessage || result.status}. The run is preserved in ManagerAI for review.`;
      await reply(target.channel, target.threadTs, text.trim()); pendingRuns.delete(runId);
    } catch (error) { state.lastErrorCode = String(error.message).slice(0, 160); }
  }
}

function jsonResponse(response, status, payload) {
  const body = JSON.stringify(payload); response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-robots-tag": "noindex, nofollow" }); response.end(body);
}

const server = http.createServer(async (request, response) => {
  if (request.url === "/health" && request.method === "GET") return jsonResponse(response, 200, { status: "ok", configured: Boolean(installation), connected: state.connected });
  const token = String(request.headers.authorization || "").replace(/^Bearer /, "");
  if (!managementToken || !safeEqual(token, managementToken)) return jsonResponse(response, 401, { error: "Unauthorized" });
  if (request.url === "/v1/status" && request.method === "GET") return jsonResponse(response, 200, { ...state, configured: Boolean(installation), apiAppId: installation?.apiAppId, workspaceName: installation?.workspaceName, teamId: installation?.teamId, botUserId: installation?.botUserId, allowedChannels: installation?.allowedChannels || [], allowedUsers: installation?.allowedUsers || [], pendingRuns: pendingRuns.size });
  if (request.url === "/v1/report-channel" && request.method === "POST") {
    const payload = await readJsonBody(request, response); if (!payload) return;
    if (!installation || payload.teamId !== installation.teamId || !/^[CG][A-Z0-9]{1,79}$/.test(payload.channelId || "")) return jsonResponse(response, 403, { error: "report_forbidden" });
    try {
      const result = await slackApi("conversations.info", installation.botToken, { channel: payload.channelId });
      const c = result.channel;
      if (payload.userId !== undefined) {
        if (!/^[UW][A-Z0-9]{1,79}$/.test(payload.userId)) return jsonResponse(response, 400, {error:"invalid_requester"});
        c.requester_is_member = await isChannelMember((method, body) => slackApi(method, installation.botToken, body), payload.channelId, payload.userId);
      }
      const fields = ["id", "is_archived", "is_member", "is_im", "is_mpim", "is_ext_shared", "is_shared", "is_pending_ext_shared", "pending_shared", "shared_team_ids", "requester_is_member"];
      return jsonResponse(response, 200, { channel: Object.fromEntries(fields.filter(k => k in c).map(k => [k, c[k]])) });
    } catch { return jsonResponse(response, 503, { error: "channel_verification_unavailable" }); }
  }
  if (request.url === "/v1/notify" && request.method === "POST") {
    const payload = await readJsonBody(request, response); if (!payload) return;
    const result = await processNotification({
      payload,
      currentInstallation: installation,
      replayStore: postedNotifications,
      postMessage: (message) => slackApi("chat.postMessage", installation.botToken, message),
    });
    if (result.status === 502) state.lastErrorCode = result.payload.error;
    return jsonResponse(response, result.status, result.payload);
  }
  if (request.url === "/v1/configure" && request.method === "POST") {
    const payload = await readJsonBody(request, response); if (!payload) return;
    try {
      const auth = await slackApi("auth.test", String(payload.botToken || ""));
      const allowedUsers = Array.isArray(payload.allowedUsers) ? payload.allowedUsers.map(String).slice(0, 25) : installation?.allowedUsers || [];
      if (!String(payload.appToken || "").startsWith("xapp-") || !Array.isArray(payload.allowedChannels) || !payload.allowedChannels.length || !allowedUsers.length) return jsonResponse(response, 400, { error: "App token, at least one allowed channel, and at least one allowed user are required" });
      const apiAppId = payload.apiAppId === undefined ? installation?.apiAppId : payload.apiAppId;
      if (apiAppId !== undefined && (typeof apiAppId !== "string" || !/^A[A-Z0-9]{1,79}$/.test(apiAppId))) return jsonResponse(response, 400, { error: "Invalid Slack app ID" });
      installation = { apiAppId, appToken: String(payload.appToken), botToken: String(payload.botToken), teamId: String(auth.team_id), workspaceName: String(auth.team), botUserId: String(auth.user_id), allowedChannels: payload.allowedChannels.map(String).slice(0, 100), allowedUsers };
      saveConfig(installation); if (socket) socket.close(); void connectSocket();
      return jsonResponse(response, 200, { configured: true, teamId: installation.teamId, workspaceName: installation.workspaceName, botUserId: installation.botUserId });
    } catch (error) { return jsonResponse(response, 502, { error: String(error.message).slice(0, 180) }); }
  }
  return jsonResponse(response, 404, { error: "Not found" });
});

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  installation = loadConfig();
  // Explicit deployment configuration is required; importing the worker in a
  // test or leaving reports disabled does not create persistent state.
  if (process.env.MANAGERAI_REPORT_INBOX) reportInbox = new ReportInbox(process.env.MANAGERAI_REPORT_INBOX);
  setInterval(async () => {
    if (reportDrainActive) return;
    reportDrainActive = true;
    try { if (reportInbox) { await drainReportInbox(reportInbox, bridge, 10, async (request) => {
      if (installation?.teamId === request.source.teamId) await slackApi("chat.postEphemeral", installation.botToken, { channel: request.source.channelId, user: request.source.userId, text: "This report request was not authorized. Ask the workspace owner to check report-only access and channel policy." });
    }); await bridge({ action: "report.reconcile" }); await pollReportDelivery(); } }
    catch { state.lastErrorCode = "report_bridge_unavailable"; }
    finally { reportDrainActive = false; }
  }, 5000).unref();
  server.listen(port, host, () => { void connectSocket(); });
  setInterval(() => void pollRuns(), 15_000).unref();
}
