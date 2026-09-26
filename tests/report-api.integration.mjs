import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import {databaseFixture} from './report-database.mjs';
const db=databaseFixture();
globalThis.__CLOUDFLARE_TEST_ENV__={OWNER_EMAIL:'owner@example.com',DB:db};
const worker=(await import('../dist/server/index.js')).default;
const runtime={ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
const context={waitUntil(){},passThroughOnException(){}};
const owner={'oai-authenticated-user-email':'owner@example.com'};
const call=(path,options={})=>worker.fetch(new Request('http://localhost'+path,options),runtime,context);
test.after(()=>db.sqlite.close());
test('report settings require owner authentication and same-origin writes',async()=>{
  assert.equal((await call('/api/slack/reports')).status,401);
  assert.equal((await call('/api/slack/reports',{headers:{'oai-authenticated-user-email':'other@example.com'}})).status,403);
  assert.equal((await call('/api/slack/reports',{method:'POST',headers:{...owner,origin:'https://foreign.example'},body:'{"action":"disable"}'})).status,403);
  const result=await call('/api/slack/reports',{headers:owner});assert.equal(result.status,200);
  assert.equal((await result.json()).configuration,null);
});
test('unsigned report bridge calls cannot create or claim reports',async()=>{
  for(const action of ['report.request','report.reconcile','report.delivery.claim']){
    const response=await call('/api/slack/bridge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});
    assert.equal(response.status,401);
  }
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_jobs').get().n,0);
});
test('owner cannot enable a report before configuration and reviewed runtime preflight',async()=>{
  const response=await call('/api/slack/reports',{method:'POST',headers:{...owner,origin:'http://localhost','content-type':'application/json'},body:'{"action":"validate_enable"}'});
  assert.equal(response.status,409);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_configurations').get().n,0);
});

test('signed report request uses compatible private transport and refuses redirects',async()=>{
  const values=globalThis.__CLOUDFLARE_TEST_ENV__;
  Object.assign(values,{SLACK_BRIDGE_SECRET:'report-fixture-secret',MANAGERAI_SLACK_STATUS_URL:'http://172.17.0.1:13008/v1/status',MANAGERAI_SLACK_MANAGEMENT_TOKEN:'fixture-management-token'});
  const request=JSON.parse(fs.readFileSync(new URL('../app/reports/examples/synthetic-request.example.json',import.meta.url)));
  const now=Date.now();
  db.sqlite.prepare("INSERT INTO slack_installations(id,team_id,workspace_name,bot_token_secret_ref,app_token_secret_ref,status,installed_by,installed_at) VALUES('installation',?,'fixture','private','private','active','fixture',?)").run(request.source.teamId,now);
  db.sqlite.prepare("INSERT INTO report_configurations(report_key,project_id,installation_id,api_app_id,executor_id,executor_version_id,reference_id,reference_sha256,source_config_id,enabled,preflight_verified_at,updated_at) VALUES(?,'project','installation',?,'executor','version','reference',?,'source',1,?,?)").run(request.reportKey,request.source.apiAppId,'a'.repeat(64),now,now);
  db.sqlite.prepare("INSERT INTO report_grants VALUES('installation',?,?,'project',1,'owner',?)").run(request.source.userId,request.reportKey,now);
  db.sqlite.prepare("INSERT INTO report_channel_policies VALUES('installation',?,?,1,'owner',?)").run(request.source.channelId,request.reportKey,now);
  const channel={id:request.source.channelId,is_archived:false,is_member:true,is_im:false,is_mpim:false,is_shared:false,is_ext_shared:false,is_pending_ext_shared:false,pending_shared:[],shared_team_ids:[request.source.teamId]};
  const original=globalThis.fetch;let redirect=false;let calls=0;
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'http://172.17.0.1:13008/v1/report-channel');
    // Workerd supports manual/follow; Node alone would accept error and hide this regression.
    if(options.redirect!=='manual')throw new TypeError('Unsupported redirect mode');
    assert.equal(options.headers.authorization,'Bearer fixture-management-token');calls++;
    return redirect?new Response(null,{status:302,headers:{location:'https://unexpected.example/'}}):Response.json({channel});
  };
  const send=async()=>{
    const body=JSON.stringify({action:'report.request',request});const timestamp=String(Math.floor(Date.now()/1000));
    return call('/api/slack/bridge',{method:'POST',headers:{'content-type':'application/json','x-managerai-timestamp':timestamp,'x-managerai-signature':'sha256='+createHmac('sha256',values.SLACK_BRIDGE_SECRET).update(timestamp+'.'+body).digest('hex')},body});
  };
  try{
    const first=await send();assert.equal(first.status,202);const accepted=await first.json();assert.equal(accepted.accepted,true);
    const replay=await send();assert.equal(replay.status,202);assert.equal((await replay.json()).runId,accepted.runId);
    redirect=true;const denied=await send();assert.equal(denied.status,503);
    assert.equal(calls,3);assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_jobs').get().n,1);
  }finally{globalThis.fetch=original;}
});
