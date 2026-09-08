import * as NodeCrypto from "node:crypto";
import type {
  McpServerId,
  ProjectMcpCredentialId,
  ResolvedProjectMcpServer,
  ThreadId,
} from "@t3tools/contracts";
import {
  InMemoryServerEventBus,
  Server,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isLegacyRequest,
  type McpHttpHandler,
  type Notification,
  type Progress,
  type RequestOptions,
  type ServerContext,
  type ServerNotifier,
} from "@modelcontextprotocol/server";
import {
  JSONObjectSchema,
  JSONValueSchema,
  SubscriptionFilterSchema,
} from "@modelcontextprotocol/core";
import type { ClientContext } from "@modelcontextprotocol/client";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";

import type { ConnectProjectMcpServerInput, ProjectMcpConnection } from "./ProjectMcpConnection.ts";
import {
  connectProjectMcpServer,
  projectMcpConnectionCoordinator,
} from "./ProjectMcpConnection.ts";
import { ProjectMcpBroker } from "./ProjectMcpBroker.ts";
import * as ProjectMcpOAuth from "./ProjectMcpOAuth.ts";
import * as ProjectMcpSecretStore from "./ProjectMcpSecretStore.ts";

const randomEndpointHandle = NodeCrypto.randomUUID;

export type ProjectMcpProxyConnect = (
  input: ConnectProjectMcpServerInput,
) => Promise<ProjectMcpConnection>;

export interface ProjectMcpProxyEndpoint {
  readonly endpointHandle: string;
  readonly endpoint: URL;
  readonly id: McpServerId;
  readonly name: string;
}

export interface ProjectMcpProxySessionInput {
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly servers: ReadonlyArray<ResolvedProjectMcpServer>;
  /** Used by tests and by secret-store integrations that already own a lease. */
  readonly resolveSecret?: (serverId: McpServerId, credentialId: string) => string | undefined;
}

export type ProjectMcpProxyErrorCode =
  | "unauthorized"
  | "unknown_endpoint"
  | "session_revoked"
  | "upstream_connection_failed"
  | "upstream_request_failed";

export class ProjectMcpProxyError extends Error {
  readonly _tag: string = "ProjectMcpProxyError";
  readonly code: ProjectMcpProxyErrorCode;
  override readonly cause?: unknown;

  constructor(code: ProjectMcpProxyErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.cause = cause;
    this.name = "ProjectMcpProxyError";
  }
}

export class ProjectMcpProxyUnauthorizedError extends ProjectMcpProxyError {
  override readonly _tag: string = "ProjectMcpProxyUnauthorizedError";

  constructor() {
    super("unauthorized", "The MCP proxy endpoint is not authorized for this session.");
    this.name = "ProjectMcpProxyUnauthorizedError";
  }
}

export class ProjectMcpProxyUnknownEndpointError extends ProjectMcpProxyError {
  override readonly _tag: string = "ProjectMcpProxyUnknownEndpointError";

  constructor() {
    super("unknown_endpoint", "The MCP proxy endpoint does not exist.");
    this.name = "ProjectMcpProxyUnknownEndpointError";
  }
}

interface ConnectionRecord {
  readonly server: ResolvedProjectMcpServer;
  readonly resolveSecret?: ProjectMcpProxySessionInput["resolveSecret"];
  readonly opening: Promise<ProjectMcpConnection>;
  modernBroker?: ProjectMcpBroker;
  modernBrokerOpening?: Promise<ProjectMcpBroker>;
  readonly modernBus: InMemoryServerEventBus;
  readonly modernHandlers: Set<McpHttpHandler>;
  readonly legacySessions: Map<string, LegacySessionRecord>;
}

interface LegacySessionRecord {
  readonly broker: ProjectMcpBroker;
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
}

interface SessionRecord {
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly servers: ReadonlyMap<string, ResolvedProjectMcpServer>;
  readonly endpoints: ReadonlyMap<string, ProjectMcpProxyEndpoint>;
  readonly connections: Map<string, ConnectionRecord>;
  readonly resolveSecret?: ProjectMcpProxySessionInput["resolveSecret"];
  readonly revokedServerIds: Set<McpServerId>;
  revoked: boolean;
}

