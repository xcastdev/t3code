import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthSessionId,
  EnvironmentId,
  McpCatalogOperationError,
  McpServerId,
  McpDefinitionId,
  ThreadId,
  ProjectId,
  ProjectMcpCredentialId,
  ProjectMcpHeaderName,
  SecretRef,
  type McpCatalogWriteInput,
  type McpCatalogDefinition,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Option from "effect/Option";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Catalog from "./McpCatalogService.ts";
import * as Application from "./McpCatalogApplicationService.ts";
import * as Secrets from "./ProjectMcpSecretStore.ts";
import * as OAuth from "./ProjectMcpOAuth.ts";
import { McpCatalogClientService, layer } from "./McpCatalogClientService.ts";

const unused = (): never => {
  throw new Error("Unexpected dependency call");
};
const projectId = ProjectId.make("project");
const sessionId = AuthSessionId.make("human");
const secretRef = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");
const credentialId = ProjectMcpCredentialId.make("ab99d61a-33f1-42a2-9db3-fb748a265818");
const input: McpCatalogWriteInput = {
  scope: "project",
  scopeId: projectId,
  expectedRevision: 0,
  operation: {
    type: "create",
    definition: {
      name: "Docs",
      enabled: true,
      providerInstanceIds: [],
      transport: {
        type: "streamable-http",
        url: "https://example.test/mcp",
        headers: [
          {
            name: ProjectMcpHeaderName.make("Authorization"),
            credential: { name: "Key", secretRef },
          },
        ],
        authorization: { type: "none" },
      },
    },
  },
};

