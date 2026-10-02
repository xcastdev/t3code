import type {
  ManagedSkillKey,
  ModelSelection,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { NativeSkillCandidate } from "../../skills/NativeSkillObservationService.ts";
import type {
  ProviderSkillPlan,
  ProviderSkillPrepareRequest,
} from "../../skills/ProviderSkillAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import type { PiSessionTerminal } from "./PiSessionRuntime.ts";
import type { PiWorkerOperation } from "./PiWorkerProtocol.ts";

/** Select a parent-owned Pi configuration directory; credentials never enter this value. */
export const PiDriverConfiguration = Schema.Struct({
  agentDirectory: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4096),
      Schema.makeFilter((value) => value.trim() === value && !value.includes("\0")),
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type PiDriverConfiguration = typeof PiDriverConfiguration.Type;

export class PiManagedRuntimeError extends Schema.TaggedError<PiManagedRuntimeError>()(
  "PiManagedRuntimeError",
  {
    code: Schema.Literals(["denied", "conflict", "unavailable", "uncertain"]),
    detail: Schema.String,
  },
) {}

type Assertions = {
  readonly runtimeMode?: ProviderSession["runtimeMode"];
  readonly cwd?: string;
  readonly modelSelection?: ModelSelection;
  readonly resumeCursor?: unknown;
  /** Explicit parent-owned materialization; this value alone grants no skill access. */
  readonly skillPlan?: ProviderSkillPlan;
};

/** The parent rejects routing/mode mismatches before effects; hints never grant authority. */
export type PiManagedOperationRequest = Assertions &
  (
    | { readonly threadId: ThreadId; readonly kind: "initialize" }
    | { readonly threadId: ThreadId; readonly kind: "prompt"; readonly prompt: string }
    | { readonly threadId: ThreadId; readonly kind: "compact" }
  );

export interface PiManagedControlReceipt {
  readonly controlId: number;
  readonly status: "received" | "unresolved";
}

/** Only the parent supplies events from its validated, durably correlated worker stream. */
export type PiManagedEventObserver = (
  event: ProviderRuntimeEvent,
) => Effect.Effect<void, PiManagedRuntimeError>;

export type PiManagedPreparedOperation = {
  readonly operation: PiWorkerOperation;
  /** Single activation: duplicates return a receipt or conflict without replaying effects. */
  readonly run: Effect.Effect<
    { readonly terminal: PiSessionTerminal; readonly session: ProviderSession },
    PiManagedRuntimeError
  >;
  readonly steer: (
    kind: "steer" | "follow-up",
    text: string,
  ) => Effect.Effect<PiManagedControlReceipt, PiManagedRuntimeError>;
  readonly interrupt: Effect.Effect<PiManagedControlReceipt, PiManagedRuntimeError>;
} & (
  | { readonly kind: "prompt"; readonly turnId: TurnId }
  | { readonly kind: "initialize" | "compact"; readonly turnId?: never }
);

export interface PiManagedRuntimeInstance {
  /** No inference, extension activation, credential resolution, or implicit catalog fetch. */
  readonly inspect: Effect.Effect<ServerProviderDraft, PiManagedRuntimeError>;
  /** Current SQL intent, gates and reservations must commit before returning an operation. */
  readonly prepareOperation: (
    request: PiManagedOperationRequest,
    observe: PiManagedEventObserver,
  ) => Effect.Effect<PiManagedPreparedOperation, PiManagedRuntimeError>;
  readonly readSession: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderSession, PiManagedRuntimeError>;
  /** Bounded, authorized native reads cannot rewrite or migrate session files. */
  readonly readThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderThreadSnapshot, PiManagedRuntimeError>;
  readonly requestStop: (threadId: ThreadId) => Effect.Effect<void, PiManagedRuntimeError>;
  readonly stopAll: Effect.Effect<void, PiManagedRuntimeError>;
  readonly authorizeSkills: (
    request: ProviderSkillPrepareRequest,
  ) => Effect.Effect<ReadonlyArray<ManagedSkillKey>, PiManagedRuntimeError>;
  readonly discoverNativeSkills: (
    cwd: string,
  ) => Effect.Effect<ReadonlyArray<NativeSkillCandidate>, PiManagedRuntimeError>;
}

/** Root-owned production service: missing durable producers deny before process acquisition. */
export class PiManagedRuntime extends Context.Service<
  PiManagedRuntime,
  {
    readonly forInstance: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly enabled: boolean;
      readonly configuration: PiDriverConfiguration;
    }) => Effect.Effect<PiManagedRuntimeInstance, PiManagedRuntimeError, Scope.Scope>;
  }
>()("t3/provider/pi/PiManagedRuntime") {}
