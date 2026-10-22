import {
  CheckpointId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemJson,
  RunId,
  ThreadHistoryRpcError,
  ThreadId,
  type ThreadHistoryArchiveHeader,
  type ThreadHistoryDetailResult,
  type ThreadHistoryCapabilities,
  type ThreadHistoryRecoverInput,
  type ThreadHistoryFileRestoreStatusResult,
} from "@t3tools/contracts";
import { historyArchiveAvailability } from "./threadHistory.ts";
import { REASONING_EFFORT_OPTION_IDS } from "./threadExecution.ts";
import { getProviderOptionStatedValue } from "@t3tools/shared/model";
import { deriveTurnWorkCounts, type TurnWorkCounts } from "@t3tools/shared/turnWorkCounts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type Header = typeof ThreadHistoryArchiveHeader.Type;
type Fragment = (typeof ThreadHistoryDetailResult.Type)["fragments"][number];

export const HISTORY_LIST_PAGE_SIZE = 20;
export const HISTORY_DETAIL_PAGE_SIZE = 4;

export type HistoryAvailability =
  | "preparing"
  | "available"
  | "uncertain"
  | "releasing"
  | "released";

/** The shared mapping, narrowed; anything unrecognized is treated as an unknown outcome. */
export function archiveAvailability(header: Header): HistoryAvailability {
  const availability = historyArchiveAvailability(header);
  switch (availability) {
    case "preparing":
    case "available":
    case "uncertain":
    case "releasing":
    case "released":
      return availability;
    default:
      return "uncertain";
  }
}

export const AVAILABILITY_LABELS: Record<HistoryAvailability, string> = {
  preparing: "Preparing",
  available: "Available",
  uncertain: "Outcome unknown",
  releasing: "Releasing",
  released: "Released",
};

/** Only the server's plain reason is shown; `operation_json` has no client contract. */
export function describeArchiveReason(header: Header): string {
  switch (header.reason) {
    case "rollback":
      return "Before rollback";
    case "file-restore":
      return "File restore";
    default:
      return header.reason.length > 0 ? header.reason : "Archived history";
  }
}

/** Older pages are requested only when the last one was full; the cursor is its final ID. */
export function nextListCursor(
  pages: ReadonlyArray<ReadonlyArray<Header> | null>,
  pageSize = HISTORY_LIST_PAGE_SIZE,
): string | null {
  const last = pages.at(-1);
  if (!last || last.length < pageSize) return null;
  return last.at(-1)?.archive_id ?? null;
}

/** Overlapping list pages (a new archive shifts the window) keep the first copy of each ID. */
export function mergeListPages(pages: ReadonlyArray<ReadonlyArray<Header> | null>): Header[] {
  const seen = new Set<string>();
  const headers: Header[] = [];
  for (const page of pages) {
    for (const header of page ?? []) {
      if (seen.has(header.archive_id)) continue;
      seen.add(header.archive_id);
      headers.push(header);
    }
  }
  return headers;
}

const Row = Schema.Struct({ payload_json: Schema.String });
const decodeRow = Schema.decodeUnknownOption(Schema.fromJsonString(Row));
const decodeMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: MessageId,
      role: Schema.String,
      text: Schema.String,
      createdAt: Schema.optional(Schema.String),
    }),
  ),
);
const decodeRun = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: RunId,
      threadId: ThreadId,
      ordinal: Schema.Number,
      modelSelection: ModelSelection,
      status: OrchestrationV2RunStatus,
    }),
  ),
);
const decodeTurnItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodeCheckpoint = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: CheckpointId,
      threadId: ThreadId,
      runId: Schema.NullOr(RunId),
      status: Schema.String,
      capturedAt: Schema.String,
      files: Schema.Array(Schema.Unknown),
    }),
  ),
);
const decodeSubagent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: NodeId,
      threadId: ThreadId,
      runId: Schema.NullOr(RunId),
      childThreadId: Schema.NullOr(ThreadId),
      title: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      modelSelection: Schema.optional(ModelSelection),
      status: Schema.String,
    }),
  ),
);

export interface ArchivedMessage {
  readonly id: MessageId;
  readonly threadId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string | null;
}

export interface ArchivedCheckpoint {
  readonly id: CheckpointId;
  readonly threadId: string;
  readonly runId: string | null;
  readonly capturedAt: string;
  readonly fileCount: number;
  readonly fileRestorable: boolean;
}

export interface ArchivedSubagent {
  readonly id: string;
  readonly threadId: string;
  readonly childThreadId: ThreadId | null;
  readonly title: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: string;
}

export interface ArchiveDetailView {
  readonly threadId: string;
  readonly messages: ReadonlyArray<ArchivedMessage>;
  readonly checkpoints: ReadonlyArray<ArchivedCheckpoint>;
  readonly subagents: ReadonlyArray<ArchivedSubagent>;
  readonly work: ReadonlyArray<TurnWorkCounts>;
  /** Rows whose stored payload no longer matches what this client can read. */
  readonly unreadableRows: number;
  /** Every fragment has been loaded; without this the view is a prefix. */
  readonly complete: boolean;
}

