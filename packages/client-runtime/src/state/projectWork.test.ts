import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  ProjectWorkWriteIntent,
  ProjectWorkRpcError,
  type ProjectWorkReadIntent,
  ProjectWorkTaskId,
  EnvironmentId,
  ProjectId,
  EventId,
  WS_METHODS,
  type ProjectWorkDelta,
  type ProjectWorkStreamInput,
  type ProjectWorkStreamItem,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import {
  prepareProjectWorkHumanMutation,
  prepareProjectWorkDeliveryMutation,
  retainProjectWorkDeliveryOperation,
  prepareProjectWorkRecoveredDelivery,
  decodeProjectWorkSpecialRead,
  isProjectWorkHumanCommand,
} from "../projectWork.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createProjectWorkEnvironmentAtoms,
  emptyProjectWorkStreamState,
  normalizeProjectWorkPage,
  normalizeProjectWorkRead,
  projectWorkDeltaAffectsRead,
  projectWorkResourceKey,
  reduceProjectWorkStream,
  resumeProjectWorkInput,
} from "./projectWork.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);
const isWriteIntent = Schema.is(ProjectWorkWriteIntent);
const projectId = ProjectId.make("same-project");
const first = EnvironmentId.make("first");
const second = EnvironmentId.make("second");
const delta = (cursor: number, overrides: Partial<ProjectWorkDelta> = {}): ProjectWorkDelta => ({
  projectId,
  cursor,
  eventId: EventId.make(`event-${cursor}`),
  kind: "task",
  recordId: "task",
  revision: cursor,
  deleted: false,
  ...overrides,
});

it("keys coincident IDs by environment, filter, collection and page with stable object order", () => {
  const input = { projectId, operation: "tasks" as const, state: "draft", limit: 20, offset: 0 };
  const key = projectWorkResourceKey({ environmentId: first, input });
  expect(
    projectWorkResourceKey({
      environmentId: first,
      input: { offset: 0, limit: 20, state: "draft", operation: "tasks", projectId },
    }),
  ).toBe(key);
  for (const target of [
    { environmentId: second, input },
    { environmentId: first, input: { ...input, state: "ready" } },
    { environmentId: first, input: { ...input, offset: 20 } },
    { environmentId: first, input: { ...input, operation: "evidence" as const } },
  ])
    expect(projectWorkResourceKey(target)).not.toBe(key);
  expect(normalizeProjectWorkRead({ ...input, limit: 400, offset: -5 })).toMatchObject({
    limit: 128,
    offset: 0,
    envelope: true,
  });
});

it("keeps pages separate by revision and marks future or malformed records unknown", () => {
  const input = { projectId, operation: "tasks" as const };
  const page = normalizeProjectWorkPage(input, {
    projectId,
    revision: 9,
    offset: 20,
    limit: 2,
    hasMore: true,
    items: [{ id: "future", kind: "new-kind" }, null],
  });
  expect(page).toMatchObject({
    revision: 9,
    nextOffset: 22,
    items: [{ known: false, label: "Unknown work record" }, { known: false }],
  });
  expect(
    normalizeProjectWorkPage(input, {
      projectId: "other",
      revision: 9,
      offset: 0,
      limit: 2,
      hasMore: false,
      items: [],
    }),
  ).toBeNull();
  expect(
    normalizeProjectWorkPage(input, {
      projectId,
      revision: 9,
      offset: 0,
      limit: 128,
      hasMore: false,
      items: Array.from({ length: 129 }, () => null),
    }),
  ).toBeNull();
});

it("ignores stale, duplicate and foreign deltas; bounds retained records and resets ahead cursors", () => {
  let state = reduceProjectWorkStream(emptyProjectWorkStreamState(projectId), {
    kind: "delta",
    delta: delta(3),
  });
  expect(reduceProjectWorkStream(state, { kind: "delta", delta: delta(3) })).toBe(state);
  expect(reduceProjectWorkStream(state, { kind: "delta", delta: delta(2) })).toBe(state);
  expect(
    reduceProjectWorkStream(state, {
      kind: "delta",
      delta: delta(4, { projectId: ProjectId.make("other") }),
    }),
  ).toBe(state);
  for (let cursor = 4; cursor < 200; cursor++)
    state = reduceProjectWorkStream(state, { kind: "delta", delta: delta(cursor) });
  expect(state.changes).toHaveLength(128);
  state = reduceProjectWorkStream(state, {
    kind: "resync-required",
    projectId,
    cursor: 8,
    reason: "cursor-ahead",
  });
  expect(state).toMatchObject({ cursor: 8, synchronized: false, resyncCursor: 8, changes: [] });
  expect(
    resumeProjectWorkInput(
      { projectId, afterCursor: 199 },
      { kind: "resync-required", projectId, cursor: 8, reason: "cursor-ahead" },
    ).afterCursor,
  ).toBe(8);
});

it("invalidates bounded reads in the affected project including dependent projections", () => {
  expect(projectWorkDeltaAffectsRead({ projectId, operation: "evidence" }, delta(1))).toBe(true);
  expect(
    projectWorkDeltaAffectsRead({ projectId, operation: "tasks", state: "draft" }, delta(1)),
  ).toBe(true);
  expect(
    projectWorkDeltaAffectsRead(
      { projectId, operation: "task", taskId: ProjectWorkTaskId.make("another") },
      delta(1),
    ),
  ).toBe(true);
  expect(
    projectWorkDeltaAffectsRead(
      { projectId: ProjectId.make("other"), operation: "tasks" },
      delta(1),
    ),
  ).toBe(false);
});

