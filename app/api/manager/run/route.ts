import { env } from "cloudflare:workers";
import { boundedText, jsonObject } from "../../../operations";
import { requireOwnerApi, requireSameOrigin, runtimeEnv, safeId, secureJson } from "../../../server-security";
import { getRunnerConfiguration } from "../../../setup-server";

type DatabaseEnv = { DB: D1Database };

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const { MANAGER_RUNTIME_URL: dedicatedEndpoint, MANAGER_RUNTIME_TOKEN: dedicatedToken } = runtimeEnv();
  const runner = await getRunnerConfiguration();
  const useDedicatedRuntime = Boolean(dedicatedEndpoint && dedicatedToken);
  const endpoint = useDedicatedRuntime ? (dedicatedEndpoint ?? "") : runner.url ? new URL("/v1/manager/jobs", runner.url).toString() : "";
  const token = useDedicatedRuntime ? (dedicatedToken ?? "") : runner.token;
  if (!endpoint || !token) return secureJson({ error: "Manager runtime is not configured" }, { status: 503 });
  let configuredUrl: URL;
  try { configuredUrl = new URL(endpoint); } catch { return secureJson({ error: "Manager runtime URL is invalid" }, { status: 503 }); }
  if (configuredUrl.protocol !== "https:") return secureJson({ error: "Manager runtime must use HTTPS" }, { status: 503 });
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const ticketId = boundedText(payload.ticketId, 180);
  const projectId = boundedText(payload.projectId, 180);
  if (!ticketId && !projectId) return secureJson({ error: "ticketId or projectId is required" }, { status: 400 });

  const database = (env as unknown as DatabaseEnv).DB;
  const ticket = ticketId ? await database.prepare(
    "SELECT id, title, details, priority, status, assignee, source FROM tickets WHERE id = ?",
  ).bind(ticketId).first<{ id: string; title: string; details: string; priority: string; status: string; assignee: string; source: string }>() : null;
  if (ticketId && !ticket) return secureJson({ error: "Ticket not found" }, { status: 404 });
  const project = projectId ? await database.prepare("SELECT id,name,description,objective,success_definition AS successDefinition,status FROM projects WHERE id=? AND archived_at IS NULL").bind(projectId).first<Record<string, unknown>>() : null;
  if (projectId && !project) return secureJson({ error: "Project not found" }, { status: 404 });
  const requestedAgent = boundedText(payload.agentId, 180);
  const agent = await database.prepare(`SELECT a.id,a.name,a.slug,a.lifecycle_status AS lifecycleStatus,a.current_version_id AS currentVersionId,
    v.version_number AS versionNumber,v.role,v.objective,v.success_definition AS successDefinition,v.system_instructions AS systemInstructions,
    v.boundary_instructions AS boundaryInstructions,v.output_schema_name AS outputSchemaName,v.output_schema_version AS outputSchemaVersion,
    v.model_name AS modelName,v.reasoning_effort AS reasoningEffort,v.sandbox_mode AS sandboxMode,v.timeout_seconds AS timeoutSeconds,
    v.max_input_chars AS maxInputChars,v.workspace_ref AS workspaceRef
    FROM agents a JOIN agent_versions v ON v.id=a.current_version_id
    WHERE ${requestedAgent ? "a.id=?" : "a.slug='manager'"}`).bind(...(requestedAgent ? [requestedAgent] : [])).first<Record<string, unknown>>();
  if (!agent || agent.lifecycleStatus !== "active") return secureJson({ error: "Selected agent is not active" }, { status: 409 });
  const activeRuns = await database.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE agent_id=? AND status IN ('queued','running','waiting_for_approval')").bind(agent.id).first<{ count: number }>();
  if (Number(activeRuns?.count ?? 0) >= Number(agent.maxConcurrency ?? 1)) return secureJson({ error: "Agent is at capacity" }, { status: 429 });

  const now = Date.now();
  const runId = safeId("run");
  const input = { ticket, project, instruction: boundedText(payload.instruction, 10_000, "Validate and triage this work. Gather read-only evidence first. Return a proposed plan and request approval before any consequential action.") };
  await database.batch([
    database.prepare("INSERT INTO agent_runs (id,agent_id,agent_version_id,project_id,ticket_id,trigger_type,trigger_ref,input_snapshot,runner_job_id,idempotency_key,status,attempt_number,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,'manual',?,?,?,?,'queued',1,?,?,?)").bind(runId, agent.id, agent.currentVersionId, projectId || null, ticketId || null, ticketId || projectId, jsonObject(input), runId, `manual:${runId}`, owner.email, now, now),
    database.prepare("INSERT INTO agent_run_events (id,run_id,sequence,event_type,stage,message,occurred_at,received_at) VALUES (?,?,1,'queued','dispatch','Run queued by owner',?,?)").bind(safeId("rue"), runId, now, now),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Queued agent run','agent_run',?,'queued',?,?)").bind(safeId("aud"), owner.email, runId, JSON.stringify({ agentId: agent.id, ticketId: ticketId || null, projectId: projectId || null }), now),
  ]);
  const response = await fetch(configuredUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-command-center-user": owner.email }, body: JSON.stringify({ runId, agent, input, requestedBy: owner.email }), signal: AbortSignal.timeout(30_000) });
  const resultText = await response.text();
  const result = resultText.length > 100_000 ? resultText.slice(0, 100_000) : resultText;
  if (!response.ok) {
    await database.prepare("UPDATE agent_runs SET status='failed',failure_code='runner_rejected',failure_message=?,completed_at=?,updated_at=? WHERE id=?").bind(`Runner rejected dispatch with HTTP ${response.status}`, Date.now(), Date.now(), runId).run();
    return secureJson({ error: "Manager runtime rejected the request", status: response.status, runId }, { status: 502 });
  }
  await database.batch([
    database.prepare("UPDATE agent_runs SET status='running',started_at=?,heartbeat_at=?,updated_at=? WHERE id=?").bind(Date.now(), Date.now(), Date.now(), runId),
    ...(ticketId ? [database.prepare("UPDATE tickets SET status = 'running', updated_at = ? WHERE id = ?").bind(Date.now(), ticketId)] : []),
    database.prepare("INSERT INTO audit_events (id, actor, action, object_type, object_id, result, metadata, occurred_at) VALUES (?, ?, 'Dispatched to manager runtime', 'agent_run', ?, 'accepted', ?, ?)").bind(safeId("aud"), owner.email, runId, JSON.stringify({ ticketId: ticketId || null, projectId: projectId || null }), Date.now()),
  ]);
  return secureJson({ accepted: true, runId, result }, { status: 202 });
}