function fixture(
  options: {
    revoked?: boolean;
    stale?: boolean;
    revokeDuringPrepare?: boolean;
    expireDuringPrepare?: boolean;
    settingsOnly?: boolean;
    oauth?: boolean;
    committing?: Deferred.Deferred<void>;
    releaseCommit?: Deferred.Deferred<void>;
    failAfterPublication?: boolean;
    failSecretCommit?: boolean;
    retainedReadFails?: boolean;
  } = {},
) {
  const calls: Array<string> = [];
  let revoked = options.revoked === true;
  let expired = false;
  const state = {
    revision: 0,
    definitions: options.oauth
      ? [
          {
            definitionId: McpDefinitionId.make("definition"),
            logicalServerId: McpServerId.make("server"),
            scope: "project" as const,
            scopeId: projectId,
            revision: 0,
            name: "OAuth",
            enabled: true,
            providerInstanceIds: [],
            transport: {
              type: "streamable-http" as const,
              url: "https://example.test/mcp",
              headers: [],
              authorization: {
                type: "oauth" as const,
                registration: { type: "automatic" as const },
              },
            },
          },
        ]
      : [],
    overrides: [],
  };
  let published: Array<McpCatalogDefinition> = [];
  const catalog = Catalog.McpCatalogService.of({
    subscribeSessionChanges: Effect.die("unused"),
    activeSessionForThread: () =>
      Effect.sync(() => {
        calls.push("session-read");
        return undefined;
      }),
    read: (_input, actor) =>
      actor.scopes.includes(AuthOrchestrationReadScope)
        ? Effect.succeed(state)
        : Effect.fail(new McpCatalogOperationError({ message: "Missing read grant" })),
    readForWrite: (_input, actor) =>
      actor.scopes.includes(AuthSettingsWriteScope)
        ? Effect.succeed(state)
        : Effect.fail(new McpCatalogOperationError({ message: "Missing settings grant" })),
    getSessionForWrite: unused,
    authorizeWrite: () =>
      Effect.sync(() => {
        calls.push("authorize");
        return state;
      }),
    write: (request) =>
      Effect.sync(() => {
        calls.push("write");
        expect(JSON.stringify(request)).not.toContain("secret-value");
      }).pipe(
        Effect.andThen(
          options.stale
            ? Effect.fail(new McpCatalogOperationError({ message: "Stale revision" }))
            : Effect.gen(function* () {
                if (options.committing !== undefined && options.releaseCommit !== undefined) {
                  yield* Deferred.succeed(options.committing, undefined);
                  yield* Deferred.await(options.releaseCommit);
                  calls.push("sql-committed");
                }
                if (options.failAfterPublication) {
                  const operation = request.operation;
                  if (
                    (operation.type !== "create" && operation.type !== "update") ||
                    operation.logicalServerId === undefined ||
                    operation.definitionId === undefined
                  )
                    throw new Error("Expected prepared create");
                  published = [
                    {
                      ...operation.definition,
                      scope: request.scope,
                      scopeId: request.scopeId,
                      revision: 1,
                      definitionId: operation.definitionId,
                      logicalServerId: operation.logicalServerId,
                    },
                  ];
                  return yield* new McpCatalogOperationError({ message: "Uncertain commit" });
                }
                return { ...state, revision: 1 };
              }).pipe(Effect.uninterruptible),
        ),
      ),
    getSession: unused,
    materializeSession: unused,
    pendingApplications: unused,
    recordApplication: unused,
    disposeSession: unused,
    retainedSessions: unused,
    retainedDefinitions: () =>
      options.retainedReadFails
        ? Effect.fail(new McpCatalogOperationError({ message: "Read unavailable" }))
        : Effect.succeed(published),
    requestApplication: unused,
  });
  const store = Secrets.ProjectMcpSecretStore.of({
    prepareCreate: (_owner, draft) =>
      Effect.sync(() => {
        calls.push("prepare");
        if (options.revokeDuringPrepare) revoked = true;
        if (options.expireDuringPrepare) expired = true;
        expect(JSON.stringify(draft)).toContain("secret-value");
        return {
          transport: {
            type: "streamable-http" as const,
            url: "https://example.test/mcp",
            headers: [
              {
                name: ProjectMcpHeaderName.make("Authorization"),
                credential: { id: credentialId, name: "Key" },
              },
            ],
            authorization: { type: "none" as const },
          },
          commit: Effect.sync(() => {
            calls.push("commit");
          }).pipe(
            Effect.andThen(
              options.failSecretCommit ? Effect.die("Fixture finalization failed") : Effect.void,
            ),
          ),
          rollback: Effect.sync(() => {
            calls.push("rollback");
          }),
        };
      }),
    prepareUpdate: unused,
    retireTransport: unused,
    createAuxiliarySecret: unused,
    ensureOAuthStateOwner: unused,
    listAuxiliarySecrets: unused,
    listServerIds: unused,
    removeAuxiliarySecret: unused,
    removeServer: unused,
    resolve: unused,
    acquireLease: unused,
    acquireOAuthStateLease: unused,
    revokeOAuthState: unused,
    reconcile: unused,
  });
  const auth = AuthSessions.AuthSessionRepository.of({
    getById: () =>
      Effect.sync(() =>
        Option.some({
          sessionId,
          subject: "human",
          scopes: options.settingsOnly
            ? [AuthSettingsWriteScope]
            : [AuthOrchestrationReadScope, AuthSettingsWriteScope],
          method: "browser-session-cookie",
          client: {
            label: null,
            ipAddress: null,
            userAgent: null,
            deviceType: "unknown",
            os: null,
            browser: null,
          },
          issuedAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z"),
          expiresAt: DateTime.makeUnsafe(expired ? "1970-01-01T00:00:00Z" : "2099-01-01T00:00:00Z"),
          lastConnectedAt: null,
          revokedAt: revoked ? DateTime.makeUnsafe("2020-01-02T00:00:00Z") : null,
        }),
      ),
    create: unused,
    createReplacingActive: unused,
    createIfAbsent: unused,
    listActive: unused,
    revoke: unused,
    revokeAllExcept: unused,
    setLastConnectedAt: unused,
    setClientConnection: unused,
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(Catalog.McpCatalogService, catalog),
    Layer.succeed(Secrets.ProjectMcpSecretStore, store),
    Layer.succeed(AuthSessions.AuthSessionRepository, auth),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      getDescriptor: Effect.die("unused"),
    }),
    Layer.succeed(SecretRequests.SecretRequests, {
      answer: unused,
      prepareCatalog: (request) =>
        Effect.sync(() => {
          expect(request.authSessionId).toBe(sessionId);
          calls.push("secret-prepare");
          return secretRef;
        }),
      savedRef: unused,
      consume: (request) =>
        Effect.sync(() => {
          expect(request.ref).toBe(secretRef);
          expect(request.catalogBinding?.authSessionId).toBe(sessionId);
          expect(request.catalogBinding?.expectedRevision).toBe(0);
          if (request.catalogBinding?.scope === "global") expect(request.projectId).toBeUndefined();
          else expect(request.projectId).toBe(projectId);
          calls.push("consume");
          return "secret-value";
        }),
    }),
    Layer.succeed(Application.McpCatalogApplicationService, {
      prepareNativeRuntime: unused,
      requiresRestart: unused,
      recover: unused,
      reconnect: unused,
      disconnect: unused,
      drain: () =>
        Effect.sync(() => {
          calls.push("drain");
        }),
    }),
    Layer.succeed(OAuth.ProjectMcpOAuth, {
      status: () =>
        Effect.sync(() => {
          calls.push("oauth-status");
          return "authorization-pending" as const;
        }),
      providerFor: unused,
      begin: unused,
      continuePending: unused,
      completeCallback: unused,
      disconnect: unused,
    }),
    NodeCrypto.layer,
  );
  return { calls, layer: layer.pipe(Layer.provide(dependencies)) };
}

