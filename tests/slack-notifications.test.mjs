import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeNotificationTemplate,
  parseNotificationTriggeredEvent,
  parseSocialPostEvent,
  renderSocialNotification,
  renderTriggeredNotification,
  routeAllowsPlatform,
  routeAllowsTriggeredEvent,
} from "../app/slack-notifications.ts";

const route = {
  id: "snr_1",
  principal_id: "marketing-linkedin-bot",
  display_name: "LinkedIn Marketing Bot",
  event_type: "social.post.published",
  trigger_key: "social_post_published",
  event_family: "marketing.social",
  description: "",
  slack_channel_id: "C123",
  allowed_platforms: '["linkedin"]',
  variable_names: "[]",
  message_template: "{agent} published {title} on {platform}: {url} {summary}",
  enabled: 1,
};

test("accepts a matching LinkedIn completion event and renders Assistant's fixed route template", () => {
  const event = parseSocialPostEvent({
    platform: "linkedin",
    post_url: "https://www.linkedin.com/posts/example-123",
    title: "A practical launch note",
    summary: "Published successfully.",
    published_at: 1_725_000_000_000,
  }, route.principal_id);
  assert.ok(event);
  assert.equal(routeAllowsPlatform(route, event.platform), true);
  assert.equal(renderSocialNotification(route, event), "LinkedIn Marketing Bot published A practical launch note on LinkedIn: https://www.linkedin.com/posts/example-123 Published successfully.");
});

test("rejects cross-platform, insecure, credentialed, and misleading social URLs", () => {
  const cases = [
    { platform: "linkedin", post_url: "https://x.com/acme/status/1" },
    { platform: "x", post_url: "http://x.com/acme/status/1" },
    { platform: "x", post_url: "https://x.com.evil.test/acme/status/1" },
    { platform: "linkedin", post_url: "https://user:pass@linkedin.com/posts/1" },
  ];
  for (const value of cases) {
    assert.equal(parseSocialPostEvent({ ...value, title: "Published" }, "marketing-bot"), null);
  }
});

test("does not allow an X completion through a LinkedIn-only Assistant route", () => {
  assert.equal(routeAllowsPlatform(route, "x"), false);
});

test("renders a completely static fixed-trigger contract without variables", () => {
  const staticRoute = {
    ...route,
    event_type: "notification.triggered",
    trigger_key: "marketing_posts_published",
    allowed_platforms: '["linkedin","x"]',
    variable_names: "[]",
    message_template: "The marketing agent has published this post on both LinkedIn and X.",
  };
  const event = parseNotificationTriggeredEvent({ trigger: "marketing_posts_published", platforms: ["linkedin", "x"], variables: {} }, route.principal_id);
  assert.ok(event);
  assert.equal(routeAllowsTriggeredEvent(staticRoute, event), true);
  assert.equal(renderTriggeredNotification(staticRoute, event), staticRoute.message_template);
});

test("renders a multi-line trigger contract with exactly its declared variables", () => {
  const variableRoute = {
    ...route,
    event_type: "notification.triggered",
    trigger_key: "marketing_posts_published",
    allowed_platforms: '["linkedin","x"]',
    variable_names: '["campaign","linkedin_url","x_url"]',
    message_template: "The marketing agent has published this post on {platforms}.\nCampaign: {campaign}\nLinkedIn: {linkedin_url}\nX: {x_url}",
  };
  const event = parseNotificationTriggeredEvent({
    trigger: "marketing_posts_published",
    platforms: ["linkedin", "x"],
    variables: { campaign: "August launch", linkedin_url: "https://linkedin.com/posts/1", x_url: "https://x.com/example/status/1" },
  }, route.principal_id);
  assert.ok(event);
  assert.equal(renderTriggeredNotification(variableRoute, event), "The marketing agent has published this post on LinkedIn and X.\nCampaign: August launch\nLinkedIn: https://linkedin.com/posts/1\nX: https://x.com/example/status/1");
});

test("rejects missing, extra, reserved, credential-like, and non-scalar variables", () => {
  const variableRoute = { ...route, event_type: "notification.triggered", variable_names: '["campaign"]', message_template: "Campaign: {campaign}" };
  const missing = parseNotificationTriggeredEvent({ trigger: "campaign_published", variables: {} }, route.principal_id);
  const extra = parseNotificationTriggeredEvent({ trigger: "campaign_published", variables: { campaign: "August", note: "extra" } }, route.principal_id);
  assert.ok(missing);
  assert.ok(extra);
  assert.equal(renderTriggeredNotification(variableRoute, missing), null);
  assert.equal(renderTriggeredNotification(variableRoute, extra), null);
  assert.equal(parseNotificationTriggeredEvent({ trigger: "campaign_published", variables: { trigger: "substitute-me" } }, route.principal_id), null);
  assert.equal(parseNotificationTriggeredEvent({ trigger: "campaign_published", variables: { campaign: "token=do-not-send" } }, route.principal_id), null);
  assert.equal(parseNotificationTriggeredEvent({ trigger: "campaign_published", variables: { campaign: ["not", "scalar"] } }, route.principal_id), null);
});

test("forbids trigger interpolation while allowing static and declared-variable templates", () => {
  assert.equal(analyzeNotificationTemplate("Everything is complete.").ok, true);
  assert.deepEqual(analyzeNotificationTemplate("Campaign: {campaign}\nURL: {post_url}").variables, ["campaign", "post_url"]);
  const triggerTemplate = analyzeNotificationTemplate("Completed {trigger}");
  assert.equal(triggerTemplate.ok, false);
  assert.match(triggerTemplate.error, /Reserved protocol field/);
});
