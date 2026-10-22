import { expect, it } from "@effect/vitest";
import {
  AssistantId,
  ScheduledTaskId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AssistantConfigurationRevision,
  CommandId,
  EnvironmentId,
  MemoryGrantId,
  ProjectId,
  ProviderInstanceId,
  MessageId,
  type AssistantConfiguration,
  ThreadId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  type AssistantDetail,
  type AssistantListInput,
  type AssistantListResult,
  type AssistantActivityListInput,
  type AssistantMemoryWriteInput,
  type AssistantSummary,
  type AssistantThreadOwner,
  type AuthSessionState,
  type MemoryGrant,
  type ProjectMemorySourceRead,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentCommand } from "./runtime.ts";
import { interruptThreadTurn } from "../operations/commands.ts";
import {
  assistantActivityState,
  assistantThreadOwnerState,
  assistantMemoryRecipient,
  assistantHomeTarget,
  assistantMemorySourceKey,
  assistantMemorySourceSelector,
  assistantMemoryStatus,
  assistantScopeKey,
  captureAssistantConfigurationDraft,
  captureAssistantSelection,
  createAssistantsEnvironmentAtoms,
  normalizeAssistantList,
  normalizeAssistantRoutineRead,
  prepareAssistantRoutineMutation,
  type AssistantRoutineMutationIntent,
  type AssistantThreadOwnerSnapshot,
  normalizeAssistantMemoryRead,
  prepareAssistantConfigurationMutation,
  prepareAssistantLifecycleMutation,
  prepareAssistantMemoryMutation,
  prepareAssistantStop,
} from "./assistants.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);
const environmentId = EnvironmentId.make("first");
const otherEnvironment = EnvironmentId.make("second");
const assistantId = AssistantId.make("assistant");
const commandId = CommandId.make("command");
const summary: AssistantSummary = {
  environmentId,
  assistantId,
  name: "Assistant",
  configurationRevision: AssistantConfigurationRevision.make(4),
  lifecycle: "active",
  provisioningState: "ready",
  binding: {
    environmentId,
    assistantId,
    backingProjectId: ProjectId.make("project"),
    canonicalThreadId: ThreadId.make("home"),
  },
  attention: {
    queuedRuns: 0,
    activeRuns: 0,
    waitingRuns: 0,
    uncertainRuns: 0,
    pendingMemoryJobs: 0,
    memoryStatus: "ready",
    reason: null,
  },
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};
const selection = captureAssistantSelection(summary, "session-1");
const source: ProjectMemorySourceRead = {
  kind: "memory-source",
  recordId: "source-record",
  owner: { kind: "assistant", assistantId },
  ownerRevision: 0,
  revision: 2,
  generation: 3,
  updatedAt: summary.updatedAt,
  status: "current",
  sourceKind: "result",
  sourceId: "source",
  sourceRevision: 2,
  content: "Reviewed preference",
  contentHash: "a".repeat(64),
  contentRevision: 2,
  conversationSpans: [],
  attribution: {
    actor: { kind: "human" },
    source: { kind: "manual" },
    recordedAt: summary.updatedAt,
  },
};

it("keeps coincident identities and canonical routes qualified by environment", () => {
  expect(assistantScopeKey(selection)).not.toBe(
    assistantScopeKey({ ...selection, environmentId: otherEnvironment }),
  );
  expect(assistantHomeTarget(selection)).toEqual({
    environmentId,
    projectId: summary.binding.backingProjectId,
    threadId: summary.binding.canonicalThreadId,
  });
  expect(
    normalizeAssistantList({
      environmentId,
      includeArchived: true,
      limit: Infinity,
    }),
  ).toEqual({ environmentId, includeArchived: true, limit: 100 });
  expect(
    normalizeAssistantList({
      environmentId,
      includeArchived: false,
      cursor: "page-2",
      limit: -1,
    }),
  ).toMatchObject({ cursor: "page-2", limit: 1 });
  expect(
    normalizeAssistantMemoryRead({
      environmentId,
      assistantId,
      operation: "list",
      limit: 300,
    }),
  ).toMatchObject({ limit: 32 });
});

