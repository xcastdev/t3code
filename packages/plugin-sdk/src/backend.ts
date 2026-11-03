// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Plugin backends bundle to one builtin-only CommonJS file with no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import type { PluginRequestErrorReason, PluginSubscriptionEvent } from "@t3tools/contracts";

// Mirrors PLUGIN_LIMITS in @t3tools/contracts; the bundled backend cannot import it at runtime.
export const PLUGIN_WORKER_LIMITS = {
  maxPayloadBytes: 240 * 1024,
  maxMessageBytes: 256 * 1024,
  maxBatchBytes: 64 * 1024,
} as const;

export const PLUGIN_WORKER_PROTOCOL_VERSION = 1;

const PLUGIN_WORKER_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  notInitialized: -32002,
  plugin: -32000,
} as const;

const MAX_REVISION_LENGTH = 128;
const MAX_CURSOR_LENGTH = 1024;
const MAX_DETAIL_LENGTH = 1024;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type PluginCaller = "ui" | "agent";
export type PluginConfig = Readonly<Record<string, unknown>>;
export type PluginSecrets = Readonly<Record<string, string>>;

export interface StartContext {
  readonly pluginId: string;
  readonly version: string;
  readonly previousVersion: string | undefined;
  readonly dataDir: string;
  readonly config: PluginConfig;
  readonly secrets: PluginSecrets;
  readonly log: (message: string) => void;
}

export interface OperationContext {
  readonly caller: PluginCaller;
  readonly signal: AbortSignal;
  readonly dataDir: string;
  readonly config: PluginConfig;
  readonly secrets: PluginSecrets;
  readonly log: (message: string) => void;
}

export interface SnapshotPage {
  readonly items: ReadonlyArray<unknown>;
  readonly revision: string;
  readonly cursor: string | null;
}

export interface TopicEmitter {
  readonly snapshot: (page: SnapshotPage) => void;
  readonly batch: (items: ReadonlyArray<unknown>, revision: string) => void;
}

export type TopicHandler = (params: unknown, emit: TopicEmitter) => () => void;

export type OperationHandler = (input: unknown, ctx: OperationContext) => Promise<unknown>;

export interface PluginBackendDefinition {
  readonly operations: Readonly<Record<string, OperationHandler>>;
  readonly topics?: Readonly<Record<string, TopicHandler>>;
  readonly resolveReference?: (
    locator: Readonly<Record<string, string>>,
  ) => Promise<{ readonly title: string; readonly detail: string }>;
  readonly onStart?: (ctx: StartContext) => Promise<void> | void;
  readonly onStop?: () => Promise<void> | void;
}

export interface PluginBackendIo {
  readonly input: NodeStream.Readable;
  readonly output: NodeStream.Writable;
  readonly exit: (code: number) => void;
}

export type PluginWorkerStatus = "running" | "failed" | "missing-prerequisite";

type JsonRpcId = string | number;

type WorkerErrorReason = Extract<
  PluginRequestErrorReason,
  "unknown-operation" | "operation-failed" | "too-large"
>;

class WorkerError extends Error {
  readonly code: number;
  readonly reason: WorkerErrorReason | undefined;
  readonly detail: string | undefined;
  constructor(code: number, message: string, reason?: WorkerErrorReason, detail?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;

const jsonBytes = (value: unknown): number => {
  try {
    return utf8Bytes(JSON.stringify(value) ?? "null");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, entry]) => typeof entry === "string")
    ? Object.fromEntries(entries as Array<[string, string]>)
    : undefined;
};

const errorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
};

const invalidParams = (message: string) =>
  new WorkerError(PLUGIN_WORKER_ERROR_CODES.invalidParams, message);

let activeDataDir: string | undefined;
let activeWrite: ((message: unknown) => void) | undefined;

/**
 * Writes `contents` once to `<dataDir>/runtime/<sha256-16>-<name>` (mode 0600) and returns the
 * absolute path. Use it for text assets imported into the backend bundle.
 */
