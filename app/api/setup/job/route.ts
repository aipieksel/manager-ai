import { requireOwnerApi, secureJson } from "../../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../../setup-server";

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const runId = new URL(request.url).searchParams.get("runId") ?? "";
  if (!/^setup_[a-f0-9]{32}$/.test(runId)) return secureJson({ error: "Invalid run id" }, { status: 400 });
  const { database, url, token, configured } = await getRunnerConfiguration();
  const local = await database.prepare("SELECT id, job, status, output, created_at as createdAt, completed_at as completedAt FROM setup_job_runs WHERE id = ?").bind(runId).first<{ id: string; job: string; status: string; output: string; createdAt: number; completedAt: number | null }>();
  if (!local) return secureJson({ error: "Setup job not found" }, { status: 404 });
  if (!configured || !url || ["succeeded", "failed"].includes(local.status)) return secureJson({ run: local });

  try {
    const response = await runnerFetch(url, token, `/v1/jobs/${runId}`, { signal: AbortSignal.timeout(7_000) });
    const remote = await responseJson(response);
    if (!response.ok) return secureJson({ run: local, runnerError: remote });
    const status = ["queued", "running", "succeeded", "failed"].includes(String(remote.status)) ? String(remote.status) : "running";
    const output = String(remote.output ?? "").slice(0, 100_000);
    const completedAt = ["succeeded", "failed"].includes(status) ? Number(remote.completedAt) || Date.now() : null;
    await database.prepare("UPDATE setup_job_runs SET status = ?, runner_status = ?, output = ?, completed_at = ? WHERE id = ?").bind(status, response.status, output, completedAt, runId).run();
    return secureJson({ run: { ...local, status, output, completedAt } });
  } catch {
    return secureJson({ run: local, runnerError: { error: "Runner is unreachable" } });
  }
}