it("retains reviewed configuration and refuses revision, selection, binding or connection changes", () => {
  const configuration = {
    name: "Assistant",
    rules: "reviewed",
    prompt: "",
    personality: "",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    resources: { mcpTools: [], skills: [], instructions: [] },
    memory: {
      automaticCapture: true,
      allowRoutineCreation: false,
      extractionFallback: null,
      externalIndexing: null,
    },
  } satisfies AssistantConfiguration;
  const detail: AssistantDetail = {
    summary,
    configuration: {
      environmentId,
      assistantId,
      revision: summary.configurationRevision,
      configuration,
      createdAt: summary.createdAt,
    },
    provisioning: { state: "ready", binding: summary.binding },
  };
  const draft = captureAssistantConfigurationDraft(detail, "session-1");
  configuration.rules = "changed behind the form";
  expect(draft.configuration.rules).toBe("reviewed");
  expect(
    prepareAssistantConfigurationMutation({
      draft,
      current: selection,
      commandId,
    }),
  ).toMatchObject({
    expectedRevision: 4,
    configuration: { rules: "reviewed" },
  });
  for (const current of [
    { ...selection, environmentId: otherEnvironment },
    { ...selection, assistantId: AssistantId.make("other") },
    { ...selection, canonicalThreadId: ThreadId.make("other") },
    { ...selection, backingProjectId: ProjectId.make("other") },
    {
      ...selection,
      configurationRevision: AssistantConfigurationRevision.make(5),
    },
    { ...selection, connectionEpoch: "session-2" },
  ]) {
    expect(prepareAssistantConfigurationMutation({ draft, current, commandId })).toBeNull();
    expect(
      prepareAssistantLifecycleMutation({
        selected: selection,
        current,
        commandId,
        action: "archive",
      }),
    ).toBeNull();
    expect(prepareAssistantStop({ selected: selection, current, commandId })).toBeNull();
  }
  expect(draft.configuration.rules).toBe("reviewed");
});

it("restores the retained owner through lifecycle CAS and stops only the canonical home", () => {
  for (const action of ["archive", "restore", "disable", "enable"] as const) {
    expect(
      prepareAssistantLifecycleMutation({
        selected: selection,
        current: selection,
        commandId,
        action,
      }),
    ).toEqual({
      environmentId,
      assistantId,
      expectedRevision: 4,
      commandId,
      action,
    });
  }
  expect(
    prepareAssistantStop({
      selected: selection,
      current: selection,
      commandId,
    }),
  ).toEqual({
    environmentId,
    input: {
      type: "thread.stop",
      threadId: summary.binding.canonicalThreadId,
      commandId,
    },
  });
});

it("fences edits by the full source tuple and refuses unknown or revoked sharing authority", () => {
  const intent: AssistantMemoryWriteInput = {
    environmentId,
    assistantId,
    operation: "forget",
    source: assistantMemorySourceSelector(source),
  };
  const base = {
    selected: selection,
    current: selection,
    intent,
    currentSource: source,
  };
  expect(prepareAssistantMemoryMutation(base)).toBe(intent);
  for (const currentSource of [
    { ...source, sourceRevision: 3 },
    { ...source, generation: 4 },
    { ...source, contentHash: "b".repeat(64) },
    { ...source, status: "retracted" },
    { ...source, status: "future-status" },
    {
      ...source,
      owner: {
        kind: "assistant" as const,
        assistantId: AssistantId.make("other"),
      },
    },
  ])
    expect(prepareAssistantMemoryMutation({ ...base, currentSource })).toBeNull();
  expect(assistantMemorySourceKey(selection, intent.source)).not.toBe(
    assistantMemorySourceKey({ ...selection, environmentId: otherEnvironment }, intent.source),
  );
  const recipient = {
    environmentId,
    owner: { kind: "project" as const, projectId: ProjectId.make("recipient") },
    revision: 8,
  };
  const grantIntent = {
    ...intent,
    operation: "grant" as const,
    recipient: recipient.owner,
    recipientRevision: 8,
  };
  expect(prepareAssistantMemoryMutation({ ...base, intent: grantIntent })).toBeNull();
  expect(prepareAssistantMemoryMutation({ ...base, intent: grantIntent, recipient })).toBe(
    grantIntent,
  );
  expect(
    prepareAssistantMemoryMutation({
      ...base,
      intent: grantIntent,
      recipient: { ...recipient, revision: 9 },
    }),
  ).toBeNull();
  const grant: MemoryGrant = {
    id: MemoryGrantId.make("grant"),
    environmentId,
    source: {
      owner: source.owner,
      sourceId: source.sourceId,
      sourceRevision: source.sourceRevision,
    },
    recipient: recipient.owner,
    ownerRevision: 0,
    recipientRevision: 8,
    createdAt: summary.createdAt,
    revokedAt: null,
  };
  const revoke = {
    ...grantIntent,
    operation: "revoke" as const,
    grantId: grant.id,
  };
  expect(
    prepareAssistantMemoryMutation({
      ...base,
      intent: revoke,
      recipient,
      currentGrant: grant,
    }),
  ).toBe(revoke);
  for (const currentGrant of [
    { ...grant, environmentId: otherEnvironment },
    { ...grant, ownerRevision: 1 },
    { ...grant, revokedAt: summary.updatedAt },
    { ...grant, recipientRevision: 9 },
  ]) {
    expect(
      prepareAssistantMemoryMutation({
        ...base,
        intent: revoke,
        recipient,
        currentGrant,
      }),
    ).toBeNull();
  }
});

