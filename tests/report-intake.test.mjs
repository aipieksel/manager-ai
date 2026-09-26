import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeReport, drainReportInbox } from '../slack/report-intake.mjs';
const installation = {teamId:'TTEST',apiAppId:'ATEST',botUserId:'UBOT'};
const envelope = {type:'slash_commands',envelope_id:'env',payload:{team_id:'TTEST',api_app_id:'ATEST',command:'/ai-referrals',text:'',trigger_id:'trigger',user_id:'UTEST',channel_id:'CTEST'}};
test('durable persistence precedes ACK and reports bypass general routing', async () => {
  const order=[];
  assert.equal(await intakeReport(envelope,installation,{put:async()=>order.push('commit')},async()=>order.push('ack')),true);
  assert.deepEqual(order,['commit','ack']);
});
test('failed persistence leaves envelope unacknowledged for Slack retry', async () => {
  let ack=false;
  await assert.rejects(intakeReport(envelope,installation,{put:async()=>{throw Error('disk_full');}},async()=>{ack=true;}),/disk_full/);
  assert.equal(ack,false);
});
test('disabled and custom reports cannot become general agent requests', async () => {
  let message;
  assert.equal(await intakeReport(envelope,installation,null,async(_,text)=>{message=text;}),true);
  assert.match(message,/not enabled/);
  assert.equal(await intakeReport({...envelope,payload:{...envelope.payload,text:'yesterday'}},installation,null,async()=>{}),true);
});
test('bridge failures retry durable claims; denials are terminal', async () => {
  for (const [status,expected] of [[503,'retry'],[429,'retry'],[403,'rejected'],[409,'rejected']]) {
    const outcomes=[];let pending=true;
    await drainReportInbox({claim:()=>pending?(pending=false,{request:{}}):null,settle:(_,outcome)=>outcomes.push(outcome)},async()=>{throw Object.assign(Error('bridge'),{status});});
    assert.deepEqual(outcomes,[expected]);
  }
});