const makeHarness = Effect.fn("ProjectWorkTest.makeHarness")(function* () {
  const inputs: ProjectWorkStreamInput[] = [];
  const closes = yield* Queue.unbounded<number>();
  const closed = yield* Deferred.make<void>();
  const firstStarted = yield* Deferred.make<void>();
  const makeSession = (items: readonly ProjectWorkStreamItem[], trackClose = false) =>
    ({
      client: {
        [WS_METHODS.projectWorkRead]: () =>
          Effect.succeed({
            projectId,
            revision: 7,
            offset: 0,
            limit: 64,
            hasMore: false,
            items: [],
          }),
        [WS_METHODS.projectWorkSubscribe]: (input: ProjectWorkStreamInput) => {
          inputs.push(input);
          return Stream.fromEffect(Deferred.succeed(firstStarted, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable(items)),
            Stream.concat(Stream.never),
            Stream.ensuring(
              Queue.offer(closes, input.afterCursor ?? 0).pipe(
                Effect.andThen(trackClose ? Deferred.succeed(closed, undefined) : Effect.void),
              ),
            ),
          );
        },
      },
    }) as unknown as RpcSession;
  const session = yield* SubscriptionRef.make(
    Option.some(
      makeSession(
        [
          { kind: "delta", delta: delta(7) },
          { kind: "synchronized", projectId, cursor: 7 },
        ],
        true,
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: first,
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
  const service = EnvironmentRegistry.of({
    run: (_id, source) => Effect.provideService(source, EnvironmentSupervisor, supervisor),
    followStream: (_id, source) => Stream.provideService(source, EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, service));
  return { inputs, closes, closed, firstStarted, makeSession, session, runtime, supervisor };
});

describe("Work environment atoms", () => {
  it.effect(
    "refreshes task, attention and relationship projections from remote blocker and task deltas",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const updates = yield* Queue.unbounded<ProjectWorkStreamItem>();
          let revision = 7;
          const reads = new Map<string, number>();
          const session = {
            client: {
              [WS_METHODS.projectWorkRead]: (input: ProjectWorkReadIntent) =>
                Effect.sync(() => {
                  reads.set(input.operation, (reads.get(input.operation) ?? 0) + 1);
                  const task = {
                    taskId: "task",
                    state: revision === 7 ? "blocked" : "ready",
                    revision,
                  };
                  if (input.operation === "task") return task;
                  const items =
                    input.operation === "tasks"
                      ? [task]
                      : input.operation === "attention"
                        ? revision === 7
                          ? [{ reason: "blocked" }]
                          : []
                        : revision === 9
                          ? [{ fromTaskId: "task", toTaskId: "duplicate" }]
                          : [];
                  return { projectId, revision, offset: 0, limit: 64, hasMore: false, items };
                }),
              [WS_METHODS.projectWorkSubscribe]: () =>
                Stream.concat(
                  Stream.succeed({ kind: "synchronized" as const, projectId, cursor: 7 }),
                  Stream.fromQueue(updates),
                ),
            },
          } as unknown as RpcSession;
          yield* SubscriptionRef.set(harness.session, Option.some(session));
          const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const operations = ["tasks", "task", "attention", "relationships"] as const;
          const milestones = new Map<string, Deferred.Deferred<void>>();
          for (const operation of operations)
            for (const version of [7, 8, 9])
              milestones.set(`${operation}:${version}`, yield* Deferred.make<void>());
          const mounted = operations.map((operation) => {
            const atom = atoms.read({
              environmentId: first,
              input: {
                projectId,
                operation,
                ...(operation === "task" ? { taskId: ProjectWorkTaskId.make("task") } : {}),
              },
            });
            registry.subscribe(
              atom,
              (state) => {
                const value = state.value;
                if (
                  state.status !== "ready" ||
                  typeof value !== "object" ||
                  value === null ||
                  !("revision" in value)
                )
                  return;
                const milestone = milestones.get(`${operation}:${value.revision}`);
                if (milestone) Deferred.doneUnsafe(milestone, Exit.void);
              },
              { immediate: true },
            );
            return atom;
          });
          const awaitRevision = (version: number) =>
            Effect.all(
              operations.map((operation) =>
                Deferred.await(milestones.get(`${operation}:${version}`)!),
              ),
            );
          yield* awaitRevision(7);
          revision = 8;
          yield* Queue.offer(updates, {
            kind: "delta",
            delta: delta(8, {
              kind: "blocker",
              recordId: "blocker",
              record: { taskId: "task", resolvedAt: "2026-10-21T00:00:00.000Z" },
            }),
          });
          yield* awaitRevision(8);
          expect(registry.get(mounted[0]!).page?.items[0]?.value).toMatchObject({ state: "ready" });
          expect(registry.get(mounted[1]!).value).toMatchObject({ state: "ready" });
          expect(registry.get(mounted[2]!).page?.items).toEqual([]);
          revision = 9;
          yield* Queue.offer(updates, { kind: "delta", delta: delta(9) });
          yield* awaitRevision(9);
          expect(registry.get(mounted[3]!).page?.items[0]?.value).toMatchObject({
            toTaskId: "duplicate",
          });
          for (const operation of operations)
            expect(reads.get(operation)).toBeGreaterThanOrEqual(3);
        }),
      ),
  );

  it.effect(
    "retains a successful bounded page but labels it stale after the live subscription fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const fail = yield* Deferred.make<void>();
          const session = {
            client: {
              [WS_METHODS.projectWorkRead]: () =>
                Effect.succeed({
                  projectId,
                  revision: 7,
                  offset: 0,
                  limit: 64,
                  hasMore: false,
                  items: [],
                }),
              [WS_METHODS.projectWorkSubscribe]: () =>
                Stream.concat(
                  Stream.succeed({ kind: "synchronized" as const, projectId, cursor: 7 }),
                  Stream.fromEffect(Deferred.await(fail)).pipe(
                    Stream.flatMap(() =>
                      Stream.fail(
                        new ProjectWorkRpcError({ operation: "subscribe", reason: "unavailable" }),
                      ),
                    ),
                  ),
                ),
            },
          } as unknown as RpcSession;
          yield* SubscriptionRef.set(harness.session, Option.some(session));
          const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const ready = yield* Deferred.make<void>();
          const stale = yield* Deferred.make<void>();
          const atom = atoms.read({
            environmentId: first,
            input: { projectId, operation: "tasks" },
          });
          registry.subscribe(
            atom,
            (state) => {
              if (state.status === "ready") Deferred.doneUnsafe(ready, Exit.void);
              if (
                state.status === "stale" &&
                registry.get(atoms.stream(first, projectId))._tag === "Failure"
              )
                Deferred.doneUnsafe(stale, Exit.void);
            },
            { immediate: true },
          );
          yield* Deferred.await(ready);
          yield* Deferred.succeed(fail, undefined);
          yield* Deferred.await(stale);
          expect((yield* SubscriptionRef.get(harness.supervisor.state)).phase).toBe("connected");
          expect(registry.get(atom)).toMatchObject({
            status: "stale",
            label: "Work may be stale",
            page: { revision: 7, items: [] },
          });
        }),
      ),
  );

  it.effect(
    "keeps records with coincident project IDs isolated across two connected environments",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const one = yield* makeHarness();
          const two = yield* makeHarness();
          yield* SubscriptionRef.set(
            two.session,
            Option.some(
              two.makeSession([
                { kind: "delta", delta: delta(19) },
                { kind: "synchronized", projectId, cursor: 19 },
              ]),
            ),
          );
          const supervisorFor = (id: EnvironmentId) =>
            id === first ? one.supervisor : two.supervisor;
          const service = EnvironmentRegistry.of({
            run: (id, source) =>
              Effect.provideService(source, EnvironmentSupervisor, supervisorFor(id)),
            followStream: (id, source) =>
              Stream.provideService(source, EnvironmentSupervisor, supervisorFor(id)),
          } as EnvironmentRegistry["Service"]);
          const atoms = createProjectWorkEnvironmentAtoms(
            Atom.runtime(Layer.succeed(EnvironmentRegistry, service)),
          );
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const ready = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
          const cursors = new Map<EnvironmentId, number>();
          for (const [index, id] of [first, second].entries())
            registry.subscribe(
              atoms.stream(id, projectId),
              (result) => {
                if (
                  !AsyncResult.isSuccess(result) ||
                  Option.isNone(result.value) ||
                  !result.value.value.synchronized
                )
                  return;
                cursors.set(id, result.value.value.cursor);
                Deferred.doneUnsafe(ready[index]!, Exit.void);
              },
              { immediate: true },
            );
          yield* Effect.all(ready.map(Deferred.await));
          expect([...cursors.entries()]).toEqual([
            [first, 7],
            [second, 19],
          ]);
        }),
      ),
  );

  it.effect("labels retained bounded data disconnected when its environment goes offline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const ready = yield* Deferred.make<void>();
        const offline = yield* Deferred.make<void>();
        const atom = atoms.read({ environmentId: first, input: { projectId, operation: "tasks" } });
        registry.subscribe(
          atom,
          (state) => {
            if (state.status === "ready") Deferred.doneUnsafe(ready, Exit.void);
            if (state.status === "disconnected") Deferred.doneUnsafe(offline, Exit.void);
          },
          { immediate: true },
        );
        yield* Deferred.await(ready);
        yield* SubscriptionRef.update(harness.supervisor.state, (state) => ({
          ...state,
          phase: "offline" as const,
        }));
        yield* Deferred.await(offline);
        expect(registry.get(atom)).toMatchObject({
          status: "disconnected",
          label: "Disconnected",
          page: { revision: 7, items: [] },
        });
      }),
    ),
  );

  it.effect(
    "resumes a replaced RPC session after the last cursor, deduplicates replay and closes detail streams",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
          const registry = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
          const firstSeen = yield* Deferred.make<void>();
          const secondSeen = yield* Deferred.make<void>();
          const observed: number[] = [];
          registry.subscribe(
            atoms.stream(first, projectId),
            (result) => {
              if (!AsyncResult.isSuccess(result) || Option.isNone(result.value)) return;
              const state = result.value.value;
              if (!state.synchronized) return;
              observed.push(state.cursor);
              if (state.cursor === 7) Deferred.doneUnsafe(firstSeen, Exit.void);
              if (state.cursor === 9) Deferred.doneUnsafe(secondSeen, Exit.void);
            },
            { immediate: true },
          );
          yield* Deferred.await(firstSeen);
          yield* SubscriptionRef.set(
            harness.session,
            Option.some(
              harness.makeSession([
                { kind: "delta", delta: delta(7) },
                { kind: "delta", delta: delta(9) },
                { kind: "synchronized", projectId, cursor: 9 },
              ]),
            ),
          );
          yield* Deferred.await(secondSeen);
          yield* Deferred.await(harness.closed);
          expect(harness.inputs.map((input) => input.afterCursor)).toEqual([undefined, 7]);
          expect(observed).toEqual([7, 9]);
          expect(yield* Queue.take(harness.closes)).toBe(0);
          registry.dispose();
          expect(yield* Queue.take(harness.closes)).toBe(7);
        }),
      ),
  );

  it.effect("exposes the mutation grant and denies a write in an environment without it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        registry.set(
          sessions(first),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: [],
            permissions: [],
          }),
        );
        expect(registry.get(atoms.permissionAtom(first))).toBe(false);
        expect(atoms.write.requiredScopes()).toEqual(["orchestration:operate"]);
        const result = yield* Effect.promise(() =>
          atoms.write.run(registry, {
            environmentId: first,
            input: {
              type: "project-work.task.create",
              projectId,
              commandId: CommandId.make("command"),
              expectedRevision: 0,
              taskId: ProjectWorkTaskId.make("task"),
              title: "Task",
              createdAt: "2026-10-21T00:00:00.000Z",
            },
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(harness.inputs).toEqual([]);
      }),
    ),
  );
});

