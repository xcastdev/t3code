import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  WS_METHODS,
  type ProjectWorkReadIntent,
  type ProjectWorkWriteIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";

import {
  PROJECT_WORK_PAGE_REQUEST_SIZE,
  createProjectWorkEnvironmentAtoms,
  type ProjectWorkWriteTarget,
  PROJECT_WORK_PAGE_SIZE,
  asProjectWorkArray,
  asProjectWorkFoundationPage,
  combineProjectWorkFoundationPages,
  asProjectWorkBriefing,
  asProjectWorkPage,
  projectWorkPageInput,
  projectWorkPageTargetKey,
  projectWorkStreamAvailable,
  initialProjectWorkStreamState,
  reduceProjectWorkStreamItem,
  reduceProjectWorkStreamBatch,
  projectWorkWritesAvailable,
} from "./index.ts";

describe("project-work client bounds", () => {
  it("keeps read collections bounded when the server response is malformed", () => {
    expect(asProjectWorkArray({ records: Array.from({ length: 500 }, () => ({})) })).toEqual([]);
    expect(asProjectWorkArray(["first", "second"])).toHaveLength(2);
    expect(PROJECT_WORK_PAGE_SIZE).toBe(50);
    expect(PROJECT_WORK_PAGE_REQUEST_SIZE).toBe(51);
  });

  it("keys each page by environment, project, collection, and offset", () => {
    const target = {
      environmentId: "environment-a" as never,
      projectId: "project-a" as never,
      collection: "tasks" as const,
      offset: 50,
    };
    expect(projectWorkPageTargetKey(target)).toBe(
      JSON.stringify(["environment-a", "project-a", "tasks", 50]),
    );
    expect(projectWorkPageTargetKey({ ...target, poll: false })).toBe(
      projectWorkPageTargetKey(target),
    );
    expect(projectWorkPageInput(target)).toEqual({
      projectId: "project-a",
      operation: "tasks",
      limit: 51,
      offset: 50,
      envelope: true,
    });
    expect(projectWorkPageInput({ ...target, offset: Number.NaN })).toMatchObject({
      offset: 0,
      limit: 51,
    });
  });

  it("advances durable cursors and requires a new snapshot after resync", () => {
    const initial = initialProjectWorkStreamState(3);
    const changed = reduceProjectWorkStreamItem(initial, {
      kind: "delta",
      delta: {
        projectId: "project-a" as never,
        cursor: 5,
        eventId: "event-1" as never,
        kind: "task",
        recordId: "task-1",
        revision: 2,
        deleted: false,
      },
    });
    expect(changed).toMatchObject({ cursor: 5, healthy: false, changedKinds: ["task"] });
    expect(
      reduceProjectWorkStreamItem(changed, {
        kind: "synchronized",
        projectId: "project-a" as never,
        cursor: 7,
      }),
    ).toMatchObject({ cursor: 7, healthy: true, resyncRequired: false });
    expect(
      reduceProjectWorkStreamItem(changed, {
        kind: "resync-required",
        projectId: "project-a" as never,
        cursor: 9,
        reason: "replay-too-large",
      }),
    ).toEqual({ cursor: 9, healthy: false, resyncRequired: true, changedKinds: [] });
  });

  it("accepts revision-bearing bounded envelopes", () => {
    expect(
      asProjectWorkPage({
        projectId: "project-a",
        revision: 11,
        offset: 0,
        limit: 50,
        hasMore: true,
        items: [{ id: 1 }],
      }),
    ).toEqual({ records: [{ id: 1 }], offset: 0, hasNext: true, nextOffset: 50, revision: 11 });
  });

  it("uses the extra row as a sentinel without rendering it", () => {
    const records = Array.from({ length: 51 }, (_, index) => ({ id: index }));
    expect(asProjectWorkPage(records, 50)).toEqual({
      records: records.slice(0, 50),
      offset: 50,
      hasNext: true,
      nextOffset: 100,
      revision: null,
    });
    expect(asProjectWorkPage(records.slice(0, 50), 50)).toEqual({
      records: records.slice(0, 50),
      offset: 50,
      hasNext: false,
      nextOffset: null,
      revision: null,
    });
    expect(asProjectWorkPage({ records }, 50)).toEqual({
      records: [],
      offset: 50,
      hasNext: false,
      nextOffset: null,
      revision: null,
    });
  });

  it("keeps a 51st envelope item as the next-page sentinel even when hasMore is false", () => {
    const records = Array.from({ length: 51 }, (_, id) => ({ id }));
    expect(asProjectWorkPage({ revision: 9, hasMore: false, items: records }, 0)).toEqual({
      records: records.slice(0, 50),
      offset: 0,
      hasNext: true,
      nextOffset: 50,
      revision: 9,
    });
  });

  it("folds every marker in a coalesced stream batch", () => {
    const state = reduceProjectWorkStreamBatch(initialProjectWorkStreamState(2), [
      {
        kind: "delta",
        delta: {
          projectId: "project-a" as never,
          cursor: 3,
          eventId: "event-1" as never,
          kind: "task",
          recordId: "task-1",
          revision: 1,
          deleted: false,
        },
      },
      { kind: "synchronized", projectId: "project-a" as never, cursor: 4 },
    ]);
    expect(state).toMatchObject({ cursor: 4, healthy: true, changedKinds: ["task"] });
  });

  it("only permits authoritative writes while enabled and connected", () => {
    expect(projectWorkWritesAvailable({ enabled: false, connectionPhase: "connected" })).toBe(
      false,
    );
    expect(projectWorkWritesAvailable({ enabled: true, connectionPhase: "reconnecting" })).toBe(
      false,
    );
    expect(projectWorkWritesAvailable({ enabled: true, connectionPhase: "connected" })).toBe(true);
  });

  it("requires the advertised stream capability before opening a work stream", () => {
    expect(
      projectWorkStreamAvailable({ capability: undefined, connectionPhase: "connected" }),
    ).toBe(false);
    expect(projectWorkStreamAvailable({ capability: false, connectionPhase: "connected" })).toBe(
      false,
    );
    expect(projectWorkStreamAvailable({ capability: true, connectionPhase: "reconnecting" })).toBe(
      false,
    );
    expect(projectWorkStreamAvailable({ capability: true, connectionPhase: "connected" })).toBe(
      true,
    );
  });

  it("ignores an incompatible overview envelope", () => {
    expect(asProjectWorkBriefing({ text: "missing revision" })).toBeNull();
    expect(
      asProjectWorkBriefing({
        text: "A bounded brief",
        sourceRevision: 3,
        includedTaskIds: [],
        includedKnowledgeIds: [],
        omittedReasons: [],
      }),
    ).not.toBeNull();
  });
});

