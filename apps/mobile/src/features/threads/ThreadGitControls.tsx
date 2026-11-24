import { msg, useGT, useMessages } from "gt-react-native";

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
import { changeRequestTermKind } from "../../lib/changeRequestTerm";

import { m, type MessageResolver } from "../../i18n/messages";
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
import { projectScriptMenuLabel } from "@t3tools/shared/projectScriptsCopy";
import { compactMenuBranchLabel } from "./ThreadGitControls.logic";

function compactMenuStatus(gitStatus: VcsStatusResult | null, resolve: MessageResolver): string {
  if (!gitStatus) {
    return resolve(msg("Checking status"));
  }
  if (!gitStatus.isRepo) {
    return resolve(msg("Not a repo"));
  }

  const parts: string[] = [];
  if (gitStatus.hasWorkingTreeChanges) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} changed} other {{count} changed}}", {
          count: gitStatus.workingTree.files.length,
        }),
      ),
    );
  } else if (gitStatus.aheadCount === 0 && gitStatus.behindCount === 0) {
    parts.push(resolve(msg("Clean", { $context: "git working tree has no changes" })));
  }
  if (gitStatus.aheadCount > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} ahead} other {{count} ahead}}", {
          count: gitStatus.aheadCount,
        }),
      ),
    );
  }
  if (gitStatus.behindCount > 0) {
    parts.push(
      resolve(
        msg("{count, plural, one {{count} behind} other {{count} behind}}", {
          count: gitStatus.behindCount,
        }),
      ),
    );
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
  /** The project tracks repositories besides its folder, which then need not be one itself. */
  readonly tracksRepositories?: boolean;
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
  const gt = useGT();
  const messages = useMessages();
  const openPullRequest = useOpenPullRequest();
  const environmentId = props.environmentId;
  const canWriteSourceControl = useEnvironmentScope(
    environmentId ? EnvironmentId.make(String(environmentId)) : null,
    AuthSourceControlWriteScope,
  );
  const threadId = props.threadId;
  const { gitStatus, gitOperationLabel, onPull, onRunAction } = props;

  const currentBranchLabel = gitStatus?.refName ?? props.currentBranch ?? gt("Detached HEAD");
  const busy = gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;

  const quickAction = (() => {
    if (!isRepo) {
      return {
        label: gt("Git unavailable"),
        disabled: true,
        kind: "show_hint" as const,
        hint: gt("This workspace is not a git repository."),
      };
    }
    const action = resolveQuickAction(gitStatus, busy, isDefaultRef, hasPrimaryRemote, messages);
    return !canWriteSourceControl && (action.kind === "run_pull" || action.kind === "run_action")
      ? {
          ...action,
          disabled: true,
          hint: gt("This connection cannot change source control."),
        }
      : action;
  })();

  const quickActionHint = quickAction.disabled
    ? (quickAction.hint ?? gt("This action is unavailable."))
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
    const term = changeRequestTermKind(
      sourceControlClients.get(gitStatus?.sourceControlProvider?.kind).changeRequest,
    );
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Dialog.alert(
        gt("{term, select, mr {No open MR} cr {No open change request} other {No open PR}}", {
          term,
        }),
        gt(
          "{term, select, mr {This branch does not have an open merge request.} cr {This branch does not have an open change request.} other {This branch does not have an open pull request.}}",
          { term },
        ),
      );
      return;
    }
    if (!(await openPullRequest(prUrl))) {
      Dialog.alert(
        gt(
          "{term, select, mr {Unable to open MR} cr {Unable to open change request} other {Unable to open PR}}",
          { term },
        ),
        gt(
          "{term, select, mr {The merge request could not be opened.} cr {The change request could not be opened.} other {The pull request could not be opened.}}",
          { term },
        ),
      );
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
          gt("Choose a feature branch"),
          gt("Switch branches before publishing changes from this draft."),
        );
        return;
      }
      navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        confirmAction: confirmableAction,
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

