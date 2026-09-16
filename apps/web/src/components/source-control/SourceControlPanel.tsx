import type {
  EnvironmentId,
  ProjectId,
  PullRequestListInput,
  ScopedThreadRef,
  ThreadId,
  VcsStatusResult,
  VcsWorkingTreeFile,
  GitRepositoryDiscoveryResult,
  GitRepositoryCapabilities,
  GitCommitFilesResult,
  GitCommitGraphPageResult,
  GitActionOperation,
  GitActionContinuation,
} from "@t3tools/contracts";
import { GitBranchIcon, GitCommitIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefCallback } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironmentQuery } from "~/state/query";
import { sourceControlWorkspaceEnvironment } from "~/state/sourceControl";
import {
  chooseActiveRepository,
  isCurrentSourceControlRequest,
  readSourceControlComposerSessionDraft,
  sourceControlWorkspaceProgressAtom,
  sourceControlWorkspaceRevisionAtom,
  updateSourceControlComposerSessionDraft,
} from "@t3tools/client-runtime/state/sourceControlWorkspace";
import { usePullRequestList, type EnvironmentQueryTarget } from "~/state/pullRequests";
import type { ShortcutMatchContext } from "~/keybindings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { applyWorkingTreePage, type WorkingTreePageState } from "@t3tools/client-runtime/state/vcs";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PullRequestListGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestRow } from "../pullRequest/PullRequestRow";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import type { EnvironmentPullRequestEntry } from "../pullRequest/pullRequestList.logic";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Textarea } from "../ui/textarea";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildSourceControlCommitInput,
  buildSourceControlFileTree,
  canSubmitSourceControlCommit,
  fileAction,
  derivePrimarySourceControlAction,
  sourceControlGenerateDisabledReason,
  gitIndexWorkflowAvailability,
  gitMutationRejectionCode,
  groupWorkingTreeFiles,
  requiresAmendConfirmation,
  moveSourceControlTab,
  sourceControlFileStatusLabel,
  sourceControlComposerDraftKey,
  sourceControlConfirmationDescription,
  createBoundedGraphRefreshWindow,
  nextSourceControlView,
  sourceControlPanelTabs,
  type SourceControlFileView,
  type SourceControlPanelView,
} from "./sourceControlPanel.logic";
import { PublishRepositoryDialog } from "./PublishRepositoryDialog";
import {
  getSourceControlPresentation,
  type SourceControlPresentation,
} from "~/sourceControlPresentation";
import { openRepositoryComparison } from "~/secondaryPaneStore";
import { useRightPanelStore } from "~/rightPanelStore";
import SourceControlActions from "./SourceControlActions";
import { reviewedGitSnapshotAvailability } from "./sourceControlActions.logic";

const SOURCE_CONTROL_SHORTCUT_CONTEXT: ShortcutMatchContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
};

type ReviewedStatus = Pick<
  VcsStatusResult,
  "headCommit" | "indexTree" | "isDefaultRef" | "pendingMergeHeads" | "refName"
>;

/** The composer confirmation owns every source and destination it reviewed. */
type PrimaryActionScope = {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceRef: string | null;
  readonly sourceHead: string | null;
  readonly sourceIndexTree: string;
  readonly remoteName: string | null;
  readonly remoteRefName: string | null;
  readonly pullRemoteName: string | null;
  readonly pullRefName: string | null;
};

function primaryActionScopeKey(scope: PrimaryActionScope): string {
  return [
    scope.environmentId,
    scope.cwd,
    scope.sourceRef ?? "",
    scope.sourceHead ?? "",
    scope.sourceIndexTree ?? "",
    scope.remoteName ?? "",
    scope.remoteRefName ?? "",
    scope.pullRemoteName ?? "",
    scope.pullRefName ?? "",
  ].join("\0");
}

function primaryActionPrecondition(scope: PrimaryActionScope) {
  return {
    expectedHeadCommit: scope.sourceHead,
    expectedIndexTree: scope.sourceIndexTree,
    expectedRefName: scope.sourceRef,
  };
}

function firstDefined<T>(...values: ReadonlyArray<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined);
}

export interface SourceControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | null;
  readonly projectId: ProjectId | null;
  readonly envLocked: boolean;
  readonly view: SourceControlPanelView;
  readonly onViewChange: (view: SourceControlPanelView) => void;
  readonly supportsPullRequests: boolean;
  readonly pullRequestsCapabilityKnown: boolean;
  readonly gitIndexWorkflowCapabilityKnown: boolean;
  readonly supportsGitIndexWorkflow: boolean;
  readonly sourceControlWorkspaceCapabilityKnown?: boolean;
  readonly supportsSourceControlWorkspace?: boolean;
  readonly repositoryCapabilities?: GitRepositoryCapabilities;
  readonly writerAvailability?: { readonly ready: boolean; readonly reason: string | null };
  readonly providerPresentation?: SourceControlPresentation | null;
  readonly actionsTargetRef?: RefCallback<HTMLDivElement>;
}

