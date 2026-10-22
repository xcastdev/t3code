import { expect, it } from "@effect/vitest";
import {
  AuthTerminalOperateScope,
  EnvironmentId,
  ProjectId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
} from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createProjectTerminalEnvironmentAtoms } from "./projectTerminals.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const session = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthTerminalOperateScope] : [],
  permissions: allowed ? [AuthTerminalOperateScope] : [],
});

const makeRuntime = Effect.fn("test.makeRuntime")(function* (destination: EnvironmentId) {
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: destination,
      label: "test",
      httpBaseUrl: "http://test",
      wsBaseUrl: "ws://test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
  return Atom.runtime(
    Layer.mock(EnvironmentRegistry)({
      entries,
      networkStatus,
      run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    }),
  );
});

it.effect("drops attach and metadata streams as soon as the last viewer unmounts", () =>
  Effect.gen(function* () {
    const environmentId = EnvironmentId.make("destination");
    const terminals = createProjectTerminalEnvironmentAtoms(yield* makeRuntime(environmentId));
    // Queue the registry's deferred work so the test flushes it instead of waiting on a timer.
    const queued: Array<() => void> = [];
    const flush = () => {
      for (let task = queued.shift(); task !== undefined; task = queued.shift()) task();
    };
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        queued.push(task);
        return () => undefined;
      },
    });
    const projectId = ProjectId.make("project");
    const attach = terminals.attach({
      environmentId,
      input: { projectId, terminalId: "terminal" },
    });
    const metadata = terminals.metadata({ environmentId, input: projectId });
    try {
      for (const atom of [attach, metadata] as ReadonlyArray<Atom.Atom<unknown>>) {
        const release = registry.mount(atom);
        expect(registry.getNodes().has(atom)).toBe(true);
        release();
        flush();
        // A retained node would keep its RPC stream open for the default five minutes.
        expect(registry.getNodes().has(atom)).toBe(false);
      }
    } finally {
      registry.dispose();
    }
  }),
);

it.effect("guards project mutations using the actual destination environment", () =>
  Effect.gen(function* () {
    const destination = EnvironmentId.make("destination");
    const origin = EnvironmentId.make("origin");
    const runtime = yield* makeRuntime(destination);
    const terminals = createProjectTerminalEnvironmentAtoms(runtime);
    const registry = AtomRegistry.make();
    const releaseOrigin = registry.mount(sessions(origin));
    const releaseDestination = registry.mount(sessions(destination));
    const handle = {
      projectId: ProjectId.make("project"),
      terminalId: "terminal",
      expectedGeneration: "old-generation",
    };
    try {
      registry.set(sessions(origin), AsyncResult.success(session(true)));
      registry.set(sessions(destination), AsyncResult.success(session(false)));
      expect(registry.get(terminals.write.permissionAtom(origin))).toBe(true);
      expect(registry.get(terminals.write.permissionAtom(destination))).toBe(false);
      const writes = [
        terminals.write.run(registry, {
          environmentId: destination,
          input: { ...handle, data: "x" },
        }),
        terminals.resize.run(registry, {
          environmentId: destination,
          input: { ...handle, cols: 80, rows: 24 },
        }),
        terminals.kill.run(registry, { environmentId: destination, input: handle }),
      ];
      for (const result of yield* Effect.promise(() => Promise.all(writes))) {
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthTerminalOperateScope,
          });
      }
      registry.set(sessions(destination), AsyncResult.success(session(true)));
      expect(registry.get(terminals.write.permissionAtom(destination))).toBe(true);
      expect(registry.get(terminals.resize.permissionAtom(destination))).toBe(true);
      expect(registry.get(terminals.kill.permissionAtom(destination))).toBe(true);
    } finally {
      releaseDestination();
      releaseOrigin();
      registry.dispose();
    }
  }),
);
