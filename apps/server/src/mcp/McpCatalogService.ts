import { assertOrdinaryAssistantDestination } from "../assistants/AssistantGuards.ts";
import {
  AuthOrchestrationReadScope,
  AuthEnvironmentScopes,
  type AuthSessionId,
  AuthSettingsWriteScope,
  McpCatalogDefinition,
  McpCatalogOverride,
  McpCatalogOperationError,
  McpCatalogStaleRevisionError,
  McpCatalogSnapshot,
  McpCatalogSessionId,
  McpDefinitionId,
  McpServerId,
  ProjectMcpTransport,
  type AuthEnvironmentScope,
  type EnvironmentId,
  ProjectId,
  ThreadId,
  type ProviderInstanceId,
  type McpCatalogReadInput,
  type McpCatalogWriteInput,
  type McpCatalogMutationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import {
  applyMcpCatalogOverrides,
  catalogBaselineForProject,
  validateEffectiveCatalog,
} from "./McpCatalogResolver.ts";
import { hasCatalogTransportIdentityChange } from "./McpCatalogDefinitionIdentity.ts";

export interface McpCatalogActor {
  readonly environmentId: EnvironmentId;
  /** Set only by the authenticated client bridge; persisted grants override cached scopes. */
  readonly authSessionId?: AuthSessionId;
  readonly scopes: readonly AuthEnvironmentScope[];
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
}
export type PersistedMcpCatalogWriteInput = Omit<McpCatalogWriteInput, "operation"> & {
  readonly operation:
    | {
        readonly type: "create";
        readonly logicalServerId?: McpServerId;
        readonly definition: Pick<
          McpCatalogDefinition,
          "name" | "enabled" | "providerInstanceIds" | "transport"
        >;
        readonly definitionId?: McpDefinitionId;
      }
    | {
        readonly type: "update";
        readonly logicalServerId: McpServerId;
        readonly definition: Pick<
          McpCatalogDefinition,
          "name" | "enabled" | "providerInstanceIds" | "transport"
        >;
        readonly definitionId?: McpDefinitionId;
      }
    | { readonly type: "remove"; readonly logicalServerId: McpServerId }
    | { readonly type: "put-override"; readonly override: McpCatalogOverride }
    | { readonly type: "remove-override"; readonly overrideId: string }
    | { readonly type: "reset" };
};
export interface MaterializeSessionInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly mcpCatalogSessionId?: McpCatalogSessionId;
}
export interface CatalogSessionRequest {
  readonly threadId: ThreadId;
  readonly mcpCatalogSessionId: McpCatalogSessionId;
}
export interface CatalogApplicationInput extends CatalogSessionRequest {
  readonly revision: number;
  readonly status: "applied" | "failed" | "restart-required";
  readonly reason?: string;
}
const fail = (message: string) => new McpCatalogOperationError({ message });
const ScopeState = Schema.Struct({
  revision: Schema.Number,
  definitions: Schema.Array(McpCatalogDefinition),
  overrides: Schema.Array(McpCatalogOverride),
});
type ScopeState = typeof ScopeState.Type;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const empty: ScopeState = { revision: 0, definitions: [], overrides: [] };
interface SessionRow {
  readonly catalog_session_id: string;
  readonly thread_id: string;
  readonly project_id: string;
  readonly snapshot_json: string;
  readonly definitions_json: string;
  readonly overrides_json: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // One pending invalidation is enough: subscribers always re-read authoritative state.
  const sessionChanges = yield* PubSub.sliding<void>(1);
  const notifySessionChanges = PubSub.publish(sessionChanges, undefined);
  const subscribeSessionChanges = PubSub.subscribe(sessionChanges).pipe(
    Effect.map((subscription) =>
      Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)),
    ),
  );
  const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() => fail("Invalid persisted MCP catalog.")),
    );
  const decodeJson = <S extends Schema.Top>(schema: S, value: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError(() => fail("Invalid persisted MCP catalog.")),
    );
  const mapSqlErrors = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(
      Effect.mapError((error): Exclude<E, SqlError.SqlError> | McpCatalogOperationError =>
        error && typeof error === "object" && "_tag" in error && error._tag === "SqlError"
          ? fail("MCP catalog persistence failed.")
          : (error as Exclude<E, SqlError.SqlError>),
      ),
    );
  const transaction = <A, E>(program: Effect.Effect<A, E>) =>
    sql.withTransaction(program).pipe(mapSqlErrors);
  const threadProject = Effect.fn("McpCatalogService.threadProject")(function* (threadId: string) {
    const rows = yield* sql<{
      project_id: string;
    }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=${threadId} AND deleted_at IS NULL`;
    if (!rows[0]) return yield* fail("MCP catalog thread is unavailable.");
    return rows[0].project_id;
  });
  const projectExists = Effect.fn("McpCatalogService.projectExists")(function* (projectId: string) {
    const rows =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
    if (!rows.length) return yield* fail("MCP catalog project is unavailable.");
  });
  const sessionRow = Effect.fn("McpCatalogService.sessionRow")(function* (id: string) {
    const rows =
      yield* sql<SessionRow>`SELECT catalog_session_id,thread_id,project_id,snapshot_json,definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_sessions WHERE catalog_session_id=${id}`;
    if (!rows[0]) return yield* fail("MCP catalog session is unavailable.");
    const snapshot = yield* decodeJson(McpCatalogSnapshot, rows[0].snapshot_json);
    if (snapshot.disposedAt) return yield* fail("MCP catalog session is disposed.");
    if ((yield* threadProject(rows[0].thread_id)) !== rows[0].project_id)
      return yield* fail("MCP catalog session owner changed.");
    yield* projectExists(rows[0].project_id);
    return {
      ...rows[0],
      snapshot,
      definitions: yield* decodeJson(Schema.Array(McpCatalogDefinition), rows[0].definitions_json),
      overrides: yield* decodeJson(Schema.Array(McpCatalogOverride), rows[0].overrides_json),
    };
  });
  const loadScope = Effect.fn("McpCatalogService.loadScope")(function* (
    scope: "global" | "project",
    scopeId: string,
  ) {
    const rows = yield* sql<{
      revision: number;
      definitions_json: string;
      overrides_json: string;
    }>`SELECT revision,definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_scopes WHERE scope=${scope} AND scope_id=${scopeId}`;
    if (!rows[0]) return empty;
    return yield* decode(ScopeState, {
      revision: rows[0].revision,
      definitions: yield* decodeJson(Schema.Array(McpCatalogDefinition), rows[0].definitions_json),
      overrides: yield* decodeJson(Schema.Array(McpCatalogOverride), rows[0].overrides_json),
    });
  });
  const authorize = Effect.fn("McpCatalogService.authorize")(function* (
    input: McpCatalogReadInput,
    actor: McpCatalogActor,
    write: boolean,
  ) {
    let scopes = actor.scopes;
    if (actor.authSessionId !== undefined) {
      const rows = yield* sql<{
        scopes: string;
        expires_at: string;
        revoked_at: string | null;
      }>`SELECT scopes,expires_at,revoked_at FROM auth_sessions WHERE session_id=${actor.authSessionId}`;
      const row = rows[0];
      if (!row || row.revoked_at !== null) return yield* fail("MCP catalog permission denied.");
      const expiresAt = yield* decode(Schema.DateTimeUtcFromString, row.expires_at);
      if (expiresAt.epochMilliseconds <= (yield* DateTime.now).epochMilliseconds)
        return yield* fail("MCP catalog permission denied.");
      scopes = yield* decodeJson(AuthEnvironmentScopes, row.scopes);
    }
    if (!scopes.includes(write ? AuthSettingsWriteScope : AuthOrchestrationReadScope))
      return yield* fail("MCP catalog permission denied.");
    if (input.scope === "global") {
      if (actor.projectId || actor.threadId || input.scopeId !== actor.environmentId)
        return yield* fail("MCP global catalog owner mismatch.");
    } else if (input.scope === "project") {
      if (actor.threadId || (actor.projectId && actor.projectId !== input.scopeId))
        return yield* fail("MCP project catalog owner mismatch.");
      if (write)
        yield* assertOrdinaryAssistantDestination({
          projectId: ProjectId.make(input.scopeId),
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(() =>
            fail("Assistant resources must be selected through its configuration."),
          ),
        );
      yield* projectExists(input.scopeId);
    } else {
      const row = yield* sessionRow(input.scopeId);
      if (write)
        yield* assertOrdinaryAssistantDestination({
          projectId: ProjectId.make(row.project_id),
          threadId: ThreadId.make(row.thread_id),
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(() =>
            fail("Assistant resources must be selected through its configuration."),
          ),
        );
      if (
        (actor.projectId && actor.projectId !== row.project_id) ||
        (actor.threadId && actor.threadId !== row.thread_id)
      )
        return yield* fail("MCP session catalog owner mismatch.");
    }
  });
  const readState = Effect.fn("McpCatalogService.readState")(function* (
    input: McpCatalogReadInput,
  ) {
    if (input.scope !== "session") return yield* loadScope(input.scope, input.scopeId);
    const { snapshot, definitions, overrides } = yield* sessionRow(input.scopeId);
    return { revision: snapshot.desiredRevision, definitions, overrides, snapshot };
  });
  const read = Effect.fn("McpCatalogService.read")(function* (
    input: McpCatalogReadInput,
    actor: McpCatalogActor,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* authorize(input, actor, false);
        return yield* readState(input);
      }),
    );
  });
  const readForWrite = Effect.fn("McpCatalogService.readForWrite")(function* (
    input: McpCatalogReadInput,
    actor: McpCatalogActor,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* authorize(input, actor, true);
        return yield* readState(input);
      }),
    );
  });
  const authorizeWrite = Effect.fn("McpCatalogService.authorizeWrite")(function* (
    input: Pick<McpCatalogWriteInput, "scope" | "scopeId" | "expectedRevision">,
    actor: McpCatalogActor,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* authorize(input, actor, true);
        const state = yield* readState(input);
        if (state.revision !== input.expectedRevision)
          return yield* new McpCatalogStaleRevisionError({
            scope: input.scope,
            scopeId: input.scopeId,
            expectedRevision: input.expectedRevision,
            actualRevision: state.revision,
          });
        return state;
      }),
    );
  });
  const saveSession = Effect.fn("McpCatalogService.saveSession")(function* (
    snapshot: McpCatalogSnapshot,
    pending: boolean,
  ) {
    yield* sql`UPDATE t3_workflow_v2_mcp_catalog_sessions SET snapshot_json=${encodeJson(snapshot)},pending_apply=${pending ? 1 : 0} WHERE catalog_session_id=${snapshot.catalogSessionId}`;
    return snapshot;
  });
  const globalDefinitions = Effect.fn("McpCatalogService.globalDefinitions")(function* () {
    const globals = yield* sql<{
      definitions_json: string;
    }>`SELECT definitions_json FROM t3_workflow_v2_mcp_catalog_scopes WHERE scope='global'`;
    const definitions: Array<McpCatalogDefinition> = [];
    for (const row of globals)
      definitions.push(
        ...(yield* decodeJson(Schema.Array(McpCatalogDefinition), row.definitions_json)),
      );
    return definitions;
  });
  const baseline = Effect.fn("McpCatalogService.baseline")(function* (projectId: string) {
    const definitions = yield* globalDefinitions();
    const project = yield* loadScope("project", projectId);
    return catalogBaselineForProject({
      globalDefinitions: definitions,
      projectDefinitions: project.definitions,
      projectOverrides: project.overrides,
      projectId,
    });
  });
  const validate = (definitions: readonly McpCatalogDefinition[]) =>
    Effect.try({
      try: () => validateEffectiveCatalog({ definitions }),
      catch: (e) => e as McpCatalogMutationError,
    });
  const write = Effect.fn("McpCatalogService.write")(function* (
    input: PersistedMcpCatalogWriteInput,
    actor: McpCatalogActor,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const current = yield* authorizeWrite(input, actor);
        let definitions = [...current.definitions];
        let overrides = [...current.overrides];
        const operation = input.operation;
        if (operation.type === "create" || operation.type === "update") {
          // Schema decoding strips unknown fields, so reject secret bytes before decoding can hide them.
          if (encodeJson(operation.definition.transport).includes('"value":'))
            return yield* fail("Credential values cannot enter the catalog.");
          const transport = yield* decode(ProjectMcpTransport, operation.definition.transport);
          const id =
            operation.logicalServerId ??
            McpServerId.make(
              yield* crypto
                .randomUUIDv4()
                .pipe(Effect.mapError(() => fail("MCP catalog identity allocation failed."))),
            );
          const previous = definitions.find((d) => d.logicalServerId === id);
          if ((operation.type === "create") === Boolean(previous))
            return yield* fail("MCP catalog logical server identity conflicts.");
          if (
            operation.type === "create" &&
            input.scope === "project" &&
            (yield* globalDefinitions()).some((definition) => definition.logicalServerId === id)
          )
            return yield* fail("MCP catalog logical identity already belongs to the global scope.");
          if (operation.type === "create" && input.scope === "global") {
            const projects = yield* sql<{
              definitions_json: string;
            }>`SELECT definitions_json FROM t3_workflow_v2_mcp_catalog_scopes WHERE scope='project'`;
            for (const project of projects)
              if (
                (yield* decodeJson(
                  Schema.Array(McpCatalogDefinition),
                  project.definitions_json,
                )).some((definition) => definition.logicalServerId === id)
              )
                return yield* fail(
                  "MCP catalog logical identity already belongs to a project scope.",
                );
          }
          const definitionId =
            operation.definitionId ??
            (previous && !hasCatalogTransportIdentityChange(previous.transport, transport)
              ? previous.definitionId
              : McpDefinitionId.make(
                  yield* crypto
                    .randomUUIDv4()
                    .pipe(Effect.mapError(() => fail("MCP catalog identity allocation failed."))),
                ));
          const definition = yield* decode(McpCatalogDefinition, {
            ...operation.definition,
            transport,
            logicalServerId: id,
            definitionId,
            scope: input.scope,
            scopeId: input.scopeId,
            revision: current.revision + 1,
          });
          definitions = definitions.filter((d) => d.logicalServerId !== id).concat(definition);
        } else if (operation.type === "remove") {
          if (!definitions.some((d) => d.logicalServerId === operation.logicalServerId))
            return yield* fail("MCP catalog server not found.");
          definitions = definitions.filter((d) => d.logicalServerId !== operation.logicalServerId);
        } else if (operation.type === "put-override") {
          if (
            input.scope === "global" ||
            operation.override.scope !== input.scope ||
            operation.override.scopeId !== input.scopeId
          )
            return yield* fail("MCP catalog override owner mismatch.");
          if (encodeJson(operation.override).includes('"value":'))
            return yield* fail("Credential values cannot enter the catalog.");
          const patch = yield* decode(McpCatalogOverride, operation.override);
          const candidates = input.scope === "session" ? definitions : yield* globalDefinitions();
          if (!candidates.some((d) => d.logicalServerId === patch.targetId))
            return yield* fail("MCP catalog override target not found.");
          overrides = overrides
            .filter((o) => o.id !== patch.id && o.targetId !== patch.targetId)
            .concat(patch);
        } else if (operation.type === "remove-override") {
          if (input.scope === "global" || !overrides.some((o) => o.id === operation.overrideId))
            return yield* fail("MCP catalog override not found.");
          overrides = overrides.filter((o) => o.id !== operation.overrideId);
        } else {
          if (input.scope !== "session") return yield* fail("Only a session catalog can reset.");
          definitions = [...(yield* baseline((yield* sessionRow(input.scopeId)).project_id))];
          overrides = [];
        }
        if (input.scope === "session") {
          const desired = [...applyMcpCatalogOverrides(definitions, overrides)];
          yield* validate(desired);
          const row = yield* sessionRow(input.scopeId);
          yield* sql`UPDATE t3_workflow_v2_mcp_catalog_sessions SET definitions_json=${encodeJson(definitions)},overrides_json=${encodeJson(overrides)} WHERE catalog_session_id=${input.scopeId}`;
          const snapshot = yield* saveSession(
            {
              ...row.snapshot,
              desired,
              baseline: operation.type === "reset" ? definitions : row.snapshot.baseline,
              desiredRevision: current.revision + 1,
            },
            true,
          );
          return { revision: snapshot.desiredRevision, definitions, overrides, snapshot };
        }
        yield* validate(
          input.scope === "project"
            ? catalogBaselineForProject({
                globalDefinitions: yield* globalDefinitions(),
                projectDefinitions: definitions,
                projectOverrides: overrides,
                projectId: input.scopeId,
              })
            : definitions,
        );
        if (input.scope === "global") {
          const projects = yield* sql<{
            scope_id: string;
            definitions_json: string;
            overrides_json: string;
          }>`SELECT scope_id,definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_scopes WHERE scope='project'`;
          for (const project of projects)
            yield* validate(
              catalogBaselineForProject({
                globalDefinitions: definitions,
                projectDefinitions: yield* decodeJson(
                  Schema.Array(McpCatalogDefinition),
                  project.definitions_json,
                ),
                projectOverrides: yield* decodeJson(
                  Schema.Array(McpCatalogOverride),
                  project.overrides_json,
                ),
                projectId: project.scope_id,
              }),
            );
        }
        yield* sql`INSERT INTO t3_workflow_v2_mcp_catalog_scopes(scope,scope_id,revision,definitions_json,overrides_json) VALUES(${input.scope},${input.scopeId},${current.revision + 1},${encodeJson(definitions)},${encodeJson(overrides)}) ON CONFLICT(scope,scope_id) DO UPDATE SET revision=excluded.revision,definitions_json=excluded.definitions_json,overrides_json=excluded.overrides_json`;
        return { revision: current.revision + 1, definitions, overrides };
      }),
    ).pipe(Effect.ensuring(notifySessionChanges));
  });
  const sessionAccess = Effect.fn("McpCatalogService.sessionAccess")(function* (
    input: CatalogSessionRequest,
    actor: McpCatalogActor | undefined,
    write: boolean,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        if (actor)
          yield* authorize({ scope: "session", scopeId: input.mcpCatalogSessionId }, actor, write);
        const row = yield* sessionRow(input.mcpCatalogSessionId);
        if (row.thread_id !== input.threadId)
          return yield* fail("MCP catalog thread owner mismatch.");
        return row.snapshot;
      }),
    );
  });
  const getSession = Effect.fn("McpCatalogService.getSession")(function* (
    input: CatalogSessionRequest,
    actor?: McpCatalogActor,
  ) {
    return yield* sessionAccess(input, actor, false);
  });
  const getSessionForWrite = Effect.fn("McpCatalogService.getSessionForWrite")(function* (
    input: CatalogSessionRequest,
    actor: McpCatalogActor,
  ) {
    return yield* sessionAccess(input, actor, true);
  });
  const activeSessionForThread = Effect.fn("McpCatalogService.activeSessionForThread")(function* (
    threadId: ThreadId,
    actor?: McpCatalogActor,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const projectId = yield* threadProject(threadId);
        yield* projectExists(projectId);
        if (actor) yield* authorize({ scope: "project", scopeId: projectId }, actor, false);
        const rows = yield* sql<{
          catalog_session_id: string;
        }>`SELECT catalog_session_id FROM t3_workflow_v2_mcp_catalog_sessions WHERE thread_id=${threadId} AND json_extract(snapshot_json,'$.disposedAt') IS NULL`;
        return rows[0] ? (yield* sessionRow(rows[0].catalog_session_id)).snapshot : undefined;
      }),
    );
  });
  const materializeSession = Effect.fn("McpCatalogService.materializeSession")(function* (
    input: MaterializeSessionInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        yield* projectExists(input.projectId);
        if ((yield* threadProject(input.threadId)) !== input.projectId)
          return yield* fail("MCP catalog thread project mismatch.");
        const rows =
          yield* sql<SessionRow>`SELECT catalog_session_id,thread_id,project_id,snapshot_json,definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_sessions WHERE thread_id=${input.threadId}`;
        for (const row of rows) {
          const snapshot = yield* decodeJson(McpCatalogSnapshot, row.snapshot_json);
          if (snapshot.disposedAt) continue;
          if (input.mcpCatalogSessionId && snapshot.catalogSessionId !== input.mcpCatalogSessionId)
            return yield* fail("MCP catalog session identity mismatch.");
          if (snapshot.providerInstanceId !== input.providerInstanceId) {
            const revision = snapshot.desiredRevision + 1;
            // The native lifecycle owner revokes the old gateway first; provider filtering belongs to resolution.
            return yield* saveSession(
              {
                ...snapshot,
                providerInstanceId: input.providerInstanceId,
                desiredRevision: revision,
                application: {
                  status: "restart-required",
                  revision,
                  failedAt: DateTime.formatIso(yield* DateTime.now),
                  reason: "The new provider has not acknowledged this MCP catalog.",
                },
              },
              true,
            );
          }
          return snapshot;
        }
        const definitions = yield* baseline(input.projectId);
        yield* validate(definitions);
        const snapshot: McpCatalogSnapshot = {
          catalogSessionId:
            input.mcpCatalogSessionId ??
            McpCatalogSessionId.make(
              yield* crypto
                .randomUUIDv4()
                .pipe(Effect.mapError(() => fail("MCP catalog identity allocation failed."))),
            ),
          threadId: input.threadId,
          providerInstanceId: input.providerInstanceId,
          baseline: definitions,
          desired: definitions,
          applied: [],
          desiredRevision: 1,
          appliedRevision: 0,
        };
        yield* sql`INSERT INTO t3_workflow_v2_mcp_catalog_sessions(catalog_session_id,thread_id,project_id,snapshot_json,definitions_json,overrides_json,pending_apply) VALUES(${snapshot.catalogSessionId},${input.threadId},${input.projectId},${encodeJson(snapshot)},${encodeJson(definitions)},${encodeJson([])},1)`;
        return snapshot;
      }),
    ).pipe(Effect.ensuring(notifySessionChanges));
  });
  const recordApplication = Effect.fn("McpCatalogService.recordApplication")(function* (
    input: CatalogApplicationInput,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const snapshot = yield* getSession(input);
        if (snapshot.desiredRevision !== input.revision)
          return yield* new McpCatalogStaleRevisionError({
            scope: "session",
            scopeId: input.mcpCatalogSessionId,
            expectedRevision: input.revision,
            actualRevision: snapshot.desiredRevision,
          });
        const now = DateTime.formatIso(yield* DateTime.now);
        return yield* saveSession(
          {
            ...snapshot,
            ...(input.status === "applied"
              ? { applied: snapshot.desired, appliedRevision: input.revision }
              : {}),
            application:
              input.status === "applied"
                ? { status: "applied", revision: input.revision, appliedAt: now }
                : {
                    status: input.status,
                    revision: input.revision,
                    failedAt: now,
                    reason: (input.reason ?? "MCP catalog application requires attention.").slice(
                      0,
                      512,
                    ),
                  },
          },
          input.status !== "applied",
        );
      }),
    ).pipe(Effect.ensuring(notifySessionChanges));
  });
  const pendingApplications = Effect.fn("McpCatalogService.pendingApplications")(function* (
    input: { readonly after?: string; readonly limit?: number } = {},
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const limit = Number.isFinite(input.limit ?? 100)
          ? Math.min(100, Math.max(1, Math.trunc(input.limit ?? 100)))
          : 100;
        const rows =
          yield* sql<SessionRow>`SELECT catalog_session_id,thread_id,project_id,snapshot_json,definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_sessions WHERE pending_apply=1 AND catalog_session_id>${input.after ?? ""} ORDER BY catalog_session_id LIMIT ${limit}`;
        return yield* Effect.forEach(rows, (row) =>
          decodeJson(McpCatalogSnapshot, row.snapshot_json),
        );
      }),
    );
  });
  const disposeSession = Effect.fn("McpCatalogService.disposeSession")(function* (
    input: CatalogSessionRequest,
  ) {
    yield* transaction(
      Effect.gen(function* () {
        const rows =
          yield* sql<SessionRow>`SELECT catalog_session_id,thread_id,project_id,snapshot_json,definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_sessions WHERE catalog_session_id=${input.mcpCatalogSessionId}`;
        if (!rows[0]) return;
        if (rows[0].thread_id !== input.threadId)
          return yield* fail("MCP catalog thread owner mismatch.");
        const snapshot = yield* decodeJson(McpCatalogSnapshot, rows[0].snapshot_json);
        yield* saveSession(
          { ...snapshot, disposedAt: DateTime.formatIso(yield* DateTime.now) },
          false,
        );
      }),
    ).pipe(Effect.ensuring(notifySessionChanges));
  });
  const retainedSessions = Effect.fn("McpCatalogService.retainedSessions")(function* () {
    const rows = yield* sql<{
      snapshot_json: string;
    }>`SELECT snapshot_json FROM t3_workflow_v2_mcp_catalog_sessions ORDER BY catalog_session_id`;
    const sessions = yield* Effect.forEach(rows, (row) =>
      decodeJson(McpCatalogSnapshot, row.snapshot_json),
    );
    return sessions.filter((snapshot) => snapshot.disposedAt === undefined);
  }, mapSqlErrors);
  const retainedDefinitions = Effect.fn("McpCatalogService.retainedDefinitions")(function* () {
    // Secret reconciliation must finish reading every retained generation before deleting any refs.
    return yield* transaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          definitions_json: string;
          overrides_json: string;
        }>`SELECT definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_scopes`;
        const definitions: Array<McpCatalogDefinition> = [];
        for (const row of rows) {
          definitions.push(
            ...(yield* decodeJson(Schema.Array(McpCatalogDefinition), row.definitions_json)),
          );
          const overrides = yield* decodeJson(Schema.Array(McpCatalogOverride), row.overrides_json);
          for (const override of overrides)
            if (override.transport && override.transportDefinitionId)
              definitions.push({
                definitionId: override.transportDefinitionId,
                logicalServerId: override.targetId,
                scope: override.scope,
                scopeId: override.scopeId,
                name: override.name ?? "Override",
                transport: override.transport,
                enabled: override.enabled ?? true,
                providerInstanceIds: override.providerInstanceIds ?? [],
                revision: 0,
              });
        }
        const sessions =
          yield* sql<SessionRow>`SELECT catalog_session_id,thread_id,project_id,snapshot_json,definitions_json,overrides_json FROM t3_workflow_v2_mcp_catalog_sessions`;
        for (const row of sessions) {
          const session = yield* decodeJson(McpCatalogSnapshot, row.snapshot_json);
          if (session.disposedAt) continue;
          definitions.push(
            ...session.baseline,
            ...session.desired,
            ...session.applied,
            ...(yield* decodeJson(Schema.Array(McpCatalogDefinition), row.definitions_json)),
          );
          const overrides = yield* decodeJson(Schema.Array(McpCatalogOverride), row.overrides_json);
          for (const override of overrides)
            if (override.transport && override.transportDefinitionId)
              definitions.push({
                definitionId: override.transportDefinitionId,
                logicalServerId: override.targetId,
                scope: override.scope,
                scopeId: override.scopeId,
                name: override.name ?? "Override",
                transport: override.transport,
                enabled: override.enabled ?? true,
                providerInstanceIds: override.providerInstanceIds ?? [],
                revision: 0,
              });
        }
        return definitions;
      }),
    );
  });
  const requestApplication = Effect.fn("McpCatalogService.requestApplication")(function* (
    input: CatalogSessionRequest,
  ) {
    return yield* transaction(
      Effect.gen(function* () {
        const snapshot = yield* getSession(input);
        return yield* saveSession(
          {
            ...snapshot,
            application: {
              status: "restart-required",
              revision: snapshot.desiredRevision,
              failedAt: DateTime.formatIso(yield* DateTime.now),
              reason: "The current provider runtime has not acknowledged this MCP catalog.",
            },
          },
          true,
        );
      }),
    ).pipe(Effect.ensuring(notifySessionChanges));
  });
  return {
    subscribeSessionChanges,
    read,
    readForWrite,
    write,
    authorizeWrite,
    getSession,
    getSessionForWrite,
    materializeSession,
    activeSessionForThread,
    pendingApplications,
    recordApplication,
    disposeSession,
    retainedSessions,
    retainedDefinitions,
    requestApplication,
  };
});
export class McpCatalogService extends Context.Service<
  McpCatalogService,
  Effect.Success<typeof make>
>()("t3/mcp/McpCatalogService") {}
export const layer = Layer.effect(McpCatalogService, make);
