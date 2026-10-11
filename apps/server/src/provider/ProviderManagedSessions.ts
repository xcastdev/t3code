import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import type {
  ProviderInstanceId,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ProviderValidationError, type ProviderServiceError } from "./Errors.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

interface Start {
  readonly input: ProviderSessionStartInput;
  readonly primaryProjectRoot: string;
  readonly assertCurrent: Effect.Effect<void, ProviderServiceError>;
}
interface Assignment {
  readonly input: ProviderSendTurnInput & { readonly input: string };
  readonly instanceId: ProviderInstanceId;
  readonly assertCurrent: Effect.Effect<void, ProviderServiceError>;
}
interface Borrow {
  readonly factory: object;
  readonly adapter: object;
  readonly operation: "start" | "assignment";
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly primaryProjectRoot?: string;
  readonly assignment?: string;
  readonly assertCurrent: Effect.Effect<void, ProviderServiceError>;
  readonly enter: (input: unknown) => Effect.Effect<void, ProviderServiceError>;
}
class ManagedCall extends Context.Service<ManagedCall, Borrow>()(
  "t3/provider/ProviderManagedSessions/ManagedCall",
) {}
interface Port {
  readonly start: (request: Start) => ReturnType<ProviderServiceShape["startSession"]>;
  readonly assignment: (request: Assignment) => ReturnType<ProviderServiceShape["sendTurn"]>;
}
const ports = new WeakMap<ProviderServiceShape, Port>();
const denied = (issue: string) =>
  new ProviderValidationError({ operation: "ProviderService.managedSession", issue });

/** Root supplies current durable authority; these private calls grant none themselves. */
export const startManagedProviderSession = (service: ProviderServiceShape, request: Start) => {
  let input: ProviderSessionStartInput;
  try {
    input = structuredClone(request.input);
  } catch {
    return Effect.fail(denied("Managed initialization input cannot be snapshotted"));
  }
  const snapshot = { ...request, input };
  return Effect.suspend(() => {
    const port = ports.get(service);
    return port
      ? port.start(snapshot)
      : Effect.fail(denied("Managed session factory is unavailable"));
  });
};

/** The returned Effect is one-shot; uncertainty must be reconciled rather than resent. */
export const sendManagedProviderAssignment = (
  service: ProviderServiceShape,
  request: Assignment,
) => {
  let input: Assignment["input"];
  try {
    input = structuredClone(request.input);
  } catch {
    return Effect.fail(denied("Managed assignment input cannot be snapshotted"));
  }
  const snapshot = { ...request, input };
  let entered = false;
  return Effect.suspend(() => {
    if (entered) return Effect.fail(denied("Managed assignment effect was already entered"));
    entered = true;
    const port = ports.get(service);
    return port
      ? port.assignment(snapshot)
      : Effect.fail(denied("Managed assignment factory is unavailable"));
  });
};