function RepositoryGroupHeader(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly repository: GitRepositoryDiscoveryResult["repositories"][number];
  readonly projectRoot: string | null;
  readonly active: boolean;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const statusQuery = useEnvironmentQuery(
    sourceControlWorkspaceEnvironment.status({
      environmentId: props.environmentId,
      input: { cwd: props.repository.rootPath },
    }),
  );
  const refresh = useAtomCommand(sourceControlWorkspaceEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const relativePath =
    props.projectRoot && props.repository.rootPath.startsWith(`${props.projectRoot}/`)
      ? props.repository.rootPath.slice(props.projectRoot.length + 1)
      : ".";
  const displayName =
    props.repository.rootPath.split("/").filter(Boolean).at(-1) ?? props.repository.rootPath;
  const status = statusQuery.data;
  return (
    <div className="flex items-center gap-1 px-3 py-2 text-xs">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
        aria-expanded={!props.collapsed}
        onClick={props.onToggle}
      >
        <span className="min-w-0 truncate font-medium">{displayName}</span>
        {relativePath === "." ? null : (
          <span className="truncate text-muted-foreground">{relativePath}</span>
        )}
        <span className="shrink-0 text-muted-foreground">{status?.refName ?? "—"}</span>
        {status?.hasUpstream ? (
          <span className="shrink-0 text-muted-foreground">
            ↑{status.aheadCount} ↓{status.behindCount}
          </span>
        ) : null}
        {props.active ? <span className="shrink-0 text-muted-foreground">Active</span> : null}
      </button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Refresh ${displayName}`}
        onClick={() =>
          void refresh({
            environmentId: props.environmentId,
            input: { cwd: props.repository.rootPath },
          })
        }
      >
        <RefreshCwIcon className="size-3.5" />
      </Button>
      <div ref={setActionsTarget} className="shrink-0" data-source-control-actions-target />
      <SourceControlActions
        target={actionsTarget}
        gitCwd={props.repository.rootPath}
        activeThreadRef={props.threadRef}
      />
    </div>
  );
}

function failureMessage(result: { readonly cause: unknown }): string {
  const error = squashAtomCommandFailure(result as never);
  return error instanceof Error ? error.message : "The Git operation failed.";
}

function ChangesView(
  props: Pick<
    SourceControlPanelProps,
    | "environmentId"
    | "threadId"
    | "threadRef"
    | "cwd"
    | "envLocked"
    | "gitIndexWorkflowCapabilityKnown"
    | "supportsGitIndexWorkflow"
    | "repositoryCapabilities"
    | "writerAvailability"
  >,
) {
  const statusQuery = useEnvironmentQuery(
    props.cwd === null
      ? null
      : sourceControlWorkspaceEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: props.cwd },
        }),
  );
  const status = statusQuery.data;
  const reviewedSnapshot = useMemo(
    () =>
      reviewedGitSnapshotAvailability({
        status,
        isPending: statusQuery.isPending,
        hasError: statusQuery.error !== null,
      }),
    [status, statusQuery.error, statusQuery.isPending],
  );
  const availability = gitIndexWorkflowAvailability(
    props.repositoryCapabilities === undefined ? props.gitIndexWorkflowCapabilityKnown : true,
    props.repositoryCapabilities?.supportsIndexWorkflow ?? props.supportsGitIndexWorkflow,
  );
  const stage = useAtomCommand(sourceControlWorkspaceEnvironment.stageFiles, {
    reportFailure: false,
  });
  const unstage = useAtomCommand(sourceControlWorkspaceEnvironment.unstageFiles, {
    reportFailure: false,
  });
  const getWorkingTreeDiff = useAtomCommand(sourceControlWorkspaceEnvironment.getWorkingTreeDiff, {
    reportFailure: false,
  });
  const commit = useAtomCommand(sourceControlWorkspaceEnvironment.commitIndex, {
    reportFailure: false,
  });
  const runAction = useAtomCommand(sourceControlWorkspaceEnvironment.runAction, {
    reportFailure: false,
  });
  const dismissProgress = useAtomCommand(sourceControlWorkspaceEnvironment.dismissProgress, {
    reportFailure: false,
  });
  const generateCommitMessage = useAtomCommand(
    sourceControlWorkspaceEnvironment.generateCommitMessage,
    { reportFailure: false },
  );
  const refresh = useAtomCommand(sourceControlWorkspaceEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const init = useAtomCommand(sourceControlWorkspaceEnvironment.init, { reportFailure: false });
  const loadWorkingTreePage = useAtomCommand(sourceControlWorkspaceEnvironment.workingTreePage, {
    reportFailure: false,
  });
  const composerDraftStorageKey = `t3code:source-control-composer:v2:${props.threadRef.environmentId}:${props.threadRef.threadId}`;
  const legacyComposerDraftStorageKey = `t3code:source-control-composer:v1:${props.threadRef.environmentId}:${props.threadRef.threadId}`;
  const repositoryDraftScope = sourceControlComposerDraftKey(
    props.environmentId,
    props.threadRef.threadId,
    props.cwd ?? "",
  );
  type ComposerDraft = {
    message: string;
    instructions: string;
    action: "commit" | "amend" | "commit_push" | "commit_sync";
  };
  const readPersistedMessage = (): string => {
    if (typeof window === "undefined") return "";
    try {
      const persisted = JSON.parse(
        window.localStorage.getItem(composerDraftStorageKey) ?? "{}",
      ) as unknown;
      if (persisted && typeof persisted === "object") {
        const message = (persisted as Record<string, unknown>)[repositoryDraftScope];
        if (typeof message === "string") return message;
      }
      // Keep recoverable message drafts from the old format, but deliberately
      // discard its transient instructions and selected action on a fresh app session.
      const legacy = JSON.parse(
        window.localStorage.getItem(legacyComposerDraftStorageKey) ?? "{}",
      ) as unknown;
      const legacyDraft =
        legacy && typeof legacy === "object"
          ? (legacy as Record<string, { readonly message?: unknown }>)[repositoryDraftScope]
          : undefined;
      return typeof legacyDraft?.message === "string" ? legacyDraft.message : "";
    } catch {
      return "";
    }
  };
  const initialComposerDraft = readSourceControlComposerSessionDraft(repositoryDraftScope);
  const [message, setMessage] = useState(initialComposerDraft?.message ?? readPersistedMessage());
  const [generationInstructions, setGenerationInstructions] = useState(
    initialComposerDraft?.instructions ?? "",
  );
  const [replaceGenerationPrompt, setReplaceGenerationPrompt] = useState(false);
  const [generationOpen, setGenerationOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const generationRequestId = useRef(0);
  const generationScope = `${props.environmentId}\0${props.threadId}\0${props.cwd ?? ""}`;
  const generationScopeRef = useRef(generationScope);
  generationScopeRef.current = generationScope;
  const messageRef = useRef(message);
  messageRef.current = message;
  const [selectedCommitAction, setSelectedCommitAction] = useState<
    "commit" | "amend" | "commit_push" | "commit_sync"
  >(
    initialComposerDraft?.action === "commit-push"
      ? "commit_push"
      : initialComposerDraft?.action === "commit-sync"
        ? "commit_sync"
        : (initialComposerDraft?.action ?? "commit"),
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingPrimaryAction, setPendingPrimaryAction] = useState<
    | "push"
    | "sync"
    | "publish"
    | "publish-repository"
    | "commit_push"
    | "commit_sync"
    | "commit_publish"
    | null
  >(null);
  const [pendingActionScope, setPendingActionScope] = useState<PrimaryActionScope | null>(null);
  const [publishRepositoryOpen, setPublishRepositoryOpen] = useState(false);
  const [publishRepositorySource, setPublishRepositorySource] = useState<{
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly ref: string | null;
    readonly head: string | null;
    readonly indexTree: string;
  } | null>(null);
  const [initConfirmationScope, setInitConfirmationScope] = useState<{
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
  } | null>(null);
  const [pendingContinuation, setPendingContinuation] = useState<GitActionContinuation | null>(
    null,
  );
  const pendingScope = `${props.environmentId}\0${props.cwd ?? ""}`;
  const currentPrimaryActionScope: PrimaryActionScope | null =
    props.cwd === null ||
    !reviewedSnapshot.available ||
    status === null ||
    status === undefined ||
    // The shared availability predicate is the behavioral gate. Repeat these
    // checks only to narrow optional protocol fields for TypeScript.
    status.refName === undefined ||
    status.headCommit === undefined ||
    status.indexTree === undefined
      ? null
      : {
          environmentId: props.environmentId,
          cwd: props.cwd,
          sourceRef: status.refName,
          sourceHead: status.headCommit,
          sourceIndexTree: status.indexTree,
          remoteName: status.remoteName ?? null,
          remoteRefName: status.remoteRefName ?? null,
          pullRemoteName: status.pullRemoteName ?? null,
          pullRefName: status.pullRefName ?? null,
        };
  const currentPrimaryActionScopeKey = currentPrimaryActionScope
    ? primaryActionScopeKey(currentPrimaryActionScope)
    : null;
  const currentPublishRepositorySource = currentPrimaryActionScope
    ? {
        environmentId: currentPrimaryActionScope.environmentId,
        cwd: currentPrimaryActionScope.cwd,
        ref: currentPrimaryActionScope.sourceRef,
        head: currentPrimaryActionScope.sourceHead,
        indexTree: currentPrimaryActionScope.sourceIndexTree,
      }
    : null;
  const isPublishRepositorySourceCurrent =
    publishRepositorySource !== null &&
    currentPublishRepositorySource !== null &&
    publishRepositorySource.environmentId === currentPublishRepositorySource.environmentId &&
    publishRepositorySource.cwd === currentPublishRepositorySource.cwd &&
    publishRepositorySource.ref === currentPublishRepositorySource.ref &&
    publishRepositorySource.head === currentPublishRepositorySource.head &&
    publishRepositorySource.indexTree === currentPublishRepositorySource.indexTree;
  const openPublishRepositoryDialog = useCallback(() => {
    if (currentPrimaryActionScope === null) return;
    setPublishRepositorySource({
      environmentId: currentPrimaryActionScope.environmentId,
      cwd: currentPrimaryActionScope.cwd,
      ref: currentPrimaryActionScope.sourceRef,
      head: currentPrimaryActionScope.sourceHead,
      indexTree: currentPrimaryActionScope.sourceIndexTree,
    });
    setPublishRepositoryOpen(true);
  }, [currentPrimaryActionScope]);
  const setPublishRepositoryDialogOpen = useCallback((open: boolean) => {
    setPublishRepositoryOpen(open);
    if (!open) setPublishRepositorySource(null);
  }, []);
  useEffect(() => {
    if (publishRepositoryOpen && !isPublishRepositorySourceCurrent) {
      setPublishRepositoryOpen(false);
      setPublishRepositorySource(null);
    }
  }, [isPublishRepositorySourceCurrent, publishRepositoryOpen]);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [workingTreePages, setWorkingTreePages] = useState<WorkingTreePageState>(() => ({
    snapshotId: status?.workingTree.snapshotId ?? null,
    files: status?.workingTree.files ?? [],
    nextCursor: status?.workingTree.nextCursor ?? null,
    requestId: 0,
  }));
  const [pageError, setPageError] = useState<string | null>(null);
  const [fileView, setFileView] = useState<SourceControlFileView>({ tree: false, sort: "path" });
  const persistMessage = useCallback(
    (value: string) => {
      if (typeof window === "undefined") return;
      let drafts: Record<string, string> = {};
      try {
        const parsed: unknown = JSON.parse(
          window.localStorage.getItem(composerDraftStorageKey) ?? "{}",
        );
        if (parsed && typeof parsed === "object") drafts = parsed as Record<string, string>;
      } catch {
        // A malformed draft must not stop the composer from accepting a new message.
      }
      drafts[repositoryDraftScope] = value;
      window.localStorage.setItem(composerDraftStorageKey, JSON.stringify(drafts));
    },
    [composerDraftStorageKey, repositoryDraftScope],
  );
  const sessionAction = (action: ComposerDraft["action"]) =>
    action === "commit_push" ? "commit-push" : action === "commit_sync" ? "commit-sync" : action;
  const updateMessage = useCallback(
    (value: string) => {
      setMessage(value);
      persistMessage(value);
      updateSourceControlComposerSessionDraft(repositoryDraftScope, {
        message: value,
        instructions: generationInstructions,
        action: sessionAction(selectedCommitAction),
      });
    },
    [generationInstructions, persistMessage, repositoryDraftScope, selectedCommitAction],
  );
  const updateGenerationInstructions = useCallback(
    (value: string) => {
      setGenerationInstructions(value);
      updateSourceControlComposerSessionDraft(repositoryDraftScope, {
        message,
        instructions: value,
        action: sessionAction(selectedCommitAction),
      });
    },
    [message, repositoryDraftScope, selectedCommitAction],
  );
  const updateSelectedCommitAction = useCallback(
    (value: ComposerDraft["action"]) => {
      setSelectedCommitAction(value);
      updateSourceControlComposerSessionDraft(repositoryDraftScope, {
        message,
        instructions: generationInstructions,
        action: sessionAction(value),
      });
    },
    [generationInstructions, message, repositoryDraftScope],
  );
  const [initializing, setInitializing] = useState(false);
  const [reviewedStatus, setReviewedStatus] = useState<{
    readonly scope: string;
    readonly status: ReviewedStatus;
  } | null>(null);
  const [review, setReview] = useState<{
    readonly comparison: "head" | "index" | "worktree-index";
    readonly diff: string | null;
    readonly label: string;
    readonly path: string;
    readonly truncated: boolean;
  } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [defaultRefConfirmationOpen, setDefaultRefConfirmationOpen] = useState(false);
  const reviewRequestId = useRef(0);
  const reviewScope = `${props.environmentId}\0${props.threadId}\0${props.cwd ?? ""}`;
  const reviewScopeRef = useRef(reviewScope);
  reviewScopeRef.current = reviewScope;
  const activeReviewedStatus = reviewedStatus?.scope === reviewScope ? reviewedStatus.status : null;
  const pageRequestId = useRef(0);
  const files = workingTreePages.files;
  useEffect(() => {
    const onViewChange = (event: Event) => {
      const action = (event as CustomEvent<unknown>).detail;
      if (
        action !== "view-tree" &&
        action !== "view-list" &&
        action !== "view-sort" &&
        action !== "view-sort-path" &&
        action !== "view-sort-name" &&
        action !== "view-sort-status"
      )
        return;
      setFileView((current) => nextSourceControlView(current, action));
    };
    window.addEventListener("t3code:source-control-view", onViewChange);
    return () => window.removeEventListener("t3code:source-control-view", onViewChange);
  }, []);
  const fileGroups = useMemo(
    () =>
      groupWorkingTreeFiles(files).map((group) => {
        const compareFiles = (a: (typeof group.files)[number], b: (typeof group.files)[number]) => {
          if (fileView.sort === "status" && a.indexStatus !== b.indexStatus) {
            return (a.indexStatus ?? "unknown").localeCompare(b.indexStatus ?? "unknown");
          }
          if (fileView.sort === "name") {
            const byName = (a.path.split("/").at(-1) ?? a.path).localeCompare(
              b.path.split("/").at(-1) ?? b.path,
            );
            if (byName !== 0) return byName;
          }
          return a.path.localeCompare(b.path);
        };
        const sortedFiles = [...group.files].sort(compareFiles);
        return {
          ...group,
          files: sortedFiles,
          nodes: fileView.tree ? buildSourceControlFileTree(sortedFiles, compareFiles) : null,
        };
      }),
    [fileView.sort, fileView.tree, files],
  );
  const workflowAvailable = availability === "available";
  const authoritativeWorkingTreeCount = status?.workingTree.totalCount ?? files.length;
  const authoritativeStagedCount =
    status?.workingTree.stagedCount ??
    files.filter((file) => file.indexStatus === "staged" || file.indexStatus === "both").length;
  const hasPendingMerge = (status?.pendingMergeHeads?.length ?? 0) > 0;
  const workspaceProgress = useAtomValue(
    sourceControlWorkspaceProgressAtom({
      environmentId: props.environmentId,
      repositoryRoot: props.cwd ?? "",
    }),
  );
  const continuation = workspaceProgress.continuation
    ? {
        value: workspaceProgress.continuation,
        ...(workspaceProgress.commitSha ? { commitSha: workspaceProgress.commitSha } : {}),
      }
    : null;
  const confirmationRemote = pendingContinuation?.remoteName ?? pendingActionScope?.remoteName;
  const confirmationRemoteRef = pendingContinuation?.refName ?? pendingActionScope?.remoteRefName;
  const confirmationPullRemote =
    pendingContinuation?.pullRemoteName ?? pendingActionScope?.pullRemoteName;
  const confirmationPullRef = pendingContinuation?.pullRefName ?? pendingActionScope?.pullRefName;
  const writerAvailability = props.writerAvailability ?? { ready: true, reason: null };
  const generateDisabledReason = sourceControlGenerateDisabledReason({
    stagedCount: authoritativeStagedCount,
    generating,
    writer: writerAvailability,
  });
  const instructionGenerateDisabledReason = sourceControlGenerateDisabledReason({
    stagedCount: authoritativeStagedCount,
    generating,
    writer: writerAvailability,
    instructionsRequired: true,
    hasInstructions: generationInstructions.trim().length > 0,
  });
  const primaryAction = derivePrimarySourceControlAction({
    selectedAction:
      selectedCommitAction === "commit_push"
        ? "commit-push"
        : selectedCommitAction === "commit_sync"
          ? "commit-sync"
          : selectedCommitAction,
    stagedCount: authoritativeStagedCount,
    aheadCount: status?.aheadCount ?? 0,
    behindCount: status?.behindCount ?? 0,
    hasPrimaryRemote: status?.hasPrimaryRemote ?? false,
    hasUpstream: status?.hasUpstream ?? false,
    ...(status?.commitIdentityReady !== undefined
      ? { commitIdentityReady: status.commitIdentityReady }
      : {}),
    ...(status?.remoteCredentialReady !== undefined
      ? {
          remoteCredentialReady: status.remoteCredentialReady,
          ...(status.remoteCredentialReason
            ? { remoteCredentialReason: status.remoteCredentialReason }
            : {}),
        }
      : {}),
    refName: status?.refName,
    activeConflictOperation: status?.activeConflictOperation,
    statusFresh: reviewedSnapshot.available,
    ...(!reviewedSnapshot.available ? { statusFreshReason: reviewedSnapshot.reason } : {}),
    busy: workspaceProgress.isRunning,
  });
  const primaryPublicationAction = ["push", "publish", "publish-repository"].includes(
    primaryAction.action,
  )
    ? (primaryAction.action as "push" | "publish" | "publish-repository")
    : null;
  const reviewedCommitReady = canSubmitSourceControlCommit({
    workflowAvailable,
    stagedCount: authoritativeStagedCount,
    message,
    reviewedStateAvailable:
      reviewedSnapshot.available &&
      activeReviewedStatus?.headCommit !== undefined &&
      activeReviewedStatus?.indexTree !== undefined,
    hasReviewedBranch:
      activeReviewedStatus?.refName !== null && activeReviewedStatus?.refName !== undefined,
    hasReviewedMerge: hasPendingMerge && activeReviewedStatus?.pendingMergeHeads?.length !== 0,
  });
  const stagedPaths = useMemo(
    () =>
      files
        .filter((file) => file.indexStatus === "staged" || file.indexStatus === "both")
        .map((file) => file.path),
    [files],
  );

  useEffect(() => {
    pageRequestId.current += 1;
    const requestId = pageRequestId.current;
    const snapshotId = status?.workingTree.snapshotId ?? null;
    setPageError(null);
    setWorkingTreePages({
      snapshotId,
      files: status?.workingTree.files ?? [],
      nextCursor: status?.workingTree.nextCursor ?? null,
      requestId,
    });
  }, [status?.workingTree.files, status?.workingTree.nextCursor, status?.workingTree.snapshotId]);

  useEffect(() => {
    generationRequestId.current += 1;
    setGenerating(false);
    const draft = readSourceControlComposerSessionDraft(repositoryDraftScope);
    const action =
      draft?.action === "commit-push"
        ? "commit_push"
        : draft?.action === "commit-sync"
          ? "commit_sync"
          : (draft?.action ?? "commit");
    const restoredMessage = draft?.message ?? readPersistedMessage();
    setMessage(restoredMessage);
    setGenerationInstructions(draft?.instructions ?? "");
    setSelectedCommitAction(action);
    updateSourceControlComposerSessionDraft(repositoryDraftScope, {
      message: restoredMessage,
      instructions: draft?.instructions ?? "",
      action: draft?.action ?? "commit",
    });
    setReplaceGenerationPrompt(false);
    setGenerationOpen(false);
  }, [generationScope, repositoryDraftScope]);

  useEffect(
    () => () => {
      reviewRequestId.current += 1;
    },
    [],
  );

  useEffect(() => {
    reviewRequestId.current += 1;
    setDefaultRefConfirmationOpen(false);
    setError(null);
    setPendingPath(null);
    setReview(null);
    setReviewError(null);
    setReviewedStatus(null);
    setPendingPrimaryAction(null);
    setPendingContinuation(null);
    setPendingActionScope(null);
  }, [reviewScope]);

  const refreshStatus = useCallback(async () => {
    if (props.cwd === null) return;
    const result = await refresh({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setError(failureMessage(result));
  }, [props.cwd, props.environmentId, refresh]);
  const generate = useCallback(async () => {
    if (props.cwd === null || authoritativeStagedCount === 0 || generating) return;
    const requestId = generationRequestId.current + 1;
    generationRequestId.current = requestId;
    const requestScope = generationScope;
    const requestMessage = message;
    setGenerating(true);
    const result = await generateCommitMessage({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        // A paged status can omit staged rows that have not been loaded yet. Let the server use
        // the complete index in that case instead of silently generating from a partial page.
        ...(stagedPaths.length === authoritativeStagedCount ? { paths: stagedPaths } : {}),
        ...(generationInstructions.trim()
          ? {
              instructions: generationInstructions,
              replacePrompt: replaceGenerationPrompt,
            }
          : {}),
      },
    });
    setGenerating(false);
    if (
      requestId !== generationRequestId.current ||
      requestScope !== generationScopeRef.current ||
      requestMessage !== messageRef.current
    ) {
      return;
    }
    if (result._tag === "Success") {
      updateMessage(result.value.message);
      setGenerationOpen(false);
    } else if (!isAtomCommandInterrupted(result)) {
      setError(failureMessage(result));
    }
  }, [
    generating,
    generateCommitMessage,
    generationInstructions,
    generationScope,
    updateMessage,
    message,
    props.cwd,
    props.environmentId,
    replaceGenerationPrompt,
    authoritativeStagedCount,
    stagedPaths,
  ]);
  useEffect(() => {
    setInitConfirmationScope((current) =>
      current && `${current.environmentId}\0${current.cwd}` !== pendingScope ? null : current,
    );
  }, [pendingScope]);
  useEffect(() => {
    if (
      pendingActionScope !== null &&
      (currentPrimaryActionScopeKey === null ||
        primaryActionScopeKey(pendingActionScope) !== currentPrimaryActionScopeKey)
    ) {
      setPendingPrimaryAction(null);
      setPendingActionScope(null);
      setPendingContinuation(null);
    }
  }, [currentPrimaryActionScopeKey, pendingActionScope]);
  const initializeRepository = useCallback(
    async (
      target: { readonly environmentId: EnvironmentId; readonly cwd: string },
      confirmation: "approved" | undefined,
    ) => {
      if (target.environmentId !== props.environmentId || target.cwd !== props.cwd) return;
      setError(null);
      setInitializing(true);
      const result = await init({
        environmentId: target.environmentId,
        input: { cwd: target.cwd, ...(confirmation ? { confirmation } : {}) },
      });
      setInitializing(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setError(failureMessage(result));
        return;
      }
      if (result._tag === "Success") void refreshStatus();
    },
    [init, props.cwd, props.environmentId, refreshStatus],
  );
  const loadMore = useCallback(async () => {
    if (
      props.cwd === null ||
      workingTreePages.snapshotId === null ||
      workingTreePages.nextCursor === null
    )
      return;
    const requestId = pageRequestId.current + 1;
    pageRequestId.current = requestId;
    setPageError(null);
    const result = await loadWorkingTreePage({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        snapshotId: workingTreePages.snapshotId,
        cursor: workingTreePages.nextCursor,
      },
    });
    if (isAtomCommandInterrupted(result)) return;
    if (result._tag === "Failure") {
      if (requestId === pageRequestId.current) setPageError(failureMessage(result));
      return;
    }
    setWorkingTreePages((current) =>
      applyWorkingTreePage(current, result.value, requestId, "append"),
    );
  }, [loadWorkingTreePage, props.cwd, props.environmentId, workingTreePages]);
  const mutateFile = useCallback(
    async (file: VcsWorkingTreeFile, kind: "stage" | "unstage") => {
      if (props.cwd === null || !workflowAvailable) return;
      setPendingPath(file.path);
      setError(null);
      reviewRequestId.current += 1;
      setReview(null);
      setReviewError(null);
      setReviewedStatus(null);
      const result = await (kind === "stage" ? stage : unstage)({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, paths: [file.path] },
      });
      setPendingPath(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        setError(failureMessage(result));
    },
    [props.cwd, props.environmentId, stage, unstage, workflowAvailable],
  );
  const reviewFile = useCallback(
    async (file: VcsWorkingTreeFile | null, comparison: "head" | "index" | "worktree-index") => {
      if (props.cwd === null || status === null || !workflowAvailable) return;
      const requestScope = reviewScope;
      const capturedStatus = {
        headCommit: status.headCommit,
        indexTree: status.indexTree,
        isDefaultRef: status.isDefaultRef,
        pendingMergeHeads: status.pendingMergeHeads,
        refName: status.refName,
      };
      const reviewLabel =
        comparison === "index" && file === null
          ? "pending merge vs HEAD"
          : comparison === "index"
            ? "staged vs HEAD"
            : comparison === "worktree-index" && file?.indexStatus === "untracked"
              ? "untracked vs empty"
              : comparison === "worktree-index"
                ? "working tree vs index"
                : "working tree vs HEAD";
      const requestId = reviewRequestId.current + 1;
      reviewRequestId.current = requestId;
      setReviewedStatus(null);
      setReview({
        comparison,
        diff: null,
        label: reviewLabel,
        path: file?.path ?? "Pending merge",
        truncated: false,
      });
      setReviewError(null);
      const comparisonOldPath =
        comparison === "index"
          ? (firstDefined(file?.indexOldPath, file?.oldPath, file?.path) ?? null)
          : (firstDefined(file?.worktreeOldPath, file?.oldPath, file?.path) ?? null);
      const comparisonNewPath =
        comparison === "index"
          ? (firstDefined(file?.indexNewPath, file?.newPath, file?.path) ?? null)
          : (firstDefined(file?.worktreeNewPath, file?.newPath, file?.path) ?? null);
      openRepositoryComparison(props.threadRef, {
        repositoryRoot: props.cwd,
        comparison: comparison === "index" ? "index" : "working-tree",
        // Status carries the Git path sides. `null` is intentional for an
        // add/delete and must not be rewritten to the display path.
        oldPath: comparisonOldPath,
        newPath: comparisonNewPath,
        // Capture the actual HEAD/index identity while the aggregate list is
        // still authoritative.  The secondary tab never re-derives this from
        // a later status response.
        ...((comparison === "worktree-index"
          ? capturedStatus.indexTree
          : capturedStatus.headCommit) !== undefined
          ? {
              baseRevision:
                comparison === "worktree-index"
                  ? capturedStatus.indexTree
                  : capturedStatus.headCommit,
            }
          : {}),
        ...(comparison === "index" && capturedStatus.indexTree !== undefined
          ? { headRevision: capturedStatus.indexTree }
          : {}),
        ...(comparison === "index" && capturedStatus.indexTree
          ? { indexTree: capturedStatus.indexTree }
          : {}),
        snapshotId: status.workingTree.snapshotId ?? null,
        liveBase: comparison === "worktree-index" ? "index" : "head",
      });
      const result = await getWorkingTreeDiff({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          ...(file ? { path: file.path } : {}),
          comparison,
          ...(comparison === "index" &&
          capturedStatus.headCommit !== undefined &&
          capturedStatus.indexTree !== undefined
            ? {
                reviewedState: {
                  headCommit: capturedStatus.headCommit,
                  indexTree: capturedStatus.indexTree,
                },
              }
            : {}),
        },
      });
      if (
        requestId !== reviewRequestId.current ||
        requestScope !== reviewScopeRef.current ||
        isAtomCommandInterrupted(result)
      )
        return;
      if (result._tag === "Failure") {
        setReviewError(failureMessage(result));
        return;
      }
      if (comparison === "index")
        setReviewedStatus({ scope: requestScope, status: capturedStatus });
      setReview({
        comparison,
        diff: result.value.diff,
        label: reviewLabel,
        path: file?.path ?? "Pending merge",
        truncated: result.value.truncated,
      });
    },
    [getWorkingTreeDiff, props.cwd, props.environmentId, reviewScope, status, workflowAvailable],
  );
  const cancelReview = useCallback(() => {
    reviewRequestId.current += 1;
    setReview(null);
    setReviewError(null);
    setReviewedStatus(null);
  }, []);
  const reviewPendingMerge = useCallback(() => {
    void reviewFile(null, "index");
  }, [reviewFile]);
  useEffect(() => {
    if (activeReviewedStatus === null || status === null) return;
    if (
      activeReviewedStatus.headCommit !== status.headCommit ||
      activeReviewedStatus.indexTree !== status.indexTree ||
      activeReviewedStatus.refName !== status.refName ||
      JSON.stringify(activeReviewedStatus.pendingMergeHeads ?? []) !==
        JSON.stringify(status.pendingMergeHeads ?? [])
    ) {
      cancelReview();
    }
  }, [activeReviewedStatus, cancelReview, status]);
  const submit = useCallback(
    async (confirmDefaultRef: boolean, amendCommit = false) => {
      if (!reviewedSnapshot.available) return false;
      // Message-only amend has no staged diff to review. Its confirmation still
      // protects the current HEAD/index snapshot, so use the current status only
      // for that explicit amend path.
      const commitReviewStatus = amendCommit
        ? (activeReviewedStatus ??
          (status
            ? {
                headCommit: status.headCommit,
                indexTree: status.indexTree,
                isDefaultRef: status.isDefaultRef,
                pendingMergeHeads: status.pendingMergeHeads,
                refName: status.refName,
              }
            : null))
        : activeReviewedStatus;
      if (
        props.cwd === null ||
        commitReviewStatus === null ||
        (amendCommit
          ? !workflowAvailable ||
            commitReviewStatus.headCommit === undefined ||
            commitReviewStatus.headCommit === null ||
            commitReviewStatus.indexTree === undefined ||
            commitReviewStatus.refName === null ||
            commitReviewStatus.refName === undefined
          : !canSubmitSourceControlCommit({
              workflowAvailable,
              stagedCount: authoritativeStagedCount,
              message,
              reviewedStateAvailable:
                commitReviewStatus.headCommit !== undefined &&
                commitReviewStatus.indexTree !== undefined,
              hasReviewedBranch:
                commitReviewStatus.refName !== null && commitReviewStatus.refName !== undefined,
              hasReviewedMerge:
                hasPendingMerge && commitReviewStatus.pendingMergeHeads?.length !== 0,
            }))
      )
        return false;
      if (requiresAmendConfirmation(amendCommit) && !confirmDefaultRef) {
        setDefaultRefConfirmationOpen(true);
        return false;
      }
      setError(null);
      const result = await commit({
        environmentId: props.environmentId,
        input: {
          ...buildSourceControlCommitInput({
            cwd: props.cwd,
            message,
            headCommit: commitReviewStatus.headCommit,
            indexTree: commitReviewStatus.indexTree,
            refName: commitReviewStatus.refName,
            pendingMergeHeads: commitReviewStatus.pendingMergeHeads,
            confirmDefaultRef,
            amend: amendCommit,
          }),
          ...(amendCommit ? { confirmation: "approved" as const } : {}),
        },
      });
      if (result._tag === "Success") {
        updateMessage("");
        setDefaultRefConfirmationOpen(false);
        cancelReview();
        setReviewedStatus(null);
        return true;
      }
      if (isAtomCommandInterrupted(result)) return false;
      setError(
        gitMutationRejectionCode(result.cause) === "stale_git_state"
          ? "Repository changed; review the staged changes and try again."
          : failureMessage(result),
      );
      if (gitMutationRejectionCode(result.cause) === "stale_git_state") {
        setDefaultRefConfirmationOpen(false);
        cancelReview();
        setReviewedStatus(null);
        void refreshStatus();
      }
      return false;
    },
    [
      cancelReview,
      commit,
      files,
      message,
      props.cwd,
      props.environmentId,
      refreshStatus,
      activeReviewedStatus,
      status,
      authoritativeStagedCount,
      hasPendingMerge,
      workflowAvailable,
      reviewedSnapshot.available,
    ],
  );

  const executePendingPrimaryAction = useCallback(async () => {
    const pending = pendingPrimaryAction;
    const approval = pendingActionScope;
    if (
      pending === null ||
      approval === null ||
      currentPrimaryActionScopeKey === null ||
      primaryActionScopeKey(approval) !== currentPrimaryActionScopeKey
    )
      return;
    setPendingPrimaryAction(null);
    setPendingActionScope(null);
    if (pending === "publish-repository") {
      openPublishRepositoryDialog();
      return;
    }
    const isCompound =
      pending === "commit_push" || pending === "commit_sync" || pending === "commit_publish";
    const remoteName = pendingContinuation?.remoteName ?? approval.remoteName;
    const remoteRefName = pendingContinuation?.refName ?? approval.remoteRefName;
    const pullRemoteName = pendingContinuation?.pullRemoteName ?? approval.pullRemoteName;
    const pullRefName = pendingContinuation?.pullRefName ?? approval.pullRefName;
    if (
      isCompound &&
      (activeReviewedStatus === null ||
        !canSubmitSourceControlCommit({
          workflowAvailable,
          stagedCount: authoritativeStagedCount,
          message,
          reviewedStateAvailable:
            activeReviewedStatus.headCommit !== undefined &&
            activeReviewedStatus.indexTree !== undefined,
          hasReviewedBranch:
            activeReviewedStatus.refName !== null && activeReviewedStatus.refName !== undefined,
          hasReviewedMerge: hasPendingMerge && activeReviewedStatus.pendingMergeHeads?.length !== 0,
        }))
    ) {
      return;
    }
    const action: GitActionOperation = isCompound ? "commit" : pending;
    const compoundCommitInput = isCompound
      ? buildSourceControlCommitInput({
          cwd: approval.cwd,
          message,
          headCommit: activeReviewedStatus?.headCommit,
          indexTree: activeReviewedStatus?.indexTree,
          refName: activeReviewedStatus?.refName,
          pendingMergeHeads: activeReviewedStatus?.pendingMergeHeads,
          confirmDefaultRef: false,
        })
      : null;
    const actionInput =
      compoundCommitInput === null
        ? {
            cwd: approval.cwd,
            action,
            confirm: true,
            ...(remoteName ? { remoteName } : {}),
            ...(remoteRefName ? { refName: remoteRefName } : {}),
            ...(pendingContinuation?.sourceRef ? { sourceRef: pendingContinuation.sourceRef } : {}),
            precondition: primaryActionPrecondition(approval),
            ...(pullRemoteName ? { pullRemoteName } : {}),
            ...(pullRefName ? { pullRefName } : {}),
            ...(pendingContinuation?.strategy ? { strategy: pendingContinuation.strategy } : {}),
          }
        : {
            cwd: approval.cwd,
            action: "commit" as const,
            confirm: true,
            message,
            compoundOperation:
              pending === "commit_push"
                ? ("commit-push" as const)
                : pending === "commit_publish"
                  ? ("commit-publish" as const)
                  : ("commit-sync" as const),
            ...(approval.remoteName ? { remoteName: approval.remoteName } : {}),
            ...(approval.remoteRefName ? { refName: approval.remoteRefName } : {}),
            ...(approval.pullRemoteName ? { pullRemoteName: approval.pullRemoteName } : {}),
            ...(approval.pullRefName ? { pullRefName: approval.pullRefName } : {}),
            ...(compoundCommitInput.precondition
              ? { precondition: compoundCommitInput.precondition }
              : {}),
          };
    const result = await runAction({
      environmentId: props.environmentId,
      input: actionInput,
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(
        pending === "commit_push" || pending === "commit_sync"
          ? failureMessage(result)
          : failureMessage(result),
      );
      void refreshStatus();
    } else if (result._tag === "Success") {
      void refreshStatus();
      if (isCompound && result.value.completed.includes("commit")) {
        updateMessage("");
        cancelReview();
        setReviewedStatus(null);
      }
      if (result.value.failedStep) {
        setPendingContinuation(result.value.continuation ?? null);
        setError(
          `${result.value.completed.length > 0 ? `${result.value.completed.join(" then ")} completed, but ` : ""}${result.value.failedStep} failed.${result.value.failureMessage ? ` ${result.value.failureMessage}` : ""}`,
        );
      }
      if (!result.value.failedStep) setPendingContinuation(null);
      if (!result.value.failedStep) setError(null);
    }
  }, [
    activeReviewedStatus,
    authoritativeStagedCount,
    cancelReview,
    hasPendingMerge,
    message,
    openPublishRepositoryDialog,
    pendingPrimaryAction,
    pendingContinuation,
    pendingActionScope,
    pendingScope,
    props.cwd,
    props.environmentId,
    refreshStatus,
    runAction,
    updateMessage,
    workflowAvailable,
  ]);

  const runPrimaryAction = useCallback(async () => {
    if (!reviewedSnapshot.available) return;
    if (
      primaryAction.action === "push" ||
      primaryAction.action === "publish" ||
      primaryAction.action === "publish-repository"
    ) {
      if (!primaryAction.enabled || props.cwd === null || currentPrimaryActionScope === null)
        return;
      setPendingPrimaryAction(primaryAction.action);
      setPendingActionScope(currentPrimaryActionScope);
      return;
    }
    if (selectedCommitAction === "commit") {
      await submit(false);
      return;
    }
    if (primaryAction.action === "amend") {
      await submit(false, true);
      return;
    }
    if (!primaryAction.enabled || currentPrimaryActionScope === null) return;
    setPendingPrimaryAction(
      primaryAction.action === "commit-publish"
        ? "commit_publish"
        : primaryAction.action === "commit-push"
          ? "commit_push"
          : "commit_sync",
    );
    setPendingActionScope(currentPrimaryActionScope);
  }, [
    currentPrimaryActionScope,
    primaryAction,
    props.cwd,
    reviewedSnapshot.available,
    selectedCommitAction,
    submit,
  ]);

  if (statusQuery.isPending && status === null)
    return <p className="p-3 text-xs text-muted-foreground">Loading repository status...</p>;
  if (statusQuery.error && status === null)
    return (
      <div className="space-y-2 p-3 text-xs">
        <p className="text-destructive" role="alert">
          Unable to read repository status.
        </p>
        <Button size="xs" variant="outline" onClick={() => void refreshStatus()}>
          Retry
        </Button>
      </div>
    );
  if (status?.isRepo === false)
    return (
      <div className="space-y-2 p-4 text-center text-xs text-muted-foreground">
        <p>This project is not a Git repository.</p>
        {error ? (
          <p className="text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          disabled={initializing}
          onClick={() => {
            if (props.cwd !== null) {
              setInitConfirmationScope({ environmentId: props.environmentId, cwd: props.cwd });
            }
          }}
        >
          {initializing ? "Initializing..." : "Initialize repository"}
        </Button>
        <AlertDialog
          open={initConfirmationScope !== null}
          onOpenChange={(open) => {
            if (!open) setInitConfirmationScope(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Initialize Git repository?</AlertDialogTitle>
              <AlertDialogDescription>
                Initialize a new Git repository at {initConfirmationScope?.cwd}. This creates Git
                metadata in this selected repository.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                onClick={() => {
                  const scope = initConfirmationScope;
                  setInitConfirmationScope(null);
                  // Scope changes close the approval. This guard also protects
                  // an event already queued by a rerender.
                  if (
                    scope === null ||
                    scope.environmentId !== props.environmentId ||
                    scope.cwd !== props.cwd
                  )
                    return;
                  void initializeRepository(scope, "approved");
                }}
              >
                Initialize Git
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">Branch</p>
            <BranchToolbarBranchSelector
              environmentId={props.environmentId}
              threadId={props.threadId}
              selectedRepositoryRoot={props.cwd}
              envLocked={props.envLocked}
              startFromOrigin={false}
              onStartFromOriginChange={() => undefined}
            />
          </div>
          <Button
            aria-label="Refresh source control"
            size="icon-xs"
            variant="ghost"
            onClick={() => void refreshStatus()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {authoritativeWorkingTreeCount} changes ·{" "}
          {status?.workingTree.stagedCount ??
            files.filter((file) => file.indexStatus === "staged" || file.indexStatus === "both")
              .length}{" "}
          staged · +{status?.workingTree.insertions ?? 0} · -{status?.workingTree.deletions ?? 0}
        </p>
        {availability === "loading" ? (
          <p className="text-xs text-muted-foreground">Checking Source Control support...</p>
        ) : null}
        {availability === "unsupported" ? (
          <p className="text-xs text-muted-foreground">
            Update this server to stage files or commit from this panel.
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {fileGroups.map((group) => (
            <section key={group.id} aria-labelledby={`source-control-${group.id}`}>
              <h3
                id={`source-control-${group.id}`}
                className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {group.label}
              </h3>
              <div className="space-y-1">
                {(
                  group.nodes ??
                  group.files.map((file) => ({ kind: "file" as const, path: file.path, depth: 0 }))
                ).map((node) => {
                  if (node.kind === "directory") {
                    return (
                      <p
                        className="px-2 py-1 text-[10px] font-medium text-muted-foreground"
                        key={`${group.id}:directory:${node.path}`}
                        style={{ paddingLeft: `${0.5 + node.depth * 0.75}rem` }}
                      >
                        {node.path.split("/").at(-1)}
                      </p>
                    );
                  }
                  const file = group.files.find((candidate) => candidate.path === node.path);
                  if (!file) return null;
                  const actions = fileAction(file.indexStatus);
                  const comparisons =
                    file.indexStatus === "both"
                      ? ([
                          { comparison: "index", label: "Staged changes" },
                          { comparison: "worktree-index", label: "Unstaged changes" },
                        ] as const)
                      : file.indexStatus === "staged"
                        ? ([{ comparison: "index", label: "Staged changes" }] as const)
                        : file.indexStatus === "unstaged"
                          ? ([
                              {
                                comparison: "worktree-index",
                                label: "Unstaged changes",
                              },
                            ] as const)
                          : file.indexStatus === "untracked"
                            ? ([
                                {
                                  comparison: "worktree-index",
                                  label: "Untracked changes",
                                },
                              ] as const)
                            : [];
                  return (
                    <div
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/60"
                      key={`${group.id}:${file.path}`}
                      style={fileView.tree ? { marginLeft: `${node.depth * 0.75}rem` } : undefined}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono">
                          {fileView.tree ? (file.path.split("/").at(-1) ?? file.path) : file.path}
                        </p>
                        <p className="text-[10px] text-muted-foreground">
                          {sourceControlFileStatusLabel(file.indexStatus)} · +{file.insertions} -
                          {file.deletions}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {comparisons.map(({ comparison, label }) => (
                          <Button
                            key={label}
                            size="xs"
                            variant="ghost"
                            disabled={!workflowAvailable || pendingPath !== null}
                            onClick={() => void reviewFile(file, comparison)}
                          >
                            {label}
                          </Button>
                        ))}
                        {actions?.map((action) => (
                          <Button
                            key={action}
                            size="xs"
                            variant={action === "stage" ? "outline" : "ghost"}
                            disabled={!workflowAvailable || pendingPath !== null}
                            onClick={() => void mutateFile(file, action)}
                          >
                            {pendingPath === file.path
                              ? "Working..."
                              : action === "stage"
                                ? "Stage"
                                : "Unstage"}
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {authoritativeWorkingTreeCount === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              Working tree clean.
            </p>
          ) : null}
          {hasPendingMerge && authoritativeStagedCount === 0 ? (
            <div className="px-2">
              <Button
                size="xs"
                variant="outline"
                disabled={!workflowAvailable}
                onClick={reviewPendingMerge}
              >
                Review pending merge
              </Button>
            </div>
          ) : null}
          {status && (status.aheadCount > 0 || status.behindCount > 0) ? (
            <p className="px-2 text-xs text-muted-foreground">
              {status.aheadCount > 0 ? `${status.aheadCount} ahead` : ""}
              {status.aheadCount > 0 && status.behindCount > 0 ? " · " : ""}
              {status.behindCount > 0 ? `${status.behindCount} behind` : ""}
            </p>
          ) : null}
          {workingTreePages.nextCursor !== null ? (
            <Button size="xs" variant="outline" className="mx-2" onClick={() => void loadMore()}>
              Load more changes
            </Button>
          ) : null}
          {pageError ? <p className="px-2 text-xs text-destructive">{pageError}</p> : null}
          {review ? (
            <div className="rounded border border-border/70 bg-muted/30 p-2 text-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="min-w-0 truncate font-mono">
                  {review.path} · {review.label}
                </p>
                <Button size="xs" variant="ghost" onClick={cancelReview}>
                  Cancel review
                </Button>
              </div>
              <p className="text-muted-foreground">
                This file opened in the secondary pane for single-file review.
              </p>
              {review.truncated ? (
                <p className="mt-2 text-muted-foreground">This diff was truncated.</p>
              ) : null}
            </div>
          ) : null}
          {reviewError ? <p className="px-2 text-xs text-destructive">{reviewError}</p> : null}
          {files.some((file) => file.indexStatus === "conflicted") ? (
            <p className="px-2 text-xs text-muted-foreground">
              Resolve conflicted files in Git before staging them.
            </p>
          ) : null}
        </div>
      </ScrollArea>
      <div className="border-t border-border/70 p-3">
        <Textarea
          aria-label="Commit message"
          value={message}
          onChange={(event) => updateMessage(event.target.value)}
          placeholder="Commit message"
          maxLength={10_000}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <Popover open={generationOpen} onOpenChange={setGenerationOpen}>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                title={generateDisabledReason ?? undefined}
                disabled={generateDisabledReason !== null}
                onClick={() => void generate()}
              >
                {generating ? "Generating…" : "Generate"}
              </Button>
              <PopoverTrigger
                render={<Button size="sm" variant="outline" aria-label="Generate options" />}
              >
                ▾
              </PopoverTrigger>
            </div>
            <PopoverPopup className="w-72 space-y-2 p-3">
              <p className="text-xs font-medium">Generate with instructions</p>
              <Textarea
                aria-label="Generation instructions"
                value={generationInstructions}
                onChange={(event) => updateGenerationInstructions(event.target.value)}
                placeholder="Add temporary guidance"
                maxLength={10_000}
              />
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={replaceGenerationPrompt}
                  onChange={(event) => setReplaceGenerationPrompt(event.target.checked)}
                />
                <Tooltip>
                  <TooltipTrigger render={<span>Replace prompt</span>} />
                  <TooltipPopup>
                    Replace configured writing instructions for this request.
                  </TooltipPopup>
                </Tooltip>
              </label>
              <Button
                size="sm"
                className="w-full"
                title={instructionGenerateDisabledReason ?? undefined}
                disabled={instructionGenerateDisabledReason !== null}
                onClick={() => void generate()}
              >
                Generate
              </Button>
            </PopoverPopup>
          </Popover>
          <div className="flex items-center gap-1">
            <select
              aria-label="Commit action"
              className="h-8 rounded border border-border bg-background px-2 text-xs"
              value={selectedCommitAction}
              onChange={(event) =>
                updateSelectedCommitAction(event.target.value as ComposerDraft["action"])
              }
            >
              <option value="commit">Commit</option>
              <option value="amend">Commit (Amend)</option>
              <option value="commit_push">Commit & Push</option>
              <option value="commit_sync">Commit & Sync</option>
            </select>
            <Button
              size="sm"
              title={primaryAction.reason ?? undefined}
              disabled={
                !reviewedSnapshot.available ||
                !primaryAction.enabled ||
                (primaryAction.action === "commit"
                  ? !reviewedCommitReady
                  : primaryAction.action === "amend"
                    ? !workflowAvailable ||
                      status?.headCommit == null ||
                      status.indexTree === undefined ||
                      status.refName == null
                    : primaryAction.action === "commit-push" ||
                        primaryAction.action === "commit-sync" ||
                        primaryAction.action === "commit-publish"
                      ? !reviewedCommitReady
                      : false)
              }
              onClick={() => void runPrimaryAction()}
            >
              <GitCommitIcon className="size-3.5" />
              {primaryPublicationAction !== null
                ? primaryPublicationAction === "push"
                  ? "Push"
                  : primaryPublicationAction === "publish"
                    ? "Publish Branch"
                    : "Publish Repository"
                : primaryAction.action === "commit-publish"
                  ? "Commit & Publish Branch"
                  : selectedCommitAction === "commit"
                    ? "Commit staged changes"
                    : selectedCommitAction === "amend"
                      ? "Amend"
                      : selectedCommitAction === "commit_push"
                        ? "Commit & Push"
                        : "Commit & Sync"}
            </Button>
          </div>
        </div>
      </div>
      {continuation ? (
        <div className="border-t border-border/70 px-3 py-2 text-xs">
          <p className="text-muted-foreground">
            {continuation.commitSha
              ? `Commit ${continuation.commitSha.slice(0, 7)} was created. `
              : ""}
            Retry only the remaining {continuation.value.action} step.
          </p>
          <Button
            size="xs"
            variant="outline"
            title={!reviewedSnapshot.available ? reviewedSnapshot.reason : undefined}
            disabled={!reviewedSnapshot.available || currentPrimaryActionScope === null}
            onClick={() => {
              if (!reviewedSnapshot.available || currentPrimaryActionScope === null) return;
              setPendingContinuation(continuation.value);
              setPendingPrimaryAction(continuation.value.action);
              setPendingActionScope(currentPrimaryActionScope);
            }}
          >
            Retry {continuation.value.action}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              if (props.cwd === null) return;
              void dismissProgress({
                environmentId: props.environmentId,
                input: { cwd: props.cwd },
              });
            }}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      <AlertDialog
        open={defaultRefConfirmationOpen}
        onOpenChange={(open) => setDefaultRefConfirmationOpen(open)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {activeReviewedStatus?.isDefaultRef
                ? "Commit to the default branch?"
                : "Confirm amend commit?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {`Repository ${status?.repositoryRoot ?? props.cwd ?? "this repository"}, branch ${status?.refName ?? "detached HEAD"}: this replaces HEAD with the reviewed staged changes.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void submit(true, true)}>Amend commit</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={pendingPrimaryAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingPrimaryAction(null);
            setPendingContinuation(null);
            setPendingActionScope(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Git action</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingPrimaryAction
                ? sourceControlConfirmationDescription({
                    action: pendingPrimaryAction,
                    repositoryRoot: pendingActionScope?.cwd ?? "this repository",
                    branch: pendingActionScope?.sourceRef ?? "detached HEAD",
                    ...(confirmationRemote ? { remoteName: confirmationRemote } : {}),
                    ...(confirmationRemoteRef ? { remoteRefName: confirmationRemoteRef } : {}),
                    ...(confirmationPullRemote ? { pullRemoteName: confirmationPullRemote } : {}),
                    ...(confirmationPullRef ? { pullRefName: confirmationPullRef } : {}),
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void executePendingPrimaryAction()}>Continue</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {props.cwd ? (
        <PublishRepositoryDialog
          open={publishRepositoryOpen && isPublishRepositorySourceCurrent}
          onOpenChange={setPublishRepositoryDialogOpen}
          environmentId={props.environmentId}
          threadRef={props.threadRef}
          gitCwd={props.cwd}
          reviewedSourceRef={publishRepositorySource?.ref ?? null}
          reviewedSourceHead={publishRepositorySource?.head ?? null}
          reviewedSourceIndexTree={publishRepositorySource?.indexTree ?? null}
          currentSourceRef={currentPublishRepositorySource?.ref ?? null}
          currentSourceHead={currentPublishRepositorySource?.head ?? null}
          currentSourceIndexTree={currentPublishRepositorySource?.indexTree ?? null}
        />
      ) : null}
    </div>
  );
}

function PullRequestsView(
  props: Pick<
    SourceControlPanelProps,
    | "environmentId"
    | "projectId"
    | "threadRef"
    | "cwd"
    | "supportsPullRequests"
    | "pullRequestsCapabilityKnown"
  >,
) {
  const targets = useMemo<ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>>(
    () =>
      props.supportsPullRequests && props.projectId !== null
        ? [
            {
              environmentId: props.environmentId,
              input: {
                state: "open",
                involvement: "all",
                projectId: props.projectId,
                ...(props.cwd === null ? {} : { repositoryRoot: props.cwd }),
                limit: 50,
              },
            },
          ]
        : [],
    [props.cwd, props.environmentId, props.projectId, props.supportsPullRequests],
  );
  const list = usePullRequestList(targets);
  const [selected, setSelected] = useState<EnvironmentPullRequestEntry | null>(null);
  const selectionScope = `${props.environmentId}\0${props.projectId ?? ""}\0${props.cwd ?? ""}`;
  useEffect(() => setSelected(null), [selectionScope]);
  if (!props.pullRequestsCapabilityKnown) return <PullRequestListGhost rows={5} />;
  if (!props.supportsPullRequests)
    return (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />
    );
  const entries = list.data?.entries ?? [];
  // Effects clear the previous selection after paint. Never construct a mixed
  // root/reference during that transition: it could target an action at the
  // newly selected repository with an old pull request number.
  const selectedForScope =
    selected !== null &&
    selected.environmentId === props.environmentId &&
    selected.projectId === props.projectId
      ? selected
      : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="max-h-56 border-b border-border/70 p-2">
        {entries.map((entry) => (
          <PullRequestRow
            key={`${entry.environmentId}:${entry.projectId}:${entry.host}:${entry.repository}#${entry.number}`}
            entry={entry}
            selected={
              selectedForScope?.host === entry.host &&
              selectedForScope?.repository === entry.repository &&
              selectedForScope?.number === entry.number
            }
            showProjectTitle={false}
            showProvider={false}
            onSelect={(target) =>
              setSelected(
                entries.find(
                  (candidate) =>
                    candidate.projectId === target.projectId &&
                    candidate.host === target.host &&
                    candidate.repository === target.repository &&
                    candidate.number === target.number,
                ) ?? null,
              )
            }
          />
        ))}
      </ScrollArea>
      <div className="min-h-0 flex-1">
        {selectedForScope ? (
          <PullRequestDetailPanel
            key={`${selectedForScope.environmentId}:${selectedForScope.projectId}:${props.cwd ?? ""}:${selectedForScope.host ?? ""}:${selectedForScope.repository}#${selectedForScope.number}`}
            environmentId={selectedForScope.environmentId}
            shortcutsEnabled={false}
            getShortcutContext={() => SOURCE_CONTROL_SHORTCUT_CONTEXT}
            threadRef={props.threadRef}
            reference={{
              projectId: selectedForScope.projectId,
              ...(props.cwd === null ? {} : { repositoryRoot: props.cwd }),
              host: selectedForScope.host,
              repository: selectedForScope.repository,
              number: selectedForScope.number,
            }}
            context="page"
            composerDraftTarget={props.threadRef}
            onActed={list.refresh}
          />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <GitPullRequestIcon className="size-4" />
            Select a pull request to review it.
          </div>
        )}
      </div>
    </div>
  );
}

function graphLaneColumns(commit: GitCommitGraphPageResult["commits"][number]) {
  const lane = commit.lane ?? 0;
  const edges = commit.edges ?? (commit.lanes ?? []).map((to) => ({ from: lane, to }));
  return Math.max(lane, ...edges.flatMap((edge) => [edge.from, edge.to]), 0) + 1;
}

function CommitGraphLanes({
  commit,
}: {
  readonly commit: GitCommitGraphPageResult["commits"][number];
}) {
  const lane = commit.lane ?? 0;
  const edges = commit.edges ?? (commit.lanes ?? []).map((to) => ({ from: lane, to }));
  const columns = graphLaneColumns(commit);
  return (
    <svg
      aria-label="Graph lanes"
      className="pointer-events-none absolute left-2 top-[6px] z-0 overflow-visible text-muted-foreground"
      data-graph-lanes
      height="100%"
      width={columns * 12}
    >
      {edges.map((edge) => (
        <line
          key={`${edge.from}-${edge.to}`}
          data-graph-edge={`${edge.from}-${edge.to}`}
          stroke="currentColor"
          strokeWidth="1.5"
          x1={edge.from * 12 + 6}
          x2={edge.to * 12 + 6}
          y1="0"
          y2="100%"
        />
      ))}
      <circle cx={lane * 12 + 6} cy="0" data-graph-lane={lane} fill="currentColor" r="3" />
    </svg>
  );
}

function GraphView(props: Pick<SourceControlPanelProps, "environmentId" | "cwd" | "threadRef">) {
  const graphRowLimit = 500;
  const graphPageSize = 50;
  const graphWindowPageLimit = Math.ceil(graphRowLimit / graphPageSize);
  const loadPage = useAtomCommand(sourceControlWorkspaceEnvironment.commitGraphPage, {
    reportFailure: false,
  });
  const loadFiles = useAtomCommand(sourceControlWorkspaceEnvironment.commitFiles, {
    reportFailure: false,
  });
  const [commits, setCommits] = useState<GitCommitGraphPageResult["commits"]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [filesByCommit, setFilesByCommit] = useState<
    Readonly<Record<string, GitCommitFilesResult["files"]>>
  >({});
  const [parentByCommit, setParentByCommit] = useState<Readonly<Record<string, string>>>({});
  const [requestedParentByCommit, setRequestedParentByCommit] = useState<
    Readonly<Record<string, string>>
  >({});
  const [fileErrors, setFileErrors] = useState<Readonly<Record<string, string>>>({});
  const [loadingFiles, setLoadingFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [nextCursor, setNextCursor] = useState<GitCommitGraphPageResult["nextCursor"]>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedPage, setFailedPage] = useState<
    | {
        readonly kind: "page";
        readonly cursor: GitCommitGraphPageResult["nextCursor"];
        readonly append: boolean;
      }
    | { readonly kind: "refresh" }
    | null
  >(null);
  const [hoveredCommit, setHoveredCommit] = useState<string | null>(null);
  const [graphInvalidationEpoch, setGraphInvalidationEpoch] = useState(0);
  const requestId = useRef(0);
  const graphRequestPendingRef = useRef<number | null>(null);
  const graphInvalidationRef = useRef<{
    observedRevision: number | null;
    observedStatusSignature: string | null;
    pendingReplay: boolean;
    replayScheduled: boolean;
  }>({
    observedRevision: null,
    observedStatusSignature: null,
    pendingReplay: false,
    replayScheduled: false,
  });
  const fileRequestGeneration = useRef(0);
  const commitsRef = useRef(commits);
  const selectedCommitRef = useRef<string | null>(null);
  const loadedPageCountRef = useRef(0);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLElement | null>(null);
  const scrollAnchorRef = useRef<{
    readonly element: HTMLElement;
    readonly sha: string;
    readonly offsetTop: number;
  } | null>(null);
  const activeCwdRef = useRef(props.cwd);
  activeCwdRef.current = props.cwd;
  const repositoryRevision = useAtomValue(
    sourceControlWorkspaceRevisionAtom({
      environmentId: props.environmentId,
      repositoryRoot: props.cwd ?? "",
    }),
  );
  const statusQuery = useEnvironmentQuery(
    props.cwd
      ? sourceControlWorkspaceEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: props.cwd },
        })
      : null,
  );
  const refsQuery = useEnvironmentQuery(
    props.cwd
      ? sourceControlWorkspaceEnvironment.listRefs({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, limit: 500 },
        })
      : null,
  );
  const refSignature = refsQuery.data?.refs
    .map((ref) => `${ref.name}:${ref.current}:${ref.isDefault}:${ref.worktreePath ?? ""}`)
    .join("\0");
  const statusInvalidationSignature =
    statusQuery.data === null || statusQuery.data === undefined
      ? null
      : `${refSignature ?? ""}\0${statusQuery.data.headCommit}\0${statusQuery.data.refName ?? ""}`;
  const scheduleGraphReplay = useCallback(() => {
    const invalidation = graphInvalidationRef.current;
    invalidation.pendingReplay = true;
    if (graphRequestPendingRef.current !== null || invalidation.replayScheduled) return;
    invalidation.replayScheduled = true;
    setGraphInvalidationEpoch((epoch) => epoch + 1);
  }, []);
  const completeGraphRequest = useCallback((currentRequest: number) => {
    if (graphRequestPendingRef.current !== currentRequest) return;
    graphRequestPendingRef.current = null;
    const invalidation = graphInvalidationRef.current;
    if (invalidation.pendingReplay && !invalidation.replayScheduled) {
      invalidation.replayScheduled = true;
      setGraphInvalidationEpoch((epoch) => epoch + 1);
    }
  }, []);
  const captureScrollAnchor = useCallback(() => {
    const element = scrollViewportRef.current;
    if (!element) return;
    const viewportTop = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll<HTMLElement>("[data-graph-row]")].find(
      (row) => row.getBoundingClientRect().bottom > viewportTop,
    );
    const sha = anchor?.dataset.graphRow;
    scrollAnchorRef.current = anchor && sha ? { element, sha, offsetTop: anchor.offsetTop } : null;
  }, []);
  const restoreScrollAnchor = useCallback(() => {
    requestAnimationFrame(() => {
      const anchor = scrollAnchorRef.current;
      scrollAnchorRef.current = null;
      if (!anchor) return;
      const row = anchor.element.querySelector<HTMLElement>(`[data-graph-row="${anchor.sha}"]`);
      if (row) anchor.element.scrollTop += row.offsetTop - anchor.offsetTop;
    });
  }, []);
  const retainCommits = useCallback(
    (next: GitCommitGraphPageResult["commits"], direction: "head" | "tail" = "head") => {
      captureScrollAnchor();
      const unique = [...new Map(next.map((commit) => [commit.sha, commit])).values()];
      // A graph row's lanes join the next rendered row, so this must remain one
      // contiguous server order window. Selection is retained by choosing the
      // refresh window below, never by replacing an unrelated row here.
      const retained =
        direction === "tail" ? unique.slice(-graphRowLimit) : unique.slice(0, graphRowLimit);
      const retainedShas = new Set(retained.map((commit) => commit.sha));
      const membershipChanged =
        commitsRef.current.length !== retained.length ||
        commitsRef.current.some((commit, index) => commit.sha !== retained[index]?.sha);
      const contentChanged =
        membershipChanged || commitsRef.current.some((commit, index) => commit !== retained[index]);
      if (membershipChanged) {
        setExpanded((expanded) => new Set([...expanded].filter((sha) => retainedShas.has(sha))));
        setFilesByCommit((files) =>
          Object.fromEntries(Object.entries(files).filter(([sha]) => retainedShas.has(sha))),
        );
        setParentByCommit((parents) =>
          Object.fromEntries(Object.entries(parents).filter(([sha]) => retainedShas.has(sha))),
        );
        setRequestedParentByCommit((parents) =>
          Object.fromEntries(Object.entries(parents).filter(([sha]) => retainedShas.has(sha))),
        );
        setFileErrors((errors) =>
          Object.fromEntries(Object.entries(errors).filter(([sha]) => retainedShas.has(sha))),
        );
        setLoadingFiles(
          (loadingFiles) => new Set([...loadingFiles].filter((sha) => retainedShas.has(sha))),
        );
        setHoveredCommit((sha) => (sha !== null && !retainedShas.has(sha) ? null : sha));
      }
      if (contentChanged) {
        restoreScrollAnchor();
      }
      if (selectedCommitRef.current && !retainedShas.has(selectedCommitRef.current))
        selectedCommitRef.current = null;
      commitsRef.current = retained;
      return retained;
    },
    [captureScrollAnchor, restoreScrollAnchor],
  );
  const load = useCallback(
    async (cursor: GitCommitGraphPageResult["nextCursor"], append: boolean) => {
      if (!props.cwd) return;
      const currentRequest = requestId.current + 1;
      requestId.current = currentRequest;
      graphRequestPendingRef.current = currentRequest;
      setLoading(true);
      setError(null);
      const result = await loadPage({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, cursor, limit: 50 },
      });
      if (currentRequest !== requestId.current) {
        return;
      }
      setLoading(false);
      if (result._tag === "Failure") {
        completeGraphRequest(currentRequest);
        setError("Unable to load Git history.");
        setFailedPage({ kind: "page", cursor, append });
        return;
      }
      const page = result.value as GitCommitGraphPageResult;
      setFailedPage(null);
      setCommits((current) => {
        const next = append
          ? [
              ...new Map(
                [...current, ...page.commits].map((commit) => [commit.sha, commit]),
              ).values(),
            ]
          : page.commits;
        return retainCommits(next, append ? "tail" : "head");
      });
      loadedPageCountRef.current = append
        ? Math.min(graphWindowPageLimit, loadedPageCountRef.current + 1)
        : 1;
      setNextCursor(page.nextCursor);
      // State updates above commit together. The invalidation effect below
      // then sees even an empty first page before replaying a newer snapshot.
      completeGraphRequest(currentRequest);
    },
    [completeGraphRequest, loadPage, props.cwd, props.environmentId, retainCommits],
  );
  const refreshLoadedWindow = useCallback(async () => {
    if (!props.cwd) return;
    const currentRequest = requestId.current + 1;
    requestId.current = currentRequest;
    graphRequestPendingRef.current = currentRequest;
    captureScrollAnchor();
    const priorCommitShas = new Set(commitsRef.current.map((commit) => commit.sha));
    const selectedProtection =
      selectedCommitRef.current && priorCommitShas.has(selectedCommitRef.current)
        ? selectedCommitRef.current
        : null;
    const anchorProtection =
      scrollAnchorRef.current?.sha && priorCommitShas.has(scrollAnchorRef.current.sha)
        ? scrollAnchorRef.current.sha
        : null;
    setLoading(true);
    setError(null);
    const pagesToReload = Math.max(1, loadedPageCountRef.current);
    // Replaying an ordinary loaded page must remain one page of graph work.
    // The accumulator may still look farther when preserving a selected row
    // or the visible anchor requires a different contiguous window.
    const refreshWindowLimit = Math.min(
      graphRowLimit,
      Math.max(graphPageSize, commitsRef.current.length),
    );
    let cursor: GitCommitGraphPageResult["nextCursor"] = null;
    const refreshWindow = createBoundedGraphRefreshWindow<
      GitCommitGraphPageResult["commits"][number]
    >({
      limit: graphRowLimit,
      windowLimit: refreshWindowLimit,
      selectedSha: selectedProtection,
      anchorSha: anchorProtection,
    });
    let pagesLoaded = 0;
    type RefreshBoundary = {
      readonly start: number;
      readonly end: number;
      readonly cursor: GitCommitGraphPageResult["nextCursor"];
      readonly nextCursor: GitCommitGraphPageResult["nextCursor"];
    };
    let headBoundary: RefreshBoundary | null = null;
    let candidateBoundary: RefreshBoundary | null = null;
    while (true) {
      const pageCursor = cursor;
      const pageStart = refreshWindow.count;
      const result = await loadPage({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, cursor, limit: graphPageSize },
      });
      if (currentRequest !== requestId.current) return;
      if (result._tag === "Failure") {
        completeGraphRequest(currentRequest);
        setLoading(false);
        setError("Unable to load Git history.");
        setFailedPage({ kind: "refresh" });
        return;
      }
      const page = result.value as GitCommitGraphPageResult;
      for (const commit of page.commits) refreshWindow.push(commit);
      cursor = page.nextCursor;
      const boundary: RefreshBoundary = {
        start: pageStart,
        end: refreshWindow.count,
        cursor: pageCursor,
        nextCursor: page.nextCursor,
      };
      if (
        !headBoundary &&
        boundary.start < refreshWindowLimit &&
        boundary.end >= refreshWindowLimit
      ) {
        headBoundary = boundary;
      }
      const desiredWindow = refreshWindow.target();
      if (boundary.start < desiredWindow.end && boundary.end >= desiredWindow.end) {
        candidateBoundary = boundary;
      }
      pagesLoaded += 1;
      const missingSelection = selectedProtection !== null && !refreshWindow.selectedFound;
      const missingAnchor = anchorProtection !== null && !refreshWindow.anchorFound;
      // A missing protection is only known to be gone at EOF. Otherwise
      // collect enough rows for the chosen contiguous window, regardless of
      // where its endpoints land inside a server page.
      if (
        cursor === null ||
        (!missingSelection &&
          !missingAnchor &&
          pagesLoaded >= pagesToReload &&
          refreshWindow.count >= desiredWindow.end)
      )
        break;
    }
    if (currentRequest !== requestId.current) return;
    const retainedWindow = refreshWindow.finish();
    const retainedEnd = retainedWindow.end;
    const retained = retainedWindow.commits;
    const retainedBoundary =
      selectedProtection || anchorProtection ? candidateBoundary : headBoundary;
    let retainedCursor = retainedBoundary?.end === retainedEnd ? retainedBoundary.nextCursor : null;
    // Graph cursors carry the active lane topology. If a selected/anchored
    // window ends within a fetched page, replay just that prefix from the
    // page's starting cursor so the continuation belongs to the rendered row.
    if (
      retainedBoundary?.end !== retainedEnd &&
      retainedEnd > 0 &&
      retainedEnd < refreshWindow.count
    ) {
      if (retainedBoundary) {
        const boundaryResult = await loadPage({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            cursor: retainedBoundary.cursor,
            limit: retainedEnd - retainedBoundary.start,
          },
        });
        if (currentRequest !== requestId.current) return;
        if (boundaryResult._tag === "Failure") {
          completeGraphRequest(currentRequest);
          setLoading(false);
          setError("Unable to load Git history.");
          setFailedPage({ kind: "refresh" });
          return;
        }
        retainedCursor = (boundaryResult.value as GitCommitGraphPageResult).nextCursor;
      }
    }
    // If no protection survived, this is the normal HEAD prefix; its cursor
    // was recorded at the prefix boundary, not at the later EOF scan.
    setCommits(retainCommits(retained, "head"));
    loadedPageCountRef.current = Math.min(
      graphWindowPageLimit,
      Math.max(1, Math.ceil(retained.length / graphPageSize)),
    );
    setNextCursor(retainedCursor);
    setFailedPage(null);
    setLoading(false);
    completeGraphRequest(currentRequest);
  }, [
    captureScrollAnchor,
    completeGraphRequest,
    graphPageSize,
    graphRowLimit,
    graphWindowPageLimit,
    loadPage,
    props.cwd,
    props.environmentId,
    retainCommits,
  ]);
  const requestFiles = useCallback(
    async (commit: GitCommitGraphPageResult["commits"][number], parentSha?: string) => {
      if (!props.cwd) return;
      const { sha } = commit;
      const requestCwd = props.cwd;
      const requestGeneration = fileRequestGeneration.current;
      if (parentSha) setRequestedParentByCommit((current) => ({ ...current, [sha]: parentSha }));
      setLoadingFiles((current) => new Set(current).add(sha));
      setFileErrors((current) => {
        const { [sha]: _ignored, ...next } = current;
        return next;
      });
      const result = await loadFiles({
        environmentId: props.environmentId,
        input: { cwd: requestCwd, commitSha: sha, ...(parentSha ? { parentSha } : {}) },
      });
      if (
        activeCwdRef.current !== requestCwd ||
        requestGeneration !== fileRequestGeneration.current ||
        !commitsRef.current.some((candidate) => candidate.sha === sha)
      )
        return;
      setLoadingFiles((current) => {
        const next = new Set(current);
        next.delete(sha);
        return next;
      });
      if (result._tag === "Failure") {
        setFileErrors((current) => ({ ...current, [sha]: "Unable to load changed files." }));
        return;
      }
      if (parentSha) setParentByCommit((current) => ({ ...current, [sha]: parentSha }));
      setFilesByCommit((current) => ({ ...current, [sha]: result.value.files }));
    },
    [loadFiles, props.cwd, props.environmentId],
  );
  const toggleCommit = useCallback(
    async (commit: GitCommitGraphPageResult["commits"][number]) => {
      const { sha } = commit;
      selectedCommitRef.current = sha;
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(sha)) next.delete(sha);
        else next.add(sha);
        return next;
      });
      if (!props.cwd || filesByCommit[sha] !== undefined) return;
      if (commit.parents.length > 1 && !parentByCommit[sha]) return;
      await requestFiles(commit, parentByCommit[sha]);
    },
    [filesByCommit, parentByCommit, props.cwd, requestFiles],
  );
  const selectMergeParent = useCallback(
    async (sha: string, parentSha: string) => {
      const commit = commits.find((candidate) => candidate.sha === sha);
      if (commit) await requestFiles(commit, parentSha);
    },
    [commits, requestFiles],
  );
  useEffect(() => {
    graphInvalidationRef.current = {
      observedRevision: null,
      observedStatusSignature: null,
      pendingReplay: false,
      replayScheduled: false,
    };
    graphRequestPendingRef.current = null;
    fileRequestGeneration.current += 1;
    loadedPageCountRef.current = 0;
    commitsRef.current = [];
    selectedCommitRef.current = null;
    setCommits([]);
    setExpanded(new Set());
    setFilesByCommit({});
    setParentByCommit({});
    setRequestedParentByCommit({});
    setFileErrors({});
    setLoadingFiles(new Set());
    setNextCursor(null);
    setFailedPage(null);
    void load(null, false);
  }, [load]);
  useEffect(() => {
    // Repository revision is available from mount, unlike status. Establish
    // its baseline independently so a mutation before the first status query
    // resolves is still an invalidation of an in-flight graph request.
    const invalidation = graphInvalidationRef.current;
    if (invalidation.observedRevision === null) {
      invalidation.observedRevision = repositoryRevision;
      return;
    }
    if (invalidation.observedRevision === repositoryRevision) return;
    invalidation.observedRevision = repositoryRevision;
    scheduleGraphReplay();
  }, [repositoryRevision, scheduleGraphReplay]);
  useEffect(() => {
    // Status/ref availability is only a baseline. Later changes are distinct
    // invalidations, coalesced with revision changes into one replay.
    if (statusInvalidationSignature === null) return;
    const invalidation = graphInvalidationRef.current;
    if (invalidation.observedStatusSignature === null) {
      invalidation.observedStatusSignature = statusInvalidationSignature;
      return;
    }
    if (invalidation.observedStatusSignature === statusInvalidationSignature) return;
    invalidation.observedStatusSignature = statusInvalidationSignature;
    scheduleGraphReplay();
  }, [scheduleGraphReplay, statusInvalidationSignature]);
  useEffect(() => {
    if (graphInvalidationEpoch === 0) return;
    const invalidation = graphInvalidationRef.current;
    if (!invalidation.pendingReplay || graphRequestPendingRef.current !== null) return;
    invalidation.pendingReplay = false;
    invalidation.replayScheduled = false;
    void refreshLoadedWindow();
  }, [graphInvalidationEpoch, refreshLoadedWindow]);
  useEffect(() => {
    const target = loadMoreRef.current;
    if (
      !target ||
      nextCursor === null ||
      loading ||
      error ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load(nextCursor, true);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [error, load, loading, nextCursor]);
  if (!props.cwd) return <p className="p-4 text-xs text-muted-foreground">Select a repository.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea
        className="min-h-0 flex-1"
        onScrollCapture={(event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          scrollViewportRef.current = target;
          if (loading || error || nextCursor === null) return;
          if (target.scrollTop + target.clientHeight >= target.scrollHeight - 160) {
            void load(nextCursor, true);
          }
        }}
        aria-busy={loading}
      >
        <div className="p-2" role="list" aria-label="Git history">
          {commits.map((commit) => (
            <div
              key={commit.sha}
              className="relative rounded px-2 py-1.5 text-xs"
              data-graph-row={commit.sha}
              role="listitem"
              onMouseEnter={() => setHoveredCommit(commit.sha)}
              onMouseLeave={() =>
                setHoveredCommit((current) => (current === commit.sha ? null : current))
              }
            >
              <CommitGraphLanes commit={commit} />
              <button
                type="button"
                className="relative z-10 flex w-full items-start text-left"
                aria-expanded={expanded.has(commit.sha)}
                style={{ paddingLeft: `${graphLaneColumns(commit) * 12 + 8}px` }}
                onClick={() => void toggleCommit(commit)}
              >
                <span className="min-w-0">
                  <span className="block truncate">{commit.subject}</span>
                  {commit.refs.length > 0 ? (
                    <span className="flex flex-wrap gap-1 pt-0.5 text-[10px] text-muted-foreground">
                      {commit.refs.map((ref) => (
                        <span
                          key={`${ref.kind}:${ref.name}`}
                          className="rounded border border-border/70 px-1"
                          data-graph-ref-kind={ref.kind}
                        >
                          {ref.kind === "head" ? "HEAD" : `${ref.kind}: ${ref.name}`}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </button>
              {hoveredCommit === commit.sha ? (
                <div className="absolute left-8 top-full z-10 max-w-[min(24rem,90%)] rounded border border-border bg-popover p-2 text-[11px] shadow-md">
                  <p className="font-mono">{commit.sha}</p>
                  <p className="whitespace-pre-wrap">{commit.message ?? commit.subject}</p>
                  <p>
                    {commit.authorName ?? "Unknown author"}
                    {commit.authorEmail ? ` <${commit.authorEmail}>` : ""}
                  </p>
                  <p>
                    Parents:{" "}
                    {commit.parents.length === 0 ? "root commit" : commit.parents.join(", ")}
                  </p>
                  {commit.changeSummary ? <p>Change summary: {commit.changeSummary}</p> : null}
                  <p className="text-muted-foreground">
                    {commit.parents.length} parent{commit.parents.length === 1 ? "" : "s"} ·{" "}
                    {new Date(commit.authorTimestamp * 1000).toLocaleString()}
                  </p>
                </div>
              ) : null}
              {expanded.has(commit.sha) ? (
                <div className="mt-1 ml-4 space-y-0.5 border-l border-border/70 pl-2">
                  {commit.parents.length > 1 ? (
                    <div className="space-y-1 text-[11px] text-muted-foreground">
                      <span>Choose a parent to review this merge:</span>
                      <div className="flex flex-wrap gap-1">
                        {commit.parents.map((parent, index) => (
                          <Button
                            key={parent}
                            size="xs"
                            variant="outline"
                            onClick={() => {
                              void selectMergeParent(commit.sha, parent);
                            }}
                            disabled={loadingFiles.has(commit.sha)}
                          >
                            Parent {index + 1}
                            {parentByCommit[commit.sha] === parent ? " (selected)" : ""}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {loadingFiles.has(commit.sha) ? (
                    <span className="text-[11px] text-muted-foreground">
                      Loading changed files…
                    </span>
                  ) : null}
                  {fileErrors[commit.sha] ? (
                    <div className="flex items-center gap-2 text-[11px] text-destructive">
                      <span>{fileErrors[commit.sha]}</span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          void requestFiles(
                            commit,
                            requestedParentByCommit[commit.sha] ?? parentByCommit[commit.sha],
                          )
                        }
                      >
                        Retry files
                      </Button>
                    </div>
                  ) : null}
                  {(filesByCommit[commit.sha] ?? []).map((file) => {
                    const path = file.newPath ?? file.oldPath;
                    if (!path) return null;
                    const mergeParent = parentByCommit[commit.sha] ?? commit.parents[0] ?? null;
                    return (
                      <button
                        type="button"
                        key={`${file.status}:${file.oldPath ?? ""}:${file.newPath ?? ""}`}
                        className="block max-w-full truncate text-left text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          openRepositoryComparison(props.threadRef, {
                            repositoryRoot: props.cwd ?? "",
                            comparison: "commit",
                            oldPath: file.oldPath,
                            newPath: file.newPath,
                            commitSha: commit.sha,
                            headRevision: commit.sha,
                            baseRevision: mergeParent,
                            mergeParent,
                          })
                        }
                      >
                        {file.status} {path}
                      </button>
                    );
                  })}
                  {filesByCommit[commit.sha]?.length === 0 ? (
                    <span className="text-[11px] text-muted-foreground">No changed files.</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          {commits.length === 0 && !loading && !error ? (
            <p className="p-4 text-center text-xs text-muted-foreground">No commits found.</p>
          ) : null}
          {nextCursor !== null ? <div ref={loadMoreRef} aria-hidden="true" /> : null}
        </div>
      </ScrollArea>
      {error ? (
        <p className="px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end border-t border-border/70 p-2">
        {loading ? (
          <span className="mr-auto px-2 text-xs text-muted-foreground">Loading history…</span>
        ) : null}
        {error && failedPage ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              if (failedPage.kind === "refresh") void refreshLoadedWindow();
              else void load(failedPage.cursor, failedPage.append);
            }}
          >
            Retry
          </Button>
        ) : null}
        {nextCursor === null && commits.length > 0 && !loading && !error ? (
          <span className="px-2 text-xs text-muted-foreground">End of history</span>
        ) : null}
      </div>
    </div>
  );
}

export function SourceControlPanel(props: SourceControlPanelProps) {
  const workspaceSupported =
    props.supportsSourceControlWorkspace ??
    (props.sourceControlWorkspaceCapabilityKnown === undefined
      ? true
      : props.sourceControlWorkspaceCapabilityKnown);
  const discoverRepositories = useAtomCommand(
    sourceControlWorkspaceEnvironment.discoverRepositories,
    { reportFailure: false },
  );
  const [discovery, setDiscovery] = useState<GitRepositoryDiscoveryResult | null>(null);
  const [collapsedRepositoryRoots, setCollapsedRepositoryRoots] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [visitedGraphRoots, setVisitedGraphRoots] = useState<ReadonlySet<string>>(() => new Set());
  const discoveryRequestId = useRef(0);
  const discoveryScope = `${props.environmentId}\0${props.cwd ?? ""}`;
  const discoveryScopeRef = useRef(discoveryScope);
  discoveryScopeRef.current = discoveryScope;
  const selectedRepositoryRoot = useRightPanelStore((state) =>
    state.getSourceControlRepositoryRoot(props.threadRef),
  );
  const refreshRepositories = useCallback(async () => {
    if (!workspaceSupported || !props.cwd) return;
    const requestId = discoveryRequestId.current + 1;
    discoveryRequestId.current = requestId;
    const requestScope = discoveryScope;
    const result = await discoverRepositories({
      environmentId: props.environmentId,
      input: { cwd: props.cwd },
    });
    if (
      result._tag === "Success" &&
      isCurrentSourceControlRequest(requestId, discoveryRequestId.current) &&
      requestScope === discoveryScopeRef.current
    ) {
      setDiscovery(result.value as GitRepositoryDiscoveryResult);
    }
  }, [discoverRepositories, discoveryScope, props.cwd, props.environmentId, workspaceSupported]);
  useEffect(() => {
    setDiscovery(null);
    void refreshRepositories();
  }, [refreshRepositories]);
  const activeRepository = chooseActiveRepository(
    discovery?.repositories ?? [],
    selectedRepositoryRoot,
    discovery?.projectRoot ?? props.cwd ?? "",
  );
  const setSelectedRepositoryRoot = useCallback(
    (root: string | null) => {
      useRightPanelStore.getState().setSourceControlRepositoryRoot(props.threadRef, root);
    },
    [props.threadRef],
  );
  useEffect(() => {
    if (activeRepository && activeRepository.rootPath !== selectedRepositoryRoot) {
      setSelectedRepositoryRoot(activeRepository.rootPath);
    }
  }, [activeRepository, selectedRepositoryRoot, setSelectedRepositoryRoot]);
  const activeCwd = activeRepository?.rootPath ?? props.cwd;
  useEffect(() => {
    if (props.view !== "graph" || !activeCwd) return;
    setVisitedGraphRoots((current) =>
      current.has(activeCwd) ? current : new Set([...current, activeCwd]),
    );
  }, [activeCwd, props.view]);
  const activeStatusQuery = useEnvironmentQuery(
    workspaceSupported && activeCwd
      ? sourceControlWorkspaceEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const activePresentation = useMemo(
    () =>
      activeStatusQuery.data?.sourceControlProvider
        ? getSourceControlPresentation(activeStatusQuery.data.sourceControlProvider)
        : (props.providerPresentation ?? null),
    [activeStatusQuery.data?.sourceControlProvider, props.providerPresentation],
  );
  const tabs = sourceControlPanelTabs(
    activePresentation?.providerName,
    activePresentation?.terminology.singular === "merge request"
      ? "Merge Requests"
      : "Pull Requests",
  );
  const tabPanelId = `source-control-tabpanel-${props.threadRef.threadId}`;
  const ProviderIcon = activePresentation?.Icon ?? GitBranchIcon;
  const repositories = discovery?.repositories ?? [];
  const repositoryViews = repositories;
  // Keep the per-repository Changes tree mounted while another tab is active.
  // Its local review and paging state belongs to the repository, not the tab.
  const showRepositoryGroups = repositories.length > 1;
  const toggleRepositoryGroup = useCallback(
    (root: string) => {
      setSelectedRepositoryRoot(root);
      setCollapsedRepositoryRoots((current) => {
        const next = new Set(current);
        if (next.has(root)) next.delete(root);
        else next.add(root);
        return next;
      });
    },
    [setSelectedRepositoryRoot],
  );
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-source-control-panel>
      <div className="@container/header-actions flex w-full items-center justify-between border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-2">
          <ProviderIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            {activePresentation?.providerName ?? "Source Control"}
          </h2>
        </div>
        {discovery && discovery.repositories.length > 0 ? (
          <div className="flex min-w-0 items-center gap-1">
            <select
              className="h-7 max-w-52 min-w-0 rounded border border-border bg-background px-1.5 text-xs"
              aria-label="Active repository"
              value={activeRepository?.rootPath ?? ""}
              onChange={(event) => setSelectedRepositoryRoot(event.target.value || null)}
            >
              {discovery.repositories.map((repository) => (
                <option key={repository.rootPath} value={repository.rootPath}>
                  {repository.rootPath.split("/").filter(Boolean).at(-1) ?? repository.rootPath}
                  {repository.rootPath === discovery.projectRoot
                    ? ""
                    : ` — ${
                        repository.rootPath.startsWith(`${discovery.projectRoot}/`)
                          ? repository.rootPath.slice(discovery.projectRoot.length + 1)
                          : repository.rootPath
                      }`}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh repositories"
              onClick={() => void refreshRepositories()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
            {discovery.truncated ? (
              <Tooltip>
                <TooltipTrigger render={<span className="text-[10px] text-muted-foreground" />}>
                  More repositories not shown
                </TooltipTrigger>
                <TooltipPopup>Repository discovery was bounded</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        {!showRepositoryGroups ? (
          <div
            ref={props.actionsTargetRef}
            className="shrink-0"
            data-source-control-actions-target
          />
        ) : null}
        <div
          className="flex rounded bg-muted p-0.5"
          role="tablist"
          aria-label="Source Control views"
        >
          {tabs.map(({ id: view, label }) => (
            <button
              key={view}
              type="button"
              role="tab"
              id={`source-control-tab-${view}-${props.threadRef.threadId}`}
              aria-selected={props.view === view}
              aria-controls={tabPanelId}
              tabIndex={props.view === view ? 0 : -1}
              className="rounded px-2 py-1 text-xs data-[selected=true]:bg-background"
              data-selected={props.view === view}
              onKeyDown={(event) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = moveSourceControlTab(
                  props.view,
                  event.key as "ArrowLeft" | "ArrowRight" | "Home" | "End",
                );
                props.onViewChange(next);
                requestAnimationFrame(() =>
                  document
                    .getElementById(`source-control-tab-${next}-${props.threadRef.threadId}`)
                    ?.focus(),
                );
              }}
              onClick={() => props.onViewChange(view)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        id={tabPanelId}
        role="tabpanel"
        aria-labelledby={`source-control-tab-${props.view}-${props.threadRef.threadId}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {!workspaceSupported ? (
          <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
            Update the connected T3 Code server to use this Source Control workspace.
          </div>
        ) : (
          <>
            {showRepositoryGroups ? (
              <div className="min-h-0 flex-1 overflow-y-auto" hidden={props.view !== "changes"}>
                {repositoryViews.map((repository) => {
                  const collapsed = collapsedRepositoryRoots.has(repository.rootPath);
                  const isActive = activeRepository?.rootPath === repository.rootPath;
                  return (
                    <section
                      key={repository.rootPath}
                      data-source-control-repository-group
                      data-active={isActive}
                      className="border-b border-border/70"
                      onClickCapture={() => {
                        if (!isActive) setSelectedRepositoryRoot(repository.rootPath);
                      }}
                      onFocusCapture={() => {
                        if (!isActive) setSelectedRepositoryRoot(repository.rootPath);
                      }}
                    >
                      <RepositoryGroupHeader
                        environmentId={props.environmentId}
                        threadRef={props.threadRef}
                        repository={repository}
                        projectRoot={props.cwd}
                        active={isActive}
                        collapsed={collapsed}
                        onToggle={() => toggleRepositoryGroup(repository.rootPath)}
                      />
                      <div hidden={collapsed}>
                        <ChangesView
                          {...props}
                          cwd={repository.rootPath}
                          {...(repository.capabilities
                            ? { repositoryCapabilities: repository.capabilities }
                            : {})}
                        />
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : repositoryViews.length > 0 ? (
              repositoryViews.map((repository) => (
                <div key={repository.rootPath} hidden={props.view !== "changes"}>
                  <ChangesView
                    {...props}
                    cwd={repository.rootPath}
                    {...(repository.capabilities
                      ? { repositoryCapabilities: repository.capabilities }
                      : {})}
                  />
                </div>
              ))
            ) : (
              <div hidden={props.view !== "changes"}>
                <ChangesView
                  {...props}
                  cwd={activeCwd}
                  {...(activeRepository?.capabilities
                    ? { repositoryCapabilities: activeRepository.capabilities }
                    : {})}
                />
              </div>
            )}
            {repositoryViews
              .filter((repository) => visitedGraphRoots.has(repository.rootPath))
              .map((repository) => (
                <div
                  key={repository.rootPath}
                  hidden={props.view !== "graph" || repository.rootPath !== activeCwd}
                >
                  <GraphView
                    environmentId={props.environmentId}
                    cwd={repository.rootPath}
                    threadRef={props.threadRef}
                  />
                </div>
              ))}
            {props.view === "pull-requests" ? (
              <PullRequestsView
                key={`${props.environmentId}\0${props.projectId ?? ""}\0${activeCwd ?? ""}`}
                {...props}
                cwd={activeCwd}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