it("keeps memory route CAS, cleanup and unknown lineage confirmation explicit", () => {
  const intent: AssistantMemoryWriteInput = {
    environmentId,
    assistantId,
    operation: "configure",
    expectedRevision: 7,
    configuration: {},
  };
  const base = {
    selected: selection,
    current: selection,
    intent,
    configurationRevision: 7,
  };
  expect(prepareAssistantMemoryMutation(base)).toBe(intent);
  expect(prepareAssistantMemoryMutation({ ...base, configurationRevision: 8 })).toBeNull();
  expect(
    assistantMemoryStatus({
      operation: "status",
      jobs: [{ status: "pending", count: 2 }],
      unresolvedForgottenSources: 1,
      requiresUserConfirmation: true,
    }),
  ).toEqual({
    jobs: [{ status: "pending", count: 2 }],
    pendingCleanup: 1,
    requiresUserConfirmation: true,
  });
});

it("keeps server offline separate from last known attention and dispatch outcome", () => {
  const lastRun = {
    phase: "dispatch" as const,
    assistantId,
    configurationRevision: summary.configurationRevision,
    commandId,
    messageId: MessageId.make("message"),
    scheduledTaskId: null,
    updatedAt: summary.updatedAt,
    runId: null,
    runAttemptId: null,
    status: "dispatched",
  };
  const dispatched = assistantActivityState({
    connected: false,
    summary,
    lastRun,
  });
  expect(dispatched.activity).toEqual({
    phase: "dispatch",
    status: "dispatched",
    runId: null,
    updatedAt: summary.updatedAt,
  });
  const view = assistantActivityState({ connected: false, summary });
  expect(view).toMatchObject({
    environment: "offline",
    lifecycle: "active",
    attention: summary.attention,
    activity: null,
  });
});

