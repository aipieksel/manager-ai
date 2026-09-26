import { env } from "cloudflare:workers";
import { boundedText } from "../../../operations";
import { persistRunnerState } from "../../../run-persistence";
import { runtimeEnv, secureJson, verifyTimestampedHmac } from "../../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 200_000) return secureJson({ error: "Payload too large" }, { status: 413 });
  const secret = runtimeEnv().RUNTIME_CALLBACK_SECRET ?? "";
  const timestamp = request.headers.get("x-managerai-timestamp") ?? "";
  if (!(await verifyTimestampedHmac(secret, timestamp, rawBody, request.headers.get("x-managerai-signature")))) return secureJson({ error: "Invalid callback signature" }, { status: 401 });
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody) as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const runId = boundedText(payload.id, 180);
  if (!/^run_[a-f0-9]{32}$/.test(runId)) return secureJson({ error: "Invalid run id" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const result = await persistRunnerState(database, runId, payload);
  if (!result.ok) return secureJson({ error: result.error }, { status: result.status });
  return secureJson({ accepted: true, runId, status: result.status }, { status: 202 });
}
