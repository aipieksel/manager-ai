export class ReportError extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}

export function assertInternalChannel(channel, expectedId) {
  // Missing sharing/membership facts are unknown, never implicitly internal.
  if (!channel || channel.id !== expectedId || channel.is_archived !== false || channel.is_member !== true || channel.is_im !== false || channel.is_mpim !== false || channel.is_ext_shared !== false || channel.is_shared !== false || channel.is_pending_ext_shared !== false) throw new ReportError("report_forbidden");
  if (!Array.isArray(channel.pending_shared) || channel.pending_shared.length || !Array.isArray(channel.shared_team_ids) || channel.shared_team_ids.length > 1) throw new ReportError("report_forbidden");
  return channel;
}

export async function authorizeReport(db, request, inspectChannel, now = Date.now()) {
  const config = await db.prepare("SELECT * FROM report_configurations WHERE report_key=?").bind(request.reportKey).first();
  const s = request.source;
  if (!config || config.enabled !== 1) throw new ReportError("dependency_unavailable", 503);
  if (config.api_app_id !== s.apiAppId) throw new ReportError("report_forbidden");
  const installation = await db.prepare("SELECT id FROM slack_installations WHERE id=? AND team_id=? AND status='active'").bind(config.installation_id, s.teamId).first();
  const grant = await db.prepare("SELECT active FROM report_grants WHERE installation_id=? AND user_id=? AND report_key=? AND project_id=?").bind(config.installation_id, s.userId, request.reportKey, config.project_id).first();
  const destination = await db.prepare("SELECT enabled FROM report_channel_policies WHERE installation_id=? AND channel_id=? AND report_key=?").bind(config.installation_id, s.channelId, request.reportKey).first();
  const memberGrant = await db.prepare("SELECT active FROM report_grants WHERE installation_id=? AND user_id=? AND report_key=? AND project_id=?").bind(config.installation_id, `channel:${s.channelId}`, request.reportKey, config.project_id).first();
  if (!installation || (grant?.active !== 1 && memberGrant?.active !== 1) || destination?.enabled !== 1) throw new ReportError("report_forbidden");
  if (!config.preflight_verified_at || config.preflight_verified_at > now) throw new ReportError("dependency_unavailable", 503);
  const channel = assertInternalChannel(await inspectChannel(s.teamId, s.channelId, memberGrant?.active === 1 ? s.userId : undefined), s.channelId);
  if (memberGrant?.active === 1 && channel.requester_is_member !== true) throw new ReportError("report_forbidden");
  return config;
}
