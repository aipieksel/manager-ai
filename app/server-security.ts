import { env } from "cloudflare:workers";
import { getChatGPTUser } from "./chatgpt-auth";

type RuntimeEnv = {
  OWNER_EMAIL?: string;
  LOCAL_PROXY_SECRET?: string;
  AGENT_WEBHOOK_SECRET?: string;
  MANAGER_RUNTIME_URL?: string;
  MANAGER_RUNTIME_TOKEN?: string;
  MANAGERAI_REPORT_RUNTIME_URL?: string;
  MANAGERAI_REPORT_RUNTIME_TOKEN?: string;
  SETUP_RUNNER_TOKEN?: string;
  RUNTIME_CALLBACK_SECRET?: string;
  INTAKE_FORWARD_SECRET?: string;
  MANAGERAI_INTAKE_STATUS_URL?: string;
  MANAGERAI_INTAKE_STATUS_TOKEN?: string;
  SLACK_BRIDGE_SECRET?: string;
  MANAGERAI_SLACK_STATUS_URL?: string;
  MANAGERAI_SLACK_MANAGEMENT_TOKEN?: string;
  PROJECT_AGENT_RUNTIME_URL?: string;
  PROJECT_AGENT_RUNTIME_TOKEN?: string;
  PROJECT_AGENT_CALLBACK_SECRET?: string;
  PUBLIC_PORTAL_ORIGIN?: string;
};

export function runtimeEnv(): RuntimeEnv {
  return env as unknown as RuntimeEnv;
}

export async function requireOwnerApi(): Promise<
  | { ok: true; email: string; displayName: string; subject: string; authMode: "github" | "chatgpt" | "development" }
  | { ok: false; response: Response }
> {
  const user = await getChatGPTUser();
  if (!user) return { ok: false, response: secureJson({ error: "Authentication required" }, { status: 401 }) };

  const configuredOwner = runtimeEnv().OWNER_EMAIL?.trim().toLowerCase();
  if (user.authMode !== "github" && configuredOwner && user.email.trim().toLowerCase() !== configuredOwner) {
    return { ok: false, response: secureJson({ error: "Owner access required" }, { status: 403 }) };
  }

  return { ok: true, email: user.email, displayName: user.displayName, subject: user.subject, authMode: user.authMode };
}

export function secureJson(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(payload, { ...init, headers });
}

export function requireSameOrigin(request: Request): Response | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return secureJson({ error: "Cross-site write rejected" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (!origin) return secureJson({ error: "Origin header required" }, { status: 403 });

  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return secureJson({ error: "Invalid request URL" }, { status: 400 });
  }

  const configuredOrigin = runtimeEnv().PUBLIC_PORTAL_ORIGIN?.trim();
  let publicOrigin = "";
  if (configuredOrigin) {
    try { publicOrigin = new URL(configuredOrigin).origin; } catch { publicOrigin = ""; }
  }

  if (origin !== requestOrigin && origin !== publicOrigin) {
    return secureJson({ error: "Cross-origin write rejected" }, { status: 403 });
  }

  return null;
}

export function safeId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function verifyTimestampedHmac(secret: string, timestamp: string, rawBody: string, providedHeader: string | null) {
  const unixSeconds = Number(timestamp);
  if (!secret || !Number.isFinite(unixSeconds) || Math.abs(Date.now() / 1000 - unixSeconds) > 300) return false;
  const provided = (providedHeader ?? "").replace(/^sha256=/, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(provided)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  const expected = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  return mismatch === 0;
}

export function publicHttpsUrl(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return null;
  if (hostname === "0.0.0.0" || hostname === "[::]" || hostname === "[::1]" || /^\[(fc|fd|fe8|fe9|fea|feb)/.test(hostname)) return null;
  if (/^(10|127)\./.test(hostname) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) return null;
  const private172 = hostname.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return null;
  return url;
}
