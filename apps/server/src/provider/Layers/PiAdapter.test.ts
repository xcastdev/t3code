import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  PiManagedRuntimeError,
  type PiManagedEventObserver,
  type PiManagedOperationRequest,
  type PiManagedPreparedOperation,
  type PiManagedRuntimeInstance,
} from "../pi/PiManagedRuntime.ts";
import type { PiModelAccountingReceipt } from "../pi/PiModelBroker.ts";
import type { PiSessionTerminal } from "../pi/PiSessionRuntime.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const instanceId = ProviderInstanceId.make("pi-one");
const threadId = ThreadId.make("managed-thread");
const provider = ProviderDriverKind.make("piAgent");
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const timestamp = "2026-10-01T00:00:00.000Z";
const initialSession = (instance = instanceId): ProviderSession => ({
  provider,
  providerInstanceId: instance,
  threadId,
  runtimeMode: "full-access",
  status: "ready",
  cwd: "/managed/worktree",
  model: "frozen-model",
  resumeCursor: { sessionId: "native-one", leafId: "leaf-0" },
  createdAt: timestamp,
  updatedAt: timestamp,
});
const startInput = { threadId, runtimeMode: "full-access" as const };
const denied = new PiManagedRuntimeError({
  code: "denied",
  detail: "Current authorization denied.",
});
type Output = { readonly terminal: PiSessionTerminal; readonly session: ProviderSession };
type FakeOperation = {
  readonly prepared: PiManagedPreparedOperation;
  readonly observe: PiManagedEventObserver;
  readonly started: Deferred.Deferred<void>;
  readonly result: Deferred.Deferred<Output, PiManagedRuntimeError>;
};

