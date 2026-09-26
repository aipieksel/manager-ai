import { env } from "cloudflare:workers";
import { boundedText, nullableText } from "../../operations";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const database = (env as unknown as DatabaseEnv).DB;
  const rows = await database.prepare("SELECT id,kind,display_name,role_title,timezone,availability,status FROM identities WHERE status='active' ORDER BY display_name").all();
  return secureJson({ identities: rows.results });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const displayName = boundedText(payload.displayName, 160);
  const agentId = boundedText(payload.agentId, 180);
  const kind = agentId ? "agent" : ["person", "agent", "virtual_assistant"].includes(String(payload.kind)) ? String(payload.kind) : "person";
  if (!displayName) return secureJson({ error: "Display name is required" }, { status: 400 });
  const id = safeId("idn"); const now = Date.now();
  const database = (env as unknown as DatabaseEnv).DB;
  if (agentId && !await database.prepare("SELECT id FROM agents WHERE id=? AND archived_at IS NULL").bind(agentId).first()) return secureJson({ error: "Agent not found" }, { status: 404 });
  await database.batch([
    database.prepare("INSERT INTO identities (id,kind,display_name,email,role_title,timezone,availability,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'unknown','active',?,?,?)").bind(id, kind, displayName, nullableText(payload.email, 320), nullableText(payload.roleTitle, 200), boundedText(payload.timezone, 80, "Africa/Johannesburg"), owner.email, now, now),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created identity','identity',?,'allowed','{}',?)").bind(safeId("aud"), owner.email, id, now),
    ...(agentId ? [database.prepare("UPDATE agents SET owner_identity_id=?,updated_at=? WHERE id=?").bind(id, now, agentId)] : []),
  ]);
  return secureJson({ identity: { id, kind, displayName } }, { status: 201 });
}
