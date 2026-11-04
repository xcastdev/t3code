import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  asT3WebSearchTurnItem,
  compactDynamicToolOutput,
  MAX_TOOL_OUTPUT_IMAGES,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "./toolOutput.ts";

describe("compactDynamicToolOutput", () => {
  it("extracts IDs through the MCP result envelopes used by T3 summaries", () => {
    const metadata = { threadId: "thread-1", messageId: "message-1" };
    const json = JSON.stringify({ ...metadata, response: "Private response body" });
    for (const value of [
      { ...metadata, response: "Private response body" },
      { structuredContent: JSON.parse(json), content: "Ignored alternative body" },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual(metadata);
    }
  });

  it("keeps nested thread identity and scalar task IDs without result bodies", () => {
    const output = {
      thread: { threadId: "thread-1", messages: ["Private message"] },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      status: "failed",
      summary: "A child failed; the tool itself succeeded.",
      unlinked: [{ repository: "acme/app", state: "merged", numbers: [1] }],
      unlinkedCount: 1,
      linkedCount: 2,
    };
    expect(compactDynamicToolOutput(output)).toEqual({
      thread: { threadId: "thread-1" },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      linkedCount: 2,
      unlinkedCount: 1,
    });
    expect(output.thread.messages).toEqual(["Private message"]);
  });

  it("keeps explicit envelope failure while dropping error text and arbitrary output", () => {
    for (const failure of [
      { isError: true },
      { is_error: true },
      { _tag: "OrchestratorMcpFailure" },
      { error: { message: "Private error" } },
    ]) {
      expect(
        compactDynamicToolOutput({
          ...failure,
          structuredContent: { threadId: "thread-1", error: "Private details" },
        }),
      ).toEqual({ isError: true, threadId: "thread-1" });
    }
    expect(compactDynamicToolOutput("Private plain text")).toBeUndefined();
    expect(compactDynamicToolOutput({ result: { body: "Private result" } })).toBeUndefined();
  });

  it("uses the first result data but combines explicit failure flags across content blocks", () => {
    expect(
      compactDynamicToolOutput([
        { text: JSON.stringify({ threadId: "first" }) },
        { text: JSON.stringify({ threadId: "second", isError: true, error: "Private error" }) },
      ]),
    ).toEqual({ threadId: "first", isError: true });
    expect(
      compactDynamicToolOutput([{ text: "{}" }, { text: JSON.stringify({ threadId: "second" }) }]),
    ).toBeUndefined();
  });

  it("keeps complete thread creation batches and rollback markers without row bodies", () => {
    expect(
      compactDynamicToolOutput({
        threads: [
          { threadId: "created", status: "running", messages: ["Private message"] },
          { threadId: "reverted", status: "rolled_back", error: "Private error" },
          { status: "rolled_back" },
        ],
      }),
    ).toEqual({
      threads: [
        { threadId: "created" },
        { threadId: "reverted", status: "rolled_back" },
        { status: "rolled_back" },
      ],
    });
    expect(compactDynamicToolOutput({ threadId: "reverted", status: "rolled_back" })).toEqual({
      threadId: "reverted",
      status: "rolled_back",
    });
    expect(compactDynamicToolOutput({ threads: [] })).toEqual({ threads: [] });
  });

  it("omits incomplete or oversized creation evidence instead of returning a partial count", () => {
    for (const threads of [
      [{ threadId: "known" }, { title: "No confirmed ID" }],
      Array.from({ length: 101 }, (_, index) => ({ threadId: `thread-${index}` })),
      Array.from({ length: 100 }, (_, index) => ({ threadId: `${index}`.padEnd(256, "x") })),
      [{ threadId: "x".repeat(257) }],
    ]) {
      expect(
        compactDynamicToolOutput({
          threadId: "must-not-be-counted-as-one",
          status: "rolled_back",
          taskId: "task-1",
          threads,
        }),
      ).toEqual({ taskId: "task-1" });
    }
    const normalBatch = {
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    expect(compactDynamicToolOutput(normalBatch)).toEqual(normalBatch);
    expect(
      new TextEncoder().encode(JSON.stringify(compactDynamicToolOutput(normalBatch))).byteLength,
    ).toBeLessThanOrEqual(8_192);
  });

  it("bounds parsing and envelope scanning while preserving an outer failure marker", () => {
    const oversizedJson = JSON.stringify({ threadId: "hidden", body: "😄".repeat(5_000) });
    for (const content of [
      "x".repeat(1_000_000),
      oversizedJson,
      Array.from({ length: 33 }, () => ({ text: JSON.stringify({ threadId: "hidden" }) })),
      { content: { content: { content: { content: { threadId: "too-deep" } } } } },
    ]) {
      expect(compactDynamicToolOutput({ isError: true, content })).toEqual({ isError: true });
    }
    expect(compactDynamicToolOutput({ threadId: "known", body: "x".repeat(1_000_000) })).toEqual({
      threadId: "known",
    });
  });
});

describe("toolOutputIndicatesFailure", () => {
  it("preserves the command failure phrases across shells without copying the output", () => {
    for (const text of [
      "FILE NOT FOUND",
      "No files found",
      "ENOENT",
      "No such file or directory",
      "CommandNotFoundException",
      "command not found",
      "Cannot find path 'a' because it does not exist",
      "The term 'example' is not recognized",
      "is not recognized as the name of a cmdlet",
      "A parameter cannot be found that matches parameter name",
      "<exited with exit code 2>",
      "Exited with exit code 1",
      "exit code: 127",
    ])
      expect(toolOutputIndicatesFailure(text)).toBe(true);
  });

  it("does not mark successful exit codes or incomplete failure phrases", () => {
    for (const text of [
      "Done",
      "exit code: 0",
      "Exited with exit code 0",
      "cannot find path",
      "is not recognized",
    ]) {
      expect(toolOutputIndicatesFailure(text)).toBe(false);
    }
  });
});

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });
});

