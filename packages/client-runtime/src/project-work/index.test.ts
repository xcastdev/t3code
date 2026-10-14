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
  asProjectWorkVerificationJob,
  asProjectTeamSupervisionSummary,
  asProjectTeamBindingAccounting,
  projectTeamAccountingCaptions,
  projectTeamSupervisionAvailable,
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
  it("normalizes monitored overshoot and captions threshold headroom without a hard output promise", () => {
    const owner = {
      projectId: ProjectId.make("project"),
      recordId: "binding",
      generation: 1,
      taskId: "task",
      attemptId: "attempt",
      environmentId: EnvironmentId.make("environment"),
    };
    const policy = {
      accountingMode: "openai-subscription-monitored",
      thresholdTokens: 64_000 as const,
      observedChargedTokens: 80_384,
      nominalHeldTokens: 0,
      stoppedReason: "threshold-reached",
    } as const;
    const accounting = {
      availability: "available" as const,
      projectId: ProjectId.make("project"),
      environmentId: EnvironmentId.make("environment"),
      bindingId: "binding",
      generation: 1,
      taskId: "task",
      attemptId: "attempt",
      observedAt: "2026-10-01T00:00:00.000Z",
      root: {
        taskId: "root",
        maximumTokens: 64_000,
        deadlineAtMs: 2_000,
        chargedTokens: 80_384,
        reservedTokens: 0,
        unknownChargedTokens: 0,
        remainingTokens: 0,
        heldCalls: 0,
        quarantinedCalls: 0,
        policy,
      },
      attempt: {
        maximumTokens: 64_000,
        deadlineAtMs: 2_000,
        chargedTokens: 80_384,
        reservedTokens: 0,
        unknownChargedTokens: 0,
        remainingTokens: 0,
        heldCalls: 0,
        quarantinedCalls: 0,
        policy,
      },
    };
    const normalized = asProjectTeamBindingAccounting(accounting, owner);
    expect(normalized).toEqual(accounting);
    const captions = projectTeamAccountingCaptions(normalized).join(" ");
    expect(captions).toContain("80,384 charged");
    expect(captions).toContain("Monitored stopping threshold: 64,000 tokens");
    expect(captions).toContain("not a hard upstream output limit");
    const { policy: _rootPolicy, ...root } = accounting.root;
    const { policy: _attemptPolicy, ...attempt } = accounting.attempt;
    void _rootPolicy;
    void _attemptPolicy;
    const hard = {
      ...accounting,
      root: { ...root, chargedTokens: 100, remainingTokens: 63_900 },
      attempt: { ...attempt, chargedTokens: 100, remainingTokens: 63_900 },
    };
    expect(asProjectTeamBindingAccounting(hard, owner)).toEqual(hard);
  });

  it("rejects monitored policy counters that do not match the recorded scope", () => {
    const owner = {
      projectId: ProjectId.make("project"),
      recordId: "binding",
      generation: 1,
      taskId: "task",
      attemptId: "attempt",
      environmentId: EnvironmentId.make("environment"),
    };
    const scope = {
      maximumTokens: 64_000,
      deadlineAtMs: 2_000,
      chargedTokens: 80_384,
      reservedTokens: 0,
      unknownChargedTokens: 0,
      remainingTokens: 0,
      heldCalls: 0,
      quarantinedCalls: 0,
      policy: {
        accountingMode: "openai-subscription-monitored" as const,
        thresholdTokens: 64_000 as const,
        observedChargedTokens: 80_383,
        nominalHeldTokens: 0,
      },
    };
    expect(
      asProjectTeamBindingAccounting(
        {
          availability: "available" as const,
          projectId: ProjectId.make("project"),
          environmentId: EnvironmentId.make("environment"),
          bindingId: "binding",
          generation: 1,
          taskId: "task",
          attemptId: "attempt",
          observedAt: "2026-10-01T00:00:00.000Z",
          root: { taskId: "root", ...scope },
          attempt: scope,
        },
        owner,
      ),
    ).toBeUndefined();
  });

  it("uses charged usage alone for monitored headroom and keeps hard reservations conservative", () => {
    const owner = {
      projectId: ProjectId.make("project"),
      recordId: "binding",
      generation: 1,
      taskId: "task",
      attemptId: "attempt",
      environmentId: EnvironmentId.make("environment"),
    };
    const identity = {
      projectId: ProjectId.make("project"),
      environmentId: EnvironmentId.make("environment"),
      bindingId: "binding",
      generation: 1,
      taskId: "task",
      attemptId: "attempt",
      observedAt: "2026-10-01T00:00:00.000Z",
    };
    const monitoredScope = {
      maximumTokens: 64_000,
      deadlineAtMs: 2_000,
      chargedTokens: 55_000,
      reservedTokens: 18_432,
      unknownChargedTokens: 0,
      remainingTokens: 9_000,
      heldCalls: 1,
      quarantinedCalls: 0,
      policy: {
        accountingMode: "openai-subscription-monitored" as const,
        thresholdTokens: 64_000 as const,
        observedChargedTokens: 55_000,
        nominalHeldTokens: 18_432,
      },
    };
    const monitored = {
      availability: "available" as const,
      ...identity,
      root: { taskId: "root", ...monitoredScope },
      attempt: monitoredScope,
    };
    expect(asProjectTeamBindingAccounting(monitored, owner)).toEqual(monitored);
    expect(projectTeamAccountingCaptions(monitored).join(" ")).toContain(
      "18,432 held; 9,000/64,000 threshold headroom",
    );

    const hardScope = {
      maximumTokens: 64_000,
      deadlineAtMs: 2_000,
      chargedTokens: 10_000,
      reservedTokens: 18_432,
      unknownChargedTokens: 0,
      remainingTokens: 35_568,
      heldCalls: 1,
      quarantinedCalls: 0,
    };
    const hard = {
      availability: "available" as const,
      ...identity,
      root: { taskId: "root", ...hardScope },
      attempt: hardScope,
    };
    expect(asProjectTeamBindingAccounting(hard, owner)).toEqual(hard);
    expect(projectTeamAccountingCaptions(hard).join(" ")).toContain(
      "18,432 held; 35,568/64,000 tokens remaining",
    );
  });

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
  it("merges independent accounting at the same revision without changing foundation eligibility", () => {
    const binding = {
      projectId,
      recordId: "binding",
      revision: 2,
      generation: 0,
      updatedAt: "2026-10-01T00:00:00.000Z",
      kind: "run-binding",
      status: "settled",
      taskId: "task",
      attemptId: "attempt",
      memberId: "member",
      roleRevisionId: "role",
      providerInstanceId: "pi",
      threadId: "thread",
      environmentId: "environment",
      model: "frozen",
      configuration: {
        instructionsHash: "hash",
        toolIds: [],
        skillIds: [],
        runtimeVersion: "1",
        maxTokens: 1000,
        maxDurationMs: 1000,
        paidFallback: false,
      },
      worktree: "/workspace",
      branch: "task",
      leaseGeneration: 0,
      specRevision: 1,
      planRevision: 1,
    };
    const usage = {
      availability: "available",
      projectId,
      environmentId: "environment",
      bindingId: "binding",
      generation: 0,
      taskId: "task",
      attemptId: "attempt",
      observedAt: "2026-10-01T00:00:00.000Z",
      root: {
        taskId: "root",
        maximumTokens: 1000,
        deadlineAtMs: 2000,
        chargedTokens: 200,
        reservedTokens: 50,
        unknownChargedTokens: 40,
        remainingTokens: 750,
        heldCalls: 1,
        quarantinedCalls: 1,
      },
      attempt: {
        maximumTokens: 400,
        deadlineAtMs: 1500,
        chargedTokens: 150,
        reservedTokens: 10,
        unknownChargedTokens: 40,
        remainingTokens: 240,
        heldCalls: 1,
        quarantinedCalls: 1,
      },
    };
    const value = {
      projectId,
      revision: 3,
      items: [{ ...binding, payload: "future data" }],
      accounting: [usage],
    };
    const read = (accounting: unknown) =>
      combineProjectWorkFoundationPages({
        projectId,
        pages: [{ value: { ...value, accounting } }],
      });
    expect(read([usage])).toMatchObject({
      complete: true,
      revision: 3,
      error: null,
      records: [binding],
      accounting: [usage],
    });
    expect(read([usage]).records[0]).not.toHaveProperty("payload");
    const changed = {
      ...usage,
      observedAt: "2026-10-01T00:01:00.000Z",
      root: { ...usage.root, chargedTokens: 210, remainingTokens: 740 },
    };
    expect(read([changed])).toMatchObject({
      complete: true,
      revision: 3,
      records: [binding],
      accounting: [changed],
    });
    for (const accounting of [
      "malformed",
      [{ ...usage, generation: 1 }],
      [{ ...usage, projectId: "foreign" }],
      [{ ...usage, environmentId: "foreign" }],
      [{ ...usage, attempt: { ...usage.attempt, unknownChargedTokens: 151 } }],
    ]) {
      const result = read(accounting);
      expect(result).toMatchObject({
        complete: true,
        revision: 3,
        error: null,
        records: [binding],
      });
      expect(result.accounting).toBeUndefined();
    }
  });

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

