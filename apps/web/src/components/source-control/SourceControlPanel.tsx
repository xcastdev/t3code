import type {
  EnvironmentId,
  ProjectId,
  PullRequestListInput,
  ScopedThreadRef,
  ThreadId,
  VcsWorkingTreeFile,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { GitBranchIcon, GitCommitIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { usePullRequestList, type EnvironmentQueryTarget } from "~/state/pullRequests";
import { readLocalApi } from "~/localApi";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import { cn } from "~/lib/utils";
import { BranchToolbarBranchSelector } from "../BranchToolbarBranchSelector";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PullRequestListGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestRow } from "../pullRequest/PullRequestRow";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import type { EnvironmentPullRequestEntry } from "../pullRequest/pullRequestList.logic";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  defaultSourceControlDiffComparison,
  fileActions,
  gitIndexWorkflowAvailability,
  isFileStaged,
  sourceControlDiffComparisons,
  sourceControlFileStatusLabel,
  type SourceControlPanelView,
} from "./sourceControlPanel.logic";

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
}

export interface SourceControlPanelContentProps {
  readonly view: SourceControlPanelView;
  readonly onViewChange: (view: SourceControlPanelView) => void;
  readonly changes: ReactNode;
  readonly pullRequests: ReactNode;
}

/** Stable presentation shell kept separate so the panel's visual contract is easy to test. */
export function SourceControlPanelContent({
  view,
  onViewChange,
  changes,
  pullRequests,
}: SourceControlPanelContentProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-source-control-panel>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <GitBranchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="truncate text-sm font-semibold">Source Control</h2>
        </div>
        <div className="flex shrink-0 rounded-md bg-muted/60 p-0.5" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={view === "changes"}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              view === "changes"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onViewChange("changes")}
          >
            Changes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "pull-requests"}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              view === "pull-requests"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onViewChange("pull-requests")}
          >
            Pull requests
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col" data-source-control-view={view}>
        {view === "changes" ? changes : pullRequests}
      </div>
    </section>
  );
}

function commandError(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The Git operation failed.";
}

function fileKey(file: VcsWorkingTreeFile): string {
  return file.path;
}

type PendingIndexAction = Readonly<{
  path: string;
  kind: "stage" | "unstage";
}>;

function DiffPreview({
  diff,
  truncated,
  pending,
  error,
}: {
  readonly diff: string | null;
  readonly truncated: boolean;
  readonly pending: boolean;
  readonly error: string | null;
}) {
  if (pending) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground"
        role="status"
      >
        <Spinner className="size-3.5" aria-hidden />
        Loading diff...
      </div>
    );
  }
  if (error) {
    return (
      <p className="px-3 py-4 text-xs text-destructive" role="alert">
        {error}
      </p>
    );
  }
  if (diff === null || diff.trim().length === 0) {
    return <p className="px-3 py-4 text-xs text-muted-foreground">No changes for this file.</p>;
  }
  const lines = diff.split("\n");
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/20 px-3 py-2">
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => {
          const className = line.startsWith("+")
            ? "text-emerald-700 dark:text-emerald-300"
            : line.startsWith("-")
              ? "text-red-700 dark:text-red-300"
              : line.startsWith("@@")
                ? "text-blue-700 dark:text-blue-300"
                : "text-muted-foreground";
          return (
            <span className={className} key={`${index}:${line}`}>
              {line}
              {index < lines.length - 1 ? "\n" : null}
            </span>
          );
        })}
      </pre>
      {truncated ? (
        <p className="mt-2 text-[11px] text-warning">
          Diff truncated to keep the panel responsive.
        </p>
      ) : null}
    </div>
  );
}

