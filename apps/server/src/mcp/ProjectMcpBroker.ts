import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { McpServerId } from "@t3tools/contracts";
import type {
  CallToolRequestParams,
  CallToolResult,
  Client,
  CompleteRequestParams,
  CompleteResult,
  DiscoverResult,
  GetPromptRequestParams,
  GetPromptResult,
  InputRequiredResult,
  ListPromptsRequest,
  ListPromptsResult,
  ListResourceTemplatesRequest,
  ListResourceTemplatesResult,
  ListResourcesRequest,
  ListResourcesResult,
  ListToolsRequest,
  ListToolsResult,
  McpSubscription,
  Notification,
  NotificationOptions,
  ProtocolEra,
  Progress,
  RequestOptions,
  StandardSchemaV1,
  SubscriptionFilter,
} from "@modelcontextprotocol/client";
import { isInputRequiredResult } from "@modelcontextprotocol/client";

import type { ProjectMcpClient, ProjectMcpConnection } from "./ProjectMcpConnection.ts";

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
  readonly onProgress?: (progress: Progress) => void | Promise<void>;
  readonly onRootsRequest?: (request: unknown) => unknown | Promise<unknown>;
  readonly onSamplingRequest?: (request: unknown) => unknown | Promise<unknown>;
  readonly onElicitationRequest?: (request: unknown) => unknown | Promise<unknown>;
}

export interface ProjectMcpExtensionSchemas {
  readonly params: StandardSchemaV1;
  readonly result: StandardSchemaV1;
}

export interface ProjectMcpExtensionAdapter extends ProjectMcpExtensionSchemas {
  readonly encodeParams?: (params: unknown) => unknown;
  readonly decodeResult?: (result: unknown) => unknown;
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
}

