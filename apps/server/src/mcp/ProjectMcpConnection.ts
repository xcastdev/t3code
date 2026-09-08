import type { McpServerId, ProjectMcpTransport } from "@t3tools/contracts";
import {
  Client,
  SdkHttpError,
  type ClientOptions,
  type DiscoverResult,
  type OAuthClientProvider,
  type ProtocolEra,
  type ServerCapabilities,
  type Implementation,
  type ClientContext,
  type Notification,
  type McpSubscription,
  type SubscriptionFilter,
  type RequestOptions,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/client";

import { makeProjectMcpTransport } from "./ProjectMcpTransport.ts";

export interface ProjectMcpClient {
  onclose?: (() => void) | undefined;
  readonly connect: (transport: unknown) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly transport?: unknown;
  readonly request?: Client["request"];
  readonly notification?: Client["notification"];
  readonly ping?: Client["ping"];
  readonly discover?: Client["discover"];
  readonly complete?: Client["complete"];
  readonly setLoggingLevel?: Client["setLoggingLevel"];
  readonly listTools?: Client["listTools"];
  readonly callTool?: Client["callTool"];
  readonly listResources?: Client["listResources"];
  readonly listResourceTemplates?: Client["listResourceTemplates"];
  readonly readResource?: Client["readResource"];
  readonly subscribeResource?: Client["subscribeResource"];
  readonly unsubscribeResource?: Client["unsubscribeResource"];
  readonly listen?: Client["listen"];
  readonly listPrompts?: Client["listPrompts"];
  readonly getPrompt?: Client["getPrompt"];
  readonly setRequestHandler?: Client["setRequestHandler"];
  readonly setNotificationHandler?: Client["setNotificationHandler"];
  readonly terminateSession?: () => Promise<void>;
  readonly getProtocolEra?: () => ProtocolEra | undefined;
  readonly getNegotiatedProtocolVersion?: () => string | undefined;
  readonly getDiscoverResult?: () => DiscoverResult | undefined;
  readonly getServerCapabilities?: () => ServerCapabilities | undefined;
  readonly getServerVersion?: () => Implementation | undefined;
}

export interface ProjectMcpConnectionDependencies {
  readonly createClient: (options: ClientOptions) => ProjectMcpClient;
  readonly createTransport: (input: {
    readonly serverId: McpServerId;
    readonly transport: ProjectMcpTransport;
    readonly resolveSecret: (secretRef: string) => string | undefined;
    readonly oauthProvider?: OAuthClientProvider;
  }) => unknown;
}

const isLegacyFallbackStatus = (error: unknown): boolean => {
  return SdkHttpError.isInstance(error) && [400, 404, 405].includes(error.status);
};

const automaticClientOptions: ClientOptions = {
  capabilities: {
    roots: { listChanged: true },
    sampling: {},
    elicitation: { form: {}, url: {} },
  },
  versionNegotiation: { mode: "auto" },
  inputRequired: { autoFulfill: false, maxRounds: 10 },
};

const legacyClientOptions: ClientOptions = {
  capabilities: {
    roots: { listChanged: true },
    sampling: {},
    elicitation: { form: {}, url: {} },
  },
  versionNegotiation: { mode: "legacy" },
  inputRequired: { autoFulfill: false, maxRounds: 10 },
};

const closeResources = async (client: ProjectMcpClient, transport?: unknown): Promise<void> => {
  let firstError: unknown;
  const clientOwnsTransport = transport !== undefined && client.transport === transport;
  try {
    await client.terminateSession?.();
  } catch (error) {
    firstError = error;
  }
  try {
    await client.close();
  } catch (error) {
    firstError ??= error;
  }
  if (
    typeof transport === "object" &&
    transport !== null &&
    !clientOwnsTransport &&
    "close" in transport &&
    typeof transport.close === "function"
  ) {
    try {
      await transport.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
};

const defaultDependencies: ProjectMcpConnectionDependencies = {
  createClient: (options) =>
    new Client({ name: "t3-code", version: "0.0.0" }, options) as ProjectMcpClient,
  createTransport: makeProjectMcpTransport,
};

export interface ConnectProjectMcpServerInput {
  readonly serverId: McpServerId;
  readonly transport: ProjectMcpTransport;
  readonly resolveSecret: (secretRef: string) => string | undefined;
  readonly oauthProvider?: OAuthClientProvider;
  readonly dependencies?: ProjectMcpConnectionDependencies;
}

export interface ProjectMcpConnection {
  readonly client: ProjectMcpClient;
  readonly transport: ProjectMcpTransport;
  readonly protocolEra: ProtocolEra | undefined;
  readonly negotiatedProtocolVersion: string | undefined;
  readonly discoverResult: DiscoverResult | undefined;
  readonly serverCapabilities?: ServerCapabilities;
  readonly serverVersion?: Implementation;
  readonly close: () => Promise<void>;
}

type PushHandler = (
  method: string,
  request: unknown,
  context?: ClientContext,
) => unknown | Promise<unknown>;

type RootsOwnerState = "pending" | "committed" | "failed";

interface RootsOwner {
  readonly owner: object;
  readonly handler: PushHandler;
  readonly generation: number;
  previous: RootsOwner | undefined;
  state: RootsOwnerState;
}

interface RootsOwnerReplacement {
  readonly record: RootsOwner;
}

/** One owner at a time on legacy transports, which carry no parent request correlation. */
export class ProjectMcpConnectionCoordinator {
  readonly controller = new AbortController();
  private busy = false;
  private owner: PushHandler | undefined;
  private rootsOwner: RootsOwner | undefined;
  private rootsOwnerGeneration = 0;
  private pendingRootsOwnerCount = 0;
  private readonly releasedRootsOwners = new WeakSet<object>();
  private readonly queue: Array<() => void> = [];
  private readonly listeners = new Set<(notification: Notification) => void | Promise<void>>();
  private readonly subscriptions = new Map<string, Promise<McpSubscription>>();
  private readonly resourceOwners = new Map<string, Set<object>>();
  private readonly resourceTransitions = new Map<string, Promise<void>>();
  private readonly disposedResourceOwners = new WeakSet<object>();
  private readonly connection: ProjectMcpConnection;

  constructor(connection: ProjectMcpConnection) {
    this.connection = connection;
    const client = connection.client;
    const onclose = client.onclose;
    // MCP Protocol exposes a callback property, not EventTarget.addEventListener.
    // eslint-disable-next-line unicorn/prefer-add-event-listener
    client.onclose = () => {
      void this.close();
      onclose?.();
    };
    const notify = (notification: Notification) =>
      Promise.allSettled(
        [...this.listeners].map((listener) => Promise.resolve().then(() => listener(notification))),
      ).then(() => undefined);
    for (const method of [
      "notifications/tools/list_changed",
      "notifications/prompts/list_changed",
      "notifications/resources/list_changed",
      "notifications/resources/updated",
      "notifications/message",
    ] as const) {
      client.setNotificationHandler?.(method, notify);
    }
    const setRequestHandler = client.setRequestHandler?.bind(client) as
      | ((method: string, handler: (request: unknown, context: ClientContext) => unknown) => void)
      | undefined;
    for (const method of ["roots/list", "sampling/createMessage", "elicitation/create"] as const) {
      setRequestHandler?.(method, (request: unknown, context: ClientContext) => {
        const rootsOwner = this.rootsOwner;
        const handler =
          this.owner ??
          (method === "roots/list" &&
          rootsOwner !== undefined &&
          this.isViableRootsOwner(rootsOwner)
            ? rootsOwner.handler
            : undefined);
        if (!handler)
          throw new ProtocolError(
            ProtocolErrorCode.MethodNotFound,
            "Unassociated MCP server request is unsupported",
          );
        return handler(method, request, context);
      });
    }
  }

  addListener(listener: (notification: Notification) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.connection.protocolEra !== "modern" || !this.connection.client.listen) return;
    const capabilities =
      this.connection.discoverResult?.capabilities ?? this.connection.serverCapabilities;
    const filter: SubscriptionFilter = {
      ...(capabilities?.tools?.listChanged ? { toolsListChanged: true } : {}),
      ...(capabilities?.prompts?.listChanged ? { promptsListChanged: true } : {}),
      ...(capabilities?.resources?.listChanged ? { resourcesListChanged: true } : {}),
    };
    if (Object.keys(filter).length) await this.listen("lists", filter);
  }

  private listen(
    key: string,
    filter: SubscriptionFilter,
    options?: RequestOptions,
  ): Promise<McpSubscription> {
    const existing = this.subscriptions.get(key);
    if (existing) return existing;
    if (this.controller.signal.aborted) return Promise.reject(new Error("MCP connection closed"));
    const pending =
      this.connection.protocolEra === "legacy"
        ? this.listenLegacyResource(filter.resourceSubscriptions![0]!, options)
        : this.connection.client.listen!(filter, { ...options, signal: this.controller.signal });
    this.subscriptions.set(key, pending);
    void pending.catch(() => {
      if (this.subscriptions.get(key) === pending) this.subscriptions.delete(key);
    });
    return pending;
  }

  private async listenLegacyResource(
    uri: string,
    options?: RequestOptions,
  ): Promise<McpSubscription> {
    const unsupported = () => {
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        "Unassociated MCP server request is unsupported",
      );
    };
    const release = await this.acquire(unsupported, options?.signal);
    try {
      await this.connection.client.subscribeResource!(
        { uri },
        {
          ...options,
          signal: options?.signal
            ? AbortSignal.any([options.signal, this.controller.signal])
            : this.controller.signal,
        },
      );
    } finally {
      release();
    }
    const closed = Promise.withResolvers<"local">();
    let closing: Promise<void> | undefined;
    return {
      honoredFilter: { resourceSubscriptions: [uri] },
      closed: closed.promise,
      close: () =>
        (closing ??= (async () => {
          if (!this.controller.signal.aborted) {
            const release = await this.acquire(unsupported);
            try {
              await this.connection.client.unsubscribeResource!({ uri });
            } finally {
              release();
            }
          }
          closed.resolve("local");
        })()),
    };
  }

  ownsResource(uri: string, owner: object): boolean {
    return (
      !this.disposedResourceOwners.has(owner) && (this.resourceOwners.get(uri)?.has(owner) ?? false)
    );
  }

  async releaseResourceOwner(owner: object): Promise<void> {
    this.disposedResourceOwners.add(owner);
    const uris = [...this.resourceOwners]
      .filter(([, owners]) => owners.has(owner))
      .map(([uri]) => uri);
    await Promise.all(uris.map((uri) => this.unsubscribeResource(uri, owner)));
  }

  replaceRootsOwner(owner: object, handler: PushHandler): RootsOwnerReplacement | undefined {
    if (this.controller.signal.aborted || this.releasedRootsOwners.has(owner)) return undefined;
    const record: RootsOwner = {
      owner,
      handler,
      generation: ++this.rootsOwnerGeneration,
      previous: this.rootsOwner,
      state: "pending",
    };
    this.rootsOwner = record;
    this.pendingRootsOwnerCount += 1;
    return { record };
  }

  commitRootsOwner(replacement: RootsOwnerReplacement): void {
    if (this.settleRootsOwner(replacement, "committed") === undefined) return;
    this.compactRootsOwnerHistory();
  }

  rollbackRootsOwner(replacement: RootsOwnerReplacement): void {
    const failed = this.settleRootsOwner(replacement, "failed");
    if (failed === undefined) return;
    if (this.rootsOwner === failed) {
      this.rootsOwner = this.nearestViableRootsOwner(failed.previous);
    }
    this.compactRootsOwnerHistory();
  }

  private settleRootsOwner(
    replacement: RootsOwnerReplacement,
    state: Exclude<RootsOwnerState, "pending">,
  ): RootsOwner | undefined {
    const record = replacement.record;
    if (record.state !== "pending") return undefined;
    record.state = state;
    this.pendingRootsOwnerCount -= 1;
    return record;
  }

  private compactRootsOwnerHistory(): void {
    const current = this.rootsOwner;
    if (!current) return;

    if (current.state === "committed") {
      current.previous = undefined;
      return;
    }

    const retained: RootsOwner[] = [];
    for (let record: RootsOwner | undefined = current; record; ) {
      const next: RootsOwner | undefined = record.previous;
      if (record === current || record.state === "pending" || this.isViableRootsOwner(record)) {
        retained.push(record);
      } else {
        record.previous = undefined;
      }
      record = next;
    }
    for (let index = 0; index < retained.length; index += 1) {
      retained[index]!.previous = retained[index + 1];
    }
  }

  private isViableRootsOwner(record: RootsOwner | undefined): boolean {
    return (
      record !== undefined &&
      record.state !== "failed" &&
      !this.releasedRootsOwners.has(record.owner)
    );
  }

  private nearestViableRootsOwner(record: RootsOwner | undefined): RootsOwner | undefined {
    let candidate = record;
    while (candidate !== undefined) {
      if (this.isViableRootsOwner(candidate)) return candidate;
      candidate = candidate.previous;
    }
    return undefined;
  }

  ownsRootsOwner(owner: object): boolean {
    const rootsOwner = this.rootsOwner;
    return (
      rootsOwner !== undefined && this.isViableRootsOwner(rootsOwner) && rootsOwner.owner === owner
    );
  }

  releaseRootsOwner(owner: object): void {
    this.releasedRootsOwners.add(owner);
    if (this.rootsOwner?.owner === owner) this.rootsOwner = undefined;
    else this.compactRootsOwnerHistory();
  }

  private resourceTransition(
    uri: string,
    transition: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = Promise.withResolvers<void>();
    const abort = () => result.reject(signal?.reason ?? new Error("MCP request cancelled"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const pending = (this.resourceTransitions.get(uri) ?? Promise.resolve()).then(() => {
      signal?.removeEventListener("abort", abort);
      signal?.throwIfAborted();
      return transition();
    });
    void pending.then(result.resolve, result.reject);
    const settled = pending.catch(() => undefined);
    this.resourceTransitions.set(uri, settled);
    void settled.then(() => {
      if (this.resourceTransitions.get(uri) === settled) this.resourceTransitions.delete(uri);
    });
    return result.promise;
  }

  subscribeResource(uri: string, owner: object, options?: RequestOptions): Promise<void> {
    return this.resourceTransition(
      uri,
      () => this.subscribeResourceUnlocked(uri, owner, options),
      options?.signal,
    );
  }

  private async subscribeResourceUnlocked(
    uri: string,
    owner: object,
    options?: RequestOptions,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    if (this.disposedResourceOwners.has(owner)) throw new Error("MCP resource owner disposed");
    const owners = this.resourceOwners.get(uri) ?? new Set<object>();
    owners.add(owner);
    this.resourceOwners.set(uri, owners);
    try {
      await this.listen(`resource:${uri}`, { resourceSubscriptions: [uri] }, options);
    } catch (error) {
      owners.delete(owner);
      if (!owners.size) this.resourceOwners.delete(uri);
      throw error;
    }
  }

  unsubscribeResource(uri: string, owner: object): Promise<void> {
    return this.resourceTransition(uri, () => this.unsubscribeResourceUnlocked(uri, owner));
  }

  private async unsubscribeResourceUnlocked(uri: string, owner: object): Promise<void> {
    const owners = this.resourceOwners.get(uri);
    owners?.delete(owner);
    if (!owners || owners.size) return;
    this.resourceOwners.delete(uri);
    const subscription = this.subscriptions.get(`resource:${uri}`);
    this.subscriptions.delete(`resource:${uri}`);
    await (await subscription)?.close();
  }

  acquire(handler: PushHandler, signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(start);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal?.reason ?? new Error("MCP request cancelled"));
      };
      const start = () => {
        signal?.removeEventListener("abort", abort);
        if (this.controller.signal.aborted) {
          reject(new Error("MCP connection closed"));
          return;
        }
        if (signal?.aborted) {
          abort();
          return;
        }
        this.busy = true;
        this.owner = handler;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.busy = false;
          this.owner = undefined;
          this.queue.shift()?.();
        });
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      if (!this.busy) start();
      else {
        this.queue.push(start);
        signal?.addEventListener("abort", abort, { once: true });
      }
    });
  }

  async close(): Promise<void> {
    if (this.controller.signal.aborted) return;
    this.controller.abort(new Error("MCP connection closed"));
    this.owner = undefined;
    this.rootsOwner = undefined;
    for (const next of this.queue.splice(0)) next();
    this.listeners.clear();
    const subscriptions = [...this.subscriptions.values()];
    this.subscriptions.clear();
    this.resourceOwners.clear();
    await Promise.allSettled(
      subscriptions.map(async (subscription) => (await subscription).close()),
    );
  }
}

