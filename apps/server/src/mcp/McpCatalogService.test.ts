import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  AuthOrchestrationReadScope,
  AuthEnvironmentScopes,
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentId,
  McpServerId,
  McpDefinitionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  McpCatalogOverrideId,
} from "@t3tools/contracts";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import { resolveSessionCatalog } from "./McpCatalogResolver.ts";
import { runWorkflowFeatureMigrations } from "../persistence/WorkflowFeatureMigrations.ts";
import {
  McpCatalogService,
  layer as catalogLayer,
  type McpCatalogActor,
} from "./McpCatalogService.ts";
const encodeScopes = Schema.encodeSync(Schema.fromJsonString(AuthEnvironmentScopes));
const environmentId = EnvironmentId.make("environment");
const projectId = ProjectId.make("project");
const threadId = ThreadId.make("thread");
const providerInstanceId = ProviderInstanceId.make("codex");
const actor: McpCatalogActor = {
  environmentId,
  scopes: [AuthOrchestrationReadScope, AuthSettingsWriteScope],
};
const definition = {
  name: "Docs",
  enabled: true,
  providerInstanceIds: [providerInstanceId],
  transport: {
    type: "streamable-http" as const,
    url: "https://example.test/mcp",
    headers: [],
    authorization: { type: "none" as const },
  },
};
const base = Layer.merge(NodeSqliteClient.layer({ filename: ":memory:" }), NodeCrypto.layer);
const layer = catalogLayer.pipe(Layer.provideMerge(base));
const seed = Effect.fn("McpCatalogTest.seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runWorkflowFeatureMigrations();
  yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, deleted_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,deleted_at TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES(${projectId},NULL),('other',NULL)`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${threadId},${projectId},NULL),('other-thread','other',NULL)`;
  return yield* McpCatalogService;
});
it.effect("P7 expectedRevision is checked in durable state across fresh service construction", () =>
  Effect.gen(function* () {
    const service = yield* seed();
    const first = yield* service.write(
      {
        scope: "global",
        scopeId: environmentId,
        expectedRevision: 0,
        operation: { type: "create", definition },
      },
      actor,
    );
    assert.equal(first.revision, 1);
    const stale = yield* Effect.result(
      service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 0,
          operation: { type: "create", definition: { ...definition, name: "Other" } },
        },
        actor,
      ),
    );
    assert.equal(stale._tag, "Failure");
    const fresh = yield* Effect.provide(McpCatalogService, catalogLayer);
    assert.deepStrictEqual(
      yield* fresh.read({ scope: "global", scopeId: environmentId }, actor),
      first,
    );
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "P7 session baseline survives project edits until explicit reset; failures preserve applied generation",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const state = yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 0,
          operation: { type: "create", definition },
        },
        actor,
      );
      const initial = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      yield* service.recordApplication({
        threadId,
        mcpCatalogSessionId: initial.catalogSessionId,
        revision: 1,
        status: "applied",
      });
      yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 1,
          operation: {
            type: "update",
            logicalServerId: state.definitions[0]!.logicalServerId,
            definition: { ...definition, name: "Changed" },
          },
        },
        actor,
      );
      assert.equal(
        (yield* service.materializeSession({ threadId, projectId, providerInstanceId })).desired[0]
          ?.name,
        "Docs",
      );
      const reset = yield* service.write(
        {
          scope: "session",
          scopeId: initial.catalogSessionId,
          expectedRevision: 1,
          operation: { type: "reset" },
        },
        actor,
      );
      assert.equal(reset.snapshot?.desired[0]?.name, "Changed");
      const failed = yield* service.recordApplication({
        threadId,
        mcpCatalogSessionId: initial.catalogSessionId,
        revision: 2,
        status: "failed",
        reason: "Handshake failed",
      });
      assert.equal(failed.appliedRevision, 1);
      assert.equal(failed.applied[0]?.name, "Docs");
      assert.equal((yield* service.pendingApplications({ limit: 1 })).length, 1);
      const stale = yield* Effect.result(
        service.recordApplication({
          threadId,
          mcpCatalogSessionId: initial.catalogSessionId,
          revision: 1,
          status: "applied",
        }),
      );
      assert.equal(stale._tag, "Failure");
      const applied = yield* service.recordApplication({
        threadId,
        mcpCatalogSessionId: initial.catalogSessionId,
        revision: 2,
        status: "applied",
      });
      assert.equal(applied.applied[0]?.name, "Changed");
      assert.equal((yield* service.pendingApplications()).length, 0);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "P7 denies cross-scope mutations, cross-thread session reads, and disposed session writes",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const scoped = { ...actor, projectId };
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "global",
              scopeId: environmentId,
              expectedRevision: 0,
              operation: { type: "create", definition },
            },
            scoped,
          ),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(service.read({ scope: "project", scopeId: "other" }, scoped)))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "project",
              scopeId: projectId,
              expectedRevision: 0,
              operation: { type: "create", definition },
            },
            { ...actor, scopes: [AuthOrchestrationReadScope] },
          ),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          service.materializeSession({
            threadId,
            projectId: ProjectId.make("other"),
            providerInstanceId,
          }),
        ))._tag,
        "Failure",
      );
      const snapshot = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      assert.equal(
        (yield* Effect.result(
          service.getSession(
            {
              threadId: ThreadId.make("other-thread"),
              mcpCatalogSessionId: snapshot.catalogSessionId,
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
      yield* service.disposeSession({ threadId, mcpCatalogSessionId: snapshot.catalogSessionId });
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "session",
              scopeId: snapshot.catalogSessionId,
              expectedRevision: 1,
              operation: { type: "reset" },
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "P7 project overrides disable/re-enable stable identities and removal restores original definition",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const global = yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 0,
          operation: { type: "create", definition },
        },
        actor,
      );
      const logicalServerId = global.definitions[0]!.logicalServerId;
      const override = {
        id: McpCatalogOverrideId.make("override"),
        scope: "project" as const,
        scopeId: projectId,
        targetId: logicalServerId,
        enabled: false,
        name: "Hidden",
      };
      yield* service.write(
        {
          scope: "project",
          scopeId: projectId,
          expectedRevision: 0,
          operation: { type: "put-override", override },
        },
        actor,
      );
      const disabled = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      assert.equal(disabled.desired[0]?.enabled, false);
      assert.equal(disabled.desired[0]?.logicalServerId, logicalServerId);
      yield* service.write(
        {
          scope: "project",
          scopeId: projectId,
          expectedRevision: 1,
          operation: { type: "remove-override", overrideId: override.id },
        },
        actor,
      );
      const reset = yield* service.write(
        {
          scope: "session",
          scopeId: disabled.catalogSessionId,
          expectedRevision: 1,
          operation: { type: "reset" },
        },
        actor,
      );
      assert.equal(reset.snapshot?.desired[0]?.enabled, true);
      assert.equal(reset.snapshot?.desired[0]?.name, "Docs");
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "P7 rejects name collisions, duplicate logical ids, raw secret bytes, and stale restart receipts",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const id = McpServerId.make("stable");
      yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 0,
          operation: { type: "create", logicalServerId: id, definition },
        },
        actor,
      );
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "global",
              scopeId: environmentId,
              expectedRevision: 1,
              operation: { type: "create", definition: { ...definition, name: "docs" } },
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "global",
              scopeId: environmentId,
              expectedRevision: 1,
              operation: { type: "create", logicalServerId: id, definition },
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
      const snapshot = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      const pending = yield* service.recordApplication({
        threadId,
        mcpCatalogSessionId: snapshot.catalogSessionId,
        revision: 1,
        status: "restart-required",
      });
      assert.equal(pending.appliedRevision, 0);
      assert.equal(pending.application?.status, "restart-required");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "P7 secret reconciliation retains hidden session base definitions and overrides until explicit removal",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const session = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      const created = yield* service.write(
        {
          scope: "session",
          scopeId: session.catalogSessionId,
          expectedRevision: 1,
          operation: { type: "create", definition },
        },
        actor,
      );
      const original = created.definitions[0]!;
      const patch = {
        id: McpCatalogOverrideId.make("session-override"),
        scope: "session" as const,
        scopeId: session.catalogSessionId,
        targetId: original.logicalServerId,
        transportDefinitionId: McpDefinitionId.make("replacement-definition"),
        transport: { ...definition.transport, url: "https://replacement.test/mcp" },
      };
      yield* service.write(
        {
          scope: "session",
          scopeId: session.catalogSessionId,
          expectedRevision: 2,
          operation: { type: "put-override", override: patch },
        },
        actor,
      );
      const retained = yield* service.retainedDefinitions();
      assert.ok(retained.some((entry) => entry.definitionId === original.definitionId));
      assert.ok(retained.some((entry) => entry.definitionId === patch.transportDefinitionId));
      const restored = yield* service.write(
        {
          scope: "session",
          scopeId: session.catalogSessionId,
          expectedRevision: 3,
          operation: { type: "remove-override", overrideId: patch.id },
        },
        actor,
      );
      assert.equal(restored.snapshot?.desired[0]?.definitionId, original.definitionId);
      yield* service.recordApplication({
        threadId,
        mcpCatalogSessionId: session.catalogSessionId,
        revision: 4,
        status: "applied",
      });
      assert.equal((yield* service.pendingApplications()).length, 0);
      const historical = yield* service.getSession({
        threadId,
        mcpCatalogSessionId: session.catalogSessionId,
      });
      const pending = yield* service.requestApplication({
        threadId,
        mcpCatalogSessionId: session.catalogSessionId,
      });
      assert.equal(pending.application?.status, "restart-required");
      assert.equal(pending.application?.revision, 4);
      assert.equal(pending.desiredRevision, 4);
      assert.equal(pending.appliedRevision, 4);
      assert.deepStrictEqual(pending.applied, historical.applied);
      assert.deepStrictEqual(pending.desired, historical.desired);
      assert.equal((yield* service.pendingApplications()).length, 1);
      const durable = yield* Effect.provide(McpCatalogService, catalogLayer);
      assert.equal(
        (yield* durable.getSession({ threadId, mcpCatalogSessionId: session.catalogSessionId }))
          .application?.status,
        "restart-required",
      );
      const acknowledged = yield* durable.recordApplication({
        threadId,
        mcpCatalogSessionId: session.catalogSessionId,
        revision: 4,
        status: "applied",
      });
      assert.equal(acknowledged.application?.status, "applied");
      assert.equal(acknowledged.appliedRevision, 4);
      assert.equal((yield* durable.pendingApplications()).length, 0);
      yield* service.disposeSession({ threadId, mcpCatalogSessionId: session.catalogSessionId });
      assert.equal((yield* service.retainedDefinitions()).length, 0);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "P7 global edits preserve every saved project's effective names, disabled overrides, and provider assignments",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      yield* service.write(
        {
          scope: "project",
          scopeId: projectId,
          expectedRevision: 0,
          operation: { type: "create", definition: { ...definition, name: "Local" } },
        },
        actor,
      );
      const conflicting = yield* Effect.result(
        service.write(
          {
            scope: "global",
            scopeId: environmentId,
            expectedRevision: 0,
            operation: { type: "create", definition: { ...definition, name: "local" } },
          },
          actor,
        ),
      );
      assert.equal(conflicting._tag, "Failure");
      if (conflicting._tag === "Failure")
        assert.equal(conflicting.failure._tag, "McpCatalogNameConflictError");
      assert.equal(
        (yield* service.read({ scope: "global", scopeId: environmentId }, actor)).revision,
        0,
      );
      assert.equal(
        (yield* service.read({ scope: "project", scopeId: projectId }, actor)).revision,
        1,
      );
      const otherProvider = ProviderInstanceId.make("claude");
      const saved = yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 0,
          operation: {
            type: "create",
            definition: { ...definition, name: "Remote", providerInstanceIds: [otherProvider] },
          },
        },
        actor,
      );
      const logicalServerId = saved.definitions[0]!.logicalServerId;
      yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 1,
          operation: {
            type: "update",
            logicalServerId,
            definition: { ...definition, name: "Local", providerInstanceIds: [otherProvider] },
          },
        },
        actor,
      );
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "global",
              scopeId: environmentId,
              expectedRevision: 2,
              operation: {
                type: "update",
                logicalServerId,
                definition: { ...definition, name: "Local" },
              },
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* service.read({ scope: "global", scopeId: environmentId }, actor)).revision,
        2,
      );
      const override = {
        id: McpCatalogOverrideId.make("disabled-global"),
        scope: "project" as const,
        scopeId: projectId,
        targetId: logicalServerId,
        enabled: false,
      };
      yield* service.write(
        {
          scope: "project",
          scopeId: projectId,
          expectedRevision: 1,
          operation: { type: "put-override", override },
        },
        actor,
      );
      yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 2,
          operation: {
            type: "update",
            logicalServerId,
            definition: { ...definition, name: "Local" },
          },
        },
        actor,
      );
      const session = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      assert.equal(session.desired.filter((entry) => entry.enabled).length, 1);
      assert.equal(
        session.desired.find((entry) => entry.logicalServerId === logicalServerId)?.enabled,
        false,
      );
      yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 3,
          operation: { type: "remove", logicalServerId },
        },
        actor,
      );
      const reset = yield* service.write(
        {
          scope: "session",
          scopeId: session.catalogSessionId,
          expectedRevision: 1,
          operation: { type: "reset" },
        },
        actor,
      );
      assert.equal(reset.snapshot?.desired.length, 1);
      assert.equal(
        (yield* service.read({ scope: "project", scopeId: projectId }, actor)).revision,
        2,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "P7 global create and rename honor project overrides and the effective provider limit atomically",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const global = yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 0,
          operation: {
            type: "create",
            definition: { ...definition, name: "Original", enabled: false },
          },
        },
        actor,
      );
      const id = global.definitions[0]!.logicalServerId;
      const override = {
        id: McpCatalogOverrideId.make("enabled-renamed"),
        scope: "project" as const,
        scopeId: projectId,
        targetId: id,
        enabled: true,
        name: "Masked",
      };
      yield* service.write(
        {
          scope: "project",
          scopeId: projectId,
          expectedRevision: 0,
          operation: { type: "put-override", override },
        },
        actor,
      );
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "global",
              scopeId: environmentId,
              expectedRevision: 1,
              operation: { type: "create", definition: { ...definition, name: "masked" } },
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
      const extra = yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 1,
          operation: {
            type: "create",
            definition: { ...definition, name: "Extra", enabled: false },
          },
        },
        actor,
      );
      const extraId = extra.definitions.find((entry) => entry.name === "Extra")!.logicalServerId;
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "global",
              scopeId: environmentId,
              expectedRevision: 2,
              operation: {
                type: "update",
                logicalServerId: extraId,
                definition: { ...definition, name: "Masked" },
              },
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
      for (let index = 0; index < 49; index++)
        yield* service.write(
          {
            scope: "project",
            scopeId: projectId,
            expectedRevision: index + 1,
            operation: { type: "create", definition: { ...definition, name: `Local ${index}` } },
          },
          actor,
        );
      assert.equal(
        (yield* Effect.result(
          service.write(
            {
              scope: "global",
              scopeId: environmentId,
              expectedRevision: 2,
              operation: {
                type: "update",
                logicalServerId: extraId,
                definition: { ...definition, name: "Extra" },
              },
            },
            actor,
          ),
        ))._tag,
        "Failure",
      );
      const overflow = yield* Effect.result(
        service.write(
          {
            scope: "global",
            scopeId: environmentId,
            expectedRevision: 2,
            operation: { type: "create", definition: { ...definition, name: "Overflow" } },
          },
          actor,
        ),
      );
      assert.equal(overflow._tag, "Failure");
      if (overflow._tag === "Failure")
        assert.equal(overflow.failure._tag, "McpCatalogProviderLimitExceededError");
      const after = yield* service.read({ scope: "global", scopeId: environmentId }, actor);
      assert.equal(after.revision, 2);
      assert.equal(
        after.definitions.find((entry) => entry.logicalServerId === extraId)?.enabled,
        false,
      );
      assert.equal(
        (yield* service.read({ scope: "project", scopeId: projectId }, actor)).revision,
        50,
      );
      const snapshot = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      assert.equal(snapshot.desired.filter((entry) => entry.enabled).length, 50);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "P7 human writes recheck persisted revocation, expiry, and grants inside the catalog transaction",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,scopes TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT)`;
      const authSessionId = AuthSessionId.make("catalog-human");
      const scopes = encodeScopes([AuthOrchestrationReadScope, AuthSettingsWriteScope]);
      yield* sql`INSERT INTO auth_sessions VALUES(${authSessionId},${scopes},'2999-01-01T00:00:00.000Z',NULL)`;
      const human = { ...actor, authSessionId };
      const input = {
        scope: "project" as const,
        scopeId: projectId,
        expectedRevision: 0,
        operation: { type: "create" as const, definition },
      };
      yield* service.authorizeWrite(input, human);
      yield* sql`UPDATE auth_sessions SET revoked_at='1970-01-01T00:00:00.000Z' WHERE session_id=${authSessionId}`;
      assert.equal((yield* Effect.result(service.write(input, human)))._tag, "Failure");
      yield* sql`UPDATE auth_sessions SET revoked_at=NULL,expires_at='1970-01-01T00:00:00.000Z' WHERE session_id=${authSessionId}`;
      assert.equal((yield* Effect.result(service.write(input, human)))._tag, "Failure");
      const readOnly = encodeScopes([AuthOrchestrationReadScope]);
      yield* sql`UPDATE auth_sessions SET expires_at='2999-01-01T00:00:00.000Z',scopes=${readOnly} WHERE session_id=${authSessionId}`;
      assert.equal((yield* Effect.result(service.write(input, human)))._tag, "Failure");
      assert.equal(
        (yield* service.read({ scope: "project", scopeId: projectId }, actor)).revision,
        0,
      );
      const settingsOnly = encodeScopes([AuthSettingsWriteScope]);
      yield* sql`UPDATE auth_sessions SET scopes=${settingsOnly} WHERE session_id=${authSessionId}`;
      const noCachedGrants = { ...human, scopes: [] };
      assert.equal(
        (yield* service.readForWrite({ scope: "project", scopeId: projectId }, noCachedGrants))
          .revision,
        0,
      );
      yield* service.write(input, noCachedGrants);
      assert.equal(
        (yield* Effect.result(service.read({ scope: "project", scopeId: projectId }, human)))._tag,
        "Failure",
      );
      const snapshot = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      const request = { threadId, mcpCatalogSessionId: snapshot.catalogSessionId };
      assert.equal(
        (yield* service.getSessionForWrite(request, human)).catalogSessionId,
        snapshot.catalogSessionId,
      );
      assert.equal((yield* Effect.result(service.getSession(request, human)))._tag, "Failure");
      assert.equal(
        (yield* Effect.result(
          service.readForWrite({ scope: "project", scopeId: "other" }, { ...human, projectId }),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "P7 provider rebind retains session customizations and frozen baseline while filtering the new provider",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const otherProvider = ProviderInstanceId.make("claude");
      const global = yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 0,
          operation: { type: "create", definition },
        },
        actor,
      );
      const globalId = global.definitions[0]!.logicalServerId;
      const initial = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      const custom = yield* service.write(
        {
          scope: "session",
          scopeId: initial.catalogSessionId,
          expectedRevision: 1,
          operation: {
            type: "create",
            definition: {
              ...definition,
              name: "Shared custom",
              providerInstanceIds: [providerInstanceId, otherProvider],
            },
          },
        },
        actor,
      );
      const customId = custom.definitions.find(
        (entry) => entry.name === "Shared custom",
      )!.logicalServerId;
      const override = {
        id: McpCatalogOverrideId.make("provider-switch-override"),
        scope: "session" as const,
        scopeId: initial.catalogSessionId,
        targetId: customId,
        name: "Renamed custom",
        transportDefinitionId: McpDefinitionId.make("custom-replacement"),
        transport: { ...definition.transport, url: "https://custom.example.test/mcp" },
      };
      const edited = yield* service.write(
        {
          scope: "session",
          scopeId: initial.catalogSessionId,
          expectedRevision: 2,
          operation: { type: "put-override", override },
        },
        actor,
      );
      yield* service.recordApplication({
        threadId,
        mcpCatalogSessionId: initial.catalogSessionId,
        revision: 3,
        status: "applied",
      });
      yield* service.write(
        {
          scope: "global",
          scopeId: environmentId,
          expectedRevision: 1,
          operation: {
            type: "update",
            logicalServerId: globalId,
            definition: { ...definition, name: "Changed after session" },
          },
        },
        actor,
      );
      assert.equal(
        (yield* service.activeSessionForThread(threadId))?.providerInstanceId,
        providerInstanceId,
      );
      const rebound = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId: otherProvider,
      });
      assert.equal(rebound.catalogSessionId, initial.catalogSessionId);
      assert.equal(
        (yield* service.activeSessionForThread(threadId))?.providerInstanceId,
        otherProvider,
      );
      assert.equal(rebound.providerInstanceId, otherProvider);
      assert.equal(rebound.desiredRevision, 4);
      assert.equal(rebound.appliedRevision, 3);
      assert.equal(rebound.application?.status, "restart-required");
      assert.deepStrictEqual(rebound.baseline, initial.baseline);
      assert.deepStrictEqual(rebound.desired, edited.snapshot!.desired);
      const delivered = resolveSessionCatalog({
        desired: rebound.desired,
        providerInstanceId: otherProvider,
        providerCapability: "live",
      });
      assert.deepStrictEqual(
        delivered.map((entry) => entry.logicalServerId),
        [customId],
      );
      assert.equal(delivered[0]?.name, "Renamed custom");
      assert.equal(delivered[0]?.transportDefinitionId, override.transportDefinitionId);
      assert.equal((yield* service.pendingApplications()).length, 1);
      assert.equal(
        (yield* Effect.result(
          service.recordApplication({
            threadId,
            mcpCatalogSessionId: initial.catalogSessionId,
            revision: 3,
            status: "applied",
          }),
        ))._tag,
        "Failure",
      );
      const restored = yield* service.write(
        {
          scope: "session",
          scopeId: initial.catalogSessionId,
          expectedRevision: 4,
          operation: { type: "remove-override", overrideId: override.id },
        },
        actor,
      );
      assert.equal(
        restored.snapshot?.desired.find((entry) => entry.logicalServerId === customId)?.name,
        "Shared custom",
      );
      const durable = yield* Effect.provide(McpCatalogService, catalogLayer);
      assert.equal(
        (yield* durable.materializeSession({
          threadId,
          projectId,
          providerInstanceId: otherProvider,
        })).desiredRevision,
        5,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "thread-keyed catalog reads recheck persisted authority and never materialize a session",
  () =>
    Effect.gen(function* () {
      const service = yield* seed();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,scopes TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT)`;
      const authSessionId = AuthSessionId.make("reader");
      yield* sql`INSERT INTO auth_sessions VALUES(${authSessionId},${encodeScopes([AuthOrchestrationReadScope])},'2999-01-01T00:00:00.000Z',NULL)`;
      const reader = { ...actor, authSessionId };
      assert.equal(yield* service.activeSessionForThread(threadId, reader), undefined);
      const snapshot = yield* service.materializeSession({
        threadId,
        projectId,
        providerInstanceId,
      });
      yield* service.recordApplication({
        threadId,
        mcpCatalogSessionId: snapshot.catalogSessionId,
        revision: snapshot.desiredRevision,
        status: "restart-required",
        reason: "Restart provider",
      });
      assert.equal(
        (yield* service.activeSessionForThread(threadId, reader))?.application?.status,
        "restart-required",
      );
      assert.equal(
        (yield* Effect.result(
          service.activeSessionForThread(threadId, {
            ...reader,
            projectId: ProjectId.make("other"),
          }),
        ))._tag,
        "Failure",
      );
      yield* sql`UPDATE auth_sessions SET revoked_at='1970-01-01T00:00:00.000Z' WHERE session_id=${authSessionId}`;
      assert.equal(
        (yield* Effect.result(service.activeSessionForThread(threadId, reader)))._tag,
        "Failure",
      );
      yield* sql`UPDATE auth_sessions SET revoked_at=NULL,scopes=${encodeScopes([AuthSettingsWriteScope])} WHERE session_id=${authSessionId}`;
      assert.equal(
        (yield* Effect.result(service.activeSessionForThread(threadId, reader)))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "session notifications follow committed materialization, provider rebind, and native acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* seed();
        const observed =
          yield* Queue.unbounded<
            Awaited<Effect.Success<ReturnType<typeof service.activeSessionForThread>>>
          >();
        const changes = yield* service.subscribeSessionChanges;
        yield* changes.pipe(
          Stream.runForEach(() =>
            service
              .activeSessionForThread(threadId, actor)
              .pipe(Effect.flatMap((snapshot) => Queue.offer(observed, snapshot))),
          ),
          Effect.forkScoped,
        );
        assert.equal(yield* Queue.take(observed), undefined);
        const first = yield* service.materializeSession({
          threadId,
          projectId,
          providerInstanceId,
        });
        assert.equal((yield* Queue.take(observed))?.catalogSessionId, first.catalogSessionId);
        const rebound = yield* service.materializeSession({
          threadId,
          projectId,
          providerInstanceId: ProviderInstanceId.make("claude"),
        });
        assert.equal((yield* Queue.take(observed))?.application?.status, "restart-required");
        yield* service.recordApplication({
          threadId,
          mcpCatalogSessionId: first.catalogSessionId,
          revision: rebound.desiredRevision,
          status: "applied",
        });
        assert.equal((yield* Queue.take(observed))?.application?.status, "applied");
        yield* service.disposeSession({ threadId, mcpCatalogSessionId: first.catalogSessionId });
        assert.equal(yield* Queue.take(observed), undefined);
      }).pipe(Effect.provide(layer)),
    ),
);
