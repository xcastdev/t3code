import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { KeybindingCommand } from "./keybindings.ts";
import {
  PluginOperationCallInput,
  PluginRequestError,
  PluginSubscriptionEvent,
} from "./plugins.ts";

const isKeybindingCommand = Schema.is(KeybindingCommand);
const isSubscriptionEvent = Schema.is(PluginSubscriptionEvent);
const decodeCallInput = Schema.decodeUnknownExit(PluginOperationCallInput);

describe("plugin keybinding commands", () => {
  it("decodes plugin.converter.open as a KeybindingCommand", () => {
    expect(isKeybindingCommand("plugin.converter.open")).toBe(true);
    expect(isKeybindingCommand("plugin.request-inspector.open-inspector")).toBe(true);
  });

  it.each(["plugin.a.open", "plugin.Converter.open", "plugin.converter.", "plugin.a--b.open"])(
    "rejects %s",
    (command) => {
      expect(isKeybindingCommand(command)).toBe(false);
    },
  );
});

describe("PluginSubscriptionEvent", () => {
  it("rejects a snapshot without revision or with a cursor over 1024 chars", () => {
    expect(isSubscriptionEvent({ type: "snapshot", items: [], revision: "1", cursor: null })).toBe(
      true,
    );
    expect(isSubscriptionEvent({ type: "snapshot", items: [], cursor: null })).toBe(false);
    expect(
      isSubscriptionEvent({
        type: "snapshot",
        items: [],
        revision: "1",
        cursor: "c".repeat(1025),
      }),
    ).toBe(false);
    expect(isSubscriptionEvent({ type: "batch", items: [], revision: "r".repeat(129) })).toBe(
      false,
    );
  });
});

describe("PluginRequestError", () => {
  it("gives timed-out and version-changed their fixed messages", () => {
    expect(new PluginRequestError({ reason: "timed-out" }).message).toBe(
      "The plugin did not answer in time. A state-changing operation may still finish; check its status before retrying.",
    );
    expect(new PluginRequestError({ reason: "version-changed" }).message).toBe(
      "This plugin was updated. Reload the panel.",
    );
  });
});

describe("PluginOperationCallInput", () => {
  const base = { pluginId: "request-inspector", operation: "list_proxies", input: {} };

  it.each([
    ["no chat hint", base, true],
    ["a thread hint", { ...base, chat: { threadId: "thread-1" } }, true],
    ["a project hint", { ...base, chat: { projectId: "project-1" } }, true],
    ["a hint with both keys", { ...base, chat: { threadId: "t", projectId: "p" } }, false],
    ["an empty hint", { ...base, chat: {} }, false],
  ])("%s decodes → %s", (_name, input, ok) => {
    const exit = decodeCallInput(input);
    expect(exit._tag === "Success").toBe(ok);
    if (exit._tag === "Success" && "chat" in input) expect(exit.value.chat).toEqual(input.chat);
  });
});
