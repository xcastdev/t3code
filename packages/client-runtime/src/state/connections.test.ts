import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentCatalogAtoms, waitForEnvironmentConnection } from "./connections.ts";

const ENVIRONMENT_ID = EnvironmentId.make("catalog-environment");

const connectionState = (
  overrides: Partial<SupervisorConnectionState>,
): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  ...overrides,
});

const makeCatalogHarness = Effect.fn("TestCatalog.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make(
    connectionState({ phase: "connected", attempt: 1, generation: 1 }),
  );
  const session = yield* SubscriptionRef.make(Option.some({} as RpcSession.RpcSession));
  const supervisor = {
    state,
    session,
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const catalog = createEnvironmentCatalogAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
  );
  const atom = catalog.sessionGenerationAtom(ENVIRONMENT_ID);
  const atoms = AtomRegistry.make();
  const unmount = atoms.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      atoms.dispose();
    }),
  );
  yield* Effect.yieldNow;
  /** Moves the supervisor to `next`, with a new session object when one is established. */
  const generationAfter = (
    next: SupervisorConnectionState,
    nextSession: Option.Option<RpcSession.RpcSession> = Option.none(),
  ) =>
    SubscriptionRef.set(session, nextSession).pipe(
      Effect.andThen(SubscriptionRef.set(state, next)),
      Effect.andThen(Effect.yieldNow),
      Effect.map(() => atoms.get(atom)),
    );
  return { generation: () => atoms.get(atom), generationAfter };
});

const lastFailure = new ConnectionTransientError({ reason: "transport", detail: "Down." });
const newSession = () => Option.some({} as RpcSession.RpcSession);

describe("environment catalog atoms", () => {
  it.effect("changes the session generation only when a new session comes up", () =>
    Effect.gen(function* () {
      const { generation, generationAfter } = yield* makeCatalogHarness();
      const first = generation();
      // A retry reports the generation it is attempting before it is established.
      expect(
        yield* generationAfter(
          connectionState({ phase: "connecting", stage: "opening", generation: 2, lastFailure }),
        ),
      ).toBe(first);
      expect(
        yield* generationAfter(
          connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
        ),
      ).toBe(first);
      expect(
        yield* generationAfter(
          connectionState({ phase: "connected", attempt: 2, generation: 2 }),
          newSession(),
        ),
      ).not.toBe(first);
    }),
  );

  it.effect("changes when a replaced supervisor's first session reuses an old generation", () =>
    Effect.gen(function* () {
      const { generation, generationAfter } = yield* makeCatalogHarness();
      const first = generation();
      yield* generationAfter(
        connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
      );
      // Re-pairing or editing a route installs a new supervisor, whose counter starts over.
      yield* generationAfter(connectionState({ phase: "available", generation: 0 }));
      expect(
        yield* generationAfter(
          connectionState({ phase: "connected", attempt: 1, generation: 1 }),
          newSession(),
        ),
      ).not.toBe(first);
    }),
  );
});

describe("waitForEnvironmentConnection", () => {
  it.each([
    { name: "already connected", start: "connected", then: undefined, settles: true },
    { name: "connected later", start: "connecting", then: "connected", settles: true },
    {
      name: "offline, so a request fails at once",
      start: "offline",
      then: undefined,
      settles: true,
    },
    { name: "blocked", start: "blocked", then: undefined, settles: true },
    // A supervisor state, unlike the atom's placeholder: the environment is not trying to connect.
    { name: "available but not connecting", start: "available", then: undefined, settles: true },
    {
      name: "its next retry is after the deadline",
      start: "backoff",
      retryAt: 60_000,
      then: undefined,
      settles: true,
    },
    {
      name: "still connecting when the wait runs out",
      start: "backoff",
      then: undefined,
      settles: false,
    },
  ] as const)("resolves when $name", async (row) => {
    vi.useFakeTimers({ now: 0 });
    try {
      const retryAt = "retryAt" in row ? row.retryAt : null;
      const state = (phase: SupervisorConnectionState["phase"]) =>
        AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase, retryAt });
      const registry = AtomRegistry.make();
      const atom = Atom.make(state(row.start));
      let resolved = false;
      const waited = waitForEnvironmentConnection(registry, atom, 10_000).then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(row.start !== "connecting" && row.settles);
      if (row.then !== undefined) registry.set(atom, state(row.then));
      if (!row.settles) await vi.advanceTimersByTimeAsync(10_000);
      await waited;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits through the atom's placeholder until the supervisor reports", async () => {
    vi.useFakeTimers();
    try {
      const registry = AtomRegistry.make();
      const atom = Atom.make(AsyncResult.success(AVAILABLE_CONNECTION_STATE));
      let resolved = false;
      const waited = waitForEnvironmentConnection(registry, atom, 10_000).then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      registry.set(
        atom,
        AsyncResult.success({ ...AVAILABLE_CONNECTION_STATE, phase: "connected" }),
      );
      await waited;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
