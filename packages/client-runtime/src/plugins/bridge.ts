import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  PLUGIN_HOST_API,
  PLUGIN_LIMITS,
  PluginContributionId,
  PluginReferenceLocator,
  PluginRequestError,
  type PluginManifest,
  type PluginRequestErrorReason,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";
import { isHostApiCompatible } from "@t3tools/shared/pluginManifest";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { jsonBytes } from "../mcpApps/host.ts";

export interface PluginHostContext {
  readonly apiVersion: "1.0";
  readonly theme: "light" | "dark";
  readonly styles: { readonly variables: Readonly<Record<string, string>> };
  readonly containerDimensions: { readonly width: number; readonly height: number };
  readonly platform: "web" | "desktop" | "mobile";
  readonly destination:
    | { readonly kind: "client" }
    | { readonly kind: "environment"; readonly environmentId: string; readonly label: string };
  readonly chatTarget: { readonly key: string; readonly title: string } | null;
}

export interface PluginBridgeOptions {
  readonly manifest: PluginManifest;
  readonly panelId: string;
  readonly post: (message: unknown) => void;
  readonly hostContext: () => PluginHostContext;
  readonly pluginVersion: string;
  readonly state: {
    readonly get: () => Promise<{ readonly value: unknown; readonly version: string } | null>;
    readonly set: (value: unknown) => Promise<void>;
  };
  readonly backend?: {
    readonly call: (operation: string, input: unknown) => Promise<unknown>;
    readonly subscribe: (
      topic: string,
      params: unknown,
      onEvent: (e: PluginSubscriptionEvent) => void,
    ) => () => void;
  };
  readonly openSurface: (contributionId: string) => Promise<void>;
  readonly attach: (
    request: PluginAttachRequest,
    activated: boolean,
  ) => Promise<"inserted" | "cancelled">;
}

export type PluginAttachRequest =
  | { readonly kind: "text"; readonly text: string; readonly expectedChatTargetKey: string | null }
  | {
      readonly kind: "reference";
      readonly label: string;
      readonly locator: Readonly<Record<string, string>>;
      /** Unbounded here; the host truncates it to the context record's snapshot limit. */
      readonly snapshot: string;
      readonly expectedChatTargetKey: string | null;
    };

export interface PluginBridge {
  /** Handles one message the frame posted; the caller has already checked its source. */
  readonly receive: (data: unknown, activated: boolean) => void;
  readonly updateHostContext: () => void;
  readonly hostReconnected: () => void;
  readonly dispose: () => void;
}

type JsonRpcId = string | number;

const NOT_INITIALIZED = -32002;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const REQUEST_FAILED = -32000;

const NonEmptyText = Schema.String.check(Schema.isNonEmpty());
const ChatTargetKey = Schema.NullOr(Schema.String);

const InitializeParams = Schema.Struct({ apiVersion: Schema.String });
const StateSetParams = Schema.Struct({ value: Schema.Unknown });
const BackendCallParams = Schema.Struct({
  operation: Schema.String,
  input: Schema.optional(Schema.Unknown),
});
const SubscribeParams = Schema.Struct({
  topic: Schema.String,
  params: Schema.optional(Schema.Unknown),
});
const UnsubscribeParams = Schema.Struct({ subscriptionId: Schema.String });
const SurfaceOpenParams = Schema.Struct({ contributionId: PluginContributionId });
const AttachParams = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    text: NonEmptyText,
    expectedChatTargetKey: ChatTargetKey,
  }),
  Schema.Struct({
    kind: Schema.Literal("reference"),
    label: NonEmptyText.check(Schema.isMaxLength(COMPOSER_CONTEXT_LABEL_MAX_CHARS)),
    locator: PluginReferenceLocator,
    snapshot: Schema.String,
    expectedChatTargetKey: ChatTargetKey,
  }),
]);

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  params: unknown,
) => Schema.decodeUnknownOption(schema)(params);

class BridgeFailure extends Error {
  readonly code: number;
  readonly reason: PluginRequestErrorReason | undefined;
  constructor(code: number, message: string, reason?: PluginRequestErrorReason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

const isPluginRequestError = Schema.is(PluginRequestError);

const refusal = (reason: PluginRequestErrorReason) =>
  new BridgeFailure(REQUEST_FAILED, new PluginRequestError({ reason }).message, reason);

const errorPayload = (error: unknown) => {
  if (error instanceof BridgeFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.reason === undefined ? {} : { data: { reason: error.reason } }),
    };
  }
  if (isPluginRequestError(error)) {
    return {
      code: REQUEST_FAILED,
      message: error.message,
      data: {
        reason: error.reason,
        ...(error.detail === undefined ? {} : { detail: error.detail }),
      },
    };
  }
  return {
    code: REQUEST_FAILED,
    message:
      error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.",
  };
};

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const isPlainJson = (root: unknown): boolean => {
  const stack: Array<unknown> = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return false;
    } else if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const child of Object.values(value)) stack.push(child);
  }
  return true;
};

