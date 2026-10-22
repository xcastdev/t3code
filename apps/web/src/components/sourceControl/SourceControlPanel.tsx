import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { sourceControlRepositoryKey } from "@t3tools/client-runtime/state/source-control-workspace";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EditorId,
  EnvironmentId,
  GitCommitStagedResult,
  GitHistoryResult,
  GitIndexStatusResult,
} from "@t3tools/contracts";
import { FileDiff } from "@pierre/diffs/react";
import { ExternalLinkIcon, GitBranchIcon, MinusIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { type AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { useOpenInPreferredEditor } from "~/editorPreferences";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { getRenderablePatch, resolveDiffThemeName, resolveFileDiffPath } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn, randomUUID } from "~/lib/utils";
import {
  buildHistoryGraph,
  COMMIT_BLOCKER_LABELS,
  commitOutcomePresentation,
  indexMutationPaths,
  joinRepositoryPath,
  repositoryDisplayName,
  resolveSelectedRepositoryRoot,
  shortBranchName,
  SOURCE_CONTROL_HISTORY_PAGE_SIZE,
  SOURCE_CONTROL_VISIBLE_FILE_LIMIT,
  stagedCommitBlocker,
  type HistoryGraphRow,
  type SourceControlHistoryPageResult,
  type SourceControlIndexGroup,
  useSourceControlWorkspaceStore,
  workspaceRelativeRepositoryPath,
} from "~/sourceControlWorkspace";
import { useEnvironmentPresentation } from "~/state/presentation";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { sourceControlWorkspaceEnvironment } from "~/state/sourceControlWorkspace";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { DIFF_VIEW_UNSAFE_CSS } from "../diffs/StyledDiffCodeView";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const HISTORY_REQUEST_TIMEOUT_MS = 30_000;
const GRAPH_LANE_WIDTH = 10;
const GRAPH_ROW_HEIGHT = 28;
const GRAPH_MAX_LANES = 8;

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Settles one history page. A result that was already cached is refetched once, so a
 * page always reflects the repository after the request started.
 */
function awaitFreshQuery<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Promise<AsyncResult.AsyncResult<A, E> | null> {
  return new Promise((resolve) => {
    let settled = false;
    let sawFetch = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (value: AsyncResult.AsyncResult<A, E> | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      unsubscribe?.();
      resolve(value);
    };
    const timeout = globalThis.setTimeout(() => finish(null), HISTORY_REQUEST_TIMEOUT_MS);
    unsubscribe = registry.subscribe(
      atom,
      (result) => {
        if (result.waiting || result._tag === "Initial") {
          sawFetch = true;
          return;
        }
        if (!sawFetch) {
          sawFetch = true;
          registry.refresh(atom);
          return;
        }
        finish(result);
      },
      { immediate: true },
    );
    if (settled) unsubscribe();
  });
}

async function fetchHistoryPage(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  rootPath: string,
  cursor: string | undefined,
): Promise<SourceControlHistoryPageResult> {
  const atom = sourceControlWorkspaceEnvironment.history({
    environmentId,
    input:
      cursor === undefined
        ? { cwd: rootPath, limit: SOURCE_CONTROL_HISTORY_PAGE_SIZE }
        : { cwd: rootPath, cursor, limit: SOURCE_CONTROL_HISTORY_PAGE_SIZE },
  });
  const result = await awaitFreshQuery(registry, atom);
  if (result === null) return { _tag: "Failed", message: "History took too long to load." };
  if (result._tag === "Success") return { _tag: "Page", page: result.value };
  return { _tag: "Failed", message: "Couldn't load history from this environment." };
}

export interface SourceControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly availableEditors: ReadonlyArray<EditorId>;
  /** Opens a workspace-relative path in the panel's file tabs. */
  readonly onOpenFile: (relativePath: string) => void;
}

