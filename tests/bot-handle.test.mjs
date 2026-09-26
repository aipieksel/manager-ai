import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("owner API creates only a one-time bot handle after same-origin and owner checks", async () => {
  const source = await readFile(new URL("app/api/slack/route.ts", root), "utf8");
  assert.ok(source.indexOf("requireSameOrigin(request)") < source.indexOf('payload.action === "create_bot_handle"'));
  assert.ok(source.indexOf("requireOwnerApi()") < source.indexOf('payload.action === "create_bot_handle"'));
  assert.match(source, /\/v1\/agent-contact/);
  assert.doesNotMatch(source, /rotate_contact_credential|MANAGERAI_CONTACT_SECRET/);
});

test("Slack UI copies one setup URL and has no active-contract controls", async () => {
  const source = await readFile(new URL("app/slack-workspace.tsx", root), "utf8");
  assert.match(source, /Copy bot handle/);
  assert.match(source, /safeBotHandleText\(result\.setupUrl\)/);
  assert.match(source, /`Run exactly one GET request using this private setup URL:\\n\\n\\`\$\{setupUrl\}\\``/);
  assert.match(source, /chat previews cannot spend it/i);
  assert.match(source, /exactly one GET request/i);
  assert.doesNotMatch(source, /Add contract|notificationRoutes|Copy full bot handoff|Choose a notification contract/);
});

test("intake gateway hashes setup and reusable keys and redacts setup URLs from logs", async () => {
  const source = await readFile(new URL("intake/gateway.py", root), "utf8");
  assert.match(source, /"keyHash": token_hash\(setup_key\)/);
  assert.match(source, /"bearerHash": token_hash\(reusable_key\)/);
  assert.match(source, /invalid_or_used_bot_handle/);
  assert.match(source, /key=\[redacted\]/);
  assert.doesNotMatch(source, /"secret": reusable_key/);
});

test("migration deactivates every obsolete active contract", async () => {
  const source = await readFile(new URL("drizzle/0007_deactivate_obsolete_notification_contracts.sql", root), "utf8");
  assert.match(source, /UPDATE slack_notification_routes/);
  assert.match(source, /SET enabled = 0/);
  assert.match(source, /WHERE enabled = 1/);
});