const makeHarness = Effect.fnUntraced(function* () {
  const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "First",
      httpBaseUrl: "https://first.test",
      wsBaseUrl: "wss://first.test",
    }),
    session,
    state,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  // Registry routing is the fixture boundary; supervisors otherwise use real query/permission code.
  const service = EnvironmentRegistry.of({
    run: (_id, program) => Effect.provideService(program, EnvironmentSupervisor, supervisor),
    followStream: (_id, program) =>
      Stream.provideService(program, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  return {
    session,
    supervisor,
    runtime: Atom.runtime(Layer.succeed(EnvironmentRegistry, service)),
  };
});

it.effect("reconnect reloads the bounded roster from a replacement session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atoms = createAssistantsEnvironmentAtoms(harness.runtime);
      const firstRead = yield* Deferred.make<void>();
      const replaced = yield* Deferred.make<void>();
      const inputs: unknown[] = [];
      const epochs: string[] = [];
      registry.subscribe(
        atoms.connection(environmentId),
        (result) => {
          if (
            AsyncResult.isSuccess(result) &&
            result.value.epoch !== null &&
            epochs.at(-1) !== result.value.epoch
          )
            epochs.push(result.value.epoch);
        },
        { immediate: true },
      );
      const makeSession = (name: string) =>
        ({
          client: {
            [WS_METHODS.assistantsList]: (input: unknown) =>
              Effect.sync(() => {
                inputs.push(input);
                return {
                  assistants: [{ ...summary, name }],
                  nextCursor: null,
                };
              }),
          },
        }) as unknown as RpcSession;
      yield* SubscriptionRef.set(harness.session, Option.some(makeSession("First")));
      registry.subscribe(
        atoms.list({
          environmentId,
          input: { environmentId, includeArchived: true, limit: 300 },
        }),
        (result) => {
          if (!AsyncResult.isSuccess(result)) return;
          if (result.value.assistants[0]?.name === "First")
            Deferred.doneUnsafe(firstRead, Exit.void);
          if (result.value.assistants[0]?.name === "Reconnected")
            Deferred.doneUnsafe(replaced, Exit.void);
        },
        { immediate: true },
      );
      yield* Deferred.await(firstRead);
      yield* SubscriptionRef.set(harness.session, Option.some(makeSession("Reconnected")));
      yield* Deferred.await(replaced);
      expect(epochs).toHaveLength(2);
      expect(epochs[0]).not.toBe(epochs[1]);
      expect(inputs).toEqual([
        { environmentId, includeArchived: true, limit: 100 },
        { environmentId, includeArchived: true, limit: 100 },
      ]);
    }),
  ),
);

it.effect(
  "all mutations expose current destination grants and deny revoked access before transport",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const atoms = createAssistantsEnvironmentAtoms(harness.runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        let writes = 0;
        let stops = 0;
        yield* SubscriptionRef.set(
          harness.session,
          Option.some({
            client: {
              [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: () =>
                Effect.sync(() => {
                  stops++;
                  return { sequence: 1 };
                }),
              [WS_METHODS.assistantsLifecycle]: () =>
                Effect.sync(() => {
                  writes++;
                  return {};
                }),
            },
          } as unknown as RpcSession),
        );
        const auth = {
          authenticated: true as const,
          auth: {
            policy: "remote-reachable" as const,
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationOperateScope],
        };
        registry.set(sessions(environmentId), AsyncResult.success(auth));
        expect(registry.get(atoms.lifecycle.permissionAtom(environmentId))).toBe(true);
        const accepted = yield* Effect.promise(() =>
          atoms.lifecycle.run(registry, {
            environmentId,
            input: {
              environmentId,
              assistantId,
              commandId,
              expectedRevision: summary.configurationRevision,
              action: "archive",
            },
          }),
        );
        expect(accepted._tag).toBe("Success");
        const stopTarget = prepareAssistantStop({
          selected: selection,
          current: selection,
          commandId,
        })!;
        const stopped = yield* Effect.promise(() => atoms.stop.run(registry, stopTarget));
        expect(stopped._tag).toBe("Success");
        registry.set(
          sessions(environmentId),
          AsyncResult.success({ ...auth, scopes: [], permissions: [] }),
        );
        for (const command of [
          atoms.create,
          atoms.updateConfiguration,
          atoms.lifecycle,
          atoms.memoryWrite,
          atoms.routineWrite,
          atoms.stop,
        ])
          expect(registry.get(command.permissionAtom(environmentId))).toBe(false);
        const result = yield* Effect.promise(() =>
          atoms.lifecycle.run(registry, {
            environmentId,
            input: {
              environmentId,
              assistantId,
              commandId,
              expectedRevision: summary.configurationRevision,
              action: "restore",
            },
          }),
        );
        expect(result._tag).toBe("Failure");
        const deniedStop = yield* Effect.promise(() => atoms.stop.run(registry, stopTarget));
        expect(deniedStop._tag).toBe("Failure");
        expect(stops).toBe(1);
        expect(writes).toBe(1);
      }),
    ),
);