describe("asT3WebSearchTurnItem", () => {
  const toolCall = (toolName: string, output: unknown): OrchestrationV2TurnItem => ({
    id: TurnItemId.make("item"),
    threadId: ThreadId.make("thread"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Web search",
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(0),
    type: "dynamic_tool",
    toolName,
    input: { query: " latest Node.js ", instructions: "Cite nodejs.org" },
    output,
  });
  const result = {
    answer: "Node.js 26.1.0",
    sources: [
      { title: "Releases", url: "https://nodejs.org/en/about/previous-releases" },
      { title: "No link", url: " " },
    ],
  };

  it("stores each provider's T3 web search call as a native web search", () => {
    for (const [toolName, output] of [
      ["mcp__t3-code__t3_web_search", [{ type: "text", text: JSON.stringify(result) }]],
      ["t3-code.t3_web_search", result],
      ["t3-code_t3_web_search", JSON.stringify(result)],
      [
        "t3-code-direct.t3_web_search",
        { content: [{ type: "text", text: JSON.stringify(result) }] },
      ],
    ] as const) {
      const { updatedAt: _updatedAt, ...item } = asT3WebSearchTurnItem(toolCall(toolName, output));
      expect(item).toEqual({
        id: "item",
        threadId: "thread",
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: null,
        completedAt: null,
        type: "web_search",
        patterns: ["latest Node.js"],
        results: [
          { title: "Answer", snippet: "Node.js 26.1.0" },
          { title: "Releases", url: "https://nodejs.org/en/about/previous-releases" },
        ],
      });
    }
  });

  it("marks a returned failure and leaves other tools alone", () => {
    const failed = asT3WebSearchTurnItem(
      toolCall("t3-code.t3_web_search", {
        isError: true,
        content: [{ type: "text", text: '{"message":"Web search is off"}' }],
      }),
    );
    expect(failed.status).toBe("failed");
    expect(failed.type === "web_search" ? failed.results : null).toEqual([
      { title: "Error", snippet: "Web search is off" },
    ]);
    for (const toolName of [
      "mcp__t3-code__t3_thread_read",
      "t3_web_search",
      "mcp__other__t3_web_search",
      "other.t3_web_search",
      "t3-code-other_thread_t3_web_search",
    ]) {
      const other = toolCall(toolName, result);
      expect(asT3WebSearchTurnItem(other), toolName).toBe(other);
    }
  });

  it("keeps unparsed output and non-execution, bounded for the timeline", () => {
    const timedOut = asT3WebSearchTurnItem({
      ...toolCall("mcp__t3-code__t3_web_search", "MCP error -32001: Request timed out"),
      status: "failed",
      toolNonExecutionKind: "denied",
    });
    expect(timedOut).toMatchObject({
      type: "web_search",
      status: "failed",
      toolNonExecutionKind: "denied",
      results: [{ title: "Error", snippet: "MCP error -32001: Request timed out" }],
    });
    const prose = asT3WebSearchTurnItem(toolCall("t3-code.t3_web_search", "Node.js 26.1.0"));
    expect(prose.type === "web_search" ? prose.results : null).toEqual([
      { title: "Output", snippet: "Node.js 26.1.0" },
    ]);

    const oversized = asT3WebSearchTurnItem(
      toolCall("t3-code.t3_web_search", {
        structuredContent: {
          answer: "x".repeat(70_000),
          sources: [
            { title: "Script", url: "javascript:alert(1)" },
            { title: "Long", url: `https://example.com/${"u".repeat(3_000)}` },
            ...Array.from({ length: 60 }, (_, index) => ({
              title: "t".repeat(9_000),
              url: `https://example.com/${index}`,
            })),
          ],
        },
      }),
    );
    const results = oversized.type === "web_search" ? (oversized.results ?? []) : [];
    expect(results[0]?.snippet?.length).toBeLessThanOrEqual(8_192);
    expect(results.length).toBeGreaterThan(1);
    expect(results.length).toBeLessThanOrEqual(21);
    expect(results.slice(1).every((entry) => entry.title?.length === 300)).toBe(true);
    expect(results.slice(1).every((entry) => entry.url?.startsWith("https://example.com/"))).toBe(
      true,
    );
    expect(results.some((entry) => entry.url?.includes("uuu"))).toBe(false);
    expect(JSON.stringify(oversized).length).toBeLessThanOrEqual(17_000);
  });
});
