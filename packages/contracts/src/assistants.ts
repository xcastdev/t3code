import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  ForwardCompatibleUnion,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ManagedTextResourceId, ManagedTextResourceRevision } from "./managedTextResources.ts";
import { McpDefinitionId } from "./mcpCatalog.ts";
import { AssistantId } from "./memoryOwner.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ManagedSkillId, SkillRevisionRef } from "./skills.ts";

export const AssistantConfigurationRevision = NonNegativeInt.pipe(
  Schema.brand("AssistantConfigurationRevision"),
);
export type AssistantConfigurationRevision = typeof AssistantConfigurationRevision.Type;

const AssistantName = TrimmedNonEmptyString.check(Schema.isMaxLength(120));
const AssistantText = Schema.String.check(Schema.isMaxLength(65_536));
const AssistantReason = TrimmedNonEmptyString.check(Schema.isMaxLength(1000));
const AssistantCursor = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));
const AssistantPageLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100));
// Read statuses remain bounded strings so a newer server's state retains its identity.
const AssistantReadStatus = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const AssistantResourceSelection = Schema.Struct({
  mcpTools: Schema.Array(
    Schema.Struct({
      definitionId: McpDefinitionId,
      toolNames: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(256))).check(
        Schema.isMaxLength(128),
      ),
    }),
  ).check(Schema.isMaxLength(100)),
  skills: Schema.Array(
    Schema.Struct({ skillId: ManagedSkillId, revision: SkillRevisionRef }),
  ).check(Schema.isMaxLength(100)),
  instructions: Schema.Array(
    Schema.Struct({ resourceId: ManagedTextResourceId, revision: ManagedTextResourceRevision }),
  ).check(Schema.isMaxLength(100)),
});
export type AssistantResourceSelection = typeof AssistantResourceSelection.Type;

export const AssistantMemoryPolicy = Schema.Struct({
  automaticCapture: Schema.Boolean,
  allowRoutineCreation: Schema.Boolean,
  // Null forbids sending source material to any fallback provider.
  extractionFallback: Schema.NullOr(ModelSelection),
  externalIndexing: Schema.NullOr(
    Schema.Struct({
      destination: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
      embeddingDestination: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
    }),
  ),
});
export type AssistantMemoryPolicy = typeof AssistantMemoryPolicy.Type;

export const AssistantConfiguration = Schema.Struct({
  name: AssistantName,
  rules: AssistantText,
  prompt: AssistantText,
  personality: AssistantText,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  resources: AssistantResourceSelection,
  memory: AssistantMemoryPolicy,
});
export type AssistantConfiguration = typeof AssistantConfiguration.Type;

export const AssistantConfigurationSnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  assistantId: AssistantId,
  revision: AssistantConfigurationRevision,
  configuration: AssistantConfiguration,
  createdAt: IsoDateTime,
});
export type AssistantConfigurationSnapshot = typeof AssistantConfigurationSnapshot.Type;

export const AssistantHomeBinding = Schema.Struct({
  environmentId: EnvironmentId,
  assistantId: AssistantId,
  backingProjectId: ProjectId,
  canonicalThreadId: ThreadId,
});
export type AssistantHomeBinding = typeof AssistantHomeBinding.Type;

export const AssistantLifecycle = Schema.Literals(["active", "disabled", "archived"]);
export type AssistantLifecycle = typeof AssistantLifecycle.Type;

export const AssistantProvisioning = Schema.Union([
  Schema.Struct({ state: Schema.Literal("ready"), binding: AssistantHomeBinding }),
  Schema.Struct({
    state: Schema.Literal("provisioning"),
    binding: AssistantHomeBinding,
    stage: Schema.Literals(["pending", "folder", "repository", "project", "thread", "checkpoint"]),
  }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    binding: AssistantHomeBinding,
    reason: AssistantReason,
    retryable: Schema.Boolean,
  }),
  Schema.Struct({
    state: Schema.Literal("needs-repair"),
    binding: AssistantHomeBinding,
    reason: AssistantReason,
  }),
]);
export type AssistantProvisioning = typeof AssistantProvisioning.Type;

export const AssistantRunStatus = Schema.Literals([
  "dispatched",
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "uncertain",
]);
export type AssistantRunStatus = typeof AssistantRunStatus.Type;

const AssistantRunSummaryFields = {
  assistantId: AssistantId,
  configurationRevision: AssistantConfigurationRevision,
  commandId: CommandId,
  messageId: MessageId,
  scheduledTaskId: Schema.NullOr(ScheduledTaskId),
  updatedAt: IsoDateTime,
};