const projectId = ProjectId.make("foundation-project");
const foundationRecord = (recordId = "record-1") => ({
  recordId,
  projectId,
  revision: 2,
  generation: 0,
  updatedAt: "2026-10-01T00:00:00.000Z",
  kind: "future-foundation-kind",
  status: "future-status",
  payload: "future data",
});
const foundationPage = (items = [foundationRecord()], nextCursor?: string) => ({
  projectId,
  revision: 3,
  items,
  ...(nextCursor === undefined ? {} : { nextCursor }),
});

describe("foundation snapshot validation", () => {
  it("retains bounded future record kinds and states", () => {
    expect(asProjectWorkFoundationPage(foundationPage(), projectId)).toEqual(foundationPage());
  });

  for (const [name, value] of [
    ["missing fields", { projectId, revision: 3, items: [{}] }],
    ["foreign page", { ...foundationPage(), projectId: "foreign" }],
    [
      "foreign record",
      foundationPage([{ ...foundationRecord(), projectId: ProjectId.make("foreign") }]),
    ],
    ["negative revision", { ...foundationPage(), revision: -1 }],
    ["unsafe aggregate revision", { ...foundationPage(), revision: Number.MAX_SAFE_INTEGER + 1 }],
    [
      "unsafe record revision",
      foundationPage([{ ...foundationRecord(), revision: Number.MAX_SAFE_INTEGER + 1 }]),
    ],
    ["record ahead of aggregate", foundationPage([{ ...foundationRecord(), revision: 4 }])],
    [
      "oversized page",
      foundationPage(Array.from({ length: 129 }, (_, index) => foundationRecord(String(index)))),
    ],
    [
      "oversized future payload",
      foundationPage([{ ...foundationRecord(), payload: "x".repeat(32_001) }]),
    ],
    ["oversized cursor", foundationPage([], "x".repeat(4_001))],
    ["oversized padded cursor", foundationPage([], " ".repeat(4_001) + "cursor")],
    ["empty cursor", foundationPage([], "")],
    ["null cursor", { ...foundationPage(), nextCursor: null }],
    ["array response", []],
    ["null response", null],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(asProjectWorkFoundationPage(value, projectId)).toBeNull();
      expect(combineProjectWorkFoundationPages({ projectId, pages: [{ value }] })).toMatchObject({
        records: [],
        revision: null,
        complete: false,
        nextCursor: null,
        error: "invalid-page",
      });
    });
  }

  it("keeps an empty input incomplete and an empty terminal page complete", () => {
    expect(combineProjectWorkFoundationPages({ projectId, pages: [] })).toEqual({
      records: [],
      revision: null,
      complete: false,
      nextCursor: null,
      error: null,
    });
    expect(
      combineProjectWorkFoundationPages({ projectId, pages: [{ value: foundationPage([]) }] }),
    ).toEqual({
      records: [],
      revision: 3,
      complete: true,
      nextCursor: null,
      error: null,
    });
  });

  it("requires the exact opaque cursor and a terminal page for completion", () => {
    const cursor = " opaque?token=abc/def+ghi== ";
    const first = { value: foundationPage([foundationRecord("first")], cursor) };
    expect(combineProjectWorkFoundationPages({ projectId, pages: [first] })).toEqual({
      records: [foundationRecord("first")],
      revision: 3,
      complete: false,
      nextCursor: cursor,
      error: null,
    });
    expect(
      combineProjectWorkFoundationPages({
        projectId,
        pages: [first, { cursor, value: foundationPage([foundationRecord("second")]) }],
      }),
    ).toEqual({
      records: [foundationRecord("first"), foundationRecord("second")],
      revision: 3,
      complete: true,
      nextCursor: null,
      error: null,
    });
  });

  for (const [name, pages] of [
    ["starts in the middle", [{ cursor: "middle", value: foundationPage() }]],
    [
      "skips a cursor",
      [{ value: foundationPage([], "next") }, { cursor: "other", value: foundationPage() }],
    ],
    ["omits a cursor", [{ value: foundationPage([], "next") }, { value: foundationPage() }]],
    ["continues after terminal", [{ value: foundationPage() }, { value: foundationPage() }]],
    [
      "cycles a response cursor",
      [
        { value: foundationPage([], "next") },
        { cursor: "next", value: foundationPage([], "next") },
      ],
    ],
    [
      "cycles to an earlier cursor",
      [
        { value: foundationPage([], "a") },
        { cursor: "a", value: foundationPage([], "b") },
        { cursor: "b", value: foundationPage([], "a") },
      ],
    ],
  ] as const) {
    it(`rejects a chain that ${name}`, () => {
      expect(combineProjectWorkFoundationPages({ projectId, pages })).toMatchObject({
        records: [],
        complete: false,
        error: "invalid-cursor-chain",
      });
    });
  }

  it("drops the snapshot when revisions change so callers restart from the first page", () => {
    expect(
      combineProjectWorkFoundationPages({
        projectId,
        pages: [
          { value: foundationPage([], "next") },
          { cursor: "next", value: { ...foundationPage(), revision: 4 } },
        ],
      }),
    ).toEqual({
      records: [],
      revision: null,
      complete: false,
      nextCursor: null,
      error: "revision-changed",
    });
  });

  it("rejects duplicate records within or across pages", () => {
    for (const pages of [
      [{ value: foundationPage([foundationRecord(), foundationRecord()]) }],
      [{ value: foundationPage(undefined, "next") }, { cursor: "next", value: foundationPage() }],
    ]) {
      expect(combineProjectWorkFoundationPages({ projectId, pages })).toMatchObject({
        records: [],
        complete: false,
        error: "duplicate-record",
      });
    }
  });

  it("accepts the full 16-page, 2048-record boundary and rejects a seventeenth page", () => {
    const pages = Array.from({ length: 16 }, (_, page) => ({
      ...(page === 0 ? {} : { cursor: `cursor-${page}` }),
      value: foundationPage(
        Array.from({ length: 128 }, (_, record) => foundationRecord(`${page}-${record}`)),
        page === 15 ? undefined : `cursor-${page + 1}`,
      ),
    }));
    const result = combineProjectWorkFoundationPages({ projectId, pages });
    expect(result.records).toHaveLength(2048);
    expect(result).toMatchObject({ complete: true, revision: 3, nextCursor: null, error: null });
    expect(
      combineProjectWorkFoundationPages({
        projectId,
        pages: [...pages, { cursor: "extra", value: foundationPage() }],
      }),
    ).toMatchObject({
      records: [],
      complete: false,
      error: "limit-exceeded",
    });
  });
});

