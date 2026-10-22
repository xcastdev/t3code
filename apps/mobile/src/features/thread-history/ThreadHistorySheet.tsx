import { RegistryContext, useAtomValue } from "@effect/atom-react";
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
  type ThreadHistoryArchiveHeader,
  type ThreadHistoryFileRestoreStatusResult,
  type ThreadHistoryRecoverInput,
} from "@t3tools/contracts";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { createHistorySelectionOwner, type HistorySelectionOwner } from "./historySelectionOwner";
import { threadHistoryEnvironment } from "./threadHistoryState";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type Header = typeof ThreadHistoryArchiveHeader.Type;
type HistoryTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function failureText(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  return describeHistoryFailure(squashAtomCommandFailure(result));
}

function effortText(effort: string | null) {
  return effort === null ? "effort not recorded" : `${effort} effort`;
}

function readLiveEpoch(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  const connection = Option.getOrNull(
    AsyncResult.value(registry.get(threadHistoryEnvironment.connection(environmentId))),
  );
  return connection?.connected ? connection.epoch : null;
}

/** Read-only until the user picks an action; opening it starts nothing on the provider. */
export function ThreadHistorySheet({ route }: StaticScreenProps<HistoryTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const connectionResult = useAtomValue(threadHistoryEnvironment.connection(target.environmentId));
  const connection = Option.getOrNull(AsyncResult.value(connectionResult)) ?? {
    connected: false,
    epoch: null,
  };
  const [owner] = useState(createHistorySelectionOwner);
  const [cursors, setCursors] = useState<ReadonlyArray<string | undefined>>([undefined]);
  const [selected, setSelected] = useState<HistorySelection | null>(null);
  useEffect(() => {
    owner.activate(selected);
    return () => owner.release();
  }, [owner, selected]);
  // Released before the state change so a result landing before the next commit is already stale.
  const choose = (next: HistorySelection | null) => {
    owner.release();
    setSelected(next);
  };
  // One derived atom per cursor list keeps every loaded page mounted and refreshed together.
  const pagesAtom = Atom.make((get) =>
    cursors.map((before) =>
      get(
        threadHistoryEnvironment.list({
          environmentId: target.environmentId,
          input: {
            threadId: target.threadId,
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
  const listFailed = pages.some((page) => page._tag === "Failure");
  const older = nextListCursor(pageValues);
  const current: HistorySelection | null =
    selected && connection.epoch !== null
      ? { ...selected, connectionEpoch: connection.epoch }
      : null;
  const selectedHeader = selected
    ? (headers.find((header) => header.archive_id === selected.archiveId) ?? null)
    : null;

  const select = (header: Header) => {
    if (connection.epoch === null) return;
    choose(
      captureHistorySelection({
        environmentId: target.environmentId,
        threadId: target.threadId,
        archiveId: header.archive_id,
        connectionEpoch: connection.epoch,
      }),
    );
  };
  // The sheet is a leaf: threads it opens belong in the workspace stack.
  const openThread = (threadId: ThreadId) =>
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
    );

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-5 px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {!connection.connected ? (
        <Notice message="Offline. Showing the last loaded archives." />
      ) : null}
      {selected && selectedHeader ? (
        <ArchiveDetail
          key={selected.archiveId}
          header={selectedHeader}
          selected={selected}
          current={current}
          owner={owner}
          connected={connection.connected}
          onBack={() => choose(null)}
          onReviewAgain={() => {
            if (connection.epoch !== null)
              choose(captureHistorySelection({ ...selected, connectionEpoch: connection.epoch }));
          }}
          onDone={() => navigation.goBack()}
          onOpenThread={openThread}
        />
      ) : (
        <ListSection
          title="Archived snapshots"
          footer="Kept before rollbacks and file restores. Restoring adds archived context as a message; it does not rewind the provider or change files."
        >
          {headers.length === 0 ? (
            <Text className="px-2 py-4 text-sm text-foreground-muted">
              {loading
                ? "Loading…"
                : listFailed
                  ? "Could not load history."
                  : "No archived history."}
            </Text>
          ) : (
            headers.map((header) => (
              <ArchiveListRow
                key={header.archive_id}
                header={header}
                environmentId={target.environmentId}
                disabled={!connection.connected}
                onPress={() => select(header)}
              />
            ))
          )}
          {older ? (
            <Button
              label="Older archives"
              tone="text"
              disabled={loading}
              onPress={() => setCursors((previous) => [...previous, older])}
            />
          ) : null}
        </ListSection>
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A plain formSheet screen never renders a stack header, so it comes from a nested native stack.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-history-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="History"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="History" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function ArchiveListRow(props: {
  readonly header: Header;
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly onPress: () => void;
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
    <ListRow
      label={describeArchiveReason(header)}
      description={formatTimestamp(header.created_at)}
      detail={
        mutation.filesUncertain
          ? "Files unknown"
          : mutation.recoveryUncertain
            ? "Unconfirmed"
            : AVAILABILITY_LABELS[archiveAvailability(header)]
      }
      disabled={props.disabled}
      onPress={props.onPress}
    />
  );
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
  // The newest page carries the server's current owner and retained-ref answer.
  const capabilities = last?.capabilities ?? null;
  const view: ArchiveDetailView | null = values.every((value) => value !== null)
    ? deriveArchiveDetailView({
        threadId: selected.threadId,
        fragments: values.flatMap((value) => value?.fragments ?? []),
        complete: last?.next === null,
        retainedCheckpointIds: capabilities?.retainedCheckpointIds ?? [],
      })
    : null;
  const next = last?.next ?? null;
  return {
    view,
    capabilities,
    loading: pages.some((page) => page.waiting),
    failed: pages.some((page) => page._tag === "Failure"),
    loadMore: next !== null ? () => setCursors((previous) => [...previous, next]) : null,
  };
}

function ArchiveDetail(props: {
  readonly header: Header;
  readonly selected: HistorySelection;
  readonly current: HistorySelection | null;
  readonly owner: HistorySelectionOwner;
  readonly connected: boolean;
  readonly onBack: () => void;
  readonly onReviewAgain: () => void;
  readonly onDone: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { header, selected } = props;
  const { environmentId, threadId, archiveId } = selected;
  const registry = useContext(RegistryContext);
  const detail = useArchiveDetail(selected);
  const mutation = useAtomValue(threadHistoryEnvironment.mutationState(selected));
  const canOperate = useAtomValue(threadHistoryEnvironment.recover.permissionAtom(environmentId));
  const canReconcile = useAtomValue(
    threadHistoryEnvironment.reconcile.permissionAtom(environmentId),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [checkedStatus, setCheckedStatus] = useState<{
    readonly commandId: string;
    readonly status: typeof ThreadHistoryFileRestoreStatusResult.Type;
  } | null>(null);
  const fileStatus =
    checkedStatus !== null && checkedStatus.commandId === mutation.fileOperation?.commandId
      ? checkedStatus.status
      : null;

  // Retained request identities must be loaded before any action can offer a fresh one.
  useEffect(() => {
    void threadHistoryEnvironment.hydrate(registry, { environmentId, threadId, archiveId });
  }, [registry, environmentId, threadId, archiveId]);

  const gate = {
    connected: props.connected,
    selectionCurrent: props.current !== null && historySelectionIsCurrent(selected, props.current),
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
  // Read after every await: the user may have left this archive, dismissed the sheet, or reconnected.
  const currentNow = () => props.owner.currentFor(selected, readLiveEpoch(registry, environmentId));

  const recover = async (mode: "restore" | "fork") => {
    const now = currentNow();
    if (blocker(mode) !== null || now === null) return;
    const input: ThreadHistoryRecoverInput = retained ?? {
      threadId,
      archiveId,
      mode,
      commandId: CommandId.make(uuidv4()),
      messageId: MessageId.make(uuidv4()),
      ...(mode === "fork" ? { targetThreadId: ThreadId.make(uuidv4()) } : {}),
    };
    const prepared = prepareHistoryMutation({ selected, current: now, input });
    if (prepared === null) return;
    setMessage(null);
    const result = await threadHistoryEnvironment.recover.run(registry, prepared);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result) && currentNow() !== null)
        setMessage(failureText(result));
      return;
    }
    if (currentNow() === null) return;
    if (mode === "fork") props.onOpenThread(result.value.threadId);
    else props.onDone();
  };

  const restoreFiles = (checkpointId: CheckpointId, capturedAt: string) => {
    if (blocker("restore-files", checkpointId) !== null || currentNow() === null) return;
    Dialog.confirm({
      title: "Restore files?",
      message: `Workspace files are replaced with the checkpoint from ${formatTimestamp(capturedAt)}. The conversation is not changed.`,
      confirmText: "Restore files",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const now = currentNow();
          if (now === null) return;
          const prepared = prepareHistoryMutation({
            selected,
            current: now,
            input: { threadId, archiveId, checkpointId, commandId: CommandId.make(uuidv4()) },
          });
          if (prepared === null) return;
          setMessage(null);
          const result = await threadHistoryEnvironment.restoreFiles.run(registry, prepared);
          if (currentNow() === null) return;
          if (result._tag === "Success") setMessage("Files restored.");
          else if (!isAtomCommandInterrupted(result)) setMessage(failureText(result));
        })();
      },
    });
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
    if (result._tag === "Success")
      setCheckedStatus({ commandId: operation.commandId, status: result.value });
    else if (!isAtomCommandInterrupted(result)) setMessage(failureText(result));
  };

  // Only the retained tuple is resent; the server's prepare/CAS keeps a late original from applying twice.
  const fileRetryBlocker =
    mutation.fileOperation === null
      ? "There is no retained file restore to retry."
      : historyFileRetryBlocker(gate, fileStatus, mutation.fileOperation.checkpointId);
  const retryOriginalFiles = () => {
    const operation = mutation.fileOperation;
    if (operation === null || fileRetryBlocker !== null || currentNow() === null) return;
    Dialog.confirm({
      title: "Retry the original file restore?",
      message:
        "The same request is sent again. Workspace files are replaced with the checkpoint's contents.",
      confirmText: "Retry",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const now = currentNow();
          if (now === null) return;
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
          if (currentNow() === null) return;
          if (result._tag === "Success") setMessage("Files restored.");
          else if (!isAtomCommandInterrupted(result)) setMessage(failureText(result));
        })();
      },
    });
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
    if (compareBlocked || fileStatus === null || mutation.fileOperation === null) return;
    if (currentNow() === null) return;
    const result = await threadHistoryEnvironment.reconcile.run(registry, {
      environmentId,
      input: { threadId: fileStatus.threadId, archiveId: fileStatus.archiveId },
    });
    if (currentNow() === null) return;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setMessage(failureText(result));
    // Reconcile never clears uncertainty itself; only a fresh status read for the original request can.
    await inspectFiles();
  };

  const release = () => {
    if (blocker("release") !== null || currentNow() === null) return;
    Dialog.confirm({
      title: "Release archive?",
      message: "Its retained messages and checkpoints are deleted and cannot be restored later.",
      confirmText: "Release",
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const now = currentNow();
          if (now === null) return;
          const prepared = prepareHistoryMutation({
            selected,
            current: now,
            input: { threadId, archiveId },
          });
          if (prepared === null) return;
          const result = await threadHistoryEnvironment.release.run(registry, prepared);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result) && currentNow())
            setMessage(failureText(result));
        })();
      },
    });
  };

  const view = detail.view;
  const restoreBlocker = blocker("restore");
  const forkBlocker = blocker("fork");
  return (
    <View className="gap-5">
      <ListSection
        title={`${describeArchiveReason(header)} · ${AVAILABILITY_LABELS[archiveAvailability(header)]}`}
        footer={formatTimestamp(header.created_at)}
      >
        <Button label="All archives" tone="text" onPress={props.onBack} />
      </ListSection>

      {!gate.selectionCurrent && props.connected ? (
        <Notice
          message="The connection was replaced since you opened this archive."
          onDismiss={props.onReviewAgain}
          dismissLabel="Review again"
        />
      ) : null}

      {mutation.hydration === "failed" ? (
        <Notice
          tone="danger"
          message="Saved recovery requests for this archive could not be read on this device, so history actions are off."
          onDismiss={() =>
            void threadHistoryEnvironment.hydrate(registry, { environmentId, threadId, archiveId })
          }
          dismissLabel="Try again"
        />
      ) : null}

      {retained ? (
        <Notice
          message={`The last ${retained.mode === "fork" ? "fork" : "context restore"} from this archive did not report back and may already have been applied. Retrying sends the same request, so it is not applied twice.`}
        />
      ) : null}

      {mutation.filesUncertain && mutation.fileOperation ? (
        <View className="gap-2">
          <Notice
            tone="danger"
            message={`The last file restore from this archive did not report back. Files may have changed.${fileStatus ? ` Server status: ${FILE_STATUS_LABELS[fileStatus.state]}.` : ""}`}
          />
          <Button
            label="Check status"
            tone="secondary"
            disabled={!props.connected || gate.pending || !gate.hydrated}
            onPress={() => void inspectFiles()}
          />
          {fileStatus !== null &&
          ["not-started", "preparing", "ready"].includes(fileStatus.state) ? (
            <Button
              label="Retry original file restore"
              tone="secondary"
              disabled={fileRetryBlocker !== null}
              onPress={retryOriginalFiles}
            />
          ) : null}
          {fileStatus?.state === "executing" ? (
            <Button
              label="Compare workspace"
              tone="secondary"
              disabled={compareBlocked}
              onPress={() => void reconcileFiles()}
            />
          ) : null}
        </View>
      ) : null}

      {message ? <Notice message={message} onDismiss={() => setMessage(null)} /> : null}

      <View className="gap-2">
        <Button
          label={retained?.mode === "restore" ? "Retry restore" : "Restore context here"}
          disabled={restoreBlocker !== null}
          loading={mutation.pending > 0}
          onPress={() => void recover("restore")}
        />
        <Button
          label={retained?.mode === "fork" ? "Retry fork" : "Fork with context"}
          tone="secondary"
          disabled={forkBlocker !== null}
          onPress={() => void recover("fork")}
        />
        <Button
          label="Release archive"
          tone="danger"
          disabled={blocker("release") !== null}
          onPress={release}
        />
        {restoreBlocker && forkBlocker ? (
          <Text className="text-xs text-foreground-muted">{restoreBlocker}</Text>
        ) : null}
      </View>

      {detail.failed ? <Notice tone="danger" message="Could not load this archive." /> : null}
      {view ? (
        <ArchiveContents
          view={view}
          filesBlocker={(checkpointId) => blocker("restore-files", checkpointId)}
          onRestoreFiles={(checkpoint) => restoreFiles(checkpoint.id, checkpoint.capturedAt)}
          onOpenThread={props.onOpenThread}
        />
      ) : detail.loading ? (
        <Text className="text-sm text-foreground-muted">Loading archive…</Text>
      ) : null}
      {detail.loadMore ? (
        <Button
          label="Load more of this archive"
          tone="text"
          disabled={detail.loading}
          onPress={detail.loadMore}
        />
      ) : null}
    </View>
  );
}

