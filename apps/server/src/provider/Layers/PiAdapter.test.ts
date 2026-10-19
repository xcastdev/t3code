import { expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EventId,
  ManagedSkillKey,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  SkillCatalogRevision,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
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
import type { ProviderSkillPlan } from "../../skills/ProviderSkillAdapter.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import { getProviderTurnEventSubscription } from "../ProviderTurnPublications.ts";

const instanceId = ProviderInstanceId.make("pi-one");
const threadId = ThreadId.make("managed-thread");
const provider = ProviderDriverKind.make("piAgent");
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const stopReasonModes = [
  "typed-pair",
  "two-defects",
  "same-safe-pair",
  "mixed",
  "mixed-interrupts",
  "interrupt-pair",
] as const;
const stopReasons = (mode: (typeof stopReasonModes)[number]) => {
  const typed = [
    Cause.makeFailReason(
      new PiManagedRuntimeError({ code: "denied", detail: "private-stop-first" }),
    ),
    Cause.makeFailReason(
      new PiManagedRuntimeError({ code: "unavailable", detail: "private-stop-second" }),
    ),
  ];
  const defects = [
    Cause.makeDieReason("private-stop-defect"),
    Cause.makeDieReason(new Error("private-stop-defect")),
  ];
  const interrupts = [Cause.makeInterruptReason(701), Cause.makeInterruptReason(702)];
  const reasons =
    mode === "typed-pair"
      ? typed
      : mode === "two-defects"
        ? defects
        : mode === "same-safe-pair"
          ? [
              typed[0]!,
              Cause.makeFailReason(
                new PiManagedRuntimeError({ code: "denied", detail: "private-stop-duplicate" }),
              ),
            ]
          : mode === "mixed"
            ? [...typed, ...defects]
            : mode === "interrupt-pair"
              ? interrupts
              : [typed[0]!, interrupts[0]!, defects[0]!, typed[1]!, interrupts[1]!, defects[1]!];
  // Shared annotations must not become an artificial occurrence discriminator.
  return reasons.map((reason) =>
    reason.annotate(Context.makeUnsafe(new Map([["stopCorrelation", "owned-stop"]]))),
  );
};
const expectSafeStop = (
  exit: Exit.Exit<unknown, unknown>,
  expected: ReturnType<typeof stopReasons>,
  method: string,
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) return;
  expect(exit.cause.reasons).toHaveLength(expected.length);
  for (const [index, reason] of exit.cause.reasons.entries()) {
    const prior = expected[index]!;
    if (Cause.isInterruptReason(prior))
      expect(reason).toMatchObject({ _tag: "Interrupt", fiberId: prior.fiberId });
    else {
      const code = Cause.isFailReason(prior) ? prior.error.code : "uncertain";
      expect(reason).toMatchObject({
        _tag: "Fail",
        error: {
          _tag: "ProviderAdapterRequestError",
          method,
          detail: {
            denied: "Pi authorization was denied. Review the current assignment and permissions.",
            conflict:
              "Pi operation conflicts with current state. Refresh the session before retrying.",
            unavailable: "Pi operation is unavailable. Review its setup and runtime availability.",
            uncertain:
              "Pi operation could not be confirmed. Reconcile the owned session before retrying.",
          }[code],
        },
      });
    }
    for (const [key, value] of prior.annotations) expect(reason!.annotations.get(key)).toBe(value);
  }
  expect(json(exit)).not.toContain("private-stop");
};
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

it.effect(
  "the actual adapter exposes an eager owned event subscription before initialization",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const eager = getProviderTurnEventSubscription(adapter);
      if (!eager) return yield* Effect.die("Actual Pi adapter has no eager source");
      const subscription = yield* eager;
      yield* adapter.startSession(startInput);
      const event = yield* PubSub.take(subscription);
      expect(event.type).toBe("session.started");
      expect(event.providerInstanceId).toBe(instanceId);
      expect(event.threadId).toBe(threadId);
      expect(getProviderTurnEventSubscription({ ...adapter })).toBeUndefined();
    }),
);

it.effect("carries an isolated explicit skill plan into initialization and subsequent turns", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const key = ManagedSkillKey.make("review");
    const plan = {
      providerInstanceId: instanceId,
      desiredRevision: SkillCatalogRevision.make(7),
      applicationMode: "new_session_required" as const,
      skillKeys: [key],
      payload: {
        kind: "pi-managed-skills",
        root: "/owned/skills",
        skills: [{ key, path: "/owned/skills/review/SKILL.md" }],
      },
    };
    yield* adapter.startSession({ ...startInput, skillPlan: plan });
    expect(fake.requests[0]?.skillPlan).toEqual(plan);
    const expected = structuredClone(plan);
    plan.payload.skills[0]!.path = "/untrusted/replaced";
    plan.skillKeys.length = 0;
    expect(fake.requests[0]?.skillPlan).toEqual(expected);
    yield* adapter.sendTurn({ threadId, input: "use selected skills" });
    expect(fake.requests[1]?.skillPlan).toEqual(expected);
    expect(fake.requests[1]?.skillPlan).not.toBe(fake.requests[0]?.skillPlan);
    yield* fake.settle(fake.operations[1]!, "success");
    yield* Deferred.await(fake.operations[1]!.result);
  }),
);

it.effect("rejects a foreign skill plan before acquiring a managed operation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.startSession({
            ...startInput,
            skillPlan: {
              providerInstanceId: ProviderInstanceId.make("foreign"),
              desiredRevision: SkillCatalogRevision.make(0),
              applicationMode: "new_session_required",
              skillKeys: [],
              payload: null,
            },
          }),
        ),
      ),
    ).toBe(true);
    expect(fake.requests).toHaveLength(0);
  }),
);

// Selected-content admission belongs to the real runtime; these plans exercise adapter transport only.
const readyPlan = (revision = 7, root = "/owned/skills", hash = "selected-package-v1") => {
  const key = ManagedSkillKey.make("review");
  return {
    providerInstanceId: instanceId,
    desiredRevision: SkillCatalogRevision.make(revision),
    applicationMode: "new_session_required" as const,
    skillKeys: [key],
    payload: {
      kind: "pi-managed-skills",
      root,
      skills: [{ key, path: `${root}/review/SKILL.md`, packageHash: hash }],
    },
  };
};

it.effect("ready plan accepts a fresh revision and root after runtime validation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const original = readyPlan();
    const refreshed = readyPlan(8, "/owned/refreshed");
    yield* adapter.startSession({ ...startInput, skillPlan: original });
    expect(yield* adapter.startSession({ ...startInput, skillPlan: refreshed })).toEqual(
      initialSession(),
    );
    expect(fake.readPlans).toEqual([refreshed]);
    yield* adapter.startSession(startInput);
    expect(fake.readPlans).toEqual([refreshed, refreshed]);
    yield* adapter.sendTurn({ threadId, input: "use validated plan" });
    expect(fake.requests[1]?.skillPlan).toEqual(refreshed);
    expect(fake.requests).toHaveLength(2);
    yield* fake.settle(fake.operations[1]!, "success");
  }),
);

it.effect("ready plan revalidates an omitted caller plan against the stored snapshot", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const original = readyPlan();
    yield* adapter.startSession({ ...startInput, skillPlan: original });
    fake.state.readError = denied;
    expect(json(yield* Effect.exit(adapter.startSession(startInput)))).toContain(
      "ProviderAdapterRequestError",
    );
    expect(fake.readPlans).toEqual([original]);
    expect(fake.requests).toHaveLength(1);
    expect(yield* adapter.listSessions()).toEqual([initialSession()]);
  }),
);

for (const code of ["denied", "conflict"] as const)
  it.effect(`ready plan preserves its prior snapshot when runtime reports ${code}`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const original = readyPlan();
      const changed = readyPlan(8, "/owned/changed", "selected-package-v2");
      yield* adapter.startSession({ ...startInput, skillPlan: original });
      fake.state.readError = new PiManagedRuntimeError({
        code,
        detail: "selected content changed",
      });
      const result = yield* Effect.exit(
        adapter.startSession({ ...startInput, skillPlan: changed }),
      );
      expect(json(result)).toContain("ProviderAdapterRequestError");
      expect(fake.readPlans).toEqual([changed]);
      expect(yield* adapter.listSessions()).toEqual([initialSession()]);
      fake.state.readError = undefined;
      yield* adapter.startSession(startInput);
      expect(fake.readPlans[1]).toEqual(original);
      yield* adapter.sendTurn({ threadId, input: "use prior validated plan" });
      expect(fake.requests[1]?.skillPlan).toEqual(original);
      yield* fake.settle(fake.operations[1]!, "success");
    }),
  );

it.effect("ready plan publishes only after the refreshed session passes hint checks", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const original = readyPlan();
    const refreshed = readyPlan(8, "/owned/refreshed");
    yield* adapter.startSession({ ...startInput, skillPlan: original });
    fake.state.session = { ...initialSession(), updatedAt: "2026-10-01T01:00:00.000Z" };
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          adapter.startSession({ ...startInput, skillPlan: refreshed, cwd: "/stale/worktree" }),
        ),
      ),
    ).toBe(true);
    expect(fake.readPlans).toEqual([refreshed]);
    expect(yield* adapter.listSessions()).toEqual([initialSession()]);
    yield* adapter.sendTurn({ threadId, input: "retain prior plan after stale hints" });
    expect(fake.requests[1]?.skillPlan).toEqual(original);
    yield* fake.settle(fake.operations[1]!, "success");
  }),
);

it.effect("ready plan isolates caller mutation while its runtime read is held", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const runtime: PiManagedRuntimeInstance = {
      ...fake.runtime,
      readSession: Effect.fn("PiAdapter.test.heldPlanRead")(function* (thread, plan) {
        const snapshot = yield* fake.runtime.readSession(thread, plan);
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return snapshot;
      }),
    };
    const adapter = yield* makePiAdapter({ instanceId, runtime });
    const callerPlan = readyPlan();
    const expected = structuredClone(callerPlan);
    yield* adapter.startSession({ ...startInput, skillPlan: callerPlan });
    const reading = yield* Effect.forkScoped(
      Effect.exit(adapter.startSession({ ...startInput, skillPlan: callerPlan })),
      { startImmediately: true },
    );
    yield* Deferred.await(entered);
    callerPlan.payload.skills[0]!.path = "/caller/mutated";
    callerPlan.skillKeys.length = 0;
    yield* Deferred.succeed(release, undefined);
    expect(Exit.isSuccess(yield* Fiber.join(reading))).toBe(true);
    expect(fake.readPlans).toEqual([expected]);
    yield* adapter.sendTurn({ threadId, input: "use read-time snapshot" });
    expect(fake.requests[1]?.skillPlan).toEqual(expected);
    yield* fake.settle(fake.operations[1]!, "success");
  }),
);

