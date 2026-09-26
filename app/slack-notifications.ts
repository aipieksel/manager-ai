import { boundedText, parseStoredJson } from "./operations";

export const SOCIAL_EVENT_TYPE = "social.post.published";
export const NOTIFICATION_EVENT_TYPE = "notification.triggered";
export const SOCIAL_PLATFORMS = new Set(["linkedin", "x"]);
export const DEFAULT_SOCIAL_TEMPLATE = "{agent} published {title} on {platform}: {url}";
export const DEFAULT_NOTIFICATION_TEMPLATE = "{agent} completed {task_name}.";
export const TRIGGER_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
export const EVENT_FAMILY_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/;
export const VARIABLE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const GENERIC_SYSTEM_VARIABLES = new Set(["agent", "platform", "platforms"]);
const LEGACY_SYSTEM_VARIABLES = new Set(["agent", "platform", "title", "url", "summary"]);
const RESERVED_VARIABLES = new Set([
  "authority", "idempotency_key", "principal", "trigger", "trigger_key", "type",
]);
const CREDENTIAL_MARKERS = [
  "-----begin private key-----", "-----begin openssh private key-----", "password=",
  "secret=", "token=", "api_key=", "apikey=", "authorization: bearer ", "cookie:", "set-cookie:",
];

export type SocialPostEvent = {
  principalId: string;
  platform: "linkedin" | "x";
  postUrl: string;
  title: string;
  summary: string;
  publishedAt?: number;
};

export type NotificationTriggeredEvent = {
  principalId: string;
  triggerKey: string;
  platforms: Array<"linkedin" | "x">;
  variables: Record<string, string>;
};

export type SlackNotificationRoute = {
  id: string;
  principal_id: string;
  display_name: string;
  event_type: string;
  trigger_key: string;
  event_family: string;
  description: string;
  slack_channel_id: string;
  allowed_platforms: string;
  variable_names: string;
  message_template: string;
  enabled: number | boolean;
};

function acceptedSocialUrl(platform: string, value: unknown) {
  const raw = boundedText(value, 2000);
  let url: URL;
  try { url = new URL(raw); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (platform === "linkedin" && hostname !== "linkedin.com" && !hostname.endsWith(".linkedin.com")) return "";
  if (platform === "x" && !["x.com", "twitter.com"].includes(hostname) && !hostname.endsWith(".x.com") && !hostname.endsWith(".twitter.com")) return "";
  return url.toString();
}

export function containsCredentialMaterial(value: string) {
  const normalized = value.toLowerCase();
  return CREDENTIAL_MARKERS.some((marker) => normalized.includes(marker));
}

export function parseSocialPostEvent(payload: Record<string, unknown>, principalId: string): SocialPostEvent | null {
  const platform = boundedText(payload.platform, 20).toLowerCase();
  const postUrl = acceptedSocialUrl(platform, payload.post_url);
  const title = boundedText(payload.title, 240);
  const summary = boundedText(payload.summary, 1200);
  const publishedAt = typeof payload.published_at === "number" && Number.isFinite(payload.published_at) ? payload.published_at : undefined;
  if (!principalId || !SOCIAL_PLATFORMS.has(platform) || !postUrl || !title || containsCredentialMaterial(`${title}\n${summary}`)) return null;
  return { principalId, platform: platform as SocialPostEvent["platform"], postUrl, title, summary, publishedAt };
}

export function analyzeNotificationTemplate(templateValue: unknown, eventType = NOTIFICATION_EVENT_TYPE) {
  const raw = typeof templateValue === "string" ? templateValue.trim() : "";
  if (!raw) return { ok: false as const, error: "Message template is required", variables: [] as string[] };
  if (raw.length > 3500) return { ok: false as const, error: "Message template must be 3500 characters or fewer", variables: [] as string[] };
  const systemVariables = eventType === SOCIAL_EVENT_TYPE ? LEGACY_SYSTEM_VARIABLES : GENERIC_SYSTEM_VARIABLES;
  const tokens = [...raw.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  const stripped = raw.replaceAll(/\{[^{}]+\}/g, "");
  if (/[{}]/.test(stripped)) return { ok: false as const, error: "Template braces must contain one snake_case variable name", variables: [] as string[] };
  for (const token of tokens) {
    if (!VARIABLE_KEY_PATTERN.test(token)) return { ok: false as const, error: `Invalid template variable: {${token}}`, variables: [] as string[] };
    if (RESERVED_VARIABLES.has(token)) return { ok: false as const, error: `Reserved protocol field cannot be a template variable: {${token}}`, variables: [] as string[] };
  }
  const variables = [...new Set(tokens.filter((token) => !systemVariables.has(token)))].sort();
  if (variables.length > 24) return { ok: false as const, error: "A contract may declare at most 24 message variables", variables: [] as string[] };
  return { ok: true as const, template: raw, variables };
}

export function parseNotificationTriggeredEvent(payload: Record<string, unknown>, principalId: string): NotificationTriggeredEvent | null {
  const triggerKey = typeof payload.trigger === "string" ? payload.trigger.trim() : "";
  if (!principalId || !TRIGGER_KEY_PATTERN.test(triggerKey)) return null;
  const platformInput = payload.platforms;
  if (platformInput !== undefined && !Array.isArray(platformInput)) return null;
  const platforms = platformInput === undefined ? [] : [...new Set(platformInput.map((value) => typeof value === "string" ? value.trim().toLowerCase() : ""))];
  if (platforms.length > 2 || platforms.some((platform) => !SOCIAL_PLATFORMS.has(platform))) return null;
  const input = payload.variables ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 24) return null;
  const variables: Record<string, string> = {};
  let totalLength = 0;
  for (const [key, value] of entries) {
    if (!VARIABLE_KEY_PATTERN.test(key) || RESERVED_VARIABLES.has(key) || GENERIC_SYSTEM_VARIABLES.has(key)) return null;
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) return null;
    const rendered = String(value);
    totalLength += rendered.length;
    if (rendered.length > 1200 || totalLength > 8000 || containsCredentialMaterial(rendered)) return null;
    variables[key] = rendered;
  }
  return { principalId, triggerKey, platforms: platforms as NotificationTriggeredEvent["platforms"], variables };
}