/** Private-port behavior fake only. No SQL, authorization, native persistence or process proof. */
const makeFake = Effect.fn("PiAdapter.test.makeFake")(function* (instance = instanceId) {
  const operations: FakeOperation[] = [];
  const requests: PiManagedOperationRequest[] = [];
  const preparedQueue = yield* Queue.unbounded<FakeOperation>();
  const stopped = yield* Queue.unbounded<ThreadId>();
  const requestsQueue = yield* Queue.unbounded<PiManagedOperationRequest>();
  const controls = yield* Queue.unbounded<void>();
  const state = {
    autoInitialize: true,
    stopSettles: true,
    interruptStatus: "received" as "received" | "unresolved",
    interruptCalls: 0,
    stopAllCalls: 0,
    stopCalls: 0,
    stopGates: [] as Deferred.Deferred<void>[],
    session: initialSession(instance),
    prepareError: undefined as PiManagedRuntimeError | undefined,
    readError: undefined as PiManagedRuntimeError | undefined,
    stopError: undefined as PiManagedRuntimeError | undefined,
    stopAllError: undefined as PiManagedRuntimeError | undefined,
    prepareGate: undefined as Deferred.Deferred<void> | undefined,
  };
  const output = (
    operation: FakeOperation,
    outcome: PiSessionTerminal["outcome"],
    session = state.session,
  ): Output => ({
    // These are receipt fixtures, not observed operating-system evidence.
    terminal: {
      identity: { workerId: "fake-owned-worker", generation: 7 },
      operation: operation.prepared.operation,
      outcome,
      ownerCaptured: true,
      native: null,
      accountingReceipts: [],
      drain: {
        unit: "fake-unit",
        invocation: "fake-invocation",
        cgroup: "fake-cgroup",
        ownerPid: null,
        launcherPid: 1,
        childPid: null,
        childExitCode: 0,
        kernel: "fake-empty",
        memoryBytes: 1,
        swapBytes: 0,
        oomGroup: 0,
      },
    },
    session,
  });
  const settle = Effect.fn("PiAdapter.test.settle")(function* (
    operation: FakeOperation,
    outcome: PiSessionTerminal["outcome"],
    session = state.session,
  ) {
    state.session = session;
    yield* Deferred.succeed(operation.result, output(operation, outcome, session));
  });
  const runtime: PiManagedRuntimeInstance = {
    inspect: Effect.die("unused private-port inspection"),
    prepareOperation: Effect.fn("PiAdapter.test.prepareOperation")(function* (request, observe) {
      requests.push(request);
      yield* Queue.offer(requestsQueue, request);
      if (state.prepareGate) yield* Deferred.await(state.prepareGate);
      if (state.prepareError) return yield* state.prepareError;
      const result = yield* Deferred.make<Output, PiManagedRuntimeError>();
      const started = yield* Deferred.make<void>();
      const operation = {
        operationId: `root-operation-${operations.length}`,
        operationKind: request.kind,
      };
      const run = Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* Deferred.await(result);
      });
      const interrupt = Effect.gen(function* () {
        state.interruptCalls++;
        yield* Queue.offer(controls, undefined);
        return { controlId: 19, status: state.interruptStatus };
      });
      const common = {
        operation,
        run,
        interrupt,
        steer: () => Effect.succeed({ controlId: 20, status: "unresolved" as const }),
      };
      const prepared: PiManagedPreparedOperation =
        request.kind === "prompt"
          ? { ...common, kind: "prompt", turnId: TurnId.make(`root-turn-${operations.length}`) }
          : { ...common, kind: request.kind };
      const entry = { prepared, result, started, observe };
      operations.push(entry);
      if (request.kind === "initialize" && state.autoInitialize) yield* settle(entry, "success");
      yield* Queue.offer(preparedQueue, entry);
      return prepared;
    }),
    readSession: () =>
      Effect.suspend(() =>
        state.readError ? Effect.fail(state.readError) : Effect.succeed(state.session),
      ),
    readThread: () =>
      Effect.suspend(() =>
        state.readError
          ? Effect.fail(state.readError)
          : Effect.succeed({
              threadId,
              turns: [{ id: TurnId.make("native-turn"), items: ["bounded-authorized-source"] }],
            }),
      ),
    requestStop: Effect.fn("PiAdapter.test.requestStop")(function* (thread) {
      const gate = state.stopGates[state.stopCalls++];
      yield* Queue.offer(stopped, thread);
      if (gate) yield* Deferred.await(gate);
      if (state.stopError) return yield* state.stopError;
      if (state.stopSettles)
        for (const operation of operations) yield* settle(operation, "canceled");
    }),
    stopAll: Effect.gen(function* () {
      state.stopAllCalls++;
      for (const gate of state.stopGates) yield* Deferred.succeed(gate, undefined);
      if (state.stopAllError) return yield* state.stopAllError;
      for (const operation of operations) yield* settle(operation, "canceled");
    }),
    authorizeSkills: () => Effect.succeed([]),
    discoverNativeSkills: () => Effect.succeed([]),
  };
  return {
    runtime,
    state,
    operations,
    requests,
    preparedQueue,
    stopped,
    requestsQueue,
    controls,
    settle,
    output,
  };
});
const subscribe = Effect.fn("PiAdapter.test.subscribe")(function* (
  stream: Stream.Stream<ProviderRuntimeEvent>,
) {
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  yield* Effect.forkScoped(
    Stream.runForEach(stream, (event) => Queue.offer(queue, event)),
    { startImmediately: true },
  );
  return queue;
});
const nextType = Effect.fn("PiAdapter.test.nextType")(function* (
  queue: Queue.Queue<ProviderRuntimeEvent>,
  type: ProviderRuntimeEvent["type"],
) {
  while (true) {
    const event = yield* Queue.take(queue);
    if (event.type === type) return event;
  }
});
const item = (operation: FakeOperation, instance = instanceId): ProviderRuntimeEvent => ({
  eventId: EventId.make(`root-item-${operation.prepared.operation.operationId}`),
  provider,
  providerInstanceId: instance,
  threadId,
  createdAt: timestamp,
  ...(operation.prepared.kind === "prompt" ? { turnId: operation.prepared.turnId } : {}),
  sessionGeneration: "7",
  nativeEntryId: "native-entry",
  providerOrderKey: "root-order-00001",
  type: "item.completed",
  payload: { itemType: "assistant_message", status: "completed" },
});

it.effect("waits for initialization parent receipt and prevents duplicate acquisition", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.autoInitialize = false;
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const starting = yield* Effect.forkScoped(adapter.startSession(startInput));
    const operation = yield* Queue.take(fake.preparedQueue);
    yield* Deferred.await(operation.started);
    expect(yield* adapter.hasSession(threadId)).toBe(false);
    expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
    expect(fake.requests).toHaveLength(1);
    yield* fake.settle(operation, "success");
    expect((yield* Fiber.join(starting)).status).toBe("ready");
    expect(fake.requests[0]).toEqual({ threadId, kind: "initialize", runtimeMode: "full-access" });
  }),
);

it.effect("returns root turn ID only after prepare and holds concurrent prompts", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    yield* adapter.startSession(startInput);
    const result = yield* adapter.sendTurn({ threadId, input: "authorized prompt" });
    const operation = fake.operations[1]!;
    yield* Deferred.await(operation.started);
    expect(result.turnId).toBe(
      operation.prepared.kind === "prompt" ? operation.prepared.turnId : undefined,
    );
    expect(fake.requests[1]).toEqual({ threadId, kind: "prompt", prompt: "authorized prompt" });
    expect(
      Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "second" }))),
    ).toBe(true);
    expect((yield* adapter.listSessions())[0]?.status).toBe("running");
  }),
);

