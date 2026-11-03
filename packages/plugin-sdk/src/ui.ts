// @effect-diagnostics globalTimers:off - Runs inside a sandboxed plugin frame, outside any Effect runtime.
import type { PluginRequestErrorReason, PluginSubscriptionEvent } from "@t3tools/contracts";

const PLUGIN_BRIDGE_API_VERSION = "1.0";

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

/** `expectedChatTargetKey` defaults to the current context's chat target. */
export type PluginAttachRequest =
  | { readonly kind: "text"; readonly text: string; readonly expectedChatTargetKey?: string | null }
  | {
      readonly kind: "reference";
      readonly label: string;
      readonly locator: Readonly<Record<string, string>>;
      readonly snapshot: string;
      readonly expectedChatTargetKey?: string | null;
    };

export interface PluginStoredState {
  readonly value: unknown;
  /** The plugin version whose UI wrote this value. */
  readonly version: string;
}

export interface T3PluginClient {
  readonly context: PluginHostContext;
  readonly onContextChange: (listener: (context: PluginHostContext) => void) => () => void;
  readonly state: {
    readonly get: () => Promise<PluginStoredState | null>;
    readonly set: (value: unknown) => Promise<void>;
  };
  readonly call: (operation: string, input?: unknown) => Promise<unknown>;
  readonly subscribe: (
    topic: string,
    params: unknown,
    onEvent: (event: PluginSubscriptionEvent) => void,
  ) => () => void;
  readonly openSurface: (contributionId: string) => Promise<void>;
  readonly attach: (request: PluginAttachRequest) => Promise<"inserted" | "cancelled">;
}

export class T3PluginError extends Error {
  readonly code: number;
  /** Set when the host refused with a PluginRequestError. */
  readonly reason: PluginRequestErrorReason | undefined;
  constructor(code: number, message: string, reason?: PluginRequestErrorReason) {
    super(message);
    this.name = "T3PluginError";
    this.code = code;
    this.reason = reason;
  }
}

type JsonRpcId = string | number;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

let connection: Promise<T3PluginClient> | undefined;

/** Connects this panel to the T3 host bridge. Repeated calls share one connection. */
export function connectT3(): Promise<T3PluginClient> {
  connection ??= connect();
  return connection;
}

function connect(): Promise<T3PluginClient> {
  const host = window.parent;
  let nextId = 1;
  const pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  const subscriptions = new Map<string, (event: PluginSubscriptionEvent) => void>();
  // The host may forward a subscription's first events before the subscribe response.
  const unclaimed = new Map<string, Array<PluginSubscriptionEvent>>();
  // Events already in flight when the panel unsubscribes must not land in `unclaimed`.
  const closing = new Set<string>();
  const contextListeners = new Set<(context: PluginHostContext) => void>();
  let context: PluginHostContext | undefined;

  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      host.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    });
  };

  const handleNotification = (method: string, params: Record<string, unknown>) => {
    if (method === "t3/hostContext.changed" && isRecord(params.hostContext)) {
      context = params.hostContext as unknown as PluginHostContext;
      for (const listener of contextListeners) listener(context);
      return;
    }
    if (method === "t3/backend.event" && typeof params.subscriptionId === "string") {
      if (!isRecord(params.event)) return;
      const event = params.event as unknown as PluginSubscriptionEvent;
      const listener = subscriptions.get(params.subscriptionId);
      if (listener !== undefined) listener(event);
      else if (!closing.has(params.subscriptionId)) {
        const held = unclaimed.get(params.subscriptionId) ?? [];
        held.push(event);
        unclaimed.set(params.subscriptionId, held);
      }
    }
  };

  window.addEventListener("message", (message: MessageEvent) => {
    if (message.source !== host || !isRecord(message.data)) return;
    const data = message.data;
    if (data.jsonrpc !== "2.0") return;
    if (typeof data.method === "string") {
      handleNotification(data.method, isRecord(data.params) ? data.params : {});
      return;
    }
    if (typeof data.id !== "string" && typeof data.id !== "number") return;
    const waiter = pending.get(data.id);
    if (waiter === undefined) return;
    pending.delete(data.id);
    if (isRecord(data.error)) {
      const errorData = isRecord(data.error.data) ? data.error.data : {};
      waiter.reject(
        new T3PluginError(
          typeof data.error.code === "number" ? data.error.code : -32603,
          typeof data.error.message === "string" ? data.error.message : "Request failed.",
          typeof errorData.reason === "string"
            ? (errorData.reason as PluginRequestErrorReason)
            : undefined,
        ),
      );
    } else {
      waiter.resolve(data.result);
    }
  });

  const unsubscribe = (subscriptionId: string) => {
    subscriptions.delete(subscriptionId);
    closing.add(subscriptionId);
    void request("t3/backend.unsubscribe", { subscriptionId })
      .catch(() => {})
      .finally(() => closing.delete(subscriptionId));
  };

  const subscribe = (
    topic: string,
    params: unknown,
    onEvent: (event: PluginSubscriptionEvent) => void,
  ) => {
    let subscriptionId: string | undefined;
    let cancelled = false;
    void request("t3/backend.subscribe", { topic, params }).then(
      (result) => {
        if (!isRecord(result) || typeof result.subscriptionId !== "string") return;
        const id = result.subscriptionId;
        const held = unclaimed.get(id) ?? [];
        unclaimed.delete(id);
        if (cancelled) {
          unsubscribe(id);
          return;
        }
        subscriptionId = id;
        subscriptions.set(id, onEvent);
        for (const event of held) onEvent(event);
      },
      () => {
        if (!cancelled) onEvent({ type: "closed", reason: "protocol-error" });
      },
    );
    return () => {
      if (cancelled) return;
      cancelled = true;
      if (subscriptionId !== undefined) unsubscribe(subscriptionId);
    };
  };

  return request("t3/initialize", { apiVersion: PLUGIN_BRIDGE_API_VERSION }).then((result) => {
    if (!isRecord(result) || !isRecord(result.hostContext)) {
      throw new T3PluginError(-32603, "The host did not return a host context.");
    }
    context = result.hostContext as unknown as PluginHostContext;
    const client: T3PluginClient = {
      get context() {
        return context as PluginHostContext;
      },
      onContextChange: (listener) => {
        contextListeners.add(listener);
        return () => contextListeners.delete(listener);
      },
      state: {
        get: async () => {
          const stored = await request("t3/state.get", {});
          return isRecord(stored) && typeof stored.version === "string"
            ? { value: stored.value, version: stored.version }
            : null;
        },
        set: async (value) => {
          await request("t3/state.set", { value });
        },
      },
      call: (operation, input = {}) => request("t3/backend.call", { operation, input }),
      subscribe,
      openSurface: async (contributionId) => {
        await request("t3/surface.open", { contributionId });
      },
      attach: async (attachRequest) => {
        const result = await request("t3/chat.attach", {
          ...attachRequest,
          expectedChatTargetKey:
            attachRequest.expectedChatTargetKey ?? context?.chatTarget?.key ?? null,
        });
        return isRecord(result) && result.outcome === "inserted" ? "inserted" : "cancelled";
      },
    };
    return client;
  });
}
