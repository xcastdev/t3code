import {
  PLUGIN_LIMITS,
  PLUGIN_WORKER_CONTEXT_RESOLVE_METHOD,
  type PluginCallContext,
  PluginContextResolveParams,
  type PluginContextResolveResult,
  type PluginId,
  type PluginPrerequisiteDecl,
  PluginRequestError,
  type PluginRuntimeStatus,
  PluginSubscriptionEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import { resolveCommandPath } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

const WORKER_PROTOCOL_VERSION = 1;
const REQUEST_TIMEOUT = Duration.seconds(30);
// onStart runs the plugin's data migrations, which may outlast an ordinary call.
const INITIALIZE_TIMEOUT = Duration.seconds(120);
const STOP_GRACE = Duration.seconds(5);
// A grandchild that left the process group can hold stderr open after the worker exits. The
// wait still has to cover draining a busy worker's last output on a loaded machine.
const STDERR_DRAIN = Duration.seconds(5);
const DETAIL_MAX_CHARS = 1024;
const LOG_MAX_LINES = 1000;
const LOG_MAX_BYTES = 256 * 1024;
const LOG_LINE_MAX_BYTES = 2048;
const LOGS_MAX_LIMIT = 500;
// Raw event lines queued per worker subscription before it resyncs: 16 full batches.
const SUBSCRIPTION_INBOX_BYTES = 16 * PLUGIN_LIMITS.maxBatchBytes;
const SUBSCRIPTION_OUTPUT_BUFFER = 16;
const OVERSIZED_LINE_HEAD_BYTES = 512;
// Oversized lines are matched only by their top-level envelope, never by a nested field.
const OVERSIZED_RESPONSE_ID =
  /^\s*\{\s*(?:"jsonrpc"\s*:\s*"2\.0"\s*,\s*)?"id"\s*:\s*(\d+)\s*,\s*"(?:result|error)"/;
const OVERSIZED_EVENT_SUBSCRIPTION =
  /^\s*\{\s*"jsonrpc"\s*:\s*"2\.0"\s*,\s*"method"\s*:\s*"event"\s*,\s*"params"\s*:\s*\{\s*"subscriptionId"\s*:\s*"([^"\\]{1,128})"/;
const WORKER_ERROR_REASONS: ReadonlySet<PluginRequestError["reason"]> = new Set([
  "unknown-operation",
  "operation-failed",
  "too-large",
]);
const WORKER_REPORTED_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "failed",
  "missing-prerequisite",
]);

export type PluginSubscriptionCloseReason = Extract<
  PluginSubscriptionEvent,
  { readonly type: "closed" }
>["reason"];

export type PluginWorkerStopReason = Extract<
  PluginSubscriptionCloseReason,
  "plugin-disabled" | "plugin-updated" | "plugin-uninstalled" | "worker-failed"
>;

export interface PluginWorkerStatus {
  readonly status: PluginRuntimeStatus;
  readonly detail?: string;
}

export interface PluginWorkerStatusChange extends PluginWorkerStatus {
  readonly pluginId: PluginId;
}

export interface PluginWorkerLogLine {
  readonly at: number;
  readonly line: string;
}

