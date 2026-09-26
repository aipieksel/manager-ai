import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Slack routing reuses one stable hidden conversation container per agent", async () => {
  const source = await readFile(new URL("app/api/slack/bridge/route.ts", root), "utf8");
  assert.match(source, /p\.source_type='agent_chat' AND p\.source_ref=\?/);
  assert.match(source, /'agent_chat',\?,\s*'system:slack'/);
  assert.match(source, /createdProjectSlug = `agent-\$\{String\(agent\.slug\)/);
  assert.doesNotMatch(source, /`slack-\$\{eventId/);
});

test("agent Chat is registry-backed and does not render the project workspace rail", async () => {
  const shell = await readFile(new URL("app/dashboard-shell.tsx", root), "utf8");
  const workspace = await readFile(new URL("app/operations-workspace.tsx", root), "utf8");
  assert.match(shell, /fetch\("\/api\/agents"\)/);
  assert.match(shell, /setSidebarAgents\(\(data\.agents \?\? \[\]\)\.filter\(\(agent\) => agent\.lifecycle_status === "active"\)\)/);
  assert.match(shell, /<AgentChatWorkspace/);
  const agentChat = workspace.slice(workspace.indexOf("export function AgentChatWorkspace"), workspace.indexOf("function ProjectDetail"));
  assert.match(agentChat, /Slack and ManagerAI threads/);
  assert.doesNotMatch(agentChat, /Runs & results|Docs & access|MCP files|Project workspace/);
});

test("empty agent-chat containers are hidden from the normal Projects list", async () => {
  const source = await readFile(new URL("app/api/projects/route.ts", root), "utf8");
  assert.match(source, /p\.created_by='system:slack'/);
  assert.match(source, /p\.source_type IN \('slack','agent_chat'\)/);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM tasks/);
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM plans/);
});