export function routeAllowsPlatform(route: SlackNotificationRoute, platform: string) {
  return parseStoredJson<string[]>(route.allowed_platforms, []).includes(platform);
}

export function routeAllowsTriggeredEvent(route: SlackNotificationRoute, event: NotificationTriggeredEvent) {
  const allowed = parseStoredJson<string[]>(route.allowed_platforms, []);
  return !allowed.length || (event.platforms.length > 0 && event.platforms.every((platform) => allowed.includes(platform)));
}

function platformLabel(platform: string) { return platform === "linkedin" ? "LinkedIn" : "X"; }

export function renderSocialNotification(route: SlackNotificationRoute, event: SocialPostEvent) {
  const replacements: Record<string, string> = {
    agent: boundedText(route.display_name, 120, event.principalId),
    platform: platformLabel(event.platform),
    title: event.title,
    url: event.postUrl,
    summary: event.summary,
  };
  let rendered = boundedText(route.message_template, 3500, DEFAULT_SOCIAL_TEMPLATE);
  for (const [token, value] of Object.entries(replacements)) rendered = rendered.replaceAll(`{${token}}`, value);
  return rendered.trim().slice(0, 3500);
}

export function renderTriggeredNotification(route: SlackNotificationRoute, event: NotificationTriggeredEvent) {
  const analysis = analyzeNotificationTemplate(route.message_template, NOTIFICATION_EVENT_TYPE);
  if (!analysis.ok) return null;
  const configured = parseStoredJson<string[]>(route.variable_names, []).slice().sort();
  const supplied = Object.keys(event.variables).sort();
  if (JSON.stringify(configured) !== JSON.stringify(analysis.variables) || JSON.stringify(supplied) !== JSON.stringify(configured)) return null;
  const labels = event.platforms.map(platformLabel);
  const platformText = labels.length === 2 ? `${labels[0]} and ${labels[1]}` : labels[0] || "";
  const replacements: Record<string, string> = {
    agent: boundedText(route.display_name, 120, event.principalId),
    platform: platformText,
    platforms: platformText,
    ...event.variables,
  };
  let rendered = analysis.template;
  for (const [token, value] of Object.entries(replacements)) rendered = rendered.replaceAll(`{${token}}`, value);
  return rendered.trim().slice(0, 3500);
}

export async function postAssistantNotification(channelId: string, text: string, idempotencyKey: string) {
  const { runtimeEnv } = await import("./server-security");
  const values = runtimeEnv();
  if (!values.MANAGERAI_SLACK_STATUS_URL || !values.MANAGERAI_SLACK_MANAGEMENT_TOKEN) return { ok: false as const, status: 503, error: "Slack worker is not configured" };
  let response: Response;
  try {
    response = await fetch(new URL("/v1/notify", values.MANAGERAI_SLACK_STATUS_URL), {
      method: "POST",
      headers: { authorization: `Bearer ${values.MANAGERAI_SLACK_MANAGEMENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ channel: channelId, text, idempotencyKey }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch { return { ok: false as const, status: 502, error: "Slack worker could not be reached" }; }
  let result: Record<string, unknown> = {};
  try { result = await response.json() as Record<string, unknown>; } catch { result = {}; }
  if (!response.ok) return { ok: false as const, status: 502, error: boundedText(result.error, 240, "Slack rejected the notification") };
  return { ok: true as const, status: 202, slackTs: boundedText(result.ts, 80) };
}
