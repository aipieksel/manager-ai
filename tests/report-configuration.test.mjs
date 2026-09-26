import test from 'node:test';import assert from 'node:assert/strict';
import {validateConfiguration,saveConfiguration} from '../app/reports/configuration.mjs';
import {databaseFixture} from './report-database.mjs';
const config={projectId:'project',installationId:'installation',apiAppId:'ATEST',executorId:'executor',executorVersionId:'version',referenceId:'reference',referenceSha256:'a'.repeat(64),sourceConfigId:'source',userIds:['UREPORT'],channelIds:['CREPORT']};
test('report configuration rejects paths, extra options, malformed identities and duplicate grants',()=>{
  assert.equal(validateConfiguration(config),config);
  for(const patch of [{executorId:'/bin/sh'},{referenceSha256:'broken'},{enabled:true},{userIds:['UREPORT','UREPORT']},{channelIds:['DPRIVATE']}])assert.throws(()=>validateConfiguration({...config,...patch}),/invalid_report_configuration/);
});
test('saving report-only grants disables generation and does not add general channel rules',async(t)=>{
  const db=databaseFixture();t.after(()=>db.sqlite.close());
  db.sqlite.exec(`INSERT INTO projects(id,name,slug,created_by,created_at,updated_at)VALUES('project','Fixture','fixture','owner',1,1);
    INSERT INTO agents(id,name,slug,lifecycle_status,current_version_id,created_by,created_at,updated_at)VALUES('executor','Fixture executor','fixture-executor','active','version','owner',1,1);
    INSERT INTO agent_versions(id,agent_id,version_number,role,objective,system_instructions,created_by,created_at)VALUES('version','executor',1,'report','report','fixed report','owner',1);
    INSERT INTO slack_installations(id,team_id,workspace_name,bot_token_secret_ref,app_token_secret_ref,status,installed_by,installed_at)VALUES('installation','TTEST','Fixture','private','private','active','owner',1);`);
  await saveConfiguration(db,config,'owner',100);
  assert.equal(db.sqlite.prepare('SELECT enabled FROM report_configurations').get().enabled,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM slack_channel_rules').get().n,0);
  assert.equal(db.sqlite.prepare('SELECT user_id FROM report_grants WHERE active=1').get().user_id,'UREPORT');
  db.sqlite.exec('UPDATE report_configurations SET enabled=1,preflight_verified_at=100');
  await saveConfiguration(db,{...config,userIds:['UNEXT']},'owner',200);
  await saveConfiguration(db,{...config,userIds:[],memberChannelIds:['CREPORT']},'owner',300);
  assert.deepEqual(db.sqlite.prepare('SELECT user_id FROM report_grants WHERE active=1').all().map(r=>r.user_id),['channel:CREPORT']);
  const current=db.sqlite.prepare('SELECT * FROM report_configurations').get();assert.equal(current.enabled,0);assert.equal(current.preflight_verified_at,null);assert.equal(current.revision,3);
  assert.equal(db.sqlite.prepare("SELECT active FROM report_grants WHERE user_id='UREPORT'").get().active,0);
});
test('member channel grants must name allowed report channels',()=>{
 assert.doesNotThrow(()=>validateConfiguration({...config,userIds:[],memberChannelIds:['CREPORT']}));
 for(const patch of [{userIds:[],memberChannelIds:[]},{memberChannelIds:['COTHER']},{memberChannelIds:['CREPORT','CREPORT']},{memberChannelIds:['*']}])assert.throws(()=>validateConfiguration({...config,...patch}),/invalid_report_configuration/);
});
