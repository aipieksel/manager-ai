import { env } from "cloudflare:workers";
import { boundedText, nullableText, projectStatuses, slugify, timestamp } from "../../operations";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const database = (env as unknown as DatabaseEnv).DB;
  const projectId = new URL(request.url).searchParams.get("projectId")?.slice(0, 180) ?? "";
  if (projectId) {
    const project = await database.prepare("SELECT * FROM projects WHERE id = ?").bind(projectId).first();
    if (!project) return secureJson({ error: "Project not found" }, { status: 404 });
    const [plans, tasks, sources, runs, activity, workspace, resources, variables] = await Promise.all([
      database.prepare("SELECT p.*, v.version_number AS versionNumber, v.objective, v.success_definition AS successDefinition, v.context, v.scope_in AS scopeIn, v.scope_out AS scopeOut, v.assumptions, v.decisions, v.deliverables, v.risks, v.open_questions AS openQuestions, v.reviewed_by AS reviewedBy, v.reviewed_at AS reviewedAt, v.review_decision AS reviewDecision, v.review_note AS reviewNote FROM plans p LEFT JOIN plan_versions v ON v.id = p.current_version_id WHERE p.project_id = ? ORDER BY p.updated_at DESC").bind(projectId).all(),
      database.prepare(`SELECT t.*, i.display_name AS ownerName,
        (SELECT json_group_array(ta.identity_id) FROM task_assignees ta WHERE ta.task_id=t.id) AS assigneeIds,
        (SELECT group_concat(ai.display_name, ', ') FROM task_assignees ta JOIN identities ai ON ai.id=ta.identity_id WHERE ta.task_id=t.id) AS assigneeNames,
        (SELECT json_group_array(td.depends_on_task_id) FROM task_dependencies td WHERE td.task_id=t.id) AS dependencyIds,
        (SELECT group_concat(dt.title, ', ') FROM task_dependencies td JOIN tasks dt ON dt.id=td.depends_on_task_id WHERE td.task_id=t.id) AS dependencyTitles,
        (SELECT group_concat(sr.label, ', ') FROM source_references sr WHERE sr.object_type='task' AND sr.object_id=t.id) AS sourceLabel,
        (SELECT taa.assignment_state FROM task_agent_assignments taa WHERE taa.task_id=t.id ORDER BY taa.updated_at DESC LIMIT 1) AS agentAssignmentState,
        (SELECT a.name FROM task_agent_assignments taa JOIN agents a ON a.id=taa.agent_id WHERE taa.task_id=t.id ORDER BY taa.updated_at DESC LIMIT 1) AS agentName,
        (SELECT taa.latest_run_id FROM task_agent_assignments taa WHERE taa.task_id=t.id ORDER BY taa.updated_at DESC LIMIT 1) AS agentRunId
        FROM tasks t LEFT JOIN identities i ON i.id = t.accountable_owner_id WHERE t.project_id = ? ORDER BY CASE t.status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 WHEN 'ready' THEN 2 WHEN 'backlog' THEN 3 ELSE 4 END, t.due_at, t.created_at`).bind(projectId).all(),
      database.prepare("SELECT * FROM source_references WHERE project_id = ? ORDER BY captured_at DESC").bind(projectId).all(),
      database.prepare("SELECT r.*, a.name AS agentName, v.version_number AS agentVersion, x.summary AS resultSummary, x.validation_status AS validationStatus FROM agent_runs r JOIN agents a ON a.id = r.agent_id JOIN agent_versions v ON v.id = r.agent_version_id LEFT JOIN agent_results x ON x.run_id = r.id WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT 100").bind(projectId).all(),
      database.prepare(`SELECT id,actor,action,object_type AS objectType,object_id AS objectId,result,occurred_at AS occurredAt FROM audit_events WHERE (object_type='project' AND object_id=?) OR (object_type='plan' AND object_id IN (SELECT id FROM plans WHERE project_id=?)) OR (object_type='task' AND object_id IN (SELECT id FROM tasks WHERE project_id=?)) OR (object_type='agent_run' AND object_id IN (SELECT id FROM agent_runs WHERE project_id=?)) ORDER BY occurred_at DESC LIMIT 300`).bind(projectId, projectId, projectId, projectId).all(),
      database.prepare("SELECT * FROM project_workspaces WHERE project_id=?").bind(projectId).first(),
      database.prepare("SELECT * FROM project_resources WHERE project_id=? ORDER BY resource_type,sort_order,label").bind(projectId).all(),
      database.prepare("SELECT id,project_id,name,owning_service,secret_ref,configured_status,required,description,last_checked_at,updated_at FROM project_variables WHERE project_id=? ORDER BY name").bind(projectId).all(),
    ]);
    return secureJson({ project, plans: plans.results, tasks: tasks.results, sources: sources.results, runs: runs.results, activity: activity.results, workspace, resources: resources.results, variables: variables.results });
  }
  const rows = await database.prepare("SELECT p.*, i.display_name AS ownerName, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS taskCount, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS doneCount, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'blocked') AS blockedCount, (SELECT status FROM plans pl WHERE pl.project_id = p.id ORDER BY pl.updated_at DESC LIMIT 1) AS planStatus, (SELECT MAX(created_at) FROM agent_runs r WHERE r.project_id = p.id) AS lastRunAt FROM projects p LEFT JOIN identities i ON i.id = p.accountable_owner_id WHERE p.archived_at IS NULL AND NOT (p.created_by='system:slack' AND p.source_type IN ('slack','agent_chat') AND NOT EXISTS (SELECT 1 FROM tasks st WHERE st.project_id=p.id) AND NOT EXISTS (SELECT 1 FROM plans sp WHERE sp.project_id=p.id)) ORDER BY p.updated_at DESC LIMIT 200").all();
  return secureJson({ projects: rows.results });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const database = (env as unknown as DatabaseEnv).DB;
  if (payload.action === "source") {
    const projectId = boundedText(payload.projectId, 180);
    const sourceType = boundedText(payload.sourceType, 40);
    const sourceRef = boundedText(payload.sourceRef, 2000);
    const label = boundedText(payload.label, 300);
    const sourceUrl = nullableText(payload.sourceUrl, 2000);
    if (!projectId || !sourceType || !sourceRef || !label || (sourceUrl && !sourceUrl.startsWith("https://"))) return secureJson({ error: "Project, source type, label, stable reference, and a safe HTTPS URL are required" }, { status: 400 });
    if (!await database.prepare("SELECT id FROM projects WHERE id=? AND archived_at IS NULL").bind(projectId).first()) return secureJson({ error: "Project not found" }, { status: 404 });
    const id = safeId("src"); const now = Date.now();
    await database.batch([
      database.prepare("INSERT INTO source_references (id,project_id,object_type,object_id,source_type,source_ref,source_url,label,quoted_excerpt,captured_at) VALUES (?,?,'project',?,?,?,?,?,?,?)").bind(id, projectId, projectId, sourceType, sourceRef, sourceUrl, label, nullableText(payload.quotedExcerpt, 20_000), now),
      database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Attached source','project',?,'allowed',?,?)").bind(safeId("aud"), owner.email, projectId, JSON.stringify({ sourceId: id, sourceType }), now),
    ]);
    return secureJson({ source: { id, projectId, sourceType, sourceRef, label } }, { status: 201 });
  }
  const name = boundedText(payload.name, 160);
  const slug = slugify(payload.slug || name);
  if (!name || !slug) return secureJson({ error: "Project name is required" }, { status: 400 });
  const status = typeof payload.status === "string" && projectStatuses.has(payload.status) ? payload.status : "proposed";
  const now = Date.now();
  const id = safeId("prj");
  try {
    await database.batch([
      database.prepare("INSERT INTO projects (id,name,slug,description,objective,success_definition,status,accountable_owner_id,default_agent_id,client_name,timezone,start_at,due_at,source_type,source_ref,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, name, slug, boundedText(payload.description, 20_000), boundedText(payload.objective, 20_000), boundedText(payload.successDefinition, 20_000), status, nullableText(payload.accountableOwnerId, 180), nullableText(payload.defaultAgentId, 180), nullableText(payload.clientName, 160), boundedText(payload.timezone, 80, "Africa/Johannesburg") || "Africa/Johannesburg", timestamp(payload.startAt), timestamp(payload.dueAt), boundedText(payload.sourceType, 40, "manual") || "manual", nullableText(payload.sourceRef, 500), owner.email, now, now),
      database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created project','project',?,'allowed','{}',?)").bind(safeId("aud"), owner.email, id, now),
    ]);
  } catch {
    return secureJson({ error: "Project name or slug already exists" }, { status: 409 });
  }
  return secureJson({ project: { id, name, slug, status, createdAt: now } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const id = boundedText(payload.id, 180);
  if (!id) return secureJson({ error: "Project id is required" }, { status: 400 });
  const status = typeof payload.status === "string" && projectStatuses.has(payload.status) ? payload.status : null;
  const database = (env as unknown as DatabaseEnv).DB;
  const current = await database.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first<Record<string, unknown>>();
  if (!current) return secureJson({ error: "Project not found" }, { status: 404 });
  const now = Date.now();
  const nextName = boundedText(payload.name, 160, String(current.name));
  const nextSlug = slugify(payload.slug || nextName) || String(current.slug);
  await database.batch([
    database.prepare("UPDATE projects SET name=?,slug=?,description=?,objective=?,success_definition=?,status=?,accountable_owner_id=?,default_agent_id=?,client_name=?,timezone=?,start_at=?,due_at=?,updated_at=?,archived_at=? WHERE id=?").bind(nextName, nextSlug, boundedText(payload.description, 20_000, String(current.description ?? "")), boundedText(payload.objective, 20_000, String(current.objective ?? "")), boundedText(payload.successDefinition, 20_000, String(current.success_definition ?? "")), status ?? current.status, payload.accountableOwnerId === undefined ? current.accountable_owner_id : nullableText(payload.accountableOwnerId, 180), payload.defaultAgentId === undefined ? current.default_agent_id : nullableText(payload.defaultAgentId, 180), payload.clientName === undefined ? current.client_name : nullableText(payload.clientName, 160), boundedText(payload.timezone, 80, String(current.timezone)), payload.startAt === undefined ? current.start_at : timestamp(payload.startAt), payload.dueAt === undefined ? current.due_at : timestamp(payload.dueAt), now, (status ?? current.status) === "archived" ? now : null, id),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Updated project','project',?,'allowed',?,?)").bind(safeId("aud"), owner.email, id, JSON.stringify({ status: status ?? current.status }), now),
  ]);
  return secureJson({ ok: true, updatedAt: now });
}
