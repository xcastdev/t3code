import * as Schema from "effect/Schema";
import {
  AssistantGetInput,
  AssistantConfigurationRevision,
  AssistantRpcError,
} from "./assistants.ts";
import {
  CommandId,
  MessageId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  NonNegativeInt,
} from "./baseSchemas.ts";
import { ScheduledTaskUpsertSchedule } from "./scheduledTask.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536));
const Cursor = Schema.String.check(Schema.isMaxLength(512));
const Page = {
  ...AssistantGetInput.fields,
  cursor: Schema.optional(Cursor),
  limit: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(32),
  ),
};
export const AssistantRoutineReadInput = Schema.Union([
  Schema.Struct({ ...Page, operation: Schema.Literal("list") }),
  Schema.Struct({
    ...AssistantGetInput.fields,
    operation: Schema.Literal("webhook"),
    taskId: ScheduledTaskId,
  }),
  Schema.Struct({
    ...Page,
    operation: Schema.Literal("fires"),
    taskId: Schema.optional(ScheduledTaskId),
  }),
]);
export type AssistantRoutineReadInput = typeof AssistantRoutineReadInput.Type;
const Target = { ...AssistantGetInput.fields, taskId: ScheduledTaskId };
export const AssistantRoutineWriteInput = Schema.Union([
  Schema.Struct({
    ...AssistantGetInput.fields,
    operation: Schema.Literal("upsert"),
    commandId: CommandId,
    taskId: Schema.optional(ScheduledTaskId),
    expectedRevision: Schema.optional(NonNegativeInt),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    prompt: Text,
    enabled: Schema.Boolean,
    schedule: ScheduledTaskUpsertSchedule,
  }),
  Schema.Struct({
    ...Target,
    operation: Schema.Literal("set-enabled"),
    enabled: Schema.Boolean,
    expectedRevision: NonNegativeInt,
  }),
  Schema.Struct({
    ...Target,
    operation: Schema.Literal("delete"),
    expectedRevision: NonNegativeInt,
  }),
  Schema.Struct({
    ...Target,
    operation: Schema.Literal("rotate-webhook-token"),
    expectedRevision: NonNegativeInt,
  }),
  Schema.Struct({ ...Target, operation: Schema.Literal("run-now"), commandId: CommandId }),
]);
export type AssistantRoutineWriteInput = typeof AssistantRoutineWriteInput.Type;
export const AssistantRoutineDetail = Schema.Struct({
  taskId: ScheduledTaskId,
  revision: NonNegativeInt,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  deleted: Schema.Boolean,
  schedule: Schema.NullOr(ScheduledTaskUpsertSchedule),
  nextRunAt: Schema.NullOr(Schema.String),
  timeZone: Schema.String,
  configurationRevision: AssistantConfigurationRevision,
});
export const AssistantRoutineFire = Schema.Struct({
  fireKey: Schema.String,
  taskId: ScheduledTaskId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  startedAt: Schema.String,
  trigger: Schema.Literals(["scheduled", "manual", "webhook"]),
  triggerIdentity: Schema.String,
  dispatched: Schema.Boolean,
  configurationRevision: AssistantConfigurationRevision,
  admittedConfigurationRevision: Schema.NullOr(AssistantConfigurationRevision),
  runId: Schema.NullOr(RunId),
  status: Schema.Literals([
    "attempted",
    "dispatched",
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "uncertain",
  ]),
});
export const AssistantRoutineReadResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("webhook"),
    taskId: ScheduledTaskId,
    url: Schema.NullOr(Schema.String),
    remoteAccessRequired: Schema.Boolean,
  }),
  Schema.Struct({
    operation: Schema.Literal("list"),
    routines: Schema.Array(AssistantRoutineDetail).check(Schema.isMaxLength(32)),
    nextCursor: Schema.NullOr(Cursor),
  }),
  Schema.Struct({
    operation: Schema.Literal("fires"),
    fires: Schema.Array(AssistantRoutineFire).check(Schema.isMaxLength(32)),
    nextCursor: Schema.NullOr(Cursor),
  }),
]);
export type AssistantRoutineReadResult = typeof AssistantRoutineReadResult.Type;
export const AssistantRoutineWriteResult = Schema.Struct({
  taskId: ScheduledTaskId,
  threadId: Schema.NullOr(ThreadId),
});
export type AssistantRoutineWriteResult = typeof AssistantRoutineWriteResult.Type;
export { AssistantRpcError as AssistantRoutineRpcError };
