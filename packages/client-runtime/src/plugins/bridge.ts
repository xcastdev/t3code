import {
  COMPOSER_CONTEXT_LABEL_MAX_CHARS,
  PLUGIN_HOST_API,
  PLUGIN_LIMITS,
  PluginChatTargetsListParams,
  PluginContributionId,
  PluginReferenceLocator,
  PluginRequestError,
  type PluginChatTargets,
  type PluginManifest,
  PluginRequestErrorReason,
  type PluginSubscriptionEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { isHostApiCompatible } from "@t3tools/shared/pluginManifest";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { jsonBytes } from "../mcpApps/host.ts";

/** The bridge version this client speaks, as `t3/initialize` and the host context report it. */
const PLUGIN_HOST_API_VERSION = `${PLUGIN_HOST_API.major}.${PLUGIN_HOST_API.minor}`;

export interface PluginHostContext {
  readonly apiVersion: string;
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
  readonly hostContext: () => Omit<PluginHostContext, "apiVersion">;
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
  readonly saveFile: (file: PluginSaveFile) => Promise<"saved" | "cancelled">;
  readonly writeClipboard: (text: string) => Promise<void>;
  /** Threads and projects in the install's environment; the bridge caps each list. */
  readonly chatTargets: (query: string) => PluginChatTargets | Promise<PluginChatTargets>;
}

export interface PluginSaveFile {
  /** Already reduced to a basename. */
  readonly name: string;
  readonly mimeType: string;
  readonly parts: ReadonlyArray<Uint8Array<ArrayBuffer>>;
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

const FileSaveBeginParams = Schema.Struct({
  name: NonEmptyText.check(Schema.isMaxLength(255)),
  mimeType: Schema.String.check(Schema.isMaxLength(128)),
  /** Omit it when the panel cannot know it yet; the running total is still capped. */
  size: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const FileSaveAppendParams = Schema.Struct({ saveId: Schema.String, base64: Schema.String });
const FileSaveIdParams = Schema.Struct({ saveId: Schema.String });
const ClipboardWriteParams = Schema.Struct({ text: Schema.String });

const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  params: unknown,
) => Schema.decodeUnknownOption(schema)(params);

class BridgeFailure extends Schema.TaggedError<BridgeFailure>()("BridgeFailure", {
  code: Schema.Number,
  detail: Schema.String,
  reason: Schema.optional(PluginRequestErrorReason),
}) {
  override get message() {
    return this.detail;
  }
}

const bridgeFailure = (code: number, detail: string, reason?: PluginRequestErrorReason) =>
  new BridgeFailure({ code, detail, ...(reason === undefined ? {} : { reason }) });

const isPluginRequestError = Schema.is(PluginRequestError);
const isBridgeFailure = Schema.is(BridgeFailure);

const refusal = (reason: PluginRequestErrorReason) =>
  bridgeFailure(REQUEST_FAILED, new PluginRequestError({ reason }).message, reason);

const errorPayload = (error: unknown) => {
  if (isBridgeFailure(error)) {
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

const SAVE_NAME_MAX_BYTES = 200;

const truncateUtf8 = (text: string, maxBytes: number) => {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += encoder.encode(char).byteLength;
    if (bytes > maxBytes) break;
    end += char.length;
  }
  return text.slice(0, end);
};

/**
 * Keeps the last path segment, replaces control and bidi characters (which can disguise an
 * extension), and caps the length while keeping a short extension.
 */
const saveFileName = (name: string) => {
  const basename = (name.split(/[\\/]/).at(-1) ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "_")
    .trim();
  if (basename === "" || /^\.+$/.test(basename)) return "download";
  if (encoder.encode(basename).byteLength <= SAVE_NAME_MAX_BYTES) return basename;
  const dot = basename.lastIndexOf(".");
  const extension = dot > 0 && basename.length - dot <= 16 ? basename.slice(dot) : "";
  const stem = extension === "" ? basename : basename.slice(0, dot);
  return truncateUtf8(stem, SAVE_NAME_MAX_BYTES - encoder.encode(extension).byteLength) + extension;
};

interface OpenSave {
  readonly saveId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number | undefined;
  readonly parts: Array<Uint8Array<ArrayBuffer>>;
  received: number;
}

type ChatTargetSource = {
  readonly threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly updatedAt: string;
    readonly deletedAt: string | null;
    readonly archivedAt: string | null;
  }>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: ProjectId;
    readonly title: string;
    readonly updatedAt: string;
    readonly archivedAt?: string | null | undefined;
  }>;
};

/** Recent threads and projects of one environment matching `query`, as `t3/chat.targets.list` answers. */
export function selectPluginChatTargets(
  source: ChatTargetSource,
  environmentId: string,
  query: string,
): PluginChatTargets {
  const needle = query.trim().toLowerCase();
  const matches = (...texts: ReadonlyArray<string>) =>
    needle === "" || texts.some((text) => text.toLowerCase().includes(needle));
  // ISO timestamps order as plain strings; localeCompare is far slower over every thread.
  const newestFirst = (a: { readonly updatedAt: string }, b: { readonly updatedAt: string }) =>
    a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  const projectNames = new Map<string, string>();
  const archivedProjects = new Set<string>();
  for (const project of source.projects) {
    if (project.environmentId !== environmentId) continue;
    projectNames.set(project.id, project.title);
    if ((project.archivedAt ?? null) !== null) archivedProjects.add(project.id);
  }
  const threads = source.threads
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        !archivedProjects.has(thread.projectId),
    )
    .map((thread) => ({ thread, projectName: projectNames.get(thread.projectId) ?? "" }))
    .filter(({ thread, projectName }) => matches(thread.title, projectName))
    .sort((a, b) => newestFirst(a.thread, b.thread))
    .slice(0, PLUGIN_LIMITS.maxChatTargets)
    .map(({ thread, projectName }) => ({
      threadId: thread.id,
      title: thread.title,
      projectId: thread.projectId,
      projectName,
    }));
  const projects = source.projects
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        (project.archivedAt ?? null) === null &&
        matches(project.title),
    )
    .sort(newestFirst)
    .slice(0, PLUGIN_LIMITS.maxChatTargets)
    .map((project) => ({ projectId: project.id, name: project.title }));
  return { threads, projects };
}

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
  let nextSaveId = 0;
  let save: OpenSave | null = null;
  const subscriptions = new Map<string, LiveSubscription>();

  const currentHostContext = (): PluginHostContext => ({
    ...options.hostContext(),
    apiVersion: PLUGIN_HOST_API_VERSION,
  });
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
      fail(id, bridgeFailure(REQUEST_FAILED, "Too many requests in flight."));
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
      throw bridgeFailure(INVALID_PARAMS, `Invalid params for ${method}.`);
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

  // Web also refuses panel clicks within seconds of input elsewhere in T3, so a retry must wait.
  const requireActivation = (activated: boolean, action: "Attaching" | "Copying" | "Saving") => {
    if (!activated) {
      throw bridgeFailure(
        REQUEST_FAILED,
        `${action} was blocked. Wait a few seconds, then click or tap in the panel again.`,
      );
    }
  };

  const openSave = (saveId: string) => {
    if (save === null || save.saveId !== saveId) {
      throw bridgeFailure(INVALID_PARAMS, "No such save is open.");
    }
    return save;
  };

  const handleRequest = (id: JsonRpcId, method: string, rawParams: unknown, activated: boolean) => {
    if (method === "t3/initialize") {
      const { apiVersion } = params(InitializeParams, rawParams, method);
      if (!isHostApiCompatible(apiVersion)) throw refusal("incompatible-host-api");
      const hostContext = currentHostContext();
      sentContext = JSON.stringify(hostContext);
      initialized = true;
      respond(id, {
        apiVersion: PLUGIN_HOST_API_VERSION,
        pluginId: manifest.id,
        panelId: options.panelId,
        pluginVersion: options.pluginVersion,
        hostContext,
      });
      return;
    }
    if (!initialized) {
      throw bridgeFailure(NOT_INITIALIZED, "Call t3/initialize first.");
    }
    switch (method) {
      case "t3/state.get":
        answer(id, () => options.state.get());
        return;
      case "t3/state.set": {
        const { value } = params(StateSetParams, rawParams, method);
        if (value === undefined) {
          throw bridgeFailure(INVALID_PARAMS, "t3/state.set needs a value.");
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
          throw bridgeFailure(INVALID_PARAMS, "This plugin declares no such panel or command.");
        }
        answer(id, () => options.openSurface(contributionId).then(() => ({})));
        return;
      }
      case "t3/chat.attach": {
        const request = params(AttachParams, rawParams, method);
        const capability = request.kind === "text" ? "chat.attach" : "chat.reference";
        if (!manifest.capabilities.includes(capability)) throw refusal("capability-denied");
        requireActivation(activated, "Attaching");
        answer(id, () => options.attach(request, activated).then((outcome) => ({ outcome })));
        return;
      }
      case "t3/file.save.begin": {
        const { name, mimeType, size } = params(FileSaveBeginParams, rawParams, method);
        if (!manifest.capabilities.includes("file.save")) throw refusal("capability-denied");
        requireActivation(activated, "Saving");
        if (size !== undefined && size > PLUGIN_LIMITS.maxSaveBytes) throw refusal("too-large");
        // A begin follows fresh activation, so it supersedes a save the panel abandoned.
        const saveId = `save-${nextSaveId++}`;
        save = { saveId, name: saveFileName(name), mimeType, size, parts: [], received: 0 };
        respond(id, { saveId });
        return;
      }
      case "t3/file.save.append": {
        const { saveId, base64 } = params(FileSaveAppendParams, rawParams, method);
        const current = openSave(saveId);
        const decoded = Base64.decode(base64);
        if (Result.isFailure(decoded)) {
          throw bridgeFailure(INVALID_PARAMS, "The chunk is not valid base64.");
        }
        // A copy owns its ArrayBuffer, which Blob parts require.
        const chunk = new Uint8Array(decoded.success);
        if (chunk.byteLength > PLUGIN_LIMITS.maxBodyChunkBytes) throw refusal("too-large");
        const received = current.received + chunk.byteLength;
        if (current.size !== undefined && received > current.size) {
          save = null;
          throw bridgeFailure(INVALID_PARAMS, `The file is larger than ${current.size} bytes.`);
        }
        if (received > PLUGIN_LIMITS.maxSaveBytes) {
          save = null;
          throw refusal("too-large");
        }
        current.parts.push(chunk);
        current.received += chunk.byteLength;
        respond(id, {});
        return;
      }
      case "t3/file.save.commit": {
        const { saveId } = params(FileSaveIdParams, rawParams, method);
        const current = openSave(saveId);
        save = null;
        if (current.size !== undefined && current.received !== current.size) {
          throw bridgeFailure(
            INVALID_PARAMS,
            `The file is ${current.received} bytes, not ${current.size}.`,
          );
        }
        const file = { name: current.name, mimeType: current.mimeType, parts: current.parts };
        answer(id, () => options.saveFile(file).then((outcome) => ({ outcome })));
        return;
      }
      case "t3/file.save.abort": {
        const { saveId } = params(FileSaveIdParams, rawParams, method);
        if (save?.saveId === saveId) save = null;
        respond(id, {});
        return;
      }
      case "t3/clipboard.write": {
        const { text } = params(ClipboardWriteParams, rawParams, method);
        if (!manifest.capabilities.includes("clipboard.write")) throw refusal("capability-denied");
        requireActivation(activated, "Copying");
        if (encoder.encode(text).byteLength > PLUGIN_LIMITS.maxPayloadBytes) {
          throw refusal("too-large");
        }
        answer(id, () => options.writeClipboard(text).then(() => ({})));
        return;
      }
      case "t3/chat.targets.list": {
        const { query } = params(PluginChatTargetsListParams, rawParams, method);
        if (
          !manifest.capabilities.includes("chat.attach") &&
          !manifest.capabilities.includes("chat.reference")
        ) {
          throw refusal("capability-denied");
        }
        answer(id, async () => {
          const targets = await options.chatTargets(query ?? "");
          return {
            threads: targets.threads.slice(0, PLUGIN_LIMITS.maxChatTargets),
            projects: targets.projects.slice(0, PLUGIN_LIMITS.maxChatTargets),
          };
        });
        return;
      }
      default:
        throw bridgeFailure(METHOD_NOT_FOUND, `Method not found: ${method}`);
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
        fail(id, bridgeFailure(INVALID_REQUEST, "Messages must be plain JSON."));
        return;
      }
      if (normalised.value === undefined) {
        fail(id, bridgeFailure(INVALID_REQUEST, "Message too large.", "too-large"));
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
      const hostContext = currentHostContext();
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
      save = null;
      const live = [...subscriptions.values()];
      subscriptions.clear();
      for (const entry of live) entry.dispose();
    },
  };
}
