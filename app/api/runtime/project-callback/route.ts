import { env } from "cloudflare:workers";
import { boundedText } from "../../../operations";
import { runtimeEnv, safeId, secureJson, verifyTimestampedHmac } from "../../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 256_000) return secureJson({ error: "Payload too large" }, { status: 413 });
  const timestamp = request.headers.get("x-managerai-timestamp") ?? "";
  const secret = runtimeEnv().PROJECT_AGENT_CALLBACK_SECRET ?? "";
  if (!(await verifyTimestampedHmac(secret, timestamp, rawBody, request.headers.get("x-managerai-signature")))) return secureJson({ error: "Invalid signature" }, { status: 401 });
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody) as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const runId = boundedText(payload.runId, 180);
  const conversationId = boundedText(payload.conversationId, 180);
  const projectSlug = boundedText(payload.projectSlug, 120);
  const threadId = boundedText(payload.threadId, 180);
  const responseBody = boundedText(payload.response, 100_000);
  const errorCode = boundedText(payload.errorCode, 120);
  const callbackTaskId = boundedText(payload.taskId, 180);
  const status = payload.status === "succeeded" ? "succeeded" : "failed";
  if (!runId || !conversationId || !projectSlug) return secureJson({ error: "Incomplete callback" }, { status: 400 });

  const database = (env as unknown as DatabaseEnv).DB;
  const run = await database.prepare(`SELECT r.id,r.project_id AS projectId,r.agent_id AS agentId,r.agent_version_id AS agentVersionId,
    r.trigger_ref AS ownerMessageId,r.input_snapshot AS inputSnapshot,p.slug AS projectSlug,w.checkout_path AS checkoutPath,
    m.conversation_id AS expectedConversationId
    FROM agent_runs r JOIN projects p ON p.id=r.project_id JOIN project_workspaces w ON w.project_id=p.id
    JOIN conversation_messages m ON m.id=r.trigger_ref AND m.run_id=r.id
    WHERE r.id=? AND r.trigger_type='chat'`).bind(runId).first<Record<string, unknown>>();
  if (!run || run.projectSlug !== projectSlug || run.expectedConversationId !== conversationId) return secureJson({ error: "Run not found" }, { status: 404 });
  let taskId = "";
  try {
    const snapshot = JSON.parse(String(run.inputSnapshot || "{}")) as Record<string, unknown>;
    taskId = boundedText(snapshot.taskId, 180);
  } catch { return secureJson({ error: "Run snapshot is invalid" }, { status: 409 }); }
  if (callbackTaskId !== taskId) return secureJson({ error: "Callback task mismatch" }, { status: 409 });
  const now = Date.now();
  const messageId = `msg_agent_${runId}`.slice(0, 180);
  const contentHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(responseBody || errorCode || status));
  const hash = [...new Uint8Array(contentHash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const events = Array.isArray(payload.events) ? payload.events.slice(0, 200) as Array<Record<string, unknown>> : [];
  const statements = [
    database.prepare("UPDATE agent_runs SET status=?,failure_code=?,failure_message=?,heartbeat_at=?,completed_at=?,updated_at=? WHERE id=?").bind(status, status === "failed" ? (errorCode || "project_agent_failed") : null, status === "failed" ? (responseBody || "Project agent failed") : null, now, now, now, runId),
    database.prepare("UPDATE conversation_messages SET delivery_status=? WHERE id=?").bind(status === "succeeded" ? "completed" : "failed", run.ownerMessageId),
    database.prepare("UPDATE conversations SET updated_at=? WHERE id=?").bind(now, conversationId),
    database.prepare("INSERT OR IGNORE INTO agent_results (id,run_id,schema_name,schema_version,summary,structured_data,validation_status,validation_errors,confidence,content_hash,created_at) VALUES (?,?,'conversation-response',1,?,? ,?,'[]',NULL,?,?)").bind(safeId("res"), runId, responseBody || "Project agent failed", JSON.stringify({ threadId, projectSlug }), status === "succeeded" ? "valid" : "invalid", hash, now),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,'system:project-agent','Completed project chat turn','agent_run',?,?,?,?)").bind(safeId("aud"), runId, status, JSON.stringify({ conversationId, projectId: run.projectId, threadId: threadId || null }), now),
  ];
  if (responseBody) statements.push(database.prepare("INSERT OR IGNORE INTO conversation_messages (id,conversation_id,project_id,author_type,author_ref,body,delivery_status,run_id,reply_to_message_id,source_type,created_at) VALUES (?,?,?,'agent',?,?,'completed',?,?, 'project_agent',?)").bind(messageId, conversationId, run.projectId, run.agentId, responseBody, runId, run.ownerMessageId, now));
  if (threadId) statements.push(database.prepare(`INSERT INTO codex_threads (id,conversation_id,project_id,agent_id,thread_id,workspace_ref,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT(conversation_id,agent_id) DO UPDATE SET thread_id=excluded.thread_id,workspace_ref=excluded.workspace_ref,status='active',updated_at=excluded.updated_at`).bind(safeId("cdx"), conversationId, run.projectId, run.agentId, threadId, run.checkoutPath, now, now));
  if (taskId) statements.push(database.prepare("UPDATE task_agent_assignments SET assignment_state=?,latest_run_id=?,updated_at=? WHERE task_id=? AND agent_id=?").bind(status === "succeeded" ? "completed" : "blocked", runId, now, taskId, run.agentId));
  let sequence = 2;
  for (const event of events) {
    const eventType = boundedText(event.type, 80, "progress");
    const stage = boundedText(event.stage, 80);
    const message = boundedText(event.message, 2000);
    const occurredAt = Number(event.occurredAt) || now;
    statements.push(database.prepare("INSERT OR IGNORE INTO agent_run_events (id,run_id,sequence,event_type,stage,message,progress_percent,metadata,occurred_at,received_at,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(safeId("rue"), runId, sequence, eventType, stage || null, message, Number(event.progressPercent) || null, "{}", occurredAt, now, null));
    sequence += 1;
  }
  await database.batch(statements);
  return secureJson({ ok: true, runId, status });
}
