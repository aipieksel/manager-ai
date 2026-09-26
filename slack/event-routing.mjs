export const SUGGESTED_PROMPTS = [
  { title: "Plan work", message: "Nairobi, turn this thread into a clear execution plan." },
  { title: "Work on a project", message: "Name a project agent, then describe what you need it to do." },
  { title: "Choose an agent", message: "Which Agent Command Center agent should handle this?" },
];

export function stripBotMentions(value) {
  return String(value || "").replace(/<@[A-Z0-9]+>/gi, " ").replace(/\s+/g, " ").trim();
}

export function isAllowedSlackUser(userId, allowedUsers) {
  return typeof userId === "string" && Array.isArray(allowedUsers) && allowedUsers.includes(userId);
}

export function classifySlackEvent(event) {
  if (!event || event.bot_id || event.subtype) return { kind: "ignore" };
  if (event.type === "app_mention") return { kind: "agent_request", eventType: "mention", explicit: true };
  if (event.type !== "message") return { kind: "ignore" };
  if (event.channel_type === "im") return { kind: "agent_request", eventType: "direct_message", explicit: true };
  return { kind: "ignore" };
}

export function appHomeView() {
  return {
    type: "home",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Assistant", emoji: true } },
      { type: "section", text: { type: "mrkdwn", text: "I route Slack requests to your registered Agent Command Center agents." } },
      { type: "section", text: { type: "mrkdwn", text: "*How to ask*\nName exactly one agent, then give the request and any useful context. For example: `Nairobi, turn this thread into a task plan.`" } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Channel work always requires an explicit `@Assistant` mention. Requests from users outside the private allowlist are ignored." }] },
    ],
  };
}
