import { env } from "cloudflare:workers";
import { boundedText } from "../../operations";
import { requireOwnerApi, requireSameOrigin, runtimeEnv, safeId, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

async function workerFetch(path: string, init?: RequestInit) {
  const values = runtimeEnv();
  if (!values.MANAGERAI_SLACK_STATUS_URL || !values.MANAGERAI_SLACK_MANAGEMENT_TOKEN) return null;
  return fetch(new URL(path, values.MANAGERAI_SLACK_STATUS_URL), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${values.MANAGERAI_SLACK_MANAGEMENT_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
}

async function intakeFetch(path: string, init?: RequestInit) {
  const values = runtimeEnv();
  if (!values.MANAGERAI_INTAKE_STATUS_URL || !values.MANAGERAI_INTAKE_STATUS_TOKEN) return null;
  const url = new URL(values.MANAGERAI_INTAKE_STATUS_URL);
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${values.MANAGERAI_INTAKE_STATUS_TOKEN}` }, signal: AbortSignal.timeout(20_000) });
}

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const database = (env as unknown as DatabaseEnv).DB;
  const installations = await database.prepare("SELECT id,team_id,enterprise_id,workspace_name,bot_user_id,status,installed_by,installed_at,last_connected_at,last_error_code FROM slack_installations ORDER BY installed_at DESC").all();
  const channels = await database.prepare("SELECT r.*,p.name AS defaultProjectName FROM slack_channel_rules r LEFT JOIN projects p ON p.id=r.default_project_id ORDER BY r.channel_name").all();
  let worker: Record<string, unknown> = { configured: false, connected: false };
  try { const response = await workerFetch("/v1/status"); if (response?.ok) worker = await response.json() as Record<string, unknown>; else if (response) worker = { ...worker, errorCode: `http_${response.status}` }; }
  catch { worker = { ...worker, errorCode: "worker_unreachable" }; }
  return secureJson({ installations: installations.results, channels: channels.results, worker });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const database = (env as unknown as DatabaseEnv).DB;

  if (payload.action === "create_bot_handle") {
    const allowedChannel = await database.prepare("SELECT channel_id,channel_name FROM slack_channel_rules WHERE allowed=1 ORDER BY created_at LIMIT 1").first<{ channel_id: string; channel_name: string }>();
    if (!allowedChannel) return secureJson({ error: "Allow at least one Slack channel before copying a bot handle" }, { status: 409 });
    let response: Response | null = null;
    try { response = await intakeFetch("/v1/agent-contact", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "create_bot_handle" }) }); }
    catch { return secureJson({ error: "The bot-handle service is temporarily unavailable" }, { status: 503 }); }
    if (!response) return secureJson({ error: "The bot-handle service is not configured" }, { status: 503 });
    const result = await response.json() as { setupUrl?: string; principal?: string };
    let setupUrl: URL;
    try { setupUrl = new URL(result.setupUrl || ""); } catch { return secureJson({ error: "The bot-handle service returned an invalid URL" }, { status: 502 }); }
    if (!response.ok || setupUrl.origin !== "https://hooks.managerai.example.com" || setupUrl.pathname !== "/v1/agent-contact" || !setupUrl.searchParams.get("key") || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(result.principal || "")) {
      return secureJson({ error: "The bot handle could not be created" }, { status: response.ok ? 502 : response.status });
    }
    const now = Date.now();
    await database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Created one-time bot handle','contact_principal',?,'allowed',?,?)").bind(safeId("aud"), owner.email, result.principal, JSON.stringify({ channelId: allowedChannel.channel_id, channelName: allowedChannel.channel_name }), now).run();
    return secureJson({ setupUrl: setupUrl.toString() }, { status: 201 });
  }

  const botToken = boundedText(payload.botToken, 8000);
  const appToken = boundedText(payload.appToken, 8000);
  const channelRows = Array.isArray(payload.channels) ? payload.channels.slice(0, 100) as Array<Record<string, unknown>> : [];
  const allowedChannels = channelRows.map((item) => boundedText(item.id, 120)).filter(Boolean);
  // Omission preserves the worker's current general-agent grant list.
  // Report-only grants must never be forwarded into this field.
  const apiAppId = payload.apiAppId;
  if (apiAppId !== undefined && (typeof apiAppId !== "string" || !/^A[A-Z0-9]{1,79}$/.test(apiAppId))) return secureJson({ error: "Invalid Slack app ID" }, { status: 400 });
  const allowedUsers = payload.allowedUsers;
  if (allowedUsers !== undefined && (!Array.isArray(allowedUsers) || !allowedUsers.length || allowedUsers.length > 25 || allowedUsers.some((id) => typeof id !== "string" || !/^[UW][A-Z0-9]{1,79}$/.test(id)))) return secureJson({ error: "Invalid allowed users" }, { status: 400 });
  if (!botToken.startsWith("xoxb-") || !appToken.startsWith("xapp-") || !allowedChannels.length) return secureJson({ error: "Valid bot token, app token and at least one allowed channel are required" }, { status: 400 });
  const response = await workerFetch("/v1/configure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botToken, appToken, allowedChannels, ...(apiAppId === undefined ? {} : { apiAppId }), ...(allowedUsers === undefined ? {} : { allowedUsers }) }) });
  if (!response) return secureJson({ error: "Slack worker is not configured on the server" }, { status: 503 });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) return secureJson({ error: boundedText(result.error, 300, "Slack validation failed") }, { status: 502 });
  const now = Date.now();
  const existing = await database.prepare("SELECT id FROM slack_installations WHERE team_id=?").bind(result.teamId).first<{ id: string }>();
  const installationId = existing?.id || safeId("slk");
  const statements: D1PreparedStatement[] = [
    database.prepare("INSERT INTO slack_installations (id,team_id,workspace_name,bot_user_id,bot_token_secret_ref,app_token_secret_ref,status,installed_by,installed_at,last_connected_at) VALUES (?,?,?,?,?,?,'active',?,?,?) ON CONFLICT(team_id) DO UPDATE SET workspace_name=excluded.workspace_name,bot_user_id=excluded.bot_user_id,status='active',last_connected_at=excluded.last_connected_at,last_error_code=NULL").bind(installationId, result.teamId, result.workspaceName, result.botUserId, `worker:slack:${installationId}:bot`, `worker:slack:${installationId}:app`, owner.email, now, now),
    database.prepare("DELETE FROM slack_channel_rules WHERE installation_id=?").bind(installationId),
  ];
  for (const channel of channelRows) {
    const channelId = boundedText(channel.id, 120);
    if (!channelId) continue;
    statements.push(database.prepare("INSERT INTO slack_channel_rules (id,installation_id,channel_id,channel_name,allowed,default_project_id,allowed_agent_ids,allow_thread_history,allow_file_metadata,created_by,created_at,updated_at) VALUES (?,?,?,?,1,?,'[]',1,0,?,?,?)").bind(safeId("scr"), installationId, channelId, boundedText(channel.name, 160, channelId), boundedText(channel.defaultProjectId, 180) || null, owner.email, now, now));
  }
  statements.push(database.prepare("INSERT INTO audit_events (id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES (?,?,'Configured Slack Socket Mode','slack_installation',?,'active',?,?)").bind(safeId("aud"), owner.email, installationId, JSON.stringify({ channelCount: channelRows.length }), now));
  await database.batch(statements);
  return secureJson({ configured: true, installationId, workspaceName: result.workspaceName }, { status: 201 });
}