const isSubscriptionEvent = Schema.is(PluginSubscriptionEvent);
const decodeContextResolveParams = Schema.decodeUnknownOption(PluginContextResolveParams);
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const HOST_FAILED = -32000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const utf8Bytes = (text: string) => encoder.encode(text).byteLength;
const jsonBytes = (value: unknown) => {
  try {
    return utf8Bytes(JSON.stringify(value) ?? "null");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
const encodeMessage = (message: unknown) => JSON.stringify(message);
const NOT_JSON = Symbol("not-json");
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
};
const bounded = (text: string) =>
  text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS - 1)}…` : text;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestError = (reason: PluginRequestError["reason"], detail?: string) =>
  new PluginRequestError({
    reason,
    ...(detail === undefined ? {} : { detail: bounded(detail) }),
  });

const fromWorkerError = (error: Record<string, unknown>) => {
  const data = isRecord(error.data) ? error.data : {};
  const reason = WORKER_ERROR_REASONS.has(data.reason as PluginRequestError["reason"])
    ? (data.reason as PluginRequestError["reason"])
    : "operation-failed";
  const detail =
    typeof data.detail === "string"
      ? data.detail
      : reason === "operation-failed" && typeof error.message === "string"
        ? error.message
        : undefined;
  return requestError(reason, detail);
};

interface SplitLine {
  readonly bytes: Uint8Array;
  /** The line was longer than the limit; `bytes` holds only its head. */
  readonly cut: boolean;
}

/** Splits a byte stream into newline-terminated lines, holding at most `maxBytes` of each. */
const makeLineSplitter = (maxBytes: number) => {
  let parts: Array<Uint8Array> = [];
  let size = 0;
  let cut = false;
  const keep = (bytes: Uint8Array) => {
    const room = maxBytes - size;
    if (bytes.byteLength > room) cut = true;
    const kept = bytes.byteLength > room ? bytes.subarray(0, Math.max(room, 0)) : bytes;
    if (kept.byteLength > 0) {
      parts.push(kept);
      size += kept.byteLength;
    }
  };
  const take = (): SplitLine => {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const line = { bytes, cut };
    parts = [];
    size = 0;
    cut = false;
    return line;
  };
  return {
    push: (chunk: Uint8Array): Array<SplitLine> => {
      const lines: Array<SplitLine> = [];
      let start = 0;
      let newline = chunk.indexOf(10);
      while (newline !== -1) {
        keep(chunk.subarray(start, newline));
        lines.push(take());
        start = newline + 1;
        newline = chunk.indexOf(10, start);
      }
      keep(chunk.subarray(start));
      return lines;
    },
    flush: (): SplitLine | undefined => (size > 0 || cut ? take() : undefined),
  };
};

type InboxItem =
  | { readonly kind: "event"; readonly event: unknown; readonly lineBytes: number }
  | { readonly kind: "oversized" }
  | { readonly kind: "overflow" }
  | { readonly kind: "closed"; readonly reason: PluginSubscriptionCloseReason };

interface Inbox {
  readonly queue: Queue.Queue<InboxItem>;
  bytes: number;
}

export interface WorkerConnection {
  /** Times out (30 s by default) with `timed-out`; on timeout or interruption it sends `cancel { id }`. */
  readonly request: (
    method: string,
    params: unknown,
    timeout?: Duration.Duration,
  ) => Effect.Effect<unknown, PluginRequestError>;
  readonly subscribe: (
    topic: string,
    params: unknown,
  ) => Stream.Stream<PluginSubscriptionEvent, PluginRequestError>;
  /** Ends every subscription with `closed { reason }`; requests keep working. */
  readonly close: (reason: PluginSubscriptionCloseReason) => Effect.Effect<void>;
}

export interface WorkerConnectionHandlers {
  readonly onStatus?: (status: PluginWorkerStatus) => Effect.Effect<void>;
  /** Worker stdout that is not protocol, and notes about dropped messages. */
  readonly onOutput?: (line: string) => Effect.Effect<void>;
  /** Answers the worker's `t3/context.resolve`; without it the method is not found. */
  readonly resolveContext?: PluginContextResolver;
}

export type PluginContextResolver = (
  params: PluginContextResolveParams,
) => Effect.Effect<PluginContextResolveResult, PluginRequestError>;

/**
 * The host side of the NDJSON JSON-RPC worker protocol. `input` is the worker's stdout and
 * `output` receives lines for its stdin. Late responses to timed-out or cancelled requests
 * are dropped.
 */
export const makeWorkerConnection = Effect.fn("PluginWorkerSupervisor.makeWorkerConnection")(
  function* (
    input: Stream.Stream<Uint8Array, unknown>,
    output: Queue.Enqueue<string>,
    handlers: WorkerConnectionHandlers = {},
  ) {
    let nextId = 1;
    let nextSubscription = 1;
    let ended = false;
    let closedReason: PluginSubscriptionCloseReason | undefined;
    const pending = new Map<number, Deferred.Deferred<unknown, PluginRequestError>>();
    const inboxes = new Map<string, Inbox>();
    const overflowed = new Set<string>();
    const onOutput = handlers.onOutput ?? (() => Effect.void);
    const onStatus = handlers.onStatus ?? (() => Effect.void);
    const connectionScope = yield* Effect.scope;
    let workerRequests = 0;

    const send = (method: string, params: unknown, id?: number) =>
      ended
        ? Effect.void
        : Queue.offer(
            output,
            `${encodeMessage(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params })}\n`,
          ).pipe(Effect.asVoid);

    const reply = (id: string, outcome: { result: unknown } | { error: Record<string, unknown> }) =>
      ended
        ? Effect.void
        : Queue.offer(output, `${encodeMessage({ jsonrpc: "2.0", id, ...outcome })}\n`).pipe(
            Effect.asVoid,
          );

    // Forked so a slow lookup never stalls the worker's other messages.
    const answerWorkerRequest = (id: string, method: string, params: unknown) => {
      const resolveContext = handlers.resolveContext;
      if (method !== PLUGIN_WORKER_CONTEXT_RESOLVE_METHOD || resolveContext === undefined) {
        return reply(id, { error: { code: METHOD_NOT_FOUND, message: "Method not found." } });
      }
      const decoded = decodeContextResolveParams(params);
      if (decoded._tag === "None") {
        return reply(id, {
          error: {
            code: INVALID_PARAMS,
            message: "Expected exactly one of threadId or projectId.",
          },
        });
      }
      return Effect.suspend(() => {
        if (workerRequests >= PLUGIN_LIMITS.maxPendingRequests) {
          return reply(id, {
            error: { code: HOST_FAILED, message: "Too many requests in flight." },
          });
        }
        workerRequests += 1;
        return resolveContext(decoded.value).pipe(
          Effect.matchEffect({
            onFailure: () =>
              reply(id, {
                error: { code: HOST_FAILED, message: "The host could not resolve the context." },
              }),
            onSuccess: (result) => reply(id, { result }),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              workerRequests -= 1;
            }),
          ),
          Effect.forkIn(connectionScope),
          Effect.asVoid,
        );
      });
    };

    // Untraced: a request runs inside the calling service operation's span.
    const request = Effect.fnUntraced(function* (
      method: string,
      params: unknown,
      timeout: Duration.Duration = REQUEST_TIMEOUT,
    ) {
      if (ended) return yield* requestError("worker-failed");
      const id = nextId++;
      const line = encodeMessage({ jsonrpc: "2.0", id, method, params });
      if (utf8Bytes(line) + 1 > PLUGIN_LIMITS.maxMessageBytes) {
        return yield* requestError(
          "too-large",
          `The request exceeds ${PLUGIN_LIMITS.maxMessageBytes} bytes.`,
        );
      }
      const response = Deferred.makeUnsafe<unknown, PluginRequestError>();
      pending.set(id, response);
      yield* Queue.offer(output, `${line}\n`);
      return yield* Deferred.await(response).pipe(
        Effect.onInterrupt(() => send("cancel", { id })),
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(requestError("timed-out")),
        }),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
    });

    const deliver = (subscriptionId: string, item: InboxItem) => {
      const inbox = inboxes.get(subscriptionId);
      if (inbox === undefined) return;
      const bytes = item.kind === "event" ? item.lineBytes : 0;
      if (inbox.bytes + bytes > SUBSCRIPTION_INBOX_BYTES) {
        inboxes.delete(subscriptionId);
        Queue.offerUnsafe(inbox.queue, { kind: "overflow" });
        // Unsubscribe now, not when the slow consumer reaches the overflow marker.
        if (!ended) {
          overflowed.add(subscriptionId);
          Queue.offerUnsafe(
            output,
            `${encodeMessage({ jsonrpc: "2.0", id: nextId++, method: "unsubscribe", params: { subscriptionId } })}\n`,
          );
        }
        return;
      }
      inbox.bytes += bytes;
      Queue.offerUnsafe(inbox.queue, item);
    };

    const close = (reason: PluginSubscriptionCloseReason) =>
      Effect.sync(() => {
        if (closedReason !== undefined) return;
        closedReason = reason;
        for (const inbox of inboxes.values()) {
          Queue.offerUnsafe(inbox.queue, { kind: "closed", reason });
        }
        inboxes.clear();
      });

    const endInput = Effect.suspend(() => {
      if (ended) return Effect.void;
      ended = true;
      for (const response of pending.values()) {
        Deferred.doneUnsafe(response, Effect.fail(requestError("worker-failed")));
      }
      pending.clear();
      return close("worker-failed");
    });

    // Untraced: runs once per worker message.
    const handleLine = Effect.fnUntraced(function* (line: SplitLine) {
      if (line.cut) {
        const head = decoder.decode(line.bytes.subarray(0, OVERSIZED_LINE_HEAD_BYTES));
        const id = OVERSIZED_RESPONSE_ID.exec(head)?.[1];
        const response = id === undefined ? undefined : pending.get(Number(id));
        if (response !== undefined) {
          pending.delete(Number(id));
          Deferred.doneUnsafe(
            response,
            Effect.fail(
              requestError(
                "too-large",
                `The worker's response exceeds ${PLUGIN_LIMITS.maxMessageBytes} bytes.`,
              ),
            ),
          );
        }
        const subscriptionId = OVERSIZED_EVENT_SUBSCRIPTION.exec(head)?.[1];
        if (subscriptionId !== undefined) deliver(subscriptionId, { kind: "oversized" });
        return yield* onOutput(
          `Dropped a worker message over ${PLUGIN_LIMITS.maxMessageBytes} bytes.`,
        );
      }
      const text = decoder.decode(line.bytes);
      if (text.trim() === "") return;
      const message = parseJson(text);
      if (!isRecord(message) || message.jsonrpc !== "2.0") return yield* onOutput(text);
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const response = pending.get(message.id);
        if (response === undefined) return;
        pending.delete(message.id);
        Deferred.doneUnsafe(
          response,
          isRecord(message.error)
            ? Effect.fail(fromWorkerError(message.error))
            : Effect.succeed(message.result ?? null),
        );
        return;
      }
      // Worker → host requests carry string ids, so they never collide with the host's own.
      if (typeof message.id === "string" && typeof message.method === "string") {
        return yield* answerWorkerRequest(message.id, message.method, message.params);
      }
      const params = isRecord(message.params) ? message.params : {};
      if (message.method === "event" && typeof params.subscriptionId === "string") {
        deliver(params.subscriptionId, {
          kind: "event",
          event: params.event,
          lineBytes: line.bytes.byteLength,
        });
      } else if (
        message.method === "status" &&
        typeof params.state === "string" &&
        WORKER_REPORTED_STATUSES.has(params.state)
      ) {
        yield* onStatus({
          status: params.state as PluginRuntimeStatus,
          ...(typeof params.detail === "string" ? { detail: bounded(params.detail) } : {}),
        });
      }
    });

    const splitter = makeLineSplitter(PLUGIN_LIMITS.maxMessageBytes);
    yield* Effect.addFinalizer(() => endInput);
    yield* input.pipe(
      Stream.runForEach((chunk) => Effect.forEach(splitter.push(chunk), handleLine)),
      Effect.ignore,
      Effect.andThen(endInput),
      Effect.forkScoped,
    );

    // Untraced: one worker subscription's event loop, inside the subscribe stream.
    const runSubscription = Effect.fnUntraced(function* (
      topic: string,
      params: unknown,
      out: Queue.Queue<PluginSubscriptionEvent, PluginRequestError | Cause.Done>,
    ) {
      const finish = (event: PluginSubscriptionEvent) =>
        Queue.offer(out, event).pipe(Effect.andThen(Queue.end(out)));
      let first = true;
      while (true) {
        if (closedReason !== undefined)
          return yield* finish({ type: "closed", reason: closedReason });
        const subscriptionId = `s${nextSubscription++}`;
        const inbox: Inbox = { queue: yield* Queue.unbounded<InboxItem>(), bytes: 0 };
        inboxes.set(subscriptionId, inbox);
        let workerSide = true;
        const unsubscribe = Effect.suspend(() => {
          inboxes.delete(subscriptionId);
          if (overflowed.delete(subscriptionId) || !workerSide) return Effect.void;
          workerSide = false;
          // The response is dropped; nothing waits on an unsubscribe.
          return send("unsubscribe", { subscriptionId }, nextId++);
        });
        const outcome = yield* Effect.gen(function* () {
          const subscribed = yield* request("subscribe", { subscriptionId, topic, params }).pipe(
            Effect.result,
          );
          if (subscribed._tag === "Failure") {
            workerSide = false;
            if (first) return yield* subscribed.failure;
            return { type: "closed", reason: "worker-failed" } as const;
          }
          first = false;
          let sawSnapshot = false;
          while (true) {
            const item = yield* Queue.take(inbox.queue);
            if (item.kind === "event") inbox.bytes -= item.lineBytes;
            switch (item.kind) {
              case "closed":
                workerSide = false;
                return { type: "closed", reason: item.reason } as const;
              case "oversized":
                return { type: "closed", reason: "too-large" } as const;
              case "overflow":
                return { type: "resync" } as const;
              case "event": {
                const event = item.event;
                if (!isSubscriptionEvent(event)) {
                  return { type: "closed", reason: "protocol-error" } as const;
                }
                if (event.type === "closed") return event;
                if (event.type === "resync") {
                  sawSnapshot = false;
                } else if (event.type === "batch") {
                  if (!sawSnapshot) return { type: "closed", reason: "protocol-error" } as const;
                  if (
                    item.lineBytes > PLUGIN_LIMITS.maxBatchBytes &&
                    jsonBytes(event) > PLUGIN_LIMITS.maxBatchBytes
                  ) {
                    return { type: "closed", reason: "too-large" } as const;
                  }
                } else {
                  if (
                    item.lineBytes > PLUGIN_LIMITS.maxPayloadBytes &&
                    jsonBytes(event) > PLUGIN_LIMITS.maxPayloadBytes
                  ) {
                    return { type: "closed", reason: "too-large" } as const;
                  }
                  sawSnapshot = true;
                }
                yield* Queue.offer(out, event);
              }
            }
          }
        }).pipe(Effect.ensuring(unsubscribe));
        if (outcome.type === "resync") {
          yield* Queue.offer(out, outcome);
          continue;
        }
        return yield* finish(outcome);
      }
    });

    const subscribe = (topic: string, params: unknown) =>
      Stream.callback<PluginSubscriptionEvent, PluginRequestError>(
        (out) =>
          runSubscription(topic, params, out).pipe(
            Effect.catch((error: PluginRequestError) => Queue.fail(out, error)),
          ),
        { bufferSize: SUBSCRIPTION_OUTPUT_BUFFER, strategy: "suspend" },
      );

    return { request, subscribe, close } satisfies WorkerConnection;
  },
);