const environmentId = EnvironmentId.make("foundation-environment");
const otherEnvironmentId = EnvironmentId.make("other-environment");
const makeFoundationHarness = Effect.fn(function* () {
  const reads: Array<{ environmentId: EnvironmentId; input: ProjectWorkReadIntent }> = [];
  const writes: ProjectWorkWriteIntent[] = [];
  let revision = 3;
  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();
  for (const id of [environmentId, otherEnvironmentId]) {
    // Only the three Project Work protocol methods are exercised by this harness.
    const methods = {
      [WS_METHODS.projectWorkRead]: (input: ProjectWorkReadIntent) =>
        Effect.sync(() => {
          reads.push({ environmentId: id, input });
          return { ...foundationPage([]), projectId: input.projectId, revision };
        }),
      [WS_METHODS.projectWorkWrite]: (input: ProjectWorkWriteIntent) =>
        Effect.sync(() => {
          writes.push(input);
          revision += 1;
          return {
            projectId: input.projectId,
            revision,
            receipt: {
              commandId: input.commandId,
              projectId: input.projectId,
              revision,
              status: "accepted" as const,
              eventCount: 1,
            },
            delta: { projectId: input.projectId, revision, eventIds: [], changedFields: [] },
          };
        }),
      [WS_METHODS.projectWorkSubscribe]: () => {
        revision += 1;
        return Stream.succeed({ kind: "synchronized" as const, projectId, cursor: revision });
      },
    };
    const client = methods as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      subscribeServerConfig: client.subscribeServerConfig,
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    supervisors.set(
      id,
      EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId: id,
          label: id,
          httpBaseUrl: "http://test",
          wsBaseUrl: "ws://test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      }),
    );
  }
  const supervisorFor = (id: EnvironmentId) => {
    const supervisor = supervisors.get(id);
    if (supervisor === undefined) throw new Error("Unexpected environment");
    return supervisor;
  };
  const environments = EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected registration"),
    registerPlatform: () => Effect.die("Unexpected registration"),
    reconcilePlatform: () => Effect.die("Unexpected reconciliation"),
    remove: () => Effect.die("Unexpected removal"),
    removeRelayEnvironments: () => Effect.die("Unexpected removal"),
    retryNow: () => Effect.void,
    setEnabled: () => Effect.die("Unexpected toggle"),
    state: (id) => SubscriptionRef.get(supervisorFor(id).state),
    stateChanges: (id) => SubscriptionRef.changes(supervisorFor(id).state),
    run: (id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisorFor(id)),
    runStream: (id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisorFor(id)),
    followStream: (id, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisorFor(id)),
  });
  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  return { registry, reads, writes, atoms: createProjectWorkEnvironmentAtoms(runtime) };
});