it.effect("ordinary item completion preserves source hints and cannot settle a turn", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    yield* nextType(queue, "session.started");
    yield* adapter.sendTurn({ threadId, input: "prompt" });
    const operation = fake.operations[1]!;
    yield* nextType(queue, "turn.started");
    yield* operation.observe(item(operation));
    expect(yield* nextType(queue, "item.completed")).toEqual(item(operation));
    yield* operation.observe({
      ...item(operation),
      type: "turn.completed",
      payload: { state: "completed" },
    });
    expect(yield* Queue.size(queue)).toBe(0);
    expect((yield* adapter.listSessions())[0]?.status).toBe("running");
    const committed = {
      ...initialSession(),
      resumeCursor: { sessionId: "native-one", leafId: "leaf-1" },
    };
    yield* fake.settle(operation, "success", committed);
    expect((yield* nextType(queue, "turn.completed")).payload).toEqual({
      state: "completed",
      tokenUsage: { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
    });
    expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(committed.resumeCursor);
    expect(yield* Queue.size(queue)).toBe(0);
  }),
);

for (const outcome of ["failed", "quarantine"] as const)
  it.effect(`${outcome} retains the last cursor and prevents replacement`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const queue = yield* subscribe(adapter.streamEvents);
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId, input: "prompt" });
      yield* fake.settle(fake.operations[1]!, outcome, {
        ...initialSession(),
        resumeCursor: "uncommitted-leaf",
      });
      expect((yield* nextType(queue, "turn.completed")).payload).toMatchObject({ state: "failed" });
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(
        initialSession().resumeCursor,
      );
      expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
      expect(
        Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "retry" }))),
      ).toBe(true);
      expect(fake.requests).toHaveLength(2);
      yield* adapter.stopSession(threadId);
    }),
  );

it.effect("unresolved interrupt fails without joining or replaying the control", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.interruptStatus = "unresolved";
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    yield* adapter.startSession(startInput);
    const turn = yield* adapter.sendTurn({ threadId, input: "prompt" });
    const exit = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId)))).toBe(
      true,
    );
    expect(fake.state.interruptCalls).toBe(1);
    expect((yield* adapter.listSessions())[0]?.status).toBe("running");
  }),
);

it.effect("received interrupt waits for durable cancellation and keeps the logical session", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    const turn = yield* adapter.sendTurn({ threadId, input: "prompt" });
    const operation = fake.operations[1]!;
    const interrupting = yield* Effect.forkScoped(adapter.interruptTurn(threadId, turn.turnId));
    yield* Queue.take(fake.controls);
    yield* fake.settle(operation, "canceled");
    yield* Fiber.join(interrupting);
    yield* nextType(queue, "turn.aborted");
    expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    expect(yield* adapter.hasSession(threadId)).toBe(true);
    expect(fake.requests).toHaveLength(2);
  }),
);

it.effect("setup failures remain explicit and do not silently initialize again", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.prepareError = denied;
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
    fake.state.prepareError = undefined;
    expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
    expect(fake.requests).toHaveLength(1);
    yield* adapter.stopSession(threadId);
    expect(yield* adapter.hasSession(threadId)).toBe(false);
  }),
);

it.effect("duplicate ready starts reauthorize exact hints and never reset on read errors", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    yield* adapter.startSession(startInput);
    expect(
      yield* adapter.startSession({
        ...startInput,
        cwd: "/managed/worktree",
        resumeCursor: initialSession().resumeCursor,
      }),
    ).toEqual(initialSession());
    for (const hints of [
      { cwd: "/other" },
      { resumeCursor: { leafId: "stale" } },
      { runtimeMode: "auto" as const },
    ])
      expect(
        Exit.isFailure(yield* Effect.exit(adapter.startSession({ ...startInput, ...hints }))),
      ).toBe(true);
    for (const code of ["denied", "conflict", "unavailable", "uncertain"] as const) {
      fake.state.readError = new PiManagedRuntimeError({ code, detail: "current snapshot failed" });
      expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(adapter.readThread(threadId)))).toBe(true);
    }
    expect(fake.requests).toHaveLength(1);
  }),
);