for (const race of ["newer refresh", "stopSession"] as const)
  it.effect(`ready plan rejects its obsolete read after ${race}`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const runtime: PiManagedRuntimeInstance = {
        ...fake.runtime,
        readSession: Effect.fn("PiAdapter.test.overlappingPlanRead")(function* (thread, plan) {
          const hold = reads++ === 0;
          const snapshot = yield* fake.runtime.readSession(thread, plan);
          if (hold) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return snapshot;
        }),
      };
      const adapter = yield* makePiAdapter({ instanceId, runtime });
      const original = readyPlan();
      const newer = readyPlan(8, "/owned/newer");
      yield* adapter.startSession({ ...startInput, skillPlan: original });
      const reading = yield* Effect.forkScoped(
        Effect.exit(adapter.startSession({ ...startInput, skillPlan: original })),
        { startImmediately: true },
      );
      yield* Deferred.await(entered);
      const refreshing =
        race === "newer refresh"
          ? yield* Effect.exit(adapter.startSession({ ...startInput, skillPlan: newer }))
          : undefined;
      if (race === "stopSession") yield* adapter.stopSession(threadId);
      yield* Deferred.succeed(release, undefined);
      const obsolete = yield* Fiber.join(reading);
      if (refreshing) expect(Exit.isSuccess(refreshing)).toBe(true);
      expect(Exit.isFailure(obsolete)).toBe(true);
      if (race === "newer refresh") {
        // The fake returns the identical session object, so only plan publication changes identity.
        expect(yield* adapter.listSessions()).toEqual([initialSession()]);
        yield* adapter.sendTurn({ threadId, input: "retain newer validated plan" });
        expect(fake.requests[1]?.skillPlan).toEqual(newer);
        yield* fake.settle(fake.operations[1]!, "success");
      } else {
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(fake.requests).toHaveLength(1);
      }
    }),
  );

it.effect("refuses uncopyable explicit skill payloads before a logical session is installed", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    const plan = {
      providerInstanceId: instanceId,
      desiredRevision: SkillCatalogRevision.make(0),
      applicationMode: "new_session_required" as const,
      skillKeys: [],
      payload: () => undefined,
    };
    expect(
      Exit.isFailure(yield* Effect.exit(adapter.startSession({ ...startInput, skillPlan: plan }))),
    ).toBe(true);
    expect(fake.requests).toHaveLength(0);
    yield* adapter.startSession(startInput);
    expect(fake.requests).toHaveLength(1);
  }),
);
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
  const readPlans: Array<ProviderSkillPlan | undefined> = [];
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
        operationId: request.operationId ?? `root-operation-${operations.length}`,
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
    readSession: (_thread, plan) =>
      Effect.suspend(() => {
        readPlans.push(plan);
        return state.readError ? Effect.fail(state.readError) : Effect.succeed(state.session);
      }),
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
    readPlans,
    preparedQueue,
    stopped,
    requestsQueue,
    controls,
    settle,
    output,
  };
});

it.effect(
  "native compact retains its request identity and publishes only a joined successful terminal",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
      const compaction = adapter.compaction;
      if (compaction?.type !== "native")
        return yield* Effect.die("Missing native compaction capability");
      yield* adapter.startSession(startInput);
      const eager = getProviderTurnEventSubscription(adapter);
      if (!eager) return yield* Effect.die("Missing native compaction event source");
      const subscription = yield* eager;
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkChild,
      );
      const requestId = MessageId.make("adapter-compact-one");
      const running = yield* compaction
        .start(threadId, undefined, requestId)
        .pipe(Effect.forkChild);
      yield* Queue.take(fake.preparedQueue);
      const operation = yield* Queue.take(fake.preparedQueue);
      expect(fake.requests.at(-1)).toMatchObject({ kind: "compact", threadId, requestId });
      expect(yield* Deferred.isDone(operation.result)).toBe(false);
      yield* fake.settle(operation, "success");
      yield* Fiber.join(running);
      const compacted = yield* Queue.take(events);
      expect(compacted).toMatchObject({
        type: "thread.state.changed",
        payload: { state: "compacted" },
      });
      expect(Exit.isFailure(yield* Effect.exit(compaction.start(threadId)))).toBe(true);
      expect(fake.requests).toHaveLength(2);
    }).pipe(Effect.scoped),
);
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

it.effect("retained compact receipt keeps the adapter at its audited successor session head", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    let first: FakeOperation | undefined;
    let successor: FakeOperation | undefined;
    const runtime: PiManagedRuntimeInstance = {
      ...fake.runtime,
      prepareOperation: (request, observe) => {
        if (
          request.kind === "compact" &&
          request.requestId === "adapter-first" &&
          first &&
          successor
        ) {
          const receipt = first;
          const head = successor;
          return Effect.succeed({
            ...receipt.prepared,
            replayHeadOperationId: head.prepared.operation.operationId,
            run: Effect.succeed(fake.output(receipt, "success", fake.state.session)),
          });
        }
        return fake.runtime.prepareOperation(request, observe);
      },
    };
    const adapter = yield* makePiAdapter({ instanceId, runtime });
    const compaction = adapter.compaction;
    if (compaction?.type !== "native") return yield* Effect.die("Missing native compact port");
    yield* adapter.startSession(startInput);
    yield* Queue.take(fake.preparedQueue);
    const source = getProviderTurnEventSubscription(adapter);
    if (!source) return yield* Effect.die("Missing owned event source");
    const subscription = yield* source;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkChild,
    );
    const one = yield* compaction
      .start(threadId, undefined, MessageId.make("adapter-first"))
      .pipe(Effect.forkChild);
    first = yield* Queue.take(fake.preparedQueue);
    yield* fake.settle(first, "success", {
      ...fake.state.session,
      resumeCursor: { leafId: "first" },
    });
    yield* Fiber.join(one);
    expect((yield* Queue.take(events)).type).toBe("thread.state.changed");
    const two = yield* compaction
      .start(threadId, undefined, MessageId.make("adapter-second"))
      .pipe(Effect.forkChild);
    successor = yield* Queue.take(fake.preparedQueue);
    yield* fake.settle(successor, "success", {
      ...fake.state.session,
      resumeCursor: { leafId: "successor" },
    });
    yield* Fiber.join(two);
    expect((yield* Queue.take(events)).type).toBe("thread.state.changed");
    const latest = yield* adapter.listSessions();
    expect(yield* compaction.start(threadId, undefined, MessageId.make("adapter-first"))).toEqual({
      kind: "retained",
    });
    expect(yield* adapter.listSessions()).toEqual(latest);
    expect(fake.operations).toHaveLength(3);
    yield* adapter.stopSession(threadId);
    const closed = yield* Queue.take(events);
    expect(closed.type).toBe("session.exited");
    expect(closed.eventId).toContain(successor.prepared.operation.operationId);
  }).pipe(Effect.scoped),
);
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
    expect(adapter.compaction).toMatchObject({ type: "native" });
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

// The default scheduler yields after 2048 operations, including returns from Effect helpers.
it.live("repair read R1 scheduler boundary cannot publish a snapshot after stop begins", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const returning = yield* Deferred.make<void>();
    const stopRelease = yield* Deferred.make<void>();
    let reusing = false;
    let sawReadOwnership = false;
    let sawClosingOwnership = false;
    const nativeTracer = yield* Effect.tracer;
    // Observe helper returns without replacing the scheduler or changing adapter state.
    const tracer: Tracer.Tracer = {
      span(options) {
        return nativeTracer.span(options);
      },
      context(primitive, fiber) {
        if (
          reusing &&
          "_tag" in primitive &&
          primitive._tag === "Success" &&
          "value" in primitive
        ) {
          const value = primitive.value;
          if (
            typeof value === "object" &&
            value !== null &&
            "threadId" in value &&
            value.threadId === threadId &&
            "closing" in value &&
            typeof value.closing === "boolean"
          ) {
            sawReadOwnership = true;
            if (value.closing) sawClosingOwnership = true;
          }
        }
        return primitive["~effect/Effect/evaluate"](fiber);
      },
    };
    const snapshot = { ...initialSession(), updatedAt: "2026-10-01T01:00:00.000Z" };
    const runtime: PiManagedRuntimeInstance = {
      ...fake.runtime,
      readSession: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          // On the old adapter this read tail reaches the final ownership helper at operation 2047.
          for (let index = 0; index < 2001; index++) yield* Effect.sync(() => undefined);
          yield* Deferred.succeed(returning, undefined);
          yield* Effect.withFiber(() => Effect.sync(() => undefined));
          return snapshot;
        }),
      requestStop: () => Deferred.await(stopRelease),
    };
    return yield* Effect.gen(function* () {
      const adapter = yield* makePiAdapter({ instanceId, runtime });
      const original = yield* adapter.startSession(startInput);
      reusing = true;
      const stopping = yield* Effect.forkScoped(
        Deferred.await(returning).pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.andThen(adapter.stopSession(threadId)),
        ),
        { startImmediately: true },
      );
      const reading = yield* Effect.forkScoped(Effect.exit(adapter.startSession(startInput)), {
        startImmediately: true,
      });
      yield* Deferred.await(entered);
      yield* Deferred.succeed(release, undefined);
      const read = yield* Fiber.join(reading);
      const sessions = yield* adapter.listSessions();
      yield* Deferred.succeed(stopRelease, undefined);
      yield* Fiber.join(stopping);
      expect(sawReadOwnership).toBe(true);
      expect(Exit.isSuccess(read) && sawClosingOwnership).toBe(false);
      expect(sessions).toEqual([Exit.isSuccess(read) ? snapshot : original]);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  }),
);

