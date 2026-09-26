import { env } from "cloudflare:workers";
import { publicHttpsUrl, requireOwnerApi, requireSameOrigin, safeId, secureJson } from "../../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: { runnerUrl?: string };
  try { payload = await request.json(); } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const runnerUrl = publicHttpsUrl(payload.runnerUrl?.trim() ?? "");
  if (!runnerUrl) return secureJson({ error: "Enter a public HTTPS origin without a path, query, credentials or private-network address" }, { status: 400 });

  const database = (env as unknown as DatabaseEnv).DB;
  const now = Date.now();
  await database.batch([
    database.prepare("INSERT INTO runtime_settings (key, value, updated_by, updated_at) VALUES ('runner_url', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").bind(runnerUrl.origin + "/", owner.email, now),
    database.prepare("INSERT INTO audit_events (id, actor, action, object_type, object_id, result, metadata, occurred_at) VALUES (?, ?, 'Configured setup runner URL', 'runtime_setting', 'runner_url', 'saved', '{}', ?)").bind(safeId("aud"), owner.email, now),
  ]);
  return secureJson({ ok: true, runnerUrl: runnerUrl.origin });
}
