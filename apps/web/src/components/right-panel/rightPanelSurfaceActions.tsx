import type { LucideIcon } from "lucide-react";
import { Bot, FileDiff, Files, GitPullRequest, Globe2 } from "lucide-react";

export type RightPanelSurfaceAction = {
  id: "browser" | "files" | "diff" | "pull-request" | "agents";
  label: string;
  description: string;
  shortcut: string;
  icon: LucideIcon;
  available: boolean;
  disabledReason: string;
  badgeCount: number;
  onClick: () => void;
};

const DISABLED_REASONS = {
  browser: "Browser previews are only available in the T3 Code desktop app.",
  files: "Project Explorer is only available when a project is open.",
  diff: "Diff is only available for server threads in Git repositories.",
  pullRequest: "This thread's branch has no pull request yet.",
  agents: "Agents are only available from a thread.",
} as const;

export function createRightPanelSurfaceActions(input: {
  browserAvailable: boolean;
  diffAvailable: boolean;
  filesAvailable: boolean;
  pullRequestAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
  onAddBrowser: () => void;
  onAddDiff: () => void;
  onAddFiles: () => void;
  onAddPullRequest: () => void;
  onAddAgents: () => void;
}): RightPanelSurfaceAction[] {
  return [
    {
      id: "browser",
      label: "Browser",
      description: "Open a local app or URL.",
      shortcut: "B",
      icon: Globe2,
      available: input.browserAvailable,
      disabledReason: DISABLED_REASONS.browser,
      badgeCount: 0,
      onClick: input.onAddBrowser,
    },
    {
      id: "files",
      label: "Project Explorer",
      description: "Browse workspace files.",
      shortcut: "F",
      icon: Files,
      available: input.filesAvailable,
      disabledReason: DISABLED_REASONS.files,
      badgeCount: 0,
      onClick: input.onAddFiles,
    },
    {
      id: "diff",
      label: "Diff",
      description: "Review changes in this thread.",
      shortcut: "D",
      icon: FileDiff,
      available: input.diffAvailable,
      disabledReason: DISABLED_REASONS.diff,
      badgeCount: 0,
      onClick: input.onAddDiff,
    },
    {
      id: "pull-request",
      label: "Pull request",
      description: "Open this branch's pull request.",
      shortcut: "P",
      icon: GitPullRequest,
      available: input.pullRequestAvailable,
      disabledReason: DISABLED_REASONS.pullRequest,
      badgeCount: 0,
      onClick: input.onAddPullRequest,
    },
    {
      id: "agents",
      label: "Agents",
      description: "Follow subagents and workflows.",
      shortcut: "A",
      icon: Bot,
      available: input.agentsAvailable,
      disabledReason: DISABLED_REASONS.agents,
      badgeCount: input.liveAgentCount,
      onClick: input.onAddAgents,
    },
  ];
}
