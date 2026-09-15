import {
  Bot,
  Files,
  GitBranch,
  GitPullRequest,
  GitPullRequestArrow,
  Globe2,
  Smartphone,
} from "lucide-react";
import type { ElementType } from "react";
export type RightPanelSurfaceActionId =
  | "browser"
  | "files"
  | "source-control"
  | "agents"
  | "pull-request"
  | "pull-requests"
  | "device";
export interface RightPanelSurfaceAction {
  readonly id: RightPanelSurfaceActionId;
  readonly label: string;
  readonly shortcut: string;
  readonly Icon: ElementType<{ className?: string }>;
  readonly available: boolean;
  readonly disabledReason: string;
  readonly onClick: () => void;
  readonly badgeCount: number;
  readonly profiles?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}
export function buildRightPanelSurfaceActions(input: {
  readonly browserProfiles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly sourceControlProviderName: string | null;
  readonly sourceControlIcon?: ElementType<{ className?: string }> | undefined;
  readonly availability: Record<RightPanelSurfaceActionId, boolean>;
  readonly onAddBrowser: () => void;
  readonly onAddBrowserInProfile: (id: string) => void;
  readonly onAddFiles: () => void;
  readonly onAddSourceControl: () => void;
  readonly onAddAgents: () => void;
  readonly onAddPullRequest: () => void;
  readonly onAddPullRequests: () => void;
  readonly onAddDevice: () => void;
  readonly liveAgentCount: number;
}): ReadonlyArray<RightPanelSurfaceAction> {
  return [
    {
      id: "browser",
      label: "Browser",
      shortcut: "B",
      Icon: Globe2,
      available: input.availability.browser,
      disabledReason: "Browser previews are only available in the T3 Code desktop app.",
      onClick: input.onAddBrowser,
      badgeCount: 0,
      profiles: input.browserProfiles,
    },
    {
      id: "files",
      label: "Files",
      shortcut: "F",
      Icon: Files,
      available: input.availability.files,
      disabledReason: "Files are only available when a project is open.",
      onClick: input.onAddFiles,
      badgeCount: 0,
    },
    {
      id: "source-control",
      label: input.sourceControlProviderName || "Source Control",
      shortcut: "G",
      Icon: input.sourceControlIcon ?? GitBranch,
      available: input.availability["source-control"],
      disabledReason: "Source Control is only available when a project is open.",
      onClick: input.onAddSourceControl,
      badgeCount: 0,
    },
    {
      id: "agents",
      label: "Agents",
      shortcut: "A",
      Icon: Bot,
      available: input.availability.agents,
      disabledReason: "Agents are only available from a thread.",
      onClick: input.onAddAgents,
      badgeCount: input.liveAgentCount,
    },
    {
      id: "pull-request",
      label: "Pull Request",
      shortcut: "P",
      Icon: GitPullRequest,
      available: input.availability["pull-request"],
      disabledReason: "This thread's branch has no pull request yet.",
      onClick: input.onAddPullRequest,
      badgeCount: 0,
    },
    {
      id: "pull-requests",
      label: "Linked Pull Requests",
      shortcut: "L",
      Icon: GitPullRequestArrow,
      available: input.availability["pull-requests"],
      disabledReason: "No linked pull requests are available for this thread.",
      onClick: input.onAddPullRequests,
      badgeCount: 0,
    },
    {
      id: "device",
      label: "Device",
      shortcut: "M",
      Icon: Smartphone,
      available: input.availability.device,
      disabledReason: "Devices are only available from a thread.",
      onClick: input.onAddDevice,
      badgeCount: 0,
    },
  ];
}
