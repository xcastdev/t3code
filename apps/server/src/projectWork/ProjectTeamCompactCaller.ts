import type {
  MessageId,
  ProviderInstanceId,
  ProviderSendTurnInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { PiManagedRuntimeError } from "../provider/pi/PiManagedRuntime.ts";

export type CompactCallerRequest = {
  readonly threadId: ThreadId;
  readonly requestId: MessageId;
  readonly modelSelection?: ProviderSendTurnInput["modelSelection"];
};
export type CompactCallerReservation = {
  readonly dispatchId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly requestId: MessageId;
  readonly predecessorOperationId: string;
  readonly deadlineAtMs: number;
  readonly created: boolean;
};
export type CompactCallerHandlers = {
  readonly reserveCompaction: (
    providerInstanceId: ProviderInstanceId,
    request: CompactCallerRequest,
  ) => Effect.Effect<CompactCallerReservation, PiManagedRuntimeError>;
  readonly assertCompactionReady: (
    providerInstanceId: ProviderInstanceId,
    request: CompactCallerRequest,
  ) => Effect.Effect<CompactCallerReservation, PiManagedRuntimeError>;
  readonly abandonCompaction: (
    providerInstanceId: ProviderInstanceId,
    request: CompactCallerRequest,
  ) => Effect.Effect<void, PiManagedRuntimeError>;
};

// Process-local hints carry no authority. Every subscriber reads SQL after subscribing,
// including after restart; sliding delivery coalesces changes without losing the wake.
const changes = Effect.runSync(PubSub.sliding<void>(1));
export const notifyCompactCallerChange = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
export const subscribeCompactCallerChanges: Effect.Effect<
  Stream.Stream<void>,
  never,
  Scope.Scope
> = PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription));
