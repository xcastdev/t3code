export const AGENT_SECTIONS = [
  "overview",
  "activity",
  "configuration",
  "memory",
  "routines",
] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];

export interface AgentRouteSearch {
  readonly section: AgentSection;
}

export interface AgentsRouteSearch {
  readonly archived?: true;
}

const isSection = (value: unknown): value is AgentSection =>
  AGENT_SECTIONS.some((section) => section === value);

export function validateAgentRouteSearch(search: Record<string, unknown>): AgentRouteSearch {
  return { section: isSection(search.section) ? search.section : "overview" };
}

export function validateAgentsRouteSearch(search: Record<string, unknown>): AgentsRouteSearch {
  return search.archived === true || search.archived === "true" ? { archived: true } : {};
}
