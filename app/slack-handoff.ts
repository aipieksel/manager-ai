export type BotHandoffRoute = {
  principal_id: string;
  display_name: string;
  event_type: string;
  trigger_key: string;
  event_family: string;
  description: string;
  allowed_platforms: string;
  variable_names: string;
};

const GENERIC_EVENT = "notification.triggered";
const LEGACY_SOCIAL_EVENT = "social.post.published";

function jsonList(value: string) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}

function envNameForVariable(name: string) {
  return `MANAGERAI_VAR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function platformLabel(platform: string) {
  return platform === "linkedin" ? "LinkedIn" : platform === "x" ? "X" : platform;
}

export function botHandoffMarkdown(endpoint: string, route: BotHandoffRoute) {
  if (!route?.principal_id || !route?.trigger_key || !route?.display_name) {
    throw new Error("Choose a configured ManagerAI notification contract before copying a bot handoff.");
  }

  const principal = route.principal_id;
  const eventType = route.event_type;
  const trigger = route.trigger_key;
  const variableNames = jsonList(route.variable_names || "[]");
  const platforms = jsonList(route.allowed_platforms || "[]");
  const title = route.display_name;
  const platformNames = platforms.map(platformLabel);
  const successCondition = route.description?.trim()
    || (eventType === LEGACY_SOCIAL_EVENT
      ? `The approved ${platformNames.join(" or ") || "social"} post is published successfully and the platform has returned its durable post ID and public URL.`
      : `The authorized work represented by “${title}” has completed successfully and produced a durable source event ID.`);
  const scope = platforms.length ? platformNames.map((value) => `\`${value}\``).join(", ") : "No platform field is required.";
  const runtimeInputs = [
    "- `MANAGERAI_SOURCE_EVENT_ID` — a durable ID from the completed source action (for example the CMS publication ID, deployment ID, report ID, or platform post ID). Reuse this same value for every retry of that action.",
    ...(eventType === LEGACY_SOCIAL_EVENT ? [
      `- \`MANAGERAI_PLATFORM\` — exactly ${platforms.length === 1 ? `\`${platforms[0]}\`` : platforms.map((value) => `\`${value}\``).join(" or ")}.`,
      "- `MANAGERAI_POST_URL` — the final public HTTPS URL returned by the publishing platform.",
      "- `MANAGERAI_POST_TITLE` — the completed post title.",
      "- `MANAGERAI_POST_SUMMARY` — optional short owner-facing context.",
      "- `MANAGERAI_PUBLISHED_AT` — optional publication time in Unix milliseconds.",
    ] : variableNames.map((name) => `- \`${envNameForVariable(name)}\` — the scalar value for required contract variable \`${name}\`.`)),
  ].join("\n");
  const variableEntries = variableNames.map((name) => `    ${JSON.stringify(name)}: requiredEnv(${JSON.stringify(envNameForVariable(name))}),`).join("\n");
  const bodyCode = eventType === LEGACY_SOCIAL_EVENT ? `{
  type: ${JSON.stringify(LEGACY_SOCIAL_EVENT)},
  idempotency_key: idempotencyKey,
  principal,
  authority: ["notify"],
  platform: requiredEnv("MANAGERAI_PLATFORM"),
  post_url: requiredEnv("MANAGERAI_POST_URL"),
  title: requiredEnv("MANAGERAI_POST_TITLE"),
  ...(process.env.MANAGERAI_POST_SUMMARY?.trim() ? { summary: process.env.MANAGERAI_POST_SUMMARY.trim() } : {}),
  ...(process.env.MANAGERAI_PUBLISHED_AT?.trim() ? { published_at: process.env.MANAGERAI_PUBLISHED_AT.trim() } : {}),
}` : `{
  type: ${JSON.stringify(GENERIC_EVENT)},
  idempotency_key: idempotencyKey,
  principal,
  authority: ["notify"],
  trigger: ${JSON.stringify(trigger)},${platforms.length ? `
  platforms: ${JSON.stringify(platforms)},` : ""}
  variables: {${variableEntries ? `\n${variableEntries}\n  ` : ""}},
}`;
  const variableContract = variableNames.length
    ? variableNames.map((name) => `- \`${name}\` from \`${envNameForVariable(name)}\``).join("\n")
    : "- None. This contract sends an empty `variables` object.";

  return `# ${title} — ManagerAI bot handoff

Suggested filename: \`managerai-${principal}-${trigger}.md\`

## Your assignment

This is the notification handoff for the configured ManagerAI contract **${title}**. It is not a generic starter and it does not grant new authority.

**Notify only when:** ${successCondition}

Your required workflow is:

1. Complete the authorized source work described above using your existing bot instructions and permissions.
2. Verify that the source action actually succeeded. Do not notify for a draft, queued action, partial failure, simulation, or plan.
3. Collect the runtime values listed below from that successful action.
4. Run the sender in this document once. If transport fails, follow the retry rules with the same source event ID.
5. Retain ManagerAI's returned event ID and status with the source action's audit record.

## This bot's fixed ManagerAI contract

- Contract name: \`${title}\`
- Category: \`${route.event_family}\`
- Event type: \`${eventType}\`
- Principal: \`${principal}\`
- Authority: exactly \`["notify"]\`
- Trigger: \`${trigger}\`
- Platform scope: ${scope}
- Endpoint: \`POST ${endpoint}\`

The principal, trigger, authority, platform scope, and variable names above are already configured. Do not rename or replace them.

### Required caller variables

${variableContract}

### Runtime values to provide after successful work

${runtimeInputs}

The sender derives the idempotency key exactly as \`${principal}:${trigger}:\${MANAGERAI_SOURCE_EVENT_ID}\`. This makes retries of one completed action stable while keeping different completed actions distinct.

## Private setup required once

1. Ask the owner for the separate HMAC secret issued for principal \`${principal}\` through a private channel.
2. Store it in the bot runtime as \`MANAGERAI_CONTACT_SECRET\`; never put it in source, Markdown, prompts, logs, screenshots, or the request body.
3. Store \`${endpoint}\` as \`MANAGERAI_CONTACT_URL\` and \`${principal}\` as \`MANAGERAI_AGENT_ID\`.
4. Read the generic protocol at any time with:

\`\`\`bash
curl -fsS ${endpoint}
\`\`\`

The principal ID is public. The HMAC secret is not included in this handoff and cannot be recovered from ManagerAI.

## Dependency-free Node.js sender

Set the required runtime environment values, then run this file with Node.js 22 or newer. It constructs the body once and signs the exact UTF-8 bytes that it sends.

\`\`\`js
import { createHmac } from "node:crypto";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

const endpoint = process.env.MANAGERAI_CONTACT_URL || ${JSON.stringify(endpoint)};
const principal = process.env.MANAGERAI_AGENT_ID || ${JSON.stringify(principal)};
if (principal !== ${JSON.stringify(principal)}) throw new Error("MANAGERAI_AGENT_ID does not match this contract");
const secret = requiredEnv("MANAGERAI_CONTACT_SECRET");
const sourceEventId = requiredEnv("MANAGERAI_SOURCE_EVENT_ID");
const idempotencyKey = [principal, ${JSON.stringify(trigger)}, sourceEventId].join(":");

const body = ${bodyCode};
const exactBody = JSON.stringify(body);
const timestamp = Math.floor(Date.now() / 1000).toString();
const digest = createHmac("sha256", secret)
  .update(timestamp + "." + exactBody, "utf8")
  .digest("hex");

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-agent-id": principal,
    "x-timestamp": timestamp,
    "x-signature": "sha256=" + digest,
  },
  body: exactBody,
});

const result = await response.text();
if (!response.ok) throw new Error("ManagerAI rejected the notification (" + response.status + "): " + result);
console.log(result);
\`\`\`

## Retry and response rules

- Treat a successful 2xx response as accepted. Record its returned event ID/status.
- On a timeout, network error, rate limit, or 5xx response, rerun the sender with the same \`MANAGERAI_SOURCE_EVENT_ID\` and runtime values. It will keep the same body and idempotency key while creating a fresh timestamp and signature.
- Do not retry 400, 401, or 403 unchanged. Fix the body, clock/secret, authority, principal, trigger, platform scope, or variables first.
- Never invent a different source event ID because the response was lost; replay protection should return the existing event instead of posting twice.
- Never print the secret, signature input, or private runtime environment while debugging.

## Completion checklist

- The authorized source action actually succeeded.
- The success condition in **Your assignment** is satisfied.
- Every required runtime value came from that completed source action.
- The fixed principal, trigger, authority, platform scope, and variable names were not changed.
- The exact serialized body was signed before it was sent.
- The returned ManagerAI event ID/status was retained for audit and safe retry.
`;
}