export interface ProjectMcpProxyRegistryShape {
  readonly registerSession: (
    input: ProjectMcpProxySessionInput,
  ) => Effect.Effect<ReadonlyArray<ProjectMcpProxyEndpoint>>;
  readonly resolve: (
    providerSessionId: string,
    endpointHandle: string,
  ) => Effect.Effect<
    { readonly server: ResolvedProjectMcpServer; readonly threadId: ThreadId } | undefined
  >;
  readonly handle: (
    providerSessionId: string,
    endpointHandle: string,
    request: Request,
  ) => Effect.Effect<Response, ProjectMcpProxyError>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeServer: (serverId: McpServerId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class ProjectMcpProxyRegistry extends Context.Service<
  ProjectMcpProxyRegistry,
  ProjectMcpProxyRegistryShape
>()("t3/mcp/ProjectMcpProxyRegistry") {}

export interface ProjectMcpProxyRegistryOptions {
  readonly endpointBase?: string;
  readonly connect?: ProjectMcpProxyConnect;
  readonly now?: () => number;
}

const endpointBaseFromHttpServer = (httpServer: HttpServer.HttpServer["Service"]): string => {
  if (httpServer.address._tag !== "TcpAddress") return "http://127.0.0.1/mcp";
  const hostname =
    httpServer.address.hostname === "0.0.0.0" || httpServer.address.hostname === "::"
      ? "127.0.0.1"
      : httpServer.address.hostname;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${host}:${httpServer.address.port}/mcp`;
};

const credentialIds = (server: ResolvedProjectMcpServer): ReadonlyArray<ProjectMcpCredentialId> => {
  if (server.transport.type === "stdio") {
    return server.transport.env.map(({ credential }) => credential.id);
  }
  return [
    ...server.transport.headers.map(({ credential }) => credential.id),
    ...(server.transport.authorization.type === "oauth" &&
    server.transport.authorization.registration.type === "pre-registered" &&
    server.transport.authorization.registration.clientSecret !== undefined
      ? [server.transport.authorization.registration.clientSecret.id]
      : []),
  ];
};

const makeServer = (broker: ProjectMcpBroker, notifier?: ServerNotifier): Server => {
  const discovered = broker.discoverResult;
  const discoveredInfo: unknown = discovered?.serverInfo ?? broker.serverVersion;
  const serverInfo =
    typeof discoveredInfo === "object" &&
    discoveredInfo !== null &&
    typeof (discoveredInfo as { name?: unknown }).name === "string" &&
    typeof (discoveredInfo as { version?: unknown }).version === "string"
      ? {
          name: (discoveredInfo as { name: string }).name,
          version: (discoveredInfo as { version: string }).version,
        }
      : { name: "T3 Code MCP proxy", version: "1" };
  const server = new Server(serverInfo);
  const rootsOwner = {};
  const capabilities = discovered?.capabilities ?? broker.serverCapabilities ?? {};
  server.registerCapabilities(capabilities);
  const requestOptions = (context: ServerContext): RequestOptions => ({
    signal: context.mcpReq.signal,
    onprogress: (progress: Progress) => {
      const progressToken = context.mcpReq._meta?.progressToken;
      if (progressToken === undefined) return;
      void context.mcpReq.notify({
        method: "notifications/progress",
        params: { ...progress, progressToken },
      } satisfies Notification);
    },
  });
  const continuationParams = (params: object, context: ServerContext): Record<string, unknown> => ({
    ...(params as Record<string, unknown>),
    ...(context.mcpReq.inputResponses === undefined
      ? {}
      : { inputResponses: context.mcpReq.inputResponses }),
    ...(typeof context.mcpReq.requestState() !== "string"
      ? {}
      : { requestState: context.mcpReq.requestState() }),
  });
  server.setRequestHandler("ping", (_request, context) => broker.ping(requestOptions(context)));
  (
    server as unknown as {
      fallbackRequestHandler: (request: unknown, context: ServerContext) => Promise<unknown>;
    }
  ).fallbackRequestHandler = (request, context) => {
    const extension = request as {
      readonly method: string;
      readonly params?: Record<string, unknown>;
    };
    return broker.requestExtension(
      extension.method,
      extension.params ?? {},
      { params: JSONObjectSchema, result: JSONValueSchema },
      requestOptions(context),
    );
  };
  (
    server as unknown as {
      fallbackNotificationHandler: (notification: Notification) => Promise<void>;
    }
  ).fallbackNotificationHandler = (notification) =>
    broker.notifyExtension(notification.method, notification.params);
  if (capabilities.tools) {
    server.setRequestHandler("tools/list", (request, context) =>
      broker.listTools(request.params, requestOptions(context)),
    );
    server.setRequestHandler("tools/call", (request, context) =>
      broker.callTool(
        continuationParams(request.params, context) as Parameters<ProjectMcpBroker["callTool"]>[0],
        requestOptions(context),
      ),
    );
  }
  if (capabilities.resources) {
    server.setRequestHandler("resources/list", (request, context) =>
      broker.listResources(request.params, requestOptions(context)),
    );
    server.setRequestHandler("resources/templates/list", (request, context) =>
      broker.listResourceTemplates(request.params, requestOptions(context)),
    );
    server.setRequestHandler("resources/read", (request, context) =>
      broker.readResource(
        continuationParams(request.params, context) as Parameters<
          ProjectMcpBroker["readResource"]
        >[0],
        requestOptions(context),
      ),
    );
    server.setRequestHandler("resources/subscribe", (request, context) =>
      broker.subscribeResource(request.params, requestOptions(context)),
    );
    server.setRequestHandler("resources/unsubscribe", (request, context) =>
      broker.unsubscribeResource(request.params, requestOptions(context)),
    );
  }
  if (capabilities.prompts) {
    server.setRequestHandler("prompts/list", (request, context) =>
      broker.listPrompts(request.params, requestOptions(context)),
    );
    server.setRequestHandler("prompts/get", (request, context) =>
      broker.getPrompt(
        continuationParams(request.params, context) as Parameters<ProjectMcpBroker["getPrompt"]>[0],
        requestOptions(context),
      ),
    );
  }
  if (capabilities.completions) {
    server.setRequestHandler("completion/complete", (request, context) =>
      broker.complete(request.params, requestOptions(context)),
    );
  }
  if (capabilities.logging) {
    server.setRequestHandler("logging/setLevel", (request, context) =>
      broker.setLoggingLevel(request.params.level, requestOptions(context)),
    );
  }
  const forwardRootsRequest = (request: unknown, context?: ClientContext) =>
    forwardServerRequest(server, "roots/list", request, context?.mcpReq.signal);
  server.setNotificationHandler("notifications/roots/list_changed", () =>
    broker.notifyRootsListChangedFor(rootsOwner, forwardRootsRequest),
  );
  const disposeHandlers = broker.setHandlers({
    ...(notifier
      ? {}
      : {
          onToolsChanged: () => server.sendToolListChanged(),
          onPromptsChanged: () => server.sendPromptListChanged(),
          onResourcesChanged: () => server.sendResourceListChanged(),
          onResourceUpdated: (uri: string) => server.sendResourceUpdated({ uri }),
        }),
    onLoggingMessage: (notification) => server.notification(notification),
    onUpstreamNotification: (notification) => server.notification(notification),
    onRootsRequest: forwardRootsRequest,
    onSamplingRequest: (request, context) =>
      forwardServerRequest(server, "sampling/createMessage", request, context?.mcpReq.signal),
    onElicitationRequest: (request, context) =>
      forwardServerRequest(server, "elicitation/create", request, context?.mcpReq.signal),
  });
  // MCP Protocol exposes a callback property, not EventTarget.addEventListener.
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  server.onclose = () => {
    broker.releaseRootsOwner(rootsOwner);
    disposeHandlers();
    if (!notifier)
      void broker.dispose().catch((error: unknown) => {
        server.onerror?.(error instanceof Error ? error : new Error(String(error)));
      });
  };
  return server;
};

const requestParams = (request: unknown): Record<string, unknown> | undefined =>
  typeof request === "object" &&
  request !== null &&
  "params" in request &&
  typeof request.params === "object" &&
  request.params !== null &&
  !Array.isArray(request.params)
    ? (request.params as Record<string, unknown>)
    : undefined;

const forwardServerRequest = (
  server: Server,
  method: "roots/list" | "sampling/createMessage" | "elicitation/create",
  request: unknown,
  signal?: AbortSignal,
) => {
  const params = requestParams(request);
  return server.request(
    { method, ...(params === undefined ? {} : { params }) },
    signal ? { signal } : {},
  );
};

const requestMethod = async (request: Request): Promise<string | undefined> => {
  if (request.method !== "POST") return undefined;
  try {
    const body: unknown = await request.clone().json();
    return typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      typeof (body as { method?: unknown }).method === "string"
      ? (body as { method: string }).method
      : undefined;
  } catch {
    return undefined;
  }
};

const trackModernResponse = (
  response: Response,
  handler: McpHttpHandler,
  onDone: () => void,
): Response => {
  if (!response.body) {
    onDone();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          await handler.close();
          onDone();
        } else {
          controller.enqueue(next.value);
        }
      } catch (cause) {
        controller.error(cause);
        await handler.close().catch(() => undefined);
        onDone();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      await handler.close().catch(() => undefined);
      onDone();
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
};

const makeWithOptions = Effect.fn("ProjectMcpProxyRegistry.make")(function* (
  options: ProjectMcpProxyRegistryOptions = {},
) {
  const httpServer = yield* Effect.serviceOption(HttpServer.HttpServer);
  const crypto = yield* Effect.serviceOption(Crypto.Crypto);
  const secrets = yield* Effect.serviceOption(ProjectMcpSecretStore.ProjectMcpSecretStore);
  const oauth = yield* Effect.serviceOption(ProjectMcpOAuth.ProjectMcpOAuth);
  const base = new URL(
    options.endpointBase ??
      (httpServer._tag === "Some"
        ? endpointBaseFromHttpServer(httpServer.value)
        : "http://127.0.0.1/mcp"),
  );
  const connect = options.connect ?? connectProjectMcpServer;
  const sessions = new Map<string, SessionRecord>();

  const closeConnection = async (entry: ConnectionRecord): Promise<void> => {
    let firstError: unknown;
    // Release suspended tool permits before facade resource teardown can queue behind them.
    try {
      await entry.opening.then((connection) => projectMcpConnectionCoordinator(connection).close());
    } catch (cause) {
      firstError = cause;
    }
    const handlerResults = await Promise.allSettled(
      [...entry.modernHandlers].map((handler) => handler.close()),
    );
    const handlerFailure = handlerResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (handlerFailure) firstError = handlerFailure.reason;
    await Promise.allSettled(
      [...entry.legacySessions.values()].map(async ({ server, transport }) => {
        await Promise.allSettled([server.close(), transport.close()]);
      }),
    );
    entry.legacySessions.clear();
    try {
      await entry.opening.then((connection) => connection.close());
    } catch (cause) {
      firstError ??= cause;
    }
    if (firstError !== undefined) throw firstError;
  };

  const closeSession = async (session: SessionRecord): Promise<void> => {
    session.revoked = true;
    for (const server of session.servers.values()) session.revokedServerIds.add(server.id);
    const entries = [...session.connections.values()];
    session.connections.clear();
    const results = await Promise.allSettled(entries.map(closeConnection));
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  };

  const registerSession: ProjectMcpProxyRegistryShape["registerSession"] = Effect.fn(
    "ProjectMcpProxyRegistry.registerSession",
  )(function* (input) {
    yield* revokeProviderSession(input.providerSessionId);
    const endpointMap = new Map<string, ProjectMcpProxyEndpoint>();
    const serverMap = new Map<string, ResolvedProjectMcpServer>();
    for (const server of input.servers) {
      const endpointHandle =
        crypto._tag === "Some"
          ? yield* crypto.value.randomUUIDv4.pipe(Effect.orDie)
          : randomEndpointHandle();
      const endpoint = new URL(`/mcp/project/${endpointHandle}`, base);
      const publicEndpoint = Object.freeze({
        endpointHandle,
        endpoint: Object.freeze(endpoint),
        id: server.id,
        name: server.name,
      });
      endpointMap.set(endpointHandle, publicEndpoint);
      serverMap.set(
        endpointHandle,
        Object.freeze({
          id: server.id,
          name: server.name,
          transport: structuredClone(server.transport),
        }),
      );
    }
    sessions.set(input.providerSessionId, {
      providerSessionId: input.providerSessionId,
      threadId: input.threadId,
      servers: serverMap,
      endpoints: endpointMap,
      connections: new Map(),
      resolveSecret: input.resolveSecret,
      revokedServerIds: new Set(),
      revoked: false,
    });
    return [...endpointMap.values()];
  });

  const resolve: ProjectMcpProxyRegistryShape["resolve"] = (providerSessionId, endpointHandle) =>
    Effect.sync(() => {
      const session = sessions.get(providerSessionId);
      const server = session?.servers.get(endpointHandle);
      return server && session && !session.revoked && !session.revokedServerIds.has(server.id)
        ? { server, threadId: session.threadId }
        : undefined;
    });

  const getConnection = (session: SessionRecord, endpointHandle: string) => {
    const existing = session.connections.get(endpointHandle);
    if (existing) return existing.opening;
    const server = session.servers.get(endpointHandle);
    if (!server) return Promise.reject(new ProjectMcpProxyUnknownEndpointError());
    const secretValues = new Map<string, string>();
    const opening = (async () => {
      for (const credentialId of credentialIds(server)) {
        const value =
          session.resolveSecret?.(server.id, credentialId) ??
          (secrets._tag === "Some"
            ? await Effect.runPromise(secrets.value.resolve(server.id, credentialId)).catch(
                () => undefined,
              )
            : undefined);
        if (value !== undefined) secretValues.set(credentialId, value);
      }
      const oauthProvider =
        server.transport.type !== "stdio" &&
        server.transport.authorization.type === "oauth" &&
        oauth._tag === "Some"
          ? await Effect.runPromise(
              ProjectMcpOAuth.resolveServerBinding(server, (_serverId, credentialId) =>
                Effect.succeed(secretValues.get(credentialId)),
              ).pipe(Effect.flatMap((binding) => oauth.value.providerFor(server.id, binding))),
            )
          : undefined;
      return connect({
        serverId: server.id,
        transport: server.transport,
        resolveSecret: (credentialId) => secretValues.get(credentialId),
        ...(oauthProvider ? { oauthProvider } : {}),
      });
    })();
    const record = {
      server,
      resolveSecret: session.resolveSecret,
      opening,
      modernBus: new InMemoryServerEventBus(),
      modernHandlers: new Set(),
      legacySessions: new Map(),
    } satisfies ConnectionRecord;
    session.connections.set(endpointHandle, record);
    void opening.catch(() => {
      if (session.connections.get(endpointHandle) === record)
        session.connections.delete(endpointHandle);
    });
    return opening;
  };

  const brokerFor = async (
    record: ConnectionRecord,
    providerSessionId: string,
    downstreamProtocolEra: "modern" | "legacy",
  ): Promise<ProjectMcpBroker> => {
    if (downstreamProtocolEra === "modern") {
      if (record.modernBroker) return record.modernBroker;
      if (record.modernBrokerOpening) return record.modernBrokerOpening;
      record.modernBrokerOpening = record.opening.then((connection) => {
        // Modern stream owners live in the event bus, which applies each stream's URI filter.
        projectMcpConnectionCoordinator(connection).addListener((notification) => {
          if (
            notification.method === "notifications/resources/updated" &&
            typeof notification.params?.uri === "string"
          ) {
            return record.modernBus.publish({
              kind: "resource_updated",
              uri: notification.params.uri,
            });
          }
        });
        const broker = new ProjectMcpBroker({
          connection,
          serverId: record.server.id,
          providerSessionId,
          downstreamProtocolEra,
          handlers: {
            onToolsChanged: () => record.modernBus.publish({ kind: "tools_list_changed" }),
            onPromptsChanged: () => record.modernBus.publish({ kind: "prompts_list_changed" }),
            onResourcesChanged: () => record.modernBus.publish({ kind: "resources_list_changed" }),
            onUpstreamNotification: (notification) =>
              record.modernBus.publish({ kind: "notification", notification }),
          },
        });
        record.modernBroker = broker;
        return broker;
      });
      return record.modernBrokerOpening;
    }
    return record.opening.then(
      (connection) =>
        new ProjectMcpBroker({
          connection,
          serverId: record.server.id,
          providerSessionId,
          downstreamProtocolEra,
        }),
    );
  };

  const handleModern = async (
    record: ConnectionRecord,
    providerSessionId: string,
    request: Request,
  ): Promise<Response> => {
    const broker = await brokerFor(record, providerSessionId, "modern");
    let handler: McpHttpHandler | undefined;
    handler = createMcpHandler(() => makeServer(broker, handler?.notify), {
      bus: record.modernBus,
      legacy: "reject",
      responseMode: "auto",
    });
    record.modernHandlers.add(handler);
    const coordinator = projectMcpConnectionCoordinator(await record.opening);
    const resourceUris: string[] = [];
    const close = handler.close.bind(handler);
    handler.close = async () => {
      await close();
      await Promise.all(
        resourceUris.splice(0).map((uri) => coordinator.unsubscribeResource(uri, handler)),
      );
    };
    try {
      if ((await requestMethod(request)) === "subscriptions/listen") {
        const body: unknown = await request.clone().json();
        const params = requestParams(body);
        const filter = await SubscriptionFilterSchema["~standard"].validate(params?.notifications);
        if (!filter.issues) {
          for (const uri of new Set(filter.value.resourceSubscriptions ?? [])) {
            await coordinator.subscribeResource(uri, handler, { signal: request.signal });
            resourceUris.push(uri);
          }
        }
      }
      const response = await handler.fetch(request);
      return trackModernResponse(response, handler, () => record.modernHandlers.delete(handler));
    } catch (cause) {
      record.modernHandlers.delete(handler);
      await handler.close().catch(() => undefined);
      throw cause;
    }
  };

  const handleLegacy = async (
    record: ConnectionRecord,
    providerSessionId: string,
    request: Request,
  ): Promise<Response> => {
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const legacy = record.legacySessions.get(sessionId);
      if (!legacy) return new Response(null, { status: 404 });
      return legacy.transport.handleRequest(request);
    }
    if (request.method !== "POST" || (await requestMethod(request)) !== "initialize") {
      return new Response("Bad Request", { status: 400 });
    }
    const broker = await brokerFor(record, providerSessionId, "legacy");
    const server = makeServer(broker);
    let legacy: LegacySessionRecord | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomEndpointHandle(),
      onsessioninitialized: (initializedSessionId) => {
        if (legacy) record.legacySessions.set(initializedSessionId, legacy);
      },
      onsessionclosed: async (closedSessionId) => {
        record.legacySessions.delete(closedSessionId);
        await broker.dispose();
      },
    });
    legacy = { broker, server, transport };
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      if (transport.sessionId && !record.legacySessions.has(transport.sessionId)) {
        record.legacySessions.set(transport.sessionId, legacy);
      }
      return response;
    } catch (cause) {
      await Promise.allSettled([server.close(), transport.close()]);
      throw cause;
    }
  };

  const handle: ProjectMcpProxyRegistryShape["handle"] = Effect.fn(
    "ProjectMcpProxyRegistry.handle",
  )(function* (providerSessionId, endpointHandle, request) {
    const session = sessions.get(providerSessionId);
    const server = session?.servers.get(endpointHandle);
    if (!session || session.revoked) {
      return yield* Effect.fail<ProjectMcpProxyError>(new ProjectMcpProxyUnauthorizedError());
    }
    if (!server || session.revokedServerIds.has(server.id)) {
      return yield* Effect.fail<ProjectMcpProxyError>(new ProjectMcpProxyUnknownEndpointError());
    }
    yield* Effect.tryPromise({
      try: () => getConnection(session, endpointHandle),
      catch: (cause) =>
        new ProjectMcpProxyError(
          "upstream_connection_failed",
          "Could not connect to the project MCP server.",
          cause,
        ),
    });
    if (session.revoked) {
      return yield* Effect.fail<ProjectMcpProxyError>(new ProjectMcpProxyUnauthorizedError());
    }
    const modern = yield* Effect.tryPromise({
      try: () => isLegacyRequest(request),
      catch: (cause) =>
        new ProjectMcpProxyError(
          "upstream_request_failed",
          "The MCP request could not be classified.",
          cause,
        ),
    }).pipe(Effect.map((legacy) => !legacy));
    const connectionRecord = sessions.get(providerSessionId)?.connections.get(endpointHandle);
    if (!connectionRecord) {
      return yield* Effect.fail<ProjectMcpProxyError>(
        new ProjectMcpProxyError("upstream_request_failed", "The MCP connection is unavailable."),
      );
    }
    return yield* Effect.tryPromise({
      try: () =>
        modern
          ? handleModern(connectionRecord, providerSessionId, request)
          : handleLegacy(connectionRecord, providerSessionId, request),
      catch: (cause) =>
        new ProjectMcpProxyError(
          "upstream_request_failed",
          "The project MCP request failed.",
          cause,
        ),
    });
  });

  const revokeProviderSession: ProjectMcpProxyRegistryShape["revokeProviderSession"] = Effect.fn(
    "ProjectMcpProxyRegistry.revokeProviderSession",
  )(function* (providerSessionId) {
    const session = sessions.get(providerSessionId);
    if (!session) return;
    sessions.delete(providerSessionId);
    yield* Effect.promise(() => closeSession(session)).pipe(Effect.ignore);
  });

  const revokeThread: ProjectMcpProxyRegistryShape["revokeThread"] = Effect.fn(
    "ProjectMcpProxyRegistry.revokeThread",
  )(function* (threadId) {
    const providerSessionIds = [...sessions.values()]
      .filter((session) => session.threadId === threadId)
      .map((session) => session.providerSessionId);
    yield* Effect.forEach(providerSessionIds, revokeProviderSession, { discard: true });
  });

  const closeServerConnections = (serverId: McpServerId): Effect.Effect<void> => {
    const targets: Array<{ readonly session: SessionRecord; readonly handle: string }> = [];
    for (const session of sessions.values()) {
      for (const [handle, server] of session.servers) {
        if (server.id === serverId) targets.push({ session, handle });
      }
    }
    return Effect.forEach(
      targets,
      ({ session, handle }) =>
        Effect.promise(async () => {
          const entry = session.connections.get(handle);
          if (!entry) return;
          session.connections.delete(handle);
          await closeConnection(entry);
        }).pipe(Effect.ignore),
      { discard: true },
    );
  };

  const revokeServer: ProjectMcpProxyRegistryShape["revokeServer"] = Effect.fn(
    "ProjectMcpProxyRegistry.revokeServer",
  )(function* (serverId) {
    const targets: Array<{ readonly session: SessionRecord; readonly handle: string }> = [];
    for (const session of sessions.values()) {
      for (const [handle, server] of session.servers) {
        if (server.id === serverId) targets.push({ session, handle });
      }
    }
    yield* Effect.forEach(
      targets,
      ({ session, handle }) =>
        Effect.promise(async () => {
          session.revokedServerIds.add(serverId);
          const entry = session.connections.get(handle);
          session.connections.delete(handle);
          if (entry) {
            await closeConnection(entry);
          }
        }).pipe(Effect.ignore),
      { discard: true },
    );
  });

  if (oauth._tag === "Some") {
    oauth.value.setAuthorizedHandler?.(async (serverId) => {
      await Effect.runPromise(closeServerConnections(serverId));
    });
  }

  const revokeAll = Effect.suspend(() =>
    Effect.forEach([...sessions.keys()], revokeProviderSession, { discard: true }),
  );
  return ProjectMcpProxyRegistry.of({
    registerSession,
    resolve,
    handle,
    revokeProviderSession,
    revokeThread,
    revokeServer,
    revokeAll,
  });
});

export const layer = Layer.effect(
  ProjectMcpProxyRegistry,
  Effect.acquireRelease(makeWithOptions(), (registry) => registry.revokeAll.pipe(Effect.ignore)),
);

export const __testing = { make: makeWithOptions };
