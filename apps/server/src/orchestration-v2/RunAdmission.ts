import type { ProviderOptionSelections } from "@t3tools/contracts";
import type {
  NodeId,
  OrchestrationV2DomainEvent,
  OrchestrationV2InstructionSnapshot,
  ProviderThreadId,
  ProviderSessionId,
  ProviderTurnId,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class RunAdmissionError extends Schema.TaggedError<RunAdmissionError>()(
  "RunAdmissionError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Run ownership admission could not be verified.";
  }
}
export interface AdmittedOwner {
  readonly ownerKind?: "work" | "assistant";
  readonly projectId: ProjectId;
  readonly bindingId: string;
  readonly rootId: string;
  readonly generation: number;
  readonly fence: number;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly runAttemptId?: RunAttemptId;
  readonly expiresAt: string | null;
  readonly configuration: {
    readonly providerInstanceId: string;
    readonly model: string;
    readonly options?: ProviderOptionSelections;
    readonly instructionsHash: string;
    readonly instructionSnapshot?: OrchestrationV2InstructionSnapshot;
    readonly toolIds: ReadonlyArray<string>;
    readonly skillIds: ReadonlyArray<string>;
    readonly runtimeVersion: string;
    readonly maxTokens?: number;
    readonly maxDurationMs?: number;
    readonly paidFallback: false;
  };
}
export interface OwnerDeadlineControl {
  readonly controlId: string;
  readonly controlThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly bindingId: string;
  readonly rootId: string;
  readonly generation: number;
  readonly fence: number;
  readonly targetThreadId: ThreadId;
  readonly targetRunId: RunId;
  readonly expiresAt: string;
}
export type AdmissionResult =
  | { readonly _tag: "ordinary" }
  | { readonly _tag: "denied"; readonly reason: string }
  | { readonly _tag: "expired"; readonly owner: AdmittedOwner }
  | {
      readonly _tag: "admitted";
      readonly owner: AdmittedOwner;
      readonly control?: OwnerDeadlineControl;
    };
export interface PreparedResourceInstructions {
  readonly snapshot: OrchestrationV2InstructionSnapshot;
  readonly catalogRevision: number;
  readonly baseHash: string;
}
export interface RetainedOwnerConstraint {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly bindingId: string;
  readonly rootId: string;
  readonly generation: number;
  readonly fence: number;
  readonly expiresAt: string | null;
  readonly runId: RunId;
  readonly runAttemptId: RunAttemptId;
}
export interface CommitInput {
  readonly retainedOwner?: RetainedOwnerConstraint | null;
  readonly proposedWorktreePath?: string | null;
  readonly preparedResources?: PreparedResourceInstructions;
  readonly commandId: string;
  readonly threadId: ThreadId;
  readonly now: string;
  readonly originThreadId?: ThreadId;
  readonly originSessionId?: string;
  readonly operation: "bind-thread" | "create" | "promote" | "restart" | "steer" | "runtime-answer";
  readonly projectId?: ProjectId;
  readonly runId?: RunId;
  readonly runAttemptId?: RunAttemptId;
  readonly queued?: boolean;
  readonly preparedBindingId?: string;
}
export interface NativeTarget {
  readonly runAttemptId: RunAttemptId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly providerTurnId?: ProviderTurnId;
  readonly nodeId?: NodeId;
}
export interface CheckInput {
  readonly retainedOwner?: RetainedOwnerConstraint | null;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly runAttemptId?: RunAttemptId;
  readonly now: string;
  readonly operation?: "start" | "continue" | "escape" | "completion" | "preparation";
  readonly nativeTarget?: NativeTarget;
  readonly originSessionId?: string;
}
export type DeadlineResult =
  | { readonly _tag: "stale" }
  | { readonly _tag: "early"; readonly availableAt: string }
  | { readonly _tag: "stop"; readonly targets: ReadonlyArray<OwnerDeadlineControl> };

/** Domain adapters use SQL authority only; callers retain V2 execution and receipt ownership. */
export class RunAdmission extends Context.Service<
  RunAdmission,
  {
    readonly validatePhysical?: (threadId: ThreadId) => Effect.Effect<void, RunAdmissionError>;
    readonly guardEvents?: (input: {
      readonly commandId: import("@t3tools/contracts").CommandId;
      readonly commandType: string;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    }) => Effect.Effect<void, RunAdmissionError>;
    readonly guardProject?: (input: {
      readonly commandId: import("@t3tools/contracts").CommandId;
      readonly projectId: ProjectId;
      readonly commandType: string;
    }) => Effect.Effect<void, RunAdmissionError>;
    readonly prepareResources?: (
      input: CommitInput,
    ) => Effect.Effect<PreparedResourceInstructions | undefined, RunAdmissionError>;
    readonly commit: (input: CommitInput) => Effect.Effect<AdmissionResult, RunAdmissionError>;
    readonly check: (input: CheckInput) => Effect.Effect<AdmissionResult, RunAdmissionError>;
    readonly reconcileNative: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly now: string;
      readonly runAttemptId?: RunAttemptId;
      readonly accepted: boolean;
      readonly uncertain: boolean;
    }) => Effect.Effect<AdmissionResult, RunAdmissionError>;
    readonly deadline: (
      input: OwnerDeadlineControl & { readonly now: string },
    ) => Effect.Effect<DeadlineResult, RunAdmissionError>;
    readonly validateDeadlineStop: (
      input: OwnerDeadlineControl & { readonly now: string },
    ) => Effect.Effect<boolean, RunAdmissionError>;
    readonly settle: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly now: string;
      readonly uncertain?: boolean;
    }) => Effect.Effect<ReadonlyArray<string>, RunAdmissionError>;
    readonly observeNativeTurn: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly runAttemptId: RunAttemptId;
      readonly now: string;
      readonly terminal: boolean;
    }) => Effect.Effect<
      { readonly stop: boolean; readonly cancelControlIds: ReadonlyArray<string> },
      RunAdmissionError
    >;
    readonly publishCommitted: (commandId: string) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/RunAdmission") {}

/** Used only by compositions which intentionally have no ownership domains installed. */
export const layerOrdinary = Layer.succeed(
  RunAdmission,
  RunAdmission.of({
    commit: (input) =>
      Effect.succeed(
        input.retainedOwner === undefined || input.retainedOwner === null
          ? { _tag: "ordinary" }
          : { _tag: "denied", reason: "retained-owner-unavailable" },
      ),
    check: () => Effect.succeed({ _tag: "ordinary" }),
    reconcileNative: () => Effect.succeed({ _tag: "ordinary" }),
    deadline: () => Effect.succeed({ _tag: "stale" }),
    settle: () => Effect.succeed([]),
    validateDeadlineStop: () => Effect.succeed(false),
    observeNativeTurn: () => Effect.succeed({ stop: false, cancelControlIds: [] }),
    publishCommitted: () => Effect.void,
  }),
);