it.effect("sends one human approval and rejects worker intents before transport", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const sent: ProjectWorkWriteIntent[] = [];
      const commandId = CommandId.make("approve");
      const client = {
        [WS_METHODS.projectWorkWrite]: (input: ProjectWorkWriteIntent) =>
          Effect.sync(() => {
            sent.push(input);
            return {
              projectId,
              revision: 8,
              receipt: {
                commandId,
                status: "accepted" as const,
                projectId,
                revision: 8,
                eventCount: 1,
              },
              delta: { projectId, revision: 8, eventIds: [], changedFields: ["approval"] },
            };
          }),
      };
      yield* SubscriptionRef.set(harness.session, Option.some({ client } as unknown as RpcSession));
      const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      registry.set(
        sessions(first),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationOperateScope],
        }),
      );
      const approval = {
        type: "project-team.gate.respond" as const,
        projectId,
        taskId: ProjectWorkTaskId.make("task"),
        commandId,
        expectedRevision: 7,
        expectedTaskRevision: 2,
        specRevision: 1,
        planRevision: 0,
        gateId: "gate",
        expectedGateRevision: 3,
        response: "approved" as const,
      };
      const result = yield* Effect.promise(() =>
        atoms.write.run(registry, { environmentId: first, input: approval }),
      );
      expect(result._tag).toBe("Success");
      expect(sent).toEqual([approval]);
      // Simulate a stale caller built against the wider wire contract.
      const worker = {
        projectId,
        taskId: approval.taskId,
        commandId,
        expectedRevision: 7,
        expectedTaskRevision: 2,
        type: "project-team.assignment.report",
        specRevision: 1,
        planRevision: 1,
        assignmentId: "assignment",
        expectedAssignmentRevision: 1,
        summary: "Managed report",
        evidenceIds: [],
        outputArtifactIds: [],
        outcome: "complete",
      } as unknown as Parameters<typeof atoms.write.run>[1]["input"];
      expect(isWriteIntent(worker)).toBe(true);
      const denied = yield* Effect.promise(() =>
        atoms.write.run(registry, { environmentId: first, input: worker }),
      );
      expect(denied._tag).toBe("Failure");
      expect(sent).toEqual([approval]);
    }),
  ),
);

