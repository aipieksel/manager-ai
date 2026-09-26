import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { advanceDelivery, confirmsShare, completionComment, summary, verifiedSlackUploadUrl } from "../slack/report-delivery.mjs";
import { sha256 } from "../app/reports/request.mjs";

const result = JSON.parse(fs.readFileSync(new URL("../app/reports/examples/synthetic-result.example.json", import.meta.url)));
const root = "1788786000.123456";
test("summary uses source-specific coverage and weighted result without combining measurements", () => {
  const text = summary(result);
  assert.match(text, /100 sessions; 60 engaged sessions; engagement rate 60.0%/);
  assert.match(text, /120 visits/);
  assert.doesNotMatch(text, /220|undefined/);
  const zero = structuredClone(result); zero.metrics.ga4 = { sessions: 0, engagedSessions: 0, engagementRate: null };
  assert.match(summary(zero), /not defined/);
});
test("upload target rejects arbitrary hosts, credentials, redirects and paths", () => {
  assert.equal(verifiedSlackUploadUrl("https://files.slack.com/upload/v1/abc"), "https://files.slack.com/upload/v1/abc");
  for (const url of ["http://files.slack.com/upload/a", "https://files.slack.com.evil.test/upload/a", "https://user:pass@files.slack.com/upload/a", "https://files.slack.com/api/a", "https://files.slack.com:444/upload/a"]) assert.throws(() => verifiedSlackUploadUrl(url));
});
test("uncertain parent is held without posting a second parent", async () => {
  const patches = []; let posts = 0;
  assert.equal(await advanceDelivery({ state: "parent_posting" }, { authorize: async () => {}, save: async (p) => patches.push(p), slack: async () => { posts++; } }), "held");
  assert.equal(posts, 0); assert.equal(patches[0].errorCode, "parent_outcome_unknown");
});
test("file existence alone is not proof of correct-thread delivery", () => {
  const target = { fileId: "F123", channelId: "C123", rootThreadTs: root };
  assert.equal(confirmsShare({ id: "F123" }, target), false);
  assert.equal(confirmsShare({ id: "F123", shares: { public: { C123: [{ thread_ts: "wrong" }] } } }, target), false);
  assert.equal(confirmsShare({ id: "F123", shares: { private: { C123: [{ thread_ts: root }] } } }, target), true);
});
test("normal fixture upload persists before publication and preserves root thread", async () => {
  const bytes = new TextEncoder().encode("synthetic workbook bytes; not a real workbook");
  const r = structuredClone(result); r.artifact.byteLength = bytes.length; r.artifact.sha256 = await sha256(bytes);
  const delivery = { state: "parent_ready", runId: "run_fixture", requesterUserId: "UREQUESTER", channelId: "C123", rootThreadTs: root, result: r };
  const history = [];
  const deps = {
    authorize: async () => history.push("authorize"),
    save: async (p) => { history.push(p.state); Object.assign(delivery, p); },
    artifact: async () => bytes,
    slack: async (method, payload) => {
      history.push(method);
      if (method === "files.getUploadURLExternal") return { ok: true, file_id: "F123", upload_url: "https://files.slack.com/upload/v1/abc" };
      assert.match(payload.initial_comment, /^<@UREQUESTER> your AI referral report is ready\./);
      assert.equal(payload.thread_ts, root); assert.equal(payload.channel_id, "C123");
      return { ok: true };
    },
    upload: async (_url, content, options) => { assert.equal(options.redirect, "error"); assert.equal(content, bytes); history.push("bytes"); return { ok: true }; },
  };
  assert.equal(await advanceDelivery(delivery, deps), "uploaded");
  assert.ok(history.indexOf("uploading") < history.indexOf("bytes"));
  assert.equal(await advanceDelivery(delivery, deps), "delivered");
  assert.ok(history.indexOf("completing") < history.indexOf("files.completeUploadExternal"));
});
test("lost completion response reconciles without blind finalization", async () => {
  const d = { state: "uploaded", requesterUserId: "UREQUESTER", fileId: "F123", channelId: "C123", rootThreadTs: root, result };
  let complete = 0;
  const deps = { authorize: async () => {}, save: async (p) => Object.assign(d, p), slack: async (method) => {
    if (method === "files.completeUploadExternal") { complete++; throw new Error("network_lost"); }
    assert.equal(method, "files.info"); return { ok: true, file: { id: "F123", shares: { public: { C123: [{ thread_ts: root }] } } } };
  } };
  await assert.rejects(advanceDelivery(d, deps), /network_lost/);
  assert.equal(d.state, "completing");
  assert.equal(await advanceDelivery(d, deps), "delivered"); assert.equal(complete, 1);
});
test("revocation prevents all artifact and Slack operations", async () => {
  await assert.rejects(advanceDelivery({ state: "parent_ready", result }, { authorize: async () => { throw new Error("report_forbidden"); }, save: async () => assert.fail(), artifact: async () => assert.fail(), slack: async () => assert.fail() }), /report_forbidden/);
});

test('failed execution posts one bounded notice and uncertain notices are held',async()=>{
  const states=[];const calls=[];
  const deps={authorize:async()=>{},save:async p=>states.push(p.state),slack:async(method,body)=>{calls.push({method,body});return {ok:true,ts:'1788790000.000001'};}};
  assert.equal(await advanceDelivery({state:'parent_ready',executionStatus:'failed',channelId:'CTEST',rootThreadTs:'1788790000.000001'},deps),'failed');
  assert.deepEqual(states,['failure_posting','failed']);assert.equal(calls.length,1);
  assert.equal(await advanceDelivery({state:'failure_posting',executionStatus:'failed'},deps),'held');assert.equal(calls.length,1);
});

test("completion mentions the exact requester and escapes report-supplied mentions", () => {
  const r = structuredClone(result); r.warnings = ["<@UOTHER> <!channel>"];
  for (const requesterUserId of ["UCOLLEAGUE", "WCOLLEAGUE"]) {
    const text = completionComment({ requesterUserId, result: r });
    assert.ok(text.startsWith(`<@${requesterUserId}>`));
    assert.equal((text.match(/<@/g) || []).length, 1);
    assert.ok(text.includes("&lt;!channel&gt;"));
  }
  for (const requesterUserId of [undefined, "", "<!channel>", "U123> <@UOTHER"]) {
    assert.throws(() => completionComment({ requesterUserId, result }), /invalid_report_requester/);
  }
});
