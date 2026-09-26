import { env } from "cloudflare:workers";
import { boundedText } from "../../../operations";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../../setup-server";

type DatabaseEnv = { DB: D1Database };

async function hashArguments(value: Record<string, unknown>) {
  const encoded = JSON.stringify(value, Object.keys(value).sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function redactedShape(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key.slice(0, 120), Array.isArray(item) ? "array" : item === null ? "null" : typeof item])));
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const agentId = boundedText(payload.agentId, 180); const toolId = boundedText(payload.toolId, 180); const runId = boundedText(payload.runId, 180); const approvalId = boundedText(payload.approvalId, 180);
  const args = payload.arguments && typeof payload.arguments === "object" && !Array.isArray(payload.arguments) ? payload.arguments as Record<string, unknown> : {};
  if (!agentId || !toolId || !runId || JSON.stringify(args).length > 100_000) return secureJson({ error: "agentId, toolId, runId, and arguments under 100 KB are required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const policy = await database.prepare(`SELECT a.current_version_id AS agentVersionId,a.name AS agentName,t.connection_id AS connectionId,t.tool_name AS toolName,t.risk_class AS riskClass,p.permission FROM agents a JOIN agent_mcp_permissions p ON p.agent_version_id=a.current_version_id JOIN mcp_tools t ON t.id=p.mcp_tool_id WHERE a.id=? AND t.id=? AND a.lifecycle_status='active' AND t.available=1`).bind(agentId, toolId).first<Record<string, unknown>>();
  if (!policy || policy.permission === "deny") return secureJson({ error: "Tool is denied or unavailable for this agent" }, { status: 403 });
  if (!await database.prepare("SELECT id FROM agent_runs WHERE id=? AND agent_id=?").bind(runId, agentId).first()) return secureJson({ error: "Run does not belong to this agent" }, { status: 409 });
  const argumentsHash = await hashArguments(args); const now = Date.now(); const callId = safeId("mcc");
  if (policy.permission === "allow_with_approval" && !approvalId) {
    const requestId = safeId("apr");
    await database.batch([
      database.prepare("INSERT INTO execution_requests (id,ticket_id,run_id,agent_id,agent_version_id,requested_by,action,action_class,tool_connection_id,tool_name,arguments_summary,arguments_hash,risk,reason,status,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)").bind(requestId, runId, runId, agentId, policy.agentVersionId, owner.email, `Call ${String(policy.toolName)}`, "mcp_tool_call", policy.connectionId, policy.toolName, redactedShape(args), argumentsHash, policy.riskClass || "consequential", "Agent MCP policy requires explicit owner approval", now + 30 * 60_000, now),
      database.prepare("INSERT INTO mcp_tool_calls (id,run_id,agent_version_id,connection_id,tool_id,arguments_redacted,arguments_hash,approval_request_id,status) VALUES (?,?,?,?,?,?,?,?, 'waiting_for_approval')").bind(callId, runId, policy.agentVersionId, policy.connectionId, toolId, redactedShape(args), argumentsHash, requestId),
      database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Requested MCP approval','mcp_tool_call',?,'pending',?,?)").bind(safeId("aud"), owner.email, callId, JSON.stringify({ requestId, toolName: policy.toolName }), now),
    ]);
    return secureJson({ approvalRequired: true, approvalId: requestId, callId, expiresAt: now + 30 * 60_000 }, { status: 202 });
  }
  if (policy.permission === "allow_with_approval") {
    const approval = await database.prepare("SELECT * FROM execution_requests WHERE id=? AND status='approved' AND agent_id=? AND agent_version_id=? AND tool_connection_id=? AND tool_name=? AND arguments_hash=? AND consumed_at IS NULL").bind(approvalId, agentId, policy.agentVersionId, policy.connectionId, policy.toolName, argumentsHash).first<Record<string, unknown>>();
    if (!approval || (approval.expires_at && Number(approval.expires_at) < now)) return secureJson({ error: "A current, matching, unconsumed approval is required" }, { status: 403 });
  }
  const existing = approvalId ? await database.prepare("SELECT id FROM mcp_tool_calls WHERE approval_request_id=? AND arguments_hash=?").bind(approvalId, argumentsHash).first<{ id: string }>() : null;
  const persistedCallId = existing?.id || callId;
  if (!existing) await database.prepare("INSERT INTO mcp_tool_calls (id,run_id,agent_version_id,connection_id,tool_id,arguments_redacted,arguments_hash,approval_request_id,status,started_at) VALUES (?,?,?,?,?,?,?,?, 'running',?)").bind(persistedCallId, runId, policy.agentVersionId, policy.connectionId, toolId, redactedShape(args), argumentsHash, approvalId || null, now).run();
  else await database.prepare("UPDATE mcp_tool_calls SET status='running',started_at=? WHERE id=?").bind(now, persistedCallId).run();
  const runner = await getRunnerConfiguration();
  if (!runner.configured || !runner.url) return secureJson({ error: "Runner is not configured" }, { status: 503 });
  const response = await runnerFetch(runner.url, runner.token, "/v1/mcp/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentVersionId: policy.agentVersionId, connectionId: policy.connectionId, toolName: policy.toolName, arguments: args, approved: policy.permission === "allow_with_approval" }), signal: AbortSignal.timeout(60_000) });
  const result = await responseJson(response); const completedAt = Date.now();
  await database.batch([
    database.prepare("UPDATE mcp_tool_calls SET status=?,completed_at=?,result_summary=?,error_code=? WHERE id=?").bind(response.ok ? "succeeded" : "failed", completedAt, response.ok ? "Tool call completed" : null, response.ok ? null : boundedText(result.errorCode ?? result.error, 160, "tool_call_failed"), persistedCallId),
    ...(approvalId ? [database.prepare("UPDATE execution_requests SET consumed_at=? WHERE id=? AND consumed_at IS NULL").bind(completedAt, approvalId)] : []),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Executed MCP tool','mcp_tool_call',?,?,?,?)").bind(safeId("aud"), owner.email, persistedCallId, response.ok ? "allowed" : "failed", JSON.stringify({ toolName: policy.toolName, approvalId: approvalId || null }), completedAt),
  ]);
  return secureJson(response.ok ? { ok: true, callId: persistedCallId, result: result.result } : { error: "MCP tool call failed", callId: persistedCallId }, { status: response.ok ? 200 : 502 });
}