it.effect("refreshing a failed read wrapper retries its underlying bounded query", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      let reads = 0;
      const session = harness.makeSession([{ kind: "synchronized", projectId, cursor: 7 }]);
      const retrySession = {
        ...session,
        client: {
          ...session.client,
          [WS_METHODS.projectWorkRead]: () =>
            Effect.suspend(() => {
              reads += 1;
              return reads === 1
                ? Effect.fail(new ProjectWorkRpcError({ operation: "read", reason: "unavailable" }))
                : Effect.succeed({
                    projectId,
                    revision: 7,
                    offset: 0,
                    limit: 64,
                    hasMore: false,
                    items: [],
                  });
            }),
        },
      } as unknown as RpcSession;
      yield* SubscriptionRef.set(harness.session, Option.some(retrySession));
      const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const failed = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<void>();
      const atom = atoms.read({ environmentId: first, input: { projectId, operation: "tasks" } });
      registry.subscribe(
        atom,
        (state) => {
          if (state.result._tag === "Failure") Deferred.doneUnsafe(failed, Exit.void);
          if (state.status === "ready") Deferred.doneUnsafe(recovered, Exit.void);
        },
        { immediate: true },
      );
      yield* Deferred.await(failed);
      expect(reads).toBe(1);
      registry.refresh(atom);
      yield* Deferred.await(recovered);
      expect(reads).toBe(2);
      expect(registry.get(atom)).toMatchObject({ status: "ready", page: { revision: 7 } });
    }),
  ),
);

it("binds schema-valid nested task mutations to the reviewed task and project revision", () => {
  const taskId = ProjectWorkTaskId.make("task-a");
  const otherTaskId = ProjectWorkTaskId.make("task-b");
  const selected = {
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId,
    revision: 8,
    taskRevision: 3,
  };
  const { taskId: _taskId, ...projectSelection } = selected;
  const at = "2026-10-21T00:00:00.000Z";
  const common = { commandId: CommandId.make("edit"), projectId, expectedRevision: 8 };
  const nestedMutations = (target: ProjectWorkTaskId) => [
    {
      ...common,
      type: "project-work.comment.add",
      comment: {
        commentId: "comment",
        projectId,
        taskId: target,
        body: "Note",
        createdAt: at,
        revision: 0,
      },
      addedAt: at,
    },
    {
      ...common,
      type: "project-work.evidence.add",
      evidence: {
        evidenceId: "evidence",
        taskId: target,
        kind: "observation",
        summary: "Observed",
        recordedAt: at,
        revision: 0,
      },
      addedAt: at,
    },
    {
      ...common,
      type: "project-work.task.duplicate",
      sourceTaskId: target,
      duplicateTaskId: "new-task",
      duplicatedAt: at,
    },
    {
      ...common,
      type: "project-work.criterion.upsert",
      taskId,
      criterion: {
        criterionId: "criterion",
        taskId: target,
        description: "Works",
        required: true,
        status: "unsatisfied",
        satisfiedByEvidenceIds: [],
        revision: 0,
        updatedAt: at,
      },
      updatedAt: at,
    },
  ];
  for (const intent of nestedMutations(taskId)) {
    expect(isWriteIntent(intent)).toBe(true);
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(
      intent,
    );
    expect(
      prepareProjectWorkHumanMutation({
        selected: projectSelection,
        current: projectSelection,
        intent,
      }),
    ).toBeNull();
    expect(
      prepareProjectWorkHumanMutation({ selected, current: { ...selected, revision: 9 }, intent }),
    ).toBeNull();
    const { expectedRevision: _revision, ...withoutRevision } = intent;
    expect(isWriteIntent(withoutRevision)).toBe(true);
    expect(
      prepareProjectWorkHumanMutation({ selected, current: selected, intent: withoutRevision }),
    ).toBeNull();
  }
  for (const intent of nestedMutations(otherTaskId)) {
    expect(isWriteIntent(intent)).toBe(true);
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toBeNull();
  }
  const cancel = {
    commandId: common.commandId,
    projectId,
    taskId,
    type: "project-work.task.cancel",
    canceledAt: at,
  };
  expect(isWriteIntent(cancel)).toBe(true);
  expect(
    prepareProjectWorkHumanMutation({ selected, current: selected, intent: cancel }),
  ).toBeNull();
  expect(
    prepareProjectWorkHumanMutation({
      selected,
      current: selected,
      intent: { ...cancel, expectedRevision: 8 },
    }),
  ).not.toBeNull();
  const create = {
    ...common,
    type: "project-work.task.create",
    taskId: otherTaskId,
    title: "New",
    createdAt: at,
  };
  expect(isWriteIntent(create)).toBe(true);
  expect(
    prepareProjectWorkHumanMutation({
      selected: projectSelection,
      current: projectSelection,
      intent: create,
    }),
  ).toEqual(create);
  const projectEvidence = {
    ...common,
    type: "project-work.evidence.add",
    evidence: {
      evidenceId: "project-evidence",
      kind: "observation",
      summary: "Project evidence",
      recordedAt: at,
      revision: 0,
    },
    addedAt: at,
  };
  expect(isWriteIntent(projectEvidence)).toBe(true);
  expect(
    prepareProjectWorkHumanMutation({
      selected: projectSelection,
      current: projectSelection,
      intent: projectEvidence,
    }),
  ).toEqual(projectEvidence);
  const projectComment = {
    ...common,
    type: "project-work.comment.add",
    comment: {
      commentId: "project-note",
      projectId,
      body: "Project note",
      createdAt: at,
      revision: 0,
    },
    addedAt: at,
  };
  expect(isWriteIntent(projectComment)).toBe(true);
  expect(
    prepareProjectWorkHumanMutation({
      selected: projectSelection,
      current: projectSelection,
      intent: projectComment,
    }),
  ).toEqual(projectComment);
});

it("allows relationship counterparts and binds existing-issue refinement task revisions", () => {
  const taskId = ProjectWorkTaskId.make("task-a");
  const otherTaskId = ProjectWorkTaskId.make("task-b");
  const selected = {
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId,
    revision: 8,
    taskRevision: 3,
  };
  const common = { commandId: CommandId.make("link"), projectId, expectedRevision: 8 };
  const at = "2026-10-21T00:00:00.000Z";
  for (const [fromTaskId, toTaskId] of [
    [taskId, otherTaskId],
    [otherTaskId, taskId],
  ]) {
    const intent = {
      ...common,
      type: "project-work.relationship.link",
      relationship: {
        relationshipId: "relationship",
        projectId,
        fromTaskId,
        toTaskId,
        kind: "depends-on",
        revision: 0,
        createdAt: at,
      },
      linkedAt: at,
    };
    expect(isWriteIntent(intent)).toBe(true);
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(
      intent,
    );
    expect(
      prepareProjectWorkHumanMutation({
        selected: { ...selected, taskId: ProjectWorkTaskId.make("unrelated") },
        current: { ...selected, taskId: ProjectWorkTaskId.make("unrelated") },
        intent,
      }),
    ).toBeNull();
  }
  const intent = {
    ...common,
    type: "project-work.issue.refine",
    issueRecordId: "issue",
    expectedIssueRevision: 1,
    target: { kind: "existing-task", taskId, expectedTaskRevision: 3 },
    refinedAt: at,
  };
  expect(isWriteIntent(intent)).toBe(true);
  expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(intent);
  expect(
    prepareProjectWorkHumanMutation({
      selected,
      current: selected,
      intent: { ...intent, target: { ...intent.target, expectedTaskRevision: 2 } },
    }),
  ).toBeNull();
});

