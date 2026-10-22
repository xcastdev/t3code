import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type NetworkStatus,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SkillCatalogRevision,
  ManagedSkillKey,
  ThreadId,
  WS_METHODS,
  type SkillCatalogChanged,
  type SkillCatalogListInput,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";
import { createSkillsEnvironmentAtoms, makeSkillInvalidationSignals } from "./skills.ts";

describe("skill query invalidation signals", () => {
  it("refreshes installed-copy queries on provider changes from another client", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const query = signals.refresh(WS_METHODS.skillsDeploymentList, {
      environmentId,
      input: { providerInstanceId: ProviderInstanceId.make("codex") },
    });
    registry.mount(query);
    try {
      const before = registry.get(query);
      signals.publish(
        { environmentId, input: {} },
        {
          scope: "provider",
          scopeId: ProviderInstanceId.make("codex"),
          catalogRevision: SkillCatalogRevision.make(9),
          changedKeys: [ManagedSkillKey.make("review")],
        },
        registry,
      );
      expect(registry.get(query)).not.toBe(before);
    } finally {
      registry.dispose();
    }
  });
  it("refreshes application state for distinct domain events sharing one catalog revision", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const threadId = ThreadId.make("thread-a");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const target = { environmentId, input: { threadId, providerInstanceId } };
    const application = signals.refresh(WS_METHODS.skillsApplicationGet, target);
    registry.mount(application);
    try {
      const desired: SkillCatalogChanged = {
        scope: "session",
        scopeId: threadId,
        catalogRevision: SkillCatalogRevision.make(7),
        changedKeys: [ManagedSkillKey.make("review")],
        eventId: EventId.make("desired-7"),
      };
      signals.publish(target, desired, registry);
      const desiredSignal = registry.get(application);
      const received: SkillCatalogChanged = { ...desired, eventId: EventId.make("received-7") };
      signals.publish(target, received, registry);
      const receivedSignal = registry.get(application);
      expect(receivedSignal).not.toBe(desiredSignal);
      signals.publish(target, received, registry);
      expect(registry.get(application)).toBe(receivedSignal);
    } finally {
      registry.dispose();
    }
  });
  it("refreshes the affected project and thread without refreshing another project or authored content for session changes", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const projectId = ProjectId.make("project-a");
    const threadId = ThreadId.make("thread-a");
    const query = (tag: Parameters<typeof signals.refresh>[0], input: object) => {
      const atom = signals.refresh(tag, { environmentId, input });
      registry.mount(atom);
      return atom;
    };
    try {
      const project = query(WS_METHODS.skillsCatalogList, { projectId });
      const other = query(WS_METHODS.skillsCatalogList, { projectId: ProjectId.make("project-b") });
      const thread = query(WS_METHODS.skillsCatalogList, { threadId });
      const content = query(WS_METHODS.skillsContentGet, { projectId, skillId: "skill-a" });
      const history = query(WS_METHODS.skillsHistoryList, { skillId: "skill-a" });
      const before = [project, other, thread, content, history].map((atom) => registry.get(atom));
      signals.publish(
        { environmentId, input: { threadId } },
        {
          scope: "project",
          scopeId: projectId,
          catalogRevision: SkillCatalogRevision.make(1),
          changedKeys: [ManagedSkillKey.make("review")],
        },
        registry,
      );
      expect(registry.get(project)).not.toBe(before[0]);
      expect(registry.get(other)).toBe(before[1]);
      expect(registry.get(thread)).not.toBe(before[2]);
      expect(registry.get(content)).not.toBe(before[3]);
      expect(registry.get(history)).toBe(before[4]);
      const afterProject = registry.get(project);
      const afterContent = registry.get(content);
      const afterThread = registry.get(thread);
      signals.publish(
        { environmentId, input: { threadId } },
        {
          scope: "session",
          scopeId: threadId,
          catalogRevision: SkillCatalogRevision.make(2),
          changedKeys: [ManagedSkillKey.make("review")],
        },
        registry,
      );
      expect(registry.get(thread)).not.toBe(afterThread);
      expect(registry.get(project)).toBe(afterProject);
      expect(registry.get(content)).toBe(afterContent);
    } finally {
      registry.dispose();
    }
  });

  it("refreshes unfiltered and matching provider catalogs once per notice, keeping other providers and environments unchanged", () => {
    const registry = AtomRegistry.make();
    const signals = makeSkillInvalidationSignals();
    const environmentId = EnvironmentId.make("environment");
    const providerInstanceId = ProviderInstanceId.make("claude");
    const query = (input: SkillCatalogListInput, environment = environmentId) => {
      const atom = signals.refresh(WS_METHODS.skillsCatalogList, {
        environmentId: environment,
        input,
      });
      registry.mount(atom);
      return atom;
    };
    try {
      const all = query({});
      const matching = query({ providerInstanceId });
      const other = query({ providerInstanceId: ProviderInstanceId.make("codex") });
      const remote = query({}, EnvironmentId.make("other-environment"));
      const before = [all, matching, other, remote].map((atom) => registry.get(atom));
      const change: SkillCatalogChanged = {
        scope: "provider",
        scopeId: providerInstanceId,
        catalogRevision: SkillCatalogRevision.make(3),
        changedKeys: [ManagedSkillKey.make("review")],
      };
      signals.publish({ environmentId, input: {} }, change, registry);
      expect(registry.get(all)).not.toBe(before[0]);
      expect(registry.get(matching)).not.toBe(before[1]);
      expect(registry.get(other)).toBe(before[2]);
      expect(registry.get(remote)).toBe(before[3]);
      const after = registry.get(all);
      signals.publish({ environmentId, input: { providerInstanceId } }, change, registry);
      expect(registry.get(all)).toBe(after);
    } finally {
      registry.dispose();
    }
  });
});

