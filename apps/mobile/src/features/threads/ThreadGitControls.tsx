import * as Dialog from "../../components/ui/Dialog";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import type { AppBarMenu, AppBarMenuItem } from "../../components/ui/AppBar.types";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  type GitRunStackedActionResult,
  type ProjectScript,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  buildMenuItems,
  getGitActionDisabledReason,
  type GitActionRequestInput,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import { StackActions, useNavigation } from "@react-navigation/native";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { useEnvironmentScope } from "../../state/session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useLinkedPullRequestActions } from "./useLinkedPullRequestActions";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import {
  basename,
  getTerminalStatusLabel,
  projectScriptMenuIcon,
  type TerminalMenuSession,
} from "../terminal/terminalMenu";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const headLength = Math.ceil((maxLength - 1) / 2);
  const tailLength = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, headLength)}…${value.slice(value.length - tailLength)}`;
}

function compactMenuBranchLabel(branch: string): string {
  return truncateMiddle(branch, 24);
}

function compactMenuStatus(gitStatus: VcsStatusResult | null): string {
  if (!gitStatus) {
    return "Checking status";
  }
  if (!gitStatus.isRepo) {
    return "Not a repo";
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(`${gitStatus.workingTree.files.length} changed`);
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push("Clean");
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(`${gitStatus.aheadCount} ahead`);
  }
  if (gitStatus.behindCount > 0) {
    parts.push(`${gitStatus.behindCount} behind`);
  }
  if (gitStatus.pr?.state === "open") {
    const { shortLabel } = sourceControlClients.get(
      gitStatus.sourceControlProvider?.kind,
    ).changeRequest;
    parts.push(`${shortLabel} #${gitStatus.pr.number}`);
  }

  return parts.join(" · ");
}

type QuickActionIcon =
  | "arrow.down.circle"
  | "arrow.up.right.circle"
  | "checkmark.circle"
  | "arrow.up.circle";

export type ThreadGitMenuProps = {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly currentBranch: string | null;
  readonly hasThread?: boolean;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
  readonly onOpenFilesInspector?: () => void;
  readonly onOpenGitInspector?: () => void;
  readonly onMergeBack?: () => void;
  readonly onPull: () => Promise<void>;
  readonly onRunAction: (input: GitActionRequestInput) => Promise<GitRunStackedActionResult | null>;
  /** Opened from a sheet: destinations replace it instead of stacking on top. */
  readonly replaceOnNavigate?: boolean;
};

type RootParams = ReactNavigation.RootParamList;

function useGitNavigate(replace: boolean | undefined) {
  const navigation = useNavigation();
  return <Name extends "GitConfirm" | "GitCommit" | "GitBranches" | "GitOverview" | "ThreadReview">(
    name: Name,
    params: RootParams[Name],
  ) => {
    if (replace) navigation.dispatch(StackActions.replace(name, params));
    else (navigation.navigate as (name: Name, params: RootParams[Name]) => void)(name, params);
  };
}

export type ThreadGitControlsProps = ThreadGitMenuProps & {
  readonly canOpenTerminal: boolean;
  readonly canOperateTerminal: boolean;
  readonly canOpenFiles: boolean;
  readonly projectScripts: ReadonlyArray<ProjectScript>;
  readonly terminalSessions: ReadonlyArray<TerminalMenuSession>;
  readonly onOpenTerminal: (terminalId?: string | null) => void;
  readonly onOpenNewTerminal: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => Promise<void>;
};