it("normalizes memory keyset pages without inventing an offset and keeps cursors distinct", () => {
  const taskId = ProjectWorkTaskId.make("task");
  const input = {
    projectId,
    taskId,
    operation: "memory-current" as const,
    limit: 900,
    offset: 10,
    cursor: "scanned-empty",
  };
  expect(normalizeProjectWorkRead(input)).toEqual({
    projectId,
    taskId,
    operation: "memory-current",
    limit: 32,
    cursor: "scanned-empty",
  });
  expect(projectWorkResourceKey({ environmentId: first, input })).not.toBe(
    projectWorkResourceKey({ environmentId: first, input: { ...input, cursor: "next" } }),
  );
  expect(
    normalizeProjectWorkRead({ projectId, taskId, operation: "integration-sources", limit: 128 })
      .limit,
  ).toBe(64);
  const empty = {
    owner: { kind: "project", projectId },
    projectId,
    taskId,
    revision: 7,
    status: "available",
    items: [],
    nextCursor: "scanned-empty",
  };
  expect(decodeProjectWorkSpecialRead(input, empty, first)).toEqual({
    operation: "memory-current",
    value: empty,
  });
  expect(
    decodeProjectWorkSpecialRead(input, { ...empty, taskId: "foreign" }, first)?.value,
  ).toBeNull();
  expect(
    decodeProjectWorkSpecialRead(
      input,
      { ...empty, owner: { kind: "project", projectId: "foreign" } },
      first,
    )?.value,
  ).toBeNull();
});

it("qualifies supervision and integration reads and preserves unavailable and uncertain states", () => {
  const unavailable = { projectId, availability: "archived" };
  expect(
    decodeProjectWorkSpecialRead({ projectId, operation: "supervision" }, unavailable, first)
      ?.value,
  ).toEqual(unavailable);
  expect(
    decodeProjectWorkSpecialRead(
      { projectId, operation: "supervision" },
      { ...unavailable, projectId: "elsewhere" },
      first,
    )?.value,
  ).toBeNull();
  const taskId = ProjectWorkTaskId.make("task");
  const candidates = {
    environmentId: first,
    projectId,
    taskId,
    revision: 7,
    taskRevision: 2,
    candidates: [],
    nextOffset: 0,
    hasMore: false,
  };
  expect(
    decodeProjectWorkSpecialRead(
      { projectId, taskId, operation: "integration-sources" },
      candidates,
      first,
    )?.value,
  ).toEqual(candidates);
  expect(
    decodeProjectWorkSpecialRead(
      { projectId, taskId, operation: "integration-sources" },
      candidates,
      second,
    )?.value,
  ).toBeNull();
  const sources = {
    owner: { kind: "project", projectId },
    projectId,
    taskId,
    revision: 7,
    status: "degraded",
    items: [],
    nextCursor: "scanned",
  };
  expect(
    decodeProjectWorkSpecialRead({ projectId, taskId, operation: "memory-sources" }, sources, first)
      ?.value,
  ).toEqual(sources);
});