export function threadTerminalMenu(
  props: ThreadGitControlsProps,
  resolve: MessageResolver = m,
): AppBarMenu | null {
  if (!props.canOpenTerminal) return null;
  return {
    title: resolve(msg("Terminal")),
    icon: "terminal",
    separateBackground: false,
    items: [
      ...(props.projectScripts.length > 0
        ? props.projectScripts.map((script) => ({
            id: `script-${script.id}`,
            title: projectScriptMenuLabel(script, resolve),
            icon: projectScriptMenuIcon(script.icon),
            subtitle: script.command,
            disabled: !props.canOperateTerminal,
            onPress: () => void props.onRunProjectScript(script),
          }))
        : [
            {
              id: "script-none",
              title: resolve(msg("No project scripts")),
              icon: "play",
              subtitle: resolve(msg("This project has no saved scripts yet")),
              disabled: true,
              onPress: () => {},
            },
          ]),
      ...props.terminalSessions.map((session) => ({
        id: `terminal-${session.terminalId}`,
        title: session.displayLabel,
        icon: "terminal",
        subtitle: [
          getTerminalStatusLabel(
            {
              status: session.status,
              hasRunningSubprocess: session.hasRunningSubprocess,
            },
            resolve,
          ),
          basename(session.cwd),
        ]
          .filter(Boolean)
          .join(" · "),
        onPress: () => props.onOpenTerminal(session.terminalId),
      })),
      {
        id: "terminal-new",
        title: resolve(msg("Open new terminal")),
        icon: "plus",
        subtitle: resolve(msg("Start another shell for this thread")),
        disabled: !props.canOperateTerminal,
        onPress: props.onOpenNewTerminal,
      },
    ],
  };
}