it.effect("rejects unsupported input and interactive methods before acquisition", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    expect(
      Exit.isFailure(
        yield* Effect.exit(adapter.startSession({ ...startInput, approvalPolicy: "never" })),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.startSession({ ...startInput, sandboxMode: "danger-full-access" }),
        ),
      ),
    ).toBe(true);
    for (const turn of [
      { input: undefined },
      { input: "x", continuation: true },
      {
        input: "x",
        attachments: [
          {
            type: "future-attachment",
            id: "attachment",
            name: "unsupported",
            mimeType: "application/octet-stream",
            sizeBytes: 1,
          },
        ],
      },
      { input: "x", interactionMode: "plan" as const },
      {
        input: "x",
        modelSelection: {
          instanceId,
          model: "frozen-model",
          options: [{ id: "effort", value: "high" }],
        },
      },
    ])
      expect(Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, ...turn })))).toBe(
        true,
      );
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.respondToRequest(threadId, ApprovalRequestId.make("request"), "accept"),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.respondToUserInput(threadId, ApprovalRequestId.make("request"), {}),
        ),
      ),
    ).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(adapter.rollbackThread(threadId, 1)))).toBe(true);
    expect(fake.requests).toHaveLength(0);
    expect(adapter.compaction).toBeUndefined();
    expect(adapter.forkThread).toBeUndefined();
    expect(adapter.capabilities.sessionModelSwitch).toBe("unsupported");
  }),
);

it.effect("stop waits on the owned operation and ignores stale observers after closure", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.stopSettles = false;
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    yield* adapter.sendTurn({ threadId, input: "prompt" });
    const old = fake.operations[1]!;
    const stopping = yield* Effect.forkScoped(adapter.stopSession(threadId));
    yield* Queue.take(fake.stopped);
    yield* old.observe(item(old));
    expect((yield* adapter.listSessions())[0]?.status).toBe("running");
    yield* fake.settle(old, "canceled");
    yield* Fiber.join(stopping);
    yield* nextType(queue, "session.exited");
    yield* adapter.startSession(startInput);
    yield* nextType(queue, "session.started");
    yield* old.observe(item(old));
    expect(yield* Queue.size(queue)).toBe(0);
  }),
);

it.effect("caller cancellation stops initialization before returning a ready session", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.autoInitialize = false;
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const starting = yield* Effect.forkScoped(adapter.startSession(startInput));
    const operation = yield* Queue.take(fake.preparedQueue);
    yield* Deferred.await(operation.started);
    yield* Fiber.interrupt(starting);
    expect(yield* Queue.take(fake.stopped)).toBe(threadId);
    expect(yield* adapter.hasSession(threadId)).toBe(false);
  }),
);

it.effect("scope teardown drains only its instance and closes its operations", () =>
  Effect.gen(function* () {
    const first = yield* makeFake();
    const secondId = ProviderInstanceId.make("pi-two");
    const second = yield* makeFake(secondId);
    const scope = yield* Scope.make();
    const a = yield* makePiAdapter({ instanceId, runtime: first.runtime }).pipe(
      Scope.provide(scope),
    );
    const b = yield* makePiAdapter({ instanceId: secondId, runtime: second.runtime });
    yield* a.startSession(startInput);
    yield* b.startSession(startInput);
    yield* a.sendTurn({ threadId, input: "owned" });
    yield* Scope.close(scope, Exit.void);
    expect(first.state.stopAllCalls).toBe(1);
    expect(second.state.stopAllCalls).toBe(0);
    expect(yield* b.hasSession(threadId)).toBe(true);
    expect(yield* a.hasSession(threadId)).toBe(false);
    expect(Exit.isFailure(yield* Effect.exit(a.startSession(startInput)))).toBe(true);
  }),
);

it.effect("observer rejects instance and turn confusion without publishing success", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    yield* adapter.startSession(startInput);
    yield* adapter.sendTurn({ threadId, input: "prompt" });
    const operation = fake.operations[1]!;
    expect(
      Exit.isFailure(
        yield* Effect.exit(operation.observe(item(operation, ProviderInstanceId.make("other")))),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          operation.observe({ ...item(operation), turnId: TurnId.make("stale-turn") }),
        ),
      ),
    ).toBe(true);
  }),
);