export interface PluginWorkerStartInput {
  readonly pluginId: PluginId;
  readonly version: string;
  /** Absolute path of the installed backend `.cjs`. */
  readonly entryPath: string;
  readonly dataDir: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly previousVersion?: string | undefined;
  readonly prerequisites: ReadonlyArray<PluginPrerequisiteDecl>;
  readonly resolveContext: PluginContextResolver;
}

export class PluginWorkerSupervisor extends Context.Service<
  PluginWorkerSupervisor,
  {
    /**
     * Replaces any running worker. A missing prerequisite sets `missing-prerequisite` and
     * spawns nothing.
     */
    readonly start: (input: PluginWorkerStartInput) => Effect.Effect<void, PluginRequestError>;
    /** Asks the worker to shut down, then kills its process group after 5 s. */
    readonly stop: (pluginId: PluginId, reason: PluginWorkerStopReason) => Effect.Effect<void>;
    readonly invoke: (
      pluginId: PluginId,
      request: {
        readonly operation: string;
        readonly input: unknown;
        readonly caller: "ui" | "agent";
        readonly context: PluginCallContext;
      },
    ) => Effect.Effect<unknown, PluginRequestError>;
    /** One worker subscription per stream; ending the stream unsubscribes. */
    readonly subscribe: (
      pluginId: PluginId,
      topic: string,
      params: unknown,
    ) => Stream.Stream<PluginSubscriptionEvent, PluginRequestError>;
    readonly resolveReference: (
      pluginId: PluginId,
      locator: Readonly<Record<string, string>>,
    ) => Effect.Effect<{ readonly title: string; readonly detail: string }, PluginRequestError>;
    readonly status: (pluginId: PluginId) => Effect.Effect<PluginWorkerStatus>;
    /** Every known plugin's current status first, then each change. */
    readonly statusChanges: Stream.Stream<PluginWorkerStatusChange>;
    /** The newest lines, at most 500, that fit `PLUGIN_LIMITS.maxPayloadBytes`. */
    readonly logs: (
      pluginId: PluginId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<PluginWorkerLogLine>>;
  }
>()("t3/plugins/PluginWorkerSupervisor") {}

interface ActiveWorker {
  readonly scope: Scope.Closeable;
  readonly connection: WorkerConnection;
  readonly exited: Deferred.Deferred<void>;
  ready: boolean;
  stopping: boolean;
}

interface LogRing {
  readonly lines: Array<PluginWorkerLogLine & { readonly bytes: number }>;
  bytes: number;
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const selfInvocation = yield* resolveSelfInvocation();
  const platform = yield* HostProcess.Platform;
  const services = yield* Effect.context<Effect.Services<ReturnType<typeof resolveCommandPath>>>();
  const lock = yield* KeyedLock.make<PluginId>();
  const statusHub = yield* PubSub.unbounded<PluginWorkerStatusChange>();
  const workers = new Map<PluginId, ActiveWorker>();
  const statuses = new Map<PluginId, PluginWorkerStatus>();
  const logRings = new Map<PluginId, LogRing>();

  const layerScope = yield* Effect.scope;
  const workersScope = yield* Scope.fork(layerScope, "parallel");

  const setStatus = (pluginId: PluginId, next: PluginWorkerStatus) =>
    Effect.suspend(() => {
      const current = statuses.get(pluginId);
      if (current?.status === next.status && current.detail === next.detail) return Effect.void;
      statuses.set(pluginId, next);
      return PubSub.publish(statusHub, { pluginId, ...next });
    });

  const appendLog = (pluginId: PluginId, text: string) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      let line = text;
      let bytes = utf8Bytes(line);
      if (bytes > LOG_LINE_MAX_BYTES) {
        line = `${decoder.decode(encoder.encode(line).subarray(0, LOG_LINE_MAX_BYTES - 3))}…`;
        bytes = utf8Bytes(line);
      }
      let ring = logRings.get(pluginId);
      if (ring === undefined) {
        ring = { lines: [], bytes: 0 };
        logRings.set(pluginId, ring);
      }
      ring.lines.push({ at, line, bytes });
      ring.bytes += bytes;
      while (ring.lines.length > LOG_MAX_LINES || ring.bytes > LOG_MAX_BYTES) {
        ring.bytes -= ring.lines.shift()?.bytes ?? 0;
      }
    });

  const exitLine = (exit: Exit.Exit<ChildProcessSpawner.ExitCode, unknown>) =>
    Exit.isSuccess(exit)
      ? `The plugin worker exited with code ${exit.value}.`
      : "The plugin worker was killed by a signal.";

  // Untraced: a background watcher per worker; start already has a span.
  const watchExit = Effect.fnUntraced(function* (
    pluginId: PluginId,
    worker: ActiveWorker,
    handle: ChildProcessSpawner.ChildProcessHandle,
    stderrDone: Fiber.Fiber<void>,
  ) {
    const exit = yield* Effect.exit(handle.exitCode);
    yield* Scope.close(worker.scope, Exit.void);
    yield* Fiber.join(stderrDone).pipe(Effect.timeoutOption(STDERR_DRAIN));
    yield* Fiber.interrupt(stderrDone);
    if (!worker.stopping && workers.get(pluginId) === worker) {
      workers.delete(pluginId);
      const line = exitLine(exit);
      yield* appendLog(pluginId, line);
      yield* setStatus(pluginId, { status: "failed", detail: line });
    }
    yield* Deferred.succeed(worker.exited, undefined);
  });

  const stopWorker = Effect.fn("PluginWorkerSupervisor.stopWorker")(function* (
    pluginId: PluginId,
    reason: PluginSubscriptionCloseReason,
  ) {
    const worker = workers.get(pluginId);
    if (worker === undefined) return;
    workers.delete(pluginId);
    worker.stopping = true;
    yield* worker.connection.close(reason);
    yield* worker.connection
      .request("shutdown", null)
      .pipe(
        Effect.ignore,
        Effect.andThen(Deferred.await(worker.exited)),
        Effect.timeoutOption(STOP_GRACE),
      );
    yield* Scope.close(worker.scope, Exit.void);
    yield* Deferred.await(worker.exited);
  }, Effect.uninterruptible);

  const stopLocked = (pluginId: PluginId, reason: PluginSubscriptionCloseReason) =>
    stopWorker(pluginId, reason).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          statuses.has(pluginId) ? setStatus(pluginId, { status: "stopped" }) : Effect.void,
        ),
      ),
    );

  const missingPrerequisite = Effect.fn("PluginWorkerSupervisor.missingPrerequisite")(function* (
    prerequisites: ReadonlyArray<PluginPrerequisiteDecl>,
  ) {
    for (const prerequisite of prerequisites) {
      const resolved = yield* resolveCommandPath(prerequisite.executable).pipe(
        Effect.provideContext(services),
      );
      if (resolved === null) return prerequisite;
    }
    return undefined;
  });

  /** Registers the spawned worker before any interruption can land, so stop always reaches it. */
  const spawnWorker = Effect.fn("PluginWorkerSupervisor.spawnWorker")(function* (
    input: PluginWorkerStartInput,
  ) {
    const { pluginId } = input;
    const scope = yield* Scope.fork(workersScope, "sequential");
    return yield* Effect.gen(function* () {
      const stdin = yield* Queue.unbounded<string>();
      const spawned = yield* spawner
        .spawn(
          ChildProcess.make(
            selfInvocation.command,
            [...selfInvocationArgs(selfInvocation, ["plugin-worker", input.entryPath])],
            {
              cwd: input.dataDir,
              // A POSIX process group lets stop reach the worker's own children.
              detached: platform !== "win32",
              forceKillAfter: Duration.seconds(1),
              stdin: { stream: Stream.encodeText(Stream.fromQueue(stdin)) },
              stdout: "pipe",
              stderr: "pipe",
            },
          ),
        )
        .pipe(Scope.provide(scope), Effect.result);
      if (spawned._tag === "Failure") {
        const detail = "The plugin worker could not be started.";
        yield* appendLog(pluginId, detail);
        yield* setStatus(pluginId, { status: "failed", detail });
        return yield* requestError("worker-failed", detail);
      }
      const handle = spawned.success;

      const stderrLines = makeLineSplitter(LOG_LINE_MAX_BYTES);
      const logLine = (line: SplitLine) => appendLog(pluginId, decoder.decode(line.bytes));
      const stderrDone = yield* handle.stderr.pipe(
        Stream.runForEach((chunk) => Effect.forEach(stderrLines.push(chunk), logLine)),
        Effect.ignore,
        Effect.andThen(
          Effect.suspend(() => {
            const rest = stderrLines.flush();
            return rest === undefined ? Effect.void : logLine(rest);
          }),
        ),
        Effect.forkIn(workersScope),
      );

      let worker: ActiveWorker | undefined;
      const connection = yield* makeWorkerConnection(handle.stdout, stdin, {
        onStatus: (status) =>
          worker !== undefined && !worker.stopping && workers.get(pluginId) === worker
            ? setStatus(pluginId, status)
            : Effect.void,
        onOutput: (line) => appendLog(pluginId, line),
        resolveContext: input.resolveContext,
      }).pipe(Scope.provide(scope));
      const active: ActiveWorker = {
        scope,
        connection,
        exited: yield* Deferred.make<void>(),
        ready: false,
        stopping: false,
      };
      worker = active;
      workers.set(pluginId, active);
      yield* watchExit(pluginId, active, handle, stderrDone).pipe(Effect.forkIn(workersScope));
      return active;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
  }, Effect.uninterruptible);

  // Untraced: runs only inside start's span.
  const startLocked = Effect.fnUntraced(function* (input: PluginWorkerStartInput) {
    const { pluginId } = input;
    yield* stopWorker(pluginId, "plugin-updated");
    const missing = yield* missingPrerequisite(input.prerequisites);
    if (missing !== undefined) {
      return yield* setStatus(pluginId, {
        status: "missing-prerequisite",
        detail: bounded(`${missing.executable} was not found on PATH. ${missing.hint}`),
      });
    }
    // Only initialize is interruptible, so an interrupt always finds a registered worker to stop.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* setStatus(pluginId, { status: "starting" });
        const active = yield* spawnWorker(input);
        const initialized = yield* restore(
          active.connection.request(
            "initialize",
            {
              apiVersion: WORKER_PROTOCOL_VERSION,
              pluginId,
              version: input.version,
              ...(input.previousVersion === undefined
                ? {}
                : { previousVersion: input.previousVersion }),
              dataDir: input.dataDir,
              config: input.config,
              secrets: input.secrets,
            },
            INITIALIZE_TIMEOUT,
          ),
        ).pipe(
          Effect.onInterrupt(() => stopLocked(pluginId, "worker-failed")),
          Effect.result,
        );
        if (initialized._tag === "Failure") {
          const error = initialized.failure;
          yield* stopWorker(pluginId, "worker-failed");
          const detail = bounded(error.message);
          yield* appendLog(pluginId, `The plugin worker failed to start: ${detail}`);
          yield* setStatus(pluginId, { status: "failed", detail });
          return yield* error;
        }
        if (workers.get(pluginId) !== active) {
          return yield* requestError("worker-failed");
        }
        active.ready = true;
        // Keep a status the worker reported during onStart, such as a lost prerequisite.
        if (statuses.get(pluginId)?.status === "starting") {
          yield* setStatus(pluginId, { status: "running" });
        }
      }),
    );
  });

  const requireReady = (pluginId: PluginId) =>
    Effect.suspend(() => {
      const worker = workers.get(pluginId);
      return worker !== undefined && worker.ready && !worker.stopping
        ? Effect.succeed(worker)
        : Effect.fail(requestError("not-running"));
    });

  const start: PluginWorkerSupervisor["Service"]["start"] = Effect.fn(
    "PluginWorkerSupervisor.start",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ pluginId: input.pluginId, version: input.version });
    yield* lock.withLock(input.pluginId, startLocked(input));
  });

  const stop: PluginWorkerSupervisor["Service"]["stop"] = Effect.fn("PluginWorkerSupervisor.stop")(
    function* (pluginId, reason) {
      yield* Effect.annotateCurrentSpan({ pluginId, reason });
      yield* lock.withLock(pluginId, stopLocked(pluginId, reason));
    },
  );

  const invoke: PluginWorkerSupervisor["Service"]["invoke"] = Effect.fn(
    "PluginWorkerSupervisor.invoke",
  )(function* (pluginId, request) {
    yield* Effect.annotateCurrentSpan({
      pluginId,
      operation: request.operation,
      caller: request.caller,
    });
    const worker = yield* requireReady(pluginId);
    if (jsonBytes(request.input ?? null) > PLUGIN_LIMITS.maxPayloadBytes) {
      return yield* requestError(
        "too-large",
        `The operation input exceeds ${PLUGIN_LIMITS.maxPayloadBytes} bytes.`,
      );
    }
    const result = yield* worker.connection.request("invoke", {
      operation: request.operation,
      input: request.input ?? null,
      caller: request.caller,
      context: request.context,
    });
    if (jsonBytes(result) > PLUGIN_LIMITS.maxPayloadBytes) {
      return yield* requestError(
        "too-large",
        `The operation result exceeds ${PLUGIN_LIMITS.maxPayloadBytes} bytes.`,
      );
    }
    return result;
  });

  const subscribe: PluginWorkerSupervisor["Service"]["subscribe"] = (pluginId, topic, params) =>
    Stream.unwrap(
      Effect.map(requireReady(pluginId), (worker) => worker.connection.subscribe(topic, params)),
    );

  const resolveReference: PluginWorkerSupervisor["Service"]["resolveReference"] = Effect.fn(
    "PluginWorkerSupervisor.resolveReference",
  )(function* (pluginId, locator) {
    yield* Effect.annotateCurrentSpan({ pluginId });
    const worker = yield* requireReady(pluginId);
    const resolved = yield* worker.connection.request("resolveReference", { locator });
    if (
      !isRecord(resolved) ||
      typeof resolved.title !== "string" ||
      typeof resolved.detail !== "string"
    ) {
      return yield* requestError("operation-failed", "The plugin returned an invalid reference.");
    }
    return { title: resolved.title, detail: resolved.detail };
  });

  const status: PluginWorkerSupervisor["Service"]["status"] = (pluginId) =>
    Effect.sync(() => statuses.get(pluginId) ?? { status: "stopped" });

  const statusChanges: PluginWorkerSupervisor["Service"]["statusChanges"] = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(statusHub);
      const current = [...statuses].map(([pluginId, value]) => ({ pluginId, ...value }));
      return Stream.concat(Stream.fromIterable(current), Stream.fromSubscription(subscription));
    }),
  );

  const logs: PluginWorkerSupervisor["Service"]["logs"] = Effect.fn("PluginWorkerSupervisor.logs")(
    function* (pluginId, limit) {
      yield* Effect.annotateCurrentSpan({ pluginId });
      const ring = logRings.get(pluginId);
      if (ring === undefined) return [];
      const max = Math.min(Math.max(Math.floor(limit), 0), LOGS_MAX_LIMIT);
      const newest: Array<PluginWorkerLogLine> = [];
      let bytes = 2;
      for (let index = ring.lines.length - 1; index >= 0 && newest.length < max; index -= 1) {
        const { at, line } = ring.lines[index]!;
        const entryBytes = jsonBytes({ at, line }) + 1;
        if (bytes + entryBytes > PLUGIN_LIMITS.maxPayloadBytes) break;
        bytes += entryBytes;
        newest.push({ at, line });
      }
      return newest.reverse();
    },
  );

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...workers.keys()], (pluginId) => stopWorker(pluginId, "plugin-disabled"), {
      concurrency: "unbounded",
      discard: true,
    }),
  );

  return PluginWorkerSupervisor.of({
    start,
    stop,
    invoke,
    subscribe,
    resolveReference,
    status,
    statusChanges,
    logs,
  });
});

export const layer = Layer.effect(PluginWorkerSupervisor, make);