function useThreadGitControlModel(props: ThreadGitMenuProps) {
  const navigate = useGitNavigate(props.replaceOnNavigate);
  const openPullRequest = useOpenPullRequest();
  const environmentId = props.environmentId;
  const canWriteSourceControl = useEnvironmentScope(
    environmentId ? EnvironmentId.make(String(environmentId)) : null,
    AuthSourceControlWriteScope,
  );
  const threadId = props.threadId;
  const { gitStatus, gitOperationLabel, onPull, onRunAction } = props;

  const currentBranchLabel = gitStatus?.refName ?? props.currentBranch ?? "Detached HEAD";
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

  const quickAction = (() => {
    if (!isRepo) {
      return {
        label: "Git unavailable",
        disabled: true,
        kind: "show_hint" as const,
        hint: "This workspace is not a git repository.",
      };
    }
    const action = resolveQuickAction(gitStatus, busy, isDefaultRef, hasPrimaryRemote);
    return !canWriteSourceControl && (action.kind === "run_pull" || action.kind === "run_action")
      ? {
          ...action,
          disabled: true,
          hint: "This connection cannot change source control.",
        }
      : action;
  })();

  const quickActionHint = quickAction.disabled
    ? (quickAction.hint ?? "This action is unavailable.")
    : null;

  const quickActionIcon: QuickActionIcon = (() => {
    if (quickAction.kind === "run_pull") return "arrow.down.circle";
    if (quickAction.kind === "open_pr") return "arrow.up.right.circle";
    if (quickAction.kind === "run_action") {
      if (quickAction.action === "commit") return "checkmark.circle";
      if (quickAction.action === "push" || quickAction.action === "commit_push")
        return "arrow.up.circle";
    }
    return "arrow.up.right.circle";
  })();

  const openExistingPr = async () => {
    const { shortLabel, singular } = sourceControlClients.get(
      gitStatus?.sourceControlProvider?.kind,
    ).changeRequest;
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Dialog.alert(`No open ${shortLabel}`, `This branch does not have an open ${singular}.`);
      return;
    }
    if (!(await openPullRequest(prUrl))) {
      Dialog.alert(`Unable to open ${shortLabel}`, `The ${singular} could not be opened.`);
    }
  };

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      if (props.hasThread === false) {
        Dialog.alert(
          "Choose a feature branch",
          "Switch branches before publishing changes from this draft.",
        );
        return;
      }
      navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        confirmAction: confirmableAction,
        branchName,
        includesCommit: String(input.action === "commit_push" || input.action === "commit_push_pr"),
      });
      return;
    }

    await onRunAction(input);
  };

  const runQuickAction = async () => {
    if (quickAction.disabled) return;
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (quickAction.kind === "run_pull") {
      await onPull();
      return;
    }
    if (quickAction.kind === "run_action" && quickAction.action) {
      await runActionWithPrompt({ action: quickAction.action });
    }
  };

  const openReview = () => {
    navigate("ThreadReview", {
      environmentId: EnvironmentId.make(String(environmentId)),
      threadId: ThreadId.make(String(threadId)),
    });
  };

  const openGitInspector = () => {
    if (props.onOpenGitInspector) {
      props.onOpenGitInspector();
      return;
    }
    navigate("GitOverview", {
      environmentId: String(environmentId),
      threadId: String(threadId),
    });
  };

  return {
    busy,
    canWriteSourceControl,
    hasPrimaryRemote,
    openExistingPr,
    runActionWithPrompt,
    currentBranchLabel,
    isRepo,
    openGitInspector,
    openReview,
    quickAction,
    quickActionHint,
    quickActionIcon,
    runQuickAction,
  };
}

export function threadTerminalMenu(props: ThreadGitControlsProps): AppBarMenu | null {
  if (!props.canOpenTerminal) return null;
  return {
    title: "Terminal",
    icon: "terminal",
    separateBackground: false,
    items: [
      ...(props.projectScripts.length > 0
        ? props.projectScripts.map((script) => ({
            id: `script-${script.id}`,
            title: projectScriptMenuLabel(script),
            icon: projectScriptMenuIcon(script.icon),
            subtitle: script.command,
            disabled: !props.canOperateTerminal,
            onPress: () => void props.onRunProjectScript(script),
          }))
        : [
            {
              id: "script-none",
              title: "No project scripts",
              icon: "play",
              subtitle: "This project has no saved scripts yet",
              disabled: true,
              onPress: () => {},
            },
          ]),
      ...props.terminalSessions.map((session) => ({
        id: `terminal-${session.terminalId}`,
        title: session.displayLabel,
        icon: "terminal",
        subtitle: [
          getTerminalStatusLabel({
            status: session.status,
            hasRunningSubprocess: session.hasRunningSubprocess,
          }),
          basename(session.cwd),
        ]
          .filter(Boolean)
          .join(" · "),
        onPress: () => props.onOpenTerminal(session.terminalId),
      })),
      {
        id: "terminal-new",
        title: "Open new terminal",
        icon: "plus",
        subtitle: "Start another shell for this thread",
        disabled: !props.canOperateTerminal,
        onPress: props.onOpenNewTerminal,
      },
    ],
  };
}

/** The thread's git menu, shared by the thread bar and Review. */
export function useThreadGitMenuDefinition(props: ThreadGitMenuProps): AppBarMenu | null {
  const model = useThreadGitControlModel(props);
  return {
    title: "Git controls",
    icon: "point.topleft.down.curvedto.point.bottomright.up",
    separateBackground: false,
    items: [
      {
        id: "git-status",
        title: compactMenuBranchLabel(model.currentBranchLabel),
        icon: "point.topleft.down.curvedto.point.bottomright.up",
        disabled: true,
        subtitle: compactMenuStatus(props.gitStatus),
        onPress: () => {},
      },
      {
        id: "git-quick-action",
        title: model.quickAction.label,
        icon: model.quickActionIcon,
        disabled: model.quickAction.disabled,
        subtitle: model.quickActionHint ?? undefined,
        onPress: () => {
          void model.runQuickAction();
        },
      },
      {
        id: "git-review",
        title: "Review changes",
        icon: "text.bubble",
        disabled: !model.isRepo || props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? "Available after the first message"
            : "Turn diffs and worktree changes",
        onPress: model.openReview,
      },
      ...(props.onMergeBack
        ? [
            {
              id: "git-merge-back",
              title: "Merge back to source",
              icon: PullRequestGlyph.merged,
              subtitle: "Bring this thread's latest turn into its source",
              onPress: props.onMergeBack,
            },
          ]
        : []),
      {
        id: "git-more",
        title: "More",
        icon: "ellipsis",
        disabled: props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? "Available after the first message"
            : "Commit, files, branches",
        onPress: model.openGitInspector,
      },
    ],
  };
}