it.effect("rejects a revoked connected session before touching catalog or credentials", () =>
  Effect.gen(function* () {
    const test = fixture({ revoked: true });
    const error = yield* Effect.gen(function* () {
      const service = yield* McpCatalogClientService;
      return yield* service.write(input, sessionId);
    }).pipe(Effect.provide(test.layer), Effect.flip);
    expect(error._tag).toBe("McpCatalogOperationError");
    expect(test.calls).toEqual([]);
  }),
);
it.effect("consumes the project-bound ref and commits only redacted catalog references", () =>
  Effect.gen(function* () {
    const test = fixture();
    const result = yield* Effect.gen(function* () {
      const service = yield* McpCatalogClientService;
      return yield* service.write(input, sessionId);
    }).pipe(Effect.provide(test.layer));
    expect(result.revision).toBe(1);
    expect(test.calls).toEqual(["authorize", "consume", "prepare", "write", "commit", "drain"]);
  }),
);
it.effect("rolls back prepared credentials when the final catalog CAS fails", () =>
  Effect.gen(function* () {
    const test = fixture({ stale: true });
    yield* Effect.gen(function* () {
      const service = yield* McpCatalogClientService;
      return yield* service.write(input, sessionId);
    }).pipe(Effect.provide(test.layer), Effect.flip);
    expect(test.calls).toEqual(["authorize", "consume", "prepare", "write", "rollback"]);
  }),
);

it.effect("refuses a retained credential id when creating a different owner", () =>
  Effect.gen(function* () {
    const test = fixture();
    if (
      input.operation.type !== "create" ||
      input.operation.definition.transport.type !== "streamable-http"
    )
      throw new Error("Expected the HTTP create fixture.");
    const transport = input.operation.definition.transport;
    const request = {
      ...input,
      operation: {
        ...input.operation,
        definition: {
          ...input.operation.definition,
          transport: {
            ...transport,
            headers: [
              {
                name: ProjectMcpHeaderName.make("Authorization"),
                credential: { name: "Key", id: credentialId },
              },
            ],
          },
        },
      },
    };
    yield* Effect.gen(function* () {
      const service = yield* McpCatalogClientService;
      return yield* service.write(request, sessionId);
    }).pipe(Effect.provide(test.layer), Effect.flip);
    expect(test.calls).toEqual(["authorize"]);
  }),
);

it.effect("rolls back prepared credentials if authority is revoked during preparation", () =>
  Effect.gen(function* () {
    const test = fixture({ revokeDuringPrepare: true });
    yield* Effect.gen(function* () {
      const service = yield* McpCatalogClientService;
      return yield* service.write(input, sessionId);
    }).pipe(Effect.provide(test.layer), Effect.flip);
    expect(test.calls).toEqual(["authorize", "consume", "prepare", "rollback"]);
  }),
);

it.effect(
  "allows settings-only credential writes without an additional orchestration read grant",
  () =>
    Effect.gen(function* () {
      const test = fixture({ settingsOnly: true });
      yield* Effect.gen(function* () {
        const service = yield* McpCatalogClientService;
        return yield* service.write(input, sessionId);
      }).pipe(Effect.provide(test.layer));
      expect(test.calls).toEqual(["authorize", "consume", "prepare", "write", "commit", "drain"]);
    }),
);

