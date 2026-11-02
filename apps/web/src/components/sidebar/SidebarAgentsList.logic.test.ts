import { AssistantId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentChats,
  agentOwningThread,
  agentPassesFilter,
  NO_AGENT_FILTER,
  toggleAgentFilterValue,
} from "./SidebarAgentsList.logic";

const environmentId = EnvironmentId.make("environment");
const home = ThreadId.make("home");
const agent = {
  environmentId,
  assistantId: AssistantId.make("ops"),
  binding: {
    environmentId,
    assistantId: AssistantId.make("ops"),
    backingProjectId: ProjectId.make("ops-project"),
    canonicalThreadId: home,
  },
};

const thread = (
  id: string,
  overrides: {
    relationshipToParent?: "chat" | "fork" | null;
    rootThreadId?: ThreadId;
    projectId?: ProjectId;
    archivedAt?: string | null;
    updatedAt?: string;
  } = {},
) => ({
  id: ThreadId.make(id),
  environmentId,
  projectId: overrides.projectId ?? agent.binding.backingProjectId,
  lineage: {
    parentThreadId: home,
    relationshipToParent: overrides.relationshipToParent ?? ("chat" as const),
    rootThreadId: overrides.rootThreadId ?? home,
  },
  archivedAt: overrides.archivedAt ?? null,
  deletedAt: null,
  updatedAt: overrides.updatedAt ?? "2026-10-01T00:00:00Z",
});

describe("agentChats", () => {
  it("lists the live chats under the agent's home, newest first", () => {
    const chats = agentChats(
      [
        thread("older", { updatedAt: "2026-10-01T00:00:00Z" }),
        thread("newer", { updatedAt: "2026-10-02T00:00:00Z" }),
        thread("fork", { relationshipToParent: "fork" }),
        thread("archived", { archivedAt: "2026-10-03T00:00:00Z" }),
        thread("elsewhere", { projectId: ProjectId.make("other") }),
        thread("other-home", { rootThreadId: ThreadId.make("other-home") }),
      ],
      agent,
    );
    expect(chats.map((chat) => chat.id)).toEqual(["newer", "older"]);
  });
});

describe("agent filter", () => {
  it("shows everyone until an agent or environment is picked", () => {
    expect(agentPassesFilter(agent, NO_AGENT_FILTER)).toBe(true);
    const onlyOps = toggleAgentFilterValue(NO_AGENT_FILTER, "agents", "environment:ops");
    expect(agentPassesFilter(agent, onlyOps)).toBe(true);
    expect(
      agentPassesFilter({ ...agent, assistantId: AssistantId.make("research") }, onlyOps),
    ).toBe(false);
    expect(toggleAgentFilterValue(onlyOps, "agents", "environment:ops")).toEqual(NO_AGENT_FILTER);
    const elsewhere = toggleAgentFilterValue(NO_AGENT_FILTER, "environments", "remote");
    expect(agentPassesFilter(agent, elsewhere)).toBe(false);
  });
});

describe("agentOwningThread", () => {
  it("finds the agent whose project holds the thread", () => {
    expect(agentOwningThread([agent], thread("chat"))).toBe(agent);
    expect(
      agentOwningThread([agent], { environmentId, projectId: ProjectId.make("other") }),
    ).toBeNull();
  });
});
