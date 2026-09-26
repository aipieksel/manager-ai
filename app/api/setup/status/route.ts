import { requireOwnerApi, secureJson } from "../../../server-security";
import { getRunnerConfiguration, responseJson, runnerFetch } from "../../../setup-server";

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const { database, url, token, configured } = await getRunnerConfiguration();
  const jobs = await database.prepare("SELECT id, job, status, output, created_at as createdAt, completed_at as completedAt FROM setup_job_runs ORDER BY created_at DESC LIMIT 8").all<{ id: string; job: string; status: string; output: string; createdAt: number; completedAt: number | null }>();

  if (!configured || !url) return secureJson({ configured: false, runnerUrl: url?.origin ?? "", tokenConfigured: Boolean(token), connected: false, health: null, jobs: jobs.results });
  try {
    const response = await runnerFetch(url, token, "/v1/health", { signal: AbortSignal.timeout(7_000) });
    const health = await responseJson(response);
    return secureJson({ configured: true, runnerUrl: url.origin, tokenConfigured: true, connected: response.ok && health.status === "online", health, jobs: jobs.results });
  } catch {
    return secureJson({ configured: true, runnerUrl: url.origin, tokenConfigured: true, connected: false, health: { status: "unreachable" }, jobs: jobs.results });
  }
}
