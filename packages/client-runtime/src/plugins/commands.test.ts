import { EnvironmentId, type PluginManifest } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CLIENT_PLUGIN_SCOPE_LABEL,
  listPluginPanelTargets,
  pluginPanelKey,
  resolvePluginCommand,
  type PluginInstallEntry,
} from "./commands.ts";

const manifest = {
  manifestVersion: 1,
  id: "converter",
  name: "Converter",
  version: "0.1.0",
  hostApi: "1.0",
  author: "T3 Tools",
  ui: {
    panels: [
      { id: "converter", title: "Converter", entry: "ui/converter.html" },
      { id: "open", title: "A panel named open", entry: "ui/open.html" },
    ],
    commands: [{ id: "open", title: "Open Converter", opens: { panel: "converter" } }],
  },
  capabilities: [],
} as unknown as PluginManifest;

const A = EnvironmentId.make("env-a");
const B = EnvironmentId.make("env-b");

const install = (scope: EnvironmentId | "client"): PluginInstallEntry => ({
  scope,
  scopeLabel: scope === "client" ? CLIENT_PLUGIN_SCOPE_LABEL : `Machine ${scope}`,
  record: { pluginId: manifest.id, version: manifest.version, manifest },
});

const open = { pluginId: "converter", commandId: "open" };
const converterIn = (scope: EnvironmentId | "client") =>
  pluginPanelKey(scope, manifest.id, "converter");

describe("resolvePluginCommand", () => {
  it.each([
    {
      name: "chat in A, installed in A, B, and client opens A",
      installs: [install(B), install("client"), install(A)],
      chat: A,
      expected: { kind: "open", key: converterIn(A) },
    },
    {
      name: "chat in A, installed in B and client opens client",
      installs: [install(B), install("client")],
      chat: A,
      expected: { kind: "open", key: converterIn("client") },
    },
    {
      name: "no chat, installed only in B opens B",
      installs: [install(B)],
      chat: null,
      expected: { kind: "open", key: converterIn(B) },
    },
  ])("$name", ({ installs, chat, expected }) => {
    expect(resolvePluginCommand(open, installs, chat)).toEqual(expected);
  });

  it("opens the command's panel, never a panel named after the command", () => {
    const resolved = resolvePluginCommand(open, [install(A)], A);
    expect(resolved).toEqual({ kind: "open", key: converterIn(A) });
  });

  it("asks to choose when no chat and two environments have it", () => {
    const resolved = resolvePluginCommand(open, [install(A), install(B)], null);
    expect(resolved.kind).toBe("choose");
    if (resolved.kind !== "choose") return;
    expect(resolved.title).toBe("Open Converter");
    expect(resolved.candidates.map((candidate) => candidate.key)).toEqual([
      converterIn(A),
      converterIn(B),
    ]);
  });

  it("is missing for an unknown command id", () => {
    expect(
      resolvePluginCommand({ pluginId: "converter", commandId: "close" }, [install(A)], A),
    ).toEqual({ kind: "missing" });
  });
});

describe("listPluginPanelTargets", () => {
  it("gives distinct keys and scope labels for the same plugin in A, B, and client", () => {
    const targets = listPluginPanelTargets([install(A), install(B), install("client")]);
    const panels = targets.filter(
      (target) => target.kind === "panel" && target.title === "Converter",
    );
    expect(panels.map((target) => [target.key, target.scopeLabel])).toEqual([
      [converterIn(A), "Machine env-a"],
      [converterIn(B), "Machine env-b"],
      [converterIn("client"), CLIENT_PLUGIN_SCOPE_LABEL],
    ]);
    expect(targets.filter((target) => target.kind === "command")).toHaveLength(3);
  });
});