const encoder = new TextEncoder();

/**
 * postMessage delivers structured clones, so an ArrayBuffer, Map or Blob would slip past a
 * JSON size check. Accepts only plain JSON, returning a JSON copy and its UTF-8 size.
 */
const normaliseMessage = (data: unknown) => {
  if (!isPlainJson(data)) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  const bytes = encoder.encode(json).byteLength;
  if (bytes > PLUGIN_LIMITS.maxMessageBytes) return { bytes, value: undefined };
  return { bytes, value: JSON.parse(json) as unknown };
};

interface LiveSubscription {
  readonly topic: string;
  readonly params: unknown;
  readonly token: object;
  dispose: () => void;
}

export function makePluginBridge(options: PluginBridgeOptions): PluginBridge {
  const { manifest } = options;
  let initialized = false;
  let disposed = false;
  let pending = 0;
  let sentContext = "";
  let nextSubscriptionId = 0;
  const subscriptions = new Map<string, LiveSubscription>();

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const fail = (id: JsonRpcId, error: unknown) =>
    post({ jsonrpc: "2.0", id, error: errorPayload(error) });
  const respond = (id: JsonRpcId, result: unknown) => {
    const message = { jsonrpc: "2.0", id, result: result ?? null };
    if (jsonBytes(message) > PLUGIN_LIMITS.maxMessageBytes) fail(id, refusal("too-large"));
    else post(message);
  };

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= PLUGIN_LIMITS.maxPendingRequests) {
      fail(id, new BridgeFailure(REQUEST_FAILED, "Too many requests in flight."));
      return;
    }
    pending += 1;
    void new Promise<unknown>((resolve) => resolve(run())).then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, error);
      },
    );
  };

  const params = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    value: unknown,
    method: string,
  ): S["Type"] => {
    const decoded = decode(schema, value);
    if (Option.isNone(decoded)) {
      throw new BridgeFailure(INVALID_PARAMS, `Invalid params for ${method}.`);
    }
    return decoded.value;
  };

  const requireBackend = () => {
    if (manifest.backend === undefined || options.backend === undefined) {
      throw refusal("unknown-operation");
    }
    return { declared: manifest.backend, backend: options.backend };
  };

  const subscribe = (subscriptionId: string, topic: string, subscriptionParams: unknown) => {
    const { backend } = requireBackend();
    const entry: LiveSubscription = {
      topic,
      params: subscriptionParams,
      token: {},
      dispose: () => undefined,
    };
    subscriptions.set(subscriptionId, entry);
    let dispose: () => void;
    try {
      dispose = backend.subscribe(topic, subscriptionParams, (event) => {
        if (disposed || subscriptions.get(subscriptionId)?.token !== entry.token) return;
        const message = {
          jsonrpc: "2.0",
          method: "t3/backend.event",
          params: { subscriptionId, event },
        };
        if (event.type === "closed") {
          subscriptions.delete(subscriptionId);
          entry.dispose();
        }
        if (jsonBytes(message) <= PLUGIN_LIMITS.maxMessageBytes) {
          post(message);
          return;
        }
        subscriptions.delete(subscriptionId);
        entry.dispose();
        notify("t3/backend.event", {
          subscriptionId,
          event: { type: "closed", reason: "too-large" },
        });
      });
    } catch (error) {
      if (subscriptions.get(subscriptionId)?.token === entry.token) {
        subscriptions.delete(subscriptionId);
      }
      throw error;
    }
    if (subscriptions.get(subscriptionId)?.token === entry.token) entry.dispose = dispose;
    else dispose();
  };

  const handleRequest = (id: JsonRpcId, method: string, rawParams: unknown, activated: boolean) => {
    if (method === "t3/initialize") {
      const { apiVersion } = params(InitializeParams, rawParams, method);
      if (!isHostApiCompatible(apiVersion)) throw refusal("incompatible-host-api");
      const hostContext = options.hostContext();
      sentContext = JSON.stringify(hostContext);
      initialized = true;
      respond(id, {
        apiVersion: `${PLUGIN_HOST_API.major}.${PLUGIN_HOST_API.minor}`,
        pluginId: manifest.id,
        panelId: options.panelId,
        pluginVersion: options.pluginVersion,
        hostContext,
      });
      return;
    }
    if (!initialized) {
      throw new BridgeFailure(NOT_INITIALIZED, "Call t3/initialize first.");
    }
    switch (method) {
      case "t3/state.get":
        answer(id, () => options.state.get());
        return;
      case "t3/state.set": {
        const { value } = params(StateSetParams, rawParams, method);
        if (value === undefined) {
          throw new BridgeFailure(INVALID_PARAMS, "t3/state.set needs a value.");
        }
        if (jsonBytes(value) > PLUGIN_LIMITS.maxPayloadBytes) throw refusal("too-large");
        answer(id, () => options.state.set(value).then(() => ({})));
        return;
      }
      case "t3/backend.call": {
        const { operation, input } = params(BackendCallParams, rawParams, method);
        const { declared, backend } = requireBackend();
        if (!declared.operations.some((decl) => decl.name === operation)) {
          throw refusal("unknown-operation");
        }
        answer(id, () => backend.call(operation, input ?? {}));
        return;
      }
      case "t3/backend.subscribe": {
        const { topic, params: subscriptionParams } = params(SubscribeParams, rawParams, method);
        const { declared } = requireBackend();
        if (!declared.topics.some((decl) => decl.name === topic)) {
          throw refusal("unknown-operation");
        }
        const subscriptionId = `sub-${nextSubscriptionId++}`;
        subscribe(subscriptionId, topic, subscriptionParams ?? {});
        respond(id, { subscriptionId });
        return;
      }
      case "t3/backend.unsubscribe": {
        const { subscriptionId } = params(UnsubscribeParams, rawParams, method);
        const entry = subscriptions.get(subscriptionId);
        subscriptions.delete(subscriptionId);
        entry?.dispose();
        respond(id, {});
        return;
      }
      case "t3/surface.open": {
        const { contributionId } = params(SurfaceOpenParams, rawParams, method);
        const known =
          manifest.ui?.panels.some((panel) => panel.id === contributionId) === true ||
          manifest.ui?.commands.some((command) => command.id === contributionId) === true;
        if (!known) {
          throw new BridgeFailure(INVALID_PARAMS, "This plugin declares no such panel or command.");
        }
        answer(id, () => options.openSurface(contributionId).then(() => ({})));
        return;
      }
      case "t3/chat.attach": {
        const request = params(AttachParams, rawParams, method);
        const capability = request.kind === "text" ? "chat.attach" : "chat.reference";
        if (!manifest.capabilities.includes(capability)) throw refusal("capability-denied");
        if (!activated) {
          throw new BridgeFailure(
            REQUEST_FAILED,
            "Attaching to chat must follow a click or key press in the panel.",
          );
        }
        answer(id, () => options.attach(request, activated).then((outcome) => ({ outcome })));
        return;
      }
      default:
        throw new BridgeFailure(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  return {
    receive: (data, activated) => {
      if (disposed || !Predicate.isObject(data) || data.jsonrpc !== "2.0") return;
      const id = isId(data.id) ? data.id : undefined;
      const method = data.method;
      if (typeof method !== "string" || id === undefined) return;
      const normalised = normaliseMessage(data);
      if (normalised === undefined) {
        fail(id, new BridgeFailure(INVALID_REQUEST, "Messages must be plain JSON."));
        return;
      }
      if (normalised.value === undefined) {
        fail(id, new BridgeFailure(INVALID_REQUEST, "Message too large.", "too-large"));
        return;
      }
      const message = normalised.value as { readonly params?: unknown };
      try {
        handleRequest(id, method, message.params ?? {}, activated);
      } catch (error) {
        fail(id, error);
      }
    },
    updateHostContext: () => {
      if (!initialized) return;
      const hostContext = options.hostContext();
      const serialized = JSON.stringify(hostContext);
      if (serialized === sentContext) return;
      sentContext = serialized;
      notify("t3/hostContext.changed", { hostContext });
    },
    hostReconnected: () => {
      for (const [subscriptionId, entry] of subscriptions) {
        notify("t3/backend.event", { subscriptionId, event: { type: "resync" } });
        entry.dispose();
        try {
          subscribe(subscriptionId, entry.topic, entry.params);
        } catch {
          notify("t3/backend.event", {
            subscriptionId,
            event: { type: "closed", reason: "worker-failed" },
          });
        }
      }
    },
    dispose: () => {
      disposed = true;
      const live = [...subscriptions.values()];
      subscriptions.clear();
      for (const entry of live) entry.dispose();
    },
  };
}
