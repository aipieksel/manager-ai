import { reportPreflight, inspectReportChannel } from "../../../reports/server";
import { assertInternalChannel } from "../../../reports/policy.mjs";
import { env } from 'cloudflare:workers';
import { requireOwnerApi, requireSameOrigin, secureJson } from '../../../server-security';
import { saveConfiguration, REPORT_KEY } from '../../../reports/configuration.mjs';
export async function GET() {
  const owner=await requireOwnerApi();if(!owner.ok)return owner.response;
  const db=(env as unknown as {DB:D1Database}).DB;
  const [configuration,grants,channels]=await Promise.all([
    db.prepare('SELECT * FROM report_configurations WHERE report_key=?').bind(REPORT_KEY).first(),
    db.prepare('SELECT user_id FROM report_grants WHERE report_key=? AND active=1').bind(REPORT_KEY).all(),
    db.prepare('SELECT channel_id FROM report_channel_policies WHERE report_key=? AND enabled=1').bind(REPORT_KEY).all(),
  ]);
  return secureJson({configuration,userIds:grants.results.map(r=>String(r.user_id)).filter(id=>!id.startsWith("channel:")),memberChannelIds:grants.results.map(r=>String(r.user_id)).filter(id=>id.startsWith("channel:")).map(id=>id.slice(8)),channelIds:channels.results.map(r=>r.channel_id)});
}
export async function POST(request:Request) {
  const origin=requireSameOrigin(request);if(origin)return origin;
  const owner=await requireOwnerApi();if(!owner.ok)return owner.response;
  const db=(env as unknown as {DB:D1Database}).DB;
  try {
    const raw=await request.text();if(raw.length>16_000)return secureJson({error:'Payload too large'},{status:413});
    const payload=JSON.parse(raw);
    if(payload.action==='validate_enable') {
      const config=await db.prepare('SELECT * FROM report_configurations WHERE report_key=?').bind(REPORT_KEY).first<Record<string,unknown>>();
      if(!config)return secureJson({error:'Save report configuration first'},{status:409});
      const proof=await reportPreflight();const now=Date.now();
      const mapping:Record<string,string>={projectId:'project_id',installationId:'installation_id',apiAppId:'api_app_id',executorId:'executor_id',executorVersionId:'executor_version_id',referenceId:'reference_id',referenceSha256:'reference_sha256',sourceConfigId:'source_config_id',revision:'revision'};
      if(proof.verified!==true || typeof proof.verifiedAt!=='number' || proof.verifiedAt>now || now-proof.verifiedAt>86_400_000 || Object.entries(mapping).some(([key,column])=>proof[key]!==config[column]))return secureJson({error:'Runtime preflight does not match this report configuration'},{status:409});
      const installation=await db.prepare("SELECT team_id FROM slack_installations WHERE id=? AND status='active'").bind(config.installation_id).first<{team_id:string}>();
      if(!installation)return secureJson({error:'Slack installation is not active'},{status:409});
      const channels=await db.prepare('SELECT channel_id FROM report_channel_policies WHERE installation_id=? AND report_key=? AND enabled=1').bind(config.installation_id,REPORT_KEY).all<{channel_id:string}>();
      if(!channels.results.length)return secureJson({error:'Configure report channels first'},{status:409});
      for(const channel of channels.results)assertInternalChannel(await inspectReportChannel(installation.team_id,channel.channel_id),channel.channel_id);
      await db.batch([
        db.prepare('UPDATE report_configurations SET enabled=1,preflight_verified_at=?,updated_at=? WHERE report_key=? AND revision=?').bind(proof.verifiedAt,now,REPORT_KEY,config.revision),
        db.prepare("INSERT INTO audit_events(id,actor,action,object_type,object_id,result,metadata,occurred_at) SELECT ?,?,'Enabled verified report configuration','report_configuration',report_key,'enabled','{}',? FROM report_configurations WHERE report_key=? AND revision=? AND enabled=1").bind(`aud_${crypto.randomUUID()}`,owner.email,now,REPORT_KEY,config.revision),
      ]);
      const current=await db.prepare('SELECT enabled,revision FROM report_configurations WHERE report_key=?').bind(REPORT_KEY).first<{enabled:number;revision:number}>();
      if(current?.enabled!==1 || current.revision!==config.revision)return secureJson({error:'Configuration changed during verification'},{status:409});
      return secureJson({enabled:true});
    }
    if(payload.action==='disable') {
      await db.prepare('UPDATE report_configurations SET enabled=0,revision=revision+1,preflight_verified_at=NULL,updated_at=? WHERE report_key=?').bind(Date.now(),REPORT_KEY).run();
      return secureJson({enabled:false});
    }
    if(payload.action!=='save_draft')return secureJson({error:'Unsupported report configuration action'},{status:400});
    await saveConfiguration(db,payload.configuration,owner.email);
    return secureJson({saved:true,enabled:false});
  }catch(error){const failure=error as {code?:string;status?:number};return secureJson({error:failure.code||'Report configuration unavailable'},{status:failure.status||503});}
}