export type ProjectMcpCallToolResult = CallToolResult | InputRequiredResult;
export type ProjectMcpCallToolParams = CallToolRequestParams & {
  readonly inputResponses?: Record<string, unknown>;
  readonly requestState?: string;
};
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
  readonly method: "tools/call";
  readonly paramsHash: string;
  readonly upstreamRequestState?: string;
  readonly round: number;
  readonly expiresAt: number;
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
  const { inputResponses: _inputResponses, requestState: _requestState, ...original } = params;
  return original;
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

  constructor(options: ProjectMcpBrokerOptions) {
    this.connection = options.connection;
    this.serverId = options.serverId;
    this.providerSessionId = options.providerSessionId;
    this.protocolEra = options.connection.protocolEra;
    this.negotiatedProtocolVersion = options.connection.negotiatedProtocolVersion;
    this.discoverResult = options.connection.discoverResult;
    this.serverCapabilities = options.connection.serverCapabilities;
    this.serverVersion = options.connection.serverVersion;
    this.downstreamProtocolEra =
      options.downstreamProtocolEra ?? options.connection.protocolEra ?? "legacy";
    this.requestStateSecret = options.requestStateSecret ?? randomBytes(32);
    this.now = options.now ?? Date.now;
    this.extensionAdapters = options.extensionAdapters ?? new Map();
    this.setHandlers(options.handlers);
  }

  async close(): Promise<void> {
    await this.connection.close();
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
    const input = params as Record<string, unknown>;
    const state =
      typeof input.requestState === "string"
        ? this.verifyInputState(input.requestState, input)
        : undefined;
    const outbound = state ? this.retryParams(input, state) : params;
    const result = (await this.method("callTool")(outbound as ProjectMcpCallToolParams, {
      ...options,
      allowInputRequired: true,
    })) as ProjectMcpCallToolResult;
    if (!isInputRequiredResult(result)) return result;
    const round = state ? state.round + 1 : 0;
    if (round > MAX_INPUT_ROUNDS) throw new ProjectMcpBrokerError("input_round_limit");
    return {
      ...result,
      requestState: this.signInputState({
        version: 1,
        serverId: String(this.serverId),
        providerSessionId: this.providerSessionId,
        method: "tools/call",
        paramsHash: canonicalJson(paramsForHash(input)),
        ...(result.requestState !== undefined ? { upstreamRequestState: result.requestState } : {}),
        round,
        expiresAt: this.now() + INPUT_STATE_TTL_MS,
      }),
    };
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
    params: Parameters<Client["readResource"]>[0],
    options?: Parameters<Client["readResource"]>[1],
  ) {
    return this.method("readResource")(params, options);
  }

  async subscribeResource(
    params: Parameters<Client["subscribeResource"]>[0],
    options?: RequestOptions,
  ) {
    return this.method("subscribeResource")(params, options);
  }

  async unsubscribeResource(
    params: Parameters<Client["unsubscribeResource"]>[0],
    options?: RequestOptions,
  ) {
    return this.method("unsubscribeResource")(params, options);
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
    params: GetPromptRequestParams,
    options?: RequestOptions,
  ): Promise<GetPromptResult> {
    return this.method("getPrompt")(params, options);
  }

  async notify(notification: Notification, options?: NotificationOptions): Promise<void> {
    return this.method("notification")(notification, options);
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
    return value.bind(this.connection.client) as NonNullable<ProjectMcpClient[K]>;
  }

  private signInputState(state: InputState): string {
    const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
    const signature = createHmac("sha256", this.requestStateSecret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  private verifyInputState(encoded: string, params: Record<string, unknown>): InputState {
    const parts = encoded.split(".");
    if (parts.length !== 2) throw new ProjectMcpBrokerError("invalid_request_state");
    const payload = parts[0];
    const signature = parts[1];
    if (payload === undefined || signature === undefined) {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    const expected = createHmac("sha256", this.requestStateSecret).update(payload).digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, "base64url");
    } catch {
      throw new ProjectMcpBrokerError("invalid_request_state");
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
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
      decoded.method !== "tools/call" ||
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

  setHandlers(handlers: ProjectMcpBrokerHandlers | undefined): void {
    if (!handlers) return;
    const client = this.connection.client;
    if (typeof client.setNotificationHandler === "function") {
      const setNotificationHandler = client.setNotificationHandler.bind(client) as unknown as (
        method: string,
        handler: (notification: Notification) => void | Promise<void>,
      ) => void;
      if (handlers.onToolsChanged) {
        setNotificationHandler("notifications/tools/list_changed", async () => {
          await handlers.onToolsChanged!(await this.listTools(undefined, { cacheMode: "refresh" }));
        });
      }
      if (handlers.onPromptsChanged) {
        setNotificationHandler("notifications/prompts/list_changed", async () => {
          await handlers.onPromptsChanged!(
            await this.listPrompts(undefined, { cacheMode: "refresh" }),
          );
        });
      }
      if (handlers.onResourcesChanged) {
        setNotificationHandler("notifications/resources/list_changed", async () => {
          await handlers.onResourcesChanged!(
            await this.listResources(undefined, { cacheMode: "refresh" }),
          );
        });
      }
      if (handlers.onResourceUpdated) {
        setNotificationHandler("notifications/resources/updated", async (notification) => {
          const params =
            isRecord(notification.params) && typeof notification.params.uri === "string"
              ? notification.params.uri
              : undefined;
          if (params) await handlers.onResourceUpdated!(params);
        });
      }
      if (handlers.onLoggingMessage) {
        setNotificationHandler("notifications/message", handlers.onLoggingMessage);
      }
      if (handlers.onProgress) {
        setNotificationHandler("notifications/progress", async (notification) => {
          await handlers.onProgress!(notification.params as unknown as Progress);
        });
      }
    }
    if (typeof client.setRequestHandler === "function") {
      const setRequestHandler = client.setRequestHandler.bind(client) as unknown as (
        method: string,
        handler: (request: unknown) => unknown | Promise<unknown>,
      ) => void;
      if (handlers.onRootsRequest) setRequestHandler("roots/list", handlers.onRootsRequest);
      if (handlers.onSamplingRequest)
        setRequestHandler("sampling/createMessage", handlers.onSamplingRequest);
      if (handlers.onElicitationRequest)
        setRequestHandler("elicitation/create", handlers.onElicitationRequest);
    }
  }
}

export const makeProjectMcpBroker = (options: ProjectMcpBrokerOptions): ProjectMcpBroker =>
  new ProjectMcpBroker(options);
