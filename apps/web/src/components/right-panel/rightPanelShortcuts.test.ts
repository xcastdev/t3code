import { describe, expect, it } from "vite-plus/test";
import { rightPanelRailShortcutAction } from "./rightPanelShortcuts";
describe("rightPanelRailShortcutAction", () => {
  it("only resolves mnemonics from the focused rail", () => {
    const actions = [{ shortcut: "B", available: true }] as const;
    const event = {
      key: "b",
      altKey: false,
      ctrlKey: false,
      defaultPrevented: false,
      isComposing: false,
      metaKey: false,
    };
    expect(rightPanelRailShortcutAction(actions, event, false)).toBeNull();
    expect(rightPanelRailShortcutAction(actions, event, true)).toBe(actions[0]);
  });
});
