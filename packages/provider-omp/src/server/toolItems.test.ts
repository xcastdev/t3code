import { toolOutputImages, compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import { decodeOmpEvalDetail } from "@t3tools/shared/ompEval";
import { expect, it } from "@effect/vitest";
import { OmpToolItems } from "./toolItems.ts";
it("keeps native hashline arguments/results, treats mounted writes as execution, and replaces eval tails with final snapshots", () => {
  const tools = new OmpToolItems();
  const edit = tools.update({
    type: "tool_execution_start",
    toolCallId: "e",
    toolName: "edit",
    args: {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1#AA:old\n+new\n*** End Patch",
    },
  });
  expect(edit).toMatchObject({
    kind: "dynamic_tool",
    input: { input: expect.stringContaining("1#AA") },
  });
  expect(
    tools.update({
      type: "tool_execution_start",
      toolCallId: "w",
      toolName: "write",
      args: { path: "xd://device/tap", content: "x" },
    }),
  ).toMatchObject({ kind: "dynamic_tool" });
  const deviceWrite = (toolCallId: string, path: string, content: string) =>
    tools.update({
      type: "tool_execution_start",
      toolCallId,
      toolName: "write",
      args: { path, content },
    });
  expect(deviceWrite("r", "xd://html_render", '{"path":"page.html"}')).toMatchObject({
    name: "html_render",
    input: { path: "page.html" },
    kind: "dynamic_tool",
  });
  expect(tools.update({ type: "tool_execution_end", toolCallId: "r", result: {} })).toMatchObject({
    name: "html_render",
    input: { path: "page.html" },
    complete: true,
  });
  expect(deviceWrite("n", "xd://html_render", "not json")).toMatchObject({ name: "write" });
  expect(deviceWrite("p", "xd://html_render/x", "{}")).toMatchObject({ name: "write" });
  const run = tools.update({
    type: "tool_execution_update",
    toolCallId: "v",
    toolName: "eval",
    args: { language: "python", code: "print(1)" },
    partialResult: {
      content: [{ type: "text", text: "old tail" }],
      details: {
        cells: [
          {
            title: "Native cell title",
            output: "old tail",
            statusEvents: [
              { op: "phase", title: "Loading native data" },
              { op: "log", message: "loaded" },
            ],
          },
        ],
      },
    },
  });
  const done = tools.update({
    type: "tool_execution_end",
    toolCallId: "v",
    toolName: "eval",
    result: { content: [{ type: "text", text: "final" }], details: { durationMs: 5 } },
  });
  expect(run?.output).toMatchObject({
    t3OmpEval: {
      revision: 0,
      status: "running",
      title: "Native cell title",
      phase: "Loading native data",
      logs: ["loaded"],
    },
  });
  expect(done?.output).toMatchObject({
    t3OmpEval: { revision: 1, status: "completed" },
    content: [{ text: "final" }],
  });
  expect(JSON.stringify(done)).not.toContain("old tail");
  expect(
    tools.update({
      type: "tool_execution_end",
      toolCallId: "z",
      toolName: "future_native",
      result: { details: { opaque: 42 } },
    }),
  ).toMatchObject({ kind: "dynamic_tool", output: { details: { opaque: 42 } } });
});
it("stamps eval start, projects native grep/hashline batches and preserves browser provenance", () => {
  const tools = new OmpToolItems();
  expect(
    tools.update({
      type: "tool_execution_start",
      toolCallId: "eval-start",
      toolName: "eval",
      args: { language: "javascript", code: "1" },
    })?.output,
  ).toMatchObject({ t3OmpEval: { revision: 0, status: "running" } });
  expect(
    tools.update({
      type: "tool_execution_end",
      toolCallId: "grep",
      toolName: "grep",
      args: { pattern: "needle" },
      result: { details: { files: ["src/a.ts"], fileMatches: [{ path: "src/a.ts", count: 2 }] } },
    }),
  ).toMatchObject({ kind: "file_search", pattern: "needle", results: [{ fileName: "src/a.ts" }] });
  expect(
    tools.update({
      type: "tool_execution_end",
      toolCallId: "edit",
      toolName: "edit",
      result: {
        details: {
          perFileResults: [
            { path: "a.ts", diff: "-a\n+b" },
            { path: "b.ts", diff: "-c\n+d" },
          ],
        },
      },
    }),
  ).toMatchObject({
    kind: "file_change",
    changes: [
      { path: "a.ts", operation: "update" },
      { path: "b.ts", operation: "update" },
    ],
  });
  expect(
    tools.update({
      type: "tool_execution_end",
      toolCallId: "bash",
      toolName: "bash",
      result: { content: [], details: { exitCode: 7 } },
    }),
  ).toMatchObject({ exitCode: 7 });
  expect(
    tools.update({
      type: "tool_execution_start",
      toolCallId: "browser",
      toolName: "browser",
      args: { action: "snapshot" },
    }),
  ).toMatchObject({ kind: "dynamic_tool", toolSurface: "browser" });
});

it("projects native web sources and edit operation/move/snapshots without guessing text", () => {
  const tools = new OmpToolItems();
  expect(
    tools.update({
      type: "tool_execution_end",
      toolCallId: "web",
      toolName: "web_search",
      args: { query: "native query" },
      result: {
        details: {
          response: {
            provider: "fixture",
            sources: [{ title: "Source", url: "https://example.test", snippet: "Evidence" }],
          },
        },
      },
    }),
  ).toMatchObject({
    kind: "web_search",
    patterns: ["native query"],
    webResults: [{ title: "Source", url: "https://example.test", snippet: "Evidence" }],
  });
  expect(
    tools.update({
      type: "tool_execution_end",
      toolCallId: "move",
      toolName: "edit",
      result: {
        details: {
          path: "new.ts",
          sourcePath: "old.ts",
          op: "update",
          oldText: "before",
          newText: "after",
          diff: "-before\n+after",
        },
      },
    }),
  ).toMatchObject({
    kind: "file_change",
    changes: [{ path: "new.ts", oldPath: "old.ts", operation: "update" }],
    oldStr: "before",
    newStr: "after",
  });
});
it("normalizes native live images once and refreshes detail only for image or reply changes", () => {
  const tools = new OmpToolItems();
  const a = { type: "image", mimeType: "image/png", data: "YQ==" },
    b = { type: "image", mimeType: "image/jpeg", data: "Yg==" };
  const update = (text: string, images: unknown[], replies: string[] = []) =>
    tools.update({
      type: "tool_execution_update",
      toolCallId: "images",
      toolName: "eval",
      args: { language: "python" },
      partialResult: {
        content: [{ type: "text", text }],
        details: { images, replies, cells: [{ output: text, status: "running" }] },
      },
    })!;
  const first = update("one", [a]);
  expect(toolOutputImages(first.output)).toEqual([{ mimeType: "image/png", data: "YQ==" }]);
  expect(first.output).toMatchObject({
    t3OmpEval: { images: [{ index: 0, mimeType: "image/png" }], attachmentRevision: 1 },
  });
  expect(JSON.stringify(first.output).match(/YQ==/g)).toHaveLength(1);
  expect(update("more text", [a]).output).toMatchObject({ t3OmpEval: { attachmentRevision: 1 } });
  expect(update("two", [a, b]).output).toMatchObject({ t3OmpEval: { attachmentRevision: 2 } });
  expect(update("reply", [a, b], ["Native reply"]).output).toMatchObject({
    t3OmpEval: { attachmentRevision: 3 },
  });
  expect(update("more text", [a, b], ["Native reply"]).output).toMatchObject({
    t3OmpEval: { attachmentRevision: 3 },
  });
  const done = tools.update({
    type: "tool_execution_end",
    toolCallId: "images",
    toolName: "eval",
    result: { content: [b, a], details: { images: [b, a], replies: ["Native reply"] } },
  })!;
  expect(toolOutputImages(done.output)).toEqual([
    { mimeType: "image/jpeg", data: "Yg==" },
    { mimeType: "image/png", data: "YQ==" },
  ]);
  expect(done.output).toMatchObject({
    t3OmpEval: {
      attachmentRevision: 4,
      images: [
        { index: 0, mimeType: "image/jpeg" },
        { index: 1, mimeType: "image/png" },
      ],
    },
  });
  expect(JSON.stringify(done.output).match(/YQ==/g)).toHaveLength(1);
  const wire = compactDynamicToolOutput(done.output);
  expect(JSON.stringify(wire)).not.toContain("YQ==");
  expect(decodeOmpEvalDetail(wire, {}, true)?.images).toEqual([
    { index: 0, mimeType: "image/jpeg" },
    { index: 1, mimeType: "image/png" },
  ]);
});