it.effect("bounded observer overflow fails closed without replay or successful completion", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const held = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const delivered: ProviderRuntimeEvent[] = [];
    yield* Effect.forkScoped(
      Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          delivered.push(event);
          yield* Deferred.succeed(held, undefined);
          yield* Deferred.await(release);
        }),
      ),
      { startImmediately: true },
    );
    yield* adapter.startSession(startInput);
    yield* Deferred.await(held);
    const turn = yield* adapter.sendTurn({ threadId, input: "prompt" });
    const operation = fake.operations[1]!;
    let overflowed = false;
    for (let index = 0; index < 257; index++) {
      const event = { ...item(operation), eventId: EventId.make(`root-item-${index}`) };
      if (Exit.isFailure(yield* Effect.exit(operation.observe(event)))) {
        overflowed = true;
        break;
      }
    }
    expect(overflowed).toBe(true);
    // Model how the private producer propagates its observer failure into its parent result.
    const interrupted = yield* Effect.forkScoped(
      Effect.exit(adapter.interruptTurn(threadId, turn.turnId)),
    );
    yield* Queue.take(fake.controls);
    yield* Deferred.fail(
      operation.result,
      new PiManagedRuntimeError({
        code: "uncertain",
        detail: "durable event overflow requires reconciliation",
      }),
    );
    expect(Exit.isFailure(yield* Fiber.join(interrupted))).toBe(true);
    expect((yield* adapter.listSessions())[0]?.status).toBe("error");
    expect(
      Exit.isFailure(yield* Effect.exit(adapter.sendTurn({ threadId, input: "replay" }))),
    ).toBe(true);
    expect(fake.requests).toHaveLength(2);
    expect(
      delivered.some(
        (event) => event.type === "turn.completed" && event.payload.state === "completed",
      ),
    ).toBe(false);
    yield* Deferred.succeed(release, undefined);
  }),
);

it.effect("cancellation during prepare stops durable intent before operation activation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.prepareGate = yield* Deferred.make<void>();
    fake.state.autoInitialize = false;
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const starting = yield* Effect.forkScoped(adapter.startSession(startInput));
    yield* Queue.take(fake.requestsQueue);
    const canceled = yield* Effect.forkScoped(Fiber.interrupt(starting));
    yield* Queue.take(fake.stopped);
    yield* Deferred.succeed(fake.state.prepareGate, undefined);
    yield* Fiber.join(canceled);
    expect(fake.operations).toHaveLength(1);
    expect(yield* Deferred.isDone(fake.operations[0]!.started)).toBe(false);
    expect(yield* adapter.hasSession(threadId)).toBe(false);
  }),
);

it.effect("a successful-looking parent result without drain cannot expose a ready session", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.autoInitialize = false;
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const starting = yield* Effect.forkScoped(Effect.exit(adapter.startSession(startInput)));
    const operation = yield* Queue.take(fake.preparedQueue);
    const output = fake.output(operation, "success");
    yield* Deferred.succeed(operation.result, {
      ...output,
      terminal: { ...output.terminal, drain: null },
    });
    expect(Exit.isFailure(yield* Fiber.join(starting))).toBe(true);
    expect(yield* adapter.hasSession(threadId)).toBe(false);
    expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
    expect(fake.requests).toHaveLength(1);
  }),
);

it.effect(
  "uncertain scoped stop retains error visibility and never replaces or repeats shutdown",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId, input: "prompt" });
      fake.state.stopAllError = new PiManagedRuntimeError({
        code: "uncertain",
        detail: "Owned worker drain could not be confirmed.",
      });
      expect(Exit.isFailure(yield* Effect.exit(adapter.stopAll()))).toBe(true);
      expect((yield* adapter.listSessions())[0]?.status).toBe("error");
      expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(adapter.stopAll()))).toBe(true);
      expect(fake.state.stopAllCalls).toBe(1);
    }),
);

it.effect("repair R1 concurrent scoped stops cannot close a replacement", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.stopGates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    yield* nextType(queue, "session.started");
    const first = yield* Effect.forkScoped(adapter.stopSession(threadId), {
      startImmediately: true,
    });
    yield* Queue.take(fake.stopped);
    const second = yield* Effect.forkScoped(adapter.stopSession(threadId), {
      startImmediately: true,
    });
    expect(fake.state.stopCalls).toBe(1);
    yield* Deferred.succeed(fake.state.stopGates[0]!, undefined);
    yield* Fiber.join(first);
    yield* nextType(queue, "session.exited");
    yield* adapter.startSession(startInput);
    yield* nextType(queue, "session.started");
    yield* Deferred.succeed(fake.state.stopGates[1]!, undefined);
    yield* Fiber.join(second);
    expect(yield* Queue.size(queue)).toBe(0);
    expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
  }),
);

it.effect("repair R2 cancellation exposes its committed native cursor before abort", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    yield* adapter.sendTurn({ threadId, input: "prompt" });
    const committed = {
      ...initialSession(),
      resumeCursor: { sessionId: "native-one", leafId: "canceled-leaf" },
      updatedAt: "2026-10-01T01:00:00.000Z",
    };
    yield* fake.settle(fake.operations[1]!, "canceled", committed);
    yield* nextType(queue, "turn.aborted");
    expect((yield* adapter.listSessions())[0]).toEqual(committed);
  }),
);