it.effect("repair initialization R1 canceled terminal cannot replace a closing snapshot", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    fake.state.stopSettles = false;
    fake.state.stopGates = [yield* Deferred.make<void>()];
    const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
    yield* adapter.startSession(startInput);
    const turn = yield* adapter.sendTurn({ threadId, input: "prompt" });
    const settling = yield* Effect.forkScoped(
      Effect.exit(adapter.interruptTurn(threadId, turn.turnId)),
      { startImmediately: true },
    );
    yield* Queue.take(fake.controls);
    const closingSnapshot = yield* adapter.listSessions();
    const stopping = yield* Effect.forkScoped(adapter.stopSession(threadId), {
      startImmediately: true,
    });
    yield* Queue.take(fake.stopped);
    yield* fake.settle(fake.operations[1]!, "canceled", {
      ...initialSession(),
      resumeCursor: "later-canceled-leaf",
    });
    expect(Exit.isSuccess(yield* Fiber.join(settling))).toBe(true);
    const afterTerminal = yield* adapter.listSessions();
    yield* Deferred.succeed(fake.state.stopGates[0]!, undefined);
    yield* Fiber.join(stopping);
    expect(afterTerminal).toEqual(closingSnapshot);
    expect(yield* adapter.hasSession(threadId)).toBe(false);
  }),
);

for (const stop of ["stopSession", "stopAll"] as const)
  it.live(`repair initialization R1 native scheduler publication is fenced by ${stop}`, () =>
    Effect.gen(function* () {
      let beforeFence = 0;
      let observedFence = 0;
      for (let tail = 1950; tail < 2080; tail++) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const release = yield* Deferred.make<void>();
            const entered = yield* Deferred.make<void>();
            const returning = yield* Deferred.make<void>();
            const stopRelease = yield* Deferred.make<void>();
            let context: { closing: boolean; session?: unknown } | undefined;
            const isSessionContext = (
              value: unknown,
            ): value is { closing: boolean; session?: unknown } =>
              typeof value === "object" &&
              value !== null &&
              "threadId" in value &&
              value.threadId === threadId &&
              "closing" in value &&
              typeof value.closing === "boolean";
            let observing = true;
            let closedBeforePublication = false;
            let publishedAfterFence = false;
            const nativeTracer = yield* Effect.tracer;
            // Observe the ordinary context returned by owned(), without modifying it or the scheduler.
            const tracer: Tracer.Tracer = {
              span(options) {
                return nativeTracer.span(options);
              },
              context(primitive, fiber) {
                if (
                  observing &&
                  "_tag" in primitive &&
                  primitive._tag === "Success" &&
                  "value" in primitive
                ) {
                  const value = primitive.value;
                  if (isSessionContext(value)) context = value;
                }
                if (observing && context) {
                  if (context.closing && context.session === undefined)
                    closedBeforePublication = true;
                  if (closedBeforePublication && context.session !== undefined)
                    publishedAfterFence = true;
                }
                return primitive["~effect/Effect/evaluate"](fiber);
              },
            };
            const session = initialSession();
            const operation = {
              operationId: "initialization-boundary",
              operationKind: "initialize" as const,
            };
            const output: Output = {
              session,
              terminal: {
                identity: { workerId: "fixture-owner", generation: 1 },
                operation,
                outcome: "success",
                ownerCaptured: true,
                native: null,
                accountingReceipts: [],
                drain: {
                  unit: "fixture",
                  invocation: "fixture",
                  cgroup: "fixture",
                  ownerPid: null,
                  launcherPid: 1,
                  childPid: null,
                  childExitCode: 0,
                  kernel: "fixture",
                  memoryBytes: 1,
                  swapBytes: 0,
                  oomGroup: 0,
                },
              },
            };
            const runtime: PiManagedRuntimeInstance = {
              inspect: Effect.die("unused"),
              prepareOperation: () =>
                Effect.succeed({
                  kind: "initialize",
                  operation,
                  run: Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(release);
                    // Sweep the native 2048-operation budget across validation and helper returns.
                    for (let index = 0; index < tail; index++) yield* Effect.sync(() => undefined);
                    yield* Deferred.succeed(returning, undefined);
                    yield* Effect.withFiber(() => Effect.sync(() => undefined));
                    return output;
                  }),
                  interrupt: Effect.succeed({ controlId: 1, status: "unresolved" }),
                  steer: () => Effect.succeed({ controlId: 2, status: "unresolved" }),
                }),
              readSession: () => Effect.succeed(session),
              readThread: () => Effect.die("unused"),
              requestStop: () => Deferred.await(stopRelease),
              stopAll: Deferred.await(stopRelease),
              authorizeSkills: () => Effect.succeed([]),
              discoverNativeSkills: () => Effect.succeed([]),
            };
            yield* Effect.gen(function* () {
              const adapter = yield* makePiAdapter({ instanceId, runtime });
              const stopping = yield* Effect.forkScoped(
                Deferred.await(returning).pipe(
                  Effect.andThen(Effect.yieldNow),
                  Effect.andThen(
                    stop === "stopSession" ? adapter.stopSession(threadId) : adapter.stopAll(),
                  ),
                ),
                { startImmediately: true },
              );
              const starting = yield* Effect.forkScoped(
                Effect.exit(adapter.startSession(startInput)),
                { startImmediately: true },
              );
              yield* Deferred.await(entered);
              expect(
                Exit.isFailure(
                  yield* Effect.exit(adapter.sendTurn({ threadId, input: "initializing" })),
                ),
              ).toBe(true);
              expect(context).toBeDefined();
              yield* Deferred.succeed(release, undefined);
              const result = yield* Fiber.join(starting);
              observing = false;
              if (closedBeforePublication) observedFence++;
              if (Exit.isSuccess(result) && !closedBeforePublication) beforeFence++;
              yield* Deferred.succeed(stopRelease, undefined);
              yield* Fiber.join(stopping);
              expect(publishedAfterFence, `tail ${tail}`).toBe(false);
              expect(Exit.isSuccess(result) && closedBeforePublication, `tail ${tail}`).toBe(false);
              expect(yield* adapter.hasSession(threadId)).toBe(false);
            }).pipe(Effect.provideService(Tracer.Tracer, tracer));
          }),
        );
      }
      expect(observedFence).toBeGreaterThan(0);
      expect(beforeFence).toBeGreaterThan(0);
    }),
  );

const reportedReceipt = (
  requestId: number,
  inputTokens: number,
  outputTokens: number,
  receiptProvider: PiModelAccountingReceipt["provider"] = "command-code",
): PiModelAccountingReceipt => ({
  requestId,
  reservationId: `reservation-${requestId}`,
  accountingReceiptId: `accounting-${requestId}`,
  routeId: receiptProvider === "openai-codex" ? "openai-subscription-luna" : "frozen-route",
  provider: receiptProvider,
  model: receiptProvider === "openai-codex" ? "gpt-6-luna" : "frozen-model",
  reportedModel: receiptProvider === "openai-codex" ? "gpt-6-luna" : "reported-alias",
  usage: {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: requestId === 1 ? 7 : 3 },
  },
});
for (const receiptProvider of ["command-code", "openai-codex"] as const)
  for (const outcome of ["success", "canceled", "failed"] as const)
    it.effect(
      `repair R4 ${receiptProvider} ${outcome} preserves deduplicated authoritative usage`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFake();
          const adapter = yield* makePiAdapter({ instanceId, runtime: fake.runtime });
          const queue = yield* subscribe(adapter.streamEvents);
          yield* adapter.startSession(startInput);
          yield* adapter.sendTurn({ threadId, input: "prompt" });
          const operation = fake.operations[1]!;
          const output = fake.output(operation, outcome);
          const first = reportedReceipt(1, 60, 12, receiptProvider);
          const second = reportedReceipt(2, 40, 8, receiptProvider);
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

// Stable IDs come from a private Root callback; these tests prove transport and adapter lifetime only.
it.effect("forwards exact Root operation IDs for initialization and assignment prompts", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const resolved: PiManagedOperationRequest[] = [];
    const adapter = yield* makePiAdapter({
      instanceId,
      runtime: fake.runtime,
      resolveOperationId: (request) => {
        resolved.push(request);
        return Effect.succeed(
          request.kind === "initialize" ? "dispatch_initialize" : "dispatch_assignment",
        );
      },
    });
    const queue = yield* subscribe(adapter.streamEvents);
    yield* adapter.startSession(startInput);
    yield* nextType(queue, "session.started");
    const turn = yield* adapter.sendTurn({ threadId, input: "approved assignment" });
    expect(fake.requests.map((request) => request.operationId)).toEqual([
      "dispatch_initialize",
      "dispatch_assignment",
    ]);
    expect(resolved.map((request) => request.kind)).toEqual(["initialize", "prompt"]);
    expect(turn.turnId).toBe(fake.operations[1]!.prepared.turnId);
    expect((yield* nextType(queue, "turn.started")).eventId).toContain("dispatch_assignment");
    // Preparation acknowledgment alone cannot prove native assignment consumption or completion.
    expect(yield* Deferred.isDone(fake.operations[1]!.result)).toBe(false);
    expect(yield* Queue.size(queue)).toBe(0);
    yield* fake.settle(fake.operations[1]!, "success");
    expect((yield* nextType(queue, "turn.completed")).eventId).toContain("dispatch_assignment");
  }),
);

it.effect("captures the Root resolver when the factory is called", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    let originalCalls = 0;
    let replacementCalls = 0;
    const options = {
      instanceId,
      runtime: fake.runtime,
      resolveOperationId: (_request: PiManagedOperationRequest) => {
        originalCalls++;
        return Effect.succeed("captured_root_id");
      },
    };
    const creation = makePiAdapter(options);
    options.resolveOperationId = () => {
      replacementCalls++;
      return Effect.succeed("replacement_root_id");
    };
    const adapter = yield* creation;
    yield* adapter.startSession(startInput);
    expect(fake.requests[0]?.operationId).toBe("captured_root_id");
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  }),
);

it.effect("undefined Root identity preserves ordinary Runtime allocation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const adapter = yield* makePiAdapter({
      instanceId,
      runtime: fake.runtime,
      resolveOperationId: () => Effect.succeed(undefined),
    });
    yield* adapter.startSession(startInput);
    yield* adapter.sendTurn({ threadId, input: "ordinary prompt" });
    expect(fake.requests.every((request) => request.operationId === undefined)).toBe(true);
    expect(fake.operations[1]!.prepared.operation.operationId).toBe("root-operation-1");
    yield* fake.settle(fake.operations[1]!, "success");
  }),
);

