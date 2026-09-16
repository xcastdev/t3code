import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type PullRequestAction,
  type PullRequestRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  GitActionContinuation,
  GitActionOperation,
  GitRepositoryCapabilities,
  GitActionProgressEvent,
  GitActionRequest,
  GitMutationPrecondition,
  GitRunStackedActionResult,
  GitStackedAction,
  VcsStatusResult,
  VcsWorkingTreeFile,
} from "@t3tools/contracts";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDownIcon,
  CloudDownloadIcon,
  CloudUploadIcon,
  GitBranchPlusIcon,
  GitCommitIcon,
  InfoIcon,
} from "lucide-react";
import {
  buildGitCommitFilePaths,
  workingTreeSnapshotScope,
  buildGitActionProgressStages,
  buildWorkflowMenuItems,
  type GitWorkflowMenuId,
  type GitCommitFileSelection,
  type GitQuickAction,
  type DefaultBranchConfirmableAction,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveThreadBranchMetadataPatch,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  workflowInputFields,
  workflowRequiredFields,
  destructiveWorkflowCopy,
  workflowApprovalDescription,
  isWorkflowViewChecked,
  reviewedGitSnapshotAvailability,
  workflowActionRequiresReviewedSnapshot,
} from "./sourceControlActions.logic";
import { sourceControlConfirmationDescription } from "./sourceControlPanel.logic";
import { StartTruncatedPath } from "../StartTruncatedPath";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Group, GroupSeparator } from "~/components/ui/group";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager, type ThreadToastData } from "~/components/ui/toast";
import { useOpenInPreferredEditor } from "~/editorPreferences";
import {
  useGitStackedAction,
  usePreparePullRequestThreadAction,
  useSourceControlActionRunning,
} from "~/lib/sourceControlActions";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { sourceControlEnvironment, sourceControlWorkspaceEnvironment } from "~/state/sourceControl";
import { sourceControlWorkspaceProgressAtom } from "@t3tools/client-runtime/state/sourceControlWorkspace";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { randomUUID } from "~/lib/utils";
import { resolvePathLinkTarget } from "~/terminal-links";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useOpenLink } from "~/browser/useOpenLink";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { PublishRepositoryDialog } from "./PublishRepositoryDialog";

interface SourceControlActionsProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  /** The conditional Source Control surface owns the visual placement, not this stateful host. */
  target: HTMLElement | null;
  draftId?: DraftId;
  /**
   * Opens the thread's own change request beside it. Absent when the thread has no project to
   * place it against, in which case it still opens in the browser.
   */
  onOpenPullRequest?: ((number: number) => void) | undefined;
}

/** Immutable local source identity reviewed before a mutation can continue. */
interface RepositorySourceScope {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceRef: string | null;
  readonly sourceHead: string | null;
  /** The index is part of the reviewed repository revision, not just commit UI state. */
  readonly sourceIndexTree: string;
}

/** A publication action also binds the remote destination it will mutate. */
interface GitActionApprovalScope extends RepositorySourceScope {
  readonly targetRemoteName: string | null;
  readonly targetRefName: string | null;
}

/** Header approvals also bind ordinary pull and publication destinations. */
interface HeaderActionScope extends RepositorySourceScope {
  readonly remoteName: string | null;
  readonly remoteRefName: string | null;
  readonly pullRemoteName: string | null;
  readonly pullRefName: string | null;
}

interface PendingDefaultBranchAction extends GitActionApprovalScope {
  action: DefaultBranchConfirmableAction;
  includesCommit: boolean;
  commitMessage?: string;
  onConfirmed?: () => void;
  filePaths?: string[];
}

/** Publication is reviewed against one local checkout, never the next selected repository. */
interface PublishRepositoryScope extends RepositorySourceScope {
  readonly threadRef: ScopedThreadRef | null;
}

interface PendingGitConfirmation {
  readonly input: RunGitActionWithToastInput;
  readonly scope: GitActionApprovalScope;
}

type GitActionToastId = ReturnType<typeof toastManager.add>;

interface ActiveGitActionProgress {
  toastId: GitActionToastId;
  toastData: ThreadToastData | undefined;
  actionId: string;
  title: string;
  phaseStartedAtMs: number | null;
  hookStartedAtMs: number | null;
  hookName: string | null;
  lastOutputLine: string | null;
  currentPhaseLabel: string | null;
}

type WorkflowInputAction = GitActionOperation | "checkout";
type PullRequestMenuAction = "checkout" | "merge" | "close";

/**
 * A provider-side pull request action can still change the checked-out repository
 * (checkout) or the remote request (merge/close). Keep the complete local
 * revision and provider target it was reviewed against, rather than merely the
 * PR URL needed to render its dialog.
 */
type PullRequestMutationApprovalScope = {
  readonly reviewedSourceScope: RepositorySourceScope;
  readonly reference: PullRequestRef;
  readonly url: string;
  readonly pullRequest: NonNullable<VcsStatusResult["pr"]>;
};

/** A confirmation is bound to the reviewed repository snapshot and PR target. */
type PendingPullRequestAction = PullRequestMutationApprovalScope & {
  readonly action: PullRequestMenuAction;
  readonly repositoryLabel: string;
};

type WorkflowInputState = {
  /** The exact repository/source reviewed when this form was opened. */
  readonly reviewedSourceScope: RepositorySourceScope;
  readonly reviewedPrecondition?: GitMutationPrecondition;
  /** Defaults the selected leaf would otherwise read live from status. */
  readonly reviewedRemoteName: string | null;
  readonly reviewedRemoteRefName: string | null;
  readonly reviewedPullRemoteName: string | null;
  readonly reviewedPullRefName: string | null;
  id: GitWorkflowMenuId;
  action: WorkflowInputAction;
  operation: string;
  refName: string;
  sourceRef: string;
  targetRef: string;
  oldRefName: string;
  newRefName: string;
  remoteName: string;
  message: string;
  paths: string;
  strategy: "merge" | "rebase" | "ff-only" | "hard";
};

type SourceControlPresentationChoice = "view-tree" | "view-list";
type SourceControlSortChoice = "view-sort-path" | "view-sort-name" | "view-sort-status";

type WorktreeInputState = {
  readonly reviewedSourceScope: RepositorySourceScope;
  readonly refName: string;
  readonly newRefName: string;
  readonly baseRefName: string;
  readonly path: string;
};

interface RunGitActionWithToastInput {
  action: GitStackedAction;
  commitMessage?: string;
  onConfirmed?: () => void;
  skipDefaultBranchPrompt?: boolean;
  statusOverride?: VcsStatusResult | null;
  featureBranch?: boolean;
  progressToastId?: GitActionToastId;
  filePaths?: string[];
  precondition?: GitMutationPrecondition;
  skipConfirmation?: boolean;
}

const GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS = 250;
const COMMIT_FILE_CHOOSER_WINDOW_SIZE = 100;
const HEADER_WORKFLOW_ACTIONS = new Set<GitWorkflowMenuId>([
  "fetch",
  "pull",
  "push",
  "sync",
  "publish",
  "view-tree",
  "view-list",
  "view-sort-path",
  "view-sort-name",
  "view-sort-status",
  "view-sort",
]);

type RefreshVcsStatus = (target: {
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly input: { readonly cwd: string };
}) => Promise<unknown>;

function requestVcsStatusRefresh(
  refresh: RefreshVcsStatus,
  environmentId: ScopedThreadRef["environmentId"] | null,
  cwd: string | null,
): void {
  if (environmentId === null || cwd === null) {
    return;
  }
  void refresh({ environmentId, input: { cwd } });
}
const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;
const COMMIT_DIALOG_TITLE = "Commit changes";
const COMMIT_DIALOG_DESCRIPTION =
  "Review and confirm your commit. Leave the message blank to auto-generate one.";

function repositorySourceScopeKey(scope: RepositorySourceScope): string {
  return [
    scope.environmentId,
    scope.cwd,
    scope.sourceRef ?? "",
    scope.sourceHead ?? "",
    scope.sourceIndexTree ?? "",
  ].join("\0");
}

/**
 * New clients always bind an approved workflow mutation to the repository
 * snapshot they displayed. The optional wire field remains additive for
 * clients that predate reviewed-state protection.
 */
function sourceScopePrecondition(scope: RepositorySourceScope): GitMutationPrecondition {
  return {
    expectedHeadCommit: scope.sourceHead,
    expectedIndexTree: scope.sourceIndexTree,
    expectedRefName: scope.sourceRef,
  };
}

function gitActionApprovalScopeKey(scope: GitActionApprovalScope): string {
  return [
    repositorySourceScopeKey(scope),
    scope.targetRemoteName ?? "",
    scope.targetRefName ?? "",
  ].join("\0");
}

function headerActionScopeKey(scope: HeaderActionScope): string {
  return [
    repositorySourceScopeKey(scope),
    scope.remoteName ?? "",
    scope.remoteRefName ?? "",
    scope.pullRemoteName ?? "",
    scope.pullRefName ?? "",
  ].join("\0");
}

function workflowApprovalScopeKey(
  input: Pick<
    WorkflowInputState,
    | "reviewedSourceScope"
    | "reviewedRemoteName"
    | "reviewedRemoteRefName"
    | "reviewedPullRemoteName"
    | "reviewedPullRefName"
  >,
): string {
  return [
    repositorySourceScopeKey(input.reviewedSourceScope),
    input.reviewedRemoteName ?? "",
    input.reviewedRemoteRefName ?? "",
    input.reviewedPullRemoteName ?? "",
    input.reviewedPullRefName ?? "",
  ].join("\0");
}

function sourceScopeFromStatus(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  status: VcsStatusResult | null | undefined,
): RepositorySourceScope | null {
  if (
    environmentId === null ||
    cwd === null ||
    !status ||
    status.refName === undefined ||
    status.headCommit === undefined ||
    status.indexTree === undefined
  ) {
    return null;
  }
  return {
    environmentId,
    cwd,
    sourceRef: status.refName,
    sourceHead: status.headCommit,
    sourceIndexTree: status.indexTree,
  };
}

function pullRequestMutationApprovalScopeFromStatus(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  status: VcsStatusResult | null | undefined,
  reference: PullRequestRef | null,
): PullRequestMutationApprovalScope | null {
  const reviewedSourceScope = sourceScopeFromStatus(environmentId, cwd, status);
  const pullRequest = status?.pr;
  // Provider mutations only apply to the open request that the user reviewed.
  // A closed/merged request must close an existing approval just as surely as
  // a different request number or URL does.
  if (
    reviewedSourceScope === null ||
    reference === null ||
    pullRequest === null ||
    pullRequest === undefined ||
    pullRequest.state !== "open"
  ) {
    return null;
  }
  return { reviewedSourceScope, reference, url: pullRequest.url, pullRequest };
}

function pullRequestMutationApprovalScopeKey(scope: PullRequestMutationApprovalScope): string {
  const { reference, pullRequest } = scope;
  return [
    repositorySourceScopeKey(scope.reviewedSourceScope),
    reference.projectId,
    reference.repositoryRoot ?? "",
    reference.host ?? "",
    reference.expectedAccountId ?? "",
    reference.repository,
    String(reference.number),
    scope.url,
    String(pullRequest.number),
    pullRequest.title,
    pullRequest.url,
    pullRequest.baseRef,
    pullRequest.headRef,
    pullRequest.state,
    pullRequest.isDraft === true ? "draft" : pullRequest.isDraft === false ? "ready" : "",
    pullRequest.updatedAt ?? "",
  ].join("\0");
}

function actionApprovalScopeFromStatus(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  status: VcsStatusResult | null | undefined,
): GitActionApprovalScope | null {
  if (!status) return null;
  const sourceScope = sourceScopeFromStatus(environmentId, cwd, status);
  if (sourceScope === null) return null;
  return {
    ...sourceScope,
    targetRemoteName: status.remoteName ?? null,
    targetRefName: status.remoteRefName ?? null,
  };
}

function headerActionScopeFromStatus(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  status: VcsStatusResult | null | undefined,
): HeaderActionScope | null {
  const sourceScope = sourceScopeFromStatus(environmentId, cwd, status);
  if (sourceScope === null || !status) return null;
  return {
    ...sourceScope,
    remoteName: status.remoteName ?? null,
    remoteRefName: status.remoteRefName ?? null,
    pullRemoteName: status.pullRemoteName ?? null,
    pullRefName: status.pullRefName ?? null,
  };
}

