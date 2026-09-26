import { env } from "cloudflare:workers";
import { boundedText } from "../../../operations";
import { dispatchProjectMessage } from "../../../project-message-dispatch";
import { runtimeEnv, safeId, secureJson } from "../../../server-security";
import { NOTIFICATION_EVENT_TYPE, parseNotificationTriggeredEvent, parseSocialPostEvent, postAssistantNotification, renderSocialNotification, renderTriggeredNotification, routeAllowsPlatform, routeAllowsTriggeredEvent, SOCIAL_EVENT_TYPE, type SlackNotificationRoute } from "../../../slack-notifications";

type DatabaseEnv = { DB: D1Database };
const BOT_MESSAGE_EVENT_TYPE = "notification.message";

function bytesToHex(bytes: ArrayBuffer) { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function timingSafeEqual(left: string, right: string) { if (left.length !== right.length) return false; let mismatch = 0; for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i); return mismatch === 0; }

async function deliverAssistantEvent(input: {
  database: D1Database;
  idempotencyKey: string;
  agentId: string;
  sourceId: string | null;
  eventType: string;
  payloadHash: string;
  payloadSize: number;
  eventId: string;
  principal: string;
  route: SlackNotificationRoute;
  notification: string;
  deliveryKey: string;
  auditAction: string;
  auditMetadata: Record<string, unknown>;
  responseMetadata: Record<string, unknown>;
}) {
  const { database, idempotencyKey, agentId, sourceId, eventType, payloadHash, payloadSize, principal, route } = input;
  const now = Date.now();
  const existing = await database.prepare("SELECT id,delivery_status AS deliveryStatus,delivery_attempts AS deliveryAttempts FROM webhook_events WHERE idempotency_key=?").bind(idempotencyKey).first<{ id: string; deliveryStatus: string; deliveryAttempts: number }>();
  if (existing?.deliveryStatus === "delivered") return secureJson({ accepted: true, duplicate: true, eventId: existing.id }, { status: 202 });
  const notificationEventId = existing?.id || input.eventId;
  if (!existing) {
    await database.prepare("INSERT INTO webhook_events (id,idempotency_key,agent_id,source_id,event_type,signature_status,payload_hash,payload_size,received_at,normalized_at,delivery_status,delivery_attempts) VALUES (?,?,?,?,?,'verified',?,?,?,?,'pending',0)").bind(notificationEventId, idempotencyKey, agentId, sourceId, eventType, payloadHash, payloadSize, now, now).run();
  }
  const claim = await database.prepare("UPDATE webhook_events SET delivery_status='delivering' WHERE id=? AND delivery_status IN ('pending','retrying')").bind(notificationEventId).run();
  if (!claim.meta.changes) {
    const current = await database.prepare("SELECT delivery_status AS deliveryStatus FROM webhook_events WHERE id=?").bind(notificationEventId).first<{ deliveryStatus: string }>();
    return secureJson({ accepted: true, duplicate: true, inProgress: current?.deliveryStatus !== "delivered", eventId: notificationEventId }, { status: 202 });
  }
  const delivery = await postAssistantNotification(route.slack_channel_id, input.notification, input.deliveryKey);
  const attempt = Number(existing?.deliveryAttempts || 0) + 1;
  if (!delivery.ok) {
    await database.batch([
      database.prepare("UPDATE webhook_events SET delivery_status='retrying',delivery_attempts=?,last_error_code=? WHERE id=?").bind(attempt, delivery.error, notificationEventId),
      database.prepare("INSERT INTO webhook_delivery_attempts (id,webhook_event_id,attempt_number,started_at,completed_at,http_status,result,error_code) VALUES (?,?,?,?,?,?,?,?)").bind(safeId("wha"), notificationEventId, attempt, now, Date.now(), delivery.status, "retrying", delivery.error),
    ]);
    return secureJson({ error: delivery.error, eventId: notificationEventId }, { status: delivery.status });
  }
  await database.batch([
    database.prepare("UPDATE webhook_events SET delivery_status='delivered',delivery_attempts=?,delivered_at=?,last_error_code=NULL WHERE id=?").bind(attempt, Date.now(), notificationEventId),
    database.prepare("INSERT INTO webhook_delivery_attempts (id,webhook_event_id,attempt_number,started_at,completed_at,http_status,result) VALUES (?,?,?,?,?,202,'slack_posted')").bind(safeId("wha"), notificationEventId, attempt, now, Date.now()),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,?,?,?,'delivered',?,?)").bind(safeId("aud"), principal, input.auditAction, "webhook_event", notificationEventId, JSON.stringify({ ...input.auditMetadata, routeId: route.id, channelId: route.slack_channel_id, slackTs: delivery.slackTs || null }), Date.now()),
  ]);
  return secureJson({ accepted: true, eventId: notificationEventId, notified: "assistant", ...input.responseMetadata }, { status: 202 });
}