it.effect("keeps the held resolver request immutable and isolated from caller hints", () =>
  Effect.gen(function* () {
    const fake = yield* makeFake();
    const entered = yield* Deferred.make<PiManagedOperationRequest>();
    const release = yield* Deferred.make<void>();
    const callerPlan = readyPlan();
    const expected = structuredClone(callerPlan);
    const cursor = { sessionId: "native-one", leafId: "leaf-0" };
    const adapter = yield* makePiAdapter({
      instanceId,
      runtime: fake.runtime,
      resolveOperationId: Effect.fn("PiAdapter.test.heldImmutableResolver")(function* (request) {
        yield* Deferred.succeed(entered, request);
        yield* Deferred.await(release);
        return "immutable_root_id";
      }),
    });
    const starting = yield* Effect.forkScoped(
      Effect.exit(
        adapter.startSession({
          ...startInput,
          skillPlan: callerPlan,
          resumeCursor: cursor,
        }),
      ),
    );
    const snapshot = yield* Deferred.await(entered);
    callerPlan.payload.skills[0]!.path = "/caller/replaced";
    cursor.leafId = "caller-replaced";
    expect(() =>
      Object.assign(snapshot, { threadId: ThreadId.make("resolver-replaced") }),
    ).toThrow();
    expect(() => {
      const payload = snapshot.skillPlan!.payload;
      if (payload !== null && typeof payload === "object")
        Object.assign(payload, { root: "/resolver/replaced" });
    }).toThrow();
    yield* Deferred.succeed(release, undefined);
    expect(Exit.isSuccess(yield* Fiber.join(starting))).toBe(true);
    expect(fake.requests[0]?.skillPlan).toEqual(expected);
    expect(fake.requests[0]?.resumeCursor).toEqual({ sessionId: "native-one", leafId: "leaf-0" });
    expect(fake.requests[0]?.operationId).toBe("immutable_root_id");
  }),
);

for (const operationId of ["", "bad/id", "bad id", "bad.id", "x".repeat(129)])
  it.effect(
    `rejects malformed Root identity ${operationId.length}:${operationId.slice(0, 8)}`,
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFake();
        const adapter = yield* makePiAdapter({
          instanceId,
          runtime: fake.runtime,
          resolveOperationId: () => Effect.succeed(operationId),
        });
        const result = yield* Effect.exit(adapter.startSession(startInput));
        expect(json(result)).toContain("ProviderAdapterRequestError");
        expect(fake.requests).toHaveLength(0);
        expect(fake.state.stopCalls).toBe(0);
        expect(yield* adapter.hasSession(threadId)).toBe(false);
      }),
  );

for (const code of ["denied", "conflict", "unavailable", "uncertain"] as const)
  it.effect(`denies Root resolver ${code} without allocating or stopping Runtime work`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const marker = "private resolver diagnostic";
      const adapter = yield* makePiAdapter({
        instanceId,
        runtime: fake.runtime,
        resolveOperationId: () => Effect.fail(new PiManagedRuntimeError({ code, detail: marker })),
      });
      const result = yield* Effect.exit(adapter.startSession(startInput));
      expect(json(result)).toContain("ProviderAdapterRequestError");
      expect(json(result)).not.toContain(marker);
      expect(fake.requests).toHaveLength(0);
      expect(fake.state.stopCalls).toBe(0);
    }),
  );

for (const failure of ["throw", "defect"] as const)
  it.effect(`denies a Root resolver ${failure} with a safe typed failure`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const marker = "private resolver exception";
      const adapter = yield* makePiAdapter({
        instanceId,
        runtime: fake.runtime,
        resolveOperationId: () => {
          if (failure === "throw") throw new Error(marker);
          return Effect.die(new Error(marker));
        },
      });
      const result = yield* Effect.exit(adapter.startSession(startInput));
      expect(json(result)).toContain("ProviderAdapterRequestError");
      expect(json(result)).not.toContain(marker);
      expect(fake.requests).toHaveLength(0);
      expect(fake.state.stopCalls).toBe(0);
    }),
  );

for (const kind of ["initialize", "prompt"] as const)
  for (const stop of ["stopSession", "stopAll", "interruption"] as const)
    it.effect(`a held ${kind} resolver racing ${stop} cannot prepare Runtime work`, () =>
      Effect.gen(function* () {
        const fake = yield* makeFake();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const shutdownEntered = yield* Deferred.make<void>();
        const runtime: PiManagedRuntimeInstance = {
          ...fake.runtime,
          stopAll: Deferred.succeed(shutdownEntered, undefined).pipe(
            Effect.andThen(fake.runtime.stopAll),
          ),
        };
        let held = true;
        const adapter = yield* makePiAdapter({
          instanceId,
          runtime,
          resolveOperationId: Effect.fn("PiAdapter.test.heldStoppedResolver")(function* (request) {
            if (request.kind === kind && held) {
              yield* Deferred.succeed(entered, undefined);
              yield* Effect.uninterruptible(Deferred.await(release));
              return "obsolete_root_id";
            }
            return undefined;
          }),
        });
        if (kind === "prompt") yield* adapter.startSession(startInput);
        const before = fake.requests.length;
        const caller = yield* Effect.forkScoped(
          Effect.exit(
            kind === "initialize"
              ? adapter.startSession(startInput).pipe(Effect.asVoid)
              : adapter.sendTurn({ threadId, input: "held assignment" }).pipe(Effect.asVoid),
          ),
        );
        yield* Deferred.await(entered);
        const stopping = yield* Effect.forkScoped(
          stop === "interruption"
            ? Fiber.interrupt(caller)
            : Effect.exit(stop === "stopAll" ? adapter.stopAll() : adapter.stopSession(threadId)),
        );
        if (stop === "stopAll") yield* Deferred.await(shutdownEntered);
        else yield* Queue.take(fake.stopped);
        expect(fake.requests).toHaveLength(before);
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        expect(stopping.pollUnsafe()).toBeUndefined();
        expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        const completed = yield* Effect.exit(Fiber.join(caller));
        if (stop === "interruption") expect(Exit.isFailure(completed)).toBe(true);
        else {
          expect(Exit.isSuccess(completed)).toBe(true);
          if (Exit.isSuccess(completed)) expect(Exit.isFailure(completed.value)).toBe(true);
        }
        expect(fake.requests).toHaveLength(before);
        if (stop !== "stopAll") {
          held = false;
          yield* adapter.startSession(startInput);
          expect(fake.requests).toHaveLength(before + 1);
          expect(fake.requests.at(-1)?.operationId).toBeUndefined();
        }
      }),
    );

for (const kind of ["initialize", "prompt"] as const)
  for (const cleanup of ["success", "failure"] as const)
    it.effect(
      `joins a contradictory ${kind} prepared identity and retains cleanup ${cleanup}`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFake();
          fake.state.autoInitialize = kind !== "initialize";
          const drain = yield* Deferred.make<void>();
          fake.state.stopGates = [drain];
          if (cleanup === "failure")
            fake.state.stopError = new PiManagedRuntimeError({
              code: "uncertain",
              detail: "private contradictory cleanup diagnostic",
            });
          const runtime: PiManagedRuntimeInstance = {
            ...fake.runtime,
            prepareOperation: Effect.fn("PiAdapter.test.contradictoryIdentity")(
              function* (request, observe) {
                const prepared = yield* fake.runtime.prepareOperation(request, observe);
                if (request.kind !== kind) return prepared;
                return {
                  ...prepared,
                  operation: { ...prepared.operation, operationId: "contradictory_identity" },
                };
              },
            ),
          };
          const adapter = yield* makePiAdapter({
            instanceId,
            runtime,
            resolveOperationId: () => Effect.succeed("requested_identity"),
          });
          if (kind === "prompt") yield* adapter.startSession(startInput);
          const caller = yield* Effect.forkScoped(
            Effect.exit(
              kind === "initialize"
                ? adapter.startSession(startInput).pipe(Effect.asVoid)
                : adapter
                    .sendTurn({ threadId, input: "contradictory assignment" })
                    .pipe(Effect.asVoid),
            ),
          );
          const operationIndex = kind === "initialize" ? 0 : 1;
          yield* Queue.take(fake.stopped);
          yield* Effect.addFinalizer(() => Deferred.succeed(drain, undefined));
          expect(caller.pollUnsafe()).toBeUndefined();
          expect(yield* Deferred.isDone(fake.operations[operationIndex]!.started)).toBe(false);
          yield* Deferred.succeed(drain, undefined);
          const result = yield* Fiber.join(caller);
          expect(Exit.isFailure(result)).toBe(true);
          expect(json(result)).toContain(`"method":"${kind}"`);
          if (cleanup === "failure") expect(json(result)).toContain('"method":"stopSession"');
          expect(json(result)).not.toContain("private contradictory cleanup diagnostic");
          expect(fake.state.stopCalls).toBe(1);
          expect(yield* adapter.hasSession(threadId)).toBe(kind === "prompt");
          if (kind === "prompt") expect((yield* adapter.listSessions())[0]?.status).toBe("error");
          expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
          expect(fake.requests).toHaveLength(operationIndex + 1);
        }),
    );