it.effect("routes coincident assistant IDs to independent environments", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* makeHarness();
      const second = yield* makeHarness();
      const sessionFor = (name: string, environmentId: EnvironmentId) =>
        ({
          client: {
            [WS_METHODS.assistantsGet]: () =>
              Effect.succeed({ summary: { ...summary, environmentId, name } }),
          },
        }) as unknown as RpcSession;
      yield* SubscriptionRef.set(first.session, Option.some(sessionFor("First", environmentId)));
      yield* SubscriptionRef.set(
        second.session,
        Option.some(sessionFor("Second", otherEnvironment)),
      );
      const supervisorFor = (id: EnvironmentId) =>
        id === environmentId ? first.supervisor : second.supervisor;
      const service = EnvironmentRegistry.of({
        run: (id, program) =>
          Effect.provideService(program, EnvironmentSupervisor, supervisorFor(id)),
        followStream: (id, program) =>
          Stream.provideService(program, EnvironmentSupervisor, supervisorFor(id)),
      } as EnvironmentRegistry["Service"]);
      const atoms = createAssistantsEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, service)),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const results = new Map<EnvironmentId, string>();
      const ready = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
      for (const [index, id] of [environmentId, otherEnvironment].entries())
        registry.subscribe(
          atoms.detail({
            environmentId: id,
            input: { environmentId: id, assistantId },
          }),
          (result) => {
            if (AsyncResult.isSuccess(result)) {
              results.set(id, result.value.summary.name);
              Deferred.doneUnsafe(ready[index]!, Exit.void);
            }
          },
          { immediate: true },
        );
      yield* Effect.all(ready.map(Deferred.await));
      expect([...results.entries()]).toEqual([
        [environmentId, "First"],
        [otherEnvironment, "Second"],
      ]);
    }),
  ),
);

it.effect("a bounded roster replacement refreshes visible activity from its actual V2 read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const changes = yield* Queue.unbounded<AssistantListResult>();
      const firstActivity = yield* Deferred.make<void>();
      const nextActivity = yield* Deferred.make<void>();
      const firstRoster = yield* Deferred.make<void>();
      const restoredRoster = yield* Deferred.make<void>();
      let armed = false;
      const activityInputs: AssistantActivityListInput[] = [];
      const rosterInputs: AssistantListInput[] = [];
      yield* SubscriptionRef.set(
        harness.session,
        Option.some({
          client: {
            [WS_METHODS.assistantsActivity]: (input: AssistantActivityListInput) =>
              Effect.sync(() => {
                activityInputs.push(input);
                Deferred.doneUnsafe(armed ? nextActivity : firstActivity, Exit.void);
                return { runs: [], nextCursor: null };
              }),
            [WS_METHODS.assistantsSubscribeRoster]: (input: AssistantListInput) => {
              rosterInputs.push(input);
              return Stream.concat(
                Stream.succeed({
                  assistants: [{ ...summary, lifecycle: "archived" }],
                  nextCursor: "next-page",
                }),
                Stream.fromQueue(changes),
              );
            },
          },
        } as unknown as RpcSession),
      );
      const atoms = createAssistantsEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.mount(
        atoms.activity({ environmentId, input: { environmentId, assistantId, limit: 1000 } }),
      );
      registry.subscribe(
        atoms.roster({
          environmentId,
          input: { environmentId, includeArchived: true, limit: 1000 },
        }),
        (result) => {
          if (!AsyncResult.isSuccess(result)) return;
          const row = result.value.assistants[0];
          if (row?.lifecycle === "archived") Deferred.doneUnsafe(firstRoster, Exit.void);
          if (row?.lifecycle === "active") Deferred.doneUnsafe(restoredRoster, Exit.void);
        },
        { immediate: true },
      );
      yield* Deferred.await(firstActivity);
      yield* Deferred.await(firstRoster);
      armed = true;
      yield* Queue.offer(changes, { assistants: [summary], nextCursor: "next-page" });
      yield* Deferred.await(restoredRoster);
      yield* Deferred.await(nextActivity);
      expect(rosterInputs).toEqual([{ environmentId, includeArchived: true, limit: 100 }]);
      expect(
        activityInputs.every(
          (input) =>
            input.environmentId === environmentId &&
            input.assistantId === assistantId &&
            input.limit === 100,
        ),
      ).toBe(true);
    }),
  ),
);

