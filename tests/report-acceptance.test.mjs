import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { acceptReport } from "../app/reports/acceptance.mjs";
import { assertInternalChannel } from "../app/reports/policy.mjs";
import { databaseFixture } from "./report-database.mjs";

const request = JSON.parse(fs.readFileSync(new URL("../app/reports/examples/synthetic-request.example.json", import.meta.url)));
const now = 1788790000000;
const channel = { id: request.source.channelId, is_archived: false, is_member: true, is_im: false, is_mpim: false, is_shared: false, is_ext_shared: false, is_pending_ext_shared: false, pending_shared: [], shared_team_ids: [request.source.teamId] };
function setup(t) {
  const db = databaseFixture(); t.after(() => db.sqlite.close());
  db.sqlite.prepare("INSERT INTO slack_installations(id,team_id,workspace_name,bot_token_secret_ref,app_token_secret_ref,status,installed_by,installed_at) VALUES('installation',?,'fixture','private','private','active','fixture',?)").run(request.source.teamId, now);
  db.sqlite.prepare("INSERT INTO report_configurations(report_key,project_id,installation_id,api_app_id,executor_id,executor_version_id,reference_id,reference_sha256,source_config_id,enabled,preflight_verified_at,updated_at) VALUES(?,'project','installation',?,'executor','version','reference',?,'source',1,?,?)").run(request.reportKey, request.source.apiAppId, "a".repeat(64), now, now);
  db.sqlite.prepare("INSERT INTO report_grants VALUES('installation',?,?,'project',1,'owner',?)").run(request.source.userId, request.reportKey, now);
  db.sqlite.prepare("INSERT INTO report_channel_policies VALUES('installation',?,?,1,'owner',?)").run(request.source.channelId, request.reportKey, now);
  return db;
}
test("ordered migrations and atomic acceptance produce one run and delivery on replay", async (t) => {
  const db = setup(t);
  const a = await acceptReport(db, request, async () => channel, now);
  const b = await acceptReport(db, request, async () => channel, now);
  assert.equal(a.duplicate, false); assert.equal(b.duplicate, true); assert.equal(a.runId, b.runId);
  for (const table of ["report_jobs", "slack_report_deliveries"]) assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1);
  assert.equal(db.sqlite.prepare("SELECT status FROM agent_runs WHERE id=?").get(a.runId).status, "queued");
});
test("revoked report grant blocks before channel or source reads", async (t) => {
  const db = setup(t); db.sqlite.exec("UPDATE report_grants SET active=0");
  let reads = 0;
  await assert.rejects(acceptReport(db, request, async () => { reads++; return channel; }, now), /report_forbidden/);
  assert.equal(reads, 0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM report_jobs").get().n, 0);
});
test("inactive installation, wrong app, disabled channel, disabled feature and missing preflight deny", async (t) => {
  for (const sql of ["UPDATE slack_installations SET status='revoked'", "UPDATE report_configurations SET api_app_id='AOTHER'", "UPDATE report_channel_policies SET enabled=0", "UPDATE report_configurations SET enabled=0", "UPDATE report_configurations SET preflight_verified_at=NULL"]) {
    const db = setup(t); db.sqlite.exec(sql);
    await assert.rejects(acceptReport(db, request, async () => channel, now), /report_forbidden|dependency_unavailable/);
  }
});
test("unknown channel facts never establish an internal audience", () => {
  assert.equal(assertInternalChannel(channel, channel.id), channel);
  for (const key of Object.keys(channel).filter((k) => k !== "id")) {
    const copy = { ...channel }; delete copy[key];
    assert.throws(() => assertInternalChannel(copy, channel.id), /report_forbidden/);
  }
  for (const mutation of [{ is_ext_shared: true }, { is_shared: true }, { is_archived: true }, { is_member: false }, { is_im: true }, { is_mpim: true }, { shared_team_ids: ["T1", "T2"] }]) assert.throws(() => assertInternalChannel({ ...channel, ...mutation }, channel.id), /report_forbidden/);
});
test("failed transaction leaves no partially accepted report", async (t) => {
  const db = setup(t);
  db.sqlite.exec("CREATE TRIGGER fail_report_delivery BEFORE INSERT ON slack_report_deliveries BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await assert.rejects(acceptReport(db, request, async () => channel, now), /report_acceptance_write_failed/);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM report_jobs").get().n, 0);
});