for (const kind of ["initialize", "prompt"] as const)
  for (const mode of [
    "typed-pair",
    "two-defects",
    "mixed",
    "interrupt-pair",
    "mixed-interrupts",
    "unannotated-two-defects",
    "unannotated-mixed",
    "unannotated-same-typed",
    "same-annotations-two-defects",
    "same-annotations-same-typed",
  ] as const)
    it.effect(`repair R1 ${kind} cleanup preserves every ${mode} reason after join`, () =>
      Effect.gen(function* () {
        const fake = yield* makeFake();
        fake.state.autoInitialize = kind !== "initialize";
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const typed = [
          Cause.makeFailReason(
            new PiManagedRuntimeError({ code: "denied", detail: "private-cleanup-first" }),
          ),
          Cause.makeFailReason(
            new PiManagedRuntimeError({ code: "unavailable", detail: "private-cleanup-second" }),
          ),
        ];
        const defects = [
          Cause.makeDieReason("private-cleanup-defect-one"),
          Cause.makeDieReason(new Error("private-cleanup-defect-two")),
        ];
        const interrupts = [Cause.makeInterruptReason(101), Cause.makeInterruptReason(202)];
        const selected = mode.endsWith("same-typed")
          ? [
              typed[0]!,
              Cause.makeFailReason(
                new PiManagedRuntimeError({ code: "denied", detail: "private-cleanup-duplicate" }),
              ),
            ]
          : mode === "typed-pair"
            ? typed
            : mode.endsWith("two-defects")
              ? defects
              : mode === "mixed" || mode === "unannotated-mixed"
                ? [...typed, ...defects]
                : mode === "interrupt-pair"
                  ? interrupts
                  : [
                      typed[0]!,
                      interrupts[0]!,
                      defects[0]!,
                      typed[1]!,
                      interrupts[1]!,
                      defects[1]!,
                    ];
        const cleanupReasons = selected.map((reason, index) =>
          mode.startsWith("unannotated-")
            ? reason
            : reason.annotate(
                Context.makeUnsafe(
                  new Map<string, unknown>([
                    ...(mode.startsWith("same-annotations-")
                      ? []
                      : [["cleanupStep", index] as const]),
                    ["correlation", "owned-identity-cleanup"],
                  ]),
                ),
              ),
        );
        const originalAnnotations = cleanupReasons.map((reason) => [...reason.annotations]);
        const runtime: PiManagedRuntimeInstance = {
          ...fake.runtime,
          prepareOperation: Effect.fn("PiAdapter.test.multipleCleanupIdentity")(
            function* (request, observe) {
              const prepared = yield* fake.runtime.prepareOperation(request, observe);
              if (request.kind !== kind) return prepared;
              return {
                ...prepared,
                operation: { ...prepared.operation, operationId: "contradictory_cleanup_identity" },
              };
            },
          ),
          requestStop: () =>
            Effect.gen(function* () {
              // A caller seeing Interrupt also joins stopContext; its second controlled receipt is settled.
              if (fake.state.stopCalls++ > 0) return;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* Effect.failCause(Cause.fromReasons(cleanupReasons));
            }),
        };
        const adapter = yield* makePiAdapter({
          instanceId,
          runtime,
          resolveOperationId: () => Effect.succeed("requested_cleanup_identity"),
        });
        if (kind === "prompt") yield* adapter.startSession(startInput);
        const caller = yield* Effect.forkScoped(
          Effect.exit(
            kind === "initialize"
              ? adapter.startSession(startInput).pipe(Effect.asVoid)
              : adapter
                  .sendTurn({ threadId, input: "cleanup cardinality assignment" })
                  .pipe(Effect.asVoid),
          ),
        );
        yield* Deferred.await(entered);
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        expect(caller.pollUnsafe()).toBeUndefined();
        expect(yield* Deferred.isDone(fake.operations.at(-1)!.started)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        const completed = yield* Fiber.join(caller);
        expect(Exit.isFailure(completed)).toBe(true);
        if (Exit.isFailure(completed)) {
          const [original, ...retained] = completed.cause.reasons;
          expect(original).toMatchObject({
            _tag: "Fail",
            error: { _tag: "ProviderAdapterRequestError", method: kind },
          });
          expect(retained).toHaveLength(cleanupReasons.length);
          for (const [index, reason] of retained.entries()) {
            const prior = cleanupReasons[index]!;
            if (Cause.isInterruptReason(prior))
              expect(reason).toMatchObject({ _tag: "Interrupt", fiberId: prior.fiberId });
            else {
              expect(reason).toMatchObject({
                _tag: "Fail",
                error: { _tag: "ProviderAdapterRequestError", method: "stopSession" },
              });
              if (
                reason &&
                Cause.isFailReason(reason) &&
                reason.error._tag === "ProviderAdapterRequestError"
              ) {
                const expectedCode = Cause.isFailReason(prior) ? prior.error.code : "uncertain";
                expect(reason.error.detail).toBe(
                  {
                    denied:
                      "Pi authorization was denied. Review the current assignment and permissions.",
                    conflict:
                      "Pi operation conflicts with current state. Refresh the session before retrying.",
                    unavailable:
                      "Pi operation is unavailable. Review its setup and runtime availability.",
                    uncertain:
                      "Pi operation could not be confirmed. Reconcile the owned session before retrying.",
                  }[expectedCode],
                );
              }
            }
            for (const [key, value] of originalAnnotations[index]!)
              expect(reason!.annotations.get(key)).toBe(value);
            expect(reason!.annotations.has("cleanupStep")).toBe(
              prior.annotations.has("cleanupStep"),
            );
            expect(reason!.annotations.has("correlation")).toBe(
              prior.annotations.has("correlation"),
            );
          }
        }
        expect(json(completed)).not.toContain("private-cleanup");
        expect(cleanupReasons.map((reason) => [...reason.annotations])).toEqual(
          originalAnnotations,
        );
        const interrupted = mode === "interrupt-pair" || mode === "mixed-interrupts";
        expect(fake.state.stopCalls).toBe(interrupted ? 2 : 1);
        if (interrupted) expect(yield* adapter.hasSession(threadId)).toBe(false);
        else
          expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
        expect(fake.requests).toHaveLength(kind === "initialize" ? 1 : 2);
      }),
    );

for (const method of ["stopSession", "stopAll"] as const)
  for (const mode of stopReasonModes)
    it.effect(`stop cause repair ${method} joins and retains every ${mode} reason`, () =>
      Effect.gen(function* () {
        const fake = yield* makeFake();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const reasons = stopReasons(mode);
        let calls = 0;
        const stopping = Effect.gen(function* () {
          calls++;
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return yield* Effect.failCause(Cause.fromReasons(reasons));
        });
        const runtime: PiManagedRuntimeInstance = {
          ...fake.runtime,
          requestStop: method === "stopSession" ? () => stopping : fake.runtime.requestStop,
          stopAll: method === "stopAll" ? stopping : fake.runtime.stopAll,
        };
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() =>
          Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)),
        );
        const adapter = yield* makePiAdapter({ instanceId, runtime }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const queue = yield* subscribe(adapter.streamEvents);
        yield* adapter.startSession(startInput);
        yield* nextType(queue, "session.started");
        const stop = method === "stopSession" ? adapter.stopSession(threadId) : adapter.stopAll();
        const first = yield* Effect.forkScoped(Effect.exit(stop));
        yield* Deferred.await(entered);
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const second = yield* Effect.forkScoped(Effect.exit(stop), { startImmediately: true });
        expect(first.pollUnsafe()).toBeUndefined();
        expect(second.pollUnsafe()).toBeUndefined();
        expect(calls).toBe(1);
        expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
        expect(fake.requests).toHaveLength(1);
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(first);
        expectSafeStop(result, reasons, method);
        expectSafeStop(yield* Fiber.join(second), reasons, method);
        expectSafeStop(yield* Effect.exit(stop), reasons, method);
        expect(calls).toBe(1);
        expect(json(yield* adapter.listSessions())).not.toContain("private-stop");
        if (mode !== "interrupt-pair") {
          expect((yield* adapter.listSessions())[0]?.status).toBe("error");
          if (method === "stopSession") {
            const event = yield* nextType(queue, "session.state.changed");
            expect(event.payload).toMatchObject({ state: "error" });
            expect(json(event)).not.toContain("private-stop");
          }
        }
        expect(fake.requests).toHaveLength(1);
      }),
    );

for (const method of ["stopSession", "stopAll"] as const)
  it.effect(`stop cause repair ${method} sanitizes a synchronous port throw once`, () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      let calls = 0;
      const runtime: PiManagedRuntimeInstance = {
        ...fake.runtime,
        requestStop: () => {
          calls++;
          throw new Error("private-stop-synchronous");
        },
        get stopAll() {
          if (method !== "stopAll") return fake.runtime.stopAll;
          calls++;
          throw new Error("private-stop-synchronous");
        },
      };
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() =>
        Scope.close(scope, Exit.void).pipe(Effect.catchCause(() => Effect.void)),
      );
      const adapter = yield* makePiAdapter({ instanceId, runtime }).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      yield* adapter.startSession(startInput);
      const stop = method === "stopSession" ? adapter.stopSession(threadId) : adapter.stopAll();
      for (let index = 0; index < 2; index++) {
        const result = yield* Effect.exit(stop);
        expect(json(result)).not.toContain("private-stop");
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(result.cause.reasons).toMatchObject([
            { _tag: "Fail", error: { _tag: "ProviderAdapterRequestError", method } },
          ]);
      }
      expect(calls).toBe(1);
      expect((yield* adapter.listSessions())[0]?.status).toBe("error");
    }),
  );

