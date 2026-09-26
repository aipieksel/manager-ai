import { env } from "cloudflare:workers";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };
const actions = new Set(["approve_execution", "deny_execution", "pause_agent", "resume_agent", "update_ticket"]);

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: { action?: string; objectType?: string; objectId?: string; value?: string };
  try { payload = await request.json(); } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  if (!payload.action || !actions.has(payload.action)) return secureJson({ error: "Unsupported control action" }, { status: 400 });
  const objectType = payload.objectType?.trim().slice(0, 40) || "unknown";
  const objectId = payload.objectId?.trim().slice(0, 180) || "unknown";
  const now = Date.now();
  const database = (env as unknown as DatabaseEnv).DB;
  const statements = [database.prepare("INSERT INTO audit_events (id, actor, action, object_type, object_id, result, metadata, occurred_at) VALUES (?, ?, ?, ?, ?, 'allowed', ?, ?)").bind(safeId("aud"), owner.email, payload.action, objectType, objectId, JSON.stringify({ value: payload.value?.slice(0, 120) ?? null }), now)];
  if (payload.action === "update_ticket" && objectType === "ticket" && payload.value && ["new", "triaged", "running", "blocked", "resolved"].includes(payload.value)) {
    statements.unshift(database.prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?").bind(payload.value, now, objectId));
  }
  if ((payload.action === "approve_execution" || payload.action === "deny_execution") && objectType === "execution") {
    statements.unshift(database.prepare("UPDATE execution_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'").bind(payload.action === "approve_execution" ? "approved" : "denied", owner.email, now, objectId));
  }
  await database.batch(statements);
  return secureJson({ ok: true, recordedAt: now });
}
