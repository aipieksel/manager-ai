import { env } from "cloudflare:workers";
import { boundedText } from "../../operations";
import { publicHttpsUrl, requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../setup-server";

type DatabaseEnv = { DB: D1Database };

async function hashJson(value: unknown) {
  const encoded = JSON.stringify(value ?? {});
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function riskClass(name: string) {
  const lower = name.toLowerCase();
  if (/(delete|remove|destroy|publish|deploy|payment|purchase|execute)/.test(lower)) return "consequential";
  if (/(create|update|write|record|set|send|post)/.test(lower)) return "write";
  if (/(get|list|read|search|activity|audit|capabilit|has|inspect)/.test(lower)) return "read";
  return "unknown";
}

async function storeDiscovery(database: D1Database, connectionId: string, discovery: Record<string, unknown>, actor: string) {
  const now = Date.now();
  const tools = Array.isArray(discovery.tools) ? discovery.tools.slice(0, 500) as Array<Record<string, unknown>> : [];
  const statements: D1PreparedStatement[] = [
    database.prepare("UPDATE mcp_connections SET lifecycle_status='active',health_status='connected',protocol_version=?,server_name=?,server_version=?,last_checked_at=?,last_connected_at=?,last_error_code=NULL,updated_at=? WHERE id=?").bind(boundedText(discovery.protocolVersion, 80) || null, boundedText(discovery.serverName, 160) || null, boundedText(discovery.serverVersion, 80) || null, now, now, now, connectionId),
    database.prepare("UPDATE mcp_tools SET available=0 WHERE connection_id=?").bind(connectionId),
  ];
  for (const tool of tools) {
    const name = boundedText(tool.name, 180);
    if (!name) continue;
    const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
    statements.push(database.prepare("INSERT INTO mcp_tools (id,connection_id,tool_name,description,input_schema,schema_hash,risk_class,available,discovered_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,tool_name) DO UPDATE SET description=excluded.description,input_schema=excluded.input_schema,schema_hash=excluded.schema_hash,risk_class=excluded.risk_class,available=1,last_seen_at=excluded.last_seen_at").bind(safeId("mct"), connectionId, name, boundedText(tool.description, 4000), JSON.stringify(schema), await hashJson(schema), riskClass(name), 1, now, now));
  }
  statements.push(database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Discovered MCP tools','mcp_connection',?,'connected',?,?)").bind(safeId("aud"), actor, connectionId, JSON.stringify({ toolCount: tools.length }), now));
  await database.batch(statements);
  return tools.length;
}

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const database = (env as unknown as DatabaseEnv).DB;
  const connections = await database.prepare("SELECT c.*,(SELECT COUNT(*) FROM mcp_tools t WHERE t.connection_id=c.id AND t.available=1) AS toolCount,(SELECT COUNT(DISTINCT p.agent_version_id) FROM agent_mcp_permissions p JOIN mcp_tools t ON t.id=p.mcp_tool_id WHERE t.connection_id=c.id AND p.permission!='deny') AS agentCount FROM mcp_connections c ORDER BY c.name").all();
  const tools = await database.prepare("SELECT t.*,c.name AS connectionName,(SELECT COUNT(*) FROM agent_mcp_permissions p WHERE p.mcp_tool_id=t.id AND p.permission!='deny') AS allowedAgentCount FROM mcp_tools t JOIN mcp_connections c ON c.id=t.connection_id ORDER BY c.name,t.tool_name").all();
  return secureJson({ connections: connections.results, tools: tools.results });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const name = boundedText(payload.name, 160);
  const slug = boundedText(payload.slug, 100).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const origin = publicHttpsUrl(boundedText(payload.endpointOrigin, 2000));
  const path = boundedText(payload.endpointPath, 500, "/mcp");
  const credential = boundedText(payload.credential, 8000);
  const authType = payload.authType === "none" ? "none" : "bearer";
  if (!name || !slug || !origin || !path.startsWith("/") || path.includes("?") || path.includes("#") || (authType === "bearer" && !credential)) return secureJson({ error: "Name, slug, safe HTTPS endpoint and credential are required" }, { status: 400 });
  const { url, token, configured } = await getRunnerConfiguration();
  if (!configured || !url) return secureJson({ error: "Runner is not configured" }, { status: 503 });
  const connectionId = safeId("mcp");
  const endpoint = new URL(path, origin).toString();
  const runnerResponse = await runnerFetch(url, token, `/v1/mcp/connections/${connectionId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint, authType, credential }), signal: AbortSignal.timeout(30_000) });
  const discovery = await responseJson(runnerResponse);
  if (!runnerResponse.ok) return secureJson({ error: "MCP validation failed", details: discovery.errorCode ?? discovery.error }, { status: 502 });
  const database = (env as unknown as DatabaseEnv).DB;
  const now = Date.now();
  try {
    await database.prepare("INSERT INTO mcp_connections (id,name,slug,transport,endpoint_origin,endpoint_path,auth_type,secret_ref,lifecycle_status,health_status,created_by,created_at,updated_at) VALUES (?,?,?,'streamable_http',?,?,?,?, 'draft','unknown',?,?,?)").bind(connectionId, name, slug, origin.origin, path, authType, `runner:mcp:${connectionId}`, owner.email, now, now).run();
  } catch {
    return secureJson({ error: "MCP connection name or slug already exists" }, { status: 409 });
  }
  const toolCount = await storeDiscovery(database, connectionId, discovery, owner.email);
  return secureJson({ connection: { id: connectionId, name, slug, healthStatus: "connected", toolCount } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const connectionId = boundedText(payload.id, 180);
  const action = boundedText(payload.action, 40);
  if (!connectionId || action !== "validate") return secureJson({ error: "Unsupported MCP action" }, { status: 400 });
  const { url, token, configured } = await getRunnerConfiguration();
  if (!configured || !url) return secureJson({ error: "Runner is not configured" }, { status: 503 });
  const response = await runnerFetch(url, token, `/v1/mcp/connections/${connectionId}`, { signal: AbortSignal.timeout(30_000) });
  const discovery = await responseJson(response);
  const database = (env as unknown as DatabaseEnv).DB;
  if (!response.ok) {
    await database.prepare("UPDATE mcp_connections SET health_status='offline',last_checked_at=?,last_error_code=?,updated_at=? WHERE id=?").bind(Date.now(), boundedText(discovery.errorCode, 120, "validation_failed"), Date.now(), connectionId).run();
    return secureJson({ error: "MCP validation failed", details: discovery.errorCode ?? discovery.error }, { status: 502 });
  }
  const toolCount = await storeDiscovery(database, connectionId, discovery, owner.email);
  return secureJson({ ok: true, healthStatus: "connected", toolCount });
}
