import { assert, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type McpCatalogSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import {
  McpProviderSessions,
  layer as sessionsLayer,
} from "@t3tools/provider-core/server/McpProviderSessions";
import { McpCatalogApplicationService, layer } from "./McpCatalogApplicationService.ts";
import { McpCatalogService, layer as catalogLayer } from "./McpCatalogService.ts";
import {
  McpCatalogGateway,
  McpCatalogGatewayError,
  type McpCatalogGatewaySession,
} from "./McpCatalogGateway.ts";
import { McpSessionRegistry, type McpNativeRuntimeBinding } from "./McpSessionRegistry.ts";
import { ProjectMcpSecretStore, credentialOwnerIdForDefinition } from "./ProjectMcpSecretStore.ts";
import { ProjectMcpOAuth } from "./ProjectMcpOAuth.ts";
import { runWorkflowFeatureMigrations } from "../persistence/WorkflowFeatureMigrations.ts";

it.effect(
  "provider transition retires the old gateway before rebind, preserves session baseline, and stages only assigned entries",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("env");
      const threadId = ThreadId.make("thread");
      const projectId = ProjectId.make("project");
      const codex = ProviderInstanceId.make("codex");
      const claude = ProviderInstanceId.make("claude");
      let current: McpCatalogGatewaySession | undefined;
      const bindings = new Map<string, McpNativeRuntimeBinding>();
      const actions: string[] = [];
      const gateway = Layer.mock(McpCatalogGateway)({
        resolveCatalogSession: () => Effect.sync(() => current),
        resolveProviderSession: (identity) =>
          Effect.sync(() => (current?.providerSessionId === identity ? current : undefined)),
        applyCatalogRevision: (input) =>
          Effect.sync(() => {
            actions.push("stage:" + input.providerInstanceId);
            current = input;
            return input;
          }),
        disposeCatalogSession: () =>
          Effect.sync(() => {
            actions.push("dispose");
            current = undefined;
          }),
      });
      const registry = Layer.mock(McpSessionRegistry)({
        bindNativeRuntime: (input) =>
          Effect.sync(() => {
            actions.push("bind:" + input.providerInstanceId);
            bindings.set(input.providerSessionId, input);
          }),
        resolveNativeRuntime: (identity) => Effect.sync(() => bindings.get(identity)),
        revokeProviderSession: (identity) =>
          Effect.sync(() => {
            actions.push("revoke:" + identity);
            bindings.delete(identity);
          }),
      });
      const base = Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer);
      const dependencies = Layer.mergeAll(
        catalogLayer.pipe(Layer.provideMerge(base)),
        sessionsLayer,
        gateway,
        registry,
        Layer.mock(ProjectMcpSecretStore)({ reconcile: () => Effect.void }),
        Layer.mock(ProjectMcpOAuth)({}),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runWorkflowFeatureMigrations();
        yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
        yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_projects VALUES(${projectId},NULL)`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${threadId},${projectId},NULL)`;
        const catalog = yield* McpCatalogService;
        const sessions = yield* McpProviderSessions;
        const application = yield* McpCatalogApplicationService;
        const actor = {
          environmentId,
          scopes: [AuthOrchestrationReadScope, AuthSettingsWriteScope],
        };
        const transport = {
          type: "streamable-http" as const,
          url: "https://example.test/mcp",
          headers: [],
          authorization: { type: "none" as const },
        };
        yield* catalog.write(
          {
            scope: "global",
            scopeId: environmentId,
            expectedRevision: 0,
            operation: {
              type: "create",
              definition: {
                name: "Codex only",
                enabled: true,
                providerInstanceIds: [codex],
                transport,
              },
            },
          },
          actor,
        );
        yield* catalog.write(
          {
            scope: "global",
            scopeId: environmentId,
            expectedRevision: 1,
            operation: {
              type: "create",
              definition: {
                name: "Shared",
                enabled: true,
                providerInstanceIds: [codex, claude],
                transport,
              },
            },
          },
          actor,
        );
        const old = {
          environmentId,
          threadId,
          providerSessionId: "old-issued",
          providerInstanceId: codex,
          endpoint: "http://127.0.0.1/mcp",
          catalogEndpoint: "http://127.0.0.1/mcp/catalog/old-issued",
          authorizationHeader: "Bearer old",
          browserToolsAvailable: false,
        };
        yield* sessions.set(old);
        yield* application.prepareNativeRuntime({
          threadId,
          projectId,
          providerInstanceId: codex,
          runtimeId: "old-runtime",
        });
        const original = yield* catalog.activeSessionForThread(threadId);
        assert.ok(original);
        const oldConfig = yield* sessions.read(threadId);
        assert.ok(oldConfig);
        yield* sessions.acknowledgeCatalogEndpoint(oldConfig);
        assert.equal((yield* catalog.activeSessionForThread(threadId))?.appliedRevision, 1);
        const next = {
          ...old,
          providerSessionId: "new-issued",
          providerInstanceId: claude,
          catalogEndpoint: "http://127.0.0.1/mcp/catalog/new-issued",
        };
        yield* sessions.set(next);
        assert.equal(
          yield* application.requiresRestart({ threadId, projectId, providerInstanceId: claude }),
          true,
        );
        assert.equal((yield* catalog.activeSessionForThread(threadId))?.providerInstanceId, codex);
        yield* application.prepareNativeRuntime({
          threadId,
          projectId,
          providerInstanceId: claude,
          runtimeId: "new-runtime",
        });
        const rebound = yield* catalog.activeSessionForThread(threadId);
        assert.equal(rebound?.catalogSessionId, original.catalogSessionId);
        assert.deepEqual(rebound?.baseline, original.baseline);
        assert.equal(rebound?.providerInstanceId, claude);
        assert.equal(rebound?.desiredRevision, 2);
        assert.equal(rebound?.appliedRevision, 1);
        assert.deepEqual(actions, [
          "bind:codex",
          "stage:codex",
          "revoke:old-issued",
          "dispose",
          "bind:claude",
          "stage:claude",
        ]);
        assert.deepEqual(
          current?.entries.map((entry) => entry.name),
          ["Shared"],
        );
        const config = yield* sessions.read(threadId);
        assert.ok(config);
        assert.equal(config.catalogRevision, 2);
        yield* sessions.acknowledgeCatalogEndpoint(config);
        assert.equal((yield* catalog.activeSessionForThread(threadId))?.appliedRevision, 2);
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const lookup = catalog.activeSessionForThread;
        using _lookup = vi
          .spyOn(catalog, "activeSessionForThread")
          .mockImplementationOnce((id) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.andThen(lookup(id)),
            ),
          );
        yield* sessions.set({
          ...old,
          providerSessionId: "stale-issued",
          nativeRuntimeId: "stale-runtime",
        });
        const obsolete = yield* application
          .prepareNativeRuntime({
            threadId,
            projectId,
            providerInstanceId: codex,
            runtimeId: "stale-runtime",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* sessions.set({
          ...next,
          providerSessionId: "successor-issued",
          nativeRuntimeId: "successor-runtime",
        });
        const successor = yield* application
          .prepareNativeRuntime({
            threadId,
            projectId,
            providerInstanceId: claude,
            runtimeId: "successor-runtime",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(obsolete);
        yield* Fiber.join(successor);
        const successorConfig = yield* sessions.read(threadId);
        assert.ok(successorConfig);
        yield* sessions.acknowledgeCatalogEndpoint(successorConfig);
        assert.equal(bindings.get("successor-issued")?.runtimeId, "successor-runtime");
        assert.equal((yield* catalog.activeSessionForThread(threadId))?.providerInstanceId, claude);
        assert.equal((yield* catalog.activeSessionForThread(threadId))?.desiredRevision, 2);
        assert.deepEqual(actions.slice(6), ["bind:claude", "stage:claude"]);
        yield* catalog.requestApplication({
          threadId,
          mcpCatalogSessionId: original.catalogSessionId,
        });
        const oldRecordEntered = yield* Deferred.make<void>();
        const oldRecordResume = yield* Deferred.make<void>();
        const commit = catalog.recordApplication;
        using _record = vi
          .spyOn(catalog, "recordApplication")
          .mockImplementationOnce((input) =>
            Deferred.succeed(oldRecordEntered, undefined).pipe(
              Effect.andThen(Deferred.await(oldRecordResume)),
              Effect.andThen(commit(input)),
            ),
          );
        const draining = yield* application.drain().pipe(Effect.forkChild);
        yield* Deferred.await(oldRecordEntered);
        yield* sessions.set({
          ...successorConfig,
          providerSessionId: "reopened-issued",
          nativeRuntimeId: "reopened-runtime",
        });
        const reopening = yield* application
          .prepareNativeRuntime({
            threadId,
            projectId,
            providerInstanceId: claude,
            runtimeId: "reopened-runtime",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(oldRecordResume, undefined);
        yield* Fiber.join(draining);
        yield* Fiber.join(reopening);
        assert.equal(
          (yield* catalog.activeSessionForThread(threadId))?.application?.status,
          "restart-required",
        );
        assert.equal((yield* catalog.pendingApplications()).length, 1);
        assert.equal(yield* sessions.readCatalogEndpointReceipt(threadId), undefined);
        assert.equal(
          yield* application.requiresRestart({ threadId, projectId, providerInstanceId: claude }),
          true,
        );
        const reopenedConfig = yield* sessions.read(threadId);
        assert.ok(reopenedConfig);
        yield* sessions.acknowledgeCatalogEndpoint(reopenedConfig);
        assert.equal(
          (yield* catalog.activeSessionForThread(threadId))?.application?.status,
          "applied",
        );
        assert.equal((yield* catalog.pendingApplications()).length, 0);
        const unrelatedThread = ThreadId.make("unrelated-thread");
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${unrelatedThread},${projectId},NULL)`;
        yield* catalog.materializeSession({
          threadId: unrelatedThread,
          projectId,
          providerInstanceId: claude,
        });
        yield* sessions.set({
          ...reopenedConfig,
          threadId: unrelatedThread,
          providerSessionId: "unrelated-issued",
          nativeRuntimeId: "unrelated-runtime",
        });
        const unrelatedEntered = yield* Deferred.make<void>();
        const unrelatedResume = yield* Deferred.make<void>();
        using _unrelatedLookup = vi
          .spyOn(catalog, "activeSessionForThread")
          .mockImplementationOnce((id) =>
            Deferred.succeed(unrelatedEntered, undefined).pipe(
              Effect.andThen(Deferred.await(unrelatedResume)),
              Effect.andThen(lookup(id)),
            ),
          );
        const unrelatedPreparation = yield* application
          .prepareNativeRuntime({
            threadId: unrelatedThread,
            projectId,
            providerInstanceId: claude,
            runtimeId: "unrelated-runtime",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(unrelatedEntered);
        yield* catalog.requestApplication({
          threadId,
          mcpCatalogSessionId: original.catalogSessionId,
        });
        yield* sessions.acknowledgeCatalogEndpoint(reopenedConfig);
        assert.equal(
          (yield* catalog.activeSessionForThread(threadId))?.application?.status,
          "applied",
        );
        assert.deepEqual(
          (yield* catalog.pendingApplications()).map((snapshot) => snapshot.threadId),
          [unrelatedThread],
        );
        yield* Deferred.succeed(unrelatedResume, undefined);
        yield* Fiber.join(unrelatedPreparation);
      }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(dependencies))));
    }),
);

it.effect(
  "disconnect retires all affected gateways before any blocked pending write or slow client close",
  () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("env");
      const projectId = ProjectId.make("project");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const threadIds = [ThreadId.make("thread-a"), ThreadId.make("thread-b")];
      const base = Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runWorkflowFeatureMigrations();
        yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
        yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,deleted_at TEXT)`;
        yield* sql`INSERT INTO projection_projects VALUES(${projectId},NULL)`;
        for (const threadId of threadIds)
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${threadId},${projectId},NULL)`;
        const catalog = yield* McpCatalogService;
        yield* catalog.write(
          {
            scope: "global",
            scopeId: environmentId,
            expectedRevision: 0,
            operation: {
              type: "create",
              definition: {
                name: "Shared",
                enabled: true,
                providerInstanceIds: [providerInstanceId],
                transport: {
                  type: "streamable-http",
                  url: "https://example.test/mcp",
                  headers: [],
                  authorization: { type: "none" },
                },
              },
            },
          },
          { environmentId, scopes: [AuthOrchestrationReadScope, AuthSettingsWriteScope] },
        );
        const oldSqlEntered = yield* Deferred.make<void>();
        const oldSqlResume = yield* Deferred.make<void>();
        const closeResume = yield* Deferred.make<void>();
        const secondPending = yield* Deferred.make<void>();
        const disposals = yield* Queue.unbounded<McpCatalogSessionId>();
        const active = new Map<McpCatalogSessionId, McpCatalogGatewaySession>();
        const bindings = new Map<string, McpNativeRuntimeBinding>();
        let firstId: McpCatalogSessionId | undefined;
        let secondThread: ThreadId | undefined;
        let pauseSql = false;
        let disconnected = false;
        const domain = Layer.succeed(McpCatalogService, {
          ...catalog,
          recordApplication: (input) =>
            Effect.gen(function* () {
              if (pauseSql && input.status === "applied") {
                pauseSql = false;
                yield* Deferred.succeed(oldSqlEntered, undefined);
                yield* Deferred.await(oldSqlResume);
              }
              return yield* catalog.recordApplication(input);
            }),
          requestApplication: (input) =>
            catalog
              .requestApplication(input)
              .pipe(
                Effect.tap(() =>
                  disconnected && input.threadId === secondThread
                    ? Deferred.succeed(secondPending, undefined)
                    : Effect.void,
                ),
              ),
        });
        const gateway = Layer.mock(McpCatalogGateway)({
          resolveCatalogSession: (id) => Effect.sync(() => active.get(id)),
          resolveProviderSession: (identity, id) =>
            Effect.sync(() =>
              active.get(id)?.providerSessionId === identity ? active.get(id) : undefined,
            ),
          applyCatalogRevision: (input) =>
            Effect.suspend(() =>
              disconnected
                ? Effect.fail(new McpCatalogGatewayError())
                : Effect.sync(() => {
                    active.set(input.catalogSessionId, input);
                    return input;
                  }),
            ),
          disposeCatalogSession: (id) =>
            Effect.sync(() => {
              active.delete(id);
            }).pipe(
              Effect.andThen(Queue.offer(disposals, id)),
              Effect.andThen(
                Effect.suspend(() => (id === firstId ? Deferred.await(closeResume) : Effect.void)),
              ),
            ),
        });
        const registry = Layer.mock(McpSessionRegistry)({
          bindNativeRuntime: (input) =>
            Effect.sync(() => {
              bindings.set(input.providerSessionId, input);
            }),
          resolveNativeRuntime: (id) => Effect.sync(() => bindings.get(id)),
        });
        const dependencies = Layer.mergeAll(
          domain,
          sessionsLayer,
          gateway,
          registry,
          Layer.mock(ProjectMcpSecretStore)({ reconcile: () => Effect.void }),
          Layer.mock(ProjectMcpOAuth)({}),
        );
        yield* Effect.gen(function* () {
          const application = yield* McpCatalogApplicationService;
          const sessions = yield* McpProviderSessions;
          for (const threadId of threadIds) {
            yield* sessions.set({
              environmentId,
              threadId,
              providerSessionId: "issued-" + threadId,
              providerInstanceId,
              endpoint: "http://127.0.0.1/mcp",
              catalogEndpoint: "http://127.0.0.1/mcp/catalog/" + threadId,
              authorizationHeader: "Bearer fixture",
              browserToolsAvailable: false,
            });
            yield* application.prepareNativeRuntime({
              threadId,
              projectId,
              providerInstanceId,
              runtimeId: "runtime-" + threadId,
            });
            const config = yield* sessions.read(threadId);
            assert.ok(config);
            yield* sessions.acknowledgeCatalogEndpoint(config);
          }
          const retained = yield* catalog.retainedSessions();
          const first = retained[0]!;
          const second = retained[1]!;
          firstId = first.catalogSessionId;
          secondThread = second.threadId;
          const definition = first.desired[0]!;
          const owner = credentialOwnerIdForDefinition(
            definition.logicalServerId,
            definition.definitionId,
          );
          yield* catalog.requestApplication({
            threadId: first.threadId,
            mcpCatalogSessionId: first.catalogSessionId,
          });
          pauseSql = true;
          const draining = yield* application.drain().pipe(Effect.forkChild);
          yield* Deferred.await(oldSqlEntered);
          disconnected = true;
          const disconnecting = yield* application.disconnect(owner).pipe(Effect.forkChild);
          const retired = new Set([yield* Queue.take(disposals), yield* Queue.take(disposals)]);
          assert.deepEqual(retired, new Set([first.catalogSessionId, second.catalogSessionId]));
          assert.equal(active.size, 0);
          yield* Deferred.succeed(closeResume, undefined);
          yield* Deferred.await(secondPending);
          assert.equal(
            (yield* catalog.activeSessionForThread(second.threadId))?.application?.status,
            "restart-required",
          );
          assert.equal(active.size, 0);
          yield* Deferred.succeed(oldSqlResume, undefined);
          yield* Fiber.join(draining);
          yield* Fiber.join(disconnecting);
          assert.equal(active.size, 0);
          assert.equal(
            (yield* catalog.activeSessionForThread(first.threadId))?.application?.status,
            "failed",
          );
          assert.equal(
            (yield* catalog.activeSessionForThread(second.threadId))?.application?.status,
            "failed",
          );
        }).pipe(Effect.provide(layer.pipe(Layer.provideMerge(dependencies))));
      }).pipe(Effect.provide(catalogLayer.pipe(Layer.provideMerge(base))));
    }),
);
