import * as Schema from "effect/Schema";
import { AssistantId, MemoryGrant, MemoryGrantId, MemoryOwner } from "./memoryOwner.ts";
import {
  EnvironmentId,
  MessageId,
  RunId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  ProjectMemorySourceRead,
  ProjectMemorySource,
  MemoryProcessingConfiguration,
} from "./projectMemory.ts";
const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const Cursor = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
const Scope = { environmentId: EnvironmentId, assistantId: AssistantId };
export const AssistantMemorySourceSelector = Schema.Struct({
  sourceId: Id,
  sourceRevision: NonNegativeInt,
  generation: NonNegativeInt,
  contentHash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
const AssistantMemoryPageReadInput = Schema.Struct({
  ...Scope,
  operation: Schema.Literals([
    "list",
    "status",
    "grants",
    "configuration",
    "context",
    "confirmations",
  ]),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(32))),
});
export const AssistantMemoryReadInput = Schema.Union([
  AssistantMemoryPageReadInput,
  Schema.Struct({ ...Scope, operation: Schema.Literal("recipient"), recipient: MemoryOwner }),
]);
export type AssistantMemoryReadInput = typeof AssistantMemoryReadInput.Type;
export const AssistantMemoryReadResult = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("recipient"),
    environmentId: EnvironmentId,
    owner: MemoryOwner,
    ownerRevision: NonNegativeInt,
    title: Schema.String.check(Schema.isMaxLength(4000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("confirmations"),
    items: Schema.Array(ProjectMemorySourceRead).check(Schema.isMaxLength(32)),
    nextCursor: Schema.NullOr(Cursor),
  }),
  Schema.Struct({
    operation: Schema.Literal("list"),
    items: Schema.Array(ProjectMemorySourceRead).check(Schema.isMaxLength(32)),
    nextCursor: Schema.NullOr(Cursor),
  }),
  Schema.Struct({
    operation: Schema.Literal("grants"),
    grants: Schema.Array(MemoryGrant).check(Schema.isMaxLength(32)),
    nextCursor: Schema.NullOr(Cursor),
  }),
  Schema.Struct({
    operation: Schema.Literal("context"),
    memoryEpoch: NonNegativeInt,
    text: Schema.String.check(Schema.isMaxLength(12000)),
  }),
  Schema.Struct({
    operation: Schema.Literal("configuration"),
    revision: NonNegativeInt,
    configuration: MemoryProcessingConfiguration,
  }),
  Schema.Struct({
    operation: Schema.Literal("status"),
    jobs: Schema.Array(Schema.Struct({ status: Id, count: NonNegativeInt })).check(
      Schema.isMaxLength(16),
    ),
    unresolvedForgottenSources: NonNegativeInt,
    requiresUserConfirmation: Schema.Boolean,
  }),
]);
export type AssistantMemoryReadResult = typeof AssistantMemoryReadResult.Type;
const Grant = {
  source: AssistantMemorySourceSelector,
  recipient: MemoryOwner,
  recipientRevision: NonNegativeInt,
};
export const AssistantMemoryWriteInput = Schema.Union([
  Schema.Struct({
    ...Scope,
    operation: Schema.Literal("confirm"),
    source: AssistantMemorySourceSelector,
  }),
  Schema.Struct({
    ...Scope,
    operation: Schema.Literal("forget"),
    source: AssistantMemorySourceSelector,
  }),
  Schema.Struct({
    ...Scope,
    operation: Schema.Literal("edit"),
    source: AssistantMemorySourceSelector,
    content: TrimmedNonEmptyString.check(Schema.isMaxLength(32000)),
  }),
  Schema.Struct({
    ...Scope,
    operation: Schema.Literal("reteach"),
    messageId: MessageId,
    runId: RunId,
  }),
  Schema.Struct({ ...Scope, operation: Schema.Literal("grant"), ...Grant }),
  Schema.Struct({
    ...Scope,
    operation: Schema.Literal("revoke"),
    ...Grant,
    grantId: MemoryGrantId,
  }),
  Schema.Struct({
    ...Scope,
    operation: Schema.Literal("configure"),
    expectedRevision: NonNegativeInt,
    configuration: MemoryProcessingConfiguration,
  }),
]);
export type AssistantMemoryWriteInput = typeof AssistantMemoryWriteInput.Type;
export const AssistantMemoryWriteResult = Schema.Struct({
  operation: Schema.Literals([
    "forget",
    "edit",
    "reteach",
    "grant",
    "revoke",
    "configure",
    "confirm",
  ]),
  source: Schema.optional(ProjectMemorySource),
  grant: Schema.optional(MemoryGrant),
  configurationRevision: Schema.optional(NonNegativeInt),
});
export type AssistantMemoryWriteResult = typeof AssistantMemoryWriteResult.Type;

export class AssistantMemoryRpcError extends Schema.TaggedError<AssistantMemoryRpcError>()(
  "AssistantMemoryRpcError",
  { reason: Schema.Literals(["stale", "forbidden", "unavailable", "invalid", "forgotten"]) },
) {}