it.effect("repair R3 uncertain scoped stop reports a fenced error without blind retry", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    yield* nextType(queue, "session.started");
    fake.state.stopError = new PiManagedRuntimeError({
      code: "uncertain",
      detail: "private-stop-marker",
    });
    expect(Exit.isFailure(yield* Effect.exit(adapter.stopSession(threadId)))).toBe(true);
    expect((yield* adapter.listSessions())[0]).toMatchObject({ status: "error" });
    const event = yield* nextType(queue, "session.state.changed");
    expect(event.payload).toMatchObject({ state: "error" });
    expect(json(event)).not.toContain("private-stop-marker");
    expect(Exit.isFailure(yield* Effect.exit(adapter.stopSession(threadId)))).toBe(true);
    expect(fake.state.stopCalls).toBe(1);
    expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
  }),
);

for (const race of [
  "ordinary reuse",
  "stopSession",
  "stopAll",
  "pending stop",
  "failed stop",
  "replacement context",
  "running turn",
  "settled turn",
  "settled turn with unchanged snapshot",
  "failed turn",
] as const)
  it.effect(`repair read R1 ${race} revalidates ownership and session state`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const runtime: PiManagedRuntimeInstance = {
        ...fake.runtime,
        readSession: Effect.fn("PiAdapter.test.heldRead")(function* (thread) {
          const snapshot = yield* fake.runtime.readSession(thread);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return snapshot;
        }),
      };
      const adapter = yield* makePiAdapter({ instanceId, runtime });
      const original = yield* adapter.startSession(startInput);
      const reading = yield* Effect.forkScoped(Effect.exit(adapter.startSession(startInput)), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);
      let stopping: Fiber.Fiber<void, ProviderAdapterError> | undefined;
      if (race === "stopSession" || race === "replacement context") {
        yield* adapter.stopSession(threadId);
        if (race === "replacement context") {
          fake.state.session = {
            ...initialSession(),
            resumeCursor: { sessionId: "replacement-native", leafId: "replacement-leaf" },
          };
          yield* adapter.startSession(startInput);
        }
      } else if (race === "stopAll") {
        yield* adapter.stopAll();
      } else if (race === "pending stop") {
        const gate = yield* Deferred.make<void>();
        fake.state.stopGates = [gate];
        stopping = yield* Effect.forkScoped(adapter.stopSession(threadId), {
          startImmediately: true,
        });
        yield* Queue.take(fake.stopped);
      } else if (race === "failed stop") {
        fake.state.stopError = new PiManagedRuntimeError({
          code: "uncertain",
          detail: "private-read-stop-failure",
        });
        expect(Exit.isFailure(yield* Effect.exit(adapter.stopSession(threadId)))).toBe(true);
      } else if (
        race === "running turn" ||
        race === "settled turn" ||
        race === "settled turn with unchanged snapshot" ||
        race === "failed turn"
      ) {
        yield* adapter.sendTurn({ threadId, input: "authorized concurrent prompt" });
        const operation = fake.operations[1]!;
        yield* Deferred.await(operation.started);
        if (race !== "running turn") {
          const completing = yield* Effect.forkScoped(
            Effect.exit(adapter.interruptTurn(threadId)),
            { startImmediately: true },
          );
          yield* Queue.take(fake.controls);
          const committed =
            race === "settled turn with unchanged snapshot"
              ? original
              : {
                  ...initialSession(),
                  resumeCursor: { sessionId: "native-one", leafId: "newer-leaf" },
                  updatedAt: "2026-10-01T01:00:00.000Z",
                };
          yield* fake.settle(operation, race === "failed turn" ? "failed" : "success", committed);
          expect(Exit.isSuccess(yield* Fiber.join(completing))).toBe(race !== "failed turn");
        }
      }
      const current = yield* adapter.listSessions();
      yield* Deferred.succeed(release, undefined);
      const read = yield* Fiber.join(reading);
      const afterRead = yield* adapter.listSessions();
      if (stopping) {
        yield* Deferred.succeed(fake.state.stopGates[0]!, undefined);
        yield* Fiber.join(stopping);
      }
      expect(afterRead).toEqual(current);
      expect(Exit.isSuccess(read)).toBe(race === "ordinary reuse");
      if (race === "ordinary reuse") {
        expect(Exit.isSuccess(read) && read.value).toEqual(original);
        expect(fake.requests).toHaveLength(1);
      } else if (race === "stopSession" || race === "stopAll") {
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      } else if (race === "running turn") {
        expect(afterRead[0]?.status).toBe("running");
      } else if (race === "settled turn") {
        expect(afterRead[0]).toMatchObject({
          updatedAt: "2026-10-01T01:00:00.000Z",
          resumeCursor: { leafId: "newer-leaf" },
        });
      } else if (race === "failed stop" || race === "failed turn") {
        expect(afterRead[0]?.status).toBe("error");
      } else if (race === "replacement context") {
        expect(afterRead[0]?.resumeCursor).toEqual(fake.state.session.resumeCursor);
        expect(fake.requests).toHaveLength(2);
      }
    }),
  );