it("binds retained merge and accept operations to the reviewed target across gate revisions", () => {
  const selected = {
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId: ProjectWorkTaskId.make("task"),
    revision: 7,
    taskRevision: 2,
  };
  const publish = {
    operation: "publish" as const,
    input: {
      projectId,
      taskId: selected.taskId,
      operationId: "publication",
      gateId: "gate",
      sourceRef: {
        taskId: selected.taskId,
        bindingId: "binding",
        expectedBindingRevision: 1,
        generation: 1,
        reviewDispatchId: "review",
        expectedReviewProposalSha256: "a".repeat(64),
        verificationJobId: "job",
        expectedManifestHash: "b".repeat(64),
        expectedBranchRef: "refs/heads/work",
        expectedBaseSha: "a".repeat(40),
        expectedHeadSha: "b".repeat(40),
        expectedTestedTree: "c".repeat(40),
      },
      title: "PR",
      body: "Body",
    },
  };
  const reviewedPublication = retainProjectWorkDeliveryOperation({
    selected,
    current: selected,
    request: publish,
    result: { operationId: "publication", kind: "create-pr", stage: "confirmed" },
  });
  const mergePreview = {
    operation: "preview" as const,
    input: {
      projectId,
      taskId: selected.taskId,
      commandId: CommandId.make("merge"),
      expectedRevision: 7,
      sourceRef: publish.input.sourceRef,
      baseRef: "main",
      kind: "merge" as const,
      publicationOperationId: "publication",
    },
  };
  const reviewedMerge = retainProjectWorkDeliveryOperation({
    selected,
    current: selected,
    request: mergePreview,
    result: { operationId: "merge", kind: "preview", stage: "proposed" },
  });
  expect(reviewedPublication).not.toBeNull();
  expect(reviewedMerge).not.toBeNull();
  if (reviewedPublication === null || reviewedMerge === null)
    throw new Error("Expected retained operations");
  const merge = {
    operation: "merge" as const,
    input: { operationId: "merge", publicationOperationId: "publication", gateId: "merge-gate" },
  };
  const confirmedMerge = retainProjectWorkDeliveryOperation({
    selected,
    current: selected,
    request: merge,
    reviewedOperation: reviewedMerge,
    result: {
      operationId: "merge",
      kind: "merge",
      stage: "confirmed",
      receiptHash: "a".repeat(64),
    },
  });
  expect(confirmedMerge).not.toBeNull();
  expect(confirmedMerge?.receiptHash).toBe("a".repeat(64));
  if (confirmedMerge === null) throw new Error("Expected confirmed merge");
  const accept = {
    operation: "accept",
    input: { operationId: "merge", expectedReceiptHash: "a".repeat(64) },
  };
  expect(
    prepareProjectWorkDeliveryMutation({
      selected,
      current: selected,
      request: { ...accept, input: { ...accept.input, operationId: "publication" } },
      reviewedOperation: reviewedPublication,
    }),
  ).toBeNull();
  expect(
    prepareProjectWorkDeliveryMutation({
      selected,
      current: selected,
      request: accept,
      reviewedOperation: reviewedMerge,
    }),
  ).toBeNull();
  expect(
    prepareProjectWorkDeliveryMutation({
      selected,
      current: selected,
      request: accept,
      reviewedOperation: { ...confirmedMerge, receiptHash: "b".repeat(64) },
    }),
  ).toBeNull();
  const { receiptHash: _receiptHash, ...withoutHash } = confirmedMerge;
  expect(
    prepareProjectWorkDeliveryMutation({
      selected,
      current: selected,
      request: accept,
      reviewedOperation: withoutHash,
    }),
  ).toBeNull();
  for (const stage of ["proposed", "approved", "claimed", "uncertain"] as const)
    expect(
      prepareProjectWorkDeliveryMutation({
        selected,
        current: selected,
        request: accept,
        reviewedOperation: { ...confirmedMerge, stage },
      }),
    ).toBeNull();
  for (const [request, reviewedOperation, result] of [
    [mergePreview, undefined, { operationId: "merge", kind: "preview", stage: "proposed" }],
    [publish, undefined, { operationId: "publication", kind: "create-pr", stage: "confirmed" }],
    [merge, reviewedMerge, { operationId: "merge", kind: "merge", stage: "confirmed" }],
  ] as const) {
    for (const foreign of [
      { ...result, operationId: "foreign" },
      { ...result, kind: "accept" },
      { ...result, stage: request.operation === "preview" ? "confirmed" : "proposed" },
    ])
      expect(
        retainProjectWorkDeliveryOperation({
          selected,
          current: selected,
          request,
          ...(reviewedOperation === undefined ? {} : { reviewedOperation }),
          result: foreign,
        }),
      ).toBeNull();
  }
  for (const [request, reviewedOperation] of [
    [accept, confirmedMerge],
    [merge, reviewedMerge],
  ] as const) {
    expect(prepareProjectWorkDeliveryMutation({ selected, current: selected, request })).toBeNull();
    expect(
      prepareProjectWorkDeliveryMutation({
        selected,
        current: selected,
        request,
        reviewedOperation,
      }),
    ).toEqual({ projectId, request });
    const afterGate = { ...selected, revision: 9, taskRevision: 4 };
    expect(
      prepareProjectWorkDeliveryMutation({
        selected: afterGate,
        current: afterGate,
        request,
        reviewedOperation,
      }),
    ).toEqual({ projectId, request });
    for (const current of [
      { ...selected, environmentId: second },
      { ...selected, projectId: ProjectId.make("other") },
      { ...selected, checkoutPath: "/other" },
      { ...selected, taskId: ProjectWorkTaskId.make("other") },
    ]) {
      expect(
        prepareProjectWorkDeliveryMutation({
          selected: current,
          current,
          request,
          reviewedOperation,
        }),
      ).toBeNull();
      expect(
        prepareProjectWorkDeliveryMutation({ selected, current, request, reviewedOperation }),
      ).toBeNull();
    }
    expect(
      prepareProjectWorkDeliveryMutation({
        selected,
        current: { ...selected, revision: 8 },
        request,
        reviewedOperation,
      }),
    ).toBeNull();
    expect(
      prepareProjectWorkDeliveryMutation({
        selected,
        current: selected,
        request,
        reviewedOperation: { ...reviewedOperation, operationId: "foreign-operation" },
      }),
    ).toBeNull();
  }
  expect(
    prepareProjectWorkDeliveryMutation({
      selected,
      current: selected,
      request: merge,
      reviewedOperation: { ...reviewedMerge, publicationOperationId: "foreign-publication" },
    }),
  ).toBeNull();
  expect(
    retainProjectWorkDeliveryOperation({
      selected,
      current: { ...selected, taskId: ProjectWorkTaskId.make("elsewhere") },
      request: publish,
      result: { operationId: "publication", kind: "create-pr", stage: "confirmed" },
    }),
  ).toBeNull();
  expect(
    retainProjectWorkDeliveryOperation({
      selected,
      current: selected,
      request: publish,
      result: { operationId: "foreign-operation", kind: "create-pr", stage: "confirmed" },
    }),
  ).toBeNull();
});

it("permits human question answers and message reverse attention actions with exact CAS", () => {
  const selected = {
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId: ProjectWorkTaskId.make("task"),
    revision: 7,
    taskRevision: 2,
  };
  const common = { projectId, commandId: CommandId.make("answer"), expectedRevision: 7 };
  const answer = {
    ...common,
    type: "project-team.question.answer",
    taskId: selected.taskId,
    expectedTaskRevision: 2,
    specRevision: 1,
    planRevision: 1,
    questionId: "question",
    expectedQuestionRevision: 3,
    expectedGateRevision: 2,
    answer: "Yes",
  };
  expect(isProjectWorkHumanCommand(answer)).toBe(true);
  expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent: answer })).toEqual(
    answer,
  );
  expect(
    prepareProjectWorkHumanMutation({
      selected,
      current: selected,
      intent: { ...answer, expectedTaskRevision: 1 },
    }),
  ).toBeNull();
  for (const action of ["acknowledge", "resolve"]) {
    const intent = {
      ...common,
      type: "project-team.message.attention",
      messageId: "message",
      expectedMessageRevision: 3,
      action,
    };
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(
      intent,
    );
  }
});

it.effect("delivery requires both grants and retains an uncertain host result without retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      let calls = 0;
      const request = {
        operation: "accept" as const,
        input: { operationId: "publication", expectedReceiptHash: "a".repeat(64) },
      };
      const session = {
        client: {
          [WS_METHODS.projectWorkDelivery]: () =>
            Effect.sync(() => {
              calls++;
              return {
                operationId: "publication",
                kind: "accept" as const,
                stage: "uncertain" as const,
              };
            }),
        },
      } as unknown as RpcSession;
      yield* SubscriptionRef.set(harness.session, Option.some(session));
      const atoms = createProjectWorkEnvironmentAtoms(harness.runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const authorize = (
        permissions: readonly (
          | typeof AuthOrchestrationOperateScope
          | typeof AuthSourceControlWriteScope
        )[],
      ) =>
        registry.set(
          sessions(first),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: [...permissions],
            permissions: [...permissions],
          }),
        );
      expect(atoms.delivery.requiredScopes()).toEqual([
        AuthSourceControlWriteScope,
        AuthOrchestrationOperateScope,
      ]);
      for (const grant of [AuthOrchestrationOperateScope, AuthSourceControlWriteScope]) {
        authorize([grant]);
        expect(registry.get(atoms.delivery.permissionAtom(first))).toBe(false);
        expect(
          (yield* Effect.promise(() =>
            atoms.delivery.run(registry, { environmentId: first, input: { projectId, request } }),
          ))._tag,
        ).toBe("Failure");
      }
      expect(calls).toBe(0);
      authorize([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
      expect(registry.get(atoms.delivery.permissionAtom(first))).toBe(true);
      const result = yield* Effect.promise(() =>
        atoms.delivery.run(registry, { environmentId: first, input: { projectId, request } }),
      );
      expect(result).toMatchObject({ _tag: "Success", value: { stage: "uncertain" } });
      expect(calls).toBe(1);
    }),
  ),
);

