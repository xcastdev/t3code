import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSE_NEW_AGENT,
  COMPOSE_NEW_CHAT,
  composeMenuActions,
  composeMenuAgent,
} from "./compose-menu";

const scout = { environmentId: "env-1", assistantId: "scout", name: "Scout" };
const atlas = { environmentId: "env-2", assistantId: "atlas", name: "Atlas" };

describe("compose menu", () => {
  it("offers New agent when there are no agents", () => {
    expect(composeMenuActions([]).map((action) => action.id)).toEqual([
      COMPOSE_NEW_CHAT,
      COMPOSE_NEW_AGENT,
    ]);
  });

  it("opens the only agent directly", () => {
    const [, agentChat] = composeMenuActions([scout]);
    expect(agentChat).toMatchObject({ title: "New agent chat", subtitle: "Scout" });
    expect(composeMenuAgent([scout], agentChat!.id!)).toBe(scout);
  });

  it("lists several agents in the given order and resolves each one", () => {
    const [, picker] = composeMenuActions([atlas, scout]);
    expect(picker?.id).toBeUndefined();
    expect(picker?.subactions?.map((action) => action.title)).toEqual(["Atlas", "Scout"]);
    const ids = picker!.subactions!.map((action) => action.id!);
    expect(ids.map((id) => composeMenuAgent([atlas, scout], id))).toEqual([atlas, scout]);
    expect(composeMenuAgent([atlas, scout], COMPOSE_NEW_CHAT)).toBeUndefined();
  });

  it("tells apart agents that share an id in different environments", () => {
    const twin = { ...atlas, environmentId: "env-1" };
    const ids = composeMenuActions([atlas, twin])[1]!.subactions!.map((action) => action.id!);
    expect(new Set(ids).size).toBe(2);
    expect(composeMenuAgent([atlas, twin], ids[1]!)).toBe(twin);
  });
});