function ArchiveContents(props: {
  readonly view: ArchiveDetailView;
  readonly filesBlocker: (checkpointId: CheckpointId) => string | null;
  readonly onRestoreFiles: (checkpoint: ArchiveDetailView["checkpoints"][number]) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { view } = props;
  const coverage = [
    view.complete ? null : "Showing the loaded part of this archive.",
    view.unreadableRows > 0
      ? `${view.unreadableRows} retained row${view.unreadableRows === 1 ? "" : "s"} could not be read by this app version.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <View className="gap-5">
      <ListSection title="Work" {...(coverage ? { footer: coverage } : {})}>
        {view.work.length === 0 ? (
          <Text className="px-2 text-sm text-foreground-muted">No runs in the loaded rows.</Text>
        ) : (
          view.work.map((run) => (
            <View key={`${run.threadId}:${run.runId}`} className="gap-0.5 px-2">
              <Text className="text-sm text-foreground">
                {run.modelSelection?.model ?? "Model not recorded"} ·{" "}
                {effortText(savedEffortLabel(run.modelSelection))}
                {run.threadId !== view.threadId ? " · parent thread" : ""} ·{" "}
                {run.status ?? "status unknown"}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {run.messageCount} messages · {run.commandCount} commands · {run.toolCallCount} tool
                calls · {run.subagentCount} agents · {RETENTION_LABELS[run.retention]}
              </Text>
            </View>
          ))
        )}
      </ListSection>

      {view.subagents.length > 0 ? (
        <ListSection title="Agents">
          {view.subagents.map((subagent) => {
            const childThreadId = subagent.childThreadId;
            const description = [
              subagent.model ?? "model not recorded",
              effortText(subagent.effort),
              subagent.status,
            ].join(" · ");
            return childThreadId ? (
              <ListRow
                key={subagent.id}
                label={subagent.title ?? "Agent"}
                description={description}
                detail="Open"
                onPress={() => props.onOpenThread(childThreadId)}
              />
            ) : (
              <View key={subagent.id} className="gap-0.5 px-2">
                <Text className="text-sm text-foreground">{subagent.title ?? "Agent"}</Text>
                <Text className="text-xs text-foreground-muted">
                  {description} · transcript unavailable
                </Text>
              </View>
            );
          })}
        </ListSection>
      ) : null}

      <ListSection title="Checkpoints">
        {view.checkpoints.length === 0 ? (
          <Text className="px-2 text-sm text-foreground-muted">
            No file checkpoints in the loaded rows.
          </Text>
        ) : (
          view.checkpoints.map((checkpoint) => {
            const description = `${checkpoint.fileCount} file${checkpoint.fileCount === 1 ? "" : "s"} changed`;
            if (!checkpoint.fileRestorable)
              return (
                <View key={checkpoint.id} className="gap-0.5 px-2">
                  <Text className="text-sm text-foreground">
                    {formatTimestamp(checkpoint.capturedAt)}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {description} · files not retained
                  </Text>
                </View>
              );
            const blocker = props.filesBlocker(checkpoint.id);
            return (
              <ListRow
                key={checkpoint.id}
                label={formatTimestamp(checkpoint.capturedAt)}
                description={blocker ? `${description} · ${blocker}` : description}
                detail="Restore files"
                disabled={blocker !== null}
                onPress={() => props.onRestoreFiles(checkpoint)}
              />
            );
          })
        )}
      </ListSection>

      <ListSection title="Messages">
        {view.messages.length === 0 ? (
          <Text className="px-2 text-sm text-foreground-muted">
            No messages in the loaded rows.
          </Text>
        ) : (
          view.messages.map((message) => (
            <View key={message.id} className="gap-0.5 px-2">
              <Text className="text-xs capitalize text-foreground-muted">{message.role}</Text>
              <Text className="text-sm text-foreground" numberOfLines={4}>
                {message.text}
              </Text>
            </View>
          ))
        )}
      </ListSection>
    </View>
  );
}
