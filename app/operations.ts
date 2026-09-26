export const projectStatuses = new Set(["proposed", "active", "on_hold", "completed", "archived"]);
export const planStatuses = new Set(["draft", "in_review", "approved", "rejected", "superseded", "archived"]);
export const taskStatuses = new Set(["backlog", "ready", "in_progress", "blocked", "in_review", "done", "cancelled"]);
export const priorities = new Set(["critical", "high", "normal", "low"]);
export const agentLifecycles = new Set(["draft", "active", "paused", "archived"]);
export const reasoningEfforts = new Set(["low", "medium", "high", "xhigh"]);
export const sandboxModes = new Set(["read_only", "workspace_write"]);

export function boundedText(value: unknown, maximum: number, fallback = "") {
  return typeof value === "string" ? value.trim().slice(0, maximum) : fallback;
}

export function nullableText(value: unknown, maximum: number) {
  const text = boundedText(value, maximum);
  return text || null;
}

export function slugify(value: unknown) {
  return boundedText(value, 100).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export function jsonArray(value: unknown, maximumItems = 100, maximumItemLength = 4000) {
  if (!Array.isArray(value)) return "[]";
  return JSON.stringify(value.slice(0, maximumItems).map((item) => {
    if (typeof item === "string") return item.slice(0, maximumItemLength);
    if (item && typeof item === "object") return item;
    return String(item).slice(0, maximumItemLength);
  }));
}

export function jsonObject(value: unknown, maximumLength = 100_000) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const encoded = JSON.stringify(value);
  return encoded.length <= maximumLength ? encoded : "{}";
}

export function timestamp(value: unknown) {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value ? Date.parse(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function parseStoredJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}

export function safeUrl(value: unknown) {
  const input = boundedText(value, 2000);
  if (!input) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
