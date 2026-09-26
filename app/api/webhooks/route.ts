import { env } from "cloudflare:workers";
import { requireOwnerApi, runtimeEnv, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const values = runtimeEnv();
  const database = (env as unknown as DatabaseEnv).DB;
  const events = await database.prepare("SELECT e.*,s.name AS sourceName,t.title AS ticketTitle FROM webhook_events e LEFT JOIN webhook_sources s ON s.id=e.source_id LEFT JOIN tickets t ON t.id=e.ticket_id ORDER BY e.received_at DESC LIMIT 200").all();
  const sources = await database.prepare("SELECT id,name,source_type,status,allowed_event_types,allowed_agent_ids,rate_limit_per_minute,last_received_at,created_at,updated_at FROM webhook_sources ORDER BY name").all();
  let gateway: Record<string, unknown> = { configured: false, reachable: false, counts: {}, events: [] };
  if (values.MANAGERAI_INTAKE_STATUS_URL && values.MANAGERAI_INTAKE_STATUS_TOKEN) {
    gateway = { configured: true, reachable: false, counts: {}, events: [] };
    try {
      const response = await fetch(values.MANAGERAI_INTAKE_STATUS_URL, { headers: { authorization: `Bearer ${values.MANAGERAI_INTAKE_STATUS_TOKEN}` }, signal: AbortSignal.timeout(5000) });
      if (response.ok) gateway = { configured: true, reachable: true, ...await response.json() as Record<string, unknown> };
      else gateway = { ...gateway, errorCode: `http_${response.status}` };
    } catch { gateway = { ...gateway, errorCode: "gateway_unreachable" }; }
  }
  return secureJson({ gateway, sources: sources.results, events: events.results });
}
