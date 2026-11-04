import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { openCodeToolTurnItem } from "./toolItems.ts";

const server = "t3-code-thread_1";
const base = {
  id: TurnItemId.make("item"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: "execute",
  startedAt: null,
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
};
const result = JSON.stringify({
  answer: "Node.js 26.1.0",
  sources: [{ title: "Releases", url: "https://nodejs.org/en/about/previous-releases" }],
});
const project = (name: string, input: Record<string, unknown>) =>
  openCodeToolTurnItem(base, {
    name,
    input,
    output: result,
    completedMetadata: undefined,
    t3McpServer: server,
  });

describe("openCodeToolTurnItem", () => {
  it("presents this thread's T3 web search, direct or through one Code Mode call", () => {
    for (const [name, input] of [
      [`${server}_t3_web_search`, { query: "latest Node.js" }],
      [
        "execute",
        {
          code: `const t = tools["${server}"].t3_web_search; return await t({query:"latest Node.js", instructions:"Cite nodejs.org"});`,
        },
      ],
      [
        "execute",
        { code: `return tools['${server}'].t3_web_search({ query: 'latest Node.js' });` },
      ],
    ] as const) {
      const item = project(name, input);
      expect(item.type === "web_search" ? item.patterns : item.type, name).toEqual([
        "latest Node.js",
      ]);
    }
    expect(
      project("execute", { code: `return tools["${server}"].t3_web_search({query:"q"})` }),
    ).toMatchObject({
      title: null,
      results: [
        { title: "Answer", snippet: "Node.js 26.1.0" },
        { title: "Releases", url: "https://nodejs.org/en/about/previous-releases" },
      ],
    });
  });

  it("leaves any other Code Mode script as execute", () => {
    for (const code of [
      'const hits = await tools.search({ query: "web" }); return hits;',
      `const hits = await tools.search({ query: "web" }); return tools["${server}"].t3_web_search({ query: "x" });`,
      `return tools["t3-code-other_thread"].t3_web_search({ query: "x" });`,
      `return tools["${server}"].t3_web_search({ instructions: "query: 'x'", query: q });`,
      `return tools["${server}"].t3_web_search(args) // query: "x"`,
      `const t = tools["${server}"].t3_web_search; await t({ query: "a" }); return t({ query: "b" });`,
      `const t = tools["${server}"].t3_web_search; return ["a"].map((q) => t({ query: "a" }));`,
      `for (const q of qs) await tools["${server}"].t3_web_search({ query: "a" });`,
    ]) {
      expect(project("execute", { code }).type, code).toBe("dynamic_tool");
    }
    expect(project("t3-code-other_thread_t3_web_search", { query: "x" }).type).toBe("dynamic_tool");
  });
});