export default function SourceControlPanel(props: SourceControlPanelProps) {
  const { environmentId, workspaceRoot } = props;
  const [view, setView] = useState<"changes" | "history">("changes");
  const discovery = useEnvironmentQuery(
    sourceControlWorkspaceEnvironment.discoverRepositories({
      environmentId,
      input: { cwd: workspaceRoot },
    }),
  );
  const workspace = { environmentId, workspaceRoot };
  const selected = useSourceControlWorkspaceStore(
    (state) => state.selectedRootByWorkspace[JSON.stringify([environmentId, workspaceRoot])],
  );
  const rootPath = resolveSelectedRepositoryRoot(discovery.data, selected);
  const historyGeneration = useSourceControlWorkspaceStore((state) =>
    rootPath === null
      ? 0
      : (state.historyGenerationByRepository[
          sourceControlRepositoryKey({ environmentId, rootPath })
        ] ?? 0),
  );
  const outermostRoot = resolveSelectedRepositoryRoot(discovery.data, undefined);
  const status = useEnvironmentQuery(
    rootPath === null
      ? null
      : sourceControlWorkspaceEnvironment.indexStatus({
          environmentId,
          input: { cwd: rootPath },
        }),
  );
  const openInEditor = useOpenInPreferredEditor(environmentId, props.availableEditors);
  const registry = useContext(RegistryContext);
  const branch = shortBranchName(status.data?.fingerprint.headRef ?? null);
  const repositories = discovery.data?.repositories ?? [];

  const header = (
    <div
      className="flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 px-2"
      data-surface-subheader
    >
      {repositories.length > 1 ? (
        <Select
          value={rootPath ?? ""}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            useSourceControlWorkspaceStore.getState().selectRoot(workspace, value);
          }}
        >
          <SelectTrigger size="sm" className="min-w-0 max-w-56" aria-label="Repository">
            <SelectValue>
              {rootPath === null ? "Repository" : repositoryDisplayName(rootPath, outermostRoot)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {repositories.map((repository) => (
              <SelectItem key={repository.rootPath} value={repository.rootPath}>
                {repositoryDisplayName(repository.rootPath, outermostRoot)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : rootPath !== null ? (
        <span className="min-w-0 truncate text-sm font-medium">
          {repositoryDisplayName(rootPath, outermostRoot)}
        </span>
      ) : null}
      {branch !== null ? (
        <span className="flex min-w-0 items-center gap-1 truncate text-xs text-muted-foreground">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : status.data ? (
        <span className="text-xs text-warning">Detached HEAD</span>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <ToggleGroup
          aria-label="Source control view"
          variant="segmented"
          value={[view]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "changes" || next === "history") setView(next);
          }}
        >
          <Toggle value="changes">Changes</Toggle>
          <Toggle value="history">History</Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Refresh source control"
                disabled={rootPath === null}
                onClick={() => {
                  discovery.refresh();
                  if (rootPath !== null) {
                    sourceControlWorkspaceEnvironment.refresh(
                      { environmentId, rootPath },
                      registry,
                    );
                    useSourceControlWorkspaceStore
                      .getState()
                      .refreshHistory({ environmentId, rootPath });
                  }
                }}
              />
            }
          >
            <RefreshCwIcon />
          </TooltipTrigger>
          <TooltipPopup>Refresh</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Open repository in editor"
                disabled={rootPath === null || props.availableEditors.length === 0}
                onClick={() => {
                  if (rootPath !== null) void openInEditor(rootPath);
                }}
              />
            }
          >
            <ExternalLinkIcon />
          </TooltipTrigger>
          <TooltipPopup>Open repository in editor</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );

  let body;
  if (discovery.data === null) {
    body = (
      <PanelMessage tone={discovery.error ? "error" : "muted"}>
        {discovery.error ?? "Looking for repositories…"}
      </PanelMessage>
    );
  } else if (rootPath === null) {
    body = <PanelMessage tone="muted">No Git repository in this workspace.</PanelMessage>;
  } else if (view === "changes") {
    body = (
      <ChangesView
        key={sourceControlRepositoryKey({ environmentId, rootPath })}
        environmentId={environmentId}
        rootPath={rootPath}
        workspaceRoot={workspaceRoot}
        status={status.data}
        statusError={status.error}
        statusRefreshing={status.isPending}
        onOpenFile={props.onOpenFile}
        onOpenInEditor={(path) => void openInEditor(path)}
        editorAvailable={props.availableEditors.length > 0}
      />
    );
  } else {
    body = (
      <HistoryView
        // A new HEAD or an explicit refresh starts a new history chain from the first page.
        key={`${sourceControlRepositoryKey({ environmentId, rootPath })}:${
          status.data?.fingerprint.headRef ?? ""
        }:${status.data?.fingerprint.headCommit ?? ""}:${historyGeneration}`}
        environmentId={environmentId}
        rootPath={rootPath}
      />
    );
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {header}
      {discovery.data?.truncated ? (
        <p className="border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          Showing the first repositories found. Open a nested folder as a project to reach the rest.
        </p>
      ) : null}
      {body}
    </div>
  );
}

function PanelMessage(props: { readonly tone: "muted" | "error"; readonly children: string }) {
  return (
    <div
      role={props.tone === "error" ? "alert" : "status"}
      className={cn(
        "flex flex-1 items-center justify-center p-6 text-center text-sm",
        props.tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {props.children}
    </div>
  );
}

type IndexFile = GitIndexStatusResult["staged"][number];

function ChangesView(props: {
  readonly environmentId: EnvironmentId;
  readonly rootPath: string;
  readonly workspaceRoot: string;
  readonly status: GitIndexStatusResult | null;
  readonly statusError: string | null;
  readonly statusRefreshing: boolean;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenInEditor: (absolutePath: string) => void;
  readonly editorAvailable: boolean;
}) {
  const { environmentId, rootPath, status } = props;
  const allowed = useAtomValue(
    sourceControlWorkspaceEnvironment.mutateIndex.permissionAtom(environmentId),
  );
  const mutateIndex = useAtomCommand(sourceControlWorkspaceEnvironment.mutateIndex, {
    reportFailure: false,
  });
  const commitStaged = useAtomCommand(sourceControlWorkspaceEnvironment.commitStaged, {
    reportFailure: false,
  });
  const push = useGitStackedAction({ environmentId, cwd: rootPath });
  const [message, setMessage] = useState("");
  const [pushAfterCommit, setPushAfterCommit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCommit, setLastCommit] = useState<GitCommitStagedResult | null>(null);
  const [pushRetry, setPushRetry] = useState<PushRetryState>({ state: "idle" });

  if (status === null) {
    return (
      <PanelMessage tone={props.statusError ? "error" : "muted"}>
        {props.statusError ?? "Reading changes…"}
      </PanelMessage>
    );
  }

  // The reviewed fingerprint goes with every mutation; while a refresh is in flight the
  // one on screen may already be out of date, so actions wait for it.
  const actionsLocked = busy || props.statusRefreshing || !allowed;

  const runIndexMutation = async (action: "stage" | "unstage", paths: ReadonlyArray<string>) => {
    if (actionsLocked || paths.length === 0) return;
    setBusy(true);
    setError(null);
    const result = await mutateIndex({
      environmentId,
      input: { cwd: status.fingerprint.rootPath, expected: status.fingerprint, action, paths },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(
        failureMessage(
          squashAtomCommandFailure(result),
          action === "stage" ? "Couldn't stage those files." : "Couldn't unstage those files.",
        ),
      );
    }
  };

  const blocker = stagedCommitBlocker({
    status,
    statusStale: props.statusRefreshing,
    message,
    busy,
    allowed,
  });

  const commit = async () => {
    if (blocker !== null) return;
    setBusy(true);
    setError(null);
    setLastCommit(null);
    setPushRetry({ state: "idle" });
    const result = await commitStaged({
      environmentId,
      input: {
        cwd: status.fingerprint.rootPath,
        expected: status.fingerprint,
        message: message.trim(),
        ...(pushAfterCommit ? { push: true } : {}),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setMessage("");
      setLastCommit(result.value);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(failureMessage(squashAtomCommandFailure(result), "Couldn't commit staged changes."));
    }
  };

  const retryPush = async () => {
    if (lastCommit === null || !commitOutcomePresentation(lastCommit).canRetryPush) return;
    setPushRetry({ state: "running" });
    // Pushes the retained branch and commit, never whatever HEAD is checked out now.
    const result = await push.run({
      actionId: randomUUID(),
      action: "push",
      reviewedPush: { branchRef: lastCommit.branchRef, commitSha: lastCommit.commitSha },
    });
    if (result._tag === "Success") {
      setLastCommit((current) =>
        current === null || current.commitSha !== lastCommit.commitSha
          ? current
          : { ...current, push: "succeeded", recovery: null },
      );
      setPushRetry({ state: "idle" });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setPushRetry({ state: "idle" });
      return;
    }
    setPushRetry({
      state: "failed",
      message: failureMessage(squashAtomCommandFailure(result), "Push failed again."),
    });
  };

  const groupProps = {
    rootPath,
    workspaceRoot: props.workspaceRoot,
    locked: actionsLocked,
    editorAvailable: props.editorAvailable,
    onOpenFile: props.onOpenFile,
    onOpenInEditor: props.onOpenInEditor,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <IndexGroup
          {...groupProps}
          group="staged"
          files={status.staged}
          onMutate={(paths) => void runIndexMutation("unstage", paths)}
          onMutateAll={() => void runIndexMutation("unstage", indexMutationPaths(status, "staged"))}
        />
        <IndexGroup
          {...groupProps}
          group="unstaged"
          files={status.unstaged}
          onMutate={(paths) => void runIndexMutation("stage", paths)}
          onMutateAll={() => void runIndexMutation("stage", indexMutationPaths(status, "unstaged"))}
        />
        {status.staged.length === 0 && status.unstaged.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No changes in this repository.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 p-2">
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {lastCommit ? (
          <CommitOutcome
            result={lastCommit}
            currentHeadRef={status.fingerprint.headRef}
            pushRetry={pushRetry}
            onRetryPush={() => void retryPush()}
          />
        ) : null}
        <Textarea
          size="sm"
          aria-label="Commit message"
          placeholder="Commit message"
          value={message}
          disabled={!allowed}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void commit();
            }
          }}
        />
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={pushAfterCommit}
              onChange={(event) => setPushAfterCommit(event.target.checked)}
            />
            Push after commit
          </label>
          <span className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
            {blocker !== null && blocker !== "no-message" ? COMMIT_BLOCKER_LABELS[blocker] : null}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="inline-flex">
                  <Button size="xs" disabled={blocker !== null} onClick={() => void commit()}>
                    {pushAfterCommit ? "Commit staged & push" : "Commit staged"}
                  </Button>
                </span>
              }
            />
            <TooltipPopup side="top">
              Commits only what is staged. Repository hooks don't run for this commit.
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

type PushRetryState =
  | { readonly state: "idle" | "running" }
  | { readonly state: "failed"; readonly message: string };

function CommitOutcome(props: {
  readonly result: GitCommitStagedResult;
  readonly currentHeadRef: string | null;
  readonly pushRetry: PushRetryState;
  readonly onRetryPush: () => void;
}) {
  const sha = props.result.commitSha.slice(0, 7);
  const branch = shortBranchName(props.result.branchRef) ?? props.result.branchRef;
  const outcome = commitOutcomePresentation(props.result);
  const checkoutMoved = outcome.checkoutMoved || props.currentHeadRef !== props.result.branchRef;
  return (
    <div role="status" className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1">
        {outcome.pushed ? "Committed and pushed " : "Committed "}
        <span className="font-mono">{sha}</span> to <span className="font-medium">{branch}</span>.
        {outcome.pushFailed ? " The push didn't finish; the commit is kept." : null}
        {checkoutMoved ? (
          <span className="text-warning">
            {" "}
            The checkout is no longer on {branch}. Check out {branch} again before committing more.
          </span>
        ) : null}
        {props.pushRetry.state === "failed" ? (
          <span className="text-destructive"> {props.pushRetry.message}</span>
        ) : null}
      </span>
      {outcome.canRetryPush ? (
        <Button
          size="xs"
          variant="outline"
          disabled={props.pushRetry.state === "running"}
          onClick={props.onRetryPush}
        >
          {props.pushRetry.state === "running" ? "Pushing…" : `Push ${branch}`}
        </Button>
      ) : null}
    </div>
  );
}

function IndexGroup(props: {
  readonly group: SourceControlIndexGroup;
  readonly files: ReadonlyArray<IndexFile>;
  readonly rootPath: string;
  readonly workspaceRoot: string;
  readonly locked: boolean;
  readonly editorAvailable: boolean;
  readonly onMutate: (paths: ReadonlyArray<string>) => void;
  readonly onMutateAll: () => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onOpenInEditor: (absolutePath: string) => void;
}) {
  if (props.files.length === 0) return null;
  const staged = props.group === "staged";
  const visible = props.files.slice(0, SOURCE_CONTROL_VISIBLE_FILE_LIMIT);
  const hidden = props.files.length - visible.length;
  const MutateIcon = staged ? MinusIcon : PlusIcon;
  return (
    <section aria-label={staged ? "Staged changes" : "Changes"}>
      <div className="sticky top-0 z-1 flex h-8 items-center gap-2 bg-background px-3 text-xs font-medium text-muted-foreground">
        <span>{staged ? "Staged" : "Changes"}</span>
        <span className="tabular-nums">{props.files.length}</span>
        <Button
          className="ml-auto"
          size="micro"
          variant="ghost-muted"
          disabled={props.locked}
          onClick={props.onMutateAll}
        >
          {staged ? "Unstage all" : "Stage all"}
        </Button>
      </div>
      <ul>
        {visible.map((file) => {
          const relativePath = workspaceRelativeRepositoryPath(
            props.workspaceRoot,
            props.rootPath,
            file.path,
          );
          const deleted = file.status.startsWith("D");
          return (
            <li
              key={file.path}
              className="group flex h-7 items-center gap-2 px-3 text-sm hover:bg-accent/40"
            >
              <span
                className={cn(
                  "w-5 shrink-0 font-mono text-xs",
                  deleted
                    ? "text-destructive"
                    : file.status.startsWith("A") || file.status === "??"
                      ? "text-success"
                      : "text-warning",
                )}
                aria-label={`Status ${file.status}`}
              >
                {file.status}
              </span>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left outline-none focus-visible:underline disabled:cursor-default"
                disabled={deleted || (relativePath === null && !props.editorAvailable)}
                onClick={() => {
                  if (relativePath !== null) props.onOpenFile(relativePath);
                  else props.onOpenInEditor(joinRepositoryPath(props.rootPath, file.path));
                }}
              >
                {file.path}
              </button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
                disabled={props.locked}
                onClick={() => props.onMutate([file.path])}
              >
                <MutateIcon />
              </Button>
            </li>
          );
        })}
      </ul>
      {hidden > 0 ? (
        <p className="px-3 py-1 text-xs text-muted-foreground">
          {hidden} more {hidden === 1 ? "file" : "files"} not shown.
        </p>
      ) : null}
    </section>
  );
}

function HistoryView(props: { readonly environmentId: EnvironmentId; readonly rootPath: string }) {
  const { environmentId, rootPath } = props;
  const registry = useContext(RegistryContext);
  const key = sourceControlRepositoryKey({ environmentId, rootPath });
  const entry = useSourceControlWorkspaceStore((state) => state.historyByRepository[key] ?? null);
  const phase = useEnvironmentPresentation(environmentId).presentation?.connection.phase;
  const disconnected = phase !== undefined && phase !== "connected";
  const [selectedSha, setSelectedSha] = useState<string | null>(null);

  const load = (mode: "reset" | "more") =>
    useSourceControlWorkspaceStore
      .getState()
      .loadHistory({ environmentId, rootPath }, mode, (cursor) =>
        fetchHistoryPage(registry, environmentId, rootPath, cursor),
      );

  // Reconnecting starts a new chain even when HEAD did not move: refs, tags and remotes
  // the history includes may have changed while the connection was down.
  useEffect(() => {
    const store = useSourceControlWorkspaceStore.getState();
    if (disconnected) {
      store.disconnectHistory({ environmentId, rootPath });
      return;
    }
    void store.loadHistory({ environmentId, rootPath }, "reset", (cursor) =>
      fetchHistoryPage(registry, environmentId, rootPath, cursor),
    );
  }, [environmentId, rootPath, registry, disconnected]);

  const history = entry?.history ?? null;
  const commits = history?.commits ?? [];
  const graph = buildHistoryGraph(commits);
  const graphLanes = Math.min(graph.laneCount, GRAPH_MAX_LANES);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul aria-label="Commit history">
          {commits.map((commit, index) => {
            const row = graph.rows[index]!;
            const selected = selectedSha === commit.sha;
            return (
              <li key={commit.sha}>
                <button
                  type="button"
                  aria-expanded={selected}
                  className={cn(
                    "flex h-7 w-full items-center gap-2 pr-3 text-left text-sm outline-none hover:bg-accent/40 focus-visible:bg-accent/40",
                    selected && "bg-accent/60",
                  )}
                  onClick={() => setSelectedSha(selected ? null : commit.sha)}
                >
                  <HistoryGraphCell row={row} lanes={graphLanes} />
                  <span className="min-w-0 flex-1 truncate">{commit.subject}</span>
                  <span className="hidden shrink-0 truncate text-xs text-muted-foreground @min-[28rem]:inline">
                    {commit.author}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTimeLabel(commit.authoredAt)}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {commit.sha.slice(0, 7)}
                  </span>
                </button>
                {selected ? (
                  <CommitDiff
                    environmentId={environmentId}
                    rootPath={rootPath}
                    commitSha={commit.sha}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        <HistoryFooter
          history={history}
          error={entry?.error ?? null}
          onReload={() => void load("reset")}
          onLoadMore={() => void load("more")}
        />
      </div>
    </div>
  );
}

function HistoryFooter(props: {
  readonly history: {
    readonly loading: boolean;
    readonly stale: boolean;
    readonly nextCursor: string | null;
    readonly commits: GitHistoryResult["commits"];
  } | null;
  readonly error: string | null;
  readonly onReload: () => void;
  readonly onLoadMore: () => void;
}) {
  const history = props.history;
  if (history === null || history.loading) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">Loading history…</p>;
  }
  if (history.stale) {
    return (
      <div className="flex items-center gap-2 px-3 py-3 text-xs">
        <span className={props.error ? "text-destructive" : "text-muted-foreground"}>
          {props.error ?? "History changed while it was loading."}
        </span>
        <Button size="xs" variant="outline" onClick={props.onReload}>
          Reload
        </Button>
      </div>
    );
  }
  if (history.nextCursor !== null) {
    return (
      <div className="px-3 py-2">
        <Button size="xs" variant="ghost-muted" onClick={props.onLoadMore}>
          Load more
        </Button>
      </div>
    );
  }
  return history.commits.length === 0 ? (
    <p className="px-3 py-3 text-xs text-muted-foreground">No commits yet.</p>
  ) : history.commits.length >= 500 ? (
    <p className="px-3 py-3 text-xs text-muted-foreground">Showing the latest 500 commits.</p>
  ) : null;
}

function HistoryGraphCell(props: { readonly row: HistoryGraphRow; readonly lanes: number }) {
  const width = Math.max(props.lanes, 1) * GRAPH_LANE_WIDTH + 6;
  const x = (lane: number) => Math.min(lane, GRAPH_MAX_LANES - 1) * GRAPH_LANE_WIDTH + 8;
  const middle = GRAPH_ROW_HEIGHT / 2;
  const node = x(props.row.lane);
  return (
    <svg
      aria-hidden
      className="shrink-0 text-muted-foreground"
      width={width}
      height={GRAPH_ROW_HEIGHT}
      viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
    >
      {props.row.segments.map((segment) => {
        const fromX = segment.from === null ? node : x(segment.from);
        const toX = segment.to === null ? node : x(segment.to);
        const fromY = segment.from === null ? middle : 0;
        const toY = segment.to === null ? middle : GRAPH_ROW_HEIGHT;
        return (
          <line
            key={`${segment.from ?? "n"}-${segment.to ?? "n"}`}
            x1={fromX}
            y1={fromY}
            x2={toX}
            y2={toY}
            stroke="currentColor"
            strokeWidth={1.25}
          />
        );
      })}
      <circle cx={node} cy={middle} r={3} className="fill-foreground" />
    </svg>
  );
}

function CommitDiff(props: {
  readonly environmentId: EnvironmentId;
  readonly rootPath: string;
  readonly commitSha: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const resolvedTheme = useRenderedAppearance();
  const commitDiff = useEnvironmentQuery(
    sourceControlWorkspaceEnvironment.historyDiff({
      environmentId: props.environmentId,
      input: { cwd: props.rootPath, commitSha: props.commitSha },
    }),
  );
  // A truncated commit patch may cut a file short, so a selected file is fetched alone.
  const fileDiff = useEnvironmentQuery(
    commitDiff.data?.truncated && selectedPath !== null
      ? sourceControlWorkspaceEnvironment.historyDiff({
          environmentId: props.environmentId,
          input: { cwd: props.rootPath, commitSha: props.commitSha, path: selectedPath },
        })
      : null,
  );
  if (commitDiff.data === null) {
    return (
      <p
        className={cn(
          "px-3 py-2 text-xs",
          commitDiff.error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {commitDiff.error ?? "Loading changes…"}
      </p>
    );
  }
  const patch = getRenderablePatch(commitDiff.data.patch, `source-control:${props.commitSha}`);
  if (patch === null) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">No file changes.</p>;
  }
  if (patch.kind === "raw") {
    return <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-xs">{patch.text}</pre>;
  }
  const filePatch =
    selectedPath === null
      ? null
      : commitDiff.data.truncated
        ? getRenderablePatch(
            fileDiff.data?.patch,
            `source-control:${props.commitSha}:${selectedPath}`,
          )
        : patch;
  const selectedFile =
    filePatch?.kind === "files"
      ? (filePatch.files.find((file) => resolveFileDiffPath(file) === selectedPath) ?? null)
      : null;
  return (
    <div className="border-y border-border/60 bg-muted/20">
      <ul aria-label="Files in this commit">
        {patch.files.map((file) => {
          const path = resolveFileDiffPath(file);
          return (
            <li key={path}>
              <button
                type="button"
                aria-expanded={selectedPath === path}
                className={cn(
                  "flex h-6 w-full items-center px-6 text-left font-mono text-xs outline-none hover:bg-accent/40 focus-visible:bg-accent/40",
                  selectedPath === path && "bg-accent/60",
                )}
                onClick={() => setSelectedPath(selectedPath === path ? null : path)}
              >
                <span className="truncate">{path}</span>
              </button>
              {selectedPath === path ? (
                selectedFile ? (
                  <DiffWorkerPoolProvider>
                    <FileDiff
                      fileDiff={selectedFile}
                      options={{
                        diffStyle: "unified",
                        lineDiffType: "none",
                        overflow: "scroll",
                        disableFileHeader: true,
                        theme: resolveDiffThemeName(resolvedTheme),
                        themeType: resolvedTheme,
                        preferredHighlighter: PREFERRED_HIGHLIGHTER,
                        unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
                      }}
                    />
                  </DiffWorkerPoolProvider>
                ) : (
                  <p className="px-6 py-2 text-xs text-muted-foreground">
                    {fileDiff.error ?? "Loading diff…"}
                  </p>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      {commitDiff.data.truncated ? (
        <p className="px-6 py-1 text-xs text-muted-foreground">
          This commit is large; some files may be listed only partly.
        </p>
      ) : null}
    </div>
  );
}
