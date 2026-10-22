import {
  AuthSettingsWriteScope,
  McpCatalogOperationError,
  McpDefinitionId,
  McpServerId,
  ProjectId,
  type AuthSessionId,
  type McpCatalogCredentialInput,
  type McpCatalogSecretPrepareInput,
  type McpCatalogSessionForThreadInput,
  type McpCatalogOAuthTarget,
  type McpCatalogReadInput,
  type McpCatalogSessionMutationInput,
  type McpCatalogSessionRequest,
  type McpCatalogTransportInput,
  type McpCatalogWriteInput,
  type ProjectMcpCredentialDraft,
  type ProjectMcpTransport,
  type ProjectMcpTransportDraft,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Catalog from "./McpCatalogService.ts";
import * as Application from "./McpCatalogApplicationService.ts";
import { catalogBaselineForProject } from "./McpCatalogResolver.ts";
import { hasCatalogTransportIdentityChange } from "./McpCatalogDefinitionIdentity.ts";
import * as Secrets from "./ProjectMcpSecretStore.ts";
import * as OAuth from "./ProjectMcpOAuth.ts";

const failure = () =>
  new McpCatalogOperationError({ message: "MCP catalog operation could not be completed." });

const mapTransport = Effect.fn("McpCatalogClientService.mapTransport")(function* (
  transport: McpCatalogTransportInput | ProjectMcpTransportDraft,
  credential: (
    input: McpCatalogCredentialInput | ProjectMcpCredentialDraft,
  ) => Effect.Effect<ProjectMcpCredentialDraft, McpCatalogOperationError>,
): Effect.fn.Return<ProjectMcpTransportDraft, McpCatalogOperationError> {
  if (transport.type === "stdio")
    return {
      ...transport,
      env: yield* Effect.forEach(transport.env, (item) =>
        credential(item.credential).pipe(
          Effect.map((value) => ({ name: item.name, credential: value })),
        ),
      ),
    } satisfies ProjectMcpTransportDraft;
  const registration =
    transport.authorization.type === "oauth" ? transport.authorization.registration : undefined;
  return {
    ...transport,
    headers: yield* Effect.forEach(transport.headers, (item) =>
      credential(item.credential).pipe(
        Effect.map((value) => ({ name: item.name, credential: value })),
      ),
    ),
    authorization:
      registration === undefined
        ? { type: "none" as const }
        : {
            type: "oauth" as const,
            registration:
              registration.type === "automatic"
                ? registration
                : {
                    type: "pre-registered" as const,
                    clientId: registration.clientId,
                    ...(registration.clientSecret === undefined
                      ? {}
                      : { clientSecret: yield* credential(registration.clientSecret) }),
                  },
          },
  } satisfies ProjectMcpTransportDraft;
});

const make = Effect.gen(function* () {
  const catalog = yield* Catalog.McpCatalogService;
  const application = yield* Application.McpCatalogApplicationService;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const secrets = yield* Secrets.ProjectMcpSecretStore;
  const requests = yield* SecretRequests.SecretRequests;
  const oauth = yield* OAuth.ProjectMcpOAuth;
  const crypto = yield* Crypto.Crypto;
  // A WebSocket can outlive its grant; resolve persisted authority on each call.
  const actorFor = Effect.fn("McpCatalogClientService.actorFor")(function* (
    sessionId: AuthSessionId,
  ) {
    const row = yield* sessions.getById({ sessionId }).pipe(Effect.mapError(failure));
    const now = yield* DateTime.now;
    if (
      Option.isNone(row) ||
      row.value.revokedAt !== null ||
      row.value.expiresAt.epochMilliseconds <= now.epochMilliseconds
    )
      return yield* failure();
    return {
      environmentId: yield* environment.getEnvironmentId,
      authSessionId: sessionId,
      scopes: row.value.scopes,
    } satisfies Catalog.McpCatalogActor;
  });
  const read = Effect.fn("McpCatalogClientService.read")(function* (
    input: McpCatalogReadInput,
    sessionId: AuthSessionId,
  ) {
    return yield* catalog.read(input, yield* actorFor(sessionId));
  });
  const sessionGet = Effect.fn("McpCatalogClientService.sessionGet")(function* (
    input: McpCatalogSessionRequest,
    sessionId: AuthSessionId,
  ) {
    return yield* catalog.getSession(input, yield* actorFor(sessionId));
  });
  const sessionForThread = Effect.fn("McpCatalogClientService.sessionForThread")(function* (
    input: McpCatalogSessionForThreadInput,
    sessionId: AuthSessionId,
  ) {
    const snapshot = yield* catalog.activeSessionForThread(
      input.threadId,
      yield* actorFor(sessionId),
    );
    return { snapshot: snapshot ?? null };
  });
  const sessionSubscribeForThread = (
    input: McpCatalogSessionForThreadInput,
    sessionId: AuthSessionId,
  ) =>
    Stream.unwrap(catalog.subscribeSessionChanges).pipe(
      Stream.mapEffect(() => sessionForThread(input, sessionId)),
    );
  const secretPrepare = Effect.fn("McpCatalogClientService.secretPrepare")(function* (
    input: McpCatalogSecretPrepareInput,
    sessionId: AuthSessionId,
  ) {
    yield* catalog.authorizeWrite(input, yield* actorFor(sessionId));
    return {
      secretRef: yield* requests
        .prepareCatalog({ ...input, authSessionId: sessionId })
        .pipe(Effect.mapError(failure)),
    };
  });
  const write = Effect.fn("McpCatalogClientService.write")(function* (
    input: McpCatalogWriteInput,
    sessionId: AuthSessionId,
  ) {
    const actor = yield* actorFor(sessionId);
    const current = yield* catalog.authorizeWrite(input, actor);
    const operation = input.operation;
    let prepared: Secrets.PreparedProjectMcpSecrets | undefined;
    let preparedDefinitionId: McpDefinitionId | undefined;
    let persisted: Catalog.PersistedMcpCatalogWriteInput["operation"];
    const projectId =
      input.scope === "project" ? ProjectId.make(input.scopeId) : input.credentialProjectId;
    if (projectId !== undefined) {
      yield* catalog.readForWrite({ scope: "project", scopeId: projectId }, actor);
      if (input.scope === "session") yield* catalog.authorizeWrite(input, { ...actor, projectId });
    }
    const consume = (
      logicalServerId: McpServerId,
      credential: McpCatalogCredentialInput | ProjectMcpCredentialDraft,
    ): Effect.Effect<ProjectMcpCredentialDraft, McpCatalogOperationError> => {
      if ("secretRef" in credential && credential.secretRef !== undefined)
        return requests
          .consume({
            ...(projectId === undefined ? {} : { projectId }),
            ref: credential.secretRef,
            catalogBinding: {
              authSessionId: sessionId,
              scope: input.scope,
              scopeId: input.scopeId,
              expectedRevision: input.expectedRevision,
              logicalServerId,
            },
          })
          .pipe(
            Effect.map((value) => ({ name: credential.name, value })),
            Effect.mapError(failure),
          );
      return Effect.succeed({
        name: credential.name,
        ...(credential.id === undefined ? {} : { id: credential.id }),
      });
    };
    const prepare = Effect.fn("McpCatalogClientService.prepare")(function* (
      logicalServerId: McpServerId,
      transport: McpCatalogTransportInput,
      previous?: {
        readonly definitionId: McpDefinitionId;
        readonly transport: ProjectMcpTransport;
      },
    ) {
      let draft = yield* mapTransport(transport, (credential) =>
        consume(logicalServerId, credential),
      );
      if (previous !== undefined && !hasCatalogTransportIdentityChange(previous.transport, draft)) {
        return {
          definitionId: previous.definitionId,
          prepared: yield* secrets
            .prepareUpdate(
              Secrets.credentialOwnerIdForDefinition(logicalServerId, previous.definitionId),
              previous.transport,
              draft,
            )
            .pipe(Effect.mapError(failure)),
        };
      }
      const definitionId = McpDefinitionId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      draft = yield* mapTransport(draft, (credential) => {
        if ("value" in credential && credential.value !== undefined)
          return Effect.succeed({ name: credential.name, value: credential.value });
        if (previous === undefined || credential.id === undefined) return Effect.fail(failure());
        return secrets
          .resolve(
            Secrets.credentialOwnerIdForDefinition(logicalServerId, previous.definitionId),
            credential.id,
          )
          .pipe(
            Effect.map((value) => ({ name: credential.name, value })),
            Effect.mapError(failure),
          );
      });
      return {
        definitionId,
        prepared: yield* secrets
          .prepareCreate(
            Secrets.credentialOwnerIdForDefinition(logicalServerId, definitionId),
            draft,
          )
          .pipe(Effect.mapError(failure)),
      };
    });
    if (operation.type === "create" || operation.type === "update") {
      const logicalServerId =
        operation.logicalServerId ??
        McpServerId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const previous = current.definitions.find((item) => item.logicalServerId === logicalServerId);
      if ((operation.type === "create") === (previous !== undefined)) return yield* failure();
      const result = yield* prepare(logicalServerId, operation.definition.transport, previous);
      prepared = result.prepared;
      preparedDefinitionId = result.definitionId;
      persisted = {
        ...operation,
        logicalServerId,
        definitionId: result.definitionId,
        definition: { ...operation.definition, transport: prepared.transport },
      };
    } else if (operation.type === "put-override" && operation.override.transport !== undefined) {
      const old = current.overrides.find((item) => item.id === operation.override.id);
      const result = yield* prepare(
        operation.override.targetId,
        operation.override.transport,
        old?.transport !== undefined && old.transportDefinitionId !== undefined
          ? { definitionId: old.transportDefinitionId, transport: old.transport }
          : undefined,
      );
      prepared = result.prepared;
      preparedDefinitionId = result.definitionId;
      persisted = {
        type: "put-override",
        override: {
          ...operation.override,
          transportDefinitionId: result.definitionId,
          transport: prepared.transport,
        },
      };
    } else if (operation.type === "put-override") {
      const { transport: _transport, ...override } = operation.override;
      persisted = { type: "put-override", override };
    } else persisted = operation;
    // SQL commit masks cancellation. Finalize its credentials in the same mask so
    // a pending interruption cannot turn an accepted commit into secret rollback.
    const result = yield* actorFor(sessionId).pipe(
      Effect.tapError(() => prepared?.rollback.pipe(Effect.ignore) ?? Effect.void),
      Effect.flatMap((currentActor) =>
        catalog.write({ ...input, operation: persisted }, currentActor).pipe(
          Effect.onError(() => {
            if (prepared === undefined) return Effect.void;
            const pending = prepared;
            // A failed/uncertain commit may have published the references. Only
            // discard bytes when a durable read proves they were not published.
            return catalog.retainedDefinitions().pipe(
              Effect.flatMap((definitions) =>
                definitions.some(
                  (definition) =>
                    definition.definitionId === preparedDefinitionId &&
                    Secrets.credentialIdsForTransport(pending.transport).some((id) =>
                      Secrets.credentialIdsForTransport(definition.transport).includes(id),
                    ),
                )
                  ? Effect.void
                  : pending.rollback,
              ),
              Effect.ignore,
            );
          }),
        ),
      ),
      Effect.tap(() => prepared?.commit.pipe(Effect.mapError(failure)) ?? Effect.void),
      Effect.uninterruptible,
    );
    yield* application.drain().pipe(Effect.ignore);
    return result;
  });
  const sessionReset = Effect.fn("McpCatalogClientService.sessionReset")(function* (
    input: McpCatalogSessionMutationInput,
    sessionId: AuthSessionId,
  ) {
    yield* catalog.getSessionForWrite(input, yield* actorFor(sessionId));
    yield* write(
      {
        scope: "session",
        scopeId: input.mcpCatalogSessionId,
        expectedRevision: input.expectedRevision,
        operation: { type: "reset" },
      },
      sessionId,
    );
    return yield* catalog.getSessionForWrite(input, yield* actorFor(sessionId));
  });
  const oauthBinding = Effect.fn("McpCatalogClientService.oauthBinding")(function* (
    input: McpCatalogOAuthTarget,
    sessionId: AuthSessionId,
    readOnly = false,
  ) {
    const actor = yield* actorFor(sessionId);
    if (!readOnly && !actor.scopes.includes(AuthSettingsWriteScope)) return yield* failure();
    const project = yield* (readOnly ? catalog.read : catalog.readForWrite)(
      { scope: "project", scopeId: input.projectId },
      actor,
    );
    const global = yield* (readOnly ? catalog.read : catalog.readForWrite)(
      { scope: "global", scopeId: actor.environmentId },
      actor,
    );
    const definitions =
      input.threadId !== undefined && input.mcpCatalogSessionId !== undefined
        ? (yield* (readOnly ? catalog.getSession : catalog.getSessionForWrite)(
            { threadId: input.threadId, mcpCatalogSessionId: input.mcpCatalogSessionId },
            { ...actor, projectId: input.projectId },
          )).desired
        : catalogBaselineForProject({
            globalDefinitions: global.definitions,
            projectDefinitions: project.definitions,
            projectOverrides: project.overrides,
            projectId: input.projectId,
          });
    const definition = definitions.find(
      (item) =>
        item.logicalServerId === input.logicalServerId &&
        item.definitionId === input.transportDefinitionId,
    );
    if (definition === undefined) return yield* failure();
    const owner = Secrets.credentialOwnerIdForDefinition(
      definition.logicalServerId,
      definition.definitionId,
    );
    const binding = yield* OAuth.resolveServerBinding(
      { id: owner, transport: definition.transport },
      secrets.resolve,
    ).pipe(Effect.mapError(failure));
    if (binding === undefined) return yield* failure();
    if (!readOnly) yield* secrets.ensureOAuthStateOwner(owner).pipe(Effect.mapError(failure));
    return { owner, binding };
  });
  const oauthStatus = Effect.fn("McpCatalogClientService.oauthStatus")(function* (
    input: McpCatalogOAuthTarget,
    sessionId: AuthSessionId,
  ) {
    const { owner, binding } = yield* oauthBinding(input, sessionId, true);
    return { status: yield* oauth.status(owner, binding).pipe(Effect.mapError(failure)) };
  });
  const oauthBegin = Effect.fn("McpCatalogClientService.oauthBegin")(function* (
    input: McpCatalogOAuthTarget,
    sessionId: AuthSessionId,
    redirectOrigin: string | undefined,
  ) {
    if (
      redirectOrigin === undefined ||
      OAuth.parseProjectMcpOAuthOrigin(redirectOrigin) === undefined
    )
      return yield* failure();
    const { owner, binding } = yield* oauthBinding(input, sessionId);
    return yield* oauth
      .begin({ serverId: owner, server: binding, redirectOrigin })
      .pipe(Effect.mapError(failure));
  });
  const oauthContinue = Effect.fn("McpCatalogClientService.oauthContinue")(function* (
    input: McpCatalogOAuthTarget,
    sessionId: AuthSessionId,
  ) {
    const { owner, binding } = yield* oauthBinding(input, sessionId);
    yield* oauth.continuePending(owner, binding).pipe(Effect.mapError(failure));
    yield* application.drain().pipe(Effect.ignore);
  });
  const oauthDisconnect = Effect.fn("McpCatalogClientService.oauthDisconnect")(function* (
    input: McpCatalogOAuthTarget,
    sessionId: AuthSessionId,
  ) {
    const { owner } = yield* oauthBinding(input, sessionId);
    yield* oauth.disconnect(owner).pipe(Effect.mapError(failure));
    yield* application.disconnect(owner).pipe(Effect.ignore);
  });
  return {
    read,
    write,
    sessionGet,
    sessionForThread,
    sessionSubscribeForThread,
    secretPrepare,
    sessionReset,
    oauthStatus,
    oauthBegin,
    oauthContinue,
    oauthDisconnect,
  };
});
export class McpCatalogClientService extends Context.Service<
  McpCatalogClientService,
  Effect.Success<typeof make>
>()("t3/mcp/McpCatalogClientService") {}
export const layer = Layer.effect(McpCatalogClientService, make);
