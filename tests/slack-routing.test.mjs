import assert from "node:assert/strict";
import test from "node:test";

import { agentChoiceMessage, resolveSlackAgent } from "../app/slack-routing.ts";

const agents = [
  { id: "agt_assistant", name: "Assistant", slug: "assistant", role: "Slack router" },
  { id: "agt_nairobi", name: "Nairobi", slug: "nairobi", role: "Task planner" },
  { id: "agt_talkai", name: "TalkAI Agent", slug: "talkai-agent", role: "Repository specialist" },
  { id: "agt_manager", name: "Manager", slug: "manager", role: "Manager" },
  { id: "agt_managerai", name: "ManagerAI Agent", slug: "managerai-agent", role: "Repository specialist" },
];

test("routes a Assistant mention to a named agent", () => {
  const result = resolveSlackAgent("<@U123> Nairobi turn this thread into tasks", agents);
  assert.equal(result.status, "resolved");
  assert.equal(result.agent.slug, "nairobi");
});

test("supports the short name of an Agent-suffixed registry entry", () => {
  const result = resolveSlackAgent("<@U123> please give TalkAI this bug", agents);
  assert.equal(result.status, "resolved");
  assert.equal(result.agent.slug, "talkai-agent");
});

test("does not confuse Manager with ManagerAI", () => {
  const result = resolveSlackAgent("<@U123> ManagerAI inspect this", agents);
  assert.equal(result.status, "resolved");
  assert.equal(result.agent.slug, "managerai-agent");
});

test("asks for one target when none is named", () => {
  const result = resolveSlackAgent("<@U123> please handle this", agents);
  assert.equal(result.status, "missing");
  assert.match(agentChoiceMessage(result), /Available agents: Manager, ManagerAI Agent, Nairobi, TalkAI Agent/);
  assert.doesNotMatch(agentChoiceMessage(result), /Assistant/);
});

test("rejects multiple named agents instead of guessing", () => {
  const result = resolveSlackAgent("<@U123> Nairobi and TalkAI should handle this", agents);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.matches.map((agent) => agent.slug), ["nairobi", "talkai-agent"]);
});

test("honors the pre-filtered channel agent allowlist", () => {
  const allowedAgents = agents.filter((agent) => ["assistant", "nairobi"].includes(agent.slug));
  const result = resolveSlackAgent("<@U123> TalkAI inspect this", allowedAgents);
  assert.equal(result.status, "missing");
});
