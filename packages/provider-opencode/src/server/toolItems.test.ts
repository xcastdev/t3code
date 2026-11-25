import { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_TOOL_OUTPUT_IMAGES,
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  toolOutputImages,
} from "@t3tools/shared/toolOutput";

import { openCodeToolOutput, openCodeToolTurnItem } from "./toolItems.ts";

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

describe("openCodeToolOutput", () => {
  it("preserves inline raster file content and leaves other files unserved", () => {
    const output = openCodeToolOutput("Preview complete", [
      { uri: "https://example.com/preview.png", mime: "image/png" },
      { uri: "file:///tmp/preview.png", mime: "image/png" },
      { uri: "data:image/svg+xml;base64,AAAA", mime: "image/svg+xml" },
      { uri: "data:image/png;base64,AAAA", mime: "image/jpeg" },
      { uri: "data:image/png;base64,", mime: "image/png" },
      { uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
    ]);
    expect(toolOutputImages(output)).toEqual([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(output).toEqual({
      content: [
        { type: "text", text: "Preview complete" },
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      ],
    });
    expect(openCodeToolOutput("Text result")).toBe("Text result");
    const oversized = "A".repeat(MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH + 4);
    const bounded = openCodeToolOutput(
      "Preview complete",
      Array.from({ length: MAX_TOOL_OUTPUT_IMAGES + 2 }, (_, index) => ({
        uri: `data:image/png;base64,${index === 0 ? oversized : "AQ=="}`,
        mime: "image/png",
      })),
    );
    expect(typeof bounded === "object" ? bounded.content.length : 0).toBe(
      MAX_TOOL_OUTPUT_IMAGES + 1,
    );
    const images = toolOutputImages(bounded);
    expect(images[0]?.data?.length).toBe(oversized.length);
    expect(images[1]?.data).toBe("AQ==");
  });
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
    expect(
      openCodeToolTurnItem(
        { ...base, status: "running" },
        {
          name: `${server}_t3_web_search`,
          input: { query: "x" },
          output: undefined,
          completedMetadata: undefined,
          t3McpServer: server,
        },
      ).type,
    ).toBe("dynamic_tool");
  });

  it.each([
    {
      name: "deletion",
      toolName: "edit",
      input: { oldString: "old\n", newString: "", newText: "fallback" },
      expected: { oldStr: "old\n", newStr: "" },
    },
    {
      name: "whitespace replacement",
      toolName: "edit",
      input: { oldString: " \t", newString: "\n\t" },
      expected: { oldStr: " \t", newStr: "\n\t" },
    },
    {
      name: "empty write",
      toolName: "write",
      input: { content: "" },
      expected: { newStr: "" },
    },
  ])("preserves exact file content for $name", ({ toolName, input, expected }) => {
    const item = openCodeToolTurnItem(
      {
        id: TurnItemId.make("tool-item"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: toolName,
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
      },
      {
        name: toolName,
        input: { filePath: "src/index.ts", ...input },
        output: undefined,
        completedMetadata: undefined,
      },
    );
    expect(item).toMatchObject({ type: "file_change", fileName: "src/index.ts", ...expected });
  });

  it("splits grep output into one result per matched line", () => {
    const item = openCodeToolTurnItem(
      {
        id: TurnItemId.make("grep-item"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: "grep",
        startedAt: null,
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-04T00:00:00Z"),
      },
      {
        name: "grep",
        input: { pattern: "export const \\w+", path: "/repo/src" },
        // Captured from OpenCode 2.4.1.
        output:
          'Found 2 matches\n/repo/src/one.ts:\n  Line 1: export const heading = "intro";\n\n\n/repo/src/two.ts:\n  Line 1: export const second = 2;',
        completedMetadata: undefined,
      },
    );
    expect(item).toMatchObject({
      type: "file_search",
      pattern: "export const \\w+",
      results: [
        { fileName: "/repo/src/one.ts", line: 1, preview: 'export const heading = "intro";' },
        { fileName: "/repo/src/two.ts", line: 1, preview: "export const second = 2;" },
      ],
    });
  });
});