const REQUIRES_THREAD = "Available after the first message";
// Same symbols as the git overview sheet's rows.
const GIT_ACTION_ICONS = {
  commit: "checkmark.circle",
  push: "arrow.up.circle",
  pr: "arrow.up.right.circle",
} as const;
const NO_WRITE_ACCESS = "This connection cannot change source control.";

/** The git overview's actions as flat rows, for the phone tools panel. */
export function useThreadGitPanelItems(props: ThreadGitMenuProps): ReadonlyArray<AppBarMenuItem> {
  const navigate = useGitNavigate(props.replaceOnNavigate);
  const model = useThreadGitControlModel(props);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const status = props.gitStatus;
  const hasThread = props.hasThread !== false;
  const routeParams = {
    environmentId: String(props.environmentId),
    threadId: String(props.threadId),
  };
  const { shortLabel } = sourceControlClients.get(
    status?.sourceControlProvider?.kind,
  ).changeRequest;

  const actionItems = (
    model.isRepo ? buildMenuItems(status, model.busy, model.hasPrimaryRemote) : []
  ).map((item): AppBarMenuItem => {
    const blocked = !model.canWriteSourceControl && item.kind !== "open_pr";
    const reason = blocked
      ? NO_WRITE_ACCESS
      : getGitActionDisabledReason({
          item,
          gitStatus: status,
          isBusy: model.busy,
          hasOriginRemote: model.hasPrimaryRemote,
        });
    const detail =
      item.dialogAction === "commit" && status?.hasWorkingTreeChanges
        ? `${status.workingTree.files.length} file${status.workingTree.files.length === 1 ? "" : "s"} changed`
        : item.dialogAction === "push" && (status?.aheadCount ?? 0) > 0
          ? `${status?.aheadCount} commit${status?.aheadCount === 1 ? "" : "s"} ahead`
          : item.kind === "open_pr" && status?.pr?.number != null
            ? `${shortLabel} #${status.pr.number} ${status.pr.state ?? "open"}`
            : undefined;
    return {
      id: `git-action-${item.id}`,
      title: item.label,
      icon: GIT_ACTION_ICONS[item.icon],
      subtitle: reason ?? detail,
      disabled: item.disabled || blocked || !hasThread,
      onPress: () => {
        if (item.kind === "open_pr") void model.openExistingPr();
        else if (item.dialogAction === "commit") navigate("GitCommit", routeParams);
        else if (item.dialogAction === "push") void model.runActionWithPrompt({ action: "push" });
        else if (item.dialogAction === "create_pr")
          void model.runActionWithPrompt({ action: "create_pr" });
      },
    };
  });
  const behind = status?.behindCount ?? 0;
  return [
    {
      id: "git-status",
      title: compactMenuBranchLabel(model.currentBranchLabel),
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      disabled: true,
      subtitle: compactMenuStatus(status),
      onPress: () => {},
    },
    ...actionItems,
    ...(behind > 0
      ? [
          {
            id: "git-pull",
            title: "Pull latest",
            icon: "arrow.down.circle",
            subtitle: model.canWriteSourceControl
              ? `${behind} commit${behind === 1 ? "" : "s"} behind upstream`
              : NO_WRITE_ACCESS,
            disabled: !model.canWriteSourceControl || model.busy || !model.isRepo,
            onPress: () => void props.onPull(),
          },
        ]
      : []),
    {
      id: "git-review",
      title: "Review changes",
      icon: "text.bubble",
      disabled: !model.isRepo || !hasThread,
      subtitle: hasThread ? "Turn diffs and worktree changes" : REQUIRES_THREAD,
      onPress: model.openReview,
    },
    {
      id: "git-branches",
      title: "Branches & worktrees",
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      disabled: model.busy || !model.isRepo || !hasThread,
      subtitle: hasThread ? "Switch branch, create branch, or move to a worktree" : REQUIRES_THREAD,
      onPress: () => navigate("GitBranches", routeParams),
    },
    ...(props.onMergeBack
      ? [
          {
            id: "git-merge-back",
            title: "Merge back to source",
            icon: PullRequestGlyph.merged,
            subtitle: "Bring this thread's latest turn into its source",
            onPress: props.onMergeBack,
          },
        ]
      : []),
    ...(linkedPrActions.canLink
      ? [
          {
            id: "git-link-pr",
            title: `Link ${linkedPrActions.terminology.singular}`,
            icon: "link",
            subtitle: `Attach a ${linkedPrActions.terminology.singular} by URL or number`,
            onPress: linkedPrActions.promptLink,
          },
        ]
      : []),
  ];
}