const coordinators = new WeakMap<ProjectMcpClient, ProjectMcpConnectionCoordinator>();
export const projectMcpConnectionCoordinator = (
  connection: ProjectMcpConnection,
): ProjectMcpConnectionCoordinator => {
  let coordinator = coordinators.get(connection.client);
  if (!coordinator) {
    coordinator = new ProjectMcpConnectionCoordinator(connection);
    coordinators.set(connection.client, coordinator);
  }
  return coordinator;
};

export const connectProjectMcpServer = async ({
  serverId,
  transport,
  resolveSecret,
  oauthProvider,
  dependencies = defaultDependencies,
}: ConnectProjectMcpServerInput): Promise<ProjectMcpConnection> => {
  const connect = async (selectedTransport: ProjectMcpTransport, clientOptions: ClientOptions) => {
    const client = dependencies.createClient(clientOptions);
    let sdkTransport: unknown;
    try {
      sdkTransport = dependencies.createTransport({
        serverId,
        transport: selectedTransport,
        resolveSecret,
        ...(oauthProvider === undefined ? {} : { oauthProvider }),
      });
      await client.connect(sdkTransport);
    } catch (error) {
      try {
        await closeResources(client, sdkTransport);
      } catch {
        // Preserve the connection error. Cleanup is best effort on a failed attempt.
      }
      throw error;
    }

    let closed = false;
    const serverCapabilities = client.getServerCapabilities?.();
    const serverVersion = client.getServerVersion?.();
    const connection = {
      client,
      transport: selectedTransport,
      protocolEra: client.getProtocolEra?.(),
      negotiatedProtocolVersion: client.getNegotiatedProtocolVersion?.(),
      discoverResult: client.getDiscoverResult?.(),
      ...(serverCapabilities === undefined ? {} : { serverCapabilities }),
      ...(serverVersion === undefined ? {} : { serverVersion }),
      close: async () => {
        if (closed) return;
        closed = true;
        await projectMcpConnectionCoordinator(connection).close();
        await closeResources(client, sdkTransport);
      },
    } satisfies ProjectMcpConnection;
    try {
      await projectMcpConnectionCoordinator(connection).start();
    } catch (error) {
      await connection.close();
      throw error;
    }
    return connection;
  };

  try {
    return await connect(
      transport,
      transport.type === "legacy-sse" ? legacyClientOptions : automaticClientOptions,
    );
  } catch (error) {
    if (transport.type !== "streamable-http" || !isLegacyFallbackStatus(error)) throw error;
    return connect(
      {
        type: "legacy-sse",
        url: transport.url,
        headers: transport.headers,
        authorization: transport.authorization,
      },
      legacyClientOptions,
    );
  }
};