export async function materializeAsset(
  name: string,
  contents: string | Uint8Array,
): Promise<string> {
  if (activeDataDir === undefined) {
    throw new Error("materializeAsset needs an initialized plugin backend.");
  }
  if (!ASSET_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new Error(`Invalid asset name "${name}".`);
  }
  const hashOf = (bytes: string | Uint8Array) =>
    NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const hash = hashOf(contents);
  const runtimeDir = NodePath.join(activeDataDir, "runtime");
  const target = NodePath.join(runtimeDir, `${hash.slice(0, 16)}-${name}`);
  const existing = await NodeFSP.readFile(target).catch(() => undefined);
  if (existing !== undefined && hashOf(existing) === hash) return target;

  await NodeFSP.mkdir(runtimeDir, { recursive: true });
  const temporary = `${target}.${process.pid}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, contents, { mode: 0o600 });
    await NodeFSP.rename(temporary, target);
  } catch (error) {
    await NodeFSP.rm(temporary, { force: true });
    throw error;
  }
  return target;
}

/** Tells the host about a runtime state change, for example a lost prerequisite. */
export function reportStatus(state: PluginWorkerStatus, detail?: string): void {
  activeWrite?.({
    jsonrpc: "2.0",
    method: "status",
    params: detail === undefined ? { state } : { state, detail: errorText(detail) },
  });
}

const checkRevision = (revision: unknown) => {
  if (typeof revision !== "string" || revision.length > MAX_REVISION_LENGTH) {
    throw new Error(
      `A subscription revision must be a string of at most ${MAX_REVISION_LENGTH} chars.`,
    );
  }
};

const splitBatch = (
  items: ReadonlyArray<unknown>,
  revision: string,
): Array<PluginSubscriptionEvent> => {
  const whole: PluginSubscriptionEvent = { type: "batch", items: [...items], revision };
  if (jsonBytes(whole) <= PLUGIN_WORKER_LIMITS.maxBatchBytes) return [whole];

  const envelopeBytes = jsonBytes({ type: "batch", items: [], revision });
  const events: Array<PluginSubscriptionEvent> = [];
  let current: Array<unknown> = [];
  let currentBytes = envelopeBytes;
  for (const item of items) {
    const itemBytes = jsonBytes(item);
    if (envelopeBytes + itemBytes > PLUGIN_WORKER_LIMITS.maxBatchBytes) {
      throw new Error(
        `A subscription item of ${itemBytes} bytes exceeds the ${PLUGIN_WORKER_LIMITS.maxBatchBytes}-byte batch limit.`,
      );
    }
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (currentBytes + separatorBytes + itemBytes > PLUGIN_WORKER_LIMITS.maxBatchBytes) {
      events.push({ type: "batch", items: current, revision });
      current = [];
      currentBytes = envelopeBytes;
    }
    currentBytes += (current.length === 0 ? 0 : 1) + itemBytes;
    current.push(item);
  }
  if (current.length > 0) events.push({ type: "batch", items: current, revision });
  return events;
};

/**
 * Runs the plugin's backend: answers the host's NDJSON JSON-RPC requests on stdin/stdout,
 * and exits once stdin closes or the host asks it to shut down.
 */
export function definePluginBackend(
  definition: PluginBackendDefinition,
  io: PluginBackendIo = {
    input: process.stdin,
    output: process.stdout,
    exit: (code) => process.exit(code),
  },
): void {
  const log = (message: string) => {
    console.error(message);
  };
  const pendingCalls = new Map<JsonRpcId, AbortController>();
  const subscriptions = new Map<string, () => void>();
  let session:
    | { readonly dataDir: string; readonly config: PluginConfig; readonly secrets: PluginSecrets }
    | undefined;
  let stopping: Promise<void> | undefined;
  let hostGone = false;
  let exited = false;

  const writeLine = (message: unknown) => {
    if (hostGone) return;
    if (stopping !== undefined && isRecord(message) && message.method === "event") return;
    io.output.write(`${JSON.stringify(message)}\n`);
  };
  activeWrite = writeLine;

  const exitOnce = (code: number) => {
    if (exited) return;
    exited = true;
    io.exit(code);
  };

  const respond = (id: JsonRpcId, result: unknown) => {
    const message = { jsonrpc: "2.0", id, result: result === undefined ? null : result };
    if (jsonBytes(message) > PLUGIN_WORKER_LIMITS.maxMessageBytes) {
      respondError(
        id,
        new WorkerError(PLUGIN_WORKER_ERROR_CODES.plugin, "Result too large.", "too-large"),
      );
      return;
    }
    writeLine(message);
  };

  const respondError = (id: JsonRpcId | null, error: unknown) => {
    const workerError =
      error instanceof WorkerError
        ? error
        : new WorkerError(
            PLUGIN_WORKER_ERROR_CODES.plugin,
            "The plugin operation failed.",
            "operation-failed",
            errorText(error),
          );
    const data =
      workerError.reason === undefined
        ? undefined
        : workerError.detail === undefined
          ? { reason: workerError.reason }
          : { reason: workerError.reason, detail: workerError.detail };
    writeLine({
      jsonrpc: "2.0",
      id,
      error: {
        code: workerError.code,
        message: workerError.message,
        ...(data === undefined ? {} : { data }),
      },
    });
  };

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      for (const controller of pendingCalls.values()) controller.abort();
      for (const dispose of subscriptions.values()) {
        try {
          dispose();
        } catch (error) {
          log(`Subscription cleanup failed: ${errorText(error)}`);
        }
      }
      subscriptions.clear();
      try {
        await definition.onStop?.();
      } catch (error) {
        log(`onStop failed: ${errorText(error)}`);
      }
    })();
    return stopping;
  };

  const initialize = async (params: Record<string, unknown>) => {
    if (params.apiVersion !== PLUGIN_WORKER_PROTOCOL_VERSION) {
      throw invalidParams(`Unsupported worker protocol version ${String(params.apiVersion)}.`);
    }
    const secrets = stringRecord(params.secrets ?? {});
    if (
      typeof params.pluginId !== "string" ||
      typeof params.version !== "string" ||
      typeof params.dataDir !== "string" ||
      !NodePath.isAbsolute(params.dataDir) ||
      !isRecord(params.config ?? {}) ||
      secrets === undefined ||
      (params.previousVersion !== undefined && typeof params.previousVersion !== "string")
    ) {
      throw invalidParams("Invalid initialize params.");
    }
    const config = isRecord(params.config) ? params.config : {};
    activeDataDir = params.dataDir;
    await definition.onStart?.({
      pluginId: params.pluginId,
      version: params.version,
      previousVersion:
        typeof params.previousVersion === "string" ? params.previousVersion : undefined,
      dataDir: params.dataDir,
      config,
      secrets,
      log,
    });
    session = { dataDir: params.dataDir, config, secrets };
    return { apiVersion: PLUGIN_WORKER_PROTOCOL_VERSION };
  };

  const invoke = async (id: JsonRpcId, params: Record<string, unknown>) => {
    const { operation, input, caller } = params;
    if (typeof operation !== "string" || (caller !== "ui" && caller !== "agent")) {
      throw invalidParams("Invalid invoke params.");
    }
    const handler = Object.hasOwn(definition.operations, operation)
      ? definition.operations[operation]
      : undefined;
    if (handler === undefined || session === undefined) {
      throw new WorkerError(
        PLUGIN_WORKER_ERROR_CODES.plugin,
        `Unknown operation "${operation}".`,
        "unknown-operation",
      );
    }
    const controller = new AbortController();
    pendingCalls.set(id, controller);
    try {
      const result = await handler(input, {
        caller,
        signal: controller.signal,
        dataDir: session.dataDir,
        config: session.config,
        secrets: session.secrets,
        log,
      });
      if (jsonBytes(result ?? null) > PLUGIN_WORKER_LIMITS.maxPayloadBytes) {
        throw new WorkerError(
          PLUGIN_WORKER_ERROR_CODES.plugin,
          "Result too large.",
          "too-large",
          `The result exceeds ${PLUGIN_WORKER_LIMITS.maxPayloadBytes} bytes.`,
        );
      }
      return result;
    } finally {
      pendingCalls.delete(id);
    }
  };

  const subscribe = (
    params: Record<string, unknown>,
    onSubscribed: (flush: () => void) => void,
  ) => {
    const { subscriptionId, topic } = params;
    if (typeof subscriptionId !== "string" || typeof topic !== "string") {
      throw invalidParams("Invalid subscribe params.");
    }
    if (subscriptions.has(subscriptionId)) {
      throw invalidParams(`Subscription "${subscriptionId}" already exists.`);
    }
    const handler =
      definition.topics !== undefined && Object.hasOwn(definition.topics, topic)
        ? definition.topics[topic]
        : undefined;
    if (handler === undefined) {
      throw new WorkerError(
        PLUGIN_WORKER_ERROR_CODES.plugin,
        `Unknown topic "${topic}".`,
        "unknown-operation",
      );
    }

    let snapshotSent = false;
    let live = true;
    let held: Array<PluginSubscriptionEvent> | undefined = [];
    const send = (event: PluginSubscriptionEvent) => {
      if (!live) return;
      if (held !== undefined) held.push(event);
      else writeLine({ jsonrpc: "2.0", method: "event", params: { subscriptionId, event } });
    };
    const emit: TopicEmitter = {
      snapshot: (page) => {
        checkRevision(page.revision);
        if (
          page.cursor !== null &&
          (typeof page.cursor !== "string" || page.cursor.length > MAX_CURSOR_LENGTH)
        ) {
          throw new Error(`A snapshot cursor must be null or at most ${MAX_CURSOR_LENGTH} chars.`);
        }
        const event: PluginSubscriptionEvent = {
          type: "snapshot",
          items: [...page.items],
          revision: page.revision,
          cursor: page.cursor,
        };
        if (jsonBytes(event) > PLUGIN_WORKER_LIMITS.maxPayloadBytes) {
          throw new Error(
            `A snapshot exceeds ${PLUGIN_WORKER_LIMITS.maxPayloadBytes} bytes; return a window and a cursor.`,
          );
        }
        snapshotSent = true;
        send(event);
      },
      batch: (items, revision) => {
        if (!snapshotSent) throw new Error("A topic must emit a snapshot before any batch.");
        checkRevision(revision);
        for (const event of splitBatch(items, revision)) send(event);
      },
    };
    const dispose = handler(params.params, emit);
    subscriptions.set(subscriptionId, () => {
      live = false;
      dispose();
    });
    onSubscribed(() => {
      const events = held ?? [];
      held = undefined;
      for (const event of events) send(event);
    });
  };

  const unsubscribe = (params: Record<string, unknown>) => {
    if (typeof params.subscriptionId !== "string")
      throw invalidParams("Invalid unsubscribe params.");
    const dispose = subscriptions.get(params.subscriptionId);
    subscriptions.delete(params.subscriptionId);
    dispose?.();
    return null;
  };

  const resolveReference = async (params: Record<string, unknown>) => {
    const locator = stringRecord(params.locator);
    if (locator === undefined) throw invalidParams("Invalid resolveReference params.");
    if (definition.resolveReference === undefined) {
      throw new WorkerError(
        PLUGIN_WORKER_ERROR_CODES.plugin,
        "This plugin does not resolve references.",
        "unknown-operation",
      );
    }
    const resolved = await definition.resolveReference(locator);
    return { title: String(resolved.title), detail: String(resolved.detail) };
  };

  const handleRequest = async (id: JsonRpcId, method: string, params: Record<string, unknown>) => {
    if (method === "initialize") return initialize(params);
    if (method === "shutdown") {
      await stop();
      return null;
    }
    if (session === undefined) {
      throw new WorkerError(PLUGIN_WORKER_ERROR_CODES.notInitialized, "Not initialized.");
    }
    switch (method) {
      case "invoke":
        return invoke(id, params);
      case "unsubscribe":
        return unsubscribe(params);
      case "resolveReference":
        return resolveReference(params);
      default:
        throw new WorkerError(
          PLUGIN_WORKER_ERROR_CODES.methodNotFound,
          `Unknown method "${method}".`,
        );
    }
  };

  const handleMessage = (message: unknown) => {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      respondError(
        null,
        new WorkerError(PLUGIN_WORKER_ERROR_CODES.invalidRequest, "Invalid JSON-RPC message."),
      );
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (message.id === undefined) {
      if (message.method === "cancel" && isId(params.id)) pendingCalls.get(params.id)?.abort();
      return;
    }
    const id = message.id;
    if (!isId(id)) {
      respondError(null, new WorkerError(PLUGIN_WORKER_ERROR_CODES.invalidRequest, "Invalid id."));
      return;
    }
    if (stopping !== undefined && message.method !== "shutdown") {
      respondError(id, new WorkerError(PLUGIN_WORKER_ERROR_CODES.invalidRequest, "Shutting down."));
      return;
    }
    if (message.method === "subscribe") {
      try {
        if (session === undefined) {
          throw new WorkerError(PLUGIN_WORKER_ERROR_CODES.notInitialized, "Not initialized.");
        }
        subscribe(params, (flush) => {
          respond(id, null);
          flush();
        });
      } catch (error) {
        respondError(id, error);
      }
      return;
    }
    void handleRequest(id, message.method, params).then(
      (result) => {
        respond(id, result);
        if (message.method === "shutdown") exitOnce(0);
      },
      (error: unknown) => respondError(id, error),
    );
  };

  const handleLine = (line: string) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      respondError(null, new WorkerError(PLUGIN_WORKER_ERROR_CODES.parseError, "Parse error."));
      return;
    }
    handleMessage(message);
  };

  let buffered: Array<Buffer> = [];
  let bufferedBytes = 0;
  let discarding = false;
  io.input.on("data", (chunk: Buffer | string) => {
    let data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10)) {
      const head = data.subarray(0, newline);
      data = data.subarray(newline + 1);
      if (discarding || bufferedBytes + head.byteLength > PLUGIN_WORKER_LIMITS.maxMessageBytes) {
        log("Dropped a host message over maxMessageBytes.");
      } else {
        handleLine(Buffer.concat([...buffered, head]).toString("utf8"));
      }
      buffered = [];
      bufferedBytes = 0;
      discarding = false;
    }
    if (discarding) return;
    bufferedBytes += data.byteLength;
    if (bufferedBytes > PLUGIN_WORKER_LIMITS.maxMessageBytes) {
      discarding = true;
      buffered = [];
      bufferedBytes = 0;
    } else if (data.byteLength > 0) {
      buffered.push(data);
    }
  });
  const hostDisconnected = () => {
    hostGone = true;
    void stop().then(() => exitOnce(0));
  };
  io.input.on("end", hostDisconnected);
  // A dead stdout pipe (EPIPE) must not crash the worker before onStop stops its children.
  io.output.on("error", hostDisconnected);
}