const reportedReceipt = (
  requestId: number,
  inputTokens: number,
  outputTokens: number,
): PiModelAccountingReceipt => ({
  requestId,
  reservationId: `reservation-${requestId}`,
  accountingReceiptId: `accounting-${requestId}`,
  routeId: "frozen-route",
  provider: "command-code",
  model: "frozen-model",
  reportedModel: "reported-alias",
  usage: {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: requestId === 1 ? 7 : 3 },
  },
});
for (const outcome of ["success", "canceled", "failed"] as const)
  it.effect(`repair R4 ${outcome} preserves deduplicated authoritative usage`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const queue = yield* subscribe(adapter.streamEvents);
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId, input: "prompt" });
      const operation = fake.operations[1]!;
      const output = fake.output(operation, outcome);
      const first = reportedReceipt(1, 60, 12);
      const second = reportedReceipt(2, 40, 8);
      yield* Deferred.succeed(operation.result, {
        ...output,
        terminal: { ...output.terminal, accountingReceipts: [first, second, first] },
      });
      const event = yield* nextType(
        queue,
        outcome === "canceled" ? "turn.aborted" : "turn.completed",
      );
      expect(event.payload).toMatchObject({
        tokenUsage: {
          usageScope: "main_agent",
          usageStatus: outcome === "success" ? "complete" : "partial",
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 10,
          hasSubagents: false,
        },
      });
      expect(event.payload).not.toHaveProperty("totalCostUsd");
    }),
  );

it.effect("repair R5 private diagnostics never reach errors snapshots or terminal events", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    const turn = yield* adapter.sendTurn({ threadId, input: "prompt" });
    const interrupting = yield* Effect.forkScoped(
      Effect.exit(adapter.interruptTurn(threadId, turn.turnId)),
    );
    yield* Queue.take(fake.controls);
    yield* Deferred.fail(
      fake.operations[1]!.result,
      new PiManagedRuntimeError({ code: "unavailable", detail: "synthetic-private-marker" }),
    );
    const exit = yield* Fiber.join(interrupting);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(json(exit)).not.toContain("synthetic-private-marker");
    const event = yield* nextType(queue, "turn.completed");
    expect(json(event)).not.toContain("synthetic-private-marker");
    expect(json(yield* adapter.listSessions())).not.toContain("synthetic-private-marker");
  }),
);

for (const contradictory of ["running", "active", "undrained"] as const)
  it.effect(
    `repair R2 rejects ${contradictory} canceled snapshot instead of inventing readiness`,
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFake();
        const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
        const queue = yield* subscribe(adapter.streamEvents);
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "prompt" });
        const operation = fake.operations[1]!;
        const output = fake.output(operation, "canceled");
        yield* Deferred.succeed(operation.result, {
          ...output,
          session: {
            ...output.session,
            ...(contradictory === "running" ? { status: "running" as const } : {}),
            ...(contradictory === "active" ? { activeTurnId: TurnId.make("unfinished-turn") } : {}),
            resumeCursor: "uncommitted",
          },
          terminal: {
            ...output.terminal,
            ...(contradictory === "undrained" ? { drain: null } : {}),
          },
        });
        expect((yield* nextType(queue, "turn.completed")).payload).toMatchObject({
          state: "failed",
        });
        expect((yield* adapter.listSessions())[0]).toMatchObject({
          status: "error",
          resumeCursor: initialSession().resumeCursor,
        });
      }),
  );

