import { env } from "cloudflare:workers";
import { agentLifecycles, boundedText, jsonObject, reasoningEfforts, sandboxModes, slugify } from "../../operations";
import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../setup-server";

type DatabaseEnv = { DB: D1Database };

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const agentId = new URL(request.url).searchParams.get("agentId")?.slice(0, 180) ?? "";
  const database = (env as unknown as DatabaseEnv).DB;
  const agents = await database.prepare(`SELECT a.*, v.version_number AS versionNumber, v.role, v.objective, v.success_definition AS successDefinition,
    v.system_instructions AS systemInstructions, v.boundary_instructions AS boundaryInstructions,
    v.input_schema_name AS inputSchemaName, v.output_schema_name AS outputSchemaName, v.output_schema_version AS outputSchemaVersion,
    v.model_provider AS modelProvider, v.model_name AS modelName, v.reasoning_effort AS reasoningEffort,
    v.sandbox_mode AS sandboxMode, v.timeout_seconds AS timeoutSeconds, v.max_concurrency AS maxConcurrency,
    v.max_input_chars AS maxInputChars, v.workspace_ref AS workspaceRef, v.change_reason AS changeReason,
    (SELECT COUNT(*) FROM agent_runs r WHERE r.agent_id=a.id AND r.status IN ('queued','running','waiting_for_approval')) AS activeRunCount,
    (SELECT MAX(created_at) FROM agent_runs r WHERE r.agent_id=a.id) AS lastRunAt
    FROM agents a LEFT JOIN agent_versions v ON v.id=a.current_version_id
    ${agentId ? "WHERE a.id=?" : "WHERE a.archived_at IS NULL"} ORDER BY a.name`).bind(...(agentId ? [agentId] : [])).all();
  const versions = agentId ? await database.prepare("SELECT * FROM agent_versions WHERE agent_id=? ORDER BY version_number DESC").bind(agentId).all() : { results: [] };
  const permissions = agentId ? await database.prepare("SELECT p.*, t.tool_name AS toolName, t.risk_class AS riskClass, c.name AS connectionName FROM agent_mcp_permissions p JOIN mcp_tools t ON t.id=p.mcp_tool_id JOIN mcp_connections c ON c.id=t.connection_id WHERE p.agent_version_id=(SELECT current_version_id FROM agents WHERE id=?) ORDER BY c.name,t.tool_name").bind(agentId).all() : { results: [] };
  return secureJson({ agents: agents.results, versions: versions.results, permissions: permissions.results });
}

