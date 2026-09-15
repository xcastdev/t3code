import { describe, expect, it } from "vite-plus/test";
import { dispatchRightPanelOpenCommand } from "./rightPanelOpenCommands";
const keys = [
  "browser",
  "files",
  "sourceControl",
  "agents",
  "pullRequest",
  "pullRequests",
  "device",
] as const;
const commands = [
  "rightPanel.openBrowser",
  "rightPanel.openFiles",
  "rightPanel.openSourceControl",
  "rightPanel.openAgents",
  "rightPanel.openPullRequest",
  "rightPanel.openLinkedPullRequests",
  "rightPanel.openDevice",
] as const;
describe("dispatchRightPanelOpenCommand", () =>
  it("routes every available command once", () => {
    const seen: string[] = [];
    for (const [index, command] of commands.entries()) {
      const target = keys[index]!;
      expect(
        dispatchRightPanelOpenCommand({
          command,
          event: { repeat: false, preventDefault() {}, stopPropagation() {} },
          available: Object.fromEntries(keys.map((key) => [key, key === target])) as Record<
            (typeof keys)[number],
            boolean
          >,
          open: Object.fromEntries(
            keys.map((key) => [
              key,
              () => {
                seen.push(key);
              },
            ]),
          ) as unknown as Record<(typeof keys)[number], () => void>,
        }),
      ).toBe(true);
    }
    expect(seen).toEqual(keys);
  }));
