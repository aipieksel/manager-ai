import { env } from "cloudflare:workers";
import { boundedText } from "../../operations";
import { dispatchProjectMessage, projectRuntimeConfigured } from "../../project-message-dispatch";
import { requireOwnerApi, requireSameOrigin, secureJson } from "../../server-security";

type DatabaseEnv = { DB: D1Database };

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const projectId = new URL(request.url).searchParams.get("projectId")?.slice(0, 180) ?? "";
  if (!projectId) return secureJson({ error: "projectId is required" }, { status: 400 });
  const database = (env as unknown as DatabaseEnv).DB;
  const project = await database.prepare("SELECT id,name,default_agent_id AS defaultAgentId FROM projects WHERE id=? AND archived_at IS NULL").bind(projectId).first();
  if (!project) return secureJson({ error: "Project not found" }, { status: 404 });
  const conversations = await database.prepare("SELECT * FROM conversations WHERE project_id=? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 50").bind(projectId).all();
  const conversationId = new URL(request.url).searchParams.get("conversationId")?.slice(0, 180) || String(conversations.results[0]?.id || "");
  const messages = conversationId ? await database.prepare("SELECT * FROM conversation_messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT 500").bind(conversationId).all() : { results: [] };
  return secureJson({ project, conversations: conversations.results, conversationId, messages: messages.results, runtimeConfigured: projectRuntimeConfigured() });
}

export async function POST(request: Request) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  let payload: Record<string, unknown>;
  try { payload = await request.json() as Record<string, unknown>; } catch { return secureJson({ error: "Invalid JSON" }, { status: 400 }); }
  const projectId = boundedText(payload.projectId, 180);
  const body = boundedText(payload.body, 20_000);
  if (!projectId || !body) return secureJson({ error: "projectId and body are required" }, { status: 400 });
  const result = await dispatchProjectMessage({
    database: (env as unknown as DatabaseEnv).DB,
    projectId,
    requestedConversationId: boundedText(payload.conversationId, 180),
    taskId: boundedText(payload.taskId, 180),
    forceNewConversation: payload.newConversation === true,
    body,
    actorRef: owner.email,
    authorType: "owner",
    sourceType: "owner_chat",
    authority: ["owner_authenticated_chat"],
  });
  return secureJson(result.ok ? { conversationId: result.conversationId, messageId: result.messageId, runId: result.runId, status: result.runStatus } : { error: result.error, conversationId: result.conversationId, messageId: result.messageId, runId: result.runId }, { status: result.status });
}