const awaitFoundationRead = Effect.fn(function* (
  registry: AtomRegistry.AtomRegistry,
  page: Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>,
) {
  const result = yield* AtomRegistry.toStream(registry, page).pipe(
    Stream.filter((value) => !AsyncResult.isInitial(value) && !value.waiting),
    Stream.take(1),
    Stream.runHead,
  );
  expect(Option.isSome(result) && AsyncResult.isSuccess(result.value)).toBe(true);
});

describe("foundation page transport", () => {
  it.effect("preserves opaque wire cursors and scopes page caches by environment and project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, atoms, reads } = yield* makeFoundationHarness();
        const cursor = " opaque?token=abc/def+ghi== ";
        const targets = [
          { environmentId, projectId, poll: false },
          { environmentId, projectId, cursor, poll: false },
          { environmentId: otherEnvironmentId, projectId, cursor, poll: false },
          { environmentId, projectId: ProjectId.make("other-project"), cursor, poll: false },
        ];
        for (const target of targets) {
          const atom = atoms.foundationPage(target);
          expect(atoms.foundationPage({ ...target })).toBe(atom);
          yield* awaitFoundationRead(registry, atom);
        }
        expect(reads).toEqual(
          targets.map((target) => ({
            environmentId: target.environmentId,
            input: {
              projectId: target.projectId,
              operation: "foundation-records",
              limit: 128,
              ...("cursor" in target ? { cursor } : {}),
            },
          })),
        );
        expect(atoms.foundationPage({ environmentId, projectId })).toBe(
          atoms.foundationPage({ environmentId, projectId, poll: true }),
        );
        expect(atoms.foundationPage({ environmentId, projectId })).not.toBe(
          atoms.foundationPage({ environmentId, projectId, poll: false }),
        );
      }),
    ),
  );

  it.effect(
    "sends guided write intents and refreshes every mounted page in the affected project",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { registry, atoms, reads, writes } = yield* makeFoundationHarness();
          const first = atoms.foundationPage({ environmentId, projectId, poll: false });
          const next = atoms.foundationPage({
            environmentId,
            projectId,
            cursor: "next",
            poll: false,
          });
          const other = atoms.foundationPage({
            environmentId: otherEnvironmentId,
            projectId,
            poll: false,
          });
          for (const page of [first, next, other]) {
            yield* AtomRegistry.mount(registry, page);
            yield* awaitFoundationRead(registry, page);
          }
          const target: ProjectWorkWriteTarget = {
            environmentId,
            input: {
              type: "project-team.gate.respond",
              commandId: CommandId.make("gate-response"),
              projectId,
              taskId: ProjectWorkTaskId.make("task-1"),
              expectedRevision: 3,
              expectedTaskRevision: 2,
              specRevision: 1,
              planRevision: 1,
              gateId: "gate-1",
              expectedGateRevision: 1,
              response: "approved",
            },
          };
          const result = yield* Effect.promise(() => atoms.write.run(registry, target));
          expect(AsyncResult.isSuccess(result)).toBe(true);
          for (const page of [first, next]) {
            yield* AtomRegistry.toStream(registry, page).pipe(
              Stream.filter(
                (value) =>
                  AsyncResult.isSuccess(value) &&
                  asProjectWorkFoundationPage(value.value, projectId)?.revision === 4,
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          }
          expect(writes).toEqual([target.input]);
          expect(reads.filter((read) => read.environmentId === environmentId)).toHaveLength(4);
          expect(reads.filter((read) => read.environmentId === otherEnvironmentId)).toHaveLength(1);
          expect(reads.at(-1)?.input).toMatchObject({
            operation: "foundation-records",
            limit: 128,
          });
          expect(
            reads.filter((read) => "cursor" in read.input).map((read) => read.input.cursor),
          ).toEqual(["next", "next"]);
        }),
      ),
  );

  it.effect("refreshes mounted foundation pages after a work stream marker", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, atoms, reads } = yield* makeFoundationHarness();
        const page = atoms.foundationPage({
          environmentId,
          projectId,
          cursor: "opaque",
          poll: false,
        });
        yield* AtomRegistry.mount(registry, page);
        yield* awaitFoundationRead(registry, page);
        yield* AtomRegistry.mount(registry, atoms.stream({ environmentId, projectId }));
        yield* AtomRegistry.toStream(registry, page).pipe(
          Stream.filter(
            (value) =>
              AsyncResult.isSuccess(value) &&
              asProjectWorkFoundationPage(value.value, projectId)?.revision === 4,
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        expect(reads).toHaveLength(2);
        expect(reads[1]?.input).toEqual({
          projectId,
          operation: "foundation-records",
          limit: 128,
          cursor: "opaque",
        });
      }),
    ),
  );
});
