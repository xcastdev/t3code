import * as NodeCrypto from "node:crypto";
import type { McpServerId } from "@t3tools/contracts";
import type {
  CallToolRequestParams,
  CallToolResult,
  Client,
  ClientContext,
  CompleteRequestParams,
  CompleteResult,
  DiscoverResult,
  GetPromptRequestParams,
  GetPromptResult,
  InputRequiredResult,
  InputRequest,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListToolsResult,
  McpSubscription,
  Notification,
  NotificationOptions,
  ProtocolEra,
  ReadResourceRequestParams,
  ReadResourceResult,
  RequestOptions,
  StandardSchemaV1,
  SubscriptionFilter,
} from "@modelcontextprotocol/client";
import {
  isInputRequiredResult,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/client";

import type { ProjectMcpClient, ProjectMcpConnection } from "./ProjectMcpConnection.ts";
import {
  projectMcpConnectionCoordinator,
  type ProjectMcpConnectionCoordinator,
} from "./ProjectMcpConnection.ts";

const INPUT_STATE_TTL_MS = 10 * 60 * 1000;
const MAX_INPUT_ROUNDS = 10;

export type ProjectMcpBrokerErrorCode =
  | "missing_client_operation"
  | "invalid_request_state"
  | "input_round_limit"
  | "unsupported_extension_across_protocol_eras"
  | "invalid_extension_params";

export class ProjectMcpBrokerError extends Error {
  readonly code: ProjectMcpBrokerErrorCode;

  constructor(code: ProjectMcpBrokerErrorCode) {
    super(
      {
        missing_client_operation: "The connected MCP server does not support this operation.",
        invalid_request_state: "The MCP input request state is invalid or expired.",
        input_round_limit: "The MCP input request exceeded the maximum number of rounds.",
        unsupported_extension_across_protocol_eras:
          "The MCP extension is not supported across protocol eras.",
        invalid_extension_params: "The MCP extension parameters are invalid.",
      }[code],
    );
    this.code = code;
    this.name = "ProjectMcpBrokerError";
  }
}

export interface ProjectMcpBrokerHandlers {
  readonly onToolsChanged?: (result: ListToolsResult) => void | Promise<void>;
  readonly onPromptsChanged?: (result: ListPromptsResult) => void | Promise<void>;
  readonly onResourcesChanged?: (result: ListResourcesResult) => void | Promise<void>;
  readonly onResourceUpdated?: (uri: string) => void | Promise<void>;
  readonly onLoggingMessage?: (notification: Notification) => void | Promise<void>;
  readonly onRootsRequest?: (
    request: unknown,
    context?: ClientContext,
  ) => unknown | Promise<unknown>;
  readonly onSamplingRequest?: (
    request: unknown,
    context?: ClientContext,
  ) => unknown | Promise<unknown>;
  readonly onElicitationRequest?: (
    request: unknown,
    context?: ClientContext,
  ) => unknown | Promise<unknown>;
}

type RootsRequestHandler = NonNullable<ProjectMcpBrokerHandlers["onRootsRequest"]>;

export interface ProjectMcpExtensionSchemas {
  readonly params: StandardSchemaV1;
  readonly result: StandardSchemaV1;
}

export interface ProjectMcpExtensionAdapter extends ProjectMcpExtensionSchemas {
  readonly encodeParams?: (params: unknown) => unknown;
  readonly decodeResult?: (result: unknown) => unknown;
}

export interface ProjectMcpNotificationAdapter {
  readonly encodeParams?: (params: unknown) => unknown;
}

export interface ProjectMcpBrokerOptions {
  readonly connection: ProjectMcpConnection;
  readonly serverId: McpServerId;
  readonly providerSessionId: string;
  readonly downstreamProtocolEra?: ProtocolEra;
  readonly requestStateSecret?: string | Uint8Array;
  readonly now?: () => number;
  readonly handlers?: ProjectMcpBrokerHandlers;
  readonly extensionAdapters?: ReadonlyMap<string, ProjectMcpExtensionAdapter>;
  readonly notificationExtensionAdapters?: ReadonlyMap<string, ProjectMcpNotificationAdapter>;
}

export type ProjectMcpCallToolResult = CallToolResult | InputRequiredResult;
type ProjectMcpContinuationMethod = "tools/call" | "prompts/get" | "resources/read";
type ProjectMcpContinuationParams = Record<string, unknown> & {
  readonly inputResponses?: Record<string, unknown>;
  readonly requestState?: string;
};
export type ProjectMcpCallToolParams = CallToolRequestParams & ProjectMcpContinuationParams;
export type ProjectMcpGetPromptParams = GetPromptRequestParams & ProjectMcpContinuationParams;
export type ProjectMcpReadResourceParams = ReadResourceRequestParams & ProjectMcpContinuationParams;
export type ProjectMcpContinuationResult =
  | CallToolResult
  | GetPromptResult
  | ReadResourceResult
  | InputRequiredResult;
export type ProjectMcpRequestOptions = Parameters<Client["callTool"]>[1];
export type ProjectMcpListToolsParams = Parameters<Client["listTools"]>[0];
export type ProjectMcpListToolsOptions = Parameters<Client["listTools"]>[1];
export type ProjectMcpListResourcesParams = Parameters<Client["listResources"]>[0];
export type ProjectMcpListResourcesOptions = Parameters<Client["listResources"]>[1];
export type ProjectMcpListResourceTemplatesParams = Parameters<Client["listResourceTemplates"]>[0];
export type ProjectMcpListResourceTemplatesOptions = Parameters<Client["listResourceTemplates"]>[1];
export type ProjectMcpListPromptsParams = Parameters<Client["listPrompts"]>[0];
export type ProjectMcpListPromptsOptions = Parameters<Client["listPrompts"]>[1];

interface InputState {
  readonly version: 1;
  readonly serverId: string;
  readonly providerSessionId: string;
  readonly method: ProjectMcpContinuationMethod;
  readonly paramsHash: string;
  readonly upstreamRequestState?: string;
  readonly round: number;
  readonly expiresAt: number;
  readonly operationId?: string;
  readonly nonce?: string;
}

type LegacyServerRequestMethod = "roots/list" | "sampling/createMessage" | "elicitation/create";

interface PendingInput {
  key: string;
  request: InputRequest;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface LegacyOperation {
  method: ProjectMcpContinuationMethod;
  id: string;
  paramsHash: string;
  expiresAt: number;
  controller: AbortController;
  round: number;
  nonce?: string | undefined;
  inputs: PendingInput[];
  waiter?:
    | { resolve: (result: ProjectMcpContinuationResult) => void; reject: (error: unknown) => void }
    | undefined;
  options?: ProjectMcpRequestOptions;
  detach?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  release: () => void;
}

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
};

const paramsForHash = (params: Record<string, unknown>): Record<string, unknown> => {
  const {
    inputResponses: _inputResponses,
    requestState: _requestState,
    _meta,
    ...original
  } = params;
  if (!isRecord(_meta)) return original;
  const { progressToken: _progressToken, ...metadata } = _meta;
  return Object.keys(metadata).length ? { ...original, _meta: metadata } : original;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const methodNames = new Set([
  "initialize",
  "tools/call",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "ping",
  "server/discover",
  "logging/setLevel",
  "roots/list",
  "sampling/createMessage",
  "elicitation/create",
  "subscriptions/listen",
]);

// Keep protocol-owned notifications out of the custom-extension fallback path.
const standardNotificationMethods = new Set([
  "notifications/cancelled",
  "notifications/progress",
  "notifications/initialized",
  "notifications/roots/list_changed",
  "notifications/tasks/status",
  "notifications/message",
  "notifications/resources/updated",
  "notifications/resources/list_changed",
  "notifications/tools/list_changed",
  "notifications/prompts/list_changed",
  "notifications/elicitation/complete",
  "notifications/subscriptions/acknowledged",
]);

export class ProjectMcpBroker {
  readonly protocolEra: ProtocolEra | undefined;
  readonly negotiatedProtocolVersion: string | undefined;
  readonly discoverResult: DiscoverResult | undefined;
  readonly serverCapabilities: ProjectMcpConnection["serverCapabilities"];
  readonly serverVersion: ProjectMcpConnection["serverVersion"];

  private readonly connection: ProjectMcpConnection;
  private readonly serverId: McpServerId;
  private readonly providerSessionId: string;
  private readonly downstreamProtocolEra: ProtocolEra;
  private readonly requestStateSecret: string | Uint8Array;
  private readonly now: () => number;
  private readonly extensionAdapters: ReadonlyMap<string, ProjectMcpExtensionAdapter>;
  private readonly notificationExtensionAdapters: ReadonlyMap<
    string,
    ProjectMcpNotificationAdapter
  >;
  private active: LegacyOperation | undefined;
  private readonly disposeController = new AbortController();
  private readonly coordinator: ProjectMcpConnectionCoordinator;
  private readonly handlers = new Set<ProjectMcpBrokerHandlers>();
  private readonly handlerDisposers = new Set<() => void>();
  private disposing: Promise<void> | undefined;
  private readonly onConnectionClose = () => {
    if (this.active) this.failOperation(this.active, new Error("MCP connection closed"));
  };

  constructor(options: ProjectMcpBrokerOptions) {
    this.connection = options.connection;
    this.coordinator = projectMcpConnectionCoordinator(options.connection);
    this.coordinator.controller.signal.addEventListener("abort", this.onConnectionClose, {
      once: true,
    });
    this.serverId = options.serverId;
    this.providerSessionId = options.providerSessionId;
    this.protocolEra = options.connection.protocolEra;
    this.negotiatedProtocolVersion = options.connection.negotiatedProtocolVersion;
    this.discoverResult = options.connection.discoverResult;
    this.serverCapabilities = options.connection.serverCapabilities;
    this.serverVersion = options.connection.serverVersion;
    this.downstreamProtocolEra =
      options.downstreamProtocolEra ?? options.connection.protocolEra ?? "legacy";
    this.requestStateSecret = options.requestStateSecret ?? NodeCrypto.randomBytes(32);
    this.now = options.now ?? Date.now;
    this.extensionAdapters = options.extensionAdapters ?? new Map();
    this.notificationExtensionAdapters = options.notificationExtensionAdapters ?? new Map();
    this.setHandlers(options.handlers);
  }

  async close(): Promise<void> {
    await this.coordinator.close();
    await this.connection.close();
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    const disposeError = new Error("MCP facade disposed");
    this.disposeController.abort(disposeError);
    this.coordinator.controller.signal.removeEventListener("abort", this.onConnectionClose);
    if (this.active) this.failOperation(this.active, disposeError);
    for (const dispose of this.handlerDisposers) dispose();
    this.releaseRootsOwner(this);
    return (this.disposing = this.coordinator.releaseResourceOwner(this));
  }

  async ping(options?: RequestOptions) {
    return this.method("ping")(options);
  }

  async discover(options?: RequestOptions): Promise<DiscoverResult> {
    return this.method("discover")(options);
  }

  async complete(params: CompleteRequestParams, options?: RequestOptions): Promise<CompleteResult> {
    return this.method("complete")(params, options);
  }

  async setLoggingLevel(level: Parameters<Client["setLoggingLevel"]>[0], options?: RequestOptions) {
    return this.method("setLoggingLevel")(level, options);
  }

  async listTools(
    params?: ProjectMcpListToolsParams,
    options?: ProjectMcpListToolsOptions,
  ): Promise<ListToolsResult> {
    return this.method("listTools")(params, options);
  }

  async callTool(
    params: ProjectMcpCallToolParams,
    options?: ProjectMcpRequestOptions,
  ): Promise<ProjectMcpCallToolResult> {
    if (this.active && this.active.expiresAt <= this.now()) {
      this.failOperation(this.active, new ProjectMcpBrokerError("invalid_request_state"));
    }
    const input = params as Record<string, unknown>;
    const state =
      typeof input.requestState === "string"
        ? this.verifyInputState(input.requestState, "tools/call", input)
        : undefined;
    if (this.shouldBridgeLegacyServerRequests())
      return this.callLegacyOperation("tools/call", params, state, options);
    return this.callWithInputRequired("tools/call", params, options, state);
  }

  async listResources(
    params?: ProjectMcpListResourcesParams,
    options?: ProjectMcpListResourcesOptions,
  ): Promise<ListResourcesResult> {
    return this.method("listResources")(params, options);
  }

  async listResourceTemplates(
    params?: ProjectMcpListResourceTemplatesParams,
    options?: ProjectMcpListResourceTemplatesOptions,
  ): Promise<ListResourceTemplatesResult> {
    return this.method("listResourceTemplates")(params, options);
  }

  async readResource(
    params: ProjectMcpReadResourceParams,
    options?: Parameters<Client["readResource"]>[1],
  ): Promise<ReadResourceResult | InputRequiredResult> {
    const input = params as Record<string, unknown>;
    const state =
      typeof input.requestState === "string"
        ? this.verifyInputState(input.requestState, "resources/read", input)
        : undefined;
    if (this.shouldBridgeLegacyServerRequests())
      return this.callLegacyOperation("resources/read", params, state, options);
    return this.callWithInputRequired("resources/read", params, options, state);
  }

  async subscribeResource(
    params: Parameters<Client["subscribeResource"]>[0],
    options?: RequestOptions,
  ) {
    await this.coordinator.subscribeResource(params.uri, this, options);
    return {};
  }

  async unsubscribeResource(
    params: Parameters<Client["unsubscribeResource"]>[0],
    options?: RequestOptions,
  ) {
    options?.signal?.throwIfAborted();
    await this.coordinator.unsubscribeResource(params.uri, this);
    return {};
  }

  async listen(filter: SubscriptionFilter, options?: RequestOptions): Promise<McpSubscription> {
    return this.method("listen")(filter, options);
  }

  async listPrompts(
    params?: ProjectMcpListPromptsParams,
    options?: ProjectMcpListPromptsOptions,
  ): Promise<ListPromptsResult> {
    return this.method("listPrompts")(params, options);
  }

  async getPrompt(
    params: ProjectMcpGetPromptParams,
    options?: RequestOptions,
  ): Promise<GetPromptResult | InputRequiredResult> {
    const input = params as Record<string, unknown>;
    const state =
      typeof input.requestState === "string"
        ? this.verifyInputState(input.requestState, "prompts/get", input)
        : undefined;
    if (this.shouldBridgeLegacyServerRequests())
      return this.callLegacyOperation("prompts/get", params, state, options);
    return this.callWithInputRequired("prompts/get", params, options, state);
  }

  async notify(notification: Notification, options?: NotificationOptions): Promise<void> {
    return this.method("notification")(notification, options);
  }

  async notifyExtension(
    method: string,
    params: unknown,
    options?: NotificationOptions,
  ): Promise<void> {
    if (!method || standardNotificationMethods.has(method))
      throw new ProjectMcpBrokerError("invalid_extension_params");
    if (this.protocolEra !== this.downstreamProtocolEra) {
      const adapter = this.notificationExtensionAdapters.get(method);
      if (adapter === undefined)
        throw new ProjectMcpBrokerError("unsupported_extension_across_protocol_eras");
      params = adapter.encodeParams ? adapter.encodeParams(params) : params;
    }
    return this.method("notification")(
      { method, ...(params === undefined ? {} : { params }) } as Notification,
      options,
    );
  }

  async notifyRootsListChanged(options?: NotificationOptions): Promise<void> {
    return this.notifyRootsListChangedFor(
      this,
      (request, context) =>
        this.handleUpstreamServerRequestFromCoordinator("roots/list", request, context),
      options,
    );
  }

  async notifyRootsListChangedFor(
    owner: object,
    handler: RootsRequestHandler,
    options?: NotificationOptions,
  ): Promise<void> {
    const replacement = this.coordinator.replaceRootsOwner(owner, (method, request, context) => {
      if (method !== "roots/list")
        throw new ProtocolError(ProtocolErrorCode.MethodNotFound, "Unsupported MCP server request");
      return handler(request, context);
    });
    try {
      await this.method("notification")({ method: "notifications/roots/list_changed" }, options);
      if (replacement !== undefined) this.coordinator.commitRootsOwner(replacement);
    } catch (error) {
      if (replacement !== undefined) this.coordinator.rollbackRootsOwner(replacement);
      throw error;
    }
  }

  releaseRootsOwner(owner: object): void {
    this.coordinator.releaseRootsOwner(owner);
  }

  async requestExtension<T>(
    method: string,
    params: unknown,
    schemas: ProjectMcpExtensionSchemas,
    options?: RequestOptions,
  ): Promise<T> {
    if (!method || methodNames.has(method))
      throw new ProjectMcpBrokerError("invalid_extension_params");
    if (this.protocolEra !== this.downstreamProtocolEra) {
      const adapter = this.extensionAdapters.get(method);
      if (adapter === undefined) {
        throw new ProjectMcpBrokerError("unsupported_extension_across_protocol_eras");
      }
      params = adapter.encodeParams ? adapter.encodeParams(params) : params;
      schemas = adapter;
    }
    const parsed = await schemas.params["~standard"].validate(params);
    if (parsed.issues) throw new ProjectMcpBrokerError("invalid_extension_params");
    const request = this.method("request") as unknown as (
      request: { method: string; params: Record<string, unknown> },
      resultSchema: StandardSchemaV1,
      options?: RequestOptions,
    ) => Promise<unknown>;
    const result = await request(
      { method, params: parsed.value as Record<string, unknown> },
      schemas.result,
      options,
    );
    return (
      this.protocolEra !== this.downstreamProtocolEra
        ? (this.extensionAdapters.get(method)!.decodeResult?.(result) ?? result)
        : result
    ) as T;
  }

  private method<K extends keyof ProjectMcpClient>(key: K): NonNullable<ProjectMcpClient[K]> {
    const value = this.connection.client[key];
    if (typeof value !== "function") throw new ProjectMcpBrokerError("missing_client_operation");
    const bound = value.bind(this.connection.client);
    if (
      this.protocolEra !== "legacy" ||
      ((key === "callTool" || key === "getPrompt" || key === "readResource") &&
        this.shouldBridgeLegacyServerRequests()) ||
      key === "notification"
    ) {
      return bound as NonNullable<ProjectMcpClient[K]>;
    }
    return (async (...args: unknown[]) => {
      const options = args.at(-1);
      const callerSignal =
        isRecord(options) && options.signal instanceof AbortSignal ? options.signal : undefined;
      const signal = this.lifecycleSignal(callerSignal);
      const release = await this.acquire(signal);
      try {
        signal.throwIfAborted();
        const invocationArgs =
          key === "callTool" || key === "getPrompt" || key === "readResource"
            ? [args[0], { ...(args[1] as RequestOptions | undefined), signal }]
            : args;
        return await Reflect.apply(bound, undefined, invocationArgs);
      } finally {
        release();
      }
    }) as NonNullable<ProjectMcpClient[K]>;
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    return this.coordinator.acquire(this.handleUpstreamServerRequestFromCoordinator, signal);
  }

  private lifecycleSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.disposeController.signal])
      : this.disposeController.signal;
  }

  private readonly handleUpstreamServerRequestFromCoordinator = (
    method: string,
    request: unknown,
    context?: ClientContext,
  ): unknown | Promise<unknown> => {
    if (
      method !== "roots/list" &&
      method !== "sampling/createMessage" &&
      method !== "elicitation/create"
    ) {
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, "Unsupported MCP server request");
    }
    const key =
      method === "roots/list"
        ? "onRootsRequest"
        : method === "sampling/createMessage"
          ? "onSamplingRequest"
          : "onElicitationRequest";
    const handlers = [...this.handlers].flatMap((handlers) =>
      handlers[key] ? [handlers[key]] : [],
    );
    return this.handleUpstreamServerRequest(
      method,
      request,
      (request, context) => {
        if (handlers.length !== 1)
          throw new ProtocolError(
            ProtocolErrorCode.MethodNotFound,
            "Unassociated MCP server request is unsupported",
          );
        return handlers[0]!(request, context);
      },
      context,
    );
  };

  private finishOperation(operation: LegacyOperation): void {
    operation.detach?.();
    clearTimeout(operation.timer);
    if (this.active === operation) this.active = undefined;
    operation.release();
  }

  private async callWithInputRequired(
    method: "tools/call",
    params: ProjectMcpContinuationParams,
    options: RequestOptions | undefined,
    state: InputState | undefined,
  ): Promise<ProjectMcpCallToolResult>;
  private async callWithInputRequired(
    method: "prompts/get",
    params: ProjectMcpContinuationParams,
    options: RequestOptions | undefined,
    state: InputState | undefined,
  ): Promise<GetPromptResult | InputRequiredResult>;
  private async callWithInputRequired(
    method: "resources/read",
    params: ProjectMcpContinuationParams,
    options: RequestOptions | undefined,
    state: InputState | undefined,
  ): Promise<ReadResourceResult | InputRequiredResult>;
  private async callWithInputRequired(
    method: ProjectMcpContinuationMethod,
    params: ProjectMcpContinuationParams,
    options: RequestOptions | undefined,
    state: InputState | undefined,
  ): Promise<ProjectMcpContinuationResult> {
    const outbound = state ? this.retryParams(params, state) : params;
    const clientMethod =
      method === "tools/call"
        ? "callTool"
        : method === "prompts/get"
          ? "getPrompt"
          : "readResource";
    const result = (await this.method(clientMethod)(outbound as never, {
      ...options,
      allowInputRequired: true,
    })) as ProjectMcpContinuationResult;
    if (!isInputRequiredResult(result)) return result;
    const round = state ? state.round + 1 : 0;
    if (round > MAX_INPUT_ROUNDS) throw new ProjectMcpBrokerError("input_round_limit");
    return {
      ...result,
      requestState: this.signInputState({
        version: 1,
        serverId: String(this.serverId),
        providerSessionId: this.providerSessionId,
        method,
        paramsHash: canonicalJson(paramsForHash(params)),
        ...(result.requestState !== undefined ? { upstreamRequestState: result.requestState } : {}),
        round,
        expiresAt: this.now() + INPUT_STATE_TTL_MS,
      }),
    };
  }

  private failOperation(operation: LegacyOperation, error: unknown): void {
    if (this.active !== operation) return;
    operation.controller.abort(error);
    for (const input of operation.inputs.splice(0)) input.reject(error);
    operation.waiter?.reject(error);
    operation.waiter = undefined;
    this.finishOperation(operation);
  }

  private waitForOperation(
    operation: LegacyOperation,
    options?: ProjectMcpRequestOptions,
  ): Promise<ProjectMcpContinuationResult> {
    operation.options = options;
    return new Promise((resolve, reject) => {
      operation.waiter = { resolve, reject };
      const abort = () =>
        this.failOperation(
          operation,
          options?.signal?.reason ?? new Error("MCP request cancelled"),
        );
      operation.detach = () => options?.signal?.removeEventListener("abort", abort);
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private publishInput(operation: LegacyOperation): void {
    const input = operation.inputs[0];
    if (!input || !operation.waiter) return;
    if (operation.round >= MAX_INPUT_ROUNDS) {
      this.failOperation(operation, new ProjectMcpBrokerError("input_round_limit"));
      return;
    }
    operation.nonce = NodeCrypto.randomUUID();
    const waiter = operation.waiter;
    operation.waiter = undefined;
    operation.detach?.();
    operation.options = undefined;
    waiter.resolve({
      resultType: "input_required",
      inputRequests: { [input.key]: input.request },
      requestState: this.signInputState({
        version: 1,
        serverId: String(this.serverId),
        providerSessionId: this.providerSessionId,
        method: operation.method,
        paramsHash: operation.paramsHash,
        operationId: operation.id,
        nonce: operation.nonce,
        round: operation.round++,
        expiresAt: operation.expiresAt,
      }),
    });
  }

  private callLegacyOperation(
    method: "tools/call",
    params: ProjectMcpCallToolParams,
    state: InputState | undefined,
    options?: ProjectMcpRequestOptions,
  ): Promise<ProjectMcpCallToolResult>;
  private callLegacyOperation(
    method: "prompts/get",
    params: ProjectMcpGetPromptParams,
    state: InputState | undefined,
    options?: ProjectMcpRequestOptions,
  ): Promise<GetPromptResult | InputRequiredResult>;
  private callLegacyOperation(
    method: "resources/read",
    params: ProjectMcpReadResourceParams,
    state: InputState | undefined,
    options?: ProjectMcpRequestOptions,
  ): Promise<ReadResourceResult | InputRequiredResult>;
  private async callLegacyOperation(
    method: ProjectMcpContinuationMethod,
    params: ProjectMcpContinuationParams,
    state: InputState | undefined,
    options?: ProjectMcpRequestOptions,
  ): Promise<ProjectMcpContinuationResult> {
    if (state) {
      const operation = this.active;
      const pending = operation?.inputs[0];
      if (
        !operation ||
        operation.method !== method ||
        !pending ||
        operation.id !== state.operationId ||
        !operation.nonce ||
        operation.nonce !== state.nonce ||
        !params.inputResponses ||
        !Object.hasOwn(params.inputResponses, pending.key) ||
        Object.keys(params.inputResponses).length !== 1
      ) {
        throw new ProjectMcpBrokerError("invalid_request_state");
      }
      // Claim before the first await so concurrent resumes cannot consume the same round.
      operation.nonce = undefined;
      const result = this.waitForOperation(operation, options);
      if (this.active === operation) {
        operation.inputs.shift();
        pending.resolve(params.inputResponses[pending.key]);
        this.publishInput(operation);
      }
      return result;
    }
    if (params.inputResponses) throw new ProjectMcpBrokerError("invalid_request_state");
    const signal = this.lifecycleSignal(options?.signal);
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
    } catch (error) {
      release();
      throw error;
    }
    const operation: LegacyOperation = {
      method,
      id: NodeCrypto.randomUUID(),
      paramsHash: canonicalJson(paramsForHash(params)),
      expiresAt: this.now() + INPUT_STATE_TTL_MS,
      controller: new AbortController(),
      round: 0,
      inputs: [],
      release,
    };
    this.active = operation;
    // The Promise-based SDK invocation owns this deadline, outside an Effect runtime.
    // @effect-diagnostics-next-line globalTimers:off
    operation.timer = setTimeout(
      () => this.failOperation(operation, new ProjectMcpBrokerError("invalid_request_state")),
      INPUT_STATE_TTL_MS,
    );
    operation.timer.unref?.();
    const result = this.waitForOperation(operation, options);
    if (this.active !== operation) return result;
    void Promise.resolve()
      .then(() => {
        const clientMethod =
          method === "tools/call"
            ? "callTool"
            : method === "prompts/get"
              ? "getPrompt"
              : "readResource";
        const invoke = this.method(clientMethod) as unknown as (
          params: ProjectMcpContinuationParams,
          options: ProjectMcpRequestOptions,
        ) => Promise<ProjectMcpContinuationResult>;
        return invoke(params, {
          ...options,
          signal: operation.controller.signal,
          timeout: INPUT_STATE_TTL_MS,
          maxTotalTimeout: INPUT_STATE_TTL_MS,
          resetTimeoutOnProgress: false,
          onprogress: (progress) => operation.options?.onprogress?.(progress),
        });
      })
      .then(
        (completed) => {
          if (this.active !== operation) return;
          operation.waiter?.resolve(completed);
          for (const pending of operation.inputs.splice(0))
            pending.reject(new Error("MCP invocation completed"));
          this.finishOperation(operation);
        },
        (error: unknown) => this.failOperation(operation, error),
      );
    return result;
  }

  private signInputState(state: InputState): string {
    const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
    const signature = NodeCrypto.createHmac("sha256", this.requestStateSecret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private verifyInputState(
    encoded: string,
    method: ProjectMcpContinuationMethod,
    params: Record<string, unknown>,
  ): InputState {
    const parts = encoded.split(".");
    if (parts.length !== 2) throw new ProjectMcpBrokerError("invalid_request_state");
    const payload = parts[0];
    const signature = parts[1];
    if (payload === undefined || signature === undefined) {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    const expected = NodeCrypto.createHmac("sha256", this.requestStateSecret)
      .update(payload)
      .digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "base64url");
    } catch {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    if (received.length !== expected.length || !NodeCrypto.timingSafeEqual(received, expected)) {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    if (
      !isRecord(decoded) ||
      decoded.version !== 1 ||
      decoded.serverId !== String(this.serverId) ||
      decoded.providerSessionId !== this.providerSessionId ||
      decoded.method !== method ||
      typeof decoded.paramsHash !== "string" ||
      typeof decoded.round !== "number" ||
      !Number.isInteger(decoded.round) ||
      decoded.round < 0 ||
      decoded.round > MAX_INPUT_ROUNDS ||
      typeof decoded.expiresAt !== "number" ||
      decoded.expiresAt < this.now()
    ) {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    if (decoded.paramsHash !== canonicalJson(paramsForHash(params))) {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    return decoded as unknown as InputState;
  }

  private retryParams(params: Record<string, unknown>, state: InputState): Record<string, unknown> {
    if (state.round >= MAX_INPUT_ROUNDS) throw new ProjectMcpBrokerError("input_round_limit");
    const { requestState: _requestState, ...withoutBrokerState } = params;
    return state.upstreamRequestState === undefined
      ? withoutBrokerState
      : { ...withoutBrokerState, requestState: state.upstreamRequestState };
  }

  private shouldBridgeLegacyServerRequests(): boolean {
    return this.protocolEra === "legacy" && this.downstreamProtocolEra === "modern";
  }

  private handleUpstreamServerRequest(
    method: LegacyServerRequestMethod,
    request: unknown,
    handler: (request: unknown, context?: ClientContext) => unknown | Promise<unknown>,
    context?: ClientContext,
  ): unknown | Promise<unknown> {
    if (!this.shouldBridgeLegacyServerRequests()) return handler(request, context);
    const operation = this.active;
    if (!operation) {
      if (method === "roots/list" && this.coordinator.ownsRootsOwner(this))
        return handler(request, context);
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        "Unassociated MCP server request is unsupported",
      );
    }
    const params =
      isRecord(request) && isRecord(request.params) ? { params: request.params } : undefined;
    const inputRequest = {
      method,
      ...params,
    } as InputRequest;
    return new Promise((resolve, reject) => {
      const signal = context?.mcpReq.signal;
      const abort = () =>
        this.failOperation(operation, signal?.reason ?? new Error("MCP input cancelled"));
      if (signal?.aborted) {
        abort();
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      operation.inputs.push({
        key: `legacy-input-${operation.round + operation.inputs.length}`,
        request: inputRequest,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      this.publishInput(operation);
    });
  }

  setHandlers(handlers: ProjectMcpBrokerHandlers | undefined): () => void {
    if (!handlers) return () => undefined;
    this.handlers.add(handlers);
    const dispose = this.coordinator.addListener(async (notification) => {
      if (notification.method === "notifications/tools/list_changed" && handlers.onToolsChanged) {
        await handlers.onToolsChanged!(await this.listTools(undefined, { cacheMode: "refresh" }));
      }
      if (
        notification.method === "notifications/prompts/list_changed" &&
        handlers.onPromptsChanged
      ) {
        await handlers.onPromptsChanged!(
          await this.listPrompts(undefined, { cacheMode: "refresh" }),
        );
      }
      if (
        notification.method === "notifications/resources/list_changed" &&
        handlers.onResourcesChanged
      ) {
        await handlers.onResourcesChanged!(
          await this.listResources(undefined, { cacheMode: "refresh" }),
        );
      }
      if (notification.method === "notifications/resources/updated" && handlers.onResourceUpdated) {
        const params =
          isRecord(notification.params) && typeof notification.params.uri === "string"
            ? notification.params.uri
            : undefined;
        if (params && this.coordinator.ownsResource(params, this))
          await handlers.onResourceUpdated!(params);
      }
      if (notification.method === "notifications/message" && handlers.onLoggingMessage) {
        await handlers.onLoggingMessage(notification);
      }
    });
    const disposeHandlers = () => {
      this.handlers.delete(handlers);
      dispose();
      this.handlerDisposers.delete(disposeHandlers);
    };
    this.handlerDisposers.add(disposeHandlers);
    return disposeHandlers;
  }
}

export const makeProjectMcpBroker = (options: ProjectMcpBrokerOptions): ProjectMcpBroker =>
  new ProjectMcpBroker(options);