test('coordinator recovers a lost dispatch response using the same runtime identity', async(t)=>{
  const { reconcileReports } = await import('../app/reports/coordinator.mjs');
  const db=setup(t); const accepted=await acceptReport(db,request,async()=>channel,now);
  let time=now, runtimeState=null, launches=0;
  const runtime=async(action,payload)=>{
    if(action==='status') return runtimeState;
    launches++; runtimeState={runId:payload.runId,attempt:1,status:'running',stage:'build',sequence:2};
    throw Error('lost_response');
  };
  const dependencies={inspectChannel:async()=>channel,runtime,now:()=>time,validateCompletion:async()=>{throw Error('unexpected');}};
  await reconcileReports(db,dependencies);time+=61_000;await reconcileReports(db,dependencies);
  assert.equal(launches,1);assert.equal(runtimeState.runId,accepted.runId);
  assert.equal(db.sqlite.prepare('SELECT status FROM agent_runs WHERE id=?').get(accepted.runId).status,'running');
});

test('delivery claims are exclusive, fenced, and recheck revoked report grants', async(t)=>{
  const {claimDelivery,authorizeDelivery,saveDelivery,releaseDelivery}=await import('../app/reports/delivery-store.mjs');
  const db=setup(t);await acceptReport(db,request,async()=>channel,now);
  const claim=await claimDelivery(db,now); assert.ok(claim); assert.equal(claim.requesterUserId,request.source.userId);
  assert.equal(await claimDelivery(db,now),null);
  await authorizeDelivery(db,claim,async()=>channel,now);
  await saveDelivery(db,claim,{state:'parent_ready'},now);
  await assert.rejects(saveDelivery(db,claim,{state:'delivered'},now),/stale_delivery_claim/);
  db.sqlite.exec('UPDATE report_grants SET active=0');
  await assert.rejects(authorizeDelivery(db,claim,async()=>channel,now),/report_forbidden/);
  await releaseDelivery(db,claim,now);
  await assert.rejects(authorizeDelivery(db,claim,async()=>channel,now),/stale_delivery_claim/);
});

 test('stalled report polling terminates after the one-day job deadline', async(t)=>{
  const {reconcileReports}=await import('../app/reports/coordinator.mjs');
  const db=setup(t);const accepted=await acceptReport(db,request,async()=>channel,now);
  await reconcileReports(db,{now:()=>now+86_400_000,inspectChannel:async()=>{throw Error('unexpected');},runtime:async()=>{throw Error('unexpected');}});
  assert.equal(db.sqlite.prepare('SELECT status FROM agent_runs WHERE id=?').get(accepted.runId).status,'failed');
 });

test('unchanged enabled report configuration does not expire between user requests', async(t)=>{
 const db=setup(t);db.sqlite.exec('UPDATE report_configurations SET preflight_verified_at=1');
 const result=await acceptReport(db,request,async()=>channel,now);assert.ok(result.runId);
});

test('channel member grant admits new members, denies outsiders and rechecks delivery membership',async(t)=>{
 const {invocationKey}=await import('../app/reports/request.mjs');
 const {claimDelivery,authorizeDelivery}=await import('../app/reports/delivery-store.mjs');
 const db=setup(t);db.sqlite.exec('UPDATE report_grants SET active=0');
 db.sqlite.prepare("INSERT INTO report_grants VALUES('installation',?,?,'project',1,'owner',?)").run(`channel:${request.source.channelId}`,request.reportKey,now);
 const r=structuredClone(request);r.source.userId='UNEWMEMBER';r.invocationKey=await invocationKey(r.source);
 let member=true;
 const inspect=async(team,id,user)=>{assert.equal(user,'UNEWMEMBER');return {...channel,requester_is_member:member};};
 const accepted=await acceptReport(db,r,inspect,now);assert.ok(accepted.runId);
 const claim=await claimDelivery(db,now);assert.equal(claim.requesterUserId,'UNEWMEMBER');await authorizeDelivery(db,claim,inspect,now);
 member=false;await assert.rejects(authorizeDelivery(db,claim,inspect,now),/report_forbidden/);
 await assert.rejects(acceptReport(db,r,inspect,now),/report_forbidden/);
 await assert.rejects(acceptReport(db,r,async()=>channel,now),/report_forbidden/);
 const other=structuredClone(r);other.source.channelId='COTHER';other.invocationKey=await invocationKey(other.source);
 await assert.rejects(acceptReport(db,other,async()=>{throw Error('must not inspect another channel');},now),/report_forbidden/);
 assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM report_jobs').get().n,1);
});