for (const kind of ["initialize", "prompt"] as const)
  for (const mode of ["success", "typed-pair", "two-defects", "mixed-interrupts"] as const)
    it.effect(
      `stop cause repair actual ${kind} caller interruption joins held ${mode} cleanup safely`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFake();
          const entered = yield* Deferred.make<void>();
          const secondEntered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const reasons = mode === "success" ? [] : stopReasons(mode);
          let bodies = 0;
          let joins = 0;
          let active:
            | {
                prepared: Deferred.Deferred<PiManagedPreparedOperation, ProviderAdapterError>;
                result: Deferred.Deferred<ProviderSession, ProviderAdapterError>;
                done: Deferred.Deferred<void>;
              }
            | undefined;
          const nativeTracer = yield* Effect.tracer;
          // Observe actual Adapter deferred references; no scheduling or state replacement.
          const tracer: Tracer.Tracer = {
            span: (options) => nativeTracer.span(options),
            context(primitive, fiber) {
              if ("_tag" in primitive && primitive._tag === "Success" && "value" in primitive) {
                const value = primitive.value;
                if (
                  typeof value === "object" &&
                  value !== null &&
                  "acceptingEvents" in value &&
                  "prepared" in value &&
                  Deferred.isDeferred<PiManagedPreparedOperation, ProviderAdapterError>(
                    value.prepared,
                  ) &&
                  "result" in value &&
                  Deferred.isDeferred<ProviderSession, ProviderAdapterError>(value.result) &&
                  "done" in value &&
                  Deferred.isDeferred<void, never>(value.done)
                )
                  active = { prepared: value.prepared, result: value.result, done: value.done };
              }
              return primitive["~effect/Effect/evaluate"](fiber);
            },
          };
          const joined = yield* Effect.cached(
            Effect.gen(function* () {
              bodies++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (mode !== "success") return yield* Effect.failCause(Cause.fromReasons(reasons));
            }),
          );
          const runtime: PiManagedRuntimeInstance = {
            ...fake.runtime,
            prepareOperation: Effect.fn("PiAdapter.test.stopCauseContradiction")(
              function* (request, observe) {
                const prepared = yield* fake.runtime.prepareOperation(request, observe);
                return request.kind === kind
                  ? {
                      ...prepared,
                      operation: { ...prepared.operation, operationId: "contradictory_stop_cause" },
                    }
                  : prepared;
              },
            ),
            requestStop: () =>
              Effect.gen(function* () {
                joins++;
                if (joins === 2) yield* Deferred.succeed(secondEntered, undefined);
                return yield* joined;
              }),
          };
          yield* Effect.gen(function* () {
            const adapter = yield* makePiAdapter({
              instanceId,
              runtime,
              resolveOperationId: () => Effect.succeed("requested_stop_cause"),
            });
            if (kind === "prompt") yield* adapter.startSession(startInput);
            const caller = yield* Effect.forkScoped(
              kind === "initialize"
                ? adapter.startSession(startInput).pipe(Effect.asVoid)
                : adapter
                    .sendTurn({ threadId, input: "held cleanup assignment" })
                    .pipe(Effect.asVoid),
            );
            yield* Deferred.await(entered);
            yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
            expect(active).toBeDefined();
            const captured = active!;
            expect(caller.pollUnsafe()).toBeUndefined();
            const interrupter = yield* Effect.forkScoped(Fiber.interruptAs(caller, 90701));
            yield* Deferred.await(secondEntered);
            expect(caller.pollUnsafe()).toBeUndefined();
            expect(interrupter.pollUnsafe()).toBeUndefined();
            expect(yield* Deferred.isDone(captured.prepared)).toBe(false);
            expect(yield* Deferred.isDone(captured.result)).toBe(false);
            expect(yield* Deferred.isDone(captured.done)).toBe(false);
            expect(yield* Deferred.isDone(fake.operations.at(-1)!.started)).toBe(false);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(interrupter);
            const callerExit = yield* Fiber.await(caller);
            expect(Exit.isFailure(callerExit)).toBe(true);
            if (Exit.isFailure(callerExit))
              expect(
                callerExit.cause.reasons
                  .filter(Cause.isInterruptReason)
                  .map((reason) => reason.fiberId),
              ).toContain(90701);
            expect(json(callerExit)).not.toContain("private-stop");
            const preparedHistory = yield* Effect.exit(Deferred.await(captured.prepared));
            expect(Exit.isFailure(preparedHistory)).toBe(true);
            if (Exit.isFailure(preparedHistory)) {
              expect(preparedHistory.cause.reasons[0]).toMatchObject({
                _tag: "Fail",
                error: { _tag: "ProviderAdapterRequestError", method: kind },
              });
              if (mode === "success") expect(preparedHistory.cause.reasons).toHaveLength(1);
              else
                expectSafeStop(
                  Exit.failCause(Cause.fromReasons(preparedHistory.cause.reasons.slice(1))),
                  reasons,
                  "stopSession",
                );
            }
            expect(json(preparedHistory)).not.toContain("private-stop");
            const resultHistory = yield* Effect.exit(Deferred.await(captured.result));
            expect(Exit.isFailure(resultHistory)).toBe(true);
            if (Exit.isFailure(resultHistory)) {
              expect(resultHistory.cause.reasons[0]).toMatchObject({
                _tag: "Fail",
                error: { _tag: "ProviderAdapterRequestError", method: kind },
              });
              if (mode === "success") expect(resultHistory.cause.reasons).toHaveLength(1);
              else
                expectSafeStop(
                  Exit.failCause(Cause.fromReasons(resultHistory.cause.reasons.slice(1))),
                  reasons,
                  "stopSession",
                );
            }
            expect(json(resultHistory)).not.toContain("private-stop");
            expect(yield* Deferred.isDone(captured.done)).toBe(true);
            expect(joins).toBe(2);
            expect(bodies).toBe(1);
            expect(yield* Deferred.isDone(fake.operations.at(-1)!.started)).toBe(false);
            expect(fake.requests).toHaveLength(kind === "initialize" ? 1 : 2);
          }).pipe(Effect.provideService(Tracer.Tracer, tracer));
        }),
    );

for (const mode of ["success", ...stopReasonModes] as const)
  for (const interrupted of ["first", "second", "both"] as const)
    it.effect(
      `shutdown waiter repair ${mode} keeps ${interrupted} caller cancellation out of shared cleanup`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFake();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const interruptSent = yield* Deferred.make<void>();
          const reasons = mode === "success" ? [] : stopReasons(mode);
          let calls = 0;
          const runtime: PiManagedRuntimeInstance = {
            ...fake.runtime,
            stopAll: Effect.gen(function* () {
              calls++;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              if (mode !== "success") return yield* Effect.failCause(Cause.fromReasons(reasons));
            }),
          };
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignoreCause));
          const adapter = yield* makePiAdapter({ instanceId, runtime }).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          yield* adapter.startSession(startInput);
          const first = yield* Effect.forkScoped(adapter.stopAll());
          yield* Deferred.await(entered);
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
          const second = yield* Effect.forkScoped(adapter.stopAll(), { startImmediately: true });
          const unaffected = yield* Effect.forkScoped(Effect.exit(adapter.stopAll()), {
            startImmediately: true,
          });
          const firstIds = [506801, 506802];
          const secondIds = [506901, 506902];
          const sent = yield* Effect.forkScoped(
            Effect.sync(() => {
              if (interrupted !== "second")
                for (const id of firstIds)
                  first.interruptUnsafe(id, Context.makeUnsafe(new Map([["caller", "first"]])));
              if (interrupted !== "first")
                for (const id of secondIds)
                  second.interruptUnsafe(id, Context.makeUnsafe(new Map([["caller", "second"]])));
            }).pipe(Effect.andThen(Deferred.succeed(interruptSent, undefined))),
            { startImmediately: true },
          );
          yield* Deferred.await(interruptSent);
          yield* Fiber.join(sent);
          expect(first.pollUnsafe()).toBeUndefined();
          expect(second.pollUnsafe()).toBeUndefined();
          expect(unaffected.pollUnsafe()).toBeUndefined();
          expect(calls).toBe(1);
          expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
          expect(
            Exit.isFailure(
              yield* Effect.exit(adapter.sendTurn({ threadId, input: "no shutdown successor" })),
            ),
          ).toBe(true);
          expect(fake.requests).toHaveLength(1);
          yield* Deferred.succeed(release, undefined);
          const firstExit = yield* Fiber.await(first);
          if (interrupted !== "second") {
            expect(Exit.isFailure(firstExit)).toBe(true);
            if (Exit.isFailure(firstExit)) {
              expect(
                firstExit.cause.reasons
                  .slice(0, firstIds.length)
                  .map((reason) => (Cause.isInterruptReason(reason) ? reason.fiberId : undefined)),
              ).toEqual(firstIds);
              for (const reason of firstExit.cause.reasons.slice(0, firstIds.length))
                expect(reason.annotations.get("caller")).toBe("first");
              if (mode === "success") expect(firstExit.cause.reasons).toHaveLength(firstIds.length);
              else
                expectSafeStop(
                  Exit.failCause(Cause.fromReasons(firstExit.cause.reasons.slice(firstIds.length))),
                  reasons,
                  "stopAll",
                );
            }
          } else if (mode === "success") expect(Exit.isSuccess(firstExit)).toBe(true);
          else expectSafeStop(firstExit, reasons, "stopAll");
          expect(json(firstExit)).not.toContain("private-stop");
          const secondExit = yield* Fiber.await(second);
          if (interrupted !== "first") {
            expect(Exit.isFailure(secondExit)).toBe(true);
            if (Exit.isFailure(secondExit)) {
              expect(
                secondExit.cause.reasons
                  .slice(0, secondIds.length)
                  .map((reason) => (Cause.isInterruptReason(reason) ? reason.fiberId : undefined)),
              ).toEqual(secondIds);
              for (const reason of secondExit.cause.reasons.slice(0, secondIds.length))
                expect(reason.annotations.get("caller")).toBe("second");
              if (mode === "success")
                expect(secondExit.cause.reasons).toHaveLength(secondIds.length);
              else
                expectSafeStop(
                  Exit.failCause(
                    Cause.fromReasons(secondExit.cause.reasons.slice(secondIds.length)),
                  ),
                  reasons,
                  "stopAll",
                );
            }
          } else if (mode === "success") expect(Exit.isSuccess(secondExit)).toBe(true);
          else expectSafeStop(secondExit, reasons, "stopAll");
          expect(json(secondExit)).not.toContain("private-stop");
          const shared = yield* Fiber.join(unaffected);
          const repeated = yield* Effect.exit(adapter.stopAll());
          if (mode === "success") {
            expect(Exit.isSuccess(shared)).toBe(true);
            expect(Exit.isSuccess(repeated)).toBe(true);
          } else {
            expectSafeStop(shared, reasons, "stopAll");
            expectSafeStop(repeated, reasons, "stopAll");
          }
          expect(calls).toBe(1);
          expect(fake.requests).toHaveLength(1);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(true);
        }),
    );

