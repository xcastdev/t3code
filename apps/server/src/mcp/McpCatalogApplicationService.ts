import type {
  McpCatalogSnapshot,
  McpServerId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { McpCatalogService } from "./McpCatalogService.ts";
import { McpCatalogGateway } from "./McpCatalogGateway.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import { ProjectMcpSecretStore, credentialOwnerIdForDefinition } from "./ProjectMcpSecretStore.ts";
import { ProjectMcpOAuth } from "./ProjectMcpOAuth.ts";
import { resolveSessionCatalog } from "./McpCatalogResolver.ts";

const make = Effect.gen(function* () {
  const catalog = yield* McpCatalogService;
  const gateway = yield* McpCatalogGateway;
  const sessions = yield* McpProviderSessions;
  const registry = yield* McpSessionRegistry;
  const secrets = yield* ProjectMcpSecretStore;
  const oauth = yield* ProjectMcpOAuth;
  const prepareLock = yield* KeyedLock.make<ThreadId>();
  const stage = Effect.fn("McpCatalogApplicationService.stage")(function* (
    snapshot: McpCatalogSnapshot,
    force = false,
  ) {
    const config = yield* sessions.read(snapshot.threadId);
    if (!config?.nativeRuntimeId || config.providerInstanceId !== snapshot.providerInstanceId)
      return false;
    const existing = yield* gateway.resolveProviderSession(
      config.providerSessionId,
      snapshot.catalogSessionId,
    );
    if (
      !force &&
      existing?.revision === snapshot.desiredRevision &&
      existing.runtimeId === config.nativeRuntimeId
    )
      return true;
    yield* gateway.applyCatalogRevision({
      catalogSessionId: snapshot.catalogSessionId,
      threadId: snapshot.threadId,
      providerInstanceId: snapshot.providerInstanceId,
      providerSessionId: config.providerSessionId,
      runtimeId: config.nativeRuntimeId,
      revision: snapshot.desiredRevision,
      entries: resolveSessionCatalog({
        desired: snapshot.desired,
        providerInstanceId: snapshot.providerInstanceId,
        providerCapability: "live",
      }),
    });
    return yield* sessions.replaceIfCurrent(
      {
        threadId: config.threadId,
        providerSessionId: config.providerSessionId,
        nativeRuntimeId: config.nativeRuntimeId,
      },
      { ...config, catalogRevision: snapshot.desiredRevision },
    );
  });
  const record = Effect.fn("McpCatalogApplicationService.record")(function* (
    snapshot: McpCatalogSnapshot,
  ) {
    const config = yield* sessions.read(snapshot.threadId);
    const receipt = yield* sessions.readCatalogEndpointReceipt(snapshot.threadId);
    const binding = config
      ? yield* registry.resolveNativeRuntime(config.providerSessionId)
      : undefined;
    const applied =
      binding?.runtimeId === config?.nativeRuntimeId &&
      binding !== undefined &&
      config?.nativeRuntimeId !== undefined &&
      receipt?.nativeRuntimeId === config.nativeRuntimeId &&
      receipt.providerSessionId === config.providerSessionId &&
      receipt.catalogRevision === snapshot.desiredRevision;
    yield* catalog.recordApplication({
      threadId: snapshot.threadId,
      mcpCatalogSessionId: snapshot.catalogSessionId,
      revision: snapshot.desiredRevision,
      status: applied ? "applied" : "restart-required",
      ...(applied
        ? {}
        : { reason: "Restart the provider session to load the current MCP catalog." }),
    });
  });
  const reconcile = Effect.fn("McpCatalogApplicationService.reconcile")(function* () {
    const definitions = yield* catalog.retainedDefinitions();
    yield* secrets.reconcile(
      definitions.map((definition) => {
        const owner = credentialOwnerIdForDefinition(
          definition.logicalServerId,
          definition.definitionId,
        );
        return {
          id: owner,
          transport: definition.transport,
          ...(definition.transport.type !== "stdio" &&
          definition.transport.authorization.type === "oauth"
            ? { oauthStateOwnerId: owner }
            : {}),
        };
      }),
    );
  });
  const applySnapshot = Effect.fn("McpCatalogApplicationService.applySnapshot")(function* (
    snapshot: McpCatalogSnapshot,
  ) {
    yield* stage(snapshot).pipe(
      Effect.flatMap((staged) => (staged ? record(snapshot) : Effect.void)),
      Effect.catch(() =>
        catalog
          .recordApplication({
            threadId: snapshot.threadId,
            mcpCatalogSessionId: snapshot.catalogSessionId,
            revision: snapshot.desiredRevision,
            status: "failed",
            reason: "MCP upstream staging failed; the previous catalog remains active.",
          })
          .pipe(Effect.ignore),
      ),
    );
  });
  const drain = Effect.fn("McpCatalogApplicationService.drain")(function* () {
    let after: string | undefined;
    while (true) {
      const pending = yield* catalog.pendingApplications(after ? { after } : {});
      if (!pending.length) return;
      for (const snapshot of pending)
        yield* prepareLock.withLock(snapshot.threadId, applySnapshot(snapshot));
      after = pending.at(-1)!.catalogSessionId;
    }
  });
  const prepareNativeRuntime = Effect.fn("McpCatalogApplicationService.prepareNativeRuntime")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly runtimeId: string;
    }) {
      const config = yield* sessions.read(input.threadId);
      if (
        !config ||
        config.providerInstanceId !== input.providerInstanceId ||
        (config.nativeRuntimeId !== undefined && config.nativeRuntimeId !== input.runtimeId)
      )
        return;
      const stillCurrent = () =>
        sessions
          .read(input.threadId)
          .pipe(
            Effect.map(
              (actual) =>
                actual?.providerSessionId === config.providerSessionId &&
                actual.nativeRuntimeId === config.nativeRuntimeId,
            ),
          );
      const previous = yield* catalog.activeSessionForThread(input.threadId);
      if (!(yield* stillCurrent())) return;
      if (previous && previous.providerInstanceId !== input.providerInstanceId) {
        const oldGateway = yield* gateway.resolveCatalogSession(previous.catalogSessionId);
        if (!(yield* stillCurrent())) return;
        if (oldGateway) yield* registry.revokeProviderSession(oldGateway.providerSessionId);
        if (!(yield* stillCurrent())) return;
        yield* gateway.disposeCatalogSession(previous.catalogSessionId);
      }
      if (!(yield* stillCurrent())) return;
      const snapshot = yield* catalog.materializeSession(input);
      if (
        !(yield* sessions.replaceIfCurrent(
          {
            threadId: config.threadId,
            providerSessionId: config.providerSessionId,
            ...(config.nativeRuntimeId === undefined
              ? {}
              : { nativeRuntimeId: config.nativeRuntimeId }),
          },
          { ...config, nativeRuntimeId: input.runtimeId },
        ))
      )
        return;
      yield* catalog.requestApplication({
        threadId: snapshot.threadId,
        mcpCatalogSessionId: snapshot.catalogSessionId,
      });
      yield* registry.bindNativeRuntime({
        ...input,
        providerSessionId: config.providerSessionId,
      });
      const activeConfig = yield* sessions.read(input.threadId);
      if (
        activeConfig?.providerSessionId === config.providerSessionId &&
        activeConfig.nativeRuntimeId === input.runtimeId
      )
        yield* stage(snapshot);
    },
  );
  const service = {
    disconnect: Effect.fn("McpCatalogApplicationService.disconnect")(function* (
      owner: McpServerId,
    ) {
      const affected = (yield* catalog.retainedSessions()).filter((snapshot) =>
        [...snapshot.desired, ...snapshot.applied].some(
          (definition) =>
            credentialOwnerIdForDefinition(definition.logicalServerId, definition.definitionId) ===
            owner,
        ),
      );
      yield* Effect.forEach(
        affected,
        (snapshot) => gateway.disposeCatalogSession(snapshot.catalogSessionId),
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.forEach(
        affected,
        (snapshot) =>
          prepareLock.withLock(
            snapshot.threadId,
            Effect.gen(function* () {
              yield* catalog.requestApplication({
                threadId: snapshot.threadId,
                mcpCatalogSessionId: snapshot.catalogSessionId,
              });
            }),
          ),
        { concurrency: "unbounded", discard: true },
      );
      yield* drain();
    }),
    recover: Effect.fn("McpCatalogApplicationService.recover")(function* () {
      yield* reconcile();
      yield* drain();
    }),
    reconnect: Effect.fn("McpCatalogApplicationService.reconnect")(function* () {
      for (const snapshot of yield* catalog.retainedSessions()) {
        yield* prepareLock.withLock(
          snapshot.threadId,
          Effect.gen(function* () {
            yield* catalog.requestApplication({
              threadId: snapshot.threadId,
              mcpCatalogSessionId: snapshot.catalogSessionId,
            });
            yield* stage(snapshot, true).pipe(
              Effect.flatMap((staged) => (staged ? record(snapshot) : Effect.void)),
              Effect.catch(() =>
                catalog
                  .recordApplication({
                    threadId: snapshot.threadId,
                    mcpCatalogSessionId: snapshot.catalogSessionId,
                    revision: snapshot.desiredRevision,
                    status: "failed",
                    reason: "MCP reconnect failed; the previous catalog remains active.",
                  })
                  .pipe(Effect.ignore),
              ),
            );
          }),
        );
      }
    }),
    requiresRestart: Effect.fn("McpCatalogApplicationService.requiresRestart")(function* (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
      readonly providerInstanceId: ProviderInstanceId;
    }) {
      const existing = yield* catalog.activeSessionForThread(input.threadId);
      if (existing && existing.providerInstanceId !== input.providerInstanceId) return true;
      const snapshot = existing ?? (yield* catalog.materializeSession(input));
      const receipt = yield* sessions.readCatalogEndpointReceipt(input.threadId);
      const config = yield* sessions.read(input.threadId);
      if (snapshot.desired.length === 0 && snapshot.applied.length === 0) return false;
      return (
        receipt?.catalogRevision !== snapshot.desiredRevision ||
        receipt.nativeRuntimeId !== config?.nativeRuntimeId
      );
    }),
    prepareNativeRuntime: (input: Parameters<typeof prepareNativeRuntime>[0]) =>
      prepareLock.withLock(input.threadId, prepareNativeRuntime(input)),
    drain,
  };
  yield* Effect.acquireRelease(
    sessions.onCatalogEndpointAcknowledged((acknowledged) =>
      prepareLock
        .withLock(
          acknowledged.threadId,
          Effect.gen(function* () {
            const current = yield* sessions.read(acknowledged.threadId);
            if (
              current?.providerSessionId !== acknowledged.providerSessionId ||
              current.nativeRuntimeId !== acknowledged.nativeRuntimeId ||
              current.catalogRevision !== acknowledged.catalogRevision
            )
              return;
            const snapshot = yield* catalog.activeSessionForThread(acknowledged.threadId);
            if (snapshot) yield* applySnapshot(snapshot);
          }),
        )
        .pipe(Effect.ignore),
    ),
    (dispose) => Effect.sync(dispose),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      oauth.setAuthorizedHandler?.(() =>
        Effect.runPromise(service.reconnect().pipe(Effect.ignore)),
      );
    }),
    () =>
      Effect.sync(() => {
        oauth.setAuthorizedHandler?.(undefined);
      }),
  );
  return service;
});
export class McpCatalogApplicationService extends Context.Service<
  McpCatalogApplicationService,
  Effect.Success<typeof make>
>()("t3/mcp/McpCatalogApplicationService") {}
export const layer = Layer.effect(McpCatalogApplicationService, make);
