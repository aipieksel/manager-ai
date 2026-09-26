import { env } from "cloudflare:workers";
import { boundedText, jsonArray, planStatuses } from "../../operations";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const params = new URL(request.url).searchParams;
  const planId = params.get("planId")?.slice(0, 180) ?? "";
  const projectId = params.get("projectId")?.slice(0, 180) ?? "";
  if (!planId && !projectId) return secureJson({ error: "planId or projectId is required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const plans = await database.prepare(`SELECT p.*, v.version_number AS versionNumber, v.objective, v.success_definition AS successDefinition,
    v.context, v.scope_in AS scopeIn, v.scope_out AS scopeOut, v.assumptions, v.decisions, v.deliverables, v.risks,
    v.open_questions AS openQuestions, v.reviewed_by AS reviewedBy, v.reviewed_at AS reviewedAt,
    v.review_decision AS reviewDecision, v.review_note AS reviewNote, v.created_at AS versionCreatedAt
    FROM plans p LEFT JOIN plan_versions v ON v.id = p.current_version_id
    WHERE ${planId ? "p.id = ?" : "p.project_id = ?"} ORDER BY p.updated_at DESC`).bind(planId || projectId).all();
  if (planId && !plans.results.length) return secureJson({ error: "Plan not found" }, { status: 404 });
  const versions = planId ? await database.prepare("SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version_number DESC").bind(planId).all() : { results: [] };
  return secureJson({ plans: plans.results, versions: versions.results });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const projectId = boundedText(payload.projectId, 180);
  const title = boundedText(payload.title, 200);
  if (!projectId || !title) return secureJson({ error: "projectId and title are required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const project = await database.prepare("SELECT id FROM projects WHERE id = ? AND archived_at IS NULL").bind(projectId).first();
  if (!project) return secureJson({ error: "Project not found" }, { status: 404 });
  const planId = safeId("pln");
  const versionId = safeId("plv");
  const now = Date.now();
  const tasks = Array.isArray(payload.tasks) ? payload.tasks.slice(0, 200) as Array<Record<string, unknown>> : [];
  const statements = [
    database.prepare("INSERT INTO plans (id,project_id,title,current_version_id,status,created_by,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?)").bind(planId, projectId, title, versionId, owner.email, now, now),
    database.prepare("INSERT INTO plan_versions (id,plan_id,version_number,objective,success_definition,context,scope_in,scope_out,assumptions,decisions,deliverables,risks,open_questions,source_snapshot_id,generated_by_agent_id,agent_version_id,agent_run_id,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(versionId, planId, boundedText(payload.objective, 20_000), boundedText(payload.successDefinition, 20_000), boundedText(payload.context, 40_000), jsonArray(payload.scopeIn), jsonArray(payload.scopeOut), jsonArray(payload.assumptions), jsonArray(payload.decisions), jsonArray(payload.deliverables), jsonArray(payload.risks), jsonArray(payload.openQuestions), boundedText(payload.sourceSnapshotId, 180) || null, boundedText(payload.generatedByAgentId, 180) || null, boundedText(payload.agentVersionId, 180) || null, boundedText(payload.agentRunId, 180) || null, now),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created draft plan','plan',?,'allowed',?,?)").bind(safeId("aud"), owner.email, planId, JSON.stringify({ projectId, versionId }), now),
  ];
  const taskIds: string[] = [];
  for (const task of tasks) {
    const taskTitle = boundedText(task.title, 240);
    if (!taskTitle) continue;
    const taskId = safeId("tsk");
    taskIds.push(taskId);
    statements.push(database.prepare("INSERT INTO tasks (id,project_id,origin_plan_version_id,title,description,expected_outcome,acceptance_criteria,status,priority,assignment_state,date_state,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'backlog',?,'unassigned','proposed',?,?,?)").bind(taskId, projectId, versionId, taskTitle, boundedText(task.description, 20_000), boundedText(task.expectedOutcome, 20_000), jsonArray(task.acceptanceCriteria, 50), ["critical", "high", "normal", "low"].includes(String(task.priority)) ? task.priority : "normal", owner.email, now, now));
  }
  await database.batch(statements);
  return secureJson({ plan: { id: planId, projectId, title, status: "draft", currentVersionId: versionId }, taskIds }, { status: 201 });
}

export async function PATCH(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const planId = boundedText(payload.planId, 180);
  const action = boundedText(payload.action, 40);
  const database = (env as unknown as DatabaseEnv).DB;
  const plan = await database.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first<Record<string, unknown>>();
  if (!plan) return secureJson({ error: "Plan not found" }, { status: 404 });
  const now = Date.now();
  if (action === "review") {
    const decision = payload.decision === "approved" ? "approved" : payload.decision === "rejected" ? "rejected" : "";
    if (!decision) return secureJson({ error: "Review decision must be approved or rejected" }, { status: 400 });
    await database.batch([
      database.prepare("UPDATE plan_versions SET reviewed_by=?,reviewed_at=?,review_decision=?,review_note=? WHERE id=?").bind(owner.email, now, decision, boundedText(payload.reviewNote, 4000), plan.current_version_id),
      database.prepare("UPDATE plans SET status=?,updated_at=? WHERE id=?").bind(decision, now, planId),
      database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Reviewed plan','plan',?,?,?,?)").bind(safeId("aud"), owner.email, planId, decision, JSON.stringify({ decision }), now),
    ]);
    return secureJson({ ok: true, status: decision });
  }
  if (action === "revise") {
    const previous = await database.prepare("SELECT * FROM plan_versions WHERE id = ?").bind(plan.current_version_id).first<Record<string, unknown>>();
    if (!previous) return secureJson({ error: "Current plan version is missing" }, { status: 409 });
    const versionNumber = Number(previous.version_number) + 1;
    const versionId = safeId("plv");
    await database.batch([
      database.prepare("INSERT INTO plan_versions (id,plan_id,version_number,objective,success_definition,context,scope_in,scope_out,assumptions,decisions,deliverables,risks,open_questions,source_snapshot_id,generated_by_agent_id,agent_version_id,agent_run_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(versionId, planId, versionNumber, boundedText(payload.objective, 20_000, String(previous.objective)), boundedText(payload.successDefinition, 20_000, String(previous.success_definition)), boundedText(payload.context, 40_000, String(previous.context)), payload.scopeIn === undefined ? previous.scope_in : jsonArray(payload.scopeIn), payload.scopeOut === undefined ? previous.scope_out : jsonArray(payload.scopeOut), payload.assumptions === undefined ? previous.assumptions : jsonArray(payload.assumptions), payload.decisions === undefined ? previous.decisions : jsonArray(payload.decisions), payload.deliverables === undefined ? previous.deliverables : jsonArray(payload.deliverables), payload.risks === undefined ? previous.risks : jsonArray(payload.risks), payload.openQuestions === undefined ? previous.open_questions : jsonArray(payload.openQuestions), previous.source_snapshot_id, previous.generated_by_agent_id, previous.agent_version_id, previous.agent_run_id, now),
      database.prepare("UPDATE plans SET title=?,current_version_id=?,status='draft',updated_at=? WHERE id=?").bind(boundedText(payload.title, 200, String(plan.title)), versionId, now, planId),
      database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created plan revision','plan',?,'allowed',?,?)").bind(safeId("aud"), owner.email, planId, JSON.stringify({ versionId, versionNumber }), now),
    ]);
    return secureJson({ ok: true, versionId, versionNumber, status: "draft" });
  }
  const status = typeof payload.status === "string" && planStatuses.has(payload.status) ? payload.status : null;
  if (!status) return secureJson({ error: "Unsupported plan action" }, { status: 400 });
  await database.prepare("UPDATE plans SET status=?,updated_at=? WHERE id=?").bind(status, now, planId).run();
  return secureJson({ ok: true, status });
}
