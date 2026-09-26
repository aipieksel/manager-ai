import { env } from "cloudflare:workers";
import { boundedText } from "../../operations";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const database = (env as unknown as DatabaseEnv).DB;
  const rows = await database.prepare("SELECT e.*,a.name AS agentName,p.name AS projectName FROM execution_requests e LEFT JOIN agents a ON a.id=e.agent_id LEFT JOIN projects p ON p.id=e.project_id WHERE e.status='pending' ORDER BY e.created_at DESC LIMIT 200").all();
  return secureJson({ approvals: rows.results });
}

export async function PATCH(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const id = boundedText(payload.id, 180);
  const decision = payload.decision === "approved" ? "approved" : payload.decision === "denied" ? "denied" : "";
  if (!id || !decision) return secureJson({ error: "id and valid decision are required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const current = await database.prepare("SELECT * FROM execution_requests WHERE id=? AND status='pending'").bind(id).first<Record<string, unknown>>();
  if (!current) return secureJson({ error: "Pending approval not found" }, { status: 404 });
  if (current.expires_at && Number(current.expires_at) < Date.now()) return secureJson({ error: "Approval request expired" }, { status: 409 });
  const now = Date.now();
  await database.batch([
    database.prepare("UPDATE execution_requests SET status=?,decided_by=?,decision_note=?,decided_at=? WHERE id=? AND status='pending'").bind(decision, owner.email, boundedText(payload.decisionNote, 4000), now, id),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Decided approval','execution_request',?,?,?,?)").bind(safeId("aud"), owner.email, id, decision, JSON.stringify({ argumentsHash: current.arguments_hash ?? null }), now),
  ]);
  return secureJson({ ok: true, status: decision, decidedAt: now });
}
