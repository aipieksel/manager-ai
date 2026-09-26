import { env } from "cloudflare:workers";
import { boundedText } from "../../../operations";
import { requireOwnerApi, safeId, secureJson } from "../../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../../setup-server";

type DatabaseEnv = { DB: D1Database };
const ALLOWED_TOOLS = new Set(["list", "get", "search", "activity"]);

async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function contentJson(result: Record<string, unknown>) {
  const content = Array.isArray(result.content) ? result.content as Array<Record<string, unknown>> : [];
  const text = content.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (typeof text !== "string") return result;
  try { return JSON.parse(text) as unknown; } catch { return { text }; }
}

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId")?.slice(0, 180) ?? "";
  const action = url.searchParams.get("action")?.slice(0, 40) || "list";
  const recordId = url.searchParams.get("recordId")?.slice(0, 128) ?? "";
  const query = url.searchParams.get("query")?.slice(0, 500) ?? "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), action === "activity" ? 200 : 100);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
  if (!projectId || !ALLOWED_TOOLS.has(action)) return secureJson({ error: "Valid projectId and read action are required" }, { status: 400 });
  if (action === "get" && !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/.test(recordId)) return secureJson({ error: "Valid recordId is required" }, { status: 400 });
  if (action === "search" && !query.trim()) return secureJson({ error: "Search query is required" }, { status: 400 });
  const argumentsValue = action === "get" ? { id: recordId } : action === "search" ? { query, limit } : { limit, offset };
  const database = (env as unknown as DatabaseEnv).DB;
  const project = await database.prepare("SELECT id FROM projects WHERE id=? AND archived_at IS NULL").bind(projectId).first();
  if (!project) return secureJson({ error: "Project not found" }, { status: 404 });
  const tool = await database.prepare(`SELECT t.id AS toolId,t.connection_id AS connectionId,t.tool_name AS toolName,c.name AS connectionName
    FROM mcp_tools t JOIN mcp_connections c ON c.id=t.connection_id
    WHERE c.slug='grok-mcp-seo' AND c.lifecycle_status='active' AND t.tool_name=? AND t.available=1`).bind(action).first<Record<string, unknown>>();
  if (!tool) return secureJson({ error: "SEO MCP explorer connection is not configured" }, { status: 503 });
  const runner = await getRunnerConfiguration();
  if (!runner.configured || !runner.url) return secureJson({ error: "Runner is not configured" }, { status: 503 });
  const callId = safeId("mcc");
  const now = Date.now();
  const argsHash = await digest(argumentsValue);
  await database.prepare("INSERT INTO mcp_tool_calls (id,run_id,agent_version_id,connection_id,tool_id,arguments_redacted,arguments_hash,status,started_at) VALUES (?,'owner-explorer','system-owner-explorer',?,?,?,?,'running',?)").bind(callId, tool.connectionId, tool.toolId, JSON.stringify(action === "get" ? { id: recordId } : action === "search" ? { query: "[redacted]", limit } : argumentsValue), argsHash, now).run();
  let response: Response;
  try {
    response = await runnerFetch(runner.url, runner.token, "/v1/mcp/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentVersionId: "system-owner-explorer", connectionId: tool.connectionId, toolName: action, arguments: argumentsValue, approved: true }), signal: AbortSignal.timeout(30_000) });
  } catch {
    await database.prepare("UPDATE mcp_tool_calls SET status='failed',completed_at=?,error_code='runner_unreachable' WHERE id=?").bind(Date.now(), callId).run();
    return secureJson({ error: "MCP runner could not be reached" }, { status: 502 });
  }
  const body = await responseJson(response);
  if (!response.ok) {
    await database.prepare("UPDATE mcp_tool_calls SET status='failed',completed_at=?,error_code=? WHERE id=?").bind(Date.now(), boundedText(body.errorCode, 120, "mcp_call_failed"), callId).run();
    return secureJson({ error: "MCP explorer call failed", details: body.errorCode ?? body.error }, { status: 502 });
  }
  const result = body.result && typeof body.result === "object" ? body.result as Record<string, unknown> : {};
  const parsed = contentJson(result);
  const count = Array.isArray((parsed as { items?: unknown[] })?.items) ? (parsed as { items: unknown[] }).items.length : action === "get" ? 1 : 0;
  await database.batch([
    database.prepare("UPDATE mcp_tool_calls SET status='succeeded',completed_at=?,result_summary=? WHERE id=?").bind(Date.now(), `${action} returned ${count} item(s)`, callId),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Read SEO MCP workspace','mcp_tool_call',?,'succeeded',?,?)").bind(safeId("aud"), owner.email, callId, JSON.stringify({ projectId, action, count, connectionId: tool.connectionId }), Date.now()),
  ]);
  return secureJson({ action, result: parsed, callId, connection: tool.connectionName });
}
