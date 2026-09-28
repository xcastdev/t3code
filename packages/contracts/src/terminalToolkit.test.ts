import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import * as Contracts from "./index.ts";

function exportedSchema(name: string): Schema.Top | undefined {
  const value = Reflect.get(Contracts, name);
  return value === undefined ? undefined : (value as Schema.Top);
}

function decodes(schema: Schema.Top, value: unknown): boolean {
  try {
    Schema.decodeUnknownSync(schema as never)(value);
    return true;
  } catch {
    return false;
  }
}

describe("project terminal contracts", () => {
  it("requires both owner identifiers and bounds launch inputs", () => {
    const handle = exportedSchema("ProjectTerminalHandle");
    const create = exportedSchema("ProjectTerminalCreateInput");
    expect(handle).toBeDefined();
    expect(create).toBeDefined();
    if (!handle || !create) return;

    const validHandle = { projectId: "project-1", terminalId: "terminal-1" };
    expect(decodes(handle, validHandle)).toBe(true);
    expect(decodes(handle, { terminalId: "terminal-1" })).toBe(false);
    expect(decodes(handle, { projectId: "project-1" })).toBe(false);

    const validCreate = {
      ...validHandle,
      creatingThreadId: "thread-1",
      cwd: "/tmp/project",
      command: "printf",
      args: ["hello world", "$HOME; echo safe"],
      title: "Agent shell",
      env: { CUSTOM_FLAG: "value" },
    };
    expect(decodes(create, validCreate)).toBe(true);
    expect(decodes(create, { ...validCreate, title: "x".repeat(129) })).toBe(false);
    expect(decodes(create, { ...validCreate, command: "" })).toBe(false);
    expect(decodes(create, { ...validCreate, command: "x".repeat(8_193) })).toBe(false);
    expect(decodes(create, { ...validCreate, args: ["x".repeat(8_193)] })).toBe(false);
    expect(decodes(create, { ...validCreate, args: Array(129).fill("arg") })).toBe(false);
    expect(decodes(create, { ...validCreate, command: undefined, args: ["orphan"] })).toBe(false);
    expect(decodes(create, { ...validCreate, command: "bad\u0000command" })).toBe(false);
    expect(decodes(create, { ...validCreate, args: ["bad\u0000argument"] })).toBe(false);
    expect(
      decodes(create, {
        ...validCreate,
        env: { CUSTOM_FLAG: "bad\u0000environment" },
      }),
    ).toBe(false);
    expect(
      decodes(create, {
        ...validCreate,
        command: "c".repeat(8_192),
        args: Array(8).fill("é".repeat(8_192)),
      }),
    ).toBe(false);
  });

  it("keeps the existing terminal write and dimension limits", () => {
    const write = exportedSchema("ProjectTerminalWriteInput");
    const resize = exportedSchema("ProjectTerminalResizeInput");
    expect(write).toBeDefined();
    expect(resize).toBeDefined();
    if (!write || !resize) return;

    const handle = { projectId: "project-1", terminalId: "terminal-1" };
    expect(decodes(write, { ...handle, data: "x".repeat(65_536) })).toBe(true);
    expect(decodes(write, { ...handle, data: "x".repeat(65_537) })).toBe(false);
    expect(decodes(write, { ...handle, data: "" })).toBe(false);
    expect(decodes(resize, { ...handle, cols: 1, rows: 1 })).toBe(true);
    expect(decodes(resize, { ...handle, cols: 1_000, rows: 500 })).toBe(true);
    expect(decodes(resize, { ...handle, cols: 1_001, rows: 24 })).toBe(false);
    expect(decodes(resize, { ...handle, cols: 120, rows: 501 })).toBe(false);
  });

  it("represents failed terminal cleanup as a typed tool error", () => {
    const error = exportedSchema("TerminalToolError");
    expect(error).toBeDefined();
    if (!error) return;

    expect(
      decodes(error, {
        _tag: "TerminalToolError",
        operation: "close",
        reason: "cleanup-failed",
        projectId: "project-1",
      }),
    ).toBe(true);
  });

  it("bounds read inputs and distinguishes stream and literal-search results", () => {
    const input = exportedSchema("TerminalReadInput");
    const result = exportedSchema("TerminalReadResult");
    expect(input).toBeDefined();
    expect(result).toBeDefined();
    if (!input || !result) return;

    const handle = { projectId: "project-1", terminalId: "terminal-1" };
    expect(decodes(input, handle)).toBe(true);
    expect(decodes(input, { ...handle, maxBytes: 0 })).toBe(false);
    expect(decodes(input, { ...handle, maxBytes: 65_537 })).toBe(false);
    expect(decodes(input, { ...handle, waitMs: -1 })).toBe(false);
    expect(decodes(input, { ...handle, waitMs: 30_001 })).toBe(false);
    expect(decodes(input, { ...handle, tailLines: 0 })).toBe(false);
    expect(decodes(input, { ...handle, tailLines: 501 })).toBe(false);
    expect(decodes(input, { ...handle, tailLines: 4, cursor: "cursor" })).toBe(false);
    expect(decodes(input, { ...handle, tailLines: 4, search: { text: "x" } })).toBe(false);
    expect(decodes(input, { ...handle, search: { text: "x" }, waitMs: 1 })).toBe(false);
    expect(decodes(input, { ...handle, search: { text: "" } })).toBe(false);
    expect(decodes(input, { ...handle, search: { text: "x".repeat(257) } })).toBe(false);

    const summary = {
      ...handle,
      title: null,
      command: null,
      args: [],
      cwd: "/tmp/project",
      creatingThreadId: "thread-1",
      label: "Terminal",
      status: "running",
      pid: 42,
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-09-28T00:00:00Z",
    };
    expect(
      decodes(result, {
        kind: "stream",
        terminal: summary,
        output: "hello\n",
        nextCursor: "opaque",
        hasMore: false,
        truncated: false,
      }),
    ).toBe(true);
    expect(
      decodes(result, {
        kind: "search",
        terminal: summary,
        matches: [{ start: 12, end: 17, excerpt: "hello" }],
        nextCursor: "opaque",
        hasMore: false,
        truncated: false,
      }),
    ).toBe(true);
    expect(
      decodes(result, {
        kind: "search",
        terminal: summary,
        matches: [{ start: -1, end: 4, excerpt: "hello" }],
        nextCursor: "opaque",
        hasMore: false,
        truncated: false,
      }),
    ).toBe(false);
  });
});
