import { env } from "cloudflare:workers";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;

  const database = (env as unknown as DatabaseEnv).DB;
  const rows = await database.prepare(
    "SELECT id, title, details, source, priority, status, assignee, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM tickets ORDER BY created_at DESC LIMIT 100",
  ).all();
  return secureJson({ tickets: rows.results });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;

  let payload: { title?: string; details?: string; priority?: string; assignee?: string };
  try { payload = await request.json(); } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }

  const title = payload.title?.trim().slice(0, 240) ?? "";
  const details = payload.details?.trim().slice(0, 20_000) ?? "";
  const priority = ["critical", "high", "normal", "low"].includes(payload.priority?.toLowerCase() ?? "") ? payload.priority!.toLowerCase() : "normal";
  const assignee = payload.assignee?.trim().slice(0, 80) || "Manager";
  if (!title) return secureJson({ error: "title is required" }, { status: 400 });

  const database = (env as unknown as DatabaseEnv).DB;
  const id = safeId("tkt");
  const auditId = safeId("aud");
  const now = Date.now();
  await database.batch([
    database.prepare("INSERT INTO tickets (id, title, details, source, priority, status, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, 'manual.intake', ?, 'new', ?, ?, ?, ?)").bind(id, title, details, priority, assignee, owner.email, now, now),
    database.prepare("INSERT INTO audit_events (id, actor, action, object_type, object_id, result, metadata, occurred_at) VALUES (?, ?, 'Created issue', 'ticket', ?, 'allowed', '{}', ?)").bind(auditId, owner.email, id, now),
  ]);
  return secureJson({ ticket: { id, title, details, source: "manual.intake", priority, status: "new", assignee, createdAt: now } }, { status: 201 });
}