it.effect("global human credential writes do not require a project", () =>
  Effect.gen(function* () {
    const test = fixture();
    yield* Effect.gen(function* () {
      const service = yield* McpCatalogClientService;
      const logicalServerId = McpServerId.make("chosen-server");
      const target = {
        scope: "global" as const,
        scopeId: "environment",
        expectedRevision: 0,
        logicalServerId,
      };
      const prepared = yield* service.secretPrepare(
        { ...target, secret: Redacted.make("secret-value") },
        sessionId,
      );
      expect(prepared.secretRef).toBe(secretRef);
      if (input.operation.type !== "create") throw new Error("Expected create");
      yield* service.write(
        { ...input, ...target, operation: { ...input.operation, logicalServerId } },
        sessionId,
      );
    }).pipe(Effect.provide(test.layer));
    expect(test.calls).toEqual([
      "authorize",
      "secret-prepare",
      "authorize",
      "consume",
      "prepare",
      "write",
      "commit",
      "drain",
    ]);
  }),
);
it.effect("thread-keyed reads return null without starting or draining providers", () =>
  Effect.gen(function* () {
    const test = fixture();
    const result = yield* Effect.gen(function* () {
      return yield* (yield* McpCatalogClientService).sessionForThread(
        { threadId: ThreadId.make("thread") },
        sessionId,
      );
    }).pipe(Effect.provide(test.layer));
    expect(result).toEqual({ snapshot: null });
    expect(test.calls).toEqual(["session-read"]);
  }),
);
it.effect("OAuth status exposes stored state without OAuth mutations or application work", () =>
  Effect.gen(function* () {
    const test = fixture({ oauth: true });
    const result = yield* Effect.gen(function* () {
      return yield* (yield* McpCatalogClientService).oauthStatus(
        {
          projectId,
          logicalServerId: McpServerId.make("server"),
          transportDefinitionId: McpDefinitionId.make("definition"),
        },
        sessionId,
      );
    }).pipe(Effect.provide(test.layer));
    expect(result).toEqual({ status: "authorization-pending" });
    expect(test.calls).toEqual(["oauth-status"]);
  }),
);

it.effect(
  "rolls back prepared credentials if the issuing session expires before catalog commit",
  () =>
    Effect.gen(function* () {
      const test = fixture({ expireDuringPrepare: true });
      yield* Effect.gen(function* () {
        return yield* (yield* McpCatalogClientService).write(input, sessionId);
      }).pipe(Effect.provide(test.layer), Effect.flip);
      expect(test.calls).toEqual(["authorize", "consume", "prepare", "rollback"]);
    }),
);

it.effect(
  "cancellation during masked SQL commit finalizes credentials instead of rolling them back",
  () =>
    Effect.gen(function* () {
      const committing = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const test = fixture({ committing, releaseCommit });
      const pending = yield* Effect.gen(function* () {
        return yield* (yield* McpCatalogClientService).write(input, sessionId);
      }).pipe(Effect.provide(test.layer), Effect.forkChild);
      yield* Deferred.await(committing);
      pending.interruptUnsafe();
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.await(pending);
      expect(test.calls).toContain("sql-committed");
      expect(test.calls).toContain("commit");
      expect(test.calls).not.toContain("rollback");
    }),
);

it.effect.each(["published", "unavailable"] as const)(
  "retains recovery bytes when failed publication is %s",
  (kind) =>
    Effect.gen(function* () {
      const test = fixture(
        kind === "published"
          ? { failAfterPublication: true }
          : { stale: true, retainedReadFails: true },
      );
      yield* Effect.gen(function* () {
        return yield* (yield* McpCatalogClientService).write(input, sessionId);
      }).pipe(Effect.provide(test.layer), Effect.exit);
      expect(test.calls).toContain("write");
      expect(test.calls).not.toContain("rollback");
      expect(test.calls).not.toContain("commit");
    }),
);
it.effect("preserves the recovery journal if secret finalization fails after publication", () =>
  Effect.gen(function* () {
    const test = fixture({ failSecretCommit: true });
    const result = yield* Effect.gen(function* () {
      return yield* (yield* McpCatalogClientService).write(input, sessionId);
    }).pipe(Effect.provide(test.layer), Effect.exit);
    expect(result._tag).toBe("Failure");
    expect(test.calls).toEqual(["authorize", "consume", "prepare", "write", "commit"]);
  }),
);
