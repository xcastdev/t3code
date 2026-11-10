import { describe, expect, it } from "vite-plus/test";

import { resolvePluginOpenTarget } from "./openPluginPanel";

describe("resolvePluginOpenTarget", () => {
  it.each([
    { name: "no chat opens the page", scope: "env-a", chat: null, expected: "page" },
    {
      name: "chat in env A with scope A docks",
      scope: "env-a",
      chat: { environmentId: "env-a" },
      expected: "dock",
    },
    {
      name: "client scope with a chat docks",
      scope: "client",
      chat: { environmentId: "env-a" },
      expected: "dock",
    },
    {
      name: "chat in env A with scope B opens the page",
      scope: "env-b",
      chat: { environmentId: "env-a" },
      expected: "page",
    },
  ])("$name", ({ scope, chat, expected }) => {
    expect(resolvePluginOpenTarget({ scope, chat })).toBe(expected);
  });
});
