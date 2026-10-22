import * as Schema from "effect/Schema";
import {
  CommandId,
  MessageId,
  ThreadId,
  CheckpointId,
  NonNegativeInt,
  PositiveInt,
} from "./baseSchemas.ts";

export const ThreadHistoryArchiveIdentity = Schema.Struct({
  threadId: ThreadId,
  archiveId: Schema.String.check(Schema.isMaxLength(128)),
});
export type ThreadHistoryArchiveIdentity = typeof ThreadHistoryArchiveIdentity.Type;
export const ThreadHistoryArchiveState = Schema.Literals([
  "preparing",
  "ready",
  "executing",
  "completed",
  "releasing",
  "released",
]);
export const ThreadHistoryArchiveHeader = Schema.Struct({
  archive_id: Schema.String,
  thread_id: ThreadId,
  reason: Schema.String,
  state: ThreadHistoryArchiveState,
  created_at: Schema.String,
  operation_json: Schema.NullOr(Schema.String),
});
export const ThreadHistoryListInput = Schema.Struct({
  threadId: ThreadId,
  before: Schema.optional(Schema.String),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
});
export const ThreadHistoryListResult = Schema.Array(ThreadHistoryArchiveHeader);
export const ThreadHistoryDetailInput = Schema.Struct({
  ...ThreadHistoryArchiveIdentity.fields,
  after: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(4))),
});
export const ThreadHistoryCapabilities = Schema.Struct({
  owner: Schema.Literals(["ordinary", "assistant-home"]),
  contextRestore: Schema.Boolean,
  fork: Schema.Boolean,
  restoreFiles: Schema.Boolean,
  retainedCheckpointIds: Schema.Array(CheckpointId),
});
export const ThreadHistoryDetailResult = Schema.Struct({
  archive: ThreadHistoryArchiveHeader,
  fragments: Schema.Array(
    Schema.Struct({
      position: NonNegativeInt,
      kind: Schema.String,
      source_id: Schema.String,
      fragment: NonNegativeInt,
      payload: Schema.String,
    }),
  ),
  next: Schema.NullOr(NonNegativeInt),
  continuity: Schema.Literal("context-only"),
  capabilities: ThreadHistoryCapabilities,
});
export const ThreadHistoryRecoverInput = Schema.Struct({
  ...ThreadHistoryArchiveIdentity.fields,
  commandId: CommandId,
  messageId: MessageId,
  mode: Schema.Literals(["restore", "fork"]),
  targetThreadId: Schema.optional(ThreadId),
});
export type ThreadHistoryRecoverInput = typeof ThreadHistoryRecoverInput.Type;
export const ThreadHistoryRestoreFilesInput = Schema.Struct({
  ...ThreadHistoryArchiveIdentity.fields,
  commandId: CommandId,
  checkpointId: CheckpointId,
});
export const ThreadHistoryRecoveryResult = Schema.Struct({
  threadId: ThreadId,
  archiveId: Schema.String,
  continuity: Schema.Literal("context-only"),
  partial: Schema.Boolean,
  filesRestored: Schema.Literal(false),
});
export type ThreadHistoryRecoveryResult = typeof ThreadHistoryRecoveryResult.Type;
export const ThreadHistoryRestoreFilesResult = Schema.Struct({
  ...ThreadHistoryArchiveIdentity.fields,
  state: Schema.Literal("completed"),
});
export const ThreadHistoryFileRestoreStatusInput = ThreadHistoryRestoreFilesInput;
export const ThreadHistoryFileRestoreStatusResult = Schema.Struct({
  ...ThreadHistoryArchiveIdentity.fields,
  state: Schema.Union([ThreadHistoryArchiveState, Schema.Literal("not-started")]),
});
export const ThreadHistoryReconcileInput = ThreadHistoryArchiveIdentity;
export const ThreadHistoryReconcileResult = Schema.Struct({
  ...ThreadHistoryArchiveIdentity.fields,
  state: ThreadHistoryArchiveState,
});

export class ThreadHistoryRpcError extends Schema.TaggedError<ThreadHistoryRpcError>()(
  "ThreadHistoryRpcError",
  {
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "reconciliation-required",
      "retention-unavailable",
      "storage",
      "unavailable",
      "forbidden",
      "shared-workspace",
      "busy",
      "invalid-target",
      "execution",
    ]),
  },
) {
  override get message() {
    return `History operation failed (${this.reason}).`;
  }
}
