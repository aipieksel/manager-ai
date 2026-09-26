import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { routeReport } from "../slack/report-routing.mjs";
import { validateRequest } from "../app/reports/request.mjs";

const installation = { teamId: "T123", apiAppId: "A123", botUserId: "U123" };
const mention = (text, extra = {}) => ({ type: "events_api", payload: { team_id: "T123", api_app_id: "A123", event_id: "Ev123", event: { type: "app_mention", user: "U456", channel: "C123", ts: "1788786000.123456", text, ...extra } } });
const command = (text = "", trigger = "opaque.123") => ({ type: "slash_commands", payload: { team_id: "T123", api_app_id: "A123", user_id: "U456", channel_id: "C123", command: "/ai-referrals", text, trigger_id: trigger } });

test("handoff examples satisfy canonical identity and strict request validation", async () => {
  for (const name of ["synthetic-request", "synthetic-command-request"]) {
    const request = JSON.parse(fs.readFileSync(new URL(`../app/reports/examples/${name}.example.json`, import.meta.url)));
    assert.deepEqual(await validateRequest(request), request);
  }
});
test("supported mentions preserve original thread and select standard action", async () => {
  for (const text of ["<@U123> generate AI referral report", "<@U123> Generate the AI referral report, please!", "<@U123> please  generate AI referral report."]) {
    const r = await routeReport(mention(text, { thread_ts: "1788785000.654321" }), installation);
    assert.equal(r.kind, "request");
    assert.equal(r.request.source.rootThreadTs, "1788785000.654321");
    assert.equal(r.request.source.messageTs, "1788786000.123456");
    assert.deepEqual(r.request.arguments, { mode: "refresh_standard" });
  }
});
test("commands have no fabricated timestamps; redelivery stable, deliberate invocations distinct", async () => {
  const a = await routeReport(command(), installation);
  const b = await routeReport(command(), installation);
  const c = await routeReport(command("", "different"), installation);
  assert.equal(a.kind, "request");
  assert.equal(a.request.source.messageTs, null);
  assert.equal(a.request.source.rootThreadTs, null);
  assert.deepEqual(a, b);
  assert.notEqual(a.request.invocationKey, c.request.invocationKey);
});
test("help, parameters, quoted and negated instructions never execute", async () => {
  for (const text of ["help", "last 30 days", "2026-01-01"]) assert.equal((await routeReport(command(text), installation)).kind, "help");
  for (const text of ['"generate AI referral report"', "do not generate AI referral report", "how do I implement AI referral report?", "generate AI referral report for last month", "<@U999> generate AI referral report"]) {
    assert.equal((await routeReport(mention(`<@U123> ${text}`), installation)).kind, "help");
  }
});
test("bot, edited, unrelated, wrong installation and DM invocations do not execute", async () => {
  for (const extra of [{ bot_id: "B123" }, { subtype: "message_changed" }, { user: "U123" }]) assert.equal((await routeReport(mention("<@U123> generate AI referral report", extra), installation)).kind, "unrelated");
  assert.equal((await routeReport(mention("<@U999> generate AI referral report"), installation)).kind, "unrelated");
  assert.equal((await routeReport(mention("<@U123> Nairobi plan this"), installation)).kind, "unrelated");
  assert.equal((await routeReport(command(), { ...installation, teamId: "TOTHER" })).kind, "unrelated");
  assert.equal((await routeReport(mention("<@U123> generate AI referral report", { channel: "D123" }), installation)).kind, "invalid");
});
test("unknown properties and forged invocation keys are rejected", async () => {
  const { request } = await routeReport(command(), installation);
  for (const bad of [{ ...request, authority: "owner" }, { ...request, source: { ...request.source, filePath: "/secret" } }, { ...request, arguments: { mode: "refresh_standard", url: "https://example.com" } }, { ...request, invocationKey: "slack:report:" + "0".repeat(64) }, null, []]) {
    await assert.rejects(validateRequest(bad), /invalid_request/);
  }
});