for (const path of ["initialize", "prompt", "stopSession"] as const)
  for (const mode of ["success", ...stopReasonModes] as const)
    for (const cancel of [false, true])
      it.effect(
        `closed scope repair ${path} joins global ${mode} with caller cancel ${cancel}`,
        () =>
          Effect.gen(function* () {
            const fake = yield* makeFake();
            fake.state.autoInitialize = path !== "initialize";
            const prepareRelease = yield* Deferred.make<void>();
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const interruptSent = yield* Deferred.make<void>();
            const stopChildExit = yield* Deferred.make<void>();
            const callerYielded = yield* Deferred.make<void>();
            const reasons = mode === "success" ? [] : stopReasons(mode);
            let allCalls = 0;
            let observeCaller = false;
            let caller: Fiber.Fiber<void, ProviderAdapterError> | undefined;
            let history:
              | {
                  done: Deferred.Deferred<void>;
                  result: Deferred.Deferred<ProviderSession, ProviderAdapterError>;
                  prepared: Deferred.Deferred<PiManagedPreparedOperation, ProviderAdapterError>;
                }
              | undefined;
            const original = yield* Effect.tracer;
            const tracer: Tracer.Tracer = {
              span: (options) => original.span(options),
              context(primitive, fiber) {
                if ("_tag" in primitive && primitive._tag === "Success" && "value" in primitive) {
                  const value = primitive.value;
                  if (
                    typeof value === "object" &&
                    value !== null &&
                    "acceptingEvents" in value &&
                    "done" in value &&
                    "result" in value &&
                    "prepared" in value &&
                    Deferred.isDeferred<void, never>(value.done) &&
                    Deferred.isDeferred<ProviderSession, ProviderAdapterError>(value.result) &&
                    Deferred.isDeferred<PiManagedPreparedOperation, ProviderAdapterError>(
                      value.prepared,
                    )
                  )
                    history = { done: value.done, result: value.result, prepared: value.prepared };
                  if (observeCaller && caller?.id === fiber.id && Fiber.isFiber(value))
                    value.addObserver(() => Deferred.doneUnsafe(stopChildExit, Effect.void));
                }
                const next = primitive["~effect/Effect/evaluate"](fiber);
                if (
                  observeCaller &&
                  caller?.id === fiber.id &&
                  "_yielded" in fiber &&
                  fiber._yielded !== undefined
                )
                  Deferred.doneUnsafe(callerYielded, Effect.void);
                return next;
              },
            };
            yield* Effect.gen(function* () {
              const scope = yield* Scope.make();
              yield* Effect.addFinalizer(() =>
                Scope.close(scope, Exit.void).pipe(Effect.ignoreCause),
              );
              const runtime: PiManagedRuntimeInstance = {
                ...fake.runtime,
                stopAll: Effect.gen(function* () {
                  allCalls++;
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                  if (mode !== "success")
                    return yield* Effect.failCause(Cause.fromReasons(reasons));
                  if (path === "initialize") yield* fake.settle(fake.operations[0]!, "canceled");
                  if (path === "prompt") yield* Deferred.succeed(prepareRelease, undefined);
                  if (path !== "stopSession") {
                    expect(history).toBeDefined();
                    if (history) yield* Deferred.await(history.done).pipe(Effect.ignoreCause);
                  }
                }),
              };
              const adapter = yield* makePiAdapter({ instanceId, runtime }).pipe(
                Effect.provideService(Scope.Scope, scope),
              );
              if (path !== "initialize") yield* adapter.startSession(startInput);
              if (path === "prompt") fake.state.prepareGate = prepareRelease;
              if (path !== "stopSession") {
                caller = yield* Effect.forkDetach(
                  path === "initialize"
                    ? adapter.startSession(startInput).pipe(Effect.asVoid)
                    : adapter.sendTurn({ threadId, input: "held preparation" }).pipe(Effect.asVoid),
                );
                yield* Queue.take(fake.requestsQueue);
                if (path === "prompt") yield* Queue.take(fake.requestsQueue);
                if (path === "initialize")
                  yield* Deferred.await((yield* Queue.take(fake.preparedQueue)).started);
              }
              const stopping = yield* Effect.forkScoped(Effect.exit(adapter.stopAll()));
              yield* Deferred.await(entered);
              yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
              observeCaller = true;
              if (path === "stopSession")
                caller = yield* Effect.forkDetach(adapter.stopSession(threadId), {
                  startImmediately: true,
                });
              const capturedCaller = caller!;
              if (cancel) {
                const sent = yield* Effect.forkScoped(
                  Effect.sync(() => {
                    for (const id of [608101, 608102])
                      capturedCaller.interruptUnsafe(
                        id,
                        Context.makeUnsafe(new Map([["caller", path]])),
                      );
                  }).pipe(Effect.andThen(Deferred.succeed(interruptSent, undefined))),
                  { startImmediately: true },
                );
                yield* Deferred.await(interruptSent);
                yield* Fiber.join(sent);
              }
              expect(stopping.pollUnsafe()).toBeUndefined();
              expect(capturedCaller.pollUnsafe()).toBeUndefined();
              expect(Exit.isFailure(yield* Effect.exit(adapter.startSession(startInput)))).toBe(
                true,
              );
              yield* Deferred.succeed(release, undefined);
              const stopped = yield* Fiber.join(stopping);
              if (mode === "success") expect(Exit.isSuccess(stopped)).toBe(true);
              else expectSafeStop(stopped, reasons, "stopAll");
              const resolution = yield* Effect.raceFirst(
                Fiber.await(capturedCaller).pipe(
                  Effect.map((exit) => ({ kind: "complete" as const, exit })),
                ),
                Deferred.await(stopChildExit).pipe(
                  Effect.andThen(Deferred.await(callerYielded)),
                  Effect.as({ kind: "orphaned-stop" as const }),
                ),
              );
              expect(resolution.kind).toBe("complete");
              if (resolution.kind !== "complete") return;
              const exit = resolution.exit;
              if (cancel) {
                expect(Exit.isFailure(exit)).toBe(true);
                if (Exit.isFailure(exit)) {
                  expect(
                    exit.cause.reasons
                      .slice(0, 2)
                      .map((reason) =>
                        Cause.isInterruptReason(reason) ? reason.fiberId : undefined,
                      ),
                  ).toEqual([608101, 608102]);
                  for (const reason of exit.cause.reasons.slice(0, 2))
                    expect(reason.annotations.get("caller")).toBe(path);
                  if (mode === "success") expect(exit.cause.reasons).toHaveLength(2);
                  else
                    expectSafeStop(
                      Exit.failCause(Cause.fromReasons(exit.cause.reasons.slice(2))),
                      reasons,
                      "stopAll",
                    );
                }
              } else if (mode !== "success") {
                expect(Exit.isFailure(exit)).toBe(true);
                if (Exit.isFailure(exit)) {
                  const prefix = path === "stopSession" ? 0 : 1;
                  if (prefix) expect(Cause.isInterruptReason(exit.cause.reasons[0]!)).toBe(true);
                  expectSafeStop(
                    Exit.failCause(Cause.fromReasons(exit.cause.reasons.slice(prefix))),
                    reasons,
                    "stopAll",
                  );
                }
              } else
                expect(path === "stopSession" ? Exit.isSuccess(exit) : Exit.isFailure(exit)).toBe(
                  true,
                );
              expect(json(exit)).not.toContain("private-stop");
              expect(fake.state.stopCalls).toBe(0);
              expect(allCalls).toBe(1);
              expect(fake.requests).toHaveLength(path === "prompt" ? 2 : 1);
              expect(yield* adapter.hasSession(threadId)).toBe(false);
              if (mode !== "success") {
                const repeated = yield* Effect.raceFirst(
                  Effect.exit(adapter.stopSession(threadId)).pipe(
                    Effect.map((exit) => ({ kind: "complete" as const, exit })),
                  ),
                  Deferred.await(stopChildExit).pipe(Effect.as({ kind: "orphaned-stop" as const })),
                );
                expect(repeated.kind).toBe("complete");
                if (repeated.kind === "complete") expectSafeStop(repeated.exit, reasons, "stopAll");
              }
            }).pipe(Effect.provideService(Tracer.Tracer, tracer));
          }),
      );

for (const mode of ["success", ...stopReasonModes] as const)
  for (const cancel of [false, true])
    it.effect(
      `closed scope repair joins an existing stop child ${mode} with caller cancel ${cancel}`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFake();
          const stopEntered = yield* Deferred.make<void>();
          const stopRelease = yield* Deferred.make<void>();
          const stopDone = yield* Deferred.make<void>();
          const allEntered = yield* Deferred.make<void>();
          const allRelease = yield* Deferred.make<void>();
          const interruptSent = yield* Deferred.make<void>();
          const reasons = mode === "success" ? [] : stopReasons(mode);
          let stopCalls = 0;
          let allCalls = 0;
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignoreCause));
          const adapter = yield* makePiAdapter({
            instanceId,
            runtime: {
              ...fake.runtime,
              requestStop: () =>
                Effect.gen(function* () {
                  stopCalls++;
                  yield* Deferred.succeed(stopEntered, undefined);
                  yield* Deferred.await(stopRelease);
                }).pipe(Effect.onExit(() => Deferred.succeed(stopDone, undefined))),
              stopAll: Effect.gen(function* () {
                allCalls++;
                yield* Deferred.succeed(allEntered, undefined);
                yield* Deferred.await(allRelease);
                if (mode !== "success") return yield* Effect.failCause(Cause.fromReasons(reasons));
                yield* Deferred.succeed(stopRelease, undefined);
                yield* Deferred.await(stopDone);
              }),
            },
          }).pipe(Effect.provideService(Scope.Scope, scope));
          yield* adapter.startSession(startInput);
          const caller = yield* Effect.forkScoped(adapter.stopSession(threadId));
          yield* Deferred.await(stopEntered);
          const stopping = yield* Effect.forkScoped(Effect.exit(adapter.stopAll()));
          yield* Deferred.await(allEntered);
          yield* Effect.addFinalizer(() => Deferred.succeed(allRelease, undefined));
          if (cancel) {
            const sent = yield* Effect.forkScoped(
              Effect.sync(() => {
                for (const id of [609101, 609102])
                  caller.interruptUnsafe(
                    id,
                    Context.makeUnsafe(new Map([["caller", "existing-stop"]])),
                  );
              }).pipe(Effect.andThen(Deferred.succeed(interruptSent, undefined))),
              { startImmediately: true },
            );
            yield* Deferred.await(interruptSent);
            yield* Fiber.join(sent);
          }
          expect(caller.pollUnsafe()).toBeUndefined();
          expect(stopping.pollUnsafe()).toBeUndefined();
          expect(yield* Deferred.isDone(stopDone)).toBe(false);
          yield* Deferred.succeed(allRelease, undefined);
          const stopped = yield* Fiber.join(stopping);
          yield* Deferred.await(stopDone);
          if (mode === "success") expect(Exit.isSuccess(stopped)).toBe(true);
          else expectSafeStop(stopped, reasons, "stopAll");
          const exit = yield* Fiber.await(caller);
          if (cancel) {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(
                exit.cause.reasons
                  .slice(0, 2)
                  .map((reason) => (Cause.isInterruptReason(reason) ? reason.fiberId : undefined)),
              ).toEqual([609101, 609102]);
              for (const reason of exit.cause.reasons.slice(0, 2))
                expect(reason.annotations.get("caller")).toBe("existing-stop");
              if (mode === "success") expect(exit.cause.reasons).toHaveLength(2);
              else
                expectSafeStop(
                  Exit.failCause(Cause.fromReasons(exit.cause.reasons.slice(2))),
                  reasons,
                  "stopAll",
                );
            }
          } else if (mode === "success") expect(Exit.isSuccess(exit)).toBe(true);
          else expectSafeStop(exit, reasons, "stopAll");
          expect(stopCalls).toBe(1);
          expect(allCalls).toBe(1);
          expect(fake.requests).toHaveLength(1);
          expect(yield* adapter.hasSession(threadId)).toBe(false);
        }),
    );