it("routine actions retain reviewed schedule and owner while fire pages stay bounded", () => {
  const taskId = ScheduledTaskId.make("routine");
  const routine = {
    taskId,
    revision: 7,
    title: "Review",
    prompt: "Review changes",
    enabled: false,
    deleted: false,
    schedule: { type: "interval" as const, everyMs: 60000 },
    nextRunAt: null,
    timeZone: "America/Chicago",
    configurationRevision: summary.configurationRevision,
  };
  expect(
    normalizeAssistantRoutineRead({
      environmentId,
      assistantId,
      operation: "fires",
      taskId,
      cursor: "next",
      limit: 900,
    }),
  ).toEqual({ environmentId, assistantId, operation: "fires", taskId, cursor: "next", limit: 32 });
  const create: AssistantRoutineMutationIntent = {
    environmentId,
    assistantId,
    operation: "upsert",
    commandId,
    title: "New routine",
    prompt: routine.prompt,
    enabled: false,
    schedule: routine.schedule,
  };
  const creation = { selected: selection, current: selection, intent: create };
  expect(prepareAssistantRoutineMutation(creation)).toBe(create);
  expect(
    prepareAssistantRoutineMutation({ ...creation, intent: { ...create, expectedRevision: 7 } }),
  ).toBeNull();
  const intents: AssistantRoutineMutationIntent[] = [
    { environmentId, assistantId, taskId, operation: "set-enabled", enabled: true },
    { environmentId, assistantId, taskId, operation: "delete" },
    { environmentId, assistantId, taskId, operation: "rotate-webhook-token" },
    {
      environmentId,
      assistantId,
      taskId,
      operation: "upsert",
      commandId,
      title: "Edited title",
      prompt: routine.prompt,
      enabled: routine.enabled,
      schedule: routine.schedule,
    },
    { environmentId, assistantId, taskId, operation: "run-now", commandId },
  ];
  for (const intent of intents) {
    const base = {
      selected: selection,
      current: selection,
      intent,
      reviewedRoutine: structuredClone(routine),
      currentRoutine: routine,
    };
    expect(prepareAssistantRoutineMutation(base)).toEqual(
      intent.operation === "run-now" ? intent : { ...intent, expectedRevision: routine.revision },
    );
    expect(
      prepareAssistantRoutineMutation({ ...base, currentRoutine: { ...routine, revision: 8 } }),
    ).toBeNull();
    if (intent.operation !== "run-now")
      expect(
        prepareAssistantRoutineMutation({ ...base, intent: { ...intent, expectedRevision: 6 } }),
      ).toBeNull();
    expect(routine.revision).toBe(7);
    expect(base.reviewedRoutine.revision).toBe(7);
    expect(
      prepareAssistantRoutineMutation({
        ...base,
        current: { ...selection, connectionEpoch: "new" },
      }),
    ).toBeNull();
    expect(
      prepareAssistantRoutineMutation({ ...base, currentRoutine: { ...routine, enabled: true } }),
    ).toBeNull();
    expect(
      prepareAssistantRoutineMutation({ ...base, currentRoutine: { ...routine, deleted: true } }),
    ).toBeNull();
    expect(
      prepareAssistantRoutineMutation({
        ...base,
        currentRoutine: { ...routine, taskId: ScheduledTaskId.make("other") },
      }),
    ).toBeNull();
  }
});

