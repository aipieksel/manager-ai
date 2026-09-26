import { ReportError } from './policy.mjs';
export const REPORT_KEY='site.ai_referrals';
const fields=['projectId','installationId','apiAppId','executorId','executorVersionId','referenceId','referenceSha256','sourceConfigId'];
export function validateConfiguration(input) {
  if(!input || typeof input!=='object' || Object.keys(input).some(k=>!fields.includes(k)&&!['userIds','channelIds','memberChannelIds'].includes(k))) throw new ReportError('invalid_report_configuration',400);
  for(const field of fields) if(typeof input[field]!=='string' || !(field==='referenceSha256'?/^[a-f0-9]{64}$/:/^[A-Za-z0-9_-]{1,180}$/).test(input[field])) throw new ReportError('invalid_report_configuration',400);
  if(!/^A[A-Z0-9]+$/.test(input.apiAppId)) throw new ReportError('invalid_report_configuration',400);
  for(const [key,pattern] of [['userIds',/^[UW][A-Z0-9]{1,79}$/],['channelIds',/^[CG][A-Z0-9]{1,79}$/]]) {
    if(!Array.isArray(input[key])||(key==='channelIds'&&!input[key].length)||input[key].length>100||new Set(input[key]).size!==input[key].length||input[key].some(v=>typeof v!=='string'||!pattern.test(v))) throw new ReportError('invalid_report_configuration',400);
  }
  const members=input.memberChannelIds ?? [];
  if(!Array.isArray(members)||members.length>100||new Set(members).size!==members.length||members.some(id=>!input.channelIds.includes(id))||(!input.userIds.length&&!members.length))throw new ReportError('invalid_report_configuration',400);
  return input;
}
export async function saveConfiguration(db,input,owner,now=Date.now()) {
  const c=validateConfiguration(input);
  const project=await db.prepare('SELECT id FROM projects WHERE id=? AND archived_at IS NULL').bind(c.projectId).first();
  const agent=await db.prepare("SELECT a.id FROM agents a JOIN agent_versions v ON v.id=a.current_version_id WHERE a.id=? AND v.id=? AND a.lifecycle_status='active' AND a.archived_at IS NULL").bind(c.executorId,c.executorVersionId).first();
  const installation=await db.prepare("SELECT id FROM slack_installations WHERE id=? AND status='active'").bind(c.installationId).first();
  if(!project||!agent||!installation) throw new ReportError('report_dependency_unavailable',409);
  await db.batch([
    db.prepare(`INSERT INTO report_configurations(report_key,project_id,installation_id,api_app_id,executor_id,executor_version_id,reference_id,reference_sha256,source_config_id,enabled,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(report_key) DO UPDATE SET project_id=excluded.project_id,installation_id=excluded.installation_id,api_app_id=excluded.api_app_id,executor_id=excluded.executor_id,executor_version_id=excluded.executor_version_id,reference_id=excluded.reference_id,reference_sha256=excluded.reference_sha256,source_config_id=excluded.source_config_id,enabled=0,preflight_verified_at=NULL,revision=revision+1,updated_at=excluded.updated_at`)
      .bind(REPORT_KEY,c.projectId,c.installationId,c.apiAppId,c.executorId,c.executorVersionId,c.referenceId,c.referenceSha256,c.sourceConfigId,now),
    db.prepare('UPDATE report_grants SET active=0,reviewed_by=?,updated_at=? WHERE report_key=?').bind(owner,now,REPORT_KEY),
    db.prepare('UPDATE report_channel_policies SET enabled=0,reviewed_by=?,reviewed_at=? WHERE report_key=?').bind(owner,now,REPORT_KEY),
    ...[...c.userIds,...(c.memberChannelIds??[]).map(channel=>`channel:${channel}`)].map(user=>db.prepare(`INSERT INTO report_grants VALUES(?,?,?,?,1,?,?) ON CONFLICT(installation_id,user_id,report_key,project_id) DO UPDATE SET active=1,reviewed_by=excluded.reviewed_by,updated_at=excluded.updated_at`).bind(c.installationId,user,REPORT_KEY,c.projectId,owner,now)),
    ...c.channelIds.map(channel=>db.prepare(`INSERT INTO report_channel_policies VALUES(?,?,?,1,?,?) ON CONFLICT(installation_id,channel_id,report_key) DO UPDATE SET enabled=1,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at`).bind(c.installationId,channel,REPORT_KEY,owner,now)),
    db.prepare("INSERT INTO audit_events(id,actor,action,object_type,object_id,result,metadata,occurred_at) VALUES(?,?,'Saved disabled report configuration','report_configuration',?,'draft','{}',?)").bind(`aud_${crypto.randomUUID()}`,owner,REPORT_KEY,now),
  ]);
}