/** Preserve ordinary public methods while lending the exact factory's managed path. */
export const makeProviderManagedSessions = Effect.fn("makeProviderManagedSessions")(function* (
  resolve: (id: ProviderInstanceId) => Effect.Effect<object, ProviderServiceError>,
) {
  const path = yield* Path.Path;
  const factory = {};
  let active = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active = false;
    }),
  );

  const withCall = <A>(
    request: Omit<Borrow, "factory" | "adapter" | "enter">,
    input: unknown,
    call: Effect.Effect<A, ProviderServiceError>,
  ) =>
    Effect.gen(function* () {
      const expectedInput = yield* Effect.try({
        try: () => canonicalProjectWorkPayload(input),
        catch: () => denied("Managed method input cannot be compared"),
      });
      const original = yield* resolve(request.instanceId);
      let borrowed = true;
      let entered = false;
      const enter = (actualInput: unknown) =>
        Effect.suspend(() => {
          if (entered) return Effect.fail(denied("Managed method was already entered"));
          entered = true;
          return Effect.try({
            try: () => canonicalProjectWorkPayload(actualInput),
            catch: () => denied("Managed method input cannot be compared"),
          }).pipe(
            Effect.flatMap((actual) =>
              actual === expectedInput
                ? Effect.void
                : Effect.fail(denied("Managed method input differs from its original assignment")),
            ),
          );
        });
      const assertCurrent = Effect.gen(function* () {
        if (!active || !borrowed) return yield* denied("Managed session loan has ended");
        yield* request.assertCurrent;
        const current = yield* resolve(request.instanceId);
        if (!active || !borrowed || current !== original)
          return yield* denied("Original managed adapter changed");
        yield* request.assertCurrent;
        if (!active || !borrowed) return yield* denied("Managed session loan has ended");
      });
      yield* assertCurrent;
      return yield* call.pipe(
        Effect.provideService(ManagedCall, {
          ...request,
          factory,
          adapter: original,
          assertCurrent,
          enter,
        }),
        Effect.tap(() => assertCurrent),
        Effect.ensuring(
          Effect.sync(() => {
            borrowed = false;
          }),
        ),
      );
    });

  const current = Effect.fn("ProviderService.currentManagedCall")(function* (
    operation: Borrow["operation"],
    threadId?: ThreadId,
    instanceId?: ProviderInstanceId,
    adapter?: object,
  ) {
    const supplied = yield* Effect.serviceOption(ManagedCall);
    if (Option.isNone(supplied)) return undefined;
    const borrow = supplied.value;
    if (
      borrow.factory !== factory ||
      borrow.operation !== operation ||
      (threadId !== undefined && borrow.threadId !== threadId) ||
      (instanceId !== undefined && borrow.instanceId !== instanceId) ||
      (adapter !== undefined && borrow.adapter !== adapter)
    )
      return yield* denied("Managed call differs from its original factory or assignment");
    yield* borrow.assertCurrent;
    return borrow;
  });

  const enter = Effect.fn("ProviderService.enterManagedCall")(function* (
    operation: Borrow["operation"],
    input: unknown,
  ) {
    const borrow = yield* current(operation);
    if (borrow !== undefined) yield* borrow.enter(input);
    return borrow;
  });

  const bind = (service: ProviderServiceShape) => {
    ports.set(service, {
      start: (request) =>
        Effect.suspend(() => {
          const instanceId = request.input.providerInstanceId;
          if (
            instanceId === undefined ||
            request.input.runtimeMode !== "approval-required" ||
            request.input.modelSelection?.instanceId !== instanceId ||
            request.input.cwd === undefined ||
            !path.isAbsolute(request.input.cwd) ||
            request.primaryProjectRoot.trim() !== request.primaryProjectRoot ||
            !path.isAbsolute(request.primaryProjectRoot)
          )
            return Effect.fail(
              denied("Managed initialization requires an explicit instance and mode"),
            );
          const input = Object.freeze({ ...request.input });
          return withCall(
            {
              operation: "start",
              threadId: input.threadId,
              instanceId,
              primaryProjectRoot: request.primaryProjectRoot,
              assertCurrent: request.assertCurrent,
            },
            input,
            service.startSession(input.threadId, input),
          );
        }),
      assignment: (request) =>
        Effect.suspend(() => {
          const input = Object.freeze({ ...request.input });
          if (
            input.continuation === true ||
            (input.attachments?.length ?? 0) !== 0 ||
            input.modelSelection?.instanceId !== request.instanceId
          )
            return Effect.fail(denied("Managed assignment contains unrelated input or routing"));
          return withCall(
            {
              operation: "assignment",
              threadId: input.threadId,
              instanceId: request.instanceId,
              assignment: input.input,
              assertCurrent: request.assertCurrent,
            },
            input,
            service.sendTurn(input),
          );
        }),
    });
  };
  return { bind, current, enter };
});