it("refreshes application dependencies for authored changes while isolating other destinations", () => {
  const registry = AtomRegistry.make();
  const signals = makeSkillInvalidationSignals();
  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("project-a");
  const threadId = ThreadId.make("thread-a");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const target = { environmentId, input: { threadId, providerInstanceId } };
  const query = (input: object, environment = environmentId) => {
    const atom = signals.refresh(WS_METHODS.skillsApplicationGet, {
      environmentId: environment,
      input,
    });
    registry.mount(atom);
    return atom;
  };
  try {
    const application = query(target.input);
    const projectApplication = query({ projectId, providerInstanceId });
    const otherProject = query({ projectId: ProjectId.make("project-b"), providerInstanceId });
    const otherThread = query({ threadId: ThreadId.make("thread-b"), providerInstanceId });
    const otherProvider = query({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const remote = query(target.input, EnvironmentId.make("remote"));
    const atoms = [
      application,
      projectApplication,
      otherProject,
      otherThread,
      otherProvider,
      remote,
    ];
    const before = atoms.map((atom) => registry.get(atom));
    signals.publish(
      target,
      {
        scope: "project",
        scopeId: projectId,
        catalogRevision: SkillCatalogRevision.make(2),
        changedKeys: [ManagedSkillKey.make("review")],
      },
      registry,
    );
    expect(atoms.map((atom, i) => registry.get(atom) !== before[i])).toEqual([
      true,
      true,
      false,
      false,
      true,
      false,
    ]);
    const afterProject = atoms.map((atom) => registry.get(atom));
    signals.publish(
      target,
      {
        scope: "global",
        scopeId: environmentId,
        catalogRevision: SkillCatalogRevision.make(3),
        changedKeys: [ManagedSkillKey.make("review")],
      },
      registry,
    );
    expect(atoms.map((atom, i) => registry.get(atom) !== afterProject[i])).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    const afterGlobal = atoms.map((atom) => registry.get(atom));
    signals.publish(
      target,
      {
        scope: "provider",
        scopeId: providerInstanceId,
        catalogRevision: SkillCatalogRevision.make(4),
        changedKeys: [ManagedSkillKey.make("review")],
      },
      registry,
    );
    expect(atoms.map((atom, i) => registry.get(atom) !== afterGlobal[i])).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  } finally {
    registry.dispose();
  }
});

it("full destination notices refresh all applicable query tags and preserve destination isolation", () => {
  const registry = AtomRegistry.make();
  const signals = makeSkillInvalidationSignals();
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make("thread-a");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const target = { environmentId, input: { threadId, providerInstanceId } };
  const tags = [
    WS_METHODS.skillsCatalogList,
    WS_METHODS.skillsApplicationGet,
    WS_METHODS.skillsContentGet,
    WS_METHODS.skillsHistoryList,
    WS_METHODS.skillsDeploymentList,
    WS_METHODS.skillsNativeContentGet,
  ];
  const query = (
    tag: Parameters<typeof signals.refresh>[0],
    input: object,
    environment = environmentId,
  ) => {
    const atom = signals.refresh(tag, { environmentId: environment, input });
    registry.mount(atom);
    return atom;
  };
  try {
    const applicable = tags.map((tag) =>
      query(
        tag,
        tag === WS_METHODS.skillsHistoryList || tag === WS_METHODS.skillsNativeContentGet
          ? {}
          : target.input,
      ),
    );
    const isolated = [
      query(WS_METHODS.skillsCatalogList, { ...target.input, threadId: ThreadId.make("thread-b") }),
      query(WS_METHODS.skillsDeploymentList, {
        ...target.input,
        providerInstanceId: ProviderInstanceId.make("claude"),
      }),
      query(WS_METHODS.skillsContentGet, { projectId: ProjectId.make("project-b") }),
      query(WS_METHODS.skillsHistoryList, {}, EnvironmentId.make("remote")),
    ];
    const beforeIsolated = isolated.map((atom) => registry.get(atom));
    const notice = {
      scope: "session" as const,
      scopeId: threadId,
      catalogRevision: SkillCatalogRevision.make(7),
      changedKeys: [],
      eventId: EventId.make("initial"),
    };
    let before = applicable.map((atom) => registry.get(atom));
    for (const eventId of ["initial", "ack-1", "ack-2", "reconnect"]) {
      signals.publish(target, { ...notice, eventId: EventId.make(eventId) }, registry);
      expect(applicable.map((atom, i) => registry.get(atom) !== before[i])).toEqual(
        tags.map(() => true),
      );
      before = applicable.map((atom) => registry.get(atom));
    }
    signals.publish(target, { ...notice, eventId: EventId.make("reconnect") }, registry);
    expect(applicable.map((atom) => registry.get(atom))).toEqual(before);
    expect(isolated.map((atom) => registry.get(atom))).toEqual(beforeIsolated);
  } finally {
    registry.dispose();
  }
});

it("disposing one atom registry preserves another registry's full-refresh dependencies", () => {
  const signals = makeSkillInvalidationSignals();
  const target = { environmentId: EnvironmentId.make("local"), input: {} };
  const query = signals.refresh(WS_METHODS.skillsHistoryList, target);
  const first = AtomRegistry.make();
  const second = AtomRegistry.make();
  first.mount(query);
  second.mount(query);
  first.dispose();
  try {
    const before = second.get(query);
    signals.publish(
      target,
      {
        scope: "global",
        scopeId: "global",
        catalogRevision: SkillCatalogRevision.make(7),
        changedKeys: [],
        eventId: EventId.make("after-disposal"),
      },
      second,
    );
    expect(second.get(query)).not.toBe(before);
  } finally {
    second.dispose();
  }
});

it.effect("closes the last mounted catalog stream and remounts with current destination data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closed = yield* Queue.unbounded<unknown>();
      const observed = yield* Queue.unbounded<SkillCatalogChanged>();
      const starts: unknown[] = [];
      let active = 0;
      let revision = 1;
      const client = new Proxy({} as WsRpcProtocolClient, {
        get: (_target, method) => {
          if (method !== WS_METHODS.skillsCatalogSubscribe)
            throw new Error(`Unexpected fixture method ${String(method)}`);
          return (input: { readonly threadId: ThreadId }) =>
            Stream.unwrap(
              Effect.sync(() => {
                starts.push(input);
                active += 1;
                const notice: SkillCatalogChanged = {
                  scope: "session",
                  scopeId: input.threadId,
                  catalogRevision: SkillCatalogRevision.make(revision),
                  changedKeys: [],
                };
                return Stream.concat(Stream.succeed(notice), Stream.never).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      active -= 1;
                      Queue.offerUnsafe(closed, input);
                    }),
                  ),
                );
              }),
            );
        },
      });
      const rpcSession: RpcSession = {
        client,
        initialConfig: Effect.die("unused"),
        subscribeServerConfig: () => Stream.die("unused"),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const environmentId = EnvironmentId.make("local");
      const supervisor = EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "test",
          httpBaseUrl: "http://test",
          wsBaseUrl: "ws://test",
        }),
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(rpcSession)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const destinations: EnvironmentId[] = [];
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map());
      const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
      const runtime = Atom.runtime(
        Layer.mock(EnvironmentRegistry)({
          entries,
          networkStatus,
          followStream: (id, stream) => {
            destinations.push(id);
            return Stream.provideService(stream, EnvironmentSupervisor, supervisor);
          },
        }),
      );
      const queued: Array<() => void> = [];
      const flush = () => {
        for (let task = queued.shift(); task !== undefined; task = queued.shift()) task();
      };
      const registry = AtomRegistry.make({
        scheduleTask: (task) => {
          queued.push(task);
          queueMicrotask(flush);
          return () => undefined;
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const atoms = createSkillsEnvironmentAtoms(runtime);
      const input = {
        threadId: ThreadId.make("thread-a"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      };
      const atom = atoms.changes({ environmentId, input });
      const subscribe = (value: typeof atom) =>
        registry.subscribe(
          value,
          (result) => {
            if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(observed, result.value);
          },
          { immediate: true },
        );
      const first = subscribe(atom);
      expect((yield* Queue.take(observed)).catalogRevision).toBe(1);
      const second = subscribe(atom);
      expect((yield* Queue.take(observed)).catalogRevision).toBe(1);
      first();
      flush();
      expect(active).toBe(1);
      expect(starts).toEqual([input]);
      second();
      flush();
      // Check before awaiting the RPC finalizer so retained nodes fail without a timeout.
      expect(registry.getNodes().has(atom)).toBe(false);
      expect(yield* Queue.take(closed)).toEqual(input);
      expect(active).toBe(0);
      revision = 2;
      const remounted = subscribe(atom);
      expect((yield* Queue.take(observed)).catalogRevision).toBe(2);
      const nextInput = {
        threadId: ThreadId.make("thread-b"),
        providerInstanceId: ProviderInstanceId.make("claude"),
      };
      const nextEnvironment = EnvironmentId.make("remote");
      const next = atoms.changes({ environmentId: nextEnvironment, input: nextInput });
      const releaseNext = subscribe(next);
      expect((yield* Queue.take(observed)).scopeId).toBe(nextInput.threadId);
      expect(starts).toEqual([input, input, nextInput]);
      expect(destinations).toEqual([environmentId, environmentId, nextEnvironment]);
      releaseNext();
      flush();
      expect(registry.getNodes().has(next)).toBe(false);
      expect(yield* Queue.take(closed)).toEqual(nextInput);
      expect(active).toBe(1);
      expect(registry.getNodes().has(atom)).toBe(true);
      remounted();
      flush();
      expect(registry.getNodes().has(atom)).toBe(false);
      expect(yield* Queue.take(closed)).toEqual(input);
      expect(active).toBe(0);
    }),
  ),
);
