import assert from "node:assert/strict";
import test from "node:test";
import { botHandoffMarkdown } from "../app/slack-handoff.ts";

const route = {
  principal_id: "retobi-notify",
  display_name: "SEO report ready",
  event_type: "notification.triggered",
  trigger_key: "seo_report_ready",
  event_family: "research.seo",
  description: "Notify the owner after an SEO report is complete.",
  allowed_platforms: "[]",
  variable_names: '["report_url","project"]',
};

test("builds a complete contract-specific Markdown bot handoff", () => {
  const handoff = botHandoffMarkdown("https://hooks.managerai.example.com/v1/agent-contact", route);
  assert.match(handoff, /^# SEO report ready — ManagerAI bot handoff/m);
  assert.match(handoff, /## Your assignment/);
  assert.match(handoff, /Notify only when:.*SEO report is complete/);
  assert.match(handoff, /Complete the authorized source work/);
  assert.match(handoff, /curl -fsS https:\/\/hooks\.managerai\.example\.com\/v1\/agent-contact/);
  assert.match(handoff, /`retobi-notify`/);
  assert.match(handoff, /`seo_report_ready`/);
  assert.match(handoff, /`report_url` from `MANAGERAI_VAR_REPORT_URL`/);
  assert.match(handoff, /retobi-notify:seo_report_ready:\$\{MANAGERAI_SOURCE_EVENT_ID\}/);
  assert.match(handoff, /idempotencyKey = \[principal, "seo_report_ready", sourceEventId\]\.join\(":"\)/);
  assert.match(handoff, /createHmac\("sha256", secret\)/);
  assert.match(handoff, /same `MANAGERAI_SOURCE_EVENT_ID` and runtime values/);
  assert.match(handoff, /MANAGERAI_CONTACT_SECRET/);
  assert.doesNotMatch(handoff, /[a-f0-9]{64}/);
  assert.doesNotMatch(handoff, /notify-principal-id|owner_configured_trigger|<stable-event-id>/);
});

test("refuses to invent a generic handoff without a configured contract", () => {
  assert.throws(
    () => botHandoffMarkdown("https://hooks.managerai.example.com/v1/agent-contact", undefined),
    /Choose a configured ManagerAI notification contract/,
  );
});

test("derives an actionable legacy social handoff from the configured contract", () => {
  const handoff = botHandoffMarkdown("https://hooks.managerai.example.com/v1/agent-contact", {
    ...route,
    display_name: "LinkedIn Marketing Bot",
    event_type: "social.post.published",
    trigger_key: "social_post_published",
    description: "",
    allowed_platforms: '["linkedin"]',
    variable_names: "[]",
  });
  assert.match(handoff, /approved LinkedIn post is published successfully/);
  assert.match(handoff, /MANAGERAI_PLATFORM.*`linkedin`/);
  assert.match(handoff, /MANAGERAI_POST_URL/);
  assert.match(handoff, /MANAGERAI_POST_TITLE/);
  assert.doesNotMatch(handoff, /notify-principal-id|owner_configured_trigger|<stable-platform-post-id>/);
});
