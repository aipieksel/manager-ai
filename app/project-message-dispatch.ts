import { boundedText } from "./operations";
import { runtimeEnv, safeId } from "./server-security";

type DispatchInput = {
  database: D1Database;
  projectId?: string;
  projectSlug?: string;
  requestedConversationId?: string;
  taskId?: string;
  forceNewConversation?: boolean;
  body: string;
  actorRef: string;
  authorType: "owner" | "external";
  sourceType: "owner_chat" | "authenticated_agent_contact" | "slack_mention";
  authority: string[];
  idempotencyKey?: string;
};

type DispatchFailure = { ok: false; status: number; error: string; persisted: boolean; conversationId?: string; messageId?: string; runId?: string };
type DispatchSuccess = { ok: true; status: 202; conversationId: string; messageId: string; runId: string; runStatus: "running" };
export type ProjectMessageDispatchResult = DispatchFailure | DispatchSuccess;

function runtimeConfiguration() {
  const value = runtimeEnv();
  const endpoint = value.PROJECT_AGENT_RUNTIME_URL?.trim() ?? "";
  const token = value.PROJECT_AGENT_RUNTIME_TOKEN?.trim() ?? "";
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/v1/project-agent/jobs") return null;
    if (token.length < 32) return null;
    return { endpoint: url.toString(), token };
  } catch { return null; }
}

export function projectRuntimeConfigured() { return Boolean(runtimeConfiguration()); }

