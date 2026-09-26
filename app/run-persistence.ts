import { boundedText, jsonArray, jsonObject } from "./operations";
import { safeId } from "./server-security";

const runStatuses = new Set(["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled", "timed_out"]);

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function persistRunnerState(database: D1Database, runId: string, remote: Record<string, unknown>) {
  const run = await database.prepare("SELECT * FROM agent_runs WHERE id=?").bind(runId).first<Record<string, unknown>>();
  if (!run) return { ok: false as const, status: 404, error: "Run not found" };
  const status = runStatuses.has(String(remote.status)) ? String(remote.status) : String(run.status);
  const now = Date.now();
  const terminal = ["succeeded", "failed", "cancelled", "timed_out"].includes(status);
  const startedAt = Number(remote.startedAt) || Number(run.started_at) || (status === "running" ? now : null);
  const completedAt = terminal ? Number(remote.completedAt) || now : null;
  const failureMessage = status === "failed" || status === "timed_out" ? boundedText(remote.error || remote.failureMessage || remote.output, 4000, "Runner job failed") : null;
  const statements: D1PreparedStatement[] = [
    database.prepare("UPDATE agent_runs SET status=?,runner_job_id=?,started_at=?,heartbeat_at=?,completed_at=?,failure_code=?,failure_message=?,updated_at=? WHERE id=?").bind(status, boundedText(remote.id, 180, runId), startedAt, now, completedAt, failureMessage ? status : null, failureMessage, now, runId),
  ];

  const events = Array.isArray(remote.events) ? remote.events.slice(0, 1000) : [];
  for (let index = 0; index < events.length; index += 1) {
    const event = record(events[index]);
    const sequence = Number(event.sequence) || index + 1;
    const metadata = jsonObject(event.metadata, 20_000);
    statements.push(database.prepare("INSERT OR IGNORE INTO agent_run_events (id,run_id,sequence,event_type,stage,message,progress_percent,metadata,occurred_at,received_at,content_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(safeId("rue"), runId, sequence, boundedText(event.type, 80, "progress"), boundedText(event.stage, 120) || null, boundedText(event.message, 4000), Number.isFinite(Number(event.progressPercent)) ? Math.max(0, Math.min(100, Number(event.progressPercent))) : null, metadata, Number(event.occurredAt) || now, now, await sha256(`${runId}:${sequence}:${metadata}`)));
  }

  const result = record(remote.result);
  let resultId: string | null = null;
  if (terminal) {
    resultId = safeId("res");
    const structured = Object.keys(result).length ? result : { summary: status === "succeeded" ? "Run completed without a structured result." : failureMessage ?? "Run ended." };
    const structuredData = jsonObject(structured);
    const summary = boundedText(structured.summary, 20_000, status === "succeeded" ? "Run completed." : failureMessage ?? "Run failed.");
    const validationStatus = Object.keys(result).length ? "valid" : "invalid";
    statements.push(database.prepare("INSERT INTO agent_results (id,run_id,schema_name,schema_version,summary,structured_data,validation_status,validation_errors,confidence,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET summary=excluded.summary,structured_data=excluded.structured_data,validation_status=excluded.validation_status,validation_errors=excluded.validation_errors,confidence=excluded.confidence,content_hash=excluded.content_hash").bind(resultId, runId, boundedText(remote.schemaName, 100, "planning-result"), Number(remote.schemaVersion) || 1, summary, structuredData, validationStatus, validationStatus === "valid" ? "[]" : JSON.stringify(["Runner did not return structured result data"]), boundedText(structured.confidence, 20) || null, await sha256(structuredData), now));
  }

  statements.push(database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,'system:runner','Reconciled agent run','agent_run',?,?,?,?)").bind(safeId("aud"), runId, status, JSON.stringify({ terminal, resultId }), now));
  await database.batch(statements);

  if (status === "succeeded" && run.project_id && result.plan && typeof result.plan === "object") {
    await materializeDraftPlan(database, run, record(result.plan), now);
  }
  return { ok: true as const, runId, status, terminal };
}

async function materializeDraftPlan(database: D1Database, run: Record<string, unknown>, plan: Record<string, unknown>, now: number) {
  const existing = await database.prepare("SELECT id FROM plan_versions WHERE agent_run_id=?").bind(run.id).first();
  if (existing) return;
  const projectId = String(run.project_id);
  const planId = safeId("pln");
  const versionId = safeId("plv");
  const title = boundedText(plan.title, 200, "Agent draft plan");
  const statements: D1PreparedStatement[] = [
    database.prepare("INSERT INTO plans (id,project_id,title,current_version_id,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?)").bind(planId, projectId, title, versionId, `agent:${run.agent_id}`, now, now),
    database.prepare("INSERT INTO plan_versions (id,plan_id,version_number,objective,success_definition,context,scope_in,scope_out,assumptions,decisions,deliverables,risks,open_questions,source_snapshot_id,generated_by_agent_id,agent_version_id,agent_run_id,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(versionId, planId, boundedText(plan.objective, 20_000), boundedText(plan.successDefinition, 20_000), boundedText(plan.context, 40_000), jsonArray(plan.scopeIn), jsonArray(plan.scopeOut), jsonArray(plan.assumptions), jsonArray(plan.decisions), jsonArray(plan.deliverables), jsonArray(plan.risks), jsonArray(plan.openQuestions), null, run.agent_id, run.agent_version_id, run.id, now),
  ];
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.slice(0, 200) : [];
  for (const rawTask of tasks) {
    const task = record(rawTask);
    const titleValue = boundedText(task.title, 240);
    if (!titleValue) continue;
    statements.push(database.prepare("INSERT INTO tasks (id,project_id,origin_plan_version_id,title,description,expected_outcome,acceptance_criteria,status,priority,assignment_state,date_state,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'backlog',?,'proposed','proposed',?,?,?)").bind(safeId("tsk"), projectId, versionId, titleValue, boundedText(task.description, 20_000), boundedText(task.expectedOutcome, 20_000), jsonArray(task.acceptanceCriteria, 50), ["critical", "high", "normal", "low"].includes(String(task.priority)) ? String(task.priority) : "normal", `agent:${run.agent_id}`, now, now));
  }
  statements.push(database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,'system:runner','Materialized draft plan','plan',?,'draft',?,?)").bind(safeId("aud"), planId, JSON.stringify({ runId: run.id, projectId, versionId }), now));
  await database.batch(statements);
}
