import { AssistantId, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentChats,
  agentLastActivityAt,
  agentListRows,
  agentOwningThread,
  agentsPinnedFirst,
  agentPassesFilter,
  NO_AGENT_FILTER,
  toggleAgentFilterValue,
} from "./agentsList.ts";

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
    pinnedAt?: string | null;
    pinOrderKey?: string | null;
    title?: string;
  } = {},
) => ({
  id: ThreadId.make(id),
  title: overrides.title ?? id,
  environmentId,
  projectId: overrides.projectId ?? agent.binding.backingProjectId,
  lineage: {
    parentThreadId: home,
    relationshipToParent: overrides.relationshipToParent ?? ("chat" as const),
    rootThreadId: overrides.rootThreadId ?? home,
  },
  archivedAt: overrides.archivedAt ?? null,
  deletedAt: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: overrides.updatedAt ?? "2026-10-01T00:00:00Z",
  pinnedAt: overrides.pinnedAt ?? null,
  pinOrderKey: overrides.pinOrderKey ?? null,
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

  it("puts pinned chats first in pin order, then the rest newest first", () => {
    const pinnedAt = "2026-10-05T00:00:00Z";
    const chats = agentChats(
      [
        thread("recent", { updatedAt: "2026-10-09T00:00:00Z" }),
        thread("pinned-second", { pinnedAt, pinOrderKey: "b" }),
        thread("stale", { updatedAt: "2026-09-02T00:00:00Z" }),
        thread("pinned-first", { pinnedAt, pinOrderKey: "a" }),
      ],
      agent,
    );
    expect(chats.map((chat) => chat.id)).toEqual([
      "pinned-first",
      "pinned-second",
      "recent",
      "stale",
    ]);
  });
});

describe("agentsPinnedFirst", () => {
  const agentWithHome = (name: string) => ({
    ...agent,
    assistantId: AssistantId.make(name),
    binding: { ...agent.binding, canonicalThreadId: ThreadId.make(`${name}-home`) },
  });
  const homeOf = (name: string, pinOrderKey: string | null) => ({
    ...thread(`${name}-home`),
    pinnedAt: pinOrderKey === null ? null : "2026-10-05T00:00:00Z",
    pinOrderKey,
  });

  it("leads with agents whose Home is pinned and keeps the roster order for the rest", () => {
    const [alpha, beta, gamma, delta] = ["alpha", "beta", "gamma", "delta"].map(agentWithHome);
    const ordered = agentsPinnedFirst(
      [alpha!, beta!, gamma!, delta!],
      [homeOf("alpha", null), homeOf("beta", "b"), homeOf("gamma", null), homeOf("delta", "a")],
    );
    expect(ordered.map((entry) => entry.assistantId)).toEqual(["delta", "beta", "alpha", "gamma"]);
  });
});

describe("agentListRows", () => {
  const named = (name: string, pinOrderKey: string | null = null) => ({
    agent: {
      ...agent,
      name,
      assistantId: AssistantId.make(name),
      updatedAt: "2026-08-01T00:00:00Z",
      binding: {
        ...agent.binding,
        assistantId: AssistantId.make(name),
        backingProjectId: ProjectId.make(`${name}-project`),
        canonicalThreadId: ThreadId.make(`${name}-home`),
      },
    },
    home: {
      ...thread(`${name}-home`, { projectId: ProjectId.make(`${name}-project`) }),
      pinnedAt: pinOrderKey === null ? null : "2026-10-05T00:00:00Z",
      pinOrderKey,
    },
  });
  const chatOf = (name: string, id: string, title: string) =>
    thread(id, {
      title,
      projectId: ProjectId.make(`${name}-project`),
      rootThreadId: ThreadId.make(`${name}-home`),
    });

  it("orders pinned agents first and pairs each with its Home and chats", () => {
    const ops = named("ops");
    const docs = named("docs", "a");
    const chat = chatOf("ops", "ops-chat", "Deploy");
    const rows = agentListRows([ops.agent, docs.agent], [ops.home, docs.home, chat], {
      query: "",
      filter: NO_AGENT_FILTER,
    });
    expect(rows.map((row) => [row.agent.name, row.home?.id, row.chats.map((c) => c.id)])).toEqual([
      ["docs", "docs-home", []],
      ["ops", "ops-home", ["ops-chat"]],
    ]);
  });

  it("keeps every chat on a name match and only matching chats otherwise", () => {
    const ops = named("ops");
    const docs = named("docs");
    const threads = [
      ops.home,
      docs.home,
      chatOf("ops", "deploy", "Deploy staging"),
      chatOf("ops", "rotate", "Rotate keys"),
      chatOf("docs", "fresh", "New thread"),
    ];
    const search = (query: string) =>
      agentListRows([ops.agent, docs.agent], threads, { query, filter: NO_AGENT_FILTER }).map(
        (row) => [row.agent.name, row.chats.map((chat) => chat.id)],
      );
    expect(search(" OPS ")).toEqual([["ops", ["deploy", "rotate"]]]);
    expect(search("deploy")).toEqual([["ops", ["deploy"]]]);
    // An untitled chat is searched by the name it shows.
    expect(search("new chat")).toEqual([["docs", ["fresh"]]]);
    expect(search("nothing")).toEqual([]);
  });
});

describe("agentLastActivityAt", () => {
  it("is the newest update in the agent's project, or the agent's own", () => {
    const summary = { ...agent, updatedAt: "2026-09-15T00:00:00Z" };
    expect(agentLastActivityAt([], summary)).toBe("2026-09-15T00:00:00Z");
    expect(
      agentLastActivityAt(
        [
          thread("chat", { updatedAt: "2026-10-02T00:00:00Z" }),
          thread("elsewhere", {
            projectId: ProjectId.make("other"),
            updatedAt: "2026-11-01T00:00:00Z",
          }),
        ],
        summary,
      ),
    ).toBe("2026-10-02T00:00:00Z");
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
