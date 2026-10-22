import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  captureHistorySelection,
  historySelectionIsCurrent,
  prepareHistoryFileRetry,
  prepareHistoryMutation,
  type HistorySelection,
} from "@t3tools/client-runtime/state/thread-history";
import {
  AVAILABILITY_LABELS,
  FILE_STATUS_LABELS,
  HISTORY_DETAIL_PAGE_SIZE,
  HISTORY_LIST_PAGE_SIZE,
  RETENTION_LABELS,
  archiveAvailability,
  deriveArchiveDetailView,
  describeArchiveReason,
  describeHistoryFailure,
  historyActionBlocker,
  historyFileRetryBlocker,
  mergeListPages,
  nextListCursor,
  savedEffortLabel,
  type ArchiveDetailView,
  type HistoryAction,
} from "@t3tools/client-runtime/state/thread-history-presentation";
import {
  CommandId,
  MessageId,
  ThreadId,
  type CheckpointId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadHistoryArchiveHeader,
  type ThreadHistoryFileRestoreStatusResult,
  type ThreadHistoryRecoverInput,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { create } from "zustand";

import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "../../localApi";
import { readThreadShell } from "../../state/entities";
import { formatEnvironmentQueryError } from "../../state/query";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { createHistorySelectionOwner, type HistorySelectionOwner } from "./historySelectionOwner";
import { threadHistoryEnvironment } from "./threadHistoryState";

type Header = typeof ThreadHistoryArchiveHeader.Type;

const useRequest = create<{ target: ScopedThreadRef | null }>(() => ({ target: null }));

/** Opens the read-only archive browser; nothing is sent until the user picks an action. */
export function requestThreadHistory(target: ScopedThreadRef) {
  useRequest.setState({ target });
}

export function ThreadHistoryDialogHost() {
  const target = useRequest((state) => state.target);
  if (!target) return null;
  return (
    <ThreadHistoryDialog
      key={`${target.environmentId}:${target.threadId}`}
      target={target}
      onClose={() => useRequest.setState({ target: null })}
    />
  );
}

function useHistoryConnection(environmentId: EnvironmentId) {
  const result = useAtomValue(threadHistoryEnvironment.connection(environmentId));
  return Option.getOrNull(AsyncResult.value(result)) ?? { connected: false, epoch: null };
}

function readLiveEpoch(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const connection = Option.getOrNull(
    AsyncResult.value(registry.get(threadHistoryEnvironment.connection(environmentId))),
  );
  return connection?.connected ? connection.epoch : null;
}

function ThreadHistoryDialog(props: {
  readonly target: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = props.target;
  const connection = useHistoryConnection(environmentId);
  const [owner] = useState(createHistorySelectionOwner);
  const [cursors, setCursors] = useState<ReadonlyArray<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<HistorySelection | null>(null);
  useEffect(() => {
    owner.activate(selected);
    return () => owner.release();
  }, [owner, selected]);
  // Released before the state change so a result landing before the next commit is already stale.
  const choose = (next: HistorySelection) => {
    owner.release();
    setSelected(next);
  };
  const close = () => {
    owner.release();
    props.onClose();
  };
  // One derived atom per cursor list keeps every loaded page mounted and refreshed together.
  const pagesAtom = Atom.make((get) =>
    cursors.map((before) =>
      get(
        threadHistoryEnvironment.list({
          environmentId,
          input: {
            threadId,
            limit: HISTORY_LIST_PAGE_SIZE,
            ...(before === undefined ? {} : { before }),
          },
        }),
      ),
    ),
  );
  const pages = useAtomValue(pagesAtom);
  const pageValues = pages.map((page) => Option.getOrNull(AsyncResult.value(page)));
  const headers = mergeListPages(pageValues);
  const loading = pages.some((page) => page.waiting);
  const failure = pages.find((page) => page._tag === "Failure");
  const older = nextListCursor(pageValues);
  const current: HistorySelection | null =
    selected && connection.epoch !== null
      ? { ...selected, connectionEpoch: connection.epoch }
      : null;
  const selectedHeader = selected
    ? (headers.find((header) => header.archive_id === selected.archiveId) ?? null)
    : null;
  const title = readThreadShell(props.target)?.title ?? "Thread";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Archived snapshots of “{title}” kept before rollbacks and file restores. Restoring adds
            the archived context as a message; it does not rewind the provider or change files.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid min-h-0 gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-1">
              {!connection.connected ? (
                <p className="text-muted-foreground text-xs">
                  Offline. Showing the last loaded archives.
                </p>
              ) : null}
              {headers.length === 0 && !loading && !failure ? (
                <p className="text-muted-foreground text-sm">No archived history.</p>
              ) : null}
              {headers.map((header) => (
                <ArchiveRow
                  key={header.archive_id}
                  environmentId={environmentId}
                  header={header}
                  active={selected?.archiveId === header.archive_id}
                  onSelect={() => {
                    if (connection.epoch === null) return;
                    choose(
                      captureHistorySelection({
                        environmentId,
                        threadId,
                        archiveId: header.archive_id,
                        connectionEpoch: connection.epoch,
                      }),
                    );
                  }}
                />
              ))}
              {failure && failure._tag === "Failure" ? (
                <p className="text-destructive-foreground text-xs">
                  {formatEnvironmentQueryError(failure.cause)}
                </p>
              ) : null}
              {older ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loading}
                  onClick={() => setCursors((previous) => [...previous, older])}
                >
                  Older archives
                </Button>
              ) : null}
            </div>
            <div className="min-w-0">
              {selected && selectedHeader ? (
                <ArchiveDetail
                  key={selected.archiveId}
                  header={selectedHeader}
                  selected={selected}
                  current={current}
                  owner={owner}
                  connected={connection.connected}
                  onReviewAgain={() => {
                    if (connection.epoch === null) return;
                    choose(
                      captureHistorySelection({ ...selected, connectionEpoch: connection.epoch }),
                    );
                  }}
                  onClose={close}
                />
              ) : (
                <p className="text-muted-foreground pt-1 text-sm">
                  {connection.connected
                    ? "Select an archive to review what it kept."
                    : "Reconnect to review an archive."}
                </p>
              )}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function availabilityVariant(header: Header) {
  switch (archiveAvailability(header)) {
    case "available":
      return "outline" as const;
    case "uncertain":
      return "warning" as const;
    default:
      return "secondary" as const;
  }
}

function ArchiveRow(props: {
  readonly environmentId: EnvironmentId;
  readonly header: Header;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { header } = props;
  const mutation = useAtomValue(
    threadHistoryEnvironment.mutationState({
      environmentId: props.environmentId,
      threadId: header.thread_id,
      archiveId: header.archive_id,
    }),
  );
  return (
    <Button
      variant={props.active ? "secondary" : "ghost"}
      size="sm-multiline"
      className="justify-start"
      aria-pressed={props.active}
      onClick={props.onSelect}
    >
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
        <span className="truncate text-sm">{describeArchiveReason(header)}</span>
        <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {formatTimestamp(header.created_at)}
          <Badge variant={availabilityVariant(header)} size="sm">
            {AVAILABILITY_LABELS[archiveAvailability(header)]}
          </Badge>
          {mutation.filesUncertain ? (
            <Badge variant="warning" size="sm">
              Files unknown
            </Badge>
          ) : null}
          {mutation.recoveryUncertain ? (
            <Badge variant="warning" size="sm">
              Unconfirmed
            </Badge>
          ) : null}
        </span>
      </span>
    </Button>
  );
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function useArchiveDetail(selected: HistorySelection) {
  const [cursors, setCursors] = useState<ReadonlyArray<number | undefined>>([undefined]);
  const pagesAtom = Atom.make((get) =>
    cursors.map((after) =>
      get(
        threadHistoryEnvironment.detail({
          environmentId: selected.environmentId,
          input: {
            threadId: selected.threadId,
            archiveId: selected.archiveId,
            limit: HISTORY_DETAIL_PAGE_SIZE,
            ...(after === undefined ? {} : { after }),
          },
        }),
      ),
    ),
  );
  const pages = useAtomValue(pagesAtom);
  const values = pages.map((page) => Option.getOrNull(AsyncResult.value(page)));
  const last = values.at(-1) ?? null;
  const loaded = values.every((value) => value !== null);
  // The newest page carries the server's current owner and retained-ref answer.
  const capabilities = last?.capabilities ?? null;
  const view: ArchiveDetailView | null = loaded
    ? deriveArchiveDetailView({
        threadId: selected.threadId,
        fragments: values.flatMap((value) => value?.fragments ?? []),
        complete: last?.next === null,
        retainedCheckpointIds: capabilities?.retainedCheckpointIds ?? [],
      })
    : null;
  const failure = pages.find((page) => page._tag === "Failure");
  return {
    view,
    capabilities,
    loading: pages.some((page) => page.waiting),
    error:
      failure && failure._tag === "Failure" ? formatEnvironmentQueryError(failure.cause) : null,
    loadMore:
      last?.next != null
        ? () => {
            const next = last.next;
            if (next !== null) setCursors((previous) => [...previous, next]);
          }
        : null,
  };
}

function ArchiveDetail(props: {
  readonly header: Header;
  readonly selected: HistorySelection;
  readonly current: HistorySelection | null;
  readonly owner: HistorySelectionOwner;
  readonly connected: boolean;
  readonly onReviewAgain: () => void;
  readonly onClose: () => void;
}) {
  const { header, selected } = props;
  const registry = useContext(RegistryContext);
  const router = useRouter();
  const detail = useArchiveDetail(selected);
  const mutation = useAtomValue(threadHistoryEnvironment.mutationState(selected));
  const canOperate = useAtomValue(
    threadHistoryEnvironment.recover.permissionAtom(selected.environmentId),
  );
  const canReconcile = useAtomValue(
    threadHistoryEnvironment.reconcile.permissionAtom(selected.environmentId),
  );
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [checkedStatus, setCheckedStatus] = useState<{
    readonly commandId: string;
    readonly status: typeof ThreadHistoryFileRestoreStatusResult.Type;
  } | null>(null);
  // A status read belongs to one file-restore command; a newer command starts unchecked.
  const fileStatus =
    checkedStatus !== null && checkedStatus.commandId === mutation.fileOperation?.commandId
      ? checkedStatus.status
      : null;

  const { environmentId, threadId, archiveId } = selected;
  // Retained request identities must be loaded before any action can offer a fresh one.
  useEffect(() => {
    void threadHistoryEnvironment.hydrate(registry, { environmentId, threadId, archiveId });
  }, [registry, environmentId, threadId, archiveId]);

  const selectionCurrent =
    props.current !== null && historySelectionIsCurrent(selected, props.current);
  const gate = {
    connected: props.connected,
    selectionCurrent,
    canOperate,
    availability: archiveAvailability(header),
    pending: mutation.pending > 0,
    filesUncertain: mutation.filesUncertain,
    recoveryUncertain: mutation.recoveryUncertain,
    recoveryOperation: mutation.recoveryOperation,
    detailLoaded: detail.view !== null,
    hydrated: mutation.hydration === "ready",
    capabilities: detail.capabilities,
  };
  // An unconfirmed restore/fork stays the only recovery on offer until it is retried to a definite answer.
  const retained = mutation.recoveryUncertain ? mutation.recoveryOperation : null;
  const blocker = (action: HistoryAction, checkpointId?: CheckpointId) =>
    historyActionBlocker(action, gate, checkpointId);
  // Read after every await: the user may have picked another archive, closed History, or reconnected.
  const currentNow = () =>
    props.owner.currentFor(selected, readLiveEpoch(registry, selected.environmentId));

  const recover = async (mode: "restore" | "fork") => {
    const now = currentNow();
    if (blocker(mode) !== null || now === null) return;
    const input: ThreadHistoryRecoverInput = retained ?? {
      threadId,
      archiveId,
      mode,
      commandId: CommandId.make(randomUUID()),
      messageId: MessageId.make(randomUUID()),
      ...(mode === "fork" ? { targetThreadId: ThreadId.make(randomUUID()) } : {}),
    };
    const prepared = prepareHistoryMutation({ selected, current: now, input });
    if (prepared === null) return;
    setMessage(null);
    const result = await threadHistoryEnvironment.recover.run(registry, prepared);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result) || currentNow() === null) return;
      setMessage({ tone: "error", text: describeHistoryFailure(squashAtomCommandFailure(result)) });
      return;
    }
    const recovered = result.value;
    toastManager.add({
      type: "success",
      title: mode === "fork" ? "Forked with archived context" : "Archived context restored",
      description: `Context only: the provider conversation was not rewound and files were not changed.${recovered.partial ? " A bounded selection of messages was included." : ""}`,
    });
    if (currentNow() === null) return;
    props.onClose();
    if (mode === "fork")
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, recovered.threadId)),
      });
  };

  const restoreFiles = async (checkpointId: CheckpointId, capturedAt: string) => {
    if (blocker("restore-files", checkpointId) !== null || currentNow() === null) return;
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      [
        `Restore files to the checkpoint from ${formatTimestamp(capturedAt)}?`,
        "Workspace files are replaced with the checkpoint's contents. The conversation is not changed.",
      ].join("\n"),
      { variant: "destructive" },
    );
    const now = currentNow();
    if (!confirmed || now === null) return;
    const prepared = prepareHistoryMutation({
      selected,
      current: now,
      input: { threadId, archiveId, checkpointId, commandId: CommandId.make(randomUUID()) },
    });
    if (prepared === null) return;
    setMessage(null);
    const result = await threadHistoryEnvironment.restoreFiles.run(registry, prepared);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Files restored" });
      return;
    }
    if (!isAtomCommandInterrupted(result) && currentNow() !== null)
      setMessage({ tone: "error", text: describeHistoryFailure(squashAtomCommandFailure(result)) });
  };

  // A status read changes nothing on the server, so it only needs a live connection.
  const inspectFiles = async () => {
    const operation = mutation.fileOperation;
    if (operation === null || readLiveEpoch(registry, environmentId) === null) return;
    const result = await threadHistoryEnvironment.inspectFileRestore.run(registry, {
      environmentId,
      input: operation,
    });
    if (currentNow() === null) return;
    if (result._tag === "Success") {
      setCheckedStatus({ commandId: operation.commandId, status: result.value });
      setMessage(null);
    } else if (!isAtomCommandInterrupted(result))
      setMessage({ tone: "error", text: describeHistoryFailure(squashAtomCommandFailure(result)) });
  };

  // Only the retained tuple is resent; the server's prepare/CAS keeps a late original from applying twice.
  const fileRetryBlocker =
    mutation.fileOperation === null
      ? "There is no retained file restore to retry."
      : historyFileRetryBlocker(gate, fileStatus, mutation.fileOperation.checkpointId);
  const retryOriginalFiles = async () => {
    const operation = mutation.fileOperation;
    if (operation === null || fileRetryBlocker !== null || currentNow() === null) return;
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      [
        "Retry the original file restore?",
        "The same request is sent again. Workspace files are replaced with the checkpoint's contents.",
      ].join("\n"),
      { variant: "destructive" },
    );
    const now = currentNow();
    if (!confirmed || now === null) return;
    // The confirm can outlive the render: another tab or a status read may have settled it.
    const latest = registry.get(threadHistoryEnvironment.mutationState(selected));
    if (latest.pending > 0 || latest.fileOperation?.commandId !== operation.commandId) return;
    const prepared = prepareHistoryFileRetry({
      selected,
      current: now,
      retainedOperation: operation,
      status: fileStatus,
    });
    if (prepared === null) return;
    setMessage(null);
    const result = await threadHistoryEnvironment.restoreFiles.run(registry, prepared);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: "Files restored" });
      return;
    }
    if (!isAtomCommandInterrupted(result) && currentNow() !== null)
      setMessage({ tone: "error", text: describeHistoryFailure(squashAtomCommandFailure(result)) });
  };

  // Reconcile can durably complete the operation, so it takes the same fence as other mutations.
  const compareBlocked =
    !gate.connected ||
    !canReconcile ||
    !gate.selectionCurrent ||
    gate.pending ||
    !gate.hydrated ||
    fileStatus?.state !== "executing";
  const reconcileFiles = async () => {
    const operation = mutation.fileOperation;
    if (compareBlocked || fileStatus === null || operation === null || currentNow() === null)
      return;
    const result = await threadHistoryEnvironment.reconcile.run(registry, {
      environmentId,
      input: { threadId: fileStatus.threadId, archiveId: fileStatus.archiveId },
    });
    if (currentNow() === null) return;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setMessage({ tone: "error", text: describeHistoryFailure(squashAtomCommandFailure(result)) });
    // Reconcile never clears uncertainty itself; only a fresh status read for the original request can.
    await inspectFiles();
  };

  const release = async () => {
    if (blocker("release") !== null || currentNow() === null) return;
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await api.dialogs.confirm(
      [
        "Release this archive?",
        "Its retained messages and checkpoints are deleted and cannot be restored later.",
      ].join("\n"),
      { variant: "destructive" },
    );
    const now = currentNow();
    if (!confirmed || now === null) return;
    const prepared = prepareHistoryMutation({
      selected,
      current: now,
      input: { threadId, archiveId },
    });
    if (prepared === null) return;
    const result = await threadHistoryEnvironment.release.run(registry, prepared);
    if (result._tag === "Success") toastManager.add({ type: "success", title: "Archive released" });
    else if (!isAtomCommandInterrupted(result) && currentNow() !== null)
      setMessage({ tone: "error", text: describeHistoryFailure(squashAtomCommandFailure(result)) });
  };

  const view = detail.view;
  const restoreBlocker = blocker("restore");
  const forkBlocker = blocker("fork");
  const releaseBlocker = blocker("release");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{describeArchiveReason(header)}</span>
        <Badge variant={availabilityVariant(header)} size="sm">
          {AVAILABILITY_LABELS[archiveAvailability(header)]}
        </Badge>
        <span className="text-muted-foreground text-xs">{formatTimestamp(header.created_at)}</span>
      </div>

      {!selectionCurrent && props.connected ? (
        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span>The connection was replaced since you opened this archive.</span>
          <Button size="sm" variant="outline" onClick={props.onReviewAgain}>
            Review again
          </Button>
        </div>
      ) : null}

      {mutation.hydration === "failed" ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-warning/40 px-3 py-2 text-sm">
          <span>
            Saved recovery requests for this archive could not be read from this browser, so history
            actions are off.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void threadHistoryEnvironment.hydrate(registry, {
                environmentId,
                threadId,
                archiveId,
              })
            }
          >
            Try again
          </Button>
        </div>
      ) : null}

      {retained ? (
        <p className="rounded-md border border-warning/40 px-3 py-2 text-sm">
          The last {retained.mode === "fork" ? "fork" : "context restore"} from this archive did not
          report back and may already have been applied. Retrying sends the same request, so it is
          not applied twice.
        </p>
      ) : null}

      {mutation.filesUncertain && mutation.fileOperation ? (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 px-3 py-2 text-sm">
          <span>
            The last file restore from this archive did not report back. Files may have changed.
            {fileStatus ? ` Server status: ${FILE_STATUS_LABELS[fileStatus.state]}.` : ""}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!props.connected || gate.pending || !gate.hydrated}
              onClick={() => void inspectFiles()}
            >
              Check status
            </Button>
            {fileStatus !== null &&
            ["not-started", "preparing", "ready"].includes(fileStatus.state) ? (
              <Button
                size="sm"
                variant="outline"
                disabled={fileRetryBlocker !== null}
                title={fileRetryBlocker ?? "Sends the original file restore request again."}
                onClick={() => void retryOriginalFiles()}
              >
                Retry original file restore
              </Button>
            ) : null}
            {fileStatus?.state === "executing" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={compareBlocked}
                onClick={() => void reconcileFiles()}
              >
                Compare workspace
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {message ? (
        <p className={message.tone === "error" ? "text-destructive-foreground text-sm" : "text-sm"}>
          {message.text}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={restoreBlocker !== null}
          title={restoreBlocker ?? "Adds the archived messages to this thread as context."}
          onClick={() => void recover("restore")}
        >
          {retained?.mode === "restore" ? "Retry restore" : "Restore context here"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={forkBlocker !== null}
          title={forkBlocker ?? "Starts a new thread with the archived context."}
          onClick={() => void recover("fork")}
        >
          {retained?.mode === "fork" ? "Retry fork" : "Fork with context"}
        </Button>
        <Button
          size="sm"
          variant="ghost-destructive"
          disabled={releaseBlocker !== null}
          title={releaseBlocker ?? "Deletes this archive's retained data."}
          onClick={() => void release()}
        >
          Release archive
        </Button>
      </div>
      {restoreBlocker && forkBlocker ? (
        <p className="text-muted-foreground text-xs">{restoreBlocker}</p>
      ) : null}

      {detail.error ? <p className="text-destructive-foreground text-sm">{detail.error}</p> : null}
      {view ? (
        <ArchiveContents
          view={view}
          filesBlocker={(checkpointId) => blocker("restore-files", checkpointId)}
          onRestoreFiles={(checkpoint) => void restoreFiles(checkpoint.id, checkpoint.capturedAt)}
          onOpenThread={(childThreadId) => {
            props.onClose();
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, childThreadId)),
            });
          }}
        />
      ) : detail.loading ? (
        <p className="text-muted-foreground text-sm">Loading archive…</p>
      ) : null}
      {detail.loadMore ? (
        <Button size="sm" variant="ghost" disabled={detail.loading} onClick={detail.loadMore}>
          Load more of this archive
        </Button>
      ) : null}
    </div>
  );
}