for (const kind of ["initialize", "prompt"] as const)
  for (const mode of ["success", "mixed-interrupts"] as const)
    it.effect(
      `closed scope repair retains published ${kind} interruptions and later actual cancellation ${mode}`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFake();
          const stopRelease = yield* Deferred.make<void>();
          const stopDone = yield* Deferred.make<void>();
          const allEntered = yield* Deferred.make<void>();
          const allRelease = yield* Deferred.make<void>();
          const interruptSent = yield* Deferred.make<void>();
          const correlation = { operation: "published-before-caller-cancel" };
          const annotations = Context.makeUnsafe(
            new Map<string, unknown>([
              ["caller", kind],
              ["correlation", correlation],
            ]),
          );
          const published = [
            Cause.makeInterruptReason(610101).annotate(annotations),
            Cause.makeInterruptReason(610101).annotate(annotations),
          ];
          const reasons = mode === "success" ? [] : stopReasons(mode);
          let stopCalls = 0;
          let allCalls = 0;
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignoreCause));
          const adapter = yield* makePiAdapter({
            instanceId,
            runtime: {
              ...fake.runtime,
              prepareOperation: (request, observe) =>
                fake.runtime
                  .prepareOperation(request, observe)
                  .pipe(
                    Effect.flatMap((prepared) =>
                      request.kind === kind
                        ? Effect.failCause(Cause.fromReasons<never>(published))
                        : Effect.succeed(prepared),
                    ),
                  ),
              requestStop: (thread) =>
                Effect.gen(function* () {
                  stopCalls++;
                  yield* Queue.offer(fake.stopped, thread);
                  yield* Deferred.await(stopRelease);
                }).pipe(Effect.onExit(() => Deferred.succeed(stopDone, undefined))),
              stopAll: Effect.gen(function* () {
                allCalls++;
                yield* Deferred.succeed(allEntered, undefined);
                yield* Deferred.await(allRelease);
                if (mode !== "success") return yield* Effect.failCause(Cause.fromReasons(reasons));
                yield* Deferred.succeed(stopRelease, undefined);
                yield* Deferred.await(stopDone);
              }),
            },
          }).pipe(Effect.provideService(Scope.Scope, scope));
          if (kind === "prompt") yield* adapter.startSession(startInput);
          const caller = yield* Effect.forkScoped(
            kind === "initialize"
              ? adapter.startSession(startInput).pipe(Effect.asVoid)
              : adapter.sendTurn({ threadId, input: "published interruption" }).pipe(Effect.asVoid),
          );
          // The real Runtime-published interruption reached the real Adapter waiter before cancellation.
          yield* Queue.take(fake.stopped);
          const stopping = yield* Effect.forkScoped(Effect.exit(adapter.stopAll()));
          yield* Deferred.await(allEntered);
          yield* Effect.addFinalizer(() => Deferred.succeed(allRelease, undefined));
          const sent = yield* Effect.forkScoped(
            Effect.sync(() => {
              for (const id of [610101, 610102]) caller.interruptUnsafe(id, annotations);
            }).pipe(Effect.andThen(Deferred.succeed(interruptSent, undefined))),
            { startImmediately: true },
          );
          yield* Deferred.await(interruptSent);
          yield* Fiber.join(sent);
          expect(caller.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(allRelease, undefined);
          const stopped = yield* Fiber.join(stopping);
          if (mode === "success") expect(Exit.isSuccess(stopped)).toBe(true);
          else expectSafeStop(stopped, reasons, "stopAll");
          yield* Deferred.await(stopDone);
          const exit = yield* Fiber.await(caller);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(
              exit.cause.reasons
                .slice(0, 4)
                .map((reason) => (Cause.isInterruptReason(reason) ? reason.fiberId : undefined)),
            ).toEqual([610101, 610101, 610101, 610102]);
            for (const reason of exit.cause.reasons.slice(0, 4)) {
              expect(reason.annotations.get("caller")).toBe(kind);
              expect(reason.annotations.get("correlation")).toBe(correlation);
            }
            if (mode === "success") expect(exit.cause.reasons).toHaveLength(4);
            else
              expectSafeStop(
                Exit.failCause(Cause.fromReasons(exit.cause.reasons.slice(4))),
                reasons,
                "stopAll",
              );
          }
          expect(stopCalls).toBe(1);
          expect(allCalls).toBe(1);
          expect(fake.requests).toHaveLength(kind === "initialize" ? 1 : 2);
        }),
    );

it.effect(
  "closed scope repair retains synchronous published interruption and actual caller cancellation",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      const publication = yield* Deferred.make<void>();
      const cancelRequested = yield* Deferred.make<void>();
      const interruptSent = yield* Deferred.make<void>();
      const allEntered = yield* Deferred.make<void>();
      const allRelease = yield* Deferred.make<void>();
      const correlation = { ordering: "synchronous-publication" };
      const annotations = Context.makeUnsafe(
        new Map<string, unknown>([
          ["caller", "synchronous"],
          ["correlation", correlation],
        ]),
      );
      const published = [
        Cause.makeInterruptReason(611101).annotate(annotations),
        Cause.makeInterruptReason(611101).annotate(annotations),
      ];
      const reasons = stopReasons("mixed-interrupts");
      let caller: Fiber.Fiber<void, ProviderAdapterError> | undefined;
      let armed = false;
      let signaled = false;
      let allCalls = 0;
      const original = yield* Effect.tracer;
      const tracer: Tracer.Tracer = {
        span: (options) => original.span(options),
        context(primitive, fiber) {
          if (
            armed &&
            !signaled &&
            caller?.id === fiber.id &&
            "_tag" in primitive &&
            primitive._tag === "Failure" &&
            "cause" in primitive &&
            Cause.isCause(primitive.cause) &&
            Cause.hasInterrupts(primitive.cause)
          ) {
            signaled = true;
            // Notify a separate real interrupter at the actual published failure evaluation.
            Deferred.doneUnsafe(cancelRequested, Effect.void);
          }
          return primitive["~effect/Effect/evaluate"](fiber);
        },
      };
      yield* Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.ignoreCause));
        const adapter = yield* makePiAdapter({
          instanceId,
          runtime: {
            ...fake.runtime,
            prepareOperation: (request, observe) =>
              fake.runtime
                .prepareOperation(request, observe)
                .pipe(
                  Effect.andThen(Deferred.await(publication)),
                  Effect.andThen(Effect.failCause(Cause.fromReasons<never>(published))),
                ),
            stopAll: Effect.gen(function* () {
              allCalls++;
              yield* Deferred.succeed(allEntered, undefined);
              yield* Deferred.await(allRelease);
              return yield* Effect.failCause(Cause.fromReasons(reasons));
            }),
          },
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const interrupter = yield* Effect.forkScoped(
          Deferred.await(cancelRequested).pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(caller).toBeDefined();
                if (caller)
                  for (const id of [611101, 611102]) caller.interruptUnsafe(id, annotations);
              }),
            ),
            Effect.andThen(Deferred.succeed(interruptSent, undefined)),
          ),
          { startImmediately: true },
        );
        caller = yield* Effect.forkDetach(adapter.startSession(startInput).pipe(Effect.asVoid));
        yield* Queue.take(fake.requestsQueue);
        const stopping = yield* Effect.forkScoped(Effect.exit(adapter.stopAll()));
        yield* Deferred.await(allEntered);
        yield* Effect.addFinalizer(() => Deferred.succeed(allRelease, undefined));
        armed = true;
        yield* Deferred.succeed(publication, undefined);
        yield* Deferred.await(interruptSent);
        yield* Fiber.join(interrupter);
        expect(signaled).toBe(true);
        expect(caller.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(allRelease, undefined);
        expectSafeStop(yield* Fiber.join(stopping), reasons, "stopAll");
        const exit = yield* Fiber.await(caller);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(
            exit.cause.reasons
              .slice(0, 4)
              .map((reason) => (Cause.isInterruptReason(reason) ? reason.fiberId : undefined)),
          ).toEqual([611101, 611101, 611101, 611102]);
          for (const reason of exit.cause.reasons.slice(0, 4)) {
            expect(reason.annotations.get("caller")).toBe("synchronous");
            expect(reason.annotations.get("correlation")).toBe(correlation);
          }
          expectSafeStop(
            Exit.failCause(Cause.fromReasons(exit.cause.reasons.slice(4))),
            reasons,
            "stopAll",
          );
        }
        expect(allCalls).toBe(1);
        expect(fake.state.stopCalls).toBe(0);
        expect(fake.requests).toHaveLength(1);
      }).pipe(Effect.provideService(Tracer.Tracer, tracer));
    }),
);

it.effect(
  "readonly reviewer synthetic managed initialize hands off a ready session and prompt offline",
  () =>
    Effect.gen(function* () {
      const fake = yield* makeFake();
      fake.state.autoInitialize = false;
      fake.state.session = { ...initialSession(), runtimeMode: "approval-required" };
      const adapter = yield* makePiAdapter({
        instanceId,
        runtime: fake.runtime,
        resolveOperationId: (request) => Effect.succeed(`reviewer-${request.kind}`),
      });
      const events = yield* subscribe(adapter.streamEvents);
      const plan = readyPlan();
      const starting = yield* Effect.forkScoped(
        adapter.startSession({
          threadId,
          cwd: fake.state.session.cwd,
          modelSelection: { instanceId, model: "frozen-model" },
          resumeCursor: fake.state.session.resumeCursor,
          runtimeMode: "approval-required",
          skillPlan: plan,
        }),
      );
      const initialize = yield* Queue.take(fake.preparedQueue);
      yield* Deferred.await(initialize.started);
      yield* fake.settle(initialize, "success");
      const session = yield* Fiber.join(starting);
      expect(session.status).toBe("ready");
      expect(session.runtimeMode).toBe("approval-required");
      expect((yield* Queue.take(events)).type).toBe("session.started");
      const sent = yield* adapter.sendTurn({
        threadId,
        input: "Review the implementation without edits.",
      });
      expect(sent.threadId).toBe(threadId);
      expect(fake.requests.map((request) => [request.kind, request.operationId])).toEqual([
        ["initialize", "reviewer-initialize"],
        ["prompt", "reviewer-prompt"],
      ]);
      expect(fake.requests[1]?.skillPlan).toEqual(plan);
      yield* fake.settle(fake.operations[1]!, "success");
    }),
);
