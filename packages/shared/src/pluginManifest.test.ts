import { PLUGIN_LIMITS } from "@t3tools/contracts";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import {
  decodePluginManifest,
  isHostApiCompatible,
  parsePluginResourceUri,
  parsePluginToolName,
  pluginAgentTools,
  pluginResourceUri,
  pluginToolName,
  pluginToolPolicyKey,
} from "./pluginManifest.ts";

const clientOnly = {
  manifestVersion: 1,
  id: "converter",
  name: "Converter",
  version: "1.0.0",
  hostApi: "1.0",
  author: "T3 Tools",
  ui: {
    panels: [{ id: "main", title: "Converter", entry: "panels/main.html" }],
    commands: [{ id: "open", title: "Open converter", opens: { panel: "main" } }],
  },
  capabilities: ["chat.attach"],
};

const searchOp = {
  name: "search_requests",
  title: "Search requests",
  description: "Search captured requests.",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  mutates: false,
  agent: true,
};

const withBackend = (backend: Record<string, unknown>) => ({
  ...clientOnly,
  id: "request-inspector",
  backend: {
    entry: "backend/index.cjs",
    operations: [searchOp],
    topics: [],
    resources: [],
    prerequisites: [],
    ...backend,
  },
});

const expectRejected = (input: unknown, fragment: string) => {
  const result = decodePluginManifest(input);
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) expect(result.failure).toContain(fragment);
};