function ArchiveContents(props: {
  readonly view: ArchiveDetailView;
  readonly filesBlocker: (checkpointId: CheckpointId) => string | null;
  readonly onRestoreFiles: (checkpoint: ArchiveDetailView["checkpoints"][number]) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { view } = props;
  return (
    <div className="flex flex-col gap-4">
      {!view.complete || view.unreadableRows > 0 ? (
        <p className="text-muted-foreground text-xs">
          {view.complete ? "" : "Showing the loaded part of this archive. "}
          {view.unreadableRows > 0
            ? `${view.unreadableRows} retained row${view.unreadableRows === 1 ? "" : "s"} could not be read by this app version.`
            : ""}
        </p>
      ) : null}

      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-xs uppercase tracking-wide text-muted-foreground">Work</h3>
        {view.work.length === 0 ? (
          <p className="text-muted-foreground text-sm">No runs in the loaded rows.</p>
        ) : (
          view.work.map((run) => (
            <div key={`${run.threadId}:${run.runId}`} className="flex flex-col text-sm">
              <span>
                {run.modelSelection?.model ?? "Model not recorded"}
                <span className="text-muted-foreground">
                  {" "}
                  · {effortText(savedEffortLabel(run.modelSelection))}
                </span>
                {run.threadId !== view.threadId ? (
                  <span className="text-muted-foreground"> · parent thread</span>
                ) : null}
                <span className="text-muted-foreground"> · {run.status ?? "status unknown"}</span>
              </span>
              <span className="text-muted-foreground text-xs">
                {run.messageCount} messages · {run.commandCount} commands · {run.toolCallCount} tool
                calls · {run.subagentCount} agents · {RETENTION_LABELS[run.retention]}
              </span>
            </div>
          ))
        )}
      </section>

      {view.subagents.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
            Agents
          </h3>
          {view.subagents.map((subagent) => (
            <div key={subagent.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate">
                {subagent.title ?? "Agent"}
                <span className="text-muted-foreground">
                  {" "}
                  · {subagent.model ?? "model not recorded"} · {effortText(subagent.effort)} ·{" "}
                  {subagent.status}
                </span>
              </span>
              {subagent.childThreadId ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    if (subagent.childThreadId) props.onOpenThread(subagent.childThreadId);
                  }}
                >
                  Open conversation
                </Button>
              ) : (
                <span className="text-muted-foreground text-xs">Transcript unavailable</span>
              )}
            </div>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-1.5">
        <h3 className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          Checkpoints
        </h3>
        {view.checkpoints.length === 0 ? (
          <p className="text-muted-foreground text-sm">No file checkpoints in the loaded rows.</p>
        ) : (
          view.checkpoints.map((checkpoint) => {
            const blocker = props.filesBlocker(checkpoint.id);
            return (
              <div key={checkpoint.id} className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {formatTimestamp(checkpoint.capturedAt)}
                  <span className="text-muted-foreground">
                    {" "}
                    · {checkpoint.fileCount} file{checkpoint.fileCount === 1 ? "" : "s"} changed
                  </span>
                </span>
                {checkpoint.fileRestorable ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={blocker !== null}
                    title={blocker ?? "Replaces workspace files with this checkpoint."}
                    onClick={() => props.onRestoreFiles(checkpoint)}
                  >
                    Restore files
                  </Button>
                ) : (
                  <span className="text-muted-foreground text-xs">Files not retained</span>
                )}
              </div>
            );
          })
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
          Messages
        </h3>
        {view.messages.length === 0 ? (
          <p className="text-muted-foreground text-sm">No messages in the loaded rows.</p>
        ) : (
          view.messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-0.5 text-sm">
              <span className="text-muted-foreground text-xs capitalize">{message.role}</span>
              <p className="line-clamp-4 whitespace-pre-wrap break-words">{message.text}</p>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function effortText(effort: string | null) {
  return effort === null ? "effort not recorded" : `${effort} effort`;
}