// A failed dispatch need not have a V2 run; execution outcomes always refer to one.
export const AssistantRunSummary = Schema.Union([
  Schema.Struct({
    ...AssistantRunSummaryFields,
    phase: Schema.Literal("dispatch"),
    runId: Schema.Null,
    runAttemptId: Schema.Null,
    status: AssistantReadStatus.check(
      Schema.makeFilter(
        (status) => !["queued", "running", "waiting", "completed"].includes(status),
        { expected: "a dispatch outcome rather than an admitted run status" },
      ),
    ),
  }),
  Schema.Struct({
    ...AssistantRunSummaryFields,
    phase: Schema.Literal("execution"),
    runId: RunId,
    runAttemptId: Schema.NullOr(RunAttemptId),
    status: AssistantReadStatus.check(
      Schema.makeFilter((status) => status !== "dispatched", {
        expected: "an execution outcome rather than a dispatch status",
      }),
    ),
  }),
]);
export type AssistantRunSummary = typeof AssistantRunSummary.Type;

export const AssistantRoutineSummary = Schema.Struct({
  assistantId: AssistantId,
  scheduledTaskId: ScheduledTaskId,
  name: AssistantName,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRun: Schema.NullOr(AssistantRunSummary),
});
export type AssistantRoutineSummary = typeof AssistantRoutineSummary.Type;

export const AssistantAttentionSummary = Schema.Struct({
  queuedRuns: NonNegativeInt,
  activeRuns: NonNegativeInt,
  waitingRuns: NonNegativeInt,
  uncertainRuns: NonNegativeInt,
  pendingMemoryJobs: NonNegativeInt,
  memoryStatus: AssistantReadStatus,
  reason: Schema.NullOr(AssistantReason),
});
export type AssistantAttentionSummary = typeof AssistantAttentionSummary.Type;

export const AssistantSummary = Schema.Struct({
  environmentId: EnvironmentId,
  assistantId: AssistantId,
  name: AssistantName,
  configurationRevision: AssistantConfigurationRevision,
  lifecycle: AssistantReadStatus,
  provisioningState: AssistantReadStatus,
  binding: AssistantHomeBinding,
  attention: AssistantAttentionSummary,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AssistantSummary = typeof AssistantSummary.Type;

export const AssistantDetail = Schema.Struct({
  summary: AssistantSummary,
  configuration: AssistantConfigurationSnapshot,
  provisioning: ForwardCompatibleUnion(AssistantProvisioning.members, "state"),
});
export type AssistantDetail = typeof AssistantDetail.Type;

// Configuration mutations intentionally have no message, run, or scheduler payload.
export const AssistantCreateInput = Schema.Struct({
  environmentId: EnvironmentId,
  commandId: CommandId,
  configuration: AssistantConfiguration,
});
export type AssistantCreateInput = typeof AssistantCreateInput.Type;

export const AssistantGetInput = Schema.Struct({
  environmentId: EnvironmentId,
  assistantId: AssistantId,
});
export type AssistantGetInput = typeof AssistantGetInput.Type;

export const AssistantUpdateConfigurationInput = Schema.Struct({
  ...AssistantGetInput.fields,
  commandId: CommandId,
  expectedRevision: AssistantConfigurationRevision,
  configuration: AssistantConfiguration,
});
export type AssistantUpdateConfigurationInput = typeof AssistantUpdateConfigurationInput.Type;

export const AssistantLifecycleInput = Schema.Struct({
  ...AssistantGetInput.fields,
  commandId: CommandId,
  expectedRevision: AssistantConfigurationRevision,
  action: Schema.Literals(["disable", "enable", "archive", "restore", "retry-provisioning"]),
});
export type AssistantLifecycleInput = typeof AssistantLifecycleInput.Type;

export const AssistantListInput = Schema.Struct({
  environmentId: EnvironmentId,
  includeArchived: Schema.Boolean,
  cursor: Schema.optional(AssistantCursor),
  limit: AssistantPageLimit,
});
export type AssistantListInput = typeof AssistantListInput.Type;

export const AssistantListResult = Schema.Struct({
  assistants: Schema.Array(AssistantSummary).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(AssistantCursor),
});
export type AssistantListResult = typeof AssistantListResult.Type;

export const AssistantActivityListInput = Schema.Struct({
  ...AssistantGetInput.fields,
  cursor: Schema.optional(AssistantCursor),
  limit: AssistantPageLimit,
});
export type AssistantActivityListInput = typeof AssistantActivityListInput.Type;

export const AssistantRunListResult = Schema.Struct({
  runs: Schema.Array(AssistantRunSummary).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(AssistantCursor),
});
export type AssistantRunListResult = typeof AssistantRunListResult.Type;

export const AssistantRoutineListResult = Schema.Struct({
  routines: Schema.Array(AssistantRoutineSummary).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(AssistantCursor),
});
export type AssistantRoutineListResult = typeof AssistantRoutineListResult.Type;

export class AssistantRpcError extends Schema.TaggedError<AssistantRpcError>()(
  "AssistantRpcError",
  {
    reason: Schema.Literals(["not-found", "forbidden", "conflict", "unavailable", "needs-repair"]),
  },
) {}
