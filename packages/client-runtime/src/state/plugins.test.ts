import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PluginId,
  WS_METHODS,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createPluginEnvironmentAtoms } from "./plugins.ts";

it.effect("stops following a subscription once it closes, so a reconnect does not revive it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("plugins");
      let subscribes = 0;
      const client = new Proxy({} as WsRpcProtocolClient, {
        get: (_target, method) => {
          if (method !== WS_METHODS.pluginsSubscribe)
            throw new Error(`Unexpected ${String(method)}`);
          return () =>
            Stream.suspend(() => {
              subscribes += 1;
              return Stream.concat(
                Stream.make<ReadonlyArray<PluginSubscriptionEvent>>(
                  { type: "snapshot", items: [], revision: "1", cursor: null },
                  { type: "closed", reason: "plugin-disabled" },
                ),
                Stream.never,
              );
            });
        },
      });
      const makeSession = (): RpcSession => ({
        client,
        inboundFrames: Effect.succeed(0),
        initialConfig: Effect.die("unused"),
        subscribeServerConfig: () => Stream.die("unused"),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      });
      const session = yield* SubscriptionRef.make(Option.some(makeSession()));
      const supervisor = EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Plugins",
          httpBaseUrl: "http://test",
          wsBaseUrl: "ws://test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
          desired: true,
        }),
        session,
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const runtime = Atom.runtime(
        Layer.mock(EnvironmentRegistry)({
          entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
            new Map(),
          ),
          networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        }),
      );
      const atoms = createPluginEnvironmentAtoms(runtime);
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const delivered = yield* Queue.unbounded<PluginSubscriptionEvent["type"]>();
      atoms.events(
        registry,
        { environmentId, input: { pluginId: PluginId.make("echo"), topic: "ticks", params: null } },
        (event) => Queue.offerUnsafe(delivered, event.type),
        () => Queue.offerUnsafe(delivered, "closed"),
      );

      expect(yield* Queue.take(delivered)).toBe("snapshot");
      expect(yield* Queue.take(delivered)).toBe("closed");
      yield* SubscriptionRef.set(session, Option.some(makeSession()));
      yield* Effect.yieldNow;

      expect(subscribes).toBe(1);
      expect(yield* Queue.size(delivered)).toBe(0);
    }),
  ),
);
