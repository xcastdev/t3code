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
import { WS_METHODS } from "@t3tools/contracts";
import type { ManagedTextResourceChanged } from "@t3tools/contracts";
import {
  EnvironmentId,
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceKey,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "@effect/vitest";

import {
  createManagedTextResourcesEnvironmentAtoms,
  makeManagedTextResourceInvalidationSignals,
} from "./managedTextResources.ts";

describe("managed text resource catalog invalidation", () => {
  it("refreshes the affected project and its thread across subscribed clients", () => {
    const registry = AtomRegistry.make();
    const signals = makeManagedTextResourceInvalidationSignals();
    const environmentId = EnvironmentId.make("environment-a");
    const projectId = ProjectId.make("project-a");
    const threadId = ThreadId.make("thread-a");
    const query = (input: Parameters<typeof signals.refresh>[0]["input"]) => {
      const atom = signals.refresh({ environmentId, input });
      registry.mount(atom);
      return atom;
    };
    try {
      const project = query({ projectId });
      const otherProject = query({ projectId: ProjectId.make("project-b") });
      const thread = query({ threadId });
      const before = [project, otherProject, thread].map((atom) => registry.get(atom));
      signals.publish(
        { environmentId, input: { threadId } },
        {
          scope: "project",
          scopeId: projectId,
          catalogRevision: ManagedTextResourceCatalogRevision.make(1),
          changedKeys: [{ kind: "snippet", key: ManagedTextResourceKey.make("review") }],
        },
        registry,
      );
      expect(registry.get(project)).not.toBe(before[0]);
      expect(registry.get(otherProject)).toBe(before[1]);
      expect(registry.get(thread)).not.toBe(before[2]);
    } finally {
      registry.dispose();
    }
  });
});

it("full thread notices refresh text content only within the subscription destination", () => {
  const registry = AtomRegistry.make();
  const signals = makeManagedTextResourceInvalidationSignals();
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make("thread-a");
  const target = { environmentId, input: { threadId } };
  const content = signals.refresh(target);
  const other = signals.refresh({ environmentId, input: { threadId: ThreadId.make("thread-b") } });
  const remote = signals.refresh({
    environmentId: EnvironmentId.make("remote"),
    input: { threadId },
  });
  registry.mount(content);
  registry.mount(other);
  registry.mount(remote);
  try {
    const beforeOther = [registry.get(other), registry.get(remote)];
    let before = registry.get(content);
    const notice = {
      scope: "thread" as const,
      scopeId: threadId,
      catalogRevision: ManagedTextResourceCatalogRevision.make(7),
      changedKeys: [],
    };
    for (let i = 0; i < 2; i++) {
      signals.publish(target, notice, registry);
      expect(registry.get(content)).not.toBe(before);
      before = registry.get(content);
    }
    expect([registry.get(other), registry.get(remote)]).toEqual(beforeOther);
  } finally {
    registry.dispose();
  }
});

it.effect("closes the last mounted catalog stream and remounts with current destination data", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const closed = yield* Queue.unbounded<unknown>();
      const observed = yield* Queue.unbounded<ManagedTextResourceChanged>();
      const starts: unknown[] = [];
      let active = 0;
      let revision = 1;
      const client = new Proxy({} as WsRpcProtocolClient, {
        get: (_target, method) => {
          if (method !== WS_METHODS.managedTextResourcesCatalogSubscribe)
            throw new Error(`Unexpected fixture method ${String(method)}`);
          return (input: { readonly threadId: ThreadId }) =>
            Stream.unwrap(
              Effect.sync(() => {
                starts.push(input);
                active += 1;
                const notice: ManagedTextResourceChanged = {
                  scope: "thread",
                  scopeId: input.threadId,
                  catalogRevision: ManagedTextResourceCatalogRevision.make(revision),
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
      const atoms = createManagedTextResourcesEnvironmentAtoms(runtime);
      const input = { threadId: ThreadId.make("thread-a") };
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
      const nextInput = { threadId: ThreadId.make("thread-b") };
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
