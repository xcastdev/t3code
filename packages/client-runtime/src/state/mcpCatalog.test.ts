import { describe, expect, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  WS_METHODS,
  type McpCatalogSnapshot,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
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
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { createMcpCatalogEnvironmentAtoms } from "./mcpCatalog.ts";
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

import { isCurrentMcpCatalogDraft, mcpCatalogScopeKey } from "./mcpCatalog.ts";

describe("catalog editor destination", () => {
  const target = {
    environmentId: EnvironmentId.make("first"),
    scope: "project" as const,
    scopeId: "project",
    revision: 3,
  };

  it("rejects a draft after switching environments, scopes or revisions", () => {
    expect(isCurrentMcpCatalogDraft(target, { ...target })).toBe(true);
    for (const changed of [
      { ...target, environmentId: EnvironmentId.make("second") },
      { ...target, scope: "session" as const },
      { ...target, scopeId: "other-project" },
      { ...target, revision: 4 },
    ])
      expect(isCurrentMcpCatalogDraft(changed, target)).toBe(false);
  });

  it("keeps coincident IDs and delimiter-bearing scope IDs separate", () => {
    expect(mcpCatalogScopeKey({ ...target, scopeId: "a:project:b" })).not.toBe(
      mcpCatalogScopeKey({
        ...target,
        environmentId: EnvironmentId.make("first:project:a"),
        scopeId: "b",
      }),
    );
  });
});

it.effect(
  "keeps mounted session editor revisions live across rebind, remote writes, and OAuth without reconnect loops",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("live-catalog");
        const threadId = ThreadId.make("thread");
        const updates = yield* Queue.unbounded<{ readonly snapshot: McpCatalogSnapshot | null }>();
        const observed = yield* Queue.unbounded<{ readonly snapshot: McpCatalogSnapshot | null }>();
        const closed = yield* Deferred.make<void>();
        let active = 0;
        let starts = 0;
        let closing = false;
        let current: { readonly snapshot: McpCatalogSnapshot | null } = { snapshot: null };
        // The fixture owns only the session view, editor reads, and OAuth methods.
        const client = new Proxy({} as WsRpcProtocolClient, {
          get: (_target, method) => {
            if (method === WS_METHODS.mcpCatalogSessionSubscribeForThread)
              return () =>
                Stream.unwrap(
                  Effect.sync(() => {
                    active += 1;
                    starts += 1;
                    return Stream.concat(Stream.succeed(current), Stream.fromQueue(updates)).pipe(
                      Stream.ensuring(
                        Effect.sync(() => {
                          active -= 1;
                          if (closing) Deferred.doneUnsafe(closed, Exit.void);
                        }),
                      ),
                    );
                  }),
                );
            if (method === WS_METHODS.mcpCatalogRead)
              return () =>
                Effect.sync(() => ({
                  revision: current.snapshot?.desiredRevision ?? 0,
                  definitions: current.snapshot?.desired ?? [],
                  overrides: [],
                  snapshot: current.snapshot ?? undefined,
                }));
            if (method === WS_METHODS.mcpCatalogSessionGet)
              return () =>
                Effect.sync(() => {
                  if (current.snapshot === null) throw new Error("No session in read fixture");
                  return current.snapshot;
                });
            if (
              method === WS_METHODS.mcpCatalogOAuthContinue ||
              method === WS_METHODS.mcpCatalogOAuthDisconnect
            )
              return () => Effect.void;
            throw new Error(`Unexpected fixture method ${String(method)}`);
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
        const supervisor = EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Catalog",
            httpBaseUrl: "http://test",
            wsBaseUrl: "ws://test",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
            desired: true,
          }),
          session: yield* SubscriptionRef.make(Option.some(rpcSession)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const entries = yield* SubscriptionRef.make<
          ReadonlyMap<EnvironmentId, import("../connection/catalog.ts").ConnectionCatalogEntry>
        >(new Map());
        const networkStatus =
          yield* SubscriptionRef.make<import("../connection/model.ts").NetworkStatus>("online");
        const runtime = Atom.runtime(
          Layer.mock(EnvironmentRegistry)({
            entries,
            networkStatus,
            run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
            followStream: (_id, stream) =>
              Stream.provideService(stream, EnvironmentSupervisor, supervisor),
          }),
        );
        const atoms = createMcpCatalogEnvironmentAtoms(runtime);
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        const releaseSession = registry.mount(sessions(environmentId));
        yield* Effect.addFinalizer(() => Effect.sync(releaseSession));
        registry.set(
          sessions(environmentId),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: [AuthSettingsWriteScope],
            permissions: [AuthSettingsWriteScope],
          }),
        );
        const atom = atoms.sessionForThread({ environmentId, input: { threadId } });
        const release = registry.subscribe(
          atom,
          (result) => {
            if (AsyncResult.isSuccess(result)) Queue.offerUnsafe(observed, result.value);
          },
          { immediate: true },
        );
        expect(yield* Queue.take(observed)).toEqual({ snapshot: null });
        const materialized: McpCatalogSnapshot = {
          catalogSessionId: McpCatalogSessionId.make("session"),
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          baseline: [],
          desired: [],
          applied: [],
          desiredRevision: 1,
          appliedRevision: 0,
          application: {
            status: "restart-required",
            revision: 1,
            failedAt: "2026-01-01T00:00:00Z",
            reason: "Restart",
          },
        };
        current = { snapshot: materialized };
        yield* Queue.offer(updates, current);
        expect(yield* Queue.take(observed)).toEqual(current);
        const reads = yield* Queue.unbounded<number>();
        const gets = yield* Queue.unbounded<number>();
        const read = atoms.read({
          environmentId,
          input: { scope: "session", scopeId: materialized.catalogSessionId },
        });
        const get = atoms.sessionGet({
          environmentId,
          input: { threadId, mcpCatalogSessionId: materialized.catalogSessionId },
        });
        let lastRead = -1;
        let lastGet = -1;
        const releaseRead = registry.subscribe(
          read,
          (result) => {
            if (
              AsyncResult.isSuccess(result) &&
              !result.waiting &&
              result.value.revision !== lastRead
            ) {
              lastRead = result.value.revision;
              Queue.offerUnsafe(reads, lastRead);
            }
          },
          { immediate: true },
        );
        const releaseGet = registry.subscribe(
          get,
          (result) => {
            if (
              AsyncResult.isSuccess(result) &&
              !result.waiting &&
              result.value.desiredRevision !== lastGet
            ) {
              lastGet = result.value.desiredRevision;
              Queue.offerUnsafe(gets, lastGet);
            }
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releaseRead();
            releaseGet();
          }),
        );
        expect(yield* Queue.take(reads)).toBe(1);
        expect(yield* Queue.take(gets)).toBe(1);
        for (const snapshot of [
          {
            ...materialized,
            appliedRevision: 1,
            application: {
              status: "applied" as const,
              revision: 1,
              appliedAt: "2026-01-01T00:00:00Z",
            },
          },
          {
            ...materialized,
            providerInstanceId: ProviderInstanceId.make("claude"),
            desiredRevision: 2,
          },
          {
            ...materialized,
            providerInstanceId: ProviderInstanceId.make("claude"),
            desiredRevision: 3,
            desired: [
              {
                definitionId: McpDefinitionId.make("remote-definition"),
                logicalServerId: McpServerId.make("remote-server"),
                scope: "session" as const,
                scopeId: materialized.catalogSessionId,
                revision: 3,
                name: "Remote edit",
                enabled: true,
                providerInstanceIds: [],
                transport: {
                  type: "streamable-http" as const,
                  url: "https://example.test/mcp",
                  headers: [],
                  authorization: { type: "none" as const },
                },
              },
            ],
          },
        ]) {
          current = { snapshot };
          yield* Queue.offer(updates, current);
          expect(yield* Queue.take(observed)).toEqual(current);
          if (snapshot.desiredRevision > 1) {
            expect(yield* Queue.take(reads)).toBe(snapshot.desiredRevision);
            expect(yield* Queue.take(gets)).toBe(snapshot.desiredRevision);
          }
        }
        const latestRead = registry.get(read);
        expect(AsyncResult.isSuccess(latestRead) && latestRead.value.definitions[0]?.name).toBe(
          "Remote edit",
        );
        expect(starts).toBe(1);
        const input = {
          projectId: ProjectId.make("project"),
          logicalServerId: McpServerId.make("server"),
          transportDefinitionId: McpDefinitionId.make("definition"),
          threadId,
          mcpCatalogSessionId: materialized.catalogSessionId,
        };
        for (const command of [atoms.oauthContinue, atoms.oauthDisconnect]) {
          current = {
            snapshot: { ...materialized, desiredRevision: current.snapshot!.desiredRevision + 1 },
          };
          const result = yield* Effect.promise(() =>
            command.run(registry, { environmentId, input }),
          );
          expect(result._tag).toBe("Success");
          expect(yield* Queue.take(observed)).toEqual(current);
        }
        // Only the explicit OAuth refreshes restart the stream; editor invalidation does not.
        expect(starts).toBe(3);
        closing = true;
        release();
        yield* Deferred.await(closed);
        expect(active).toBe(0);
        expect(registry.getNodes().has(atom)).toBe(false);
      }),
    ),
);
