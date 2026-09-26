export type SlackRoutableAgent = {
  id: string;
  name: string;
  slug: string;
  role?: string;
};

export type SlackAgentResolution =
  | { status: "resolved"; agent: SlackRoutableAgent; availableAgents: SlackRoutableAgent[] }
  | { status: "missing"; availableAgents: SlackRoutableAgent[] }
  | { status: "ambiguous"; matches: SlackRoutableAgent[]; availableAgents: SlackRoutableAgent[] };

function normalizedWords(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function aliases(agent: SlackRoutableAgent) {
  const values = [agent.name, agent.slug, agent.name.replace(/\s+agent$/i, "")];
  return [...new Set(values.map(normalizedWords).filter(Boolean))].sort((left, right) => right.length - left.length);
}

export function resolveSlackAgent(
  mentionText: string,
  agents: SlackRoutableAgent[],
  routerSlug = "assistant",
): SlackAgentResolution {
  const availableAgents = agents
    .filter((agent) => agent.slug !== routerSlug)
    .sort((left, right) => left.name.localeCompare(right.name));
  const haystack = ` ${normalizedWords(mentionText)} `;
  const matches = availableAgents.filter((agent) => aliases(agent).some((alias) => haystack.includes(` ${alias} `)));
  if (!matches.length) return { status: "missing", availableAgents };
  if (matches.length > 1) return { status: "ambiguous", matches, availableAgents };
  return { status: "resolved", agent: matches[0], availableAgents };
}

export function agentChoiceMessage(resolution: Exclude<SlackAgentResolution, { status: "resolved" }>) {
  const choices = resolution.availableAgents.map((agent) => agent.name).join(", ");
  if (resolution.status === "ambiguous") {
    return `I found more than one agent in that request (${resolution.matches.map((agent) => agent.name).join(", ")}). Mention exactly one agent for me to route this thread to.`;
  }
  return `Tell me which agent should handle this thread. Available agents: ${choices || "none are active yet"}.`;
}
