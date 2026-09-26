import { env } from "cloudflare:workers";
import { boundedText } from "../../../operations";
import { projectRuntimeConfigured } from "../../../project-message-dispatch";
import { requireOwnerApi, secureJson } from "../../../server-security";

type DatabaseEnv = { DB: D1Database };
type ThreadRow = { id: string; kind: "conversation" | "run"; title: string; status: string; updated_at: number; source: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parsed(value: unknown) {
  try { return typeof value === "string" ? record(JSON.parse(value)) : record(value); } catch { return {}; }
}

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const url = new URL(request.url);
  const agentSlug = boundedText(url.searchParams.get("agentSlug"), 120);
  if (!agentSlug) return secureJson({ error: "agentSlug is required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const agent = await database.prepare(`SELECT a.id,a.name,a.slug,a.lifecycle_status AS lifecycleStatus,v.role,v.workspace_ref AS workspaceRef
    FROM agents a JOIN agent_versions v ON v.id=a.current_version_id
    WHERE a.slug=? AND a.archived_at IS NULL`).bind(agentSlug).first<Record<string, unknown>>();
  if (!agent) return secureJson({ error: "Agent not found" }, { status: 404 });
  const project = await database.prepare(`SELECT p.id,p.name,p.slug,w.runtime_status AS runtimeStatus
    FROM projects p LEFT JOIN project_workspaces w ON w.project_id=p.id
    WHERE p.default_agent_id=? AND p.archived_at IS NULL
    ORDER BY CASE WHEN w.runtime_status='registered' THEN 0 ELSE 1 END,p.updated_at DESC LIMIT 1`).bind(agent.id).first<Record<string, unknown>>();
  const conversations = await database.prepare(`SELECT c.id,'conversation' AS kind,c.title,c.status,c.updated_at,p.name AS projectName
    FROM conversations c JOIN projects p ON p.id=c.project_id
    WHERE c.default_agent_id=? AND c.archived_at IS NULL ORDER BY c.updated_at DESC LIMIT 100`).bind(agent.id).all<Record<string, unknown>>();
  const runs = await database.prepare(`SELECT r.id,'run' AS kind,COALESCE(t.title,p.objective,p.name,'Agent run') AS title,r.status,r.updated_at,r.trigger_type AS triggerType
    FROM agent_runs r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN tickets t ON t.id=r.ticket_id
    WHERE r.agent_id=? AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.run_id=r.id)
    ORDER BY r.updated_at DESC LIMIT 100`).bind(agent.id).all<Record<string, unknown>>();
  const threads: ThreadRow[] = [
    ...conversations.results.map((row) => ({ id: String(row.id), kind: "conversation" as const, title: String(row.title || row.projectName || "Conversation"), status: String(row.status || "active"), updated_at: Number(row.updated_at), source: "ManagerAI" })),
    ...runs.results.map((row) => ({ id: String(row.id), kind: "run" as const, title: String(row.title || "Agent run"), status: String(row.status || "queued"), updated_at: Number(row.updated_at), source: String(row.triggerType || "agent run").replaceAll("_", " ") })),
  ].sort((left, right) => right.updated_at - left.updated_at);
  const requestedThreadId = boundedText(url.searchParams.get("threadId"), 180);
  const selected = threads.find((thread) => thread.id === requestedThreadId) || threads[0];
  let messages: Array<Record<string, unknown>> = [];
  if (selected?.kind === "conversation") {
    const rows = await database.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT 500").bind(selected.id).all();
    messages = rows.results;
  } else if (selected?.kind === "run") {
    const run = await database.prepare(`SELECT r.*,p.objective,p.name AS projectName,t.title AS ticketTitle,t.details,x.summary
      FROM agent_runs r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN tickets t ON t.id=r.ticket_id LEFT JOIN agent_results x ON x.run_id=r.id WHERE r.id=? AND r.agent_id=?`).bind(selected.id, agent.id).first<Record<string, unknown>>();
    if (run) {
      const snapshot = parsed(run.input_snapshot);
      const context = boundedText(snapshot.context, 20_000);
      const requestText = context || boundedText(run.objective, 20_000) || boundedText(run.ticketTitle, 240) || selected.title;
      const runStatus = String(run.status || "queued");
      const requestDeliveryStatus = ["queued", "running", "waiting_for_approval"].includes(runStatus) ? "sent" : runStatus;
      messages.push({ id: `${selected.id}:request`, author_type: "external", author_ref: String(run.requested_by || "Slack"), body: requestText, delivery_status: requestDeliveryStatus, run_id: selected.id, created_at: Number(run.created_at) });
      const resultText = boundedText(run.summary, 20_000) || boundedText(run.failure_message, 4000);
      if (resultText) messages.push({ id: `${selected.id}:result`, author_type: "agent", author_ref: String(agent.slug), body: resultText, delivery_status: String(run.status), run_id: selected.id, created_at: Number(run.completed_at || run.updated_at) });
    }
  }
  return secureJson({
    agent,
    project,
    threads,
    threadId: selected?.id || "",
    messages,
    runtimeConfigured: Boolean(project && project.runtimeStatus === "registered" && projectRuntimeConfigured()),
  });
}
