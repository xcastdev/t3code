import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { resolveShortcutCommand } from "~/keybindings";
import {
  buildKeybindingCommandOptions,
  commandLabel,
  buildKeybindingRows,
} from "../settings/KeybindingsSettings.logic";
import { dispatchRightPanelOpenCommand } from "./rightPanelOpenCommands";

const cases = [
  ["rightPanel.openBrowser", "browser", "Right Panel: Open Browser"],
  ["rightPanel.openFiles", "files", "Right Panel: Open Files"],
  ["rightPanel.openSourceControl", "sourceControl", "Right Panel: Open Source Control"],
  ["rightPanel.openAgents", "agents", "Right Panel: Open Agents"],
  ["rightPanel.openPullRequest", "pullRequest", "Right Panel: Open Pull Request"],
  ["rightPanel.openLinkedPullRequests", "pullRequests", "Right Panel: Open Linked Pull Requests"],
  ["rightPanel.openDevice", "device", "Right Panel: Open Device"],
] as const;
const available = {
  browser: true,
  files: true,
  sourceControl: true,
  agents: true,
  pullRequest: true,
  pullRequests: true,
  device: true,
};
function callbacks() {
  return {
    browser: vi.fn(),
    files: vi.fn(),
    sourceControl: vi.fn(),
    agents: vi.fn(),
    pullRequest: vi.fn(),
    pullRequests: vi.fn(),
    device: vi.fn(),
  };
}
function event(repeat = false) {
  return { repeat, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

describe("the ChatView right-panel command boundary", () => {
  it.each(cases)("dispatches %s only when available and never repeats", (command, target) => {
    for (const enabled of [true, false])
      for (const repeat of [true, false]) {
        const open = callbacks();
        const key = event(repeat);
        expect(
          dispatchRightPanelOpenCommand({
            command,
            event: key,
            available: { ...available, [target]: enabled },
            open,
          }),
        ).toBe(enabled);
        for (const name of Object.keys(open) as Array<keyof typeof open>)
          expect(open[name]).toHaveBeenCalledTimes(enabled && !repeat && name === target ? 1 : 0);
        expect(key.preventDefault).toHaveBeenCalledTimes(enabled ? 1 : 0);
        expect(key.stopPropagation).toHaveBeenCalledTimes(enabled ? 1 : 0);
      }
  });
  it("leaves unrelated commands to their owner", () => {
    const key = event();
    expect(
      dispatchRightPanelOpenCommand({
        command: "terminal.new",
        event: key,
        available,
        open: callbacks(),
      }),
    ).toBe(false);
    expect(key.preventDefault).not.toHaveBeenCalled();
  });
  it.each(cases)(
    "offers %s in settings without stealing a default shortcut",
    (command, _target, label) => {
      expect(buildKeybindingCommandOptions([])).toContain(command);
      expect(commandLabel(command)).toBe(label);
      expect(DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) => rule.command === command)).toEqual([]);
    },
  );
  it.each(cases)("resolves a configured %s and reports conflicting bindings", (command, target) => {
    const custom = compileResolvedKeybindingsConfig([
      { key: "ctrl+alt+b", command, when: "!terminalFocus" },
    ]);
    const bindings = mergeWithDefaultKeybindings(custom);
    const key = { key: "b", ctrlKey: true, altKey: true, metaKey: false, shiftKey: false };
    const resolved = resolveShortcutCommand(key, bindings, { context: { terminalFocus: false } });
    expect(resolved).toBe(command);
    const open = callbacks();
    expect(
      dispatchRightPanelOpenCommand({ command: resolved!, event: event(), available, open }),
    ).toBe(true);
    expect(open[target]).toHaveBeenCalledOnce();
    expect(resolveShortcutCommand(key, bindings, { context: { terminalFocus: true } })).not.toBe(
      command,
    );
    const collision = compileResolvedKeybindingsConfig([
      { key: "ctrl+alt+b", command },
      { key: "ctrl+alt+b", command: "chat.new" },
    ]);
    expect(
      buildKeybindingRows(collision, "").find((row) => row.command === command)?.conflicts,
    ).toEqual(["Chat: New"]);
    expect(resolveShortcutCommand(key, collision)).toBe("chat.new");
  });
});
