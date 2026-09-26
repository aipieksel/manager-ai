import { env } from "cloudflare:workers";
import { boundedText, parseStoredJson } from "../../operations";
import { persistRunnerState } from "../../run-persistence";
import { requireOwnerApi, requireSameOrigin, secureJson } from "../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../setup-server";

type DatabaseEnv = { DB: D1Database };

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const params = new URL(request.url).searchParams;
  const runId = params.get("runId")?.slice(0, 180) ?? "";
  const projectId = params.get("projectId")?.slice(0, 180) ?? "";
  const database = (env as unknown as DatabaseEnv).DB;
  if (runId) {
    const run = await database.prepare("SELECT r.*,a.name AS agentName,a.slug AS agentSlug,v.version_number AS agentVersion,v.output_schema_name AS outputSchemaName,x.id AS resultId,x.summary,x.structured_data AS structuredData,x.validation_status AS validationStatus,x.validation_errors AS validationErrors,x.confidence FROM agent_runs r JOIN agents a ON a.id=r.agent_id JOIN agent_versions v ON v.id=r.agent_version_id LEFT JOIN agent_results x ON x.run_id=r.id WHERE r.id=?").bind(runId).first<Record<string, unknown>>();
    if (!run) return secureJson({ error: "Run not found" }, { status: 404 });
    const events = await database.prepare("SELECT * FROM agent_run_events WHERE run_id=? ORDER BY sequence").bind(runId).all();
    if (typeof run.structuredData === "string") run.structuredData = parseStoredJson(run.structuredData, {});
    if (typeof run.validationErrors === "string") run.validationErrors = parseStoredJson(run.validationErrors, []);
    if (typeof run.input_snapshot === "string") run.input_snapshot = parseStoredJson(run.input_snapshot, {});
    return secureJson({ run, events: events.results });
  }
  const query = projectId
    ? "SELECT r.*,a.name AS agentName,v.version_number AS agentVersion,x.summary,x.validation_status AS validationStatus FROM agent_runs r JOIN agents a ON a.id=r.agent_id JOIN agent_versions v ON v.id=r.agent_version_id LEFT JOIN agent_results x ON x.run_id=r.id WHERE r.project_id=? ORDER BY r.created_at DESC LIMIT 200"
    : "SELECT r.*,a.name AS agentName,v.version_number AS agentVersion,x.summary,x.validation_status AS validationStatus FROM agent_runs r JOIN agents a ON a.id=r.agent_id JOIN agent_versions v ON v.id=r.agent_version_id LEFT JOIN agent_results x ON x.run_id=r.id ORDER BY r.created_at DESC LIMIT 200";
  const rows = await database.prepare(query).bind(...(projectId ? [projectId] : [])).all();
  return secureJson({ runs: rows.results });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const action = boundedText(payload.action, 40);
  const runId = boundedText(payload.runId, 180);
  if (action !== "reconcile" || !runId) return secureJson({ error: "Unsupported run action" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const local = await database.prepare("SELECT id,status FROM agent_runs WHERE id=?").bind(runId).first<{ id: string; status: string }>();
  if (!local) return secureJson({ error: "Run not found" }, { status: 404 });
  const { url, token, configured } = await getRunnerConfiguration();
  if (!configured || !url) return secureJson({ error: "Runner is not configured" }, { status: 503 });
  try {
    const response = await runnerFetch(url, token, `/v1/jobs/${runId}`, { signal: AbortSignal.timeout(10_000) });
    const remote = await responseJson(response);
    if (!response.ok) return secureJson({ error: "Runner job is unavailable", runnerStatus: response.status }, { status: 502 });
    const result = await persistRunnerState(database, runId, remote);
    return secureJson(result);
  } catch {
    return secureJson({ error: "Runner is unreachable" }, { status: 502 });
  }
}