const supervisionSummary = (owner = projectId) => ({
  projectId: owner,
  availability: "available",
  revision: 20,
  taskCounts: {
    draft: 0,
    specified: 0,
    ready: 1,
    "in-progress": 0,
    blocked: 0,
    "in-review": 0,
    completed: 0,
    failed: 0,
    canceled: 0,
    unknown: 0,
    total: 1,
  },
  missions: { items: [], hasMore: false },
  bindings: { items: [], hasMore: false },
  blockers: { items: [], hasMore: false },
  questions: { items: [], hasMore: false },
});

describe("supervision snapshot bounds and compatibility", () => {
  it.each([undefined, false])("never probes a server with capability %s", (capability) => {
    expect(
      projectTeamSupervisionAvailable({ enabled: true, capability, connectionPhase: "connected" }),
    ).toBe(false);
  });
  it.each(["available", "offline", "connecting", "backoff", "blocked"])(
    "never probes a %s environment",
    (connectionPhase) => {
      expect(
        projectTeamSupervisionAvailable({ enabled: true, capability: true, connectionPhase }),
      ).toBe(false);
    },
  );
  it("requires the enabled feature and an affirmative connected capability", () => {
    expect(
      projectTeamSupervisionAvailable({
        enabled: false,
        capability: true,
        connectionPhase: "connected",
      }),
    ).toBe(false);
    expect(
      projectTeamSupervisionAvailable({
        enabled: true,
        capability: true,
        connectionPhase: "connected",
      }),
    ).toBe(true);
  });
  it("decodes an exact-owner summary while removing unselected body/config fields", () => {
    const summary = supervisionSummary();
    expect(
      asProjectTeamSupervisionSummary(
        { ...summary, body: "private", configuration: { token: "private" } },
        projectId,
      ),
    ).toEqual(summary);
    expect(
      asProjectTeamSupervisionSummary(supervisionSummary(ProjectId.make("foreign")), projectId),
    ).toBeNull();
    expect(
      asProjectTeamSupervisionSummary({ ...summary, projectId: ` ${projectId} ` }, projectId),
    ).toBeNull();
  });
  it.each(["missing", "deleted", "archived", "tombstoned", "unsupported"])(
    "preserves %s availability without records",
    (availability) => {
      expect(
        asProjectTeamSupervisionSummary({ ...supervisionSummary(), availability }, projectId),
      ).toEqual({ projectId, availability });
    },
  );
  it("rejects invalid, overflowing and inconsistent counts", () => {
    for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      const summary = supervisionSummary();
      expect(
        asProjectTeamSupervisionSummary(
          { ...summary, taskCounts: { ...summary.taskCounts, ready: count } },
          projectId,
        ),
      ).toBeNull();
    }
    const summary = supervisionSummary();
    expect(
      asProjectTeamSupervisionSummary(
        { ...summary, taskCounts: { ...summary.taskCounts, total: 2 } },
        projectId,
      ),
    ).toBeNull();
  });
  it("rejects a future or repeated physical metadata identity", () => {
    const mission = {
      recordId: "mission",
      revision: 20,
      generation: 0,
      status: "future-status",
      supported: false,
      title: "Mission",
    };
    const summary = supervisionSummary();
    expect(
      asProjectTeamSupervisionSummary(
        { ...summary, missions: { items: [mission], hasMore: true } },
        projectId,
      ),
    ).toMatchObject({ missions: { items: [mission], hasMore: true } });
    expect(
      asProjectTeamSupervisionSummary(
        { ...summary, missions: { items: [{ ...mission, revision: 21 }], hasMore: false } },
        projectId,
      ),
    ).toBeNull();
    expect(
      asProjectTeamSupervisionSummary(
        { ...summary, missions: { items: [mission, mission], hasMore: false } },
        projectId,
      ),
    ).toBeNull();
  });
  it("rejects foreign profile revision even when a binding is bounded", () => {
    const summary = supervisionSummary();
    const profile = {
      recordId: "role",
      revision: 21,
      generation: 0,
      status: "available",
      supported: true,
      roleId: "role",
      roleRevision: 1,
      role: "implementer",
      model: "profile-model",
    };
    expect(
      asProjectTeamSupervisionSummary(
        {
          ...summary,
          coordinator: {
            recordId: "coordinator",
            revision: 20,
            generation: 0,
            status: "active",
            supported: true,
            name: "Coordinator",
            roleRevisionId: "role",
            profile,
          },
        },
        projectId,
      ),
    ).toBeNull();
  });
  it.effect("disabled or unsupported atom mounts perform no transport reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, atoms, reads } = yield* makeFoundationHarness();
        for (const state of [
          { enabled: true, capability: undefined, connectionPhase: "connected" },
          { enabled: true, capability: false, connectionPhase: "connected" },
          { enabled: false, capability: true, connectionPhase: "connected" },
          { enabled: true, capability: true, connectionPhase: "offline" },
        ]) {
          const atom = atoms.supervision({ environmentId, projectId, ...state });
          const unmount = registry.mount(atom);
          expect(AsyncResult.isInitial(registry.get(atom))).toBe(true);
          unmount();
        }
        expect(reads).toEqual([]);
      }),
    ),
  );
  it.effect("enabled reads keep environment/project cache identity and bounded operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { registry, atoms, reads } = yield* makeFoundationHarness();
        const state = {
          enabled: true,
          capability: true,
          connectionPhase: "connected",
          poll: false,
        };
        const targets = [
          { environmentId, projectId, ...state },
          { environmentId: otherEnvironmentId, projectId, ...state },
          { environmentId, projectId: ProjectId.make("second-project"), ...state },
        ];
        for (const target of targets) {
          const atom = atoms.supervision(target);
          expect(atoms.supervision({ ...target })).toBe(atom);
          yield* awaitFoundationRead(registry, atom);
        }
        expect(reads).toEqual(
          targets.map((target) => ({
            environmentId: target.environmentId,
            input: { projectId: target.projectId, operation: "supervision" },
          })),
        );
        expect(atoms.supervision({ ...targets[0]!, poll: true })).not.toBe(
          atoms.supervision(targets[0]!),
        );
      }),
    ),
  );
});