for (const invalidUsage of [
  "total",
  "subset",
  "aliases",
  "identity",
  "request",
  "reservation",
  "overflow",
  "unused-detail",
] as const)
  it.effect(`repair R4 ${invalidUsage} accounting cannot claim success or zero usage`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const queue = yield* subscribe(adapter.streamEvents);
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId, input: "prompt" });
      const operation = fake.operations[1]!;
      const output = fake.output(operation, "success");
      const first = reportedReceipt(1, 60, 12);
      const invalid: PiModelAccountingReceipt[] =
        invalidUsage === "total"
          ? [{ ...first, usage: { ...first.usage, total_tokens: 73 } }]
          : invalidUsage === "subset"
            ? [
                {
                  ...first,
                  usage: { ...first.usage, completion_tokens_details: { reasoning_tokens: 13 } },
                },
              ]
            : invalidUsage === "aliases"
              ? [{ ...first, usage: { ...first.usage, cached_tokens: 8 } }]
              : invalidUsage === "identity"
                ? [
                    first,
                    { ...first, usage: { ...first.usage, prompt_tokens: 61, total_tokens: 73 } },
                  ]
                : invalidUsage === "request"
                  ? [first, { ...reportedReceipt(2, 40, 8), requestId: first.requestId }]
                  : invalidUsage === "reservation"
                    ? [first, { ...reportedReceipt(2, 40, 8), reservationId: first.reservationId }]
                    : invalidUsage === "overflow"
                      ? [reportedReceipt(1, Number.MAX_SAFE_INTEGER, 0), reportedReceipt(2, 40, 8)]
                      : [
                          first,
                          {
                            ...first,
                            usage: {
                              ...first.usage,
                              completion_tokens_details: { accepted_prediction_tokens: 1 },
                            },
                          },
                        ];
      yield* Deferred.succeed(operation.result, {
        ...output,
        terminal: { ...output.terminal, accountingReceipts: invalid },
      });
      expect((yield* nextType(queue, "turn.completed")).payload).toMatchObject({
        state: "failed",
        tokenUsage: { usageStatus: "unavailable" },
      });
      expect((yield* adapter.listSessions())[0]).toMatchObject({
        status: "error",
        resumeCursor: initialSession().resumeCursor,
      });
    }),
  );

it.effect(
  "repair R4 missing receipts remain unavailable and mixed optional counts remain partial",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const queue = yield* subscribe(adapter.streamEvents);
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "prompt" });
      const interrupting = yield* Effect.forkScoped(adapter.interruptTurn(threadId, turn.turnId));
      yield* Queue.take(fake.controls);
      yield* fake.settle(fake.operations[1]!, "success");
      yield* Fiber.join(interrupting);
      expect((yield* nextType(queue, "turn.completed")).payload).toMatchObject({
        tokenUsage: { usageStatus: "unavailable" },
      });
      yield* adapter.sendTurn({ threadId, input: "prompt" });
      const operation = fake.operations[2]!;
      const output = fake.output(operation, "success");
      const second = reportedReceipt(2, 40, 8);
      yield* Deferred.succeed(operation.result, {
        ...output,
        terminal: {
          ...output.terminal,
          accountingReceipts: [
            reportedReceipt(1, 60, 12),
            { ...second, usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 } },
          ],
        },
      });
      expect((yield* nextType(queue, "turn.completed")).payload).toMatchObject({
        tokenUsage: {
          usageStatus: "partial",
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 7,
        },
      });
    }),
);

for (const source of ["prepare", "read", "stop", "failure-code", "session"] as const)
  it.effect(`repair R5 ${source} diagnostics stay behind closed public messages`, () =>
    Effect.gen(function* () {
      const marker = "private-diagnostic-marker";
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const queue = yield* subscribe(adapter.streamEvents);
      if (source === "prepare") {
        fake.state.prepareError = new PiManagedRuntimeError({ code: "denied", detail: marker });
        expect(json(yield* Effect.exit(adapter.startSession(startInput)))).not.toContain(marker);
        return;
      }
      yield* adapter.startSession(startInput);
      yield* nextType(queue, "session.started");
      if (source === "read") {
        fake.state.readError = new PiManagedRuntimeError({ code: "unavailable", detail: marker });
        expect(json(yield* Effect.exit(adapter.startSession(startInput)))).not.toContain(marker);
        expect(json(yield* Effect.exit(adapter.readThread(threadId)))).not.toContain(marker);
        return;
      }
      if (source === "stop") {
        fake.state.stopError = new PiManagedRuntimeError({ code: "uncertain", detail: marker });
        expect(json(yield* Effect.exit(adapter.stopSession(threadId)))).not.toContain(marker);
        expect(json(yield* nextType(queue, "session.state.changed"))).not.toContain(marker);
      } else if (source === "session") {
        fake.state.session = { ...initialSession(), lastError: marker };
        expect(json(yield* adapter.startSession(startInput))).not.toContain(marker);
      } else {
        yield* adapter.sendTurn({ threadId, input: "prompt" });
        const operation = fake.operations[1]!;
        const output = fake.output(operation, "failed");
        yield* Deferred.succeed(operation.result, {
          ...output,
          terminal: { ...output.terminal, failureCode: marker },
        });
        expect(json(yield* nextType(queue, "turn.completed"))).not.toContain(marker);
      }
      expect(json(yield* adapter.listSessions())).not.toContain(marker);
    }),
  );