it("prepares human investigation, assignment and execution starts only for current reviewed targets", () => {
  const selected = {
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId: ProjectWorkTaskId.make("task"),
    revision: 7,
    taskRevision: 2,
  };
  const common = {
    projectId,
    taskId: selected.taskId,
    commandId: CommandId.make("start"),
    expectedRevision: 7,
    expectedTaskRevision: 2,
  };
  const intents = [
    {
      ...common,
      type: "project-team.investigation.start",
      objective: "Investigate",
      outputDescriptions: ["Report"],
    },
    {
      ...common,
      type: "project-team.assignment.start",
      assignmentKind: "planning",
      objective: "Plan",
      outputDescriptions: ["Plan"],
      specRevision: 1,
      specificationGateId: "spec-gate",
      expectedSpecificationGateRevision: 1,
    },
    {
      ...common,
      type: "project-team.execution.start",
      specRevision: 1,
      planRevision: 1,
      specGateId: "spec-gate",
      expectedSpecGateRevision: 1,
      planId: "plan",
      expectedPlanRecordRevision: 1,
      planGateId: "plan-gate",
      expectedPlanGateRevision: 1,
    },
  ];
  for (const intent of intents) {
    expect(isProjectWorkHumanCommand(intent)).toBe(true);
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(
      intent,
    );
    for (const current of [
      { ...selected, environmentId: second },
      { ...selected, checkoutPath: "/foreign" },
      { ...selected, taskId: ProjectWorkTaskId.make("other") },
      { ...selected, revision: 8 },
      { ...selected, taskRevision: 3 },
    ])
      expect(prepareProjectWorkHumanMutation({ selected, current, intent })).toBeNull();
    expect(
      prepareProjectWorkHumanMutation({
        selected,
        current: selected,
        intent: { ...intent, taskId: ProjectWorkTaskId.make("other") },
      }),
    ).toBeNull();
  }
});

it("recovers exact retained delivery requests within the initiating read scope without writing", () => {
  const selected = {
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId: ProjectWorkTaskId.make("task"),
    revision: 9,
    taskRevision: 4,
  };
  const sourceRef = {
    taskId: selected.taskId,
    bindingId: "binding",
    expectedBindingRevision: 1,
    generation: 1,
    reviewDispatchId: "review",
    expectedReviewProposalSha256: "a".repeat(64),
    verificationJobId: "job",
    expectedManifestHash: "b".repeat(64),
    expectedBranchRef: "refs/heads/work",
    expectedBaseSha: "a".repeat(40),
    expectedHeadSha: "b".repeat(40),
    expectedTestedTree: "c".repeat(40),
  };
  const request = {
    operation: "merge" as const,
    input: { operationId: "merge", publicationOperationId: "publication", gateId: "gate" },
  };
  const row = {
    request,
    result: {
      operationId: "merge",
      kind: "merge",
      stage: "confirmed",
      receiptHash: "a".repeat(64),
    },
    sourceRef,
    baseRef: "main",
    gateId: "gate",
  };
  const recovery = {
    environmentId: first,
    projectId,
    taskId: selected.taskId,
    revision: 9,
    items: [row],
    nextCursor: "scanned",
  };
  const prepare = (value: unknown) =>
    prepareProjectWorkRecoveredDelivery({
      selected,
      current: selected,
      readScope: selected,
      recovery: value,
      operationId: "merge",
      operation: "merge",
    });
  const recovered = prepare(recovery);
  expect(recovered?.request).toEqual(request);
  expect(recovered?.reviewedOperation).toMatchObject({
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId: selected.taskId,
    operationId: "merge",
    publicationOperationId: "publication",
    stage: "confirmed",
    receiptHash: "a".repeat(64),
  });
  expect(
    prepareProjectWorkDeliveryMutation({
      selected,
      current: selected,
      request: {
        operation: "accept",
        input: { operationId: "merge", expectedReceiptHash: "a".repeat(64) },
      },
      reviewedOperation: recovered!.reviewedOperation,
    }),
  ).not.toBeNull();
  for (const overrides of [
    { environmentId: second },
    { projectId: "other" },
    { taskId: "other" },
    { revision: 8 },
    { items: [row, row] },
    { items: [{ ...row, result: { ...row.result, operationId: "foreign" } }] },
    { items: [{ ...row, result: { ...row.result, stage: "proposed" } }] },
    {
      items: [{ ...row, request: { ...request, input: { ...request.input, gateId: "foreign" } } }],
    },
  ])
    expect(prepare({ ...recovery, ...overrides })).toBeNull();
  expect(
    prepareProjectWorkRecoveredDelivery({
      selected,
      current: selected,
      readScope: { ...selected, checkoutPath: "/other" },
      recovery,
      operationId: "merge",
      operation: "merge",
    }),
  ).toBeNull();
  const preview = {
    ...row,
    request: {
      operation: "preview",
      input: {
        projectId,
        taskId: selected.taskId,
        commandId: "merge",
        expectedRevision: 7,
        sourceRef,
        baseRef: "main",
        kind: "merge",
        publicationOperationId: "publication",
      },
    },
    result: { operationId: "merge", kind: "preview", stage: "proposed", gateId: "gate" },
  };
  const recoveredPreview = prepareProjectWorkRecoveredDelivery({
    selected,
    current: selected,
    readScope: selected,
    recovery: { ...recovery, items: [preview] },
    operationId: "merge",
    operation: "preview",
  });
  expect(recoveredPreview?.reviewedOperation).toMatchObject({
    operationId: "merge",
    kind: "merge",
    stage: "proposed",
  });
  expect(
    prepare({
      ...recovery,
      items: [{ ...preview, result: { ...preview.result, operationId: "foreign" } }],
    }),
  ).toBeNull();
  const read = {
    projectId,
    taskId: selected.taskId,
    operation: "delivery-recovery" as const,
    offset: 100,
    limit: 200,
  };
  expect(normalizeProjectWorkRead(read)).toEqual({
    projectId,
    taskId: selected.taskId,
    operation: "delivery-recovery",
    limit: 32,
  });
  const empty = { ...recovery, items: [], nextCursor: "last-scanned-empty" };
  expect(decodeProjectWorkSpecialRead(read, empty, first)?.value).toEqual(empty);
  expect(decodeProjectWorkSpecialRead(read, recovery, second)?.value).toBeNull();
});

