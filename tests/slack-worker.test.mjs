import assert from "node:assert/strict";
import test from "node:test";
import { appHomeView, classifySlackEvent, isAllowedSlackUser, stripBotMentions } from "../slack/event-routing.mjs";
import { clientMessageId, processNotification } from "../slack/worker.mjs";

test("routes explicit mentions and DMs but ignores all unmentioned channel traffic", () => {
  assert.deepEqual(classifySlackEvent({ type: "app_mention" }), { kind: "agent_request", eventType: "mention", explicit: true });
  assert.deepEqual(classifySlackEvent({ type: "message", channel_type: "im" }), { kind: "agent_request", eventType: "direct_message", explicit: true });
  assert.deepEqual(classifySlackEvent({ type: "message", channel_type: "channel", thread_ts: "1.2" }), { kind: "ignore" });
  assert.deepEqual(classifySlackEvent({ type: "message", channel_type: "channel" }), { kind: "ignore" });
  assert.deepEqual(classifySlackEvent({ type: "message", channel_type: "im", bot_id: "B1" }), { kind: "ignore" });
});

test("allows only explicitly configured Slack users", () => {
  assert.equal(isAllowedSlackUser("UOWNER", ["UOWNER"]), true);
  assert.equal(isAllowedSlackUser("UOTHER", ["UOWNER"]), false);
  assert.equal(isAllowedSlackUser(undefined, ["UOWNER"]), false);
  assert.equal(isAllowedSlackUser("UOWNER", []), false);
});

test("normalizes bot mentions before signed bridge dispatch", () => {
  assert.equal(stripBotMentions(" <@U123>  Nairobi, plan this "), "Nairobi, plan this");
});

test("publishes a non-interactive Assistant home surface", () => {
  const view = appHomeView();
  assert.equal(view.type, "home");
  assert.match(JSON.stringify(view), /Agent Command Center/);
  assert.doesNotMatch(JSON.stringify(view), /password reset|support ticket/i);
});

test("denies notification delivery outside Assistant's configured channel allowlist", async () => {
  let calls = 0;
  const result = await processNotification({
    payload: { channel: "COTHER", text: "Published", idempotencyKey: "post-1" },
    currentInstallation: { allowedChannels: ["CALLOWED"] },
    replayStore: new Map(),
    postMessage: async () => { calls += 1; return { ts: "1.2" }; },
  });
  assert.equal(result.status, 400);
  assert.equal(calls, 0);
});

test("posts one bounded notification and treats a replay as a successful duplicate", async () => {
  const replayStore = new Map();
  const messages = [];
  const input = {
    payload: { channel: "CALLOWED", text: " Marketing Bot published on X ", idempotencyKey: "x-post-42" },
    currentInstallation: { allowedChannels: ["CALLOWED"] },
    replayStore,
    postMessage: async (message) => { messages.push(message); return { ts: "171.42" }; },
  };
  const first = await processNotification(input);
  const replay = await processNotification(input);
  assert.equal(first.status, 202);
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.duplicate, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Marketing Bot published on X");
  assert.match(messages[0].client_msg_id, /^[0-9a-f-]{36}$/);
  assert.equal(messages[0].client_msg_id, clientMessageId("x-post-42"));
});
