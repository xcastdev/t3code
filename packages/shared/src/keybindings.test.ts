import { expect, it } from "@effect/vitest";
import {
  DEFAULT_RESOLVED_KEYBINDINGS,
  compileResolvedKeybindingsConfig,
  matchesKeybindingShortcut,
  mergeWithDefaultKeybindings,
} from "./keybindings.ts";

it("opens Agents with one free default shortcut and preserves user replacement", () => {
  const event = {
    key: "G",
    code: "KeyG",
    metaKey: false,
    ctrlKey: true,
    shiftKey: true,
    altKey: true,
  };
  const matches = DEFAULT_RESOLVED_KEYBINDINGS.filter((rule) =>
    matchesKeybindingShortcut(event, rule.shortcut, "Linux"),
  );
  expect(matches.map((rule) => rule.command)).toEqual(["agents.open"]);
  expect(matches[0]?.whenAst).toEqual({
    type: "not",
    node: { type: "identifier", name: "terminalFocus" },
  });
  const replaced = mergeWithDefaultKeybindings(
    compileResolvedKeybindingsConfig([
      { command: "agents.open", key: "mod+shift+y", when: "!terminalFocus" },
    ]),
  );
  expect(
    replaced.some(
      (rule) =>
        rule.command === "agents.open" && matchesKeybindingShortcut(event, rule.shortcut, "Linux"),
    ),
  ).toBe(false);
  expect(
    replaced
      .filter((rule) =>
        matchesKeybindingShortcut(
          { ...event, key: "Y", code: "KeyY", altKey: false },
          rule.shortcut,
          "Linux",
        ),
      )
      .map((rule) => rule.command),
  ).toEqual(["agents.open"]);
});
