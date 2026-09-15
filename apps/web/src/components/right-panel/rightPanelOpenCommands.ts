import type { KeybindingCommand } from "@t3tools/contracts";
const TARGETS = {
  "rightPanel.openBrowser": "browser",
  "rightPanel.openFiles": "files",
  "rightPanel.openSourceControl": "sourceControl",
  "rightPanel.openAgents": "agents",
  "rightPanel.openPullRequest": "pullRequest",
  "rightPanel.openLinkedPullRequests": "pullRequests",
  "rightPanel.openDevice": "device",
} as const;

export function dispatchRightPanelOpenCommand(input: {
  command: KeybindingCommand;
  event: Pick<KeyboardEvent, "repeat" | "preventDefault" | "stopPropagation">;
  available: Record<
    "browser" | "files" | "sourceControl" | "agents" | "pullRequest" | "pullRequests" | "device",
    boolean
  >;
  open: Record<
    "browser" | "files" | "sourceControl" | "agents" | "pullRequest" | "pullRequests" | "device",
    () => void
  >;
}): boolean {
  const target = TARGETS[input.command as keyof typeof TARGETS];
  if (!target || !input.available[target]) return false;
  input.event.preventDefault();
  input.event.stopPropagation();
  if (!input.event.repeat) input.open[target]();
  return true;
}