it.effect("normal thread Stop checks current grants at the shared custom command boundary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      let stops = 0;
      yield* SubscriptionRef.set(
        harness.session,
        Option.some({
          initialConfig: Effect.succeed({ environment: { capabilities: { threadStop: true } } }),
          client: {
            [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: () =>
              Effect.sync(() => {
                stops++;
                return { sequence: stops };
              }),
          },
        } as unknown as RpcSession),
      );
      const command = createEnvironmentCommand(harness.runtime, {
        label: "test:normal-thread-stop",
        execute: (input: Parameters<typeof interruptThreadTurn>[0]) =>
          interruptThreadTurn(input).pipe(
            Effect.provideService(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size),
                digest: (_algorithm, bytes) => Effect.succeed(bytes),
              }),
            ),
          ),
      });
      const auth = {
        authenticated: true as const,
        auth: {
          policy: "remote-reachable" as const,
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "test",
        },
        scopes: [AuthOrchestrationOperateScope],
        permissions: [AuthOrchestrationOperateScope],
      };
      registry.set(sessions(environmentId), AsyncResult.success(auth));
      const target = {
        environmentId,
        input: { commandId, threadId: summary.binding.canonicalThreadId },
      };
      const allowed = yield* Effect.promise(() => command.run(registry, target));
      expect(allowed._tag).toBe("Success");
      registry.set(
        sessions(environmentId),
        AsyncResult.success({ ...auth, scopes: [], permissions: [] }),
      );
      const revoked = yield* Effect.promise(() => command.run(registry, target));
      expect(revoked._tag).toBe("Failure");
      expect(stops).toBe(1);
    }),
  ),
);

it("owner selection distinguishes ordinary threads from unresolved or stale authority", () => {
  const target = { environmentId, threadId: summary.binding.canonicalThreadId };
  const owner: AssistantThreadOwner = {
    ...summary.binding,
    threadId: target.threadId,
    configurationRevision: summary.configurationRevision,
    lifecycle: "active",
    provisioningState: "ready",
    isCanonicalHome: true,
  };
  const snapshot = { ...target, owner, connectionEpoch: "current" };
  const current = { target, snapshot, connectionEpoch: "current" };
  expect(assistantThreadOwnerState(current)).toMatchObject({
    kind: "canonical",
    owner,
    selected: { assistantId, connectionEpoch: "current" },
  });
  expect(assistantThreadOwnerState({ ...current, snapshot: null })).toEqual({ kind: "unknown" });
  expect(assistantThreadOwnerState({ ...current, connectionEpoch: null })).toEqual({
    kind: "offline",
  });
  expect(assistantThreadOwnerState({ ...current, connectionEpoch: "reconnected" })).toEqual({
    kind: "unknown",
  });
  expect(assistantThreadOwnerState({ ...current, snapshot: { ...snapshot, owner: null } })).toEqual(
    { kind: "ordinary" },
  );
  expect(
    assistantThreadOwnerState({
      ...current,
      target: { ...target, threadId: ThreadId.make("other") },
      snapshot: { ...snapshot, owner: null },
    }),
  ).toEqual({ kind: "unknown" });
  expect(
    assistantThreadOwnerState({
      ...current,
      target: { ...target, environmentId: otherEnvironment },
    }),
  ).toEqual({ kind: "unknown" });
  const child = ThreadId.make("child");
  expect(
    assistantThreadOwnerState({
      ...current,
      target: { ...target, threadId: child },
      snapshot: {
        ...snapshot,
        threadId: child,
        owner: { ...owner, threadId: child, isCanonicalHome: false },
      },
    }),
  ).toMatchObject({ kind: "child", selected: { canonicalThreadId: target.threadId } });
});

it.effect("exact owner reads refresh their session stamp without mounting any roster", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const atoms = createAssistantsEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const firstRead = yield* Deferred.make<void>();
      const secondRead = yield* Deferred.make<void>();
      const snapshots: AssistantThreadOwnerSnapshot[] = [];
      const exactId = AssistantId.make("assistant-beyond-first-100");
      const input = { environmentId, threadId: summary.binding.canonicalThreadId };
      const makeSession = (revision: number) =>
        ({
          client: {
            [WS_METHODS.assistantsResolveThread]: () =>
              Effect.succeed({
                ...summary.binding,
                assistantId: exactId,
                threadId: input.threadId,
                configurationRevision: AssistantConfigurationRevision.make(revision),
                lifecycle: "active",
                provisioningState: "ready",
                isCanonicalHome: true,
              }),
          },
        }) as unknown as RpcSession;
      yield* SubscriptionRef.set(harness.session, Option.some(makeSession(4)));
      const atom = atoms.owner({ environmentId, input });
      expect(
        atoms.owner({ environmentId, input: { threadId: input.threadId, environmentId } }),
      ).toBe(atom);
      registry.subscribe(
        atom,
        (result) => {
          if (!AsyncResult.isSuccess(result) || result.waiting) return;
          snapshots.push(result.value);
          Deferred.doneUnsafe(
            result.value.owner?.configurationRevision === 4 ? firstRead : secondRead,
            Exit.void,
          );
        },
        { immediate: true },
      );
      yield* Deferred.await(firstRead);
      yield* SubscriptionRef.set(harness.session, Option.some(makeSession(5)));
      yield* Deferred.await(secondRead);
      expect(snapshots.map((snapshot) => snapshot.owner?.assistantId)).toEqual([exactId, exactId]);
      expect(snapshots[0]?.connectionEpoch).not.toBe(snapshots[1]?.connectionEpoch);
      expect(
        assistantThreadOwnerState({
          target: input,
          snapshot: snapshots[0]!,
          connectionEpoch: snapshots[1]!.connectionEpoch,
        }),
      ).toEqual({ kind: "unknown" });
    }),
  ),
);