export async function POST(request: Request) {
  const secret = runtimeEnv().AGENT_WEBHOOK_SECRET;
  if (!secret) return secureJson({ error: "Webhook intake is not configured" }, { status: 503 });
  const agentId = request.headers.get("x-agent-id")?.trim().slice(0, 120) ?? "";
  const timestamp = request.headers.get("x-timestamp") ?? "";
  const provided = request.headers.get("x-signature")?.replace(/^sha256=/, "").toLowerCase() ?? "";
  const unixSeconds = Number(timestamp);
  if (!agentId || !Number.isFinite(unixSeconds) || Math.abs(Date.now() / 1000 - unixSeconds) > 300) return secureJson({ error: "Invalid or expired signature metadata" }, { status: 401 });
  const rawBody = await request.text();
  if (rawBody.length > 100_000) return secureJson({ error: "Payload too large" }, { status: 413 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  if (!timingSafeEqual(expected, provided)) return secureJson({ error: "Signature verification failed" }, { status: 401 });

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody) as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const idempotencyKey = boundedText(payload.idempotency_key, 180);
  const eventType = boundedText(payload.type, 120);
  if (!idempotencyKey || !["issue.created", "agent.message", SOCIAL_EVENT_TYPE, NOTIFICATION_EVENT_TYPE, BOT_MESSAGE_EVENT_TYPE].includes(eventType)) return secureJson({ error: "Supported type and idempotency_key are required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const hash = bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)));
  const now = Date.now();
  const eventId = safeId("evt");
  const sourceId = request.headers.get("x-managerai-source-id")?.trim().slice(0, 180) || null;

  if (eventType === BOT_MESSAGE_EVENT_TYPE) {
    const principal = boundedText(payload.principal, 120);
    const authority = Array.isArray(payload.authority) ? payload.authority.map((value) => boundedText(value, 40)).filter(Boolean) : [];
    const notification = boundedText(payload.message, 3500);
    if (principal !== agentId || authority.length !== 1 || authority[0] !== "notify" || !notification) return secureJson({ error: "Authenticated bot message is incomplete or unsafe" }, { status: 400 });
    const channel = await database.prepare("SELECT channel_id FROM slack_channel_rules WHERE allowed=1 ORDER BY created_at LIMIT 1").first<{ channel_id: string }>();
    if (!channel) return secureJson({ error: "No allowed Assistant Slack channel is configured" }, { status: 409 });
    const route = { id: "bot-handle", principal_id: principal, display_name: "Bot handle", event_type: BOT_MESSAGE_EVENT_TYPE, trigger_key: "bot_message", event_family: "bot", description: "", slack_channel_id: channel.channel_id, allowed_platforms: "[]", variable_names: "[]", message_template: "{message}", enabled: 1 } satisfies SlackNotificationRoute;
    return deliverAssistantEvent({
      database, idempotencyKey, agentId, sourceId, eventType, payloadHash: hash, payloadSize: rawBody.length,
      eventId, principal, route, notification,
      deliveryKey: `${principal}:${idempotencyKey}`,
      auditAction: "Assistant posted bot-handle message",
      auditMetadata: {},
      responseMetadata: {},
    });
  }

  if (eventType === NOTIFICATION_EVENT_TYPE) {
    const principal = boundedText(payload.principal, 120);
    const authority = Array.isArray(payload.authority) ? [...new Set(payload.authority.map((value) => boundedText(value, 40)).filter(Boolean))].slice(0, 8) : [];
    const notificationEvent = principal === agentId && authority.length === 1 && authority[0] === "notify" ? parseNotificationTriggeredEvent(payload, principal) : null;
    if (!notificationEvent) return secureJson({ error: "Authenticated trigger notification is incomplete or unsafe" }, { status: 400 });
    const route = await database.prepare("SELECT * FROM slack_notification_routes WHERE principal_id=? AND event_type=? AND trigger_key=? AND enabled=1").bind(principal, NOTIFICATION_EVENT_TYPE, notificationEvent.triggerKey).first<SlackNotificationRoute>();
    if (!route) return secureJson({ error: "Unknown or disabled Assistant trigger for this principal" }, { status: 403 });
    if (!routeAllowsTriggeredEvent(route, notificationEvent)) return secureJson({ error: "This Assistant trigger does not permit the declared platform scope" }, { status: 403 });
    const notification = renderTriggeredNotification(route, notificationEvent);
    if (!notification) return secureJson({ error: "Variables must exactly match the contract's declared message variables" }, { status: 400 });
    return deliverAssistantEvent({
      database, idempotencyKey, agentId, sourceId, eventType, payloadHash: hash, payloadSize: rawBody.length,
      eventId, principal, route, notification,
      deliveryKey: `${principal}:${notificationEvent.triggerKey}:${idempotencyKey}`,
      auditAction: "Assistant posted trigger notification",
      auditMetadata: { triggerKey: notificationEvent.triggerKey, platforms: notificationEvent.platforms },
      responseMetadata: { trigger: notificationEvent.triggerKey },
    });
  }

  if (eventType === SOCIAL_EVENT_TYPE) {
    const principal = boundedText(payload.principal, 120);
    const authority = Array.isArray(payload.authority) ? [...new Set(payload.authority.map((value) => boundedText(value, 40)).filter(Boolean))].slice(0, 8) : [];
    const socialEvent = principal === agentId && authority.length === 1 && authority[0] === "notify" ? parseSocialPostEvent(payload, principal) : null;
    if (!socialEvent) return secureJson({ error: "Authenticated social completion event is incomplete" }, { status: 400 });
    const routes = await database.prepare("SELECT * FROM slack_notification_routes WHERE principal_id=? AND event_type=? AND enabled=1 ORDER BY updated_at DESC").bind(principal, SOCIAL_EVENT_TYPE).all<SlackNotificationRoute>();
    const route = routes.results.find((candidate) => routeAllowsPlatform(candidate, socialEvent.platform));
    if (!route || !routeAllowsPlatform(route, socialEvent.platform)) return secureJson({ error: "No enabled Assistant notification route permits this principal and platform" }, { status: 403 });
    const notification = renderSocialNotification(route, socialEvent);
    return deliverAssistantEvent({
      database, idempotencyKey, agentId, sourceId, eventType, payloadHash: hash, payloadSize: rawBody.length,
      eventId, principal, route, notification,
      deliveryKey: `${principal}:${idempotencyKey}`,
      auditAction: "Assistant posted social completion notification",
      auditMetadata: { platform: socialEvent.platform },
      responseMetadata: { platform: socialEvent.platform },
    });
  }

  const eventInsert = await database.prepare("INSERT OR IGNORE INTO webhook_events (id,idempotency_key,agent_id,source_id,event_type,signature_status,payload_hash,payload_size,received_at,normalized_at,delivery_status,delivery_attempts,delivered_at) VALUES (?,?,?,?,?,'verified',?,?,?,?,'delivered',1,?)").bind(eventId, idempotencyKey, agentId, sourceId, eventType, hash, rawBody.length, now, now, now).run();
  if (!eventInsert.meta.changes) return secureJson({ accepted: true, duplicate: true }, { status: 202 });

  if (eventType === "agent.message") {
    const projectSlug = boundedText(payload.project, 120);
    const message = boundedText(payload.message, 20_000);
    const principal = boundedText(payload.principal, 120);
    const authority = Array.isArray(payload.authority) ? [...new Set(payload.authority.map((value) => boundedText(value, 40)).filter(Boolean))].slice(0, 8) : [];
    if (!projectSlug || !message || principal !== agentId || !authority.length) {
      await database.prepare("DELETE FROM webhook_events WHERE id=?").bind(eventId).run();
      return secureJson({ error: "Authenticated project message is incomplete" }, { status: 400 });
    }
    const result = await dispatchProjectMessage({
      database,
      projectSlug,
      requestedConversationId: boundedText(payload.conversation_id, 180),
      forceNewConversation: !boundedText(payload.conversation_id, 180),
      body: message,
      actorRef: principal,
      authorType: "external",
      sourceType: "authenticated_agent_contact",
      authority,
      idempotencyKey: `contact:${idempotencyKey}`,
    });
    await database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Accepted authenticated agent contact','webhook_event',?,?,?,?)").bind(safeId("aud"), principal, eventId, result.ok ? "queued" : "failed", JSON.stringify({ projectSlug, authority, runId: result.runId || null }), now).run();
    if (!result.ok && !result.persisted) {
      await database.prepare("DELETE FROM webhook_events WHERE id=?").bind(eventId).run();
      return secureJson({ error: result.error }, { status: result.status });
    }
    return secureJson({ accepted: true, project: projectSlug, conversationId: result.conversationId, messageId: result.messageId, runId: result.runId, dispatchStatus: result.ok ? result.runStatus : "failed" }, { status: 202 });
  }

  const title = boundedText(payload.title, 240);
  if (!title) {
    await database.prepare("DELETE FROM webhook_events WHERE id=?").bind(eventId).run();
    return secureJson({ error: "title is required" }, { status: 400 });
  }
  const ticketId = safeId("tkt");
  try {
    await database.batch([
      database.prepare("INSERT INTO tickets (id, title, details, source, priority, status, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'new', 'Manager', ?, ?, ?)").bind(ticketId, title, JSON.stringify(payload.details ?? {}), agentId, ["critical", "high", "normal", "low"].includes(String(payload.priority ?? "")) ? payload.priority : "normal", agentId, now, now),
      database.prepare("INSERT INTO audit_events (id, actor, action, object_type, object_id, result, metadata, occurred_at) VALUES (?, ?, 'Submitted signed webhook', 'ticket', ?, 'verified', ?, ?)").bind(safeId("aud"), agentId, ticketId, JSON.stringify({ eventType, payloadHash: hash }), now),
      database.prepare("UPDATE webhook_events SET ticket_id=? WHERE id=?").bind(ticketId, eventId),
      database.prepare("INSERT INTO webhook_delivery_attempts (id,webhook_event_id,attempt_number,started_at,completed_at,http_status,result) VALUES (?,?,1,?,?,202,'accepted')").bind(safeId("wha"), eventId, now, now),
    ]);
  } catch (error) {
    await database.prepare("DELETE FROM webhook_events WHERE idempotency_key = ? AND payload_hash = ?").bind(idempotencyKey, hash).run();
    throw error;
  }
  return secureJson({ accepted: true, ticketId }, { status: 202 });
}