describe("verification preview transport", () => {
  it.effect(
    "addresses exact task/job previews without reusing another environment or job cache",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { registry, atoms, reads } = yield* makeFoundationHarness();
          const targets = [
            {
              environmentId,
              projectId,
              taskId: ProjectWorkTaskId.make("task-1"),
              verificationJobId: "job-1",
            },
            {
              environmentId: otherEnvironmentId,
              projectId,
              taskId: ProjectWorkTaskId.make("task-1"),
              verificationJobId: "job-1",
            },
            {
              environmentId,
              projectId,
              taskId: ProjectWorkTaskId.make("task-1"),
              verificationJobId: "job-2",
            },
            {
              environmentId,
              projectId,
              taskId: ProjectWorkTaskId.make("task-2"),
              verificationJobId: "job-1",
            },
          ];
          const previews = targets.map((target) => atoms.verificationJob(target));
          expect(new Set(previews).size).toBe(4);
          for (const [index, target] of targets.entries()) {
            const atom = previews[index]!;
            expect(atoms.verificationJob({ ...target })).toBe(atom);
            yield* awaitFoundationRead(registry, atom);
          }
          expect(reads).toEqual(
            targets.map(({ environmentId, ...input }) => ({
              environmentId,
              input: { ...input, operation: "verification-job" },
            })),
          );
        }),
      ),
  );
});