it("memory recipient and confirmation helpers use authoritative owner metadata and exact source tuples", () => {
  const recipientOwner = { kind: "project" as const, projectId: ProjectId.make("empty-project") };
  const recipient = assistantMemoryRecipient({
    operation: "recipient",
    environmentId,
    owner: recipientOwner,
    ownerRevision: 0,
    title: "Empty project",
  });
  expect(recipient).toEqual({ environmentId, owner: recipientOwner, revision: 0 });
  expect(
    normalizeAssistantMemoryRead({
      environmentId,
      assistantId,
      operation: "recipient",
      recipient: recipientOwner,
    }),
  ).toEqual({ environmentId, assistantId, operation: "recipient", recipient: recipientOwner });
  expect(
    normalizeAssistantMemoryRead({
      environmentId,
      assistantId,
      operation: "confirmations",
      limit: 300,
    }),
  ).toMatchObject({ operation: "confirmations", limit: 32 });
  const intent = {
    environmentId,
    assistantId,
    operation: "confirm" as const,
    source: assistantMemorySourceSelector(source),
  };
  const input = { selected: selection, current: selection, intent, currentSource: source };
  expect(prepareAssistantMemoryMutation(input)).toBe(intent);
  expect(
    prepareAssistantMemoryMutation({
      ...input,
      currentSource: { ...source, generation: source.generation + 1 },
    }),
  ).toBeNull();
});

it.effect("private webhook handoff requires current read and operate grants", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const atoms = createAssistantsEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      let requests = 0;
      const taskId = ScheduledTaskId.make("webhook");
      yield* SubscriptionRef.set(
        harness.session,
        Option.some({
          client: {
            [WS_METHODS.assistantsRoutineRead]: () =>
              Effect.sync(() => {
                requests++;
                return { operation: "webhook", taskId, url: null, remoteAccessRequired: true };
              }),
          },
        } as unknown as RpcSession),
      );
      const auth = {
        authenticated: true as const,
        auth: {
          policy: "remote-reachable" as const,
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "test",
        },
        scopes: [AuthOrchestrationReadScope],
        permissions: [AuthOrchestrationReadScope],
      };
      registry.set(sessions(environmentId), AsyncResult.success(auth));
      const input = { environmentId, assistantId, operation: "webhook" as const, taskId };
      expect(normalizeAssistantRoutineRead(input)).toEqual(input);
      expect(registry.get(atoms.routineWebhook.permissionAtom(environmentId))).toBe(false);
      const denied = yield* Effect.promise(() =>
        atoms.routineWebhook.run(registry, { environmentId, input }),
      );
      expect(denied._tag).toBe("Failure");
      registry.set(
        sessions(environmentId),
        AsyncResult.success({
          ...auth,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        }),
      );
      expect(registry.get(atoms.routineWebhook.permissionAtom(environmentId))).toBe(true);
      const allowed = yield* Effect.promise(() =>
        atoms.routineWebhook.run(registry, { environmentId, input }),
      );
      expect(allowed).toMatchObject({
        _tag: "Success",
        value: { operation: "webhook", url: null, remoteAccessRequired: true },
      });
      expect(requests).toBe(1);
    }),
  ),
);