function versionValues(payload: Record<string, unknown>, fallback?: Record<string, unknown>) {
  const timeout = typeof payload.timeoutSeconds === "number" ? Math.round(payload.timeoutSeconds) : Number(fallback?.timeout_seconds ?? 1800);
  const concurrency = typeof payload.maxConcurrency === "number" ? Math.round(payload.maxConcurrency) : Number(fallback?.max_concurrency ?? 1);
  const maxInput = typeof payload.maxInputChars === "number" ? Math.round(payload.maxInputChars) : Number(fallback?.max_input_chars ?? 64000);
  return {
    role: boundedText(payload.role, 300, String(fallback?.role ?? "")),
    objective: boundedText(payload.objective, 10_000, String(fallback?.objective ?? "")),
    successDefinition: boundedText(payload.successDefinition, 10_000, String(fallback?.success_definition ?? "")),
    systemInstructions: boundedText(payload.systemInstructions, 30_000, String(fallback?.system_instructions ?? "")),
    boundaryInstructions: boundedText(payload.boundaryInstructions, 20_000, String(fallback?.boundary_instructions ?? "")),
    inputSchemaName: boundedText(payload.inputSchemaName, 100, String(fallback?.input_schema_name ?? "work-request")),
    outputSchemaName: boundedText(payload.outputSchemaName, 100, String(fallback?.output_schema_name ?? "planning-result")),
    outputSchemaVersion: Math.max(1, Math.min(1000, typeof payload.outputSchemaVersion === "number" ? Math.round(payload.outputSchemaVersion) : Number(fallback?.output_schema_version ?? 1))),
    modelProvider: boundedText(payload.modelProvider, 80, String(fallback?.model_provider ?? "openai")),
    modelName: boundedText(payload.modelName, 120, String(fallback?.model_name ?? "default")),
    reasoningEffort: typeof payload.reasoningEffort === "string" && reasoningEfforts.has(payload.reasoningEffort) ? payload.reasoningEffort : String(fallback?.reasoning_effort ?? "medium"),
    sandboxMode: typeof payload.sandboxMode === "string" && sandboxModes.has(payload.sandboxMode) ? payload.sandboxMode : String(fallback?.sandbox_mode ?? "read_only"),
    timeoutSeconds: Math.max(60, Math.min(3600, timeout)),
    maxConcurrency: Math.max(1, Math.min(4, concurrency)),
    maxInputChars: Math.max(1000, Math.min(200_000, maxInput)),
    workspaceRef: boundedText(payload.workspaceRef, 180, String(fallback?.workspace_ref ?? "")) || null,
    changeReason: boundedText(payload.changeReason, 2000, "Configuration updated"),
  };
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const name = boundedText(payload.name, 100);
  const slug = slugify(payload.slug || name);
  const values = versionValues(payload);
  if (!name || !slug || !values.role || !values.objective || !values.systemInstructions) return secureJson({ error: "Name, role, objective and system instructions are required" }, { status: 400 });
  const id = safeId("agt");
  const versionId = safeId("agv");
  const identityId = safeId("idn");
  const now = Date.now();
  const database = (env as unknown as DatabaseEnv).DB;
  try {
    await database.batch([
      database.prepare("INSERT INTO identities (id,kind,display_name,role_title,timezone,availability,status,created_by,created_at,updated_at) VALUES (?,'agent',?,?,?,'unknown','active',?,?,?)").bind(identityId, name, values.role, "Africa/Johannesburg", owner.email, now, now),
      database.prepare("INSERT INTO agents (id,name,slug,description,lifecycle_status,current_version_id,owner_identity_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id, name, slug, boundedText(payload.description, 4000), "draft", versionId, identityId, owner.email, now, now),
      database.prepare("INSERT INTO agent_versions (id,agent_id,version_number,role,objective,success_definition,system_instructions,boundary_instructions,input_schema_name,output_schema_name,output_schema_version,model_provider,model_name,reasoning_effort,sandbox_mode,timeout_seconds,max_concurrency,max_input_chars,workspace_ref,change_reason,created_by,created_at) VALUES (?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(versionId, id, values.role, values.objective, values.successDefinition, values.systemInstructions, values.boundaryInstructions, values.inputSchemaName, values.outputSchemaName, values.outputSchemaVersion, values.modelProvider, values.modelName, values.reasoningEffort, values.sandboxMode, values.timeoutSeconds, values.maxConcurrency, values.maxInputChars, values.workspaceRef, values.changeReason, owner.email, now),
      database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created agent','agent',?,'draft',?,?)").bind(safeId("aud"), owner.email, id, JSON.stringify({ versionId }), now),
    ]);
  } catch {
    return secureJson({ error: "Agent name or slug already exists" }, { status: 409 });
  }
  return secureJson({ agent: { id, name, slug, lifecycleStatus: "draft", currentVersionId: versionId, ownerIdentityId: identityId } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const id = boundedText(payload.id, 180);
  const action = boundedText(payload.action, 40);
  const database = (env as unknown as DatabaseEnv).DB;
  const agent = await database.prepare("SELECT * FROM agents WHERE id=?").bind(id).first<Record<string, unknown>>();
  if (!agent) return secureJson({ error: "Agent not found" }, { status: 404 });
  const now = Date.now();
  if (action === "lifecycle") {
    const status = typeof payload.status === "string" && agentLifecycles.has(payload.status) ? payload.status : "";
    if (!status) return secureJson({ error: "Invalid lifecycle status" }, { status: 400 });
    await database.batch([
      database.prepare("UPDATE agents SET lifecycle_status=?,updated_at=?,archived_at=? WHERE id=?").bind(status, now, status === "archived" ? now : null, id),
      database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Changed agent lifecycle','agent',?,?,?,?)").bind(safeId("aud"), owner.email, id, status, JSON.stringify({ status }), now),
    ]);
    return secureJson({ ok: true, status });
  }
  if (action === "permissions") {
    const permissions = Array.isArray(payload.permissions) ? payload.permissions.slice(0, 500) as Array<Record<string, unknown>> : [];
    const statements = [database.prepare("DELETE FROM agent_mcp_permissions WHERE agent_version_id=?").bind(agent.current_version_id)];
    const runnerTools: Array<Record<string, unknown>> = [];
    for (const permission of permissions) {
      const toolId = boundedText(permission.toolId, 180);
      const value = ["deny", "allow", "allow_with_approval"].includes(String(permission.permission)) ? String(permission.permission) : "deny";
      if (!toolId) continue;
      const tool = await database.prepare("SELECT t.tool_name,c.id AS connectionId FROM mcp_tools t JOIN mcp_connections c ON c.id=t.connection_id WHERE t.id=? AND t.available=1").bind(toolId).first<Record<string, unknown>>();
      if (!tool) return secureJson({ error: `Unknown or unavailable MCP tool: ${toolId}` }, { status: 400 });
      statements.push(database.prepare("INSERT INTO agent_mcp_permissions (agent_version_id,mcp_tool_id,permission,argument_policy,rate_limit,created_by,created_at) VALUES (?,?,?,?,?,?,?)").bind(agent.current_version_id, toolId, value, jsonObject(permission.argumentPolicy), typeof permission.rateLimit === "number" ? Math.max(0, Math.round(permission.rateLimit)) : 0, owner.email, now));
      runnerTools.push({ connectionId: tool.connectionId, toolName: tool.tool_name, permission: value });
    }
    const runner = await getRunnerConfiguration();
    if (!runner.configured || !runner.url) return secureJson({ error: "Runner is not configured; tool policy was not changed" }, { status: 503 });
    const policyResponse = await runnerFetch(runner.url, runner.token, `/v1/mcp/policies/${String(agent.current_version_id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tools: runnerTools }), signal: AbortSignal.timeout(30_000) });
    if (!policyResponse.ok) { const result = await responseJson(policyResponse); return secureJson({ error: "Runner rejected the MCP policy", details: result.error }, { status: 502 }); }
    statements.push(database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Updated agent MCP permissions','agent',?,'allowed',?,?)").bind(safeId("aud"), owner.email, id, JSON.stringify({ count: permissions.length }), now));
    await database.batch(statements);
    return secureJson({ ok: true, permissionCount: permissions.length });
  }
  if (action !== "version") return secureJson({ error: "Unsupported agent action" }, { status: 400 });
  const current = await database.prepare("SELECT * FROM agent_versions WHERE id=?").bind(agent.current_version_id).first<Record<string, unknown>>();
  if (!current) return secureJson({ error: "Current agent version is missing" }, { status: 409 });
  const values = versionValues(payload, current);
  if (!values.role || !values.objective || !values.systemInstructions) return secureJson({ error: "Role, objective and system instructions are required" }, { status: 400 });
  const versionId = safeId("agv");
  const versionNumber = Number(current.version_number) + 1;
  await database.batch([
    database.prepare("INSERT INTO agent_versions (id,agent_id,version_number,role,objective,success_definition,system_instructions,boundary_instructions,input_schema_name,output_schema_name,output_schema_version,model_provider,model_name,reasoning_effort,sandbox_mode,timeout_seconds,max_concurrency,max_input_chars,workspace_ref,change_reason,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(versionId, id, versionNumber, values.role, values.objective, values.successDefinition, values.systemInstructions, values.boundaryInstructions, values.inputSchemaName, values.outputSchemaName, values.outputSchemaVersion, values.modelProvider, values.modelName, values.reasoningEffort, values.sandboxMode, values.timeoutSeconds, values.maxConcurrency, values.maxInputChars, values.workspaceRef, values.changeReason, owner.email, now),
    database.prepare("UPDATE agents SET name=?,slug=?,description=?,current_version_id=?,updated_at=? WHERE id=?").bind(boundedText(payload.name, 100, String(agent.name)), slugify(payload.slug || payload.name || agent.slug) || agent.slug, boundedText(payload.description, 4000, String(agent.description)), versionId, now, id),
    ...(agent.owner_identity_id ? [database.prepare("UPDATE identities SET display_name=?,role_title=?,updated_at=? WHERE id=?").bind(boundedText(payload.name, 100, String(agent.name)), values.role, now, agent.owner_identity_id)] : []),
    database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created agent version','agent',?,'allowed',?,?)").bind(safeId("aud"), owner.email, id, JSON.stringify({ versionId, versionNumber }), now),
  ]);
  return secureJson({ ok: true, versionId, versionNumber });
}