describe("decodePluginManifest", () => {
  it("accepts the minimum client-only manifest", () => {
    const result = decodePluginManifest(clientOnly);
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isSuccess(result)) {
      expect(result.success.id).toBe("converter");
      expect(result.success.backend).toBeUndefined();
    }
  });

  it("rejects a manifest whose panel entry is not .html", () => {
    expectRejected(
      {
        ...clientOnly,
        ui: { ...clientOnly.ui, panels: [{ ...clientOnly.ui.panels[0], entry: "panels/main.js" }] },
      },
      "entry",
    );
  });

  it.each([
    "/abs/index.cjs",
    "../index.cjs",
    "backend/index.js",
    "a//b.cjs",
    "a\\b.cjs",
    "./index.cjs",
  ])("rejects a backend entry that is not a relative .cjs path: %s", (entry) => {
    expectRejected(withBackend({ entry }), "entry");
  });

  it("rejects a resource whose operation is undeclared or mutates", () => {
    expectRejected(
      withBackend({ resources: [{ name: "recent", title: "Recent", operation: "missing" }] }),
      'resource "recent"',
    );
    expectRejected(
      withBackend({
        operations: [searchOp, { ...searchOp, name: "replay", mutates: true }],
        resources: [{ name: "recent", title: "Recent", operation: "replay" }],
      }),
      'resource "recent"',
    );
  });

  it("rejects duplicate operation names and contribution ids", () => {
    expectRejected(withBackend({ operations: [searchOp, searchOp] }), "duplicate operation");
    expectRejected(
      {
        ...clientOnly,
        ui: { ...clientOnly.ui, panels: [clientOnly.ui.panels[0], clientOnly.ui.panels[0]] },
      },
      "duplicate panel",
    );
    expectRejected(
      {
        ...clientOnly,
        ui: { ...clientOnly.ui, commands: [clientOnly.ui.commands[0], clientOnly.ui.commands[0]] },
      },
      "duplicate command",
    );
    expectRejected(
      {
        ...clientOnly,
        ui: { ...clientOnly.ui, commands: [{ ...clientOnly.ui.commands[0], id: "main" }] },
      },
      'command "main" has the same id as a panel',
    );
  });

  it("rejects a command whose opens.panel names no declared panel", () => {
    expectRejected(
      {
        ...clientOnly,
        ui: {
          ...clientOnly.ui,
          commands: [{ id: "open", title: "Open", opens: { panel: "other" } }],
        },
      },
      'command "open"',
    );
  });

  it("rejects agent:true operations without inputSchema.type === 'object'", () => {
    expectRejected(
      withBackend({ operations: [{ ...searchOp, inputSchema: { type: "string" } }] }),
      'operation "search_requests"',
    );
    const notAgent = decodePluginManifest(
      withBackend({ operations: [{ ...searchOp, agent: false, inputSchema: {} }] }),
    );
    expect(Result.isSuccess(notAgent)).toBe(true);
  });

  it.each([
    [{ type: "object", properties: [] }, "inputSchema.properties is not an object"],
    [{ type: "object", properties: { query: "string" } }, "inputSchema.properties.query"],
    [{ type: "object", required: "query" }, "inputSchema.required"],
    [{ type: "object", required: [1] }, "inputSchema.required"],
    [{ type: "object", properties: { q: { type: "text" } } }, "inputSchema.properties.q.type"],
    [{ type: "object", properties: { q: { type: ["string", 3] } } }, "properties.q.type"],
    [{ type: "object", properties: { q: { type: "array", items: { type: "str" } } } }, "items"],
    [{ type: "object", $defs: { e: { type: "objekt" } } }, "inputSchema.$defs.e.type"],
  ])("rejects an agent operation with a malformed inputSchema: %j", (inputSchema, fragment) => {
    expectRejected(withBackend({ operations: [{ ...searchOp, inputSchema }] }), fragment);
  });

  it("accepts a nested inputSchema with enums, defaults, $defs, boolean subschemas and a property named type", () => {
    const inputSchema = {
      type: "object",
      properties: {
        type: { type: ["string", "null"], enum: ["a", null], default: null },
        anything: true,
        never: false,
        edits: { $ref: "#/$defs/edits" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["type"],
      additionalProperties: false,
      $defs: { edits: { type: "object", properties: { body: { type: "string" } } }, open: true },
      patternProperties: { "^x-": true },
    };
    const result = decodePluginManifest(
      withBackend({ operations: [{ ...searchOp, inputSchema }] }),
    );
    expect(Result.isSuccess(result)).toBe(true);
  });
});

describe("PLUGIN_LIMITS", () => {
  it("a full maxBodyChunkBytes chunk as base64 plus a 4 KiB envelope fits maxPayloadBytes", () => {
    const base64 = Buffer.alloc(PLUGIN_LIMITS.maxBodyChunkBytes).toString("base64");
    expect(base64.length).toBe(174_764);
    expect(base64.length + 4 * 1024).toBeLessThanOrEqual(PLUGIN_LIMITS.maxPayloadBytes);
    expect(PLUGIN_LIMITS.maxPayloadBytes).toBeLessThan(PLUGIN_LIMITS.maxMessageBytes);
  });
});

describe("isHostApiCompatible", () => {
  it.each([
    ["1.0", true],
    ["1.1", false],
    ["2.0", false],
    ["0.9", false],
    ["1", false],
    ["1.0.0", false],
  ])("hostApi %s compatible with 1.0 → %s", (version, ok) => {
    expect(isHostApiCompatible(version)).toBe(ok);
  });
});

describe("plugin ids", () => {
  it.each(["a--b", "a-", "-a", "a", "A-b", "a_b", "abcdefghijklmnopqrstuvwx"])(
    "rejects plugin id %s",
    (id) => {
      expectRejected({ ...clientOnly, id }, "id");
    },
  );

  it.each(["ab", "a-b", "a1-b2-c3", "abcdefghijklmnopqrstuvw"])("accepts plugin id %s", (id) => {
    expect(Result.isSuccess(decodePluginManifest({ ...clientOnly, id }))).toBe(true);
  });
});

describe("plugin tool names", () => {
  const PAIRS = [
    ["request-inspector-abcde", "search_requests_with_long_name_x"],
    ["a-b", "search"],
    ["ab", "b__search"],
    ["ab", "b_"],
    ["a1-b", "x"],
  ] as const;

  it.each(PAIRS)("round-trips tool name for %s / %s and keeps it ≤ 64 chars", (id, op) => {
    const name = pluginToolName(id, op);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(parsePluginToolName(name)).toEqual({ pluginId: id, operation: op });
  });

  it("the longest id and operation encode to exactly 64 chars", () => {
    expect(pluginToolName(PAIRS[0][0], PAIRS[0][1])).toHaveLength(64);
  });

  it("distinct (id, op) pairs never share a tool name", () => {
    expect(new Set(PAIRS.map(([id, op]) => pluginToolName(id, op))).size).toBe(PAIRS.length);
  });

  it.each([
    "mcp_6162__x",
    "plugin___x",
    "plugin_a_",
    "plugin_a__",
    "plugin_a___x",
    "plugin_A__x",
    "plugin_a-b__x",
  ])("parsePluginToolName(%s) is undefined", (name) => {
    expect(parsePluginToolName(name)).toBeUndefined();
  });

  it("builds the assistant policy key", () => {
    expect(pluginToolPolicyKey("request-inspector", "search_requests")).toBe(
      "plugin:request-inspector:search_requests",
    );
  });
});

describe("plugin resource uris", () => {
  it("round-trips a resource uri and rejects malformed ones", () => {
    const uri = pluginResourceUri("request-inspector", "recent_requests");
    expect(uri).toBe("t3-plugin://request-inspector/recent_requests");
    expect(parsePluginResourceUri(uri)).toEqual({
      pluginId: "request-inspector",
      name: "recent_requests",
    });
    for (const bad of [
      "t3-plugin://a/x",
      "t3-plugin://ab/",
      "t3-plugin://ab/x/y",
      "t3-plugin://ab/X",
      "ui://ab/x",
    ]) {
      expect(parsePluginResourceUri(bad)).toBeUndefined();
    }
  });
});

describe("pluginAgentTools", () => {
  it("lists only agent operations with read-only and destructive hints", () => {
    const result = decodePluginManifest(
      withBackend({
        operations: [
          searchOp,
          { ...searchOp, name: "replay", title: "Replay", mutates: true },
          { ...searchOp, name: "internal", agent: false },
        ],
      }),
    );
    if (!Result.isSuccess(result)) throw new Error("expected a valid manifest");
    expect(pluginAgentTools(result.success)).toEqual([
      {
        name: "plugin_request_inspector__search_requests",
        description: searchOp.description,
        inputSchema: searchOp.inputSchema,
        annotations: { title: "Search requests", readOnlyHint: true, destructiveHint: false },
      },
      {
        name: "plugin_request_inspector__replay",
        description: searchOp.description,
        inputSchema: searchOp.inputSchema,
        annotations: { title: "Replay", readOnlyHint: false, destructiveHint: true },
      },
    ]);
    expect(pluginAgentTools(clientOnlyDecoded())).toEqual([]);
  });
});

function clientOnlyDecoded() {
  const result = decodePluginManifest(clientOnly);
  if (!Result.isSuccess(result)) throw new Error("expected a valid manifest");
  return result.success;
}