/** The thread's git menu, shared by the thread bar and Review. */
export function useThreadGitMenuDefinition(props: ThreadGitMenuProps): AppBarMenu | null {
  const model = useThreadGitControlModel(props);
  const gt = useGT();
  const messages = useMessages();
  // A plain folder that tracks repositories has no branch of its own; its turns still have diffs.
  const repositoriesOnly = !model.isRepo && props.tracksRepositories === true;
  return {
    title: gt("Git controls"),
    icon: "point.topleft.down.curvedto.point.bottomright.up",
    separateBackground: false,
    items: [
      ...(repositoriesOnly
        ? // A worktree thread of such a folder still has a branch: its repositories are on it.
          props.currentBranch === null
          ? []
          : [
              {
                id: "git-status",
                title: compactMenuBranchLabel(props.currentBranch),
                icon: "point.topleft.down.curvedto.point.bottomright.up",
                disabled: true,
                subtitle: gt("Repository worktrees"),
                onPress: () => {},
              },
            ]
        : [
            {
              id: "git-status",
              title: compactMenuBranchLabel(model.currentBranchLabel),
              icon: "point.topleft.down.curvedto.point.bottomright.up",
              disabled: true,
              subtitle: compactMenuStatus(props.gitStatus, messages),
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
          ]),
      {
        id: "git-review",
        title: gt("Review changes"),
        icon: "text.bubble",
        disabled: !(model.isRepo || repositoriesOnly) || props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? gt("Available after the first message")
            : repositoriesOnly
              ? gt("Turn diffs")
              : gt("Turn diffs and worktree changes"),
        onPress: model.openReview,
      },
      ...(props.onMergeBack
        ? [
            {
              id: "git-merge-back",
              title: gt("Merge back to source"),
              icon: PullRequestGlyph.merged,
              subtitle: gt("Bring this thread's latest turn into its source"),
              onPress: props.onMergeBack,
            },
          ]
        : []),
      {
        id: "git-more",
        title: gt("More", { $context: "menu item that opens more git actions" }),
        icon: "ellipsis",
        disabled: props.hasThread === false,
        subtitle:
          props.hasThread === false
            ? gt("Available after the first message")
            : repositoriesOnly
              ? gt("Repositories")
              : props.tracksRepositories === true
                ? gt("Commit, branches, repositories")
                : gt("Commit, files, branches"),
        onPress: model.openGitInspector,
      },
    ],
  };
}

// Same symbols as the git overview sheet's rows.
const GIT_ACTION_ICONS = {
  commit: "checkmark.circle",
  push: "arrow.up.circle",
  pr: "arrow.up.right.circle",
} as const;

/** The git overview's actions as flat rows, for the phone tools panel. */
export function useThreadGitPanelItems(props: ThreadGitMenuProps): ReadonlyArray<AppBarMenuItem> {
  const navigate = useGitNavigate(props.replaceOnNavigate);
  const model = useThreadGitControlModel(props);
  const gt = useGT();
  const messages = useMessages();
  const requiresThread = gt("Available after the first message");
  const noWriteAccess = gt("This connection cannot change source control.");
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const status = props.gitStatus;
  const hasThread = props.hasThread !== false;
  const repositoriesOnly = !model.isRepo && props.tracksRepositories === true;
  const routeParams = {
    environmentId: String(props.environmentId),
    threadId: String(props.threadId),
  };
  const term = changeRequestTermKind(
    sourceControlClients.get(status?.sourceControlProvider?.kind).changeRequest,
  );

  const actionItems = (
    model.isRepo ? buildMenuItems(status, model.busy, model.hasPrimaryRemote, messages) : []
  ).map((item): AppBarMenuItem => {
    const blocked = !model.canWriteSourceControl && item.kind !== "open_pr";
    const reason = blocked
      ? noWriteAccess
      : getGitActionDisabledReason(
          {
            item,
            gitStatus: status,
            isBusy: model.busy,
            hasOriginRemote: model.hasPrimaryRemote,
          },
          messages,
        );
    const detail =
      item.dialogAction === "commit" && status?.hasWorkingTreeChanges
        ? gt("{count, plural, one {{count} file changed} other {{count} files changed}}", {
            count: status.workingTree.files.length,
          })
        : item.dialogAction === "push" && (status?.aheadCount ?? 0) > 0
          ? gt("{count, plural, one {{count} commit ahead} other {{count} commits ahead}}", {
              count: status?.aheadCount ?? 0,
            })
          : item.kind === "open_pr" && status?.pr?.number != null
            ? gt(
                "{term, select, mr {MR} cr {Change request} other {PR}} #{number} {state, select, closed {closed} merged {merged} other {open}}",
                { term, number: status.pr.number, state: status.pr.state ?? "open" },
              )
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
      subtitle: compactMenuStatus(status, messages),
      onPress: () => {},
    },
    ...actionItems,
    ...(behind > 0
      ? [
          {
            id: "git-pull",
            title: gt("Pull latest"),
            icon: "arrow.down.circle",
            subtitle: model.canWriteSourceControl
              ? gt(
                  "{count, plural, one {{count} commit behind upstream} other {{count} commits behind upstream}}",
                  { count: behind },
                )
              : noWriteAccess,
            disabled: !model.canWriteSourceControl || model.busy || !model.isRepo,
            onPress: () => void props.onPull(),
          },
        ]
      : []),
    {
      id: "git-review",
      title: gt("Review changes"),
      icon: "text.bubble",
      disabled: !(model.isRepo || repositoriesOnly) || !hasThread,
      subtitle: !hasThread
        ? requiresThread
        : repositoriesOnly
          ? gt("Turn diffs")
          : gt("Turn diffs and worktree changes"),
      onPress: model.openReview,
    },
    {
      id: "git-branches",
      title: gt("Branches & worktrees"),
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      disabled: model.busy || !model.isRepo || !hasThread,
      subtitle: hasThread
        ? gt("Switch branch, create branch, or move to a worktree")
        : requiresThread,
      onPress: () => navigate("GitBranches", routeParams),
    },
    ...(props.onMergeBack
      ? [
          {
            id: "git-merge-back",
            title: gt("Merge back to source"),
            icon: PullRequestGlyph.merged,
            subtitle: gt("Bring this thread's latest turn into its source"),
            onPress: props.onMergeBack,
          },
        ]
      : []),
    ...(linkedPrActions.canLink
      ? [
          {
            id: "git-link-pr",
            title: gt(
              "{term, select, mr {Link merge request} cr {Link change request} other {Link pull request}}",
              { term: changeRequestTermKind(linkedPrActions.terminology) },
            ),
            icon: "link",
            subtitle: gt(
              "{term, select, mr {Attach a merge request by URL or number} cr {Attach a change request by URL or number} other {Attach a pull request by URL or number}}",
              { term: changeRequestTermKind(linkedPrActions.terminology) },
            ),
            onPress: linkedPrActions.promptLink,
          },
        ]
      : []),
  ];
}