export function savedEffortLabel(selection: ModelSelection | null | undefined): string | null {
  if (!selection) return null;
  for (const id of REASONING_EFFORT_OPTION_IDS) {
    const value = getProviderOptionStatedValue(id, selection);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Joins row fragments in position order. A row cut by the page boundary stays
 * out until its remaining fragments arrive, so a prefix never decodes as garbage.
 */
export function assembleArchiveRows(
  fragments: ReadonlyArray<Fragment>,
  complete: boolean,
): {
  readonly rows: ReadonlyArray<{
    kind: string;
    sourceId: string;
    json: string;
  }>;
} {
  const ordered = [...fragments].sort((a, b) => a.position - b.position);
  const rows: { kind: string; sourceId: string; json: string }[] = [];
  let current: {
    kind: string;
    sourceId: string;
    parts: string[];
    expected: number;
  } | null = null;
  const flush = () => {
    if (current)
      rows.push({
        kind: current.kind,
        sourceId: current.sourceId,
        json: current.parts.join(""),
      });
    current = null;
  };
  let lastPosition = -1;
  for (const fragment of ordered) {
    if (fragment.position === lastPosition) continue;
    lastPosition = fragment.position;
    if (
      current !== null &&
      current.kind === fragment.kind &&
      current.sourceId === fragment.source_id &&
      fragment.fragment === current.expected
    ) {
      current.parts.push(fragment.payload);
      current.expected += 1;
      continue;
    }
    flush();
    current =
      fragment.fragment === 0
        ? {
            kind: fragment.kind,
            sourceId: fragment.source_id,
            parts: [fragment.payload],
            expected: 1,
          }
        : null;
  }
  if (complete) flush();
  return { rows };
}

export function deriveArchiveDetailView(input: {
  readonly threadId: string;
  readonly fragments: ReadonlyArray<Fragment>;
  readonly complete: boolean;
  readonly retainedCheckpointIds?: ReadonlyArray<CheckpointId>;
}): ArchiveDetailView {
  const { rows } = assembleArchiveRows(input.fragments, input.complete);
  const messages: ArchivedMessage[] = [];
  const checkpoints: ArchivedCheckpoint[] = [];
  const subagents: ArchivedSubagent[] = [];
  const runs: {
    id: RunId;
    threadId: ThreadId;
    modelSelection: ModelSelection;
    status: OrchestrationV2RunStatus;
  }[] = [];
  const turnItems: OrchestrationV2TurnItemJson[] = [];
  let unreadableRows = 0;
  for (const row of rows) {
    const payload = decodeRow(row.json).pipe(Option.map((value) => value.payload_json));
    if (Option.isNone(payload)) {
      unreadableRows += 1;
      continue;
    }
    const json = payload.value;
    switch (row.kind) {
      case "messages": {
        const message = decodeMessage(json);
        if (Option.isNone(message)) unreadableRows += 1;
        else
          messages.push({
            id: message.value.id,
            threadId: rowThreadId(row.json) ?? input.threadId,
            role: message.value.role,
            text: message.value.text,
            createdAt: message.value.createdAt ?? null,
          });
        break;
      }
      case "runs": {
        const run = decodeRun(json);
        if (Option.isNone(run)) unreadableRows += 1;
        else runs.push(run.value);
        break;
      }
      case "turn_items": {
        const item = decodeTurnItem(json);
        if (Option.isNone(item)) unreadableRows += 1;
        else turnItems.push(item.value);
        break;
      }
      case "checkpoints": {
        const checkpoint = decodeCheckpoint(json);
        if (Option.isNone(checkpoint)) unreadableRows += 1;
        else if (checkpoint.value.status === "ready")
          checkpoints.push({
            id: checkpoint.value.id,
            threadId: checkpoint.value.threadId,
            runId: checkpoint.value.runId,
            capturedAt: checkpoint.value.capturedAt,
            fileCount: checkpoint.value.files.length,
            fileRestorable: input.retainedCheckpointIds?.includes(checkpoint.value.id) ?? false,
          });
        break;
      }
      case "subagents": {
        const subagent = decodeSubagent(json);
        if (Option.isNone(subagent)) unreadableRows += 1;
        else
          subagents.push({
            id: subagent.value.id,
            threadId: subagent.value.threadId,
            childThreadId: subagent.value.childThreadId,
            title: subagent.value.title,
            model: subagent.value.modelSelection?.model ?? subagent.value.model,
            effort: savedEffortLabel(subagent.value.modelSelection),
            status: subagent.value.status,
          });
        break;
      }
      default:
        break;
    }
  }
  messages.sort(
    (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id.localeCompare(b.id),
  );
  checkpoints.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  return {
    threadId: input.threadId,
    messages,
    checkpoints,
    subagents,
    work: deriveTurnWorkCounts({
      runs,
      turnItems,
      // A prefix or an unreadable row means a count could be short.
      retention: !input.complete ? "partial" : unreadableRows > 0 ? "unknown" : "complete",
    }),
    unreadableRows,
    complete: input.complete,
  };
}

const decodeRowThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ thread_id: Schema.String })),
);
function rowThreadId(json: string): string | null {
  return Option.getOrNull(decodeRowThread(json).pipe(Option.map((row) => row.thread_id)));
}

