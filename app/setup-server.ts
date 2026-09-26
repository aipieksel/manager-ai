import { env } from "cloudflare:workers";
import { publicHttpsUrl, runtimeEnv } from "./server-security";

type DatabaseEnv = { DB: D1Database };

export async function getRunnerConfiguration() {
  const database = (env as unknown as DatabaseEnv).DB;
  const setting = await database.prepare("SELECT value FROM runtime_settings WHERE key = 'runner_url'").first<{ value: string }>();
  const url = setting?.value ? publicHttpsUrl(setting.value) : null;
  const token = runtimeEnv().SETUP_RUNNER_TOKEN ?? "";
  return { database, url, token, configured: Boolean(url && token) };
}

export async function runnerFetch(url: URL, token: string, path: string, init: RequestInit = {}) {
  const endpoint = new URL(path, url);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  return fetch(endpoint, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000) });
}

export async function responseJson(response: Response) {
  const text = (await response.text()).slice(0, 100_000);
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return { error: text || `Runner returned HTTP ${response.status}` }; }
}