it("uses server observation selectors for promotion and preserves empty scanned pages", () => {
  const selected = {
    environmentId: first,
    projectId,
    checkoutPath: "/checkout",
    taskId: ProjectWorkTaskId.make("task"),
    revision: 7,
    taskRevision: 2,
  };
  const observation = {
    observationId: "observation-from-server",
    revision: 0,
    sourceId: "different-source",
    sourceRevision: 3,
    sourceGeneration: 2,
    contentHash: "a".repeat(64),
    body: "Retained fact",
    quote: "Retained quote",
  };
  const page = {
    environmentId: first,
    projectId,
    taskId: selected.taskId,
    revision: 7,
    items: [observation],
    nextCursor: "last-scanned",
  };
  const read = {
    projectId,
    taskId: selected.taskId,
    operation: "memory-observations" as const,
    limit: 400,
    offset: 10,
  };
  expect(normalizeProjectWorkRead(read)).toEqual({
    projectId,
    taskId: selected.taskId,
    operation: "memory-observations",
    limit: 32,
  });
  expect(decodeProjectWorkSpecialRead(read, page, first)?.value).toEqual(page);
  for (const bad of [
    { ...page, environmentId: second },
    { ...page, taskId: "other" },
    { ...page, items: Array.from({ length: 33 }, () => observation) },
  ])
    expect(decodeProjectWorkSpecialRead(read, bad, first)?.value).toBeNull();
  const empty = { ...page, items: [], nextCursor: "scanned-empty" };
  expect(decodeProjectWorkSpecialRead(read, empty, first)?.value).toEqual(empty);
  const intent = {
    type: "project-team.memory.promote",
    commandId: CommandId.make("promote"),
    projectId,
    taskId: selected.taskId,
    expectedRevision: 7,
    expectedTaskRevision: 2,
    specRevision: 1,
    planRevision: 1,
    observationId: observation.observationId,
    expectedObservationRevision: observation.revision,
    expectedSourceRevision: observation.sourceRevision,
    knowledgeId: "knowledge",
    title: "Fact",
  };
  expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(intent);
  expect(
    prepareProjectWorkHumanMutation({ selected, current: { ...selected, revision: 8 }, intent }),
  ).toBeNull();
});

it("decodes an exact task own source separately from ordered integration candidates", () => {
  const taskId = ProjectWorkTaskId.make("task");
  const ref = {
    taskId,
    bindingId: "binding",
    expectedBindingRevision: 1,
    generation: 1,
    reviewDispatchId: "review",
    expectedReviewProposalSha256: "a".repeat(64),
    verificationJobId: "job",
    expectedManifestHash: "b".repeat(64),
    expectedBranchRef: "refs/heads/work",
    expectedBaseSha: "a".repeat(40),
    expectedHeadSha: "b".repeat(40),
    expectedTestedTree: "c".repeat(40),
  };
  const source = {
    taskId,
    bindingId: "binding",
    bindingRevision: 1,
    generation: 1,
    dispatchId: "dispatch",
    workspaceReceiptSha256: "a".repeat(64),
    specRevision: 1,
    planRevision: 1,
    scopeHash: "a".repeat(64),
    branchRef: "refs/heads/work",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    testedTree: "c".repeat(40),
    reviewDispatchId: "review",
    reviewProposalSha256: "a".repeat(64),
    joinedReceiptId: "joined",
    jobId: "job",
    manifestHash: "b".repeat(64),
    attemptId: "attempt",
    resultHash: "a".repeat(64),
  };
  const ownSource = { ref, source, taskTitle: "Own task" };
  const page = {
    environmentId: first,
    projectId,
    taskId,
    revision: 7,
    taskRevision: 2,
    candidates: [],
    ownSource,
    nextOffset: 0,
    hasMore: false,
  };
  const read = { projectId, taskId, operation: "integration-sources" as const };
  expect(decodeProjectWorkSpecialRead(read, page, first)?.value).toEqual(page);
  expect(
    decodeProjectWorkSpecialRead(
      read,
      { ...page, ownSource: { ...ownSource, ref: { ...ref, taskId: "other" } } },
      first,
    )?.value,
  ).toBeNull();
  expect(
    decodeProjectWorkSpecialRead(
      read,
      { ...page, ownSource: { ...ownSource, source: { ...source, taskId: "other" } } },
      first,
    )?.value,
  ).toBeNull();
});

it("keeps opaque own-source continuation independent of candidate pagination", () => {
  const taskId = ProjectWorkTaskId.make("task");
  const read = {
    projectId,
    taskId,
    operation: "integration-sources" as const,
    offset: 8,
    limit: 8,
  };
  const firstPage = {
    environmentId: first,
    projectId,
    taskId,
    revision: 7,
    taskRevision: 2,
    candidates: [],
    nextOffset: 16,
    hasMore: true,
    ownSourceNextCursor: "opaque:scan/64+revision=3",
  };
  const decoded = decodeProjectWorkSpecialRead(read, firstPage, first);
  expect(decoded?.value).toEqual(firstPage);
  const next = { ...read, ownSourceCursor: firstPage.ownSourceNextCursor };
  expect(normalizeProjectWorkRead(next)).toMatchObject({
    offset: 8,
    ownSourceCursor: firstPage.ownSourceNextCursor,
  });
  const secondPage = { ...firstPage, ownSourceNextCursor: "opaque:scan/128+revision=2" };
  expect(decodeProjectWorkSpecialRead(next, secondPage, first)?.value).toEqual(secondPage);
  expect(projectWorkResourceKey({ environmentId: first, input: read })).not.toBe(
    projectWorkResourceKey({ environmentId: first, input: next }),
  );
  expect(projectWorkResourceKey({ environmentId: first, input: next })).not.toBe(
    projectWorkResourceKey({ environmentId: first, input: { ...next, offset: 16 } }),
  );
  expect(normalizeProjectWorkRead({ ...next, offset: 16 })).toMatchObject({
    offset: 16,
    ownSourceCursor: firstPage.ownSourceNextCursor,
  });
  for (const ownSourceCursor of ["", "x".repeat(4001)])
    expect(normalizeProjectWorkRead({ ...read, ownSourceCursor })).toEqual(
      normalizeProjectWorkRead(read),
    );
  expect(
    decodeProjectWorkSpecialRead(
      read,
      { ...firstPage, ownSourceNextCursor: "x".repeat(4001) },
      first,
    )?.value,
  ).toBeNull();
});
