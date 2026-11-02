import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { AssistantSummary, EnvironmentId } from "@t3tools/contracts";
import { sortPinnedThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import * as Schema from "effect/Schema";

export const AgentSidebarFilter = Schema.Struct({
  agents: Schema.Array(Schema.String),
  environments: Schema.Array(Schema.String),
});
export type AgentSidebarFilter = typeof AgentSidebarFilter.Type;

export const NO_AGENT_FILTER: AgentSidebarFilter = { agents: [], environments: [] };

export function agentKey(agent: Pick<AssistantSummary, "environmentId" | "assistantId">): string {
  return `${agent.environmentId}:${agent.assistantId}`;
}

/** An empty list on either axis means "all"; the axes narrow together. */
export function agentPassesFilter(
  agent: Pick<AssistantSummary, "environmentId" | "assistantId">,
  filter: AgentSidebarFilter,
): boolean {
  return (
    (filter.environments.length === 0 || filter.environments.includes(agent.environmentId)) &&
    (filter.agents.length === 0 || filter.agents.includes(agentKey(agent)))
  );
}

export function agentFilterIsActive(filter: AgentSidebarFilter): boolean {
  return filter.agents.length > 0 || filter.environments.length > 0;
}

export function toggleAgentFilterValue(
  filter: AgentSidebarFilter,
  axis: keyof AgentSidebarFilter,
  value: string,
): AgentSidebarFilter {
  const current = filter[axis];
  return {
    ...filter,
    [axis]: current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value],
  };
}

/** An agent's chats: fresh conversations branched from its home, pinned first, then newest. */
type ChatShell = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "createdAt"
  | "updatedAt"
  | "pinnedAt"
  | "pinOrderKey"
>;

export function agentChats<T extends ChatShell>(
  threads: ReadonlyArray<T>,
  agent: Pick<AssistantSummary, "environmentId" | "binding">,
): ReadonlyArray<T> {
  const { backingProjectId, canonicalThreadId } = agent.binding;
  const chats = threads.filter(
    (thread) =>
      thread.environmentId === agent.environmentId &&
      thread.projectId === backingProjectId &&
      thread.lineage.relationshipToParent === "chat" &&
      thread.lineage.rootThreadId === canonicalThreadId &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
  );
  return [
    ...sortPinnedThreadsByOrderKey(chats.filter((chat) => chat.pinnedAt != null)),
    ...chats
      .filter((chat) => chat.pinnedAt == null)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  ];
}

/** An agent's Home shell, which carries the agent's pin. */
export function agentHomeThread<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: ReadonlyArray<T>,
  agent: Pick<AssistantSummary, "environmentId" | "binding">,
): T | null {
  return (
    threads.find(
      (thread) =>
        thread.environmentId === agent.environmentId &&
        thread.id === agent.binding.canonicalThreadId,
    ) ?? null
  );
}

/** Agents with a pinned Home lead in pin order; the rest keep their roster order. */
export function agentsPinnedFirst<
  A extends Pick<AssistantSummary, "environmentId" | "binding">,
  T extends Pick<
    EnvironmentThreadShell,
    "id" | "environmentId" | "createdAt" | "pinnedAt" | "pinOrderKey"
  >,
>(agents: ReadonlyArray<A>, threads: ReadonlyArray<T>): ReadonlyArray<A> {
  const homes = new Map(agents.map((agent) => [agent, agentHomeThread(threads, agent)]));
  const pinnedHomes = sortPinnedThreadsByOrderKey(
    agents.flatMap((agent) => {
      const home = homes.get(agent);
      return home?.pinnedAt != null ? [{ ...home, agent }] : [];
    }),
  );
  return [
    ...pinnedHomes.map((home) => home.agent),
    ...agents.filter((agent) => homes.get(agent)?.pinnedAt == null),
  ];
}

/** The agent a thread belongs to: its home, or any chat in the agent's project. */
export function agentOwningThread<A extends Pick<AssistantSummary, "environmentId" | "binding">>(
  agents: ReadonlyArray<A>,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId"> | null,
): A | null {
  if (thread === null) return null;
  return (
    agents.find(
      (agent) =>
        agent.environmentId === thread.environmentId &&
        agent.binding.backingProjectId === thread.projectId,
    ) ?? null
  );
}

/** Titles start as "New thread" until the first message names them. */
export function agentChatTitle(title: string): string {
  return title === "New thread" ? "New chat" : title;
}

export function environmentsWithAgents<T extends { readonly environmentId: EnvironmentId }>(
  environments: ReadonlyArray<T>,
  filter: AgentSidebarFilter,
): ReadonlyArray<T> {
  return filter.environments.length === 0
    ? environments
    : environments.filter((environment) => filter.environments.includes(environment.environmentId));
}