export async function dispatchProjectMessage(input: DispatchInput): Promise<ProjectMessageDispatchResult> {
  const runtime = runtimeConfiguration();
  if (!runtime) return { ok: false, status: 503, error: "Project agent runtime is not configured", persisted: false };
  const body = boundedText(input.body, 20_000);
  const actorRef = boundedText(input.actorRef, 180);
  if (!body || !actorRef || (!input.projectId && !input.projectSlug)) return { ok: false, status: 400, error: "Project and message are required", persisted: false };

  const selector = input.projectId ? "p.id" : "p.slug";
  const projectAgent = await input.database.prepare(`SELECT p.id AS projectId,p.name AS projectName,p.slug AS projectSlug,p.default_agent_id AS agentId,
    w.checkout_path AS checkoutPath,w.runtime_status AS runtimeStatus,a.lifecycle_status AS lifecycleStatus,
    v.id AS agentVersionId,v.system_instructions AS systemInstructions,v.boundary_instructions AS boundaryInstructions,
    v.sandbox_mode AS sandboxMode,v.model_name AS modelName,v.reasoning_effort AS reasoningEffort,v.timeout_seconds AS timeoutSeconds
    FROM projects p JOIN project_workspaces w ON w.project_id=p.id JOIN agents a ON a.id=p.default_agent_id
    JOIN agent_versions v ON v.id=a.current_version_id WHERE ${selector}=? AND p.archived_at IS NULL`).bind(input.projectId || input.projectSlug).first<Record<string, unknown>>();
  if (!projectAgent) return { ok: false, status: 409, error: "Project workspace or default agent is not registered", persisted: false };
  if (projectAgent.lifecycleStatus !== "active" || projectAgent.runtimeStatus !== "registered") return { ok: false, status: 409, error: "Project agent is not active", persisted: false };

  const projectId = String(projectAgent.projectId);
  const requestedConversationId = boundedText(input.requestedConversationId, 180);
  const taskId = boundedText(input.taskId, 180);
  const now = Date.now();
  let conversationId = input.forceNewConversation ? safeId("cnv") : requestedConversationId;
  if (conversationId && !input.forceNewConversation) {
    const owned = await input.database.prepare("SELECT id FROM conversations WHERE id=? AND project_id=? AND archived_at IS NULL").bind(conversationId, projectId).first();
    if (!owned) return { ok: false, status: 404, error: "Conversation not found", persisted: false };
  } else if (!input.forceNewConversation) {
    const current = await input.database.prepare("SELECT id FROM conversations WHERE project_id=? AND status='active' AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1").bind(projectId).first<{ id: string }>();
    conversationId = current?.id || safeId("cnv");
  }
  const isNewConversation = !(await input.database.prepare("SELECT id FROM conversations WHERE id=?").bind(conversationId).first());
  if (taskId) {
    const task = await input.database.prepare("SELECT id FROM tasks WHERE id=? AND project_id=?").bind(taskId, projectId).first();
    if (!task) return { ok: false, status: 404, error: "Task not found in this project", persisted: false };
  }

  const messageId = safeId("msg");
  const runId = safeId("run");
  const thread = await input.database.prepare("SELECT thread_id AS threadId FROM codex_threads WHERE conversation_id=? AND agent_id=? AND status='active'").bind(conversationId, projectAgent.agentId).first<{ threadId: string }>();
  const statements = [];
  if (isNewConversation) statements.push(input.database.prepare("INSERT INTO conversations (id,project_id,title,status,default_agent_id,created_by,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)").bind(conversationId, projectId, body.slice(0, 100), projectAgent.agentId, actorRef, now, now));
  const authority = [...new Set(input.authority)].slice(0, 8);
  const snapshot = { conversationId, messageId, taskId: taskId || null, body, sourceType: input.sourceType, principalId: actorRef, authority };
  statements.push(
    input.database.prepare("INSERT INTO conversation_messages (id,conversation_id,project_id,author_type,author_ref,body,delivery_status,run_id,source_type,created_at) VALUES (?,?,?,?,?,?,'dispatching',?,?,?)").bind(messageId, conversationId, projectId, input.authorType, actorRef, body, runId, input.sourceType, now),
    input.database.prepare("INSERT INTO agent_runs (id,agent_id,agent_version_id,project_id,trigger_type,trigger_ref,input_snapshot,idempotency_key,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,'chat',?,?,?,'queued',?,?,?)").bind(runId, projectAgent.agentId, projectAgent.agentVersionId, projectId, messageId, JSON.stringify(snapshot), input.idempotencyKey || `chat:${messageId}`, actorRef, now, now),
    input.database.prepare("INSERT INTO agent_run_events (id,run_id,sequence,event_type,stage,message,occurred_at,received_at) VALUES (?,?,1,'queued','chat','Project chat message queued',?,?)").bind(safeId("rue"), runId, now, now),
    input.database.prepare("UPDATE conversations SET updated_at=? WHERE id=?").bind(now, conversationId),
    input.database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,?,?,?,'queued',?,?)").bind(safeId("aud"), actorRef, input.sourceType === "owner_chat" ? "Sent project chat message" : input.sourceType === "slack_mention" ? "Assistant routed Slack thread to project agent" : "Submitted authenticated external project message", "conversation", conversationId, JSON.stringify({ projectId, runId, messageId, sourceType: input.sourceType, authority }), now),
  );
  if (taskId) statements.push(input.database.prepare("INSERT INTO task_agent_assignments (task_id,agent_id,assignment_state,latest_run_id,assigned_by,assigned_at,updated_at) VALUES (?,?,'in_progress',?,?,?,?) ON CONFLICT(task_id,agent_id) DO UPDATE SET assignment_state='in_progress',latest_run_id=excluded.latest_run_id,assigned_by=excluded.assigned_by,updated_at=excluded.updated_at").bind(taskId, projectAgent.agentId, runId, actorRef, now, now));
  await input.database.batch(statements);

  const dispatch = {
    runId, conversationId, ownerMessageId: messageId, projectSlug: projectAgent.projectSlug, taskId: taskId || null,
    message: body,
    threadId: thread?.threadId || null,
    requestContext: { sourceType: input.sourceType, principalId: actorRef, authority },
    agent: {
      id: projectAgent.agentId,
      versionId: projectAgent.agentVersionId,
      systemInstructions: projectAgent.systemInstructions,
      boundaryInstructions: projectAgent.boundaryInstructions,
      sandboxMode: projectAgent.sandboxMode,
      modelName: projectAgent.modelName,
      reasoningEffort: projectAgent.reasoningEffort,
      timeoutSeconds: projectAgent.timeoutSeconds,
    },
  };
  let response: Response;
  try {
    response = await fetch(runtime.endpoint, { method: "POST", headers: { authorization: `Bearer ${runtime.token}`, "content-type": "application/json" }, body: JSON.stringify(dispatch) });
  } catch {
    await input.database.batch([
      input.database.prepare("UPDATE conversation_messages SET delivery_status='failed' WHERE id=?").bind(messageId),
      input.database.prepare("UPDATE agent_runs SET status='failed',failure_code='project_runtime_unreachable',failure_message='Project runtime could not be reached',completed_at=?,updated_at=? WHERE id=?").bind(Date.now(), Date.now(), runId),
    ]);
    return { ok: false, status: 502, error: "Project runtime could not be reached", persisted: true, conversationId, messageId, runId };
  }
  if (!response.ok) {
    await input.database.batch([
      input.database.prepare("UPDATE conversation_messages SET delivery_status='failed' WHERE id=?").bind(messageId),
      input.database.prepare("UPDATE agent_runs SET status='failed',failure_code='project_runtime_rejected',failure_message=?,completed_at=?,updated_at=? WHERE id=?").bind(`Project runtime rejected dispatch with HTTP ${response.status}`, Date.now(), Date.now(), runId),
    ]);
    return { ok: false, status: 502, error: "Project runtime rejected the message", persisted: true, conversationId, messageId, runId };
  }
  await input.database.batch([
    input.database.prepare("UPDATE conversation_messages SET delivery_status='sent' WHERE id=?").bind(messageId),
    input.database.prepare("UPDATE agent_runs SET status='running',started_at=?,heartbeat_at=?,updated_at=? WHERE id=?").bind(Date.now(), Date.now(), Date.now(), runId),
  ]);
  return { ok: true, status: 202, conversationId, messageId, runId, runStatus: "running" };
}
