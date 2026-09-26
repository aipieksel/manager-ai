// Shared normalized boundary; validation does not grant report access.
export const REPORT_KEY = "site.ai_referrals";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const matches = (v, pattern, max) => typeof v === "string" && v.length <= max && pattern.test(v);

export async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function invocationKey(source) {
  const parts = [source.kind, source.teamId, source.apiAppId, source.sourceEventId];
  if (source.kind === "slash_command") parts.push(source.userId, source.channelId, "/ai-referrals");
  return `slack:report:${await sha256(JSON.stringify(parts))}`;
}

export async function validateRequest(value) {
  if (!exact(value, ["schemaVersion", "action", "reportKey", "invocationKey", "source", "arguments"]) || value.schemaVersion !== 1 || value.action !== "report.request" || value.reportKey !== REPORT_KEY || !exact(value.arguments, ["mode"]) || value.arguments.mode !== "refresh_standard") throw new Error("invalid_request");
  const s = value.source;
  if (!exact(s, ["kind", "teamId", "apiAppId", "userId", "channelId", "sourceEventId", "messageTs", "rootThreadTs"]) || !["mention", "slash_command"].includes(s.kind)) throw new Error("invalid_request");
  for (const [key, pattern] of [["teamId", /^T[A-Z0-9]+$/], ["apiAppId", /^A[A-Z0-9]+$/], ["userId", /^[UW][A-Z0-9]+$/], ["channelId", /^[CG][A-Z0-9]+$/]]) {
    if (!matches(s[key], pattern, 80)) throw new Error("invalid_request");
  }
  if (s.kind === "mention") {
    if (!matches(s.sourceEventId, /^Ev[A-Za-z0-9]+$/, 180) || !matches(s.messageTs, /^[0-9]{10,}\.[0-9]{6}$/, 80) || !matches(s.rootThreadTs, /^[0-9]{10,}\.[0-9]{6}$/, 80)) throw new Error("invalid_request");
  } else if (!matches(s.sourceEventId, /^[a-f0-9]{64}$/, 64) || s.messageTs !== null || s.rootThreadTs !== null) throw new Error("invalid_request");
  if (value.invocationKey !== await invocationKey(s)) throw new Error("invalid_request");
  // Fixed order also makes equivalent JSON object ordering hash identically.
  return { schemaVersion: 1, action: "report.request", reportKey: REPORT_KEY, invocationKey: value.invocationKey, source: { kind: s.kind, teamId: s.teamId, apiAppId: s.apiAppId, userId: s.userId, channelId: s.channelId, sourceEventId: s.sourceEventId, messageTs: s.messageTs, rootThreadTs: s.rootThreadTs }, arguments: { mode: "refresh_standard" } };
}