export const RETENTION_LABELS: Record<TurnWorkCounts["retention"], string> = {
  complete: "All retained rows",
  partial: "Loaded rows only",
  unknown: "Some rows unreadable",
};

export interface HistoryActionGate {
  readonly connected: boolean;
  readonly selectionCurrent: boolean;
  readonly canOperate: boolean;
  readonly availability: HistoryAvailability;
  readonly pending: boolean;
  readonly filesUncertain: boolean;
  readonly recoveryUncertain: boolean;
  readonly recoveryOperation: ThreadHistoryRecoverInput | null;
  readonly detailLoaded: boolean;
  readonly hydrated: boolean;
  readonly capabilities: typeof ThreadHistoryCapabilities.Type | null;
}

export type HistoryAction = "restore" | "fork" | "restore-files" | "release";

/** A user-visible reason the action is unavailable, or null when it may run. */
export function historyActionBlocker(
  action: HistoryAction,
  gate: HistoryActionGate,
  checkpointId?: CheckpointId,
): string | null {
  if (!gate.connected) return "Reconnect to this environment first.";
  if (!gate.canOperate) return "This connection cannot change threads.";
  if (!gate.selectionCurrent) return "The connection changed. Review this archive again.";
  if (gate.pending) return "Another history action is still running.";
  if (!gate.hydrated) return "Load retained recovery requests before acting.";
  switch (gate.availability) {
    case "preparing":
      return "This archive is still being prepared.";
    case "uncertain":
      return "An earlier operation on this archive has an unknown outcome.";
    case "releasing":
    case "released":
      return "This archive has been released.";
    case "available":
      break;
  }
  if (!gate.detailLoaded) return "Load the archive before acting on it.";
  if (
    (action === "restore" || action === "fork") &&
    gate.recoveryUncertain &&
    gate.recoveryOperation?.mode !== action
  )
    return "Retry the original context recovery request before starting another one.";
  if (action === "release" && gate.recoveryUncertain)
    return "Resolve the original context recovery request before releasing.";
  if (gate.capabilities === null) return "Load current recovery capabilities before acting.";
  if (action === "restore" && !gate.capabilities.contextRestore)
    return "This thread cannot currently restore archived context.";
  if (action === "fork" && !gate.capabilities.fork)
    return "This thread cannot fork archived history.";
  if (
    action === "restore-files" &&
    (!gate.capabilities.restoreFiles ||
      checkpointId === undefined ||
      !gate.capabilities.retainedCheckpointIds.includes(checkpointId))
  )
    return "This checkpoint is not currently available for file restoration.";
  if ((action === "restore-files" || action === "release") && gate.filesUncertain)
    return "Check the earlier file restore before changing files or releasing.";
  return null;
}

export function historyFileRetryBlocker(
  gate: HistoryActionGate,
  status: typeof ThreadHistoryFileRestoreStatusResult.Type | null,
  checkpointId: CheckpointId,
) {
  if (status === null || !["not-started", "preparing", "ready"].includes(status.state))
    return "Check the original file operation before retrying it.";
  return historyActionBlocker("restore-files", { ...gate, filesUncertain: false }, checkpointId);
}

const isHistoryRpcError = Schema.is(ThreadHistoryRpcError);

export function describeHistoryFailure(error: unknown): string {
  if (isHistoryRpcError(error)) {
    switch (error.reason) {
      case "busy":
        return "The thread is working. Wait for the current run to finish.";
      case "forbidden":
        return "This thread does not allow that. Agent home threads accept context restore only, into the same home.";
      case "shared-workspace":
        return "Another thread shares this workspace, so files were not restored.";
      case "invalid-target":
        return "That destination thread is not valid for this archive.";
      case "unavailable":
      case "not-found":
        return "The archive or its retained checkpoint is no longer available.";
      case "retention-unavailable":
        return "The server could not retain recovery data.";
      case "reconciliation-required":
        return "The workspace does not match the retained checkpoint, so the restore cannot be confirmed. Files may be partly restored.";
      case "conflict":
        return "The archive changed. Review it again.";
      case "storage":
      case "execution":
        return "The server could not finish the operation.";
    }
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "EnvironmentAuthorizationError"
  )
    return "This connection cannot change threads.";
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The request failed and its outcome is unknown.";
}

export const FILE_STATUS_LABELS: Record<
  (typeof ThreadHistoryFileRestoreStatusResult.Type)["state"],
  string
> = {
  "not-started": "No server operation yet; retry only the original request",
  preparing: "Prepared; files have not been touched",
  ready: "Prepared; files have not been touched",
  executing: "Interrupted while restoring files",
  completed: "Files restored",
  releasing: "Operation released",
  released: "Operation released",
};
