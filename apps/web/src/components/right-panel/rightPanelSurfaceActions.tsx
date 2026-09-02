import type { LucideIcon } from "lucide-react";
import { Bot, Files, GitBranch, Globe2 } from "lucide-react";

export type RightPanelSurfaceAction = {
  id: "browser" | "files" | "source-control" | "agents";
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
  sourceControl: "Source Control is only available when a project is open.",
  agents: "Agents are only available from a thread.",
} as const;

export function createRightPanelSurfaceActions(input: {
  browserAvailable: boolean;
  filesAvailable: boolean;
  sourceControlAvailable: boolean;
  agentsAvailable: boolean;
  liveAgentCount: number;
  onAddBrowser: () => void;
  onAddFiles: () => void;
  onAddSourceControl: () => void;
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
      id: "source-control",
      label: "Source Control",
      description: "Review changes, branches, and pull requests.",
      shortcut: "G",
      icon: GitBranch,
      available: input.sourceControlAvailable,
      disabledReason: DISABLED_REASONS.sourceControl,
      badgeCount: 0,
      onClick: input.onAddSourceControl,
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