function ChangesView({
  environmentId,
  threadId,
  cwd,
  envLocked,
  gitIndexWorkflowCapabilityKnown,
  supportsGitIndexWorkflow,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly envLocked: boolean;
  readonly gitIndexWorkflowCapabilityKnown: boolean;
  readonly supportsGitIndexWorkflow: boolean;
}) {
  const statusQuery = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const status = statusQuery.data;
  const files = status?.workingTree.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [requestedComparison, setRequestedComparison] = useState<"index" | "head">("head");
  const [commitMessage, setCommitMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingIndexAction | null>(null);
  const [commitPending, setCommitPending] = useState(false);

  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;
  const selectedComparisons =
    selectedFile === null ? [] : sourceControlDiffComparisons(selectedFile);
  const diffComparison =
    selectedFile !== null && selectedComparisons.includes(requestedComparison)
      ? requestedComparison
      : selectedFile !== null
        ? defaultSourceControlDiffComparison(selectedFile)
        : "head";
  useEffect(() => {
    if (selectedPath !== null && selectedFile === null) setSelectedPath(null);
  }, [selectedFile, selectedPath]);
  useEffect(() => {
    if (selectedFile !== null && requestedComparison !== diffComparison) {
      setRequestedComparison(diffComparison);
    }
  }, [diffComparison, requestedComparison, selectedFile]);

  const workflowAvailability = gitIndexWorkflowAvailability(
    gitIndexWorkflowCapabilityKnown,
    supportsGitIndexWorkflow,
  );
  const workflowAvailable = workflowAvailability === "available";

  const diffQuery = useEnvironmentQuery(
    workflowAvailable && selectedFile !== null && cwd !== null
      ? vcsEnvironment.getWorkingTreeDiffQuery({
          environmentId,
          input: { cwd, path: selectedFile.path, comparison: diffComparison },
        })
      : null,
  );
  const stage = useAtomCommand(vcsEnvironment.stageFiles, { reportFailure: false });
  const unstage = useAtomCommand(vcsEnvironment.unstageFiles, { reportFailure: false });
  const commit = useAtomCommand(vcsEnvironment.commitIndex, { reportFailure: false });
  const init = useAtomCommand(vcsEnvironment.init, { reportFailure: false });

  const runIndexAction = useCallback(
    async (file: VcsWorkingTreeFile, kind: "stage" | "unstage") => {
      if (cwd === null || !workflowAvailable) return;
      setPendingAction({ path: file.path, kind });
      setActionError(null);
      const result = await (kind === "unstage" ? unstage : stage)({
        environmentId,
        input: { cwd, paths: [file.path] },
      });
      setPendingAction(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setActionError(commandError(result));
      }
    },
    [cwd, environmentId, stage, unstage, workflowAvailable],
  );

  const runInit = useCallback(async () => {
    if (cwd === null) return;
    setActionError(null);
    const result = await init({ environmentId, input: { cwd } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setActionError(commandError(result));
    }
  }, [cwd, environmentId, init]);

  const submitCommit = useCallback(async () => {
    if (
      !workflowAvailable ||
      cwd === null ||
      status === null ||
      commitMessage.trim().length === 0
    ) {
      return;
    }
    const staged = files.some(isFileStaged);
    if (!staged || commitPending) return;
    if (status.isDefaultRef) {
      const api = readLocalApi();
      if (!api) {
        setActionError("Confirmation is unavailable in this client.");
        return;
      }
      const branch = status.refName ?? "the default branch";
      const confirmed = await api.dialogs.confirm(
        `Commit staged changes on \"${branch}\"?\nThis commits only files already staged in the Git index.`,
      );
      if (!confirmed) return;
    }
    setCommitPending(true);
    setActionError(null);
    const result = await commit({
      environmentId,
      input: { cwd, message: commitMessage.trim() },
    });
    setCommitPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) setActionError(commandError(result));
      return;
    }
    setCommitMessage("");
  }, [commit, commitMessage, commitPending, cwd, environmentId, files, status, workflowAvailable]);

  if (statusQuery.isPending && status === null) {
    return <div className="p-3 text-xs text-muted-foreground">Loading repository status...</div>;
  }
  if (statusQuery.error && status === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium">Could not load source control</p>
        <p className="text-xs text-destructive" role="alert">
          {statusQuery.error}
        </p>
        <Button size="sm" variant="outline" onClick={() => statusQuery.refresh()}>
          Retry
        </Button>
      </div>
    );
  }
  if (status?.isRepo === false) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <GitBranchIcon className="size-6 text-muted-foreground/60" aria-hidden />
        <div>
          <p className="text-sm font-medium">Source control is unavailable</p>
          <p className="mt-1 text-xs text-muted-foreground">
            This project is not a Git repository.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void runInit()}>
          Initialize Git repository
        </Button>
        {actionError ? (
          <p className="text-xs text-destructive" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    );
  }

  const stagedCount = files.filter(isFileStaged).length;
  const canCommit =
    workflowAvailable && stagedCount > 0 && commitMessage.trim().length > 0 && !commitPending;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border/70 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">Branch</p>
            <BranchToolbarBranchSelector
              className="mt-0.5"
              environmentId={environmentId}
              threadId={threadId}
              envLocked={envLocked}
              startFromOrigin={false}
              onStartFromOriginChange={() => undefined}
            />
          </div>
          <Button
            aria-label="Refresh source control"
            size="icon-xs"
            variant="ghost"
            onClick={() => statusQuery.refresh()}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            {files.length} {files.length === 1 ? "change" : "changes"}
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{status?.workingTree.insertions ?? 0}
          </span>
          <span className="text-red-600 dark:text-red-400">
            -{status?.workingTree.deletions ?? 0}
          </span>
          <span>{stagedCount} staged</span>
          {status?.aheadCount ? <span>{status.aheadCount} ahead</span> : null}
          {status?.behindCount ? <span>{status.behindCount} behind</span> : null}
        </div>
      </div>

      {workflowAvailability === "loading" ? (
        <p className="mx-3 mt-2 text-xs text-muted-foreground" role="status">
          Checking this server's Source Control capabilities...
        </p>
      ) : workflowAvailability === "unsupported" ? (
        <p className="mx-3 mt-2 text-xs text-muted-foreground">
          Update this environment's T3 Code server to review diffs, stage files, or commit from this
          panel.
        </p>
      ) : null}

      {actionError ? (
        <div
          className="mx-3 mt-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive"
          role="alert"
        >
          {actionError}
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {files.length === 0 ? (
          <p className="px-3 py-5 text-center text-xs text-muted-foreground">Working tree clean.</p>
        ) : (
          <div className="space-y-0.5 p-2">
            {files.map((file) => {
              const actions = fileActions(file);
              const selected = file.path === selectedPath;
              return (
                <div
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                    selected ? "bg-accent" : "hover:bg-accent/60",
                  )}
                  key={fileKey(file)}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      setSelectedPath(file.path);
                      setRequestedComparison(defaultSourceControlDiffComparison(file));
                    }}
                  >
                    <span className="block truncate">{file.path}</span>
                    <span className="mt-0.5 block font-sans text-[10px] text-muted-foreground">
                      {sourceControlFileStatusLabel(file.indexStatus)}
                      <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                        +{file.insertions}
                      </span>
                      <span className="ml-1 text-red-600 dark:text-red-400">-{file.deletions}</span>
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {actions.map((action) => {
                      if (action.kind === "unavailable") {
                        return (
                          <Button
                            key={action.kind}
                            size="xs"
                            variant="ghost"
                            disabled
                            title={action.reason}
                          >
                            {action.label}
                          </Button>
                        );
                      }
                      const kind = action.kind;
                      return (
                        <Button
                          key={kind}
                          size="xs"
                          variant={kind === "stage" ? "outline" : "ghost"}
                          disabled={!workflowAvailable || action.disabled || pendingAction !== null}
                          title={action.reason}
                          onClick={() => void runIndexAction(file, kind)}
                        >
                          {pendingAction?.path === file.path && pendingAction.kind === kind ? (
                            <Spinner className="size-3" aria-hidden />
                          ) : (
                            action.label
                          )}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {selectedFile ? (
          <div className="border-t border-border/70">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                {selectedFile.path}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {diffComparison === "index" ? "Staged vs HEAD" : "Working tree vs HEAD"}
              </span>
            </div>
            {selectedComparisons.length > 1 ? (
              <div
                className="flex items-center gap-1 border-t border-border/50 px-3 py-1.5"
                role="group"
                aria-label="Diff comparison"
              >
                <Button
                  size="xs"
                  variant={diffComparison === "index" ? "secondary" : "ghost"}
                  aria-pressed={diffComparison === "index"}
                  onClick={() => setRequestedComparison("index")}
                >
                  Staged
                </Button>
                <Button
                  size="xs"
                  variant={diffComparison === "head" ? "secondary" : "ghost"}
                  aria-pressed={diffComparison === "head"}
                  onClick={() => setRequestedComparison("head")}
                >
                  Working tree
                </Button>
              </div>
            ) : null}
            <DiffPreview
              diff={diffQuery.data?.diff ?? null}
              truncated={diffQuery.data?.truncated ?? false}
              pending={diffQuery.isPending}
              error={diffQuery.error}
            />
          </div>
        ) : null}
      </ScrollArea>

      <div className="shrink-0 border-t border-border/70 p-3">
        <label
          className="block text-xs font-medium text-muted-foreground"
          htmlFor="source-control-commit-message"
        >
          Commit staged changes
        </label>
        <Textarea
          id="source-control-commit-message"
          className="mt-1.5 min-h-16"
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.target.value)}
          placeholder="Message"
          disabled={commitPending}
          maxLength={10_000}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {stagedCount > 0
              ? `${stagedCount} file${stagedCount === 1 ? "" : "s"} staged`
              : "Stage files to commit"}
          </span>
          <Button size="sm" disabled={!canCommit} onClick={() => void submitCommit()}>
            <GitCommitIcon className="size-3.5" aria-hidden />
            {commitPending ? "Committing..." : "Commit"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PullRequestsView({
  environmentId,
  projectId,
  threadRef,
  supportsPullRequests,
  capabilityKnown,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadRef: ScopedThreadRef;
  readonly supportsPullRequests: boolean;
  readonly capabilityKnown: boolean;
}) {
  const targets = useMemo<ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>>(() => {
    if (!supportsPullRequests || projectId === null) return [];
    return [{ environmentId, input: { state: "open", involvement: "all", projectId, limit: 50 } }];
  }, [environmentId, projectId, supportsPullRequests]);
  const listQuery = usePullRequestList(targets);
  const [selected, setSelected] = useState<EnvironmentPullRequestEntry | null>(null);
  const entries = listQuery.data?.entries ?? [];
  useEffect(() => {
    if (
      selected &&
      !entries.some(
        (entry) =>
          entry.projectId === selected.projectId &&
          entry.repository === selected.repository &&
          entry.number === selected.number,
      )
    ) {
      setSelected(null);
    }
  }, [entries, selected]);

  if (!capabilityKnown) {
    return <PullRequestListGhost rows={5} />;
  }
  if (!supportsPullRequests) {
    return (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's T3 Code server to browse pull requests."
      />
    );
  }
  if (projectId === null) {
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        Open a project to browse pull requests.
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 max-h-56 shrink-0 flex-col overflow-y-auto border-b border-border/70 p-2">
        {listQuery.isPending && listQuery.data === null ? <PullRequestListGhost rows={4} /> : null}
        {listQuery.error && listQuery.data === null ? (
          <PullRequestsUnavailableState error={listQuery.error} onRetry={listQuery.refresh} />
        ) : null}
        {!listQuery.isPending && listQuery.error === null && entries.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            No open pull requests for this project.
          </p>
        ) : null}
        {entries.map((entry) => (
          <PullRequestRow
            key={`${entry.environmentId}:${entry.projectId}:${entry.repository}#${entry.number}`}
            entry={entry}
            selected={selected?.repository === entry.repository && selected.number === entry.number}
            showProjectTitle={false}
            showProvider={false}
            onSelect={setSelected}
          />
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {selected ? (
          <PullRequestDetailPanel
            key={`${selected.repository}#${selected.number}`}
            environmentId={selected.environmentId}
            reference={{
              projectId: selected.projectId,
              repository: selected.repository,
              number: selected.number,
            }}
            context="page"
            composerDraftTarget={threadRef}
            onActed={listQuery.refresh}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted-foreground">
            <GitPullRequestIcon className="size-5" aria-hidden />
            Select a pull request to review it.
          </div>
        )}
      </div>
    </div>
  );
}

export function SourceControlPanel(props: SourceControlPanelProps) {
  const changes = (
    <ChangesView
      environmentId={props.environmentId}
      threadId={props.threadId}
      cwd={props.cwd}
      envLocked={props.envLocked}
      gitIndexWorkflowCapabilityKnown={props.gitIndexWorkflowCapabilityKnown}
      supportsGitIndexWorkflow={props.supportsGitIndexWorkflow}
    />
  );
  const pullRequests = (
    <PullRequestsView
      environmentId={props.environmentId}
      projectId={props.projectId}
      threadRef={props.threadRef}
      supportsPullRequests={props.supportsPullRequests}
      capabilityKnown={props.pullRequestsCapabilityKnown}
    />
  );
  return (
    <SourceControlPanelContent
      view={props.view}
      onViewChange={props.onViewChange}
      changes={changes}
      pullRequests={pullRequests}
    />
  );
}
