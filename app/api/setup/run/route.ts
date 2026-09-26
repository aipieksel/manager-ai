import { requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../../setup-server";

const jobs = new Set(["preflight", "install_dependencies", "install_codex", "verify_codex", "prepare_manager", "health_check"]);

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: { job?: string };
  try { payload = await request.json(); } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const job = payload.job ?? "";
  if (!jobs.has(job)) return secureJson({ error: "Unsupported setup job" }, { status: 400 });
  const { database, url, token, configured } = await getRunnerConfiguration();
  if (!configured || !url) return secureJson({ error: "Connect the setup runner first" }, { status: 503 });

  const runId = safeId("setup");
  const now = Date.now();
  await database.prepare("INSERT INTO setup_job_runs (id, job, status, requested_by, output, created_at) VALUES (?, ?, 'queued', ?, '', ?)").bind(runId, job, owner.email, now).run();
  try {
    const response = await runnerFetch(url, token, `/v1/jobs/${job}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: runId, requestedBy: owner.email }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await responseJson(response);
    if (!response.ok) {
      await database.prepare("UPDATE setup_job_runs SET status = 'failed', runner_status = ?, output = ?, completed_at = ? WHERE id = ?").bind(response.status, JSON.stringify(result).slice(0, 100_000), Date.now(), runId).run();
      return secureJson({ error: "Runner rejected the setup job", details: result }, { status: 502 });
    }
    await database.prepare("UPDATE setup_job_runs SET status = 'running', runner_status = ? WHERE id = ?").bind(response.status, runId).run();
    return secureJson({ accepted: true, runId, job }, { status: 202 });
  } catch {
    await database.prepare("UPDATE setup_job_runs SET status = 'failed', output = 'Runner request failed', completed_at = ? WHERE id = ?").bind(Date.now(), runId).run();
    return secureJson({ error: "Setup runner is unreachable" }, { status: 502 });
  }
}
