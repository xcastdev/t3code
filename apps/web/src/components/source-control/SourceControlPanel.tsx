import type {
  EnvironmentId,
  ProjectId,
  PullRequestListInput,
  ScopedThreadRef,
  ThreadId,
  VcsStatusResult,
  VcsWorkingTreeFile,
} from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";
import { GitBranchIcon, GitCommitIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { usePullRequestList, type EnvironmentQueryTarget } from "~/state/pullRequests";
import type { ShortcutMatchContext } from "~/keybindings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
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
import {
  buildSourceControlCommitInput,
  canSubmitSourceControlCommit,
  fileAction,
  gitIndexWorkflowAvailability,
  gitMutationRejectionCode,
  sourceControlFileStatusLabel,
  type SourceControlPanelView,
} from "./sourceControlPanel.logic";
import SourceControlActions from "./SourceControlActions";

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
  readonly draftId?: DraftId;
  readonly onOpenPullRequest?: ((number: number) => void) | undefined;
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
    | "cwd"
    | "envLocked"
    | "gitIndexWorkflowCapabilityKnown"
    | "supportsGitIndexWorkflow"
  >,
) {
  const statusQuery = useEnvironmentQuery(
    props.cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId: props.environmentId,
          input: { cwd: props.cwd },
        }),
  );
  const status = statusQuery.data;
  const availability = gitIndexWorkflowAvailability(
    props.gitIndexWorkflowCapabilityKnown,
    props.supportsGitIndexWorkflow,
  );
  const stage = useAtomCommand(vcsEnvironment.stageFiles, {
    reportFailure: false,
  });
  const unstage = useAtomCommand(vcsEnvironment.unstageFiles, {
    reportFailure: false,
  });
  const getWorkingTreeDiff = useAtomCommand(vcsEnvironment.getWorkingTreeDiff, {
    reportFailure: false,
  });
  const commit = useAtomCommand(vcsEnvironment.commitIndex, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(vcsEnvironment.refreshStatus, {
    reportFailure: false,
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
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
  const files = status?.workingTree.files ?? [];
  const workflowAvailable = availability === "available";

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
    async (file: VcsWorkingTreeFile, comparison: "head" | "index" | "worktree-index") => {
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
        comparison === "index"
          ? "staged vs HEAD"
          : comparison === "worktree-index" && file.indexStatus === "untracked"
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
        path: file.path,
        truncated: false,
      });
      setReviewError(null);
      const result = await getWorkingTreeDiff({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          path: file.path,
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
        path: file.path,
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
  const submit = useCallback(
    async (confirmDefaultRef: boolean) => {
      if (
        props.cwd === null ||
        activeReviewedStatus === null ||
        !canSubmitSourceControlCommit({
          workflowAvailable,
          stagedCount: files.filter(
            (file) => file.indexStatus === "staged" || file.indexStatus === "both",
          ).length,
          message,
          reviewedStateAvailable:
            activeReviewedStatus.headCommit !== undefined &&
            activeReviewedStatus.indexTree !== undefined,
          hasReviewedBranch:
            activeReviewedStatus.refName !== null && activeReviewedStatus.refName !== undefined,
        })
      )
        return;
      if (activeReviewedStatus.isDefaultRef && !confirmDefaultRef) {
        setDefaultRefConfirmationOpen(true);
        return;
      }
      setError(null);
      const result = await commit({
        environmentId: props.environmentId,
        input: buildSourceControlCommitInput({
          cwd: props.cwd,
          message,
          headCommit: activeReviewedStatus.headCommit,
          indexTree: activeReviewedStatus.indexTree,
          refName: activeReviewedStatus.refName,
          pendingMergeHeads: activeReviewedStatus.pendingMergeHeads,
          confirmDefaultRef,
        }),
      });
      if (result._tag === "Success") {
        setMessage("");
        setDefaultRefConfirmationOpen(false);
        cancelReview();
        setReviewedStatus(null);
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
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
      workflowAvailable,
    ],
  );

  if (statusQuery.isPending && status === null)
    return <p className="p-3 text-xs text-muted-foreground">Loading repository status...</p>;
  if (status?.isRepo === false)
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        This project is not a Git repository.
      </p>
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
          {files.length} changes · +{status?.workingTree.insertions ?? 0} · -
          {status?.workingTree.deletions ?? 0}
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
          {files.map((file) => {
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
                key={file.path}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono">{file.path}</p>
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
              {review.diff === null ? (
                <p className="text-muted-foreground">Loading diff...</p>
              ) : review.diff.length === 0 ? (
                <p className="text-muted-foreground">No changes in this version.</p>
              ) : (
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-background p-2 font-mono text-[11px] leading-relaxed">
                  {review.diff}
                </pre>
              )}
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
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message"
          maxLength={10_000}
        />
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            disabled={
              !canSubmitSourceControlCommit({
                workflowAvailable,
                stagedCount: files.filter(
                  (file) => file.indexStatus === "staged" || file.indexStatus === "both",
                ).length,
                message,
                reviewedStateAvailable:
                  activeReviewedStatus?.headCommit !== undefined &&
                  activeReviewedStatus?.indexTree !== undefined,
                hasReviewedBranch:
                  activeReviewedStatus?.refName !== null &&
                  activeReviewedStatus?.refName !== undefined,
              })
            }
            onClick={() => void submit(false)}
          >
            <GitCommitIcon className="size-3.5" />
            Commit staged changes
          </Button>
        </div>
      </div>
      <AlertDialog
        open={defaultRefConfirmationOpen}
        onOpenChange={(open) => setDefaultRefConfirmationOpen(open)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Commit to the default branch?</AlertDialogTitle>
            <AlertDialogDescription>
              This commits the staged changes directly to the default branch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void submit(true)}>Commit</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function PullRequestsView(
  props: Pick<
    SourceControlPanelProps,
    | "environmentId"
    | "projectId"
    | "threadRef"
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
                limit: 50,
              },
            },
          ]
        : [],
    [props.environmentId, props.projectId, props.supportsPullRequests],
  );
  const list = usePullRequestList(targets);
  const [selected, setSelected] = useState<EnvironmentPullRequestEntry | null>(null);
  if (!props.pullRequestsCapabilityKnown) return <PullRequestListGhost rows={5} />;
  if (!props.supportsPullRequests)
    return (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />
    );
  const entries = list.data?.entries ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="max-h-56 border-b border-border/70 p-2">
        {entries.map((entry) => (
          <PullRequestRow
            key={`${entry.environmentId}:${entry.projectId}:${entry.repository}#${entry.number}`}
            entry={entry}
            selected={
              selected?.repository === entry.repository && selected?.number === entry.number
            }
            showProjectTitle={false}
            showProvider={false}
            onSelect={(target) =>
              setSelected(
                entries.find(
                  (candidate) =>
                    candidate.projectId === target.projectId &&
                    candidate.repository === target.repository &&
                    candidate.number === target.number,
                ) ?? null,
              )
            }
          />
        ))}
      </ScrollArea>
      <div className="min-h-0 flex-1">
        {selected ? (
          <PullRequestDetailPanel
            environmentId={selected.environmentId}
            shortcutsEnabled={false}
            getShortcutContext={() => SOURCE_CONTROL_SHORTCUT_CONTEXT}
            threadRef={props.threadRef}
            reference={{
              projectId: selected.projectId,
              repository: selected.repository,
              number: selected.number,
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

export function SourceControlPanel(props: SourceControlPanelProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-source-control-panel>
      <div className="flex items-center justify-between border-b border-border/70 px-3 py-2">
        <div className="flex items-center gap-2">
          <GitBranchIcon className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Source Control</h2>
        </div>
        <SourceControlActions
          gitCwd={props.cwd}
          activeThreadRef={props.threadRef}
          onOpenPullRequest={props.onOpenPullRequest}
          {...(props.draftId ? { draftId: props.draftId } : {})}
        />
        <div className="flex rounded bg-muted p-0.5" role="tablist">
          {(["changes", "pull-requests"] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={props.view === view}
              className="rounded px-2 py-1 text-xs data-[selected=true]:bg-background"
              data-selected={props.view === view}
              onClick={() => props.onViewChange(view)}
            >
              {view === "changes" ? "Changes" : "Pull requests"}
            </button>
          ))}
        </div>
      </div>
      {props.view === "changes" ? <ChangesView {...props} /> : <PullRequestsView {...props} />}
    </section>
  );
}
