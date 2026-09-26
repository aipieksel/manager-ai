import { env } from "cloudflare:workers";
import { requireOwnerApi, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;

  const database = (env as unknown as DatabaseEnv).DB;
  const rows = await database.prepare(
    "SELECT id, actor, action, object_type AS objectType, object_id AS objectId, result, occurred_at AS occurredAt FROM audit_events ORDER BY occurred_at DESC LIMIT 100",
  ).all();

  return secureJson({ events: rows.results });
}
