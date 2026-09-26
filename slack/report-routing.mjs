import { REPORT_KEY, invocationKey, sha256, validateRequest } from "../app/reports/request.mjs";

export const REPORT_HELP = "Use /ai-referrals or mention Assistant with ‘generate AI referral report’ to request the standard historical workbook. Custom date ranges are not supported.";

export async function routeReport(envelope, installation) {
  const p = envelope?.payload;
  if (!p || !installation || p.team_id !== installation.teamId || p.api_app_id !== installation.apiAppId) return { kind: "unrelated" };
  let source;
  if (envelope.type === "slash_commands" && p.command === "/ai-referrals") {
    const text = typeof p.text === "string" ? p.text.trim().toLowerCase() : "";
    if (text) return { kind: "help", text: REPORT_HELP };
    if (typeof p.trigger_id !== "string" || !p.trigger_id || p.trigger_id.length > 512) return { kind: "invalid" };
    source = { kind: "slash_command", teamId: p.team_id, apiAppId: p.api_app_id, userId: p.user_id, channelId: p.channel_id, sourceEventId: await sha256(p.trigger_id), messageTs: null, rootThreadTs: null };
  } else if (envelope.type === "events_api" && p.event?.type === "app_mention") {
    const e = p.event;
    if (e.bot_id || e.subtype || e.user === installation.botUserId || typeof e.text !== "string" || e.text.length > 2000) return { kind: "unrelated" };
    const marker = `<@${installation.botUserId}>`;
    if (!e.text.includes(marker)) return { kind: "unrelated" };
    const text = e.text.replace(marker, "").trim().replace(/\s+/g, " ").toLowerCase();
    if (!/^(?:please )?generate (?:the )?ai referral report(?:,? please)?[.!]?$/.test(text)) return /ai\s+referral/i.test(text) ? { kind: "help", text: REPORT_HELP } : { kind: "unrelated" };
    source = { kind: "mention", teamId: p.team_id, apiAppId: p.api_app_id, userId: e.user, channelId: e.channel, sourceEventId: p.event_id, messageTs: e.ts, rootThreadTs: e.thread_ts || e.ts };
  } else return { kind: "unrelated" };
  try {
    return { kind: "request", request: await validateRequest({ schemaVersion: 1, action: "report.request", reportKey: REPORT_KEY, invocationKey: await invocationKey(source), source, arguments: { mode: "refresh_standard" } }) };
  } catch { return { kind: "invalid" }; }
}