function formatElapsedDescription(startedAtMs: number | null): string | undefined {
  if (startedAtMs === null) {
    return undefined;
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `Running for ${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `Running for ${minutes}m ${seconds}s`;
}

function resolveProgressDescription(progress: ActiveGitActionProgress): string | undefined {
  if (progress.lastOutputLine) {
    return progress.lastOutputLine;
  }
  return formatElapsedDescription(progress.hookStartedAtMs ?? progress.phaseStartedAtMs);
}

function GitQuickActionIcon({
  quickAction,
  SourceControlIcon,
}: {
  quickAction: GitQuickAction;
  SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
}) {
  const iconClassName = "size-3.5";
  if (quickAction.kind === "open_pr") return <SourceControlIcon className={iconClassName} />;
  if (quickAction.kind === "open_publish") return <CloudUploadIcon className={iconClassName} />;
  if (quickAction.kind === "run_pull") return <CloudDownloadIcon className={iconClassName} />;
  if (quickAction.kind === "run_action") {
    if (quickAction.action === "commit") return <GitCommitIcon className={iconClassName} />;
    if (quickAction.action === "push" || quickAction.action === "commit_push") {
      return <CloudUploadIcon className={iconClassName} />;
    }
    return <SourceControlIcon className={iconClassName} />;
  }
  if (quickAction.label === "Commit") return <GitCommitIcon className={iconClassName} />;
  if (quickAction.label === "Push") return <CloudUploadIcon className={iconClassName} />;
  return <InfoIcon className={iconClassName} />;
}

export default function SourceControlActions({
  gitCwd,
  activeThreadRef,
  target,
  draftId,
  onOpenPullRequest,
}: SourceControlActionsProps) {
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "thread branch metadata update",
  );
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(activeEnvironmentId));
  const sourceControlWorkspaceSupported =
    serverConfig?.environment === undefined
      ? true
      : serverConfig.environment.capabilities.sourceControlWorkspace === true;
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeEnvironmentId,
    serverConfig?.availableEditors ?? [],
  );
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const openPrLink = useOpenPrLink(activeThreadRef ?? undefined);
  const openLink = useOpenLink(activeThreadRef);
  const activeDraftThread = useComposerDraftStore((store) =>
    draftId
      ? store.getDraftSession(draftId)
      : activeThreadRef
        ? store.getDraftThreadByRef(activeThreadRef)
        : null,
  );
  const activeServerThread = useThreadShell(activeThreadRef);
  const projects = useProjects();
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [selection, setSelection] = useState<GitCommitFileSelection>({ mode: "all" });
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [loadedWorkingTree, setLoadedWorkingTree] = useState<{
    readonly scope: string;
    readonly files: readonly VcsWorkingTreeFile[];
  } | null>(null);
  const [visibleFileCount, setVisibleFileCount] = useState(COMMIT_FILE_CHOOSER_WINDOW_SIZE);
  const [isPublishDialogOpen, setIsPublishDialogOpen] = useState(false);
  const [publishRepositoryScope, setPublishRepositoryScope] =
    useState<PublishRepositoryScope | null>(null);
  const [pendingDefaultBranchAction, setPendingDefaultBranchAction] =
    useState<PendingDefaultBranchAction | null>(null);
  const [workflowInput, setWorkflowInput] = useState<WorkflowInputState | null>(null);
  const [pendingPullRequestAction, setPendingPullRequestAction] =
    useState<PendingPullRequestAction | null>(null);
  const [sourceControlPresentationChoice, setSourceControlPresentationChoice] =
    useState<SourceControlPresentationChoice>("view-list");
  const [sourceControlSortChoice, setSourceControlSortChoice] =
    useState<SourceControlSortChoice>("view-sort-path");
  const [stashOutput, setStashOutput] = useState<string | null>(null);
  const [worktreeInput, setWorktreeInput] = useState<WorktreeInputState | null>(null);
  const [initConfirmationScope, setInitConfirmationScope] = useState<{
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
  } | null>(null);
  const [pendingHeaderAction, setPendingHeaderAction] = useState<{
    readonly action: "pull" | "push" | "sync" | "publish";
    readonly continuation?: GitActionContinuation;
    readonly scope: HeaderActionScope;
  } | null>(null);
  const [pendingGitConfirmation, setPendingGitConfirmation] =
    useState<PendingGitConfirmation | null>(null);
  const activeGitActionProgressRef = useRef<ActiveGitActionProgress | null>(null);
  const workingTreeLoadRequestId = useRef(0);
  const workingTreeScopeRef = useRef("");
  const sourceControlScope = useMemo(
    () => ({ environmentId: activeEnvironmentId, cwd: gitCwd }),
    [activeEnvironmentId, gitCwd],
  );
  const pendingScope = `${activeEnvironmentId ?? ""}\0${gitCwd ?? ""}`;
  useEffect(() => {
    setPendingHeaderAction(null);
    // A form is an approval/review of one immutable target. Never quietly
    // carry it into a newly selected nested repository.
    setWorkflowInput((current) =>
      current &&
      `${current.reviewedSourceScope.environmentId}\0${current.reviewedSourceScope.cwd}` !==
        pendingScope
        ? null
        : current,
    );
    setWorktreeInput((current) =>
      current &&
      `${current.reviewedSourceScope.environmentId}\0${current.reviewedSourceScope.cwd}` !==
        pendingScope
        ? null
        : current,
    );
    setInitConfirmationScope((current) =>
      current && `${current.environmentId}\0${current.cwd}` !== pendingScope ? null : current,
    );
    setPendingDefaultBranchAction((current) =>
      current && `${current.environmentId}\0${current.cwd}` !== pendingScope ? null : current,
    );
  }, [pendingScope]);
  let runGitActionWithToast: (input: RunGitActionWithToastInput) => Promise<void>;

  const updateActiveProgressToast = useCallback(() => {
    const progress = activeGitActionProgressRef.current;
    if (!progress) {
      return;
    }
    toastManager.update(progress.toastId, {
      type: "loading",
      title: progress.title,
      description: resolveProgressDescription(progress),
      timeout: 0,
      data: progress.toastData,
    });
  }, []);

  const persistThreadBranchSync = useCallback(
    (branch: string | null, manualSelection = false) => {
      if (!activeThreadRef) {
        return;
      }

      if (activeServerThread) {
        if (activeServerThread.branch === branch) {
          return;
        }

        void updateThreadMetadata({
          environmentId: activeThreadRef.environmentId,
          input: {
            threadId: activeThreadRef.threadId,
            ...resolveThreadBranchMetadataPatch(branch, activeServerThread.branch),
          },
        });

        return;
      }

      if (!activeDraftThread || activeDraftThread.branch === branch) {
        return;
      }

      setDraftThreadContext(draftId ?? activeThreadRef, {
        branch,
        worktreePath: activeDraftThread.worktreePath,
        environmentSelection: manualSelection
          ? "manual"
          : (activeDraftThread.environmentSelection ??
            (activeDraftThread.branch ? "manual" : "auto")),
      });
    },
    [
      activeDraftThread,
      activeServerThread,
      activeThreadRef,
      draftId,
      setDraftThreadContext,
      updateThreadMetadata,
    ],
  );

  const syncThreadBranchAfterGitAction = useCallback(
    (result: GitRunStackedActionResult) => {
      const branchUpdate = resolveThreadBranchUpdate(result);
      if (!branchUpdate) {
        return;
      }

      persistThreadBranchSync(branchUpdate.branch, true);
    },
    [persistThreadBranchSync],
  );

  const gitStatusQuery = useEnvironmentQuery(
    sourceControlWorkspaceSupported && activeEnvironmentId !== null && gitCwd !== null
      ? sourceControlWorkspaceEnvironment.status({
          environmentId: activeEnvironmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const sourceControlDiscoveryQuery = useEnvironmentQuery(
    activeEnvironmentId === null
      ? null
      : sourceControlEnvironment.discovery({ environmentId: activeEnvironmentId, input: {} }),
  );
  const refreshVcsStatus = useAtomCommand(sourceControlWorkspaceEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const discoverRepositories = useAtomCommand(
    sourceControlWorkspaceEnvironment.discoverRepositories,
    { reportFailure: false },
  );
  const runWorkflowAction = useAtomCommand(sourceControlWorkspaceEnvironment.runAction, {
    reportFailure: false,
  });
  const dismissWorkspaceProgress = useAtomCommand(
    sourceControlWorkspaceEnvironment.dismissProgress,
    {
      reportFailure: false,
    },
  );
  const runPullRequestAction = useAtomCommand(pullRequestEnvironment.runAction, {
    reportFailure: false,
  });
  const invalidatePullRequest = useAtomCommand(pullRequestEnvironment.invalidate, {
    reportFailure: false,
  });
  const createWorktree = useAtomCommand(sourceControlWorkspaceEnvironment.createWorktree, {
    reportFailure: false,
  });
  const initializeRepository = useAtomCommand(sourceControlWorkspaceEnvironment.init, {
    reportFailure: false,
  });
  const loadWorkingTreePage = useAtomCommand(sourceControlWorkspaceEnvironment.workingTreePage, {
    reportFailure: false,
  });
  const { data: gitStatus, error: gitStatusError, isPending: gitStatusPending } = gitStatusQuery;
  const workspaceProgress = useAtomValue(
    sourceControlWorkspaceProgressAtom({
      environmentId: activeEnvironmentId ?? ("source-control-unavailable" as EnvironmentId),
      repositoryRoot: gitCwd ?? "",
    }),
  );
  const [workflowCapabilities, setWorkflowCapabilities] = useState<
    GitRepositoryCapabilities | undefined
  >(undefined);
  useEffect(() => {
    let current = true;
    setWorkflowCapabilities(undefined);
    if (!sourceControlWorkspaceSupported || activeEnvironmentId === null || gitCwd === null) return;
    void discoverRepositories({
      environmentId: activeEnvironmentId,
      input: { cwd: gitCwd },
    }).then((result) => {
      if (!current || result._tag !== "Success") return;
      const repository = result.value.repositories.find(
        (candidate) => candidate.rootPath === gitCwd,
      );
      setWorkflowCapabilities(repository?.capabilities);
    });
    return () => {
      current = false;
    };
  }, [activeEnvironmentId, discoverRepositories, gitCwd, sourceControlWorkspaceSupported]);
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const changeRequestTerminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;
  // Default to true while loading so we don't flash init controls.
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const reviewedSnapshot = useMemo(
    () =>
      reviewedGitSnapshotAvailability({
        status: gitStatus,
        isPending: gitStatusPending,
        hasError: gitStatusError !== null,
      }),
    [gitStatus, gitStatusError, gitStatusPending],
  );
  // Mutation scopes deliberately see only a complete reviewed snapshot. Keep
  // the loaded status below for recovery and presentation: Fetch and existing
  // pull-request links do not mutate the reviewed checkout.
  const gitStatusForActions = reviewedSnapshot.available ? gitStatus : null;
  const currentRepositorySourceScope = sourceScopeFromStatus(
    activeEnvironmentId,
    gitCwd,
    gitStatusForActions,
  );
  const currentRepositorySourceScopeKey = currentRepositorySourceScope
    ? repositorySourceScopeKey(currentRepositorySourceScope)
    : null;
  const currentGitActionApprovalScope = actionApprovalScopeFromStatus(
    activeEnvironmentId,
    gitCwd,
    gitStatusForActions,
  );
  const currentGitActionApprovalScopeKey = currentGitActionApprovalScope
    ? gitActionApprovalScopeKey(currentGitActionApprovalScope)
    : null;
  const currentHeaderActionScope = headerActionScopeFromStatus(
    activeEnvironmentId,
    gitCwd,
    gitStatusForActions,
  );
  const currentHeaderActionScopeKey = currentHeaderActionScope
    ? headerActionScopeKey(currentHeaderActionScope)
    : null;
  const currentWorkflowApprovalScopeKey = currentHeaderActionScope
    ? [
        repositorySourceScopeKey(currentHeaderActionScope),
        currentHeaderActionScope.remoteName ?? "",
        currentHeaderActionScope.remoteRefName ?? "",
        currentHeaderActionScope.pullRemoteName ?? "",
        currentHeaderActionScope.pullRefName ?? "",
      ].join("\0")
    : null;
  const isPublishRepositoryScopeCurrent =
    publishRepositoryScope !== null &&
    currentRepositorySourceScopeKey !== null &&
    repositorySourceScopeKey(publishRepositoryScope) === currentRepositorySourceScopeKey;
  const isPendingGitConfirmationCurrent =
    pendingGitConfirmation !== null &&
    currentGitActionApprovalScopeKey !== null &&
    gitActionApprovalScopeKey(pendingGitConfirmation.scope) === currentGitActionApprovalScopeKey;
  const isWorkflowInputCurrent =
    workflowInput !== null &&
    currentWorkflowApprovalScopeKey !== null &&
    workflowApprovalScopeKey(workflowInput) === currentWorkflowApprovalScopeKey;
  const isWorktreeInputCurrent =
    worktreeInput !== null &&
    currentRepositorySourceScopeKey !== null &&
    repositorySourceScopeKey(worktreeInput.reviewedSourceScope) === currentRepositorySourceScopeKey;
  useEffect(() => {
    setPendingGitConfirmation((current) =>
      current !== null &&
      currentGitActionApprovalScopeKey !== null &&
      gitActionApprovalScopeKey(current.scope) === currentGitActionApprovalScopeKey
        ? current
        : null,
    );
  }, [currentGitActionApprovalScopeKey]);
  useEffect(() => {
    // Typed workflow forms are approvals of the source checkout they opened
    // against. Do not reuse them after a checkout, ref move, or HEAD move.
    setWorkflowInput((current) =>
      current !== null &&
      currentWorkflowApprovalScopeKey !== null &&
      workflowApprovalScopeKey(current) === currentWorkflowApprovalScopeKey
        ? current
        : null,
    );
  }, [currentWorkflowApprovalScopeKey]);
  useEffect(() => {
    setPendingHeaderAction((current) =>
      current !== null &&
      currentHeaderActionScopeKey !== null &&
      headerActionScopeKey(current.scope) === currentHeaderActionScopeKey
        ? current
        : null,
    );
  }, [currentHeaderActionScopeKey]);
  useEffect(() => {
    setWorktreeInput((current) =>
      current !== null &&
      currentRepositorySourceScopeKey !== null &&
      repositorySourceScopeKey(current.reviewedSourceScope) === currentRepositorySourceScopeKey
        ? current
        : null,
    );
  }, [currentRepositorySourceScopeKey]);
  useEffect(() => {
    if (isPublishDialogOpen && !isPublishRepositoryScopeCurrent) {
      setIsPublishDialogOpen(false);
      setPublishRepositoryScope(null);
    }
  }, [isPublishDialogOpen, isPublishRepositoryScopeCurrent]);
  const openPublishRepositoryDialog = useCallback(() => {
    const scope = sourceScopeFromStatus(activeEnvironmentId, gitCwd, gitStatusForActions);
    if (scope === null) return;
    setPublishRepositoryScope({ ...scope, threadRef: activeThreadRef });
    setIsPublishDialogOpen(true);
  }, [activeEnvironmentId, activeThreadRef, gitCwd, gitStatusForActions]);
  const setPublishRepositoryDialogOpen = useCallback((open: boolean) => {
    setIsPublishDialogOpen(open);
    if (!open) setPublishRepositoryScope(null);
  }, []);
  useEffect(() => {
    setPendingDefaultBranchAction((current) => {
      if (!current) return current;
      return currentGitActionApprovalScopeKey !== null &&
        gitActionApprovalScopeKey(current) === currentGitActionApprovalScopeKey
        ? current
        : null;
    });
  }, [currentGitActionApprovalScopeKey]);
  const providerDiscovery = sourceControlDiscoveryQuery.data?.sourceControlProviders.find(
    (provider) => provider.kind === gitStatus?.sourceControlProvider?.kind,
  );
  const selectedProject = useMemo(
    () =>
      projects.find(
        (project) =>
          project.environmentId === activeEnvironmentId && project.workspaceRoot === gitCwd,
      ) ?? null,
    [activeEnvironmentId, gitCwd, projects],
  );
  const selectedPullRequest = useMemo<PullRequestRef | null>(() => {
    const pullRequest = gitStatus?.pr;
    const repository = sourceControlRepositorySelector(selectedProject?.repositoryIdentity);
    if (!pullRequest || !selectedProject || !repository || !gitCwd) return null;
    return {
      projectId: selectedProject.id,
      repositoryRoot: gitCwd,
      repository,
      number: pullRequest.number,
    };
  }, [gitCwd, gitStatus?.pr, selectedProject]);
  const currentPullRequestMutationApprovalScope = useMemo(
    () =>
      pullRequestMutationApprovalScopeFromStatus(
        activeEnvironmentId,
        gitCwd,
        gitStatusForActions,
        selectedPullRequest,
      ),
    [activeEnvironmentId, gitCwd, gitStatusForActions, selectedPullRequest],
  );
  const currentPullRequestMutationApprovalScopeKey =
    currentPullRequestMutationApprovalScope === null
      ? null
      : pullRequestMutationApprovalScopeKey(currentPullRequestMutationApprovalScope);
  // Confirm handlers can outlive the dialog node that rendered them for one
  // event turn. Read the latest approval scope at submission time so a stale
  // retained handler cannot submit after the dialog has been closed.
  const currentPullRequestMutationApprovalScopeKeyRef = useRef<string | null>(
    currentPullRequestMutationApprovalScopeKey,
  );
  useLayoutEffect(() => {
    currentPullRequestMutationApprovalScopeKeyRef.current =
      currentPullRequestMutationApprovalScopeKey;
  }, [currentPullRequestMutationApprovalScopeKey]);
  const isPendingPullRequestActionCurrent =
    pendingPullRequestAction !== null &&
    currentPullRequestMutationApprovalScopeKey !== null &&
    pullRequestMutationApprovalScopeKey(pendingPullRequestAction) ===
      currentPullRequestMutationApprovalScopeKey;
  const pullRequestDetailQuery = useEnvironmentQuery(
    activeEnvironmentId === null || selectedPullRequest === null
      ? null
      : pullRequestEnvironment.detail({
          environmentId: activeEnvironmentId,
          input: selectedPullRequest,
        }),
  );
  const preparePullRequest = usePreparePullRequestThreadAction(sourceControlScope);

  const statusSnapshotId = gitStatus?.workingTree.snapshotId ?? null;
  // Snapshot counters are server-local. Include transport scope so `wt-1` on
  // another environment can never reuse rows or settle an older request.
  const workingTreeScope = workingTreeSnapshotScope(activeEnvironmentId, gitCwd, statusSnapshotId);
  workingTreeScopeRef.current = workingTreeScope;
  const allFiles =
    loadedWorkingTree?.scope === workingTreeScope
      ? loadedWorkingTree.files
      : (gitStatus?.workingTree.files ?? []);
  const totalFileCount = gitStatus?.workingTree.totalCount ?? allFiles.length;
  const selectedFiles =
    selection.mode === "all" ? allFiles : allFiles.filter((file) => selection.paths.has(file.path));
  const allSelected = selection.mode === "all";
  const noneSelected = selectedFiles.length === 0;
  const selectedFilePaths = buildGitCommitFilePaths(selection);

  const runImmediateGitAction = useGitStackedAction(sourceControlScope);
  const isGitActionRunning = useSourceControlActionRunning(
    sourceControlScope,
    RUNNING_SOURCE_CONTROL_ACTIONS,
  );
  const isSelectingWorktreeBase =
    !activeServerThread &&
    activeDraftThread?.envMode === "worktree" &&
    activeDraftThread.worktreePath === null;

  useEffect(() => {
    workingTreeLoadRequestId.current += 1;
    setLoadedWorkingTree(null);
    setIsEditingFiles(false);
    setVisibleFileCount(COMMIT_FILE_CHOOSER_WINDOW_SIZE);
  }, [workingTreeScope]);

  useEffect(
    () => () => {
      workingTreeLoadRequestId.current += 1;
    },
    [],
  );

  const loadAllWorkingTreeFiles = useCallback(async () => {
    if (!gitStatus || activeEnvironmentId === null || gitCwd === null) return false;
    const requestId = workingTreeLoadRequestId.current + 1;
    workingTreeLoadRequestId.current = requestId;
    const requestScope = workingTreeScope;
    const snapshotId = gitStatus.workingTree.snapshotId;
    if (snapshotId === undefined) {
      // Legacy servers provide their complete list in the status response.
      return true;
    }
    let files = [...gitStatus.workingTree.files];
    let cursor = gitStatus.workingTree.nextCursor ?? null;
    while (cursor !== null) {
      const result = await loadWorkingTreePage({
        environmentId: activeEnvironmentId,
        input: { cwd: gitCwd, snapshotId, cursor },
      });
      if (
        requestId !== workingTreeLoadRequestId.current ||
        requestScope !== workingTreeScopeRef.current
      )
        return false;
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Unable to load all changed files.",
            description: failure instanceof Error ? failure.message : "Refresh and try again.",
            data: threadToastData,
          });
        }
        return false;
      }
      if (result.value.snapshotId !== snapshotId) {
        toastManager.add({
          type: "error",
          title: "Changed files were refreshed.",
          description: "Refresh the commit dialog and choose files again.",
          data: threadToastData,
        });
        return false;
      }
      const existing = new Set(files.map((file) => file.path));
      files.push(...result.value.files.filter((file) => !existing.has(file.path)));
      cursor = result.value.nextCursor;
    }
    if (
      requestId !== workingTreeLoadRequestId.current ||
      requestScope !== workingTreeScopeRef.current
    )
      return false;
    setLoadedWorkingTree({ scope: requestScope, files });
    return true;
  }, [
    activeEnvironmentId,
    gitCwd,
    gitStatus,
    loadWorkingTreePage,
    threadToastData,
    workingTreeScope,
  ]);

  const beginEditingFiles = useCallback(() => {
    void (async () => {
      if (await loadAllWorkingTreeFiles()) setIsEditingFiles(true);
    })();
  }, [loadAllWorkingTreeFiles]);

  useEffect(() => {
    if (isGitActionRunning || isSelectingWorktreeBase || activeServerThread) {
      return;
    }

    const branchUpdate = resolveLiveThreadBranchUpdate({
      threadBranch: activeDraftThread?.branch ?? null,
      gitStatus,
    });
    if (!branchUpdate) {
      return;
    }

    persistThreadBranchSync(branchUpdate.branch);
  }, [
    activeServerThread,
    activeDraftThread?.branch,
    gitStatus,
    isGitActionRunning,
    isSelectingWorktreeBase,
    persistThreadBranchSync,
  ]);

  const isDefaultRef = useMemo(() => {
    return gitStatus?.isDefaultRef ?? false;
  }, [gitStatus?.isDefaultRef]);

  const pullRequestDetailStatus: "loading" | "failed" | "ready" =
    pullRequestDetailQuery.data !== null
      ? "ready"
      : pullRequestDetailQuery.error !== null
        ? "failed"
        : "loading";
  const pullRequestAvailability = useMemo(
    () => ({
      providerAvailable: providerDiscovery?.status === "available",
      // A repository's remote only identifies the host. Discovery is the authority for whether
      // this environment has a usable provider executable and authenticated account.
      authenticated: providerDiscovery?.auth.status === "authenticated",
      hasPullRequest: gitStatus?.pr?.state === "open",
      hasReference: selectedPullRequest !== null,
      detailStatus: pullRequestDetailStatus,
      ...(selectedPullRequest === null || pullRequestDetailQuery.data === null
        ? {}
        : {
            actions: new Set(pullRequestDetailQuery.data.capabilities.actions),
            viewerActions: new Set(pullRequestDetailQuery.data.viewerPermissions.actions),
          }),
    }),
    [
      gitStatus?.pr?.state,
      providerDiscovery?.auth.status,
      providerDiscovery?.status,
      pullRequestDetailQuery.data,
      pullRequestDetailStatus,
      selectedPullRequest,
    ],
  );
  const workflowMenuItems = useMemo(
    () =>
      buildWorkflowMenuItems(
        gitStatus,
        workflowCapabilities,
        isGitActionRunning,
        pullRequestAvailability,
        reviewedSnapshot,
      ),
    [
      gitStatus,
      isGitActionRunning,
      pullRequestAvailability,
      reviewedSnapshot,
      workflowCapabilities,
    ],
  );

  useEffect(() => {
    setPendingPullRequestAction((current) =>
      current !== null &&
      currentPullRequestMutationApprovalScopeKey !== null &&
      pullRequestMutationApprovalScopeKey(current) === currentPullRequestMutationApprovalScopeKey
        ? current
        : null,
    );
  }, [currentPullRequestMutationApprovalScopeKey]);
  const quickAction = useMemo(
    () =>
      resolveQuickAction(
        gitStatus,
        isGitActionRunning,
        isDefaultRef,
        hasPrimaryRemote,
        reviewedSnapshot,
      ),
    [gitStatus, hasPrimaryRemote, isDefaultRef, isGitActionRunning, reviewedSnapshot],
  );
  const quickActionDisabledReason = quickAction.disabled
    ? (quickAction.hint ?? "This action is currently unavailable.")
    : null;
  const pendingDefaultBranchActionCopy = pendingDefaultBranchAction
    ? resolveDefaultBranchActionDialogCopy({
        action: pendingDefaultBranchAction.action,
        branchName: pendingDefaultBranchAction.sourceRef ?? "detached HEAD",
        includesCommit: pendingDefaultBranchAction.includesCommit,
        repositoryRoot: pendingDefaultBranchAction.cwd,
        terminology: changeRequestTerminology,
      })
    : null;

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!activeGitActionProgressRef.current) {
        return;
      }
      updateActiveProgressToast();
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [updateActiveProgressToast]);

  useEffect(() => {
    if (gitCwd === null) {
      return;
    }

    let refreshTimeout: number | null = null;
    const scheduleRefreshCurrentGitStatus = () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      refreshTimeout = window.setTimeout(() => {
        refreshTimeout = null;
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
      }, GIT_STATUS_WINDOW_REFRESH_DEBOUNCE_MS);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        scheduleRefreshCurrentGitStatus();
      }
    };

    window.addEventListener("focus", scheduleRefreshCurrentGitStatus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      if (refreshTimeout !== null) {
        window.clearTimeout(refreshTimeout);
      }
      window.removeEventListener("focus", scheduleRefreshCurrentGitStatus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeEnvironmentId, gitCwd, refreshVcsStatus]);

  const openExistingPr = useCallback(async () => {
    const openPr = gitStatus?.pr?.state === "open" ? gitStatus.pr : null;
    // Beside the thread where it was made, the way the browser opens beside it. Checked before
    // the shell, which opening in the app does not need.
    if (openPr && onOpenPullRequest) {
      onOpenPullRequest(openPr.number);
      return;
    }
    const prUrl = openPr?.url ?? null;
    if (!prUrl) {
      toastManager.add({
        type: "error",
        title: "No open pull request found.",
        data: threadToastData,
      });
      return;
    }
    void openLink(prUrl).catch((err: unknown) => {
      console.error(err);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: err instanceof Error ? err.message : "An error occurred.",
          ...(threadToastData !== undefined ? { data: threadToastData } : {}),
        }),
      );
    });
  }, [gitStatus, onOpenPullRequest, openLink, threadToastData]);

  const runPullRequestMenuAction = (id: GitWorkflowMenuId) => {
    if (!activeEnvironmentId) return;
    if (workflowActionRequiresReviewedSnapshot(id) && !reviewedSnapshot.available) return;
    if (id === "pr-create") {
      void runGitActionWithToast({ action: "create_pr" });
      return;
    }
    if (id === "pr-open") {
      void openExistingPr();
      return;
    }
    if (id === "pr-refresh") {
      if (selectedPullRequest === null) return;
      void invalidatePullRequest({
        environmentId: activeEnvironmentId,
        input: { reference: selectedPullRequest },
      });
      return;
    }
    if (id === "pr-checkout" || id === "pr-merge" || id === "pr-close") {
      const action = id === "pr-checkout" ? "checkout" : id === "pr-merge" ? "merge" : "close";
      const approvalScope = currentPullRequestMutationApprovalScope;
      if (approvalScope === null) return;
      setPendingPullRequestAction({
        action,
        ...approvalScope,
        repositoryLabel: approvalScope.reference.repository,
      });
    }
  };

  const executePullRequestAction = async () => {
    const pending = pendingPullRequestAction;
    if (
      !pending ||
      currentPullRequestMutationApprovalScopeKeyRef.current === null ||
      pullRequestMutationApprovalScopeKey(pending) !==
        currentPullRequestMutationApprovalScopeKeyRef.current
    ) {
      setPendingPullRequestAction(null);
      return;
    }
    setPendingPullRequestAction(null);
    const result =
      pending.action === "checkout"
        ? await preparePullRequest.run({
            reference: pending.url,
            mode: "local",
            ...(activeThreadRef ? { threadId: activeThreadRef.threadId } : {}),
            // Checkout is a local Git mutation. Do not let this older header entry point
            // bypass the exact repository snapshot that its confirmation displayed.
            precondition: sourceScopePrecondition(pending.reviewedSourceScope),
          })
        : await runPullRequestAction({
            environmentId: pending.reviewedSourceScope.environmentId,
            input: { ...pending.reference, action: pending.action satisfies PullRequestAction },
          });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `Pull request ${pending.action} failed`,
          description:
            error instanceof Error
              ? error.message
              : "The pull request provider refused the action.",
          data: threadToastData,
        });
      }
      return;
    }
    requestVcsStatusRefresh(
      refreshVcsStatus,
      pending.reviewedSourceScope.environmentId,
      pending.reference.repositoryRoot ?? null,
    );
  };

  runGitActionWithToast = useEffectEvent(
    async ({
      action,
      commitMessage,
      onConfirmed,
      skipDefaultBranchPrompt = false,
      skipConfirmation = false,
      statusOverride,
      featureBranch = false,
      progressToastId,
      filePaths,
      precondition,
    }: RunGitActionWithToastInput) => {
      if (!sourceControlWorkspaceSupported) {
        toastManager.add({
          type: "error",
          title: "Source Control unavailable",
          description: "Update the connected T3 Code server to use Git workspace actions.",
          data: threadToastData,
        });
        return;
      }
      const actionStatus = statusOverride ?? gitStatusForActions;
      const actionSourceScope = sourceScopeFromStatus(activeEnvironmentId, gitCwd, actionStatus);
      // Every action this runner can execute mutates the reviewed checkout or
      // publishes from it, so a complete current status is required.
      if (actionSourceScope === null) return;
      const actionPrecondition =
        precondition ??
        (actionSourceScope ? sourceScopePrecondition(actionSourceScope) : undefined);
      const actionBranch = actionStatus?.refName ?? null;
      const actionIsDefaultBranch = featureBranch ? false : isDefaultRef;
      const actionCanCommit =
        action === "commit" || action === "commit_push" || action === "commit_push_pr";
      const includesCommit =
        actionCanCommit &&
        (action === "commit" || !!actionStatus?.hasWorkingTreeChanges || featureBranch);
      if (
        !skipDefaultBranchPrompt &&
        requiresDefaultBranchConfirmation(action, actionIsDefaultBranch) &&
        actionBranch
      ) {
        if (
          action !== "push" &&
          action !== "create_pr" &&
          action !== "commit_push" &&
          action !== "commit_push_pr"
        ) {
          return;
        }
        if (activeEnvironmentId === null || gitCwd === null) return;
        const approvalScope = actionApprovalScopeFromStatus(
          activeEnvironmentId,
          gitCwd,
          actionStatus,
        );
        if (approvalScope === null) return;
        setPendingDefaultBranchAction({
          ...approvalScope,
          action,
          includesCommit,
          ...(commitMessage ? { commitMessage } : {}),
          ...(onConfirmed ? { onConfirmed } : {}),
          ...(filePaths ? { filePaths } : {}),
        });
        return;
      }
      if (!skipConfirmation && action !== "commit") {
        const approvalScope = actionApprovalScopeFromStatus(
          activeEnvironmentId,
          gitCwd,
          actionStatus,
        );
        if (approvalScope === null) return;
        setPendingGitConfirmation({
          scope: approvalScope,
          input: {
            action,
            ...(commitMessage ? { commitMessage } : {}),
            ...(onConfirmed ? { onConfirmed } : {}),
            ...(filePaths ? { filePaths } : {}),
          },
        });
        return;
      }
      onConfirmed?.();

      const progressStages = buildGitActionProgressStages({
        action,
        hasCustomCommitMessage: !!commitMessage?.trim(),
        hasWorkingTreeChanges: !!actionStatus?.hasWorkingTreeChanges,
        featureBranch,
        terminology: changeRequestTerminology,
        shouldPushBeforePr:
          action === "create_pr" &&
          (!actionStatus?.hasUpstream || (actionStatus?.aheadCount ?? 0) > 0),
      });
      const scopedToastData = threadToastData ? { ...threadToastData } : undefined;
      const actionId = randomUUID();
      const resolvedProgressToastId =
        progressToastId ??
        toastManager.add({
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });

      activeGitActionProgressRef.current = {
        toastId: resolvedProgressToastId,
        toastData: scopedToastData,
        actionId,
        title: progressStages[0] ?? "Running git action...",
        phaseStartedAtMs: null,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        currentPhaseLabel: progressStages[0] ?? "Running git action...",
      };

      if (progressToastId) {
        toastManager.update(progressToastId, {
          type: "loading",
          title: progressStages[0] ?? "Running git action...",
          description: "Waiting for Git...",
          timeout: 0,
          data: scopedToastData,
        });
      }

      const applyProgressEvent = (event: GitActionProgressEvent) => {
        const progress = activeGitActionProgressRef.current;
        if (!progress) {
          return;
        }
        if (gitCwd && event.cwd !== gitCwd) {
          return;
        }
        if (progress.actionId !== event.actionId) {
          return;
        }

        const now = Date.now();
        switch (event.kind) {
          case "action_started":
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "phase_started":
            progress.title = event.label;
            progress.currentPhaseLabel = event.label;
            progress.phaseStartedAtMs = now;
            progress.hookStartedAtMs = null;
            progress.hookName = null;
            progress.lastOutputLine = null;
            break;
          case "hook_started":
            progress.title = `Running ${event.hookName}...`;
            progress.hookName = event.hookName;
            progress.hookStartedAtMs = now;
            progress.lastOutputLine = null;
            break;
          case "hook_output":
            progress.lastOutputLine = event.text;
            break;
          case "hook_finished":
            progress.title = progress.currentPhaseLabel ?? "Committing...";
            progress.hookName = null;
            progress.hookStartedAtMs = null;
            progress.lastOutputLine = null;
            break;
          case "action_finished":
            // Let the resolved mutation update the toast so we keep the
            // elapsed description visible until the final success state renders.
            return;
          case "action_failed":
            // Let the settled mutation publish the error toast to avoid a
            // transient intermediate state before the final failure message.
            return;
        }

        updateActiveProgressToast();
      };

      const result = await runImmediateGitAction.run({
        actionId,
        action,
        ...(commitMessage ? { commitMessage } : {}),
        ...(featureBranch ? { featureBranch } : {}),
        ...(filePaths ? { filePaths } : {}),
        ...(actionPrecondition ? { precondition: actionPrecondition } : {}),
        // A pull request the action opens is linked to the thread it ran beside. Drafts
        // have no server thread yet, so there is nothing to link to.
        ...(activeServerThread ? { threadId: activeServerThread.id } : {}),
        onProgress: applyProgressEvent,
      });

      activeGitActionProgressRef.current = null;
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          toastManager.close(resolvedProgressToastId);
          return;
        }

        const error = squashAtomCommandFailure(result);
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "error",
            title: "Action failed",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(scopedToastData !== undefined ? { data: scopedToastData } : {}),
          }),
        );
        return;
      }

      const actionResult = result.value;
      syncThreadBranchAfterGitAction(actionResult);
      const closeResultToast = () => {
        toastManager.close(resolvedProgressToastId);
      };

      const toastCta = actionResult.toast.cta;
      let toastActionProps: {
        children: string;
        onClick: (event: MouseEvent<HTMLButtonElement>) => void;
      } | null = null;
      if (toastCta.kind === "run_action") {
        toastActionProps = {
          children: toastCta.label,
          onClick: () => {
            closeResultToast();
            void runGitActionWithToast({
              action: toastCta.action.kind,
            });
          },
        };
      } else if (toastCta.kind === "open_pr") {
        toastActionProps = {
          children: toastCta.label,
          onClick: (event) => {
            closeResultToast();
            openPrLink(event, toastCta.url);
          },
        };
      }

      const successToastData = {
        ...scopedToastData,
        dismissAfterVisibleMs: 10_000,
      };

      if (toastActionProps) {
        toastManager.update(
          resolvedProgressToastId,
          stackedThreadToast({
            type: "success",
            title: actionResult.toast.title,
            description: actionResult.toast.description,
            timeout: 0,
            actionProps: toastActionProps,
            data: successToastData,
          }),
        );
      } else {
        toastManager.update(resolvedProgressToastId, {
          type: "success",
          title: actionResult.toast.title,
          description: actionResult.toast.description,
          timeout: 0,
          data: successToastData,
        });
      }
    },
  );

  const continuePendingDefaultBranchAction = () => {
    if (!pendingDefaultBranchAction) return;
    const {
      action,
      sourceRef,
      sourceHead,
      sourceIndexTree,
      targetRemoteName,
      targetRefName,
      commitMessage,
      onConfirmed,
      filePaths,
      environmentId,
      cwd,
    } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    if (
      environmentId !== activeEnvironmentId ||
      cwd !== gitCwd ||
      currentGitActionApprovalScope === null ||
      gitActionApprovalScopeKey({
        sourceRef,
        sourceHead,
        sourceIndexTree,
        targetRemoteName,
        targetRefName,
        environmentId,
        cwd,
      }) !== gitActionApprovalScopeKey(currentGitActionApprovalScope)
    )
      return;
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      skipDefaultBranchPrompt: true,
      skipConfirmation: true,
      precondition: {
        expectedHeadCommit: sourceHead,
        expectedIndexTree: sourceIndexTree,
        expectedRefName: sourceRef,
      },
    });
  };

  const continuePendingGitConfirmation = () => {
    if (!pendingGitConfirmation) return;
    const { input, scope } = pendingGitConfirmation;
    setPendingGitConfirmation(null);
    if (
      currentGitActionApprovalScope === null ||
      gitActionApprovalScopeKey(scope) !== gitActionApprovalScopeKey(currentGitActionApprovalScope)
    )
      return;
    const precondition = sourceScopePrecondition(scope);
    void runGitActionWithToast({
      ...input,
      skipDefaultBranchPrompt: true,
      skipConfirmation: true,
      precondition,
    });
  };

  const checkoutFeatureBranchAndContinuePendingAction = () => {
    if (!pendingDefaultBranchAction) return;
    const {
      action,
      sourceRef,
      sourceHead,
      sourceIndexTree,
      targetRemoteName,
      targetRefName,
      commitMessage,
      onConfirmed,
      filePaths,
      environmentId,
      cwd,
    } = pendingDefaultBranchAction;
    setPendingDefaultBranchAction(null);
    if (
      environmentId !== activeEnvironmentId ||
      cwd !== gitCwd ||
      currentGitActionApprovalScope === null ||
      gitActionApprovalScopeKey({
        sourceRef,
        sourceHead,
        sourceIndexTree,
        targetRemoteName,
        targetRefName,
        environmentId,
        cwd,
      }) !== gitActionApprovalScopeKey(currentGitActionApprovalScope)
    )
      return;
    void runGitActionWithToast({
      action,
      ...(commitMessage ? { commitMessage } : {}),
      ...(onConfirmed ? { onConfirmed } : {}),
      ...(filePaths ? { filePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
      skipConfirmation: true,
      precondition: {
        expectedHeadCommit: sourceHead,
        expectedIndexTree: sourceIndexTree,
        expectedRefName: sourceRef,
      },
    });
  };

  const runDialogActionOnNewBranch = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();

    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setSelection({ mode: "all" });
    setIsEditingFiles(false);

    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(selectedFilePaths ? { filePaths: selectedFilePaths } : {}),
      featureBranch: true,
      skipDefaultBranchPrompt: true,
    });
  };

  const runQuickAction = () => {
    if (
      quickAction.kind !== "open_pr" &&
      quickAction.kind !== "show_hint" &&
      !reviewedSnapshot.available
    ) {
      return;
    }
    if (quickAction.kind === "open_pr") {
      void openExistingPr();
      return;
    }
    if (quickAction.kind === "open_publish") {
      openPublishRepositoryDialog();
      return;
    }
    if (quickAction.kind === "run_pull") {
      if (currentHeaderActionScope) {
        setPendingHeaderAction({ action: "pull", scope: currentHeaderActionScope });
      }
      return;
    }
    if (quickAction.kind === "show_hint") {
      toastManager.add({
        type: "info",
        title: quickAction.label,
        description: quickAction.hint,
        data: threadToastData,
      });
      return;
    }
    if (quickAction.action) {
      if (quickAction.action === "commit") {
        // The header primary Commit is a presentation entry point. It opens
        // the same typed, index-only workflow as the repository menu rather
        // than reviving the old selected-working-tree stacked action.
        openWorkflowInput("commit");
        return;
      }
      if (quickAction.action === "commit_push") {
        openWorkflowInput("commit-push");
        return;
      }
      if (quickAction.action === "commit_push_pr") {
        // The old stacked action silently staged the working tree. Keep the
        // visible shortcut, but make it enter the indexed compound workflow.
        openWorkflowInput("commit-publish");
        return;
      }
      void runGitActionWithToast({ action: quickAction.action });
    }
  };

  const runWorkflowMenuAction = (id: GitWorkflowMenuId) => {
    if (!sourceControlWorkspaceSupported || !activeEnvironmentId || !gitCwd) return;
    if (workflowActionRequiresReviewedSnapshot(id) && !reviewedSnapshot.available) return;
    if (
      id === "view-tree" ||
      id === "view-list" ||
      id === "view-sort" ||
      id === "view-sort-path" ||
      id === "view-sort-name" ||
      id === "view-sort-status"
    ) {
      if (id === "view-tree" || id === "view-list") setSourceControlPresentationChoice(id);
      if (id === "view-sort-path" || id === "view-sort-name" || id === "view-sort-status")
        setSourceControlSortChoice(id);
      window.dispatchEvent(new CustomEvent("t3code:source-control-view", { detail: id }));
      return;
    }
    const safeActions: ReadonlySet<GitActionOperation> = new Set([
      "fetch",
      "pull",
      "push",
      "sync",
      "publish",
    ]);
    if (!safeActions.has(id as GitActionOperation)) return;
    if (id !== "fetch") {
      if (currentHeaderActionScope) {
        setPendingHeaderAction({
          action: id as "pull" | "push" | "sync" | "publish",
          scope: currentHeaderActionScope,
        });
      }
      return;
    }
    void runWorkflowAction({
      environmentId: activeEnvironmentId,
      input: { cwd: gitCwd, action: id as GitActionOperation, confirm: false },
    }).then((result) => {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: `${id} failed`,
            description:
              squashAtomCommandFailure(result) instanceof Error
                ? (squashAtomCommandFailure(result) as Error).message
                : "The Git operation failed.",
            data: threadToastData,
          });
        }
        return;
      }
      requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
    });
  };

  const executePendingHeaderAction = async () => {
    if (
      !sourceControlWorkspaceSupported ||
      !pendingHeaderAction ||
      !activeEnvironmentId ||
      !gitCwd ||
      currentHeaderActionScopeKey === null ||
      headerActionScopeKey(pendingHeaderAction.scope) !== currentHeaderActionScopeKey
    )
      return;
    const { action, continuation, scope } = pendingHeaderAction;
    const remoteName = continuation?.remoteName ?? scope.remoteName;
    const refName = continuation?.refName ?? scope.remoteRefName;
    const pullRemoteName = continuation?.pullRemoteName ?? scope.pullRemoteName;
    const pullRefName = continuation?.pullRefName ?? scope.pullRefName;
    setPendingHeaderAction(null);
    const result = await runWorkflowAction({
      environmentId: activeEnvironmentId,
      input: {
        cwd: scope.cwd,
        action,
        confirm: true,
        ...(remoteName ? { remoteName } : {}),
        ...(refName ? { refName } : {}),
        ...(continuation?.sourceRef ? { sourceRef: continuation.sourceRef } : {}),
        precondition: sourceScopePrecondition(scope),
        ...(pullRemoteName ? { pullRemoteName } : {}),
        ...(pullRefName ? { pullRefName } : {}),
        ...(continuation?.strategy ? { strategy: continuation.strategy } : {}),
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `${action} failed`,
          description: error instanceof Error ? error.message : "The Git operation failed.",
          data: threadToastData,
        });
      }
      return;
    }
    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
  };

  const openWorkflowInput = (id: GitWorkflowMenuId) => {
    if (!sourceControlWorkspaceSupported || !activeEnvironmentId || !gitCwd) return;
    if (workflowActionRequiresReviewedSnapshot(id) && !reviewedSnapshot.available) return;
    const immediateInput: Partial<GitActionRequest> | null =
      id === "stage-all"
        ? { action: "discard", changeOperation: "stage", confirm: false }
        : id === "unstage-all"
          ? { action: "discard", changeOperation: "unstage", confirm: false }
          : id === "fetch-all"
            ? { action: "fetch", fetchOperation: "all", confirm: false }
            : id === "fetch-prune"
              ? { action: "fetch", fetchOperation: "prune", confirm: false }
              : id === "stash-view"
                ? { action: "stash", stashOperation: "view", confirm: false }
                : null;
    if (immediateInput) {
      void runWorkflowAction({
        environmentId: activeEnvironmentId,
        input: { cwd: gitCwd, ...immediateInput } as GitActionRequest,
      }).then((result) => {
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add({
              type: "error",
              title: `${id === "stash-view" ? "View stash" : id} failed`,
              description: error instanceof Error ? error.message : "The Git operation failed.",
              data: threadToastData,
            });
          }
          return;
        }
        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
        if (id === "stash-view") setStashOutput(result.value.output ?? "No stashed changes.");
      });
      return;
    }
    if (id === "worktree") {
      const reviewedSourceScope = sourceScopeFromStatus(
        activeEnvironmentId,
        gitCwd,
        gitStatusForActions,
      );
      if (reviewedSourceScope === null) return;
      setWorktreeInput({
        reviewedSourceScope,
        refName: gitStatusForActions?.refName ?? "",
        newRefName: "",
        baseRefName: gitStatusForActions?.refName ?? "",
        path: "",
      });
      return;
    }
    if (
      id === "view-tree" ||
      id === "view-sort" ||
      id === "view-list" ||
      id === "view-sort-path" ||
      id === "view-sort-name" ||
      id === "view-sort-status" ||
      id === "fetch" ||
      id === "pull" ||
      id === "push" ||
      id === "sync" ||
      id === "publish"
    ) {
      return;
    }
    if (id.startsWith("pr-")) {
      runPullRequestMenuAction(id);
      return;
    }
    const action: WorkflowInputAction =
      id === "checkout"
        ? "checkout"
        : id.startsWith("branch-")
          ? "branch"
          : id.startsWith("remote-")
            ? "remote"
            : id.startsWith("stash-")
              ? "stash"
              : id.startsWith("tag-")
                ? "tag"
                : id === "discard-all" || id === "unstage-all" || id === "stage-all"
                  ? "discard"
                  : id === "undo-commit"
                    ? "reset"
                    : id === "commit-push" || id === "commit-sync" || id === "commit-publish"
                      ? "commit"
                      : id === "pull-from" || id === "pull-rebase"
                        ? "pull"
                        : id === "push-to" || id === "force-push"
                          ? "push"
                          : id === "fetch-all" || id === "fetch-prune"
                            ? "fetch"
                            : id === "conflict-continue" || id === "conflict-abort"
                              ? "conflict"
                              : (id as WorkflowInputAction);
    const operation =
      id === "commit-push" || id === "commit-sync" || id === "commit-publish"
        ? id
        : id === "branch-create"
          ? "create"
          : id === "branch-create-from"
            ? "create-from"
            : id === "branch-rename"
              ? "rename"
              : id === "branch-delete"
                ? "delete"
                : id === "branch-delete-remote"
                  ? "delete-remote"
                  : id === "branch-publish"
                    ? "publish"
                    : id === "remote-add"
                      ? "add"
                      : id === "remote-remove"
                        ? "remove"
                        : id === "stash-untracked"
                          ? "include-untracked"
                          : id === "stash-staged"
                            ? "staged"
                            : id === "stash-view"
                              ? "view"
                              : id === "stash-apply"
                                ? "apply"
                                : id === "stash-apply-latest"
                                  ? "apply-latest"
                                  : id === "stash-pop"
                                    ? "pop"
                                    : id === "stash-pop-latest"
                                      ? "pop-latest"
                                      : id === "stash-drop"
                                        ? "drop"
                                        : id === "stash-drop-all"
                                          ? "drop-all"
                                          : id === "tag-create"
                                            ? "create"
                                            : id === "tag-delete"
                                              ? "delete"
                                              : id === "tag-push" || id === "tag-push-all"
                                                ? id === "tag-push-all"
                                                  ? "push-all"
                                                  : "push"
                                                : id === "stage-all"
                                                  ? "stage"
                                                  : id === "unstage-all"
                                                    ? "unstage"
                                                    : id === "discard-all"
                                                      ? "discard"
                                                      : id === "undo-commit"
                                                        ? "undo-last-commit"
                                                        : id === "pull-rebase"
                                                          ? "rebase"
                                                          : id === "pull-from"
                                                            ? "from"
                                                            : id === "force-push"
                                                              ? "force"
                                                              : id === "push-to"
                                                                ? "to"
                                                                : id === "fetch-all"
                                                                  ? "all"
                                                                  : id === "fetch-prune"
                                                                    ? "prune"
                                                                    : action === "checkout"
                                                                      ? "checkout"
                                                                      : action === "branch"
                                                                        ? "checkout"
                                                                        : action === "remote"
                                                                          ? "add"
                                                                          : action === "stash"
                                                                            ? "push"
                                                                            : action === "tag"
                                                                              ? "create"
                                                                              : id ===
                                                                                  "conflict-continue"
                                                                                ? "continue"
                                                                                : id ===
                                                                                    "conflict-abort"
                                                                                  ? "abort"
                                                                                  : "run";
    const reviewedSourceScope = sourceScopeFromStatus(
      activeEnvironmentId,
      gitCwd,
      gitStatusForActions,
    );
    if (reviewedSourceScope === null) return;
    setWorkflowInput({
      reviewedSourceScope,
      reviewedRemoteName: gitStatusForActions?.remoteName ?? null,
      reviewedRemoteRefName: gitStatusForActions?.remoteRefName ?? null,
      reviewedPullRemoteName: gitStatusForActions?.pullRemoteName ?? null,
      reviewedPullRefName: gitStatusForActions?.pullRefName ?? null,
      ...(gitStatusForActions?.indexTree !== undefined &&
      (action !== "commit" && action !== "amend"
        ? true
        : gitStatusForActions.refName !== null && gitStatusForActions.refName !== undefined)
        ? {
            reviewedPrecondition: {
              expectedHeadCommit: gitStatusForActions.headCommit ?? null,
              expectedIndexTree: gitStatusForActions.indexTree,
              expectedRefName: gitStatusForActions.refName,
              ...(gitStatusForActions.pendingMergeHeads !== undefined
                ? { expectedMergeHeads: gitStatusForActions.pendingMergeHeads }
                : {}),
            } satisfies GitMutationPrecondition,
          }
        : {}),
      id,
      action,
      operation,
      refName: "",
      sourceRef: "",
      targetRef: "",
      oldRefName: "",
      newRefName: "",
      remoteName: gitStatusForActions?.remoteName ?? "",
      message: "",
      paths: "",
      strategy: "merge",
    });
  };

  const executeWorktreeInput = async () => {
    if (!worktreeInput || !activeEnvironmentId || !gitCwd) return;
    if (
      !isWorktreeInputCurrent ||
      worktreeInput.reviewedSourceScope.environmentId !== activeEnvironmentId ||
      worktreeInput.reviewedSourceScope.cwd !== gitCwd
    ) {
      setWorktreeInput(null);
      return;
    }
    if (!worktreeInput.refName.trim() || !worktreeInput.newRefName.trim()) {
      toastManager.add({
        type: "error",
        title: "Worktree branch is required.",
        description: "Choose the base ref and name the new worktree branch.",
        data: threadToastData,
      });
      return;
    }
    const input = {
      cwd: worktreeInput.reviewedSourceScope.cwd,
      refName: worktreeInput.refName.trim(),
      newRefName: worktreeInput.newRefName.trim(),
      ...(worktreeInput.baseRefName.trim()
        ? { baseRefName: worktreeInput.baseRefName.trim() }
        : {}),
      path: worktreeInput.path.trim() || null,
      precondition: sourceScopePrecondition(worktreeInput.reviewedSourceScope),
    };
    setWorktreeInput(null);
    // The completed form is the Worktree confirmation surface. The shared
    // workspace adapter deliberately refuses branch mutations unless that
    // acknowledgement is carried through to its two-phase runner.
    const result = await createWorktree({
      environmentId: worktreeInput.reviewedSourceScope.environmentId,
      input: { ...input, confirmation: "approved" },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Worktree creation failed",
          description: error instanceof Error ? error.message : "The Git operation failed.",
          data: threadToastData,
        });
      }
      return;
    }
    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
    toastManager.add({
      type: "success",
      title: "Worktree created",
      description: result.value.worktree.path,
      data: threadToastData,
    });
  };

  const executeWorkflowInput = async () => {
    if (!sourceControlWorkspaceSupported || !workflowInput || !activeEnvironmentId || !gitCwd)
      return;
    if (
      !isWorkflowInputCurrent ||
      workflowInput.reviewedSourceScope.environmentId !== activeEnvironmentId ||
      workflowInput.reviewedSourceScope.cwd !== gitCwd
    ) {
      setWorkflowInput(null);
      return;
    }
    const paths = workflowInput.paths
      .split(/[\n,]/)
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
    const missingField = workflowRequiredFields(workflowInput.id).find(
      (field) => !workflowInput[field].trim(),
    );
    if (missingField) {
      toastManager.add({
        type: "error",
        title: "Required Git input is missing",
        description: `${missingField === "sourceRef" ? "Source ref" : missingField === "remoteName" ? "Remote name" : "Ref name"} is required for this action.`,
        data: threadToastData,
      });
      return;
    }
    const action = workflowInput.action === "checkout" ? "branch" : workflowInput.action;
    const operationInput: Partial<GitActionRequest> =
      action === "branch"
        ? { branchOperation: workflowInput.operation as GitActionRequest["branchOperation"] }
        : action === "remote"
          ? { remoteOperation: workflowInput.operation as GitActionRequest["remoteOperation"] }
          : action === "stash"
            ? { stashOperation: workflowInput.operation as GitActionRequest["stashOperation"] }
            : action === "tag"
              ? { tagOperation: workflowInput.operation as GitActionRequest["tagOperation"] }
              : action === "conflict"
                ? {
                    conflictOperation:
                      workflowInput.operation as GitActionRequest["conflictOperation"],
                  }
                : action === "discard"
                  ? {
                      changeOperation:
                        workflowInput.operation as GitActionRequest["changeOperation"],
                    }
                  : action === "commit" && workflowInput.operation.startsWith("commit-")
                    ? {
                        compoundOperation:
                          workflowInput.operation as GitActionRequest["compoundOperation"],
                      }
                    : action === "pull" && workflowInput.operation === "from"
                      ? { pullOperation: "from" }
                      : action === "push" && workflowInput.operation === "to"
                        ? { pushOperation: "to" }
                        : action === "fetch"
                          ? {
                              fetchOperation:
                                workflowInput.operation as GitActionRequest["fetchOperation"],
                            }
                          : action === "reset" && workflowInput.operation === "undo-last-commit"
                            ? { resetOperation: "undo-last-commit" }
                            : {};
    const precondition = workflowInput.reviewedPrecondition;
    const input: GitActionRequest = {
      cwd: workflowInput.reviewedSourceScope.cwd,
      action,
      confirm:
        workflowMenuItems.find((item) => item.id === workflowInput.id)?.requiresConfirmation ??
        true,
      ...(workflowInput.message.trim() ? { message: workflowInput.message.trim() } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(workflowInput.refName.trim() ? { refName: workflowInput.refName.trim() } : {}),
      ...(workflowInput.sourceRef.trim() ? { sourceRef: workflowInput.sourceRef.trim() } : {}),
      ...(workflowInput.targetRef.trim() ? { targetRef: workflowInput.targetRef.trim() } : {}),
      ...(workflowInput.oldRefName.trim() ? { oldRefName: workflowInput.oldRefName.trim() } : {}),
      ...(workflowInput.newRefName.trim() ? { newRefName: workflowInput.newRefName.trim() } : {}),
      ...(workflowInput.remoteName.trim() ? { remoteName: workflowInput.remoteName.trim() } : {}),
      ...(action === "commit" && workflowInput.operation.startsWith("commit-")
        ? {
            ...(workflowInput.remoteName.trim() || workflowInput.reviewedRemoteName
              ? { remoteName: workflowInput.remoteName.trim() || workflowInput.reviewedRemoteName! }
              : {}),
            ...(workflowInput.reviewedRemoteRefName
              ? { refName: workflowInput.reviewedRemoteRefName }
              : {}),
            ...(workflowInput.reviewedPullRemoteName
              ? { pullRemoteName: workflowInput.reviewedPullRemoteName }
              : {}),
            ...(workflowInput.reviewedPullRefName
              ? { pullRefName: workflowInput.reviewedPullRefName }
              : {}),
          }
        : {}),
      ...(workflowInput.id === "pull-rebase" &&
      workflowInput.reviewedPullRemoteName &&
      workflowInput.reviewedPullRefName
        ? {
            pullRemoteName: workflowInput.reviewedPullRemoteName,
            pullRefName: workflowInput.reviewedPullRefName,
          }
        : {}),
      ...(workflowInput.id === "pull-rebase"
        ? { strategy: "rebase" as const }
        : action === "reset" || workflowInput.strategy !== "merge"
          ? { strategy: workflowInput.strategy }
          : {}),
      ...(workflowInput.id === "force-push" ? { force: true } : {}),
      ...operationInput,
      ...(precondition !== undefined ? { precondition } : {}),
    };
    setWorkflowInput(null);
    const result = await runWorkflowAction({
      environmentId: workflowInput.reviewedSourceScope.environmentId,
      input,
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: `${action} failed`,
          description: error instanceof Error ? error.message : "The Git operation failed.",
          data: threadToastData,
        });
      }
      return;
    }
    requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
    toastManager.add({
      type: result.value.failedStep ? "error" : "success",
      title: result.value.failedStep ? `${action} partially completed` : `${action} complete`,
      description: result.value.failedStep
        ? `${result.value.completed.join(" then ")} completed, but ${result.value.failedStep} failed.`
        : result.value.completed.join(" then "),
      data: threadToastData,
    });
  };

  const runDialogAction = () => {
    if (!isCommitDialogOpen) return;
    const commitMessage = dialogCommitMessage.trim();
    setIsCommitDialogOpen(false);
    setDialogCommitMessage("");
    setSelection({ mode: "all" });
    setIsEditingFiles(false);
    void runGitActionWithToast({
      action: "commit",
      ...(commitMessage ? { commitMessage } : {}),
      ...(selectedFilePaths ? { filePaths: selectedFilePaths } : {}),
    });
  };

  const openChangedFileInEditor = useCallback(
    (filePath: string) => {
      if (!gitCwd) {
        toastManager.add({
          type: "error",
          title: "Editor opening is unavailable.",
          data: threadToastData,
        });
        return;
      }
      const target = resolvePathLinkTarget(filePath, gitCwd);
      void (async () => {
        const result = await openInPreferredEditor(target);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
            ...(threadToastData !== undefined ? { data: threadToastData } : {}),
          }),
        );
      })();
    },
    [gitCwd, openInPreferredEditor, threadToastData],
  );

  const canPublishRepository =
    isRepo && reviewedSnapshot.available && gitStatusForActions !== null && !hasPrimaryRemote;
  const destructiveWorkflow = workflowInput
    ? destructiveWorkflowCopy({
        ...workflowInput,
        ...(gitCwd ? { repositoryRoot: gitCwd } : {}),
        ...(gitStatusForActions?.refName !== undefined
          ? { branch: gitStatusForActions.refName }
          : {}),
      })
    : null;
  const workflowApproval = workflowInput
    ? workflowApprovalDescription({
        label:
          workflowMenuItems.find((item) => item.id === workflowInput.id)?.label ??
          "Git workflow action",
        environmentId: workflowInput.reviewedSourceScope.environmentId,
        repositoryRoot: workflowInput.reviewedSourceScope.cwd,
        sourceRef: workflowInput.reviewedSourceScope.sourceRef,
        sourceHead: workflowInput.reviewedSourceScope.sourceHead,
        sourceIndexTree: workflowInput.reviewedSourceScope.sourceIndexTree,
        refName: workflowInput.refName,
        sourceRefInput: workflowInput.sourceRef,
        targetRef: workflowInput.targetRef,
        oldRefName: workflowInput.oldRefName,
        newRefName: workflowInput.newRefName,
        remoteName: workflowInput.remoteName,
        pullRemoteName: workflowInput.reviewedPullRemoteName,
        pullRefName: workflowInput.reviewedPullRefName,
        // The confirmation must describe the same editable publication remote
        // the commit compound will submit, not the default captured at open.
        publicationRemoteName: workflowInput.remoteName.trim() || workflowInput.reviewedRemoteName,
        publicationRefName: workflowInput.reviewedRemoteRefName,
        ...(workflowInput.operation.startsWith("commit-")
          ? { compoundOperation: workflowInput.operation }
          : {}),
      })
    : null;
  const retryContinuation = () => {
    if (
      !reviewedSnapshot.available ||
      !activeEnvironmentId ||
      !gitCwd ||
      !workspaceProgress.continuation ||
      !currentHeaderActionScope
    )
      return;
    setPendingHeaderAction({
      action: workspaceProgress.continuation.action,
      continuation: workspaceProgress.continuation,
      scope: currentHeaderActionScope,
    });
  };
  const headerConfirmationRemote =
    pendingHeaderAction?.continuation?.remoteName ?? pendingHeaderAction?.scope.remoteName;
  const headerConfirmationRef =
    pendingHeaderAction?.continuation?.refName ?? pendingHeaderAction?.scope.remoteRefName;
  const headerConfirmationPullRemote =
    pendingHeaderAction?.continuation?.pullRemoteName ?? pendingHeaderAction?.scope.pullRemoteName;
  const headerConfirmationPullRef =
    pendingHeaderAction?.continuation?.pullRefName ?? pendingHeaderAction?.scope.pullRefName;
  const retryDisabledReason = !reviewedSnapshot.available ? reviewedSnapshot.reason : null;
  // Keep Push both as a direct item and in the Pull/Push submenu. The two
  // entry points are deliberate; deduplicating by id made the submenu lie.
  const workflowHeaderItems = workflowMenuItems;

  if (!gitCwd) return null;

  return (
    <>
      {target === null
        ? null
        : createPortal(
            <>
              {!isRepo ? (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    if (activeEnvironmentId && gitCwd) {
                      setInitConfirmationScope({ environmentId: activeEnvironmentId, cwd: gitCwd });
                    }
                  }}
                >
                  <GitBranchPlusIcon className="size-3.5" aria-hidden />
                  <span className="ml-0.5">Initialize Git</span>
                </Button>
              ) : (
                <Group aria-label="Git actions" className="shrink-0" data-source-control-actions>
                  {quickActionDisabledReason ? (
                    <Popover>
                      <PopoverTrigger
                        openOnHover
                        render={
                          <Button
                            aria-disabled="true"
                            className="cursor-not-allowed rounded-e-none border-e-0 ps-[8.5px] opacity-64 before:rounded-e-none"
                            size="xs"
                            variant="outline"
                          />
                        }
                      >
                        <GitQuickActionIcon
                          quickAction={quickAction}
                          SourceControlIcon={SourceControlIcon}
                        />
                        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                          {quickAction.label}
                        </span>
                      </PopoverTrigger>
                      <PopoverPopup tooltipStyle side="bottom" align="start">
                        {quickActionDisabledReason}
                      </PopoverPopup>
                    </Popover>
                  ) : (
                    <Button
                      variant="outline"
                      size="xs"
                      className="ps-[8.5px]"
                      disabled={isGitActionRunning || quickAction.disabled}
                      onClick={runQuickAction}
                    >
                      <GitQuickActionIcon
                        quickAction={quickAction}
                        SourceControlIcon={SourceControlIcon}
                      />
                      <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                        {quickAction.label}
                      </span>
                    </Button>
                  )}
                  <GroupSeparator className="hidden @3xl/header-actions:block" />
                  <Menu
                    onOpenChange={(open) => {
                      if (open) {
                        requestVcsStatusRefresh(refreshVcsStatus, activeEnvironmentId, gitCwd);
                      }
                    }}
                  >
                    <MenuTrigger
                      render={
                        <Button aria-label="Git action options" size="icon-xs" variant="outline" />
                      }
                      disabled={isGitActionRunning}
                    >
                      <ChevronDownIcon aria-hidden="true" className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end" className="w-full">
                      {workspaceProgress.continuation ? (
                        <>
                          {retryDisabledReason ? (
                            <Popover>
                              <PopoverTrigger
                                openOnHover
                                nativeButton={false}
                                render={<span className="block w-max cursor-not-allowed" />}
                              >
                                <MenuItem
                                  disabled
                                  title={retryDisabledReason}
                                  onClick={retryContinuation}
                                >
                                  <CloudUploadIcon />
                                  {workspaceProgress.commitSha
                                    ? `Retry ${workspaceProgress.continuation.action} after ${workspaceProgress.commitSha.slice(0, 7)}`
                                    : `Retry ${workspaceProgress.continuation.action}`}
                                </MenuItem>
                              </PopoverTrigger>
                              <PopoverPopup tooltipStyle side="left" align="center">
                                {retryDisabledReason}
                              </PopoverPopup>
                            </Popover>
                          ) : (
                            <MenuItem
                              disabled={workspaceProgress.isRunning}
                              onClick={retryContinuation}
                            >
                              <CloudUploadIcon />
                              {workspaceProgress.commitSha
                                ? `Retry ${workspaceProgress.continuation.action} after ${workspaceProgress.commitSha.slice(0, 7)}`
                                : `Retry ${workspaceProgress.continuation.action}`}
                            </MenuItem>
                          )}
                          <MenuItem
                            onClick={() => {
                              if (!activeEnvironmentId || !gitCwd) return;
                              void dismissWorkspaceProgress({
                                environmentId: activeEnvironmentId,
                                input: { cwd: gitCwd },
                              });
                            }}
                          >
                            Dismiss incomplete operation
                          </MenuItem>
                        </>
                      ) : null}
                      {workflowMenuItems
                        .filter((item) => item.id === "fetch" || item.id === "pull")
                        .map((item) => (
                          <MenuItem
                            key={`direct-workflow-${item.id}`}
                            disabled={item.disabled}
                            onClick={() => runWorkflowMenuAction(item.id)}
                          >
                            <SourceControlIcon />
                            {item.label}
                          </MenuItem>
                        ))}
                      <MenuSeparator />
                      {(
                        [
                          "view",
                          "commit",
                          "changes",
                          "sync",
                          "branch",
                          "remote",
                          "stash",
                          "tags",
                          "pull-request",
                          "conflict",
                        ] as const
                      ).map((group) => {
                        const items = workflowHeaderItems.filter((item) => item.group === group);
                        if (items.length === 0) return null;
                        const label =
                          group === "view"
                            ? "View & Sort"
                            : group === "tags"
                              ? "Tags"
                              : group === "pull-request"
                                ? "Pull Request"
                                : group === "sync"
                                  ? "Pull/Push"
                                  : group[0]!.toUpperCase() + group.slice(1);
                        return (
                          <MenuSub key={`workflow-group-${group}`}>
                            <MenuSubTrigger>{label}</MenuSubTrigger>
                            <MenuSubPopup className="min-w-52">
                              {items.map((item) => {
                                const disabledReason = item.disabledReason ?? null;
                                const runItem = () =>
                                  HEADER_WORKFLOW_ACTIONS.has(item.id)
                                    ? runWorkflowMenuAction(item.id)
                                    : openWorkflowInput(item.id);
                                const isViewChoice =
                                  item.id === "view-tree" ||
                                  item.id === "view-list" ||
                                  item.id === "view-sort-path" ||
                                  item.id === "view-sort-name" ||
                                  item.id === "view-sort-status";
                                const content = isViewChoice ? (
                                  <MenuCheckboxItem
                                    className="w-full"
                                    checked={isWorkflowViewChecked(
                                      item.id,
                                      sourceControlPresentationChoice,
                                      sourceControlSortChoice,
                                    )}
                                    disabled={disabledReason !== null}
                                    onClick={runItem}
                                  >
                                    {item.label}
                                  </MenuCheckboxItem>
                                ) : (
                                  <MenuItem
                                    className="w-full"
                                    disabled={disabledReason !== null}
                                    onClick={runItem}
                                  >
                                    <SourceControlIcon />
                                    {item.label}
                                  </MenuItem>
                                );
                                return disabledReason ? (
                                  <Popover key={`workflow-${item.id}`}>
                                    <PopoverTrigger
                                      openOnHover
                                      nativeButton={false}
                                      render={<span className="block w-max cursor-not-allowed" />}
                                    >
                                      {content}
                                    </PopoverTrigger>
                                    <PopoverPopup tooltipStyle side="left" align="center">
                                      {disabledReason}
                                    </PopoverPopup>
                                  </Popover>
                                ) : (
                                  <span key={`workflow-${item.id}`}>{content}</span>
                                );
                              })}
                            </MenuSubPopup>
                          </MenuSub>
                        );
                      })}
                      {canPublishRepository ? (
                        <MenuItem
                          disabled={isGitActionRunning}
                          onClick={() => {
                            openPublishRepositoryDialog();
                          }}
                        >
                          <CloudUploadIcon />
                          Publish repository...
                        </MenuItem>
                      ) : null}
                      {gitStatus?.refName === null && (
                        <p className="px-2 py-1.5 text-xs text-warning">
                          Detached HEAD: create and check out a branch to enable push and pull
                          request actions.
                        </p>
                      )}
                      {gitStatus &&
                        gitStatus.refName !== null &&
                        !gitStatus.hasWorkingTreeChanges &&
                        gitStatus.behindCount > 0 &&
                        gitStatus.aheadCount === 0 && (
                          <p className="px-2 py-1.5 text-xs text-warning">
                            Behind upstream. Pull/rebase first.
                          </p>
                        )}
                      {gitStatusError && (
                        <p className="px-2 py-1.5 text-xs text-destructive">{gitStatusError}</p>
                      )}
                    </MenuPopup>
                  </Menu>
                </Group>
              )}
            </>,
            target,
          )}

      <Dialog
        open={initConfirmationScope !== null}
        onOpenChange={(open) => {
          if (!open) setInitConfirmationScope(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Initialize Git repository</DialogTitle>
            <DialogDescription>
              Environment {initConfirmationScope?.environmentId ?? "the selected environment"}.
              Initialize a new Git repository in{" "}
              {initConfirmationScope?.cwd ?? "the selected workspace"}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInitConfirmationScope(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!initConfirmationScope) return;
                const scope = initConfirmationScope;
                setInitConfirmationScope(null);
                void initializeRepository({
                  environmentId: scope.environmentId,
                  input: { cwd: scope.cwd, confirmation: "approved" },
                }).then((result) => {
                  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
                  const error = squashAtomCommandFailure(result);
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Git initialization failed",
                      description: error instanceof Error ? error.message : "An error occurred.",
                      ...(threadToastData !== undefined ? { data: threadToastData } : {}),
                    }),
                  );
                });
              }}
            >
              Initialize Git
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={isCommitDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsCommitDialogOpen(false);
            setDialogCommitMessage("");
            setSelection({ mode: "all" });
            setIsEditingFiles(false);
          }
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{COMMIT_DIALOG_TITLE}</DialogTitle>
            <DialogDescription>{COMMIT_DIALOG_DESCRIPTION}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="space-y-3 rounded-xl bg-zinc-25 p-3 text-sm ring-1 ring-black/5 dark:bg-white/[0.035] dark:ring-white/5">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
                <span className="text-muted-foreground">Branch</span>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{gitStatus?.refName ?? "(detached HEAD)"}</span>
                  {isDefaultRef && <span className="text-right text-warning">Default branch</span>}
                </span>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {isEditingFiles && allFiles.length > 0 && (
                      <Checkbox
                        checked={allSelected}
                        indeterminate={!allSelected && !noneSelected}
                        onCheckedChange={() => {
                          setSelection(
                            allSelected ? { mode: "paths", paths: new Set() } : { mode: "all" },
                          );
                        }}
                      />
                    )}
                    <span className="text-muted-foreground">Files</span>
                    {!allSelected && !isEditingFiles && (
                      <span className="text-muted-foreground">
                        ({selectedFiles.length} of {totalFileCount})
                      </span>
                    )}
                  </div>
                  {allFiles.length > 0 && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        if (isEditingFiles) setIsEditingFiles(false);
                        else beginEditingFiles();
                      }}
                    >
                      {isEditingFiles ? "Done" : "Edit"}
                    </Button>
                  )}
                </div>
                {!gitStatus || allFiles.length === 0 ? (
                  <p className="font-medium">none</p>
                ) : (
                  <div className="space-y-2">
                    <ScrollArea className="h-44 rounded-lg bg-card ring-1 ring-black/5 dark:bg-white/[0.025] dark:ring-white/5">
                      <div className="space-y-1 p-1">
                        {allFiles.slice(0, visibleFileCount).map((file) => {
                          const isExcluded = !allSelected && !selection.paths.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1 font-mono hover:bg-accent/50"
                            >
                              {isEditingFiles && (
                                <Checkbox
                                  checked={!isExcluded}
                                  onCheckedChange={() => {
                                    setSelection((current) => {
                                      if (current.mode === "all") {
                                        return {
                                          mode: "paths",
                                          paths: new Set(
                                            allFiles
                                              .filter((entry) => entry.path !== file.path)
                                              .map((entry) => entry.path),
                                          ),
                                        };
                                      }
                                      const paths = new Set(current.paths);
                                      if (paths.has(file.path)) paths.delete(file.path);
                                      else paths.add(file.path);
                                      return { mode: "paths", paths };
                                    });
                                  }}
                                />
                              )}
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
                                onClick={() => openChangedFileInEditor(file.path)}
                              >
                                <StartTruncatedPath
                                  path={file.path}
                                  className={`flex-1${isExcluded ? " text-muted-foreground" : ""}`}
                                />
                                <span className="shrink-0">
                                  {isExcluded ? (
                                    <span className="text-muted-foreground">Excluded</span>
                                  ) : (
                                    <>
                                      <span className="text-diff-addition">+{file.insertions}</span>
                                      <span className="text-muted-foreground"> / </span>
                                      <span className="text-diff-deletion">-{file.deletions}</span>
                                    </>
                                  )}
                                </span>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                    {allFiles.length > visibleFileCount ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="w-full"
                        onClick={() =>
                          setVisibleFileCount((count) => count + COMMIT_FILE_CHOOSER_WINDOW_SIZE)
                        }
                      >
                        Show{" "}
                        {Math.min(
                          COMMIT_FILE_CHOOSER_WINDOW_SIZE,
                          allFiles.length - visibleFileCount,
                        )}
                        more files
                      </Button>
                    ) : null}
                    <div className="flex justify-end font-mono">
                      <span className="text-diff-addition">
                        +{selectedFiles.reduce((sum, f) => sum + f.insertions, 0)}
                      </span>
                      <span className="text-muted-foreground"> / </span>
                      <span className="text-diff-deletion">
                        -{selectedFiles.reduce((sum, f) => sum + f.deletions, 0)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Commit message (optional)</p>
              <Textarea
                value={dialogCommitMessage}
                onChange={(event) => setDialogCommitMessage(event.target.value)}
                placeholder="Leave empty to auto-generate"
                size="sm"
              />
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setIsCommitDialogOpen(false);
                setDialogCommitMessage("");
                setSelection({ mode: "all" });
                setIsEditingFiles(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={noneSelected}
              onClick={runDialogActionOnNewBranch}
            >
              Commit on new branch
            </Button>
            <Button size="sm" disabled={noneSelected} onClick={runDialogAction}>
              Commit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={workflowInput !== null && isWorkflowInputCurrent}
        onOpenChange={(open) => {
          if (!open) setWorkflowInput(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Git workflow action</DialogTitle>
            <DialogDescription>
              {destructiveWorkflow
                ? `${destructiveWorkflow.description} ${workflowApproval}`
                : (workflowApproval ??
                  "Repository and source state are unavailable; reopen this action after status refreshes.")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {workflowMenuItems.find((item) => item.id === workflowInput?.id)?.label ??
                "Git workflow action"}
            </p>
            {workflowInput && workflowInputFields(workflowInput.id).has("refName") ? (
              <Input
                aria-label="Ref name"
                placeholder="Ref, branch, tag, or stash name"
                value={workflowInput?.refName ?? ""}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, refName: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("sourceRef") ? (
              <Input
                aria-label="Source ref"
                placeholder="Create from source ref (optional)"
                value={workflowInput.sourceRef}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, sourceRef: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("oldRefName") ? (
              <Input
                aria-label="Old ref name"
                placeholder="Existing branch name"
                value={workflowInput.oldRefName}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, oldRefName: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("targetRef") ? (
              <Input
                aria-label="Target ref"
                placeholder="Target or source ref"
                value={workflowInput?.targetRef ?? ""}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, targetRef: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("newRefName") ? (
              <Input
                aria-label="New ref name"
                placeholder="New name (rename/create)"
                value={workflowInput?.newRefName ?? ""}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, newRefName: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("remoteName") ? (
              <Input
                aria-label="Remote name"
                placeholder="Remote name"
                value={workflowInput?.remoteName ?? ""}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, remoteName: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("message") ? (
              <Input
                aria-label="Workflow message"
                placeholder="Message (stash/tag/amend)"
                value={workflowInput?.message ?? ""}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, message: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("paths") ? (
              <Textarea
                aria-label="Workflow paths"
                placeholder="Paths, one per line (discard/stash)"
                value={workflowInput?.paths ?? ""}
                onChange={(event) =>
                  setWorkflowInput((current) =>
                    current ? { ...current, paths: event.target.value } : current,
                  )
                }
              />
            ) : null}
            {workflowInput && workflowInputFields(workflowInput.id).has("strategy") ? (
              <label className="block space-y-1 text-xs">
                <span className="text-muted-foreground">Strategy</span>
                <select
                  aria-label="Workflow strategy"
                  className="h-8 w-full rounded border border-border bg-background px-2"
                  value={workflowInput?.strategy ?? "merge"}
                  onChange={(event) =>
                    setWorkflowInput((current) =>
                      current
                        ? {
                            ...current,
                            strategy: event.target.value as WorkflowInputState["strategy"],
                          }
                        : current,
                    )
                  }
                >
                  {workflowInput?.action === "reset" ? (
                    <>
                      <option value="merge">Merge reset (preserve local changes)</option>
                      <option value="hard">Hard reset (discard local changes)</option>
                    </>
                  ) : (
                    <>
                      <option value="merge">Merge</option>
                      <option value="rebase">Rebase</option>
                      <option value="ff-only">Fast-forward only</option>
                    </>
                  )}
                </select>
              </label>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWorkflowInput(null)}>
              Cancel
            </Button>
            <Button
              variant={destructiveWorkflow ? "destructive" : undefined}
              onClick={() => void executeWorkflowInput()}
            >
              {destructiveWorkflow?.confirmLabel ??
                (workflowInput?.action === "reset" && workflowInput.strategy === "hard"
                  ? "Confirm hard reset"
                  : "Run action")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={pendingPullRequestAction !== null && isPendingPullRequestActionCurrent}
        onOpenChange={(open) => {
          if (!open) setPendingPullRequestAction(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {pendingPullRequestAction?.action === "checkout"
                ? "Check out pull request"
                : pendingPullRequestAction?.action === "merge"
                  ? "Merge pull request"
                  : "Close pull request"}
            </DialogTitle>
            <DialogDescription>
              This action targets pull request #{pendingPullRequestAction?.reference.number} in{" "}
              {pendingPullRequestAction?.repositoryLabel} ({pendingPullRequestAction?.url}).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingPullRequestAction(null)}>
              Cancel
            </Button>
            <Button
              disabled={!isPendingPullRequestActionCurrent}
              onClick={() => void executePullRequestAction()}
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={stashOutput !== null}
        onOpenChange={(open) => {
          if (!open) setStashOutput(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Stashed changes</DialogTitle>
            <DialogDescription>
              Read-only output from <code>git stash list</code>.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
              {stashOutput}
            </pre>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setStashOutput(null)}>Close</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={worktreeInput !== null && isWorktreeInputCurrent}
        onOpenChange={(open) => {
          if (!open) setWorktreeInput(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Create worktree</DialogTitle>
            <DialogDescription>
              Environment{" "}
              {worktreeInput?.reviewedSourceScope.environmentId ?? "the selected environment"}.
              Repository {worktreeInput?.reviewedSourceScope.cwd ?? "the selected repository"}.
              Create a new branch and worktree from{" "}
              {worktreeInput?.reviewedSourceScope.sourceRef ?? "detached HEAD"}
              {worktreeInput?.reviewedSourceScope.sourceHead
                ? ` at ${worktreeInput.reviewedSourceScope.sourceHead}`
                : " (no commit yet)"}
              .
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <Input
              aria-label="Worktree ref"
              placeholder="Base ref"
              value={worktreeInput?.refName ?? ""}
              onChange={(event) =>
                setWorktreeInput((current) =>
                  current ? { ...current, refName: event.target.value } : current,
                )
              }
            />
            <Input
              aria-label="Worktree branch"
              placeholder="New branch name"
              value={worktreeInput?.newRefName ?? ""}
              onChange={(event) =>
                setWorktreeInput((current) =>
                  current ? { ...current, newRefName: event.target.value } : current,
                )
              }
            />
            <Input
              aria-label="Worktree base ref"
              placeholder="Merge-base ref (optional)"
              value={worktreeInput?.baseRefName ?? ""}
              onChange={(event) =>
                setWorktreeInput((current) =>
                  current ? { ...current, baseRefName: event.target.value } : current,
                )
              }
            />
            <Input
              aria-label="Worktree path"
              placeholder="Path (optional)"
              value={worktreeInput?.path ?? ""}
              onChange={(event) =>
                setWorktreeInput((current) =>
                  current ? { ...current, path: event.target.value } : current,
                )
              }
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWorktreeInput(null)}>
              Cancel
            </Button>
            <Button onClick={() => void executeWorktreeInput()}>Create worktree</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={
          pendingHeaderAction !== null &&
          currentHeaderActionScopeKey !== null &&
          headerActionScopeKey(pendingHeaderAction.scope) === currentHeaderActionScopeKey
        }
        onOpenChange={(open) => {
          if (!open) setPendingHeaderAction(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Confirm Git action</DialogTitle>
            <DialogDescription>
              {pendingHeaderAction
                ? sourceControlConfirmationDescription({
                    action: pendingHeaderAction.action,
                    repositoryRoot: pendingHeaderAction.scope.cwd,
                    branch: pendingHeaderAction.scope.sourceRef ?? "detached HEAD",
                    ...(headerConfirmationRemote ? { remoteName: headerConfirmationRemote } : {}),
                    ...(headerConfirmationRef ? { remoteRefName: headerConfirmationRef } : {}),
                    ...(headerConfirmationPullRemote
                      ? { pullRemoteName: headerConfirmationPullRemote }
                      : {}),
                    ...(headerConfirmationPullRef
                      ? { pullRefName: headerConfirmationPullRef }
                      : {}),
                  })
                : null}
              {pendingHeaderAction
                ? ` Environment ${pendingHeaderAction.scope.environmentId}; reviewed source ${pendingHeaderAction.scope.sourceRef ?? "detached HEAD"}${pendingHeaderAction.scope.sourceHead ? ` at ${pendingHeaderAction.scope.sourceHead}` : " (no commit yet)"}.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingHeaderAction(null)}>
              Cancel
            </Button>
            <Button onClick={() => void executePendingHeaderAction()}>Continue</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={isPendingGitConfirmationCurrent}
        onOpenChange={(open) => {
          if (!open) setPendingGitConfirmation(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Confirm Git action</DialogTitle>
            <DialogDescription>
              {pendingGitConfirmation?.input.action === "create_pr"
                ? `Repository ${pendingGitConfirmation.scope.cwd}, branch ${pendingGitConfirmation.scope.sourceRef ?? "detached HEAD"}: create a ${changeRequestTerminology.singular}${pendingGitConfirmation.scope.targetRemoteName ? ` for ${pendingGitConfirmation.scope.targetRemoteName}${pendingGitConfirmation.scope.targetRefName ? `/${pendingGitConfirmation.scope.targetRefName}` : ""}` : ""}.`
                : pendingGitConfirmation?.input.action === "commit_push_pr"
                  ? `Repository ${pendingGitConfirmation.scope.cwd}, branch ${pendingGitConfirmation.scope.sourceRef ?? "detached HEAD"}: commit, push, and create a ${changeRequestTerminology.singular}.`
                  : pendingGitConfirmation?.input.action === "commit_push"
                    ? `Repository ${pendingGitConfirmation.scope.cwd}, branch ${pendingGitConfirmation.scope.sourceRef ?? "detached HEAD"}: commit the changes and push to the configured remote.`
                    : `Repository ${pendingGitConfirmation?.scope.cwd ?? gitCwd ?? ""}, branch ${pendingGitConfirmation?.scope.sourceRef ?? "detached HEAD"}: push the current branch to the configured remote.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingGitConfirmation(null)}>
              Cancel
            </Button>
            <Button onClick={continuePendingGitConfirmation}>Continue</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <PublishRepositoryDialog
        open={isPublishDialogOpen && isPublishRepositoryScopeCurrent}
        onOpenChange={setPublishRepositoryDialogOpen}
        environmentId={publishRepositoryScope?.environmentId ?? null}
        threadRef={publishRepositoryScope?.threadRef ?? null}
        gitCwd={publishRepositoryScope?.cwd ?? ""}
        reviewedSourceRef={publishRepositoryScope?.sourceRef ?? null}
        reviewedSourceHead={publishRepositoryScope?.sourceHead ?? null}
        reviewedSourceIndexTree={publishRepositoryScope?.sourceIndexTree ?? null}
        currentSourceRef={currentRepositorySourceScope?.sourceRef ?? null}
        currentSourceHead={currentRepositorySourceScope?.sourceHead ?? null}
        currentSourceIndexTree={currentRepositorySourceScope?.sourceIndexTree ?? null}
      />

      <Dialog
        open={pendingDefaultBranchAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDefaultBranchAction(null);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {pendingDefaultBranchActionCopy?.title ?? "Run action on default branch?"}
            </DialogTitle>
            <DialogDescription>{pendingDefaultBranchActionCopy?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="dark:border-transparent dark:bg-transparent sm:flex-wrap sm:items-center">
            <Button
              className="w-full sm:mr-auto sm:w-auto"
              variant="outline"
              size="sm"
              onClick={() => setPendingDefaultBranchAction(null)}
            >
              Abort
            </Button>
            <Button
              className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
              variant="outline"
              size="sm"
              onClick={continuePendingDefaultBranchAction}
            >
              {pendingDefaultBranchActionCopy?.continueLabel ?? "Continue"}
            </Button>
            <Button
              className="min-h-8 w-full max-w-full whitespace-normal py-1.5 leading-snug sm:min-h-7 sm:w-auto"
              size="sm"
              onClick={checkoutFeatureBranchAndContinuePendingAction}
            >
              Check out feature branch & continue
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