const previewManifest = {
  version: 1,
  jobId: "verification-1",
  environmentId: "environment-1",
  projectId: "project-1",
  taskId: "task-1",
  specRevision: 2,
  specificationHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  planRevision: 3,
  planHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  criteria: [
    {
      criterionId: "criterion-1",
      revision: 3,
    },
  ],
  dispatchId: "original-implementation",
  bindingId: "binding",
  generation: 7,
  workspaceReceiptHash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  command: {
    executable: "/opt/project tools/test runner",
    argv: ["", "  preserved  ", "--filter", "$(literal); *", "line\nbreak"],
    limits: {
      maxDurationMs: 120000,
      maxOutputBytes: 65536,
    },
    environment: "clean",
  },
  target: {
    repository: "/project",
    worktree: "/project-worktree",
    branchRef: "refs/heads/assigned",
    baseSha: "dddddddddddddddddddddddddddddddddddddddd",
    headSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    testedCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    testedTree: "ffffffffffffffffffffffffffffffffffffffff",
    workspaceState: "clean-committed",
  },
  executable: {
    target: "/opt/project tools/test runner",
    sha256: "1111111111111111111111111111111111111111111111111111111111111111",
    runtimeClosureSha256: "2222222222222222222222222222222222222222222222222222222222222222",
  },
};
const preview = {
  kind: "verification-job",
  manifest: previewManifest,
  sha256: "8f6827b531a1084ce0856362ce0ee9058c8c86187d2c9974fdcb99d812e56cd9",
};

