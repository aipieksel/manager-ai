import { env } from "cloudflare:workers";
import { boundedText, jsonArray, nullableText, priorities, taskStatuses, timestamp } from "../../operations";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const params = new URL(request.url).searchParams;
  const projectId = params.get("projectId")?.slice(0, 180) ?? "";
  const taskId = params.get("taskId")?.slice(0, 180) ?? "";
  if (!projectId && !taskId) return secureJson({ error: "projectId or taskId is required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const tasks = await database.prepare(`SELECT t.*, i.display_name AS ownerName,
    (SELECT json_group_array(identity_id) FROM task_assignees ta WHERE ta.task_id=t.id) AS assigneeIds,
    (SELECT json_group_array(depends_on_task_id) FROM task_dependencies td WHERE td.task_id=t.id) AS dependencyIds,
    (SELECT taa.assignment_state FROM task_agent_assignments taa WHERE taa.task_id=t.id ORDER BY taa.updated_at DESC LIMIT 1) AS agentAssignmentState,
    (SELECT a.name FROM task_agent_assignments taa JOIN agents a ON a.id=taa.agent_id WHERE taa.task_id=t.id ORDER BY taa.updated_at DESC LIMIT 1) AS agentName,
    (SELECT taa.latest_run_id FROM task_agent_assignments taa WHERE taa.task_id=t.id ORDER BY taa.updated_at DESC LIMIT 1) AS agentRunId
    FROM tasks t LEFT JOIN identities i ON i.id=t.accountable_owner_id
    WHERE ${taskId ? "t.id=?" : "t.project_id=?"} ORDER BY t.updated_at DESC`).bind(taskId || projectId).all();
  return secureJson({ tasks: tasks.results });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const projectId = boundedText(payload.projectId, 180);
  const title = boundedText(payload.title, 240);
  if (!projectId || !title) return secureJson({ error: "projectId and title are required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const project = await database.prepare("SELECT id FROM projects WHERE id=? AND archived_at IS NULL").bind(projectId).first();
  if (!project) return secureJson({ error: "Project not found" }, { status: 404 });
  const now = Date.now();
  const id = safeId("tsk");
  const status = typeof payload.status === "string" && taskStatuses.has(payload.status) ? payload.status : "backlog";
  const priority = typeof payload.priority === "string" && priorities.has(payload.priority) ? payload.priority : "normal";
  await database.batch([
    database.prepare("INSERT INTO tasks (id,project_id,parent_task_id,title,description,expected_outcome,acceptance_criteria,status,priority,accountable_owner_id,assignment_state,start_at,due_at,date_state,estimate_minutes,milestone,blocked_reason,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, projectId, nullableText(payload.parentTaskId, 180), title, boundedText(payload.description, 20_000), boundedText(payload.expectedOutcome, 20_000), jsonArray(payload.acceptanceCriteria, 50), status, priority, nullableText(payload.accountableOwnerId, 180), payload.accountableOwnerId ? "proposed" : "unassigned", timestamp(payload.startAt), timestamp(payload.dueAt), "proposed", typeof payload.estimateMinutes === "number" ? Math.max(0, Math.min(1_000_000, Math.round(payload.estimateMinutes))) : null, nullableText(payload.milestone, 200), nullableText(payload.blockedReason, 4000), owner.email, now, now),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created task','task',?,'allowed',?,?)").bind(safeId("aud"), owner.email, id, JSON.stringify({ projectId }), now),
  ]);
  return secureJson({ task: { id, projectId, title, status, priority, createdAt: now } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const id = boundedText(payload.id, 180);
  const database = (env as unknown as DatabaseEnv).DB;
  const current = await database.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first<Record<string, unknown>>();
  if (!current) return secureJson({ error: "Task not found" }, { status: 404 });
  const status = typeof payload.status === "string" && taskStatuses.has(payload.status) ? payload.status : String(current.status);
  const priority = typeof payload.priority === "string" && priorities.has(payload.priority) ? payload.priority : String(current.priority);
  const dependencies = Array.isArray(payload.dependencyIds) ? [...new Set(payload.dependencyIds.map((value) => boundedText(value, 180)).filter(Boolean))].slice(0, 100) : null;
  if (dependencies?.includes(id)) return secureJson({ error: "A task cannot depend on itself" }, { status: 400 });
  if (dependencies?.length) {
    const placeholders = dependencies.map(() => "?").join(",");
    const valid = await database.prepare(`SELECT id FROM tasks WHERE project_id=? AND id IN (${placeholders})`).bind(current.project_id, ...dependencies).all<{ id: string }>();
    if (valid.results.length !== dependencies.length) return secureJson({ error: "Dependencies must belong to the same project" }, { status: 400 });
    const cycle = await database.prepare(`WITH RECURSIVE chain(id) AS (SELECT depends_on_task_id FROM task_dependencies WHERE task_id IN (${placeholders}) UNION SELECT td.depends_on_task_id FROM task_dependencies td JOIN chain c ON td.task_id=c.id) SELECT id FROM chain WHERE id=? LIMIT 1`).bind(...dependencies, id).first();
    if (cycle) return secureJson({ error: "This dependency would create a cycle" }, { status: 409 });
  }
  const assignees = Array.isArray(payload.assigneeIds) ? [...new Set(payload.assigneeIds.map((value) => boundedText(value, 180)).filter(Boolean))].slice(0, 50) : null;
  if (assignees?.length) {
    const placeholders = assignees.map(() => "?").join(",");
    const valid = await database.prepare(`SELECT id FROM identities WHERE id IN (${placeholders}) AND status='active'`).bind(...assignees).all();
    if (valid.results.length !== assignees.length) return secureJson({ error: "Every assignee must be an active identity" }, { status: 400 });
  }
  const now = Date.now();
  const completedAt = status === "done" ? Number(current.completed_at) || now : null;
  const statements = [
    database.prepare("UPDATE tasks SET title=?,description=?,expected_outcome=?,acceptance_criteria=?,status=?,priority=?,accountable_owner_id=?,assignment_state=?,start_at=?,due_at=?,date_state=?,estimate_minutes=?,milestone=?,blocked_reason=?,completion_summary=?,completion_evidence_ref=?,updated_at=?,completed_at=? WHERE id=?").bind(boundedText(payload.title, 240, String(current.title)), boundedText(payload.description, 20_000, String(current.description)), boundedText(payload.expectedOutcome, 20_000, String(current.expected_outcome)), payload.acceptanceCriteria === undefined ? current.acceptance_criteria : jsonArray(payload.acceptanceCriteria, 50), status, priority, payload.accountableOwnerId === undefined ? current.accountable_owner_id : nullableText(payload.accountableOwnerId, 180), payload.assignmentState === undefined ? current.assignment_state : boundedText(payload.assignmentState, 40), payload.startAt === undefined ? current.start_at : timestamp(payload.startAt), payload.dueAt === undefined ? current.due_at : timestamp(payload.dueAt), payload.dateState === undefined ? current.date_state : boundedText(payload.dateState, 40), payload.estimateMinutes === undefined ? current.estimate_minutes : typeof payload.estimateMinutes === "number" ? Math.max(0, Math.round(payload.estimateMinutes)) : null, payload.milestone === undefined ? current.milestone : nullableText(payload.milestone, 200), payload.blockedReason === undefined ? current.blocked_reason : nullableText(payload.blockedReason, 4000), payload.completionSummary === undefined ? current.completion_summary : nullableText(payload.completionSummary, 20_000), payload.completionEvidenceRef === undefined ? current.completion_evidence_ref : nullableText(payload.completionEvidenceRef, 500), now, completedAt, id),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Updated task','task',?,'allowed',?,?)").bind(safeId("aud"), owner.email, id, JSON.stringify({ status, priority }), now),
  ];
  if (dependencies) {
    statements.push(database.prepare("DELETE FROM task_dependencies WHERE task_id=?").bind(id));
    for (const dependencyId of dependencies) statements.push(database.prepare("INSERT INTO task_dependencies (task_id,depends_on_task_id,dependency_type,created_by,created_at) VALUES (?,?,'finish_to_start',?,?)").bind(id, dependencyId, owner.email, now));
  }
  if (assignees) {
    statements.push(database.prepare("DELETE FROM task_assignees WHERE task_id=?").bind(id));
    for (const identityId of assignees) statements.push(database.prepare("INSERT INTO task_assignees (task_id,identity_id,role,assignment_state,assigned_by,assigned_at) VALUES (?,?,'contributor','proposed',?,?)").bind(id, identityId, owner.email, now));
  }
  await database.batch(statements);
  return secureJson({ ok: true, status, updatedAt: now });
}