it("keeps only bounded exact immutable previews for the selected environment, project, task and job", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    taskId: ProjectWorkTaskId.make("task-1"),
    verificationJobId: "verification-1",
  };
  expect(asProjectWorkVerificationJob(preview, target)).toEqual(preview);
  for (const manifest of [
    { ...previewManifest, environmentId: "foreign" },
    { ...previewManifest, projectId: "foreign" },
    { ...previewManifest, taskId: "foreign" },
    { ...previewManifest, jobId: "foreign" },
    { ...previewManifest, taskId: " task-1 " },
    { ...previewManifest, version: 2 },
    { ...previewManifest, criteria: Array(65).fill(previewManifest.criteria[0]) },
    { ...previewManifest, command: { ...previewManifest.command, env: { TOKEN: "secret" } } },
  ])
    expect(asProjectWorkVerificationJob({ ...preview, manifest }, target)).toBeNull();
  expect(asProjectWorkVerificationJob({ ...preview, sha256: "not-a-hash" }, target)).toBeNull();
  const path = "/" + "界".repeat(4095);
  expect(
    asProjectWorkVerificationJob(
      {
        ...preview,
        manifest: {
          ...previewManifest,
          target: { ...previewManifest.target, repository: path, worktree: path },
          command: {
            ...previewManifest.command,
            executable: path,
            argv: Array(4).fill("x".repeat(4096)),
          },
          executable: { ...previewManifest.executable, target: path },
        },
      },
      target,
    ),
  ).toBeNull();
});
