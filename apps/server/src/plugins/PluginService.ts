import {
  PLUGIN_LIMITS,
  type PluginConfig,
  type PluginConfigureInput,
  type PluginId,
  type PluginInstallInput,
  type PluginInstallRecord,
  type PluginLogs,
  type PluginLogsInput,
  type PluginOperationCallInput,
  type PluginOperationDecl,
  type PluginRegistrySnapshot,
  PluginRequestError,
  type PluginResolvedReference,
  type PluginResolveReferenceInput,
  type PluginResourceDecl,
  type PluginSubscribeInput,
  type PluginSubscriptionEvent,
  type PluginUpdateInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as PluginPackageStore from "./PluginPackageStore.ts";
import * as PluginWorkerSupervisor from "./PluginWorkerSupervisor.ts";

const COALESCE_WINDOW = Duration.millis(250);
const MAX_BATCH_ITEMS = 200;
const SUBSCRIPTION_QUEUE_BATCHES = 16;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 8;
const MAX_SUBSCRIPTIONS_PER_PLUGIN = 64;
const DEFAULT_LOG_LINES = 200;

const encoder = new TextEncoder();
const jsonBytes = (value: unknown) => {
  try {
    return encoder.encode(JSON.stringify(value) ?? "null").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const requestError = (reason: PluginRequestError["reason"], detail?: string) =>
  new PluginRequestError({ reason, ...(detail === undefined ? {} : { detail }) });

const requireWithinPayload = (value: unknown, what: string) =>
  jsonBytes(value ?? null) > PLUGIN_LIMITS.maxPayloadBytes
    ? Effect.fail(
        requestError("too-large", `The ${what} exceeds ${PLUGIN_LIMITS.maxPayloadBytes} bytes.`),
      )
    : Effect.void;

export interface PluginAgentCatalogEntry {
  readonly pluginId: PluginId;
  readonly name: string;
  readonly operations: ReadonlyArray<PluginOperationDecl>;
  readonly resources: ReadonlyArray<PluginResourceDecl>;
}

export class PluginService extends Context.Service<
  PluginService,
  {
    /** Installed records with the worker supervisor's live status overlaid. */
    readonly list: Effect.Effect<PluginRegistrySnapshot>;
    readonly subscribeRegistry: Stream.Stream<PluginRegistrySnapshot>;
    readonly install: (
      input: PluginInstallInput,
    ) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    /** A start failure after the commit is recorded as `failedUpdate`, never rolled back. */
    readonly update: (
      input: PluginUpdateInput,
    ) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    readonly uninstall: (pluginId: PluginId) => Effect.Effect<void, PluginRequestError>;
    readonly deleteData: (pluginId: PluginId) => Effect.Effect<void, PluginRequestError>;
    readonly setEnabled: (
      pluginId: PluginId,
      enabled: boolean,
    ) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    readonly start: (pluginId: PluginId) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    readonly stop: (pluginId: PluginId) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    readonly restart: (
      pluginId: PluginId,
    ) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    /** Restarts a live backend so it reads the new values. */
    readonly configure: (input: PluginConfigureInput) => Effect.Effect<void, PluginRequestError>;
    readonly readConfig: (pluginId: PluginId) => Effect.Effect<PluginConfig, PluginRequestError>;
    readonly logs: (input: PluginLogsInput) => Effect.Effect<PluginLogs, PluginRequestError>;
    /** Panel call for a non-mutating operation. */
    readonly query: (input: PluginOperationCallInput) => Effect.Effect<unknown, PluginRequestError>;
    /** Panel call for a mutating operation. */
    readonly mutate: (
      input: PluginOperationCallInput,
    ) => Effect.Effect<unknown, PluginRequestError>;
    /** `connectionId` names the client socket the per-connection limit counts against. */
    readonly subscribe: (
      input: PluginSubscribeInput & { readonly connectionId: string },
    ) => Stream.Stream<PluginSubscriptionEvent, PluginRequestError>;
    readonly resolveReference: (
      input: PluginResolveReferenceInput,
    ) => Effect.Effect<PluginResolvedReference, PluginRequestError>;
    /** The operation surface shared by panels and agents; agents reach only `agent: true` operations. */
    readonly callOperation: (input: {
      readonly pluginId: PluginId;
      readonly operation: string;
      readonly input: unknown;
      readonly caller: "ui" | "agent";
    }) => Effect.Effect<unknown, PluginRequestError>;
    /** Enabled plugins with a backend. */
    readonly agentCatalog: Effect.Effect<ReadonlyArray<PluginAgentCatalogEntry>>;
  }
>()("t3/plugins/PluginService") {}

const make = Effect.gen(function* () {
  const store = yield* PluginPackageStore.PluginPackageStore;
  const supervisor = yield* PluginWorkerSupervisor.PluginWorkerSupervisor;
  const path = yield* Path.Path;
  const lifecycleLock = yield* KeyedLock.make<PluginId>();
  const subscriptionCounts = new Map<string, number>();
  const layerScope = yield* Effect.scope;

  // A client disconnect interrupts its RPC; a half-done lifecycle step would orphan a worker.
  const detached = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.forkIn(layerScope), Effect.flatMap(Fiber.join));

  const overlay = (record: PluginInstallRecord) =>
    !record.enabled || record.manifest.backend === undefined
      ? Effect.succeed(record)
      : Effect.map(supervisor.status(record.pluginId), (live): PluginInstallRecord => {
          const { statusDetail: _stored, ...rest } = record;
          return {
            ...rest,
            status: live.status,
            ...(live.detail === undefined ? {} : { statusDetail: live.detail }),
          };
        });

  const currentRegistry = Effect.gen(function* () {
    const snapshot = yield* store.snapshot;
    return {
      ...snapshot,
      installed: yield* Effect.forEach(snapshot.installed, overlay),
    } satisfies PluginRegistrySnapshot;
  });

  const findInstalled = (pluginId: PluginId) =>
    Effect.flatMap(store.snapshot, (snapshot) => {
      const record = snapshot.installed.find((candidate) => candidate.pluginId === pluginId);
      return record === undefined
        ? Effect.fail(requestError("not-installed"))
        : Effect.succeed(record);
    });

  const recordFor = (pluginId: PluginId) => Effect.flatMap(findInstalled(pluginId), overlay);

  const requireEnabled = (pluginId: PluginId, expectedVersion?: string) =>
    Effect.flatMap(findInstalled(pluginId), (record) => {
      if (!record.enabled) return Effect.fail(requestError("disabled"));
      if (expectedVersion !== undefined && expectedVersion !== record.version) {
        return Effect.fail(requestError("version-changed"));
      }
      return Effect.succeed(record);
    });

  /** Callers hold the plugin's lifecycle lock. */
  const startBackend = Effect.fn("PluginService.startBackend")(function* (
    record: PluginInstallRecord,
    previousVersion?: string,
  ) {
    const backend = record.manifest.backend;
    if (!record.enabled || backend === undefined) return;
    const { packageDir, dataDir } = store.paths(record.pluginId, record.version);
    const runtime = yield* store.runtimeConfig(record.pluginId);
    yield* supervisor.start({
      pluginId: record.pluginId,
      version: record.version,
      entryPath: path.join(packageDir, backend.entry),
      dataDir,
      config: runtime.config,
      secrets: runtime.secrets,
      previousVersion,
      prerequisites: backend.prerequisites,
    });
    if (
      record.failedUpdate?.to === record.version &&
      (yield* supervisor.status(record.pluginId)).status === "running"
    ) {
      yield* store.clearFailedUpdate(record.pluginId);
    }
  });

  const startQuietly = (record: PluginInstallRecord) =>
    startBackend(record).pipe(
      Effect.catchTags({
        PluginRequestError: (error) =>
          Effect.logWarning("Plugin backend did not start.", {
            pluginId: record.pluginId,
            reason: error.reason,
          }),
      }),
    );

  /** Re-reads the record under the lock, so a disable or uninstall that won the lock holds. */
  const startCurrent = (pluginId: PluginId) =>
    Effect.flatMap(store.snapshot, (snapshot) => {
      const record = snapshot.installed.find((candidate) => candidate.pluginId === pluginId);
      return record === undefined ? Effect.void : startQuietly(record);
    });

  const registry = yield* SubscriptionRef.make(yield* currentRegistry);
  yield* Stream.merge(store.changes, supervisor.statusChanges).pipe(
    Stream.runForEach(() =>
      Effect.flatMap(currentRegistry, (next) => SubscriptionRef.set(registry, next)),
    ),
    Effect.forkScoped,
  );

  const install: PluginService["Service"]["install"] = Effect.fn("PluginService.install")(
    function* (input) {
      const { record } = yield* store.installFromAttachment(input);
      yield* lifecycleLock.withLock(record.pluginId, startCurrent(record.pluginId));
      return yield* recordFor(record.pluginId);
    },
    detached,
  );

  const update: PluginService["Service"]["update"] = Effect.fn("PluginService.update")(function* (
    input,
  ) {
    yield* Effect.annotateCurrentSpan({ pluginId: input.pluginId });
    return yield* lifecycleLock.withLock(
      input.pluginId,
      Effect.gen(function* () {
        const staged = yield* store.stageUpdate(input);
        yield* supervisor.stop(input.pluginId, "plugin-updated");
        const committed = yield* store
          .commitVersion(input.pluginId, staged.to)
          .pipe(
            Effect.tapError(() =>
              Effect.flatMap(findInstalled(input.pluginId), startQuietly).pipe(Effect.ignore),
            ),
          );
        const started = yield* startBackend(committed, staged.from).pipe(Effect.result);
        const failed =
          started._tag === "Failure" ||
          (committed.enabled &&
            committed.manifest.backend !== undefined &&
            (yield* supervisor.status(input.pluginId)).status === "failed");
        if (failed) {
          yield* store.markFailedUpdate(input.pluginId, {
            from: staged.from,
            to: staged.to,
            reason: `Update to ${staged.to} failed during start; data may already be migrated.`,
          });
        }
        return yield* recordFor(input.pluginId);
      }),
    );
  }, detached);

  const uninstall: PluginService["Service"]["uninstall"] = Effect.fn("PluginService.uninstall")(
    function* (pluginId) {
      yield* Effect.annotateCurrentSpan({ pluginId });
      yield* lifecycleLock.withLock(
        pluginId,
        Effect.gen(function* () {
          yield* findInstalled(pluginId);
          yield* supervisor.stop(pluginId, "plugin-uninstalled");
          yield* store.uninstall(pluginId);
        }),
      );
    },
    detached,
  );

  const deleteData: PluginService["Service"]["deleteData"] = Effect.fn("PluginService.deleteData")(
    function* (pluginId) {
      yield* Effect.annotateCurrentSpan({ pluginId });
      yield* lifecycleLock.withLock(pluginId, store.deleteData(pluginId));
    },
    detached,
  );

  const setEnabled: PluginService["Service"]["setEnabled"] = Effect.fn("PluginService.setEnabled")(
    function* (pluginId, enabled) {
      yield* Effect.annotateCurrentSpan({ pluginId, enabled });
      return yield* lifecycleLock.withLock(
        pluginId,
        Effect.gen(function* () {
          const record = yield* store.setEnabled(pluginId, enabled);
          if (enabled) {
            yield* startQuietly(record);
          } else {
            yield* supervisor.stop(pluginId, "plugin-disabled");
          }
          return yield* recordFor(pluginId);
        }),
      );
    },
    detached,
  );

  const start: PluginService["Service"]["start"] = Effect.fn("PluginService.start")(function* (
    pluginId,
  ) {
    yield* Effect.annotateCurrentSpan({ pluginId });
    return yield* lifecycleLock.withLock(
      pluginId,
      Effect.gen(function* () {
        const record = yield* requireEnabled(pluginId);
        if ((yield* supervisor.status(pluginId)).status !== "running") {
          yield* startBackend(record);
        }
        return yield* recordFor(pluginId);
      }),
    );
  }, detached);

  // The supervisor replaces a live worker, closing its subscriptions with plugin-updated.
  const restart: PluginService["Service"]["restart"] = Effect.fn("PluginService.restart")(
    function* (pluginId) {
      yield* Effect.annotateCurrentSpan({ pluginId });
      return yield* lifecycleLock.withLock(
        pluginId,
        Effect.gen(function* () {
          yield* startBackend(yield* requireEnabled(pluginId));
          return yield* recordFor(pluginId);
        }),
      );
    },
    detached,
  );

  const stop: PluginService["Service"]["stop"] = Effect.fn("PluginService.stop")(function* (
    pluginId,
  ) {
    yield* Effect.annotateCurrentSpan({ pluginId });
    return yield* lifecycleLock.withLock(
      pluginId,
      Effect.gen(function* () {
        yield* findInstalled(pluginId);
        // Subscribers see what a fresh subscribe to a stopped worker reports.
        yield* supervisor.stop(pluginId, "worker-failed");
        return yield* recordFor(pluginId);
      }),
    );
  }, detached);

  const configure: PluginService["Service"]["configure"] = Effect.fn("PluginService.configure")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ pluginId: input.pluginId });
      yield* requireWithinPayload(input.values, "configuration");
      yield* lifecycleLock.withLock(
        input.pluginId,
        Effect.gen(function* () {
          yield* store.writeConfig(input.pluginId, input.values);
          const record = yield* findInstalled(input.pluginId);
          const live = yield* supervisor.status(input.pluginId);
          if (live.status !== "stopped") yield* startQuietly(record);
        }),
      );
    },
    detached,
  );

  const readConfig: PluginService["Service"]["readConfig"] = (pluginId) =>
    store.readConfig(pluginId);

  const logs: PluginService["Service"]["logs"] = Effect.fn("PluginService.logs")(function* (input) {
    yield* findInstalled(input.pluginId);
    const lines = yield* supervisor.logs(input.pluginId, input.limit ?? DEFAULT_LOG_LINES);
    return { lines };
  });

  const resolveOperation = (
    record: PluginInstallRecord,
    operation: string,
    caller: "ui" | "agent",
  ) => {
    const declared = record.manifest.backend?.operations.find(
      (candidate) => candidate.name === operation,
    );
    return declared === undefined || (caller === "agent" && !declared.agent)
      ? Effect.fail(requestError("unknown-operation"))
      : Effect.succeed(declared);
  };

  const invoke = (pluginId: PluginId, operation: string, input: unknown, caller: "ui" | "agent") =>
    requireWithinPayload(input, "operation input").pipe(
      Effect.andThen(supervisor.invoke(pluginId, { operation, input, caller })),
    );

  const callOperation: PluginService["Service"]["callOperation"] = Effect.fn(
    "PluginService.callOperation",
  )(function* (request) {
    yield* Effect.annotateCurrentSpan({
      pluginId: request.pluginId,
      operation: request.operation,
      caller: request.caller,
    });
    const record = yield* requireEnabled(request.pluginId);
    yield* resolveOperation(record, request.operation, request.caller);
    return yield* invoke(request.pluginId, request.operation, request.input, request.caller);
  });

  // Untraced: runs only inside the query or mutate span.
  const panelCall = (mutating: boolean) =>
    Effect.fnUntraced(function* (input: PluginOperationCallInput) {
      const record = yield* requireEnabled(input.pluginId, input.expectedVersion);
      const declared = yield* resolveOperation(record, input.operation, "ui");
      if (declared.mutates !== mutating) {
        return yield* requestError(
          "operation-mutates",
          mutating
            ? "This operation does not change state; call it as a query."
            : "This operation changes state; call it as a mutation.",
        );
      }
      return yield* invoke(input.pluginId, input.operation, input.input, "ui");
    });

  const query: PluginService["Service"]["query"] = Effect.fn("PluginService.query")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ pluginId: input.pluginId, operation: input.operation });
      return yield* panelCall(false)(input);
    },
  );

  const mutate: PluginService["Service"]["mutate"] = Effect.fn("PluginService.mutate")(
    function* (input) {
      yield* Effect.annotateCurrentSpan({ pluginId: input.pluginId, operation: input.operation });
      return yield* panelCall(true)(input);
    },
  );

  const resolveReference: PluginService["Service"]["resolveReference"] = Effect.fn(
    "PluginService.resolveReference",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ pluginId: input.pluginId });
    yield* requireEnabled(input.pluginId);
    yield* requireWithinPayload(input.locator, "reference locator");
    const resolved = yield* supervisor.resolveReference(input.pluginId, input.locator);
    yield* requireWithinPayload(resolved, "resolved reference");
    return resolved;
  });

  const acquireSubscriptionSlot = (connectionId: string, pluginId: PluginId) => {
    const keys = [pluginId, `${connectionId}\u0000${pluginId}`] as const;
    return Effect.acquireRelease(
      Effect.suspend(() => {
        if (
          (subscriptionCounts.get(keys[0]) ?? 0) >= MAX_SUBSCRIPTIONS_PER_PLUGIN ||
          (subscriptionCounts.get(keys[1]) ?? 0) >= MAX_SUBSCRIPTIONS_PER_CONNECTION
        ) {
          return Effect.fail(requestError("subscription-limit"));
        }
        for (const key of keys) subscriptionCounts.set(key, (subscriptionCounts.get(key) ?? 0) + 1);
        return Effect.void;
      }),
      () =>
        Effect.sync(() => {
          for (const key of keys) {
            const next = (subscriptionCounts.get(key) ?? 1) - 1;
            if (next === 0) subscriptionCounts.delete(key);
            else subscriptionCounts.set(key, next);
          }
        }),
    );
  };

  /**
   * Merges batches arriving within 250 ms into at most 200 items and `maxBatchBytes`, each
   * piece keeping its last source batch's revision. `out` holds 16 events; when it is full
   * the worker side backs up until the supervisor drops the worker subscription and resyncs.
   */
  // Untraced: lives as long as the subscription, and addChunk runs per event.
  const coalesce = Effect.fnUntraced(function* (
    upstream: Stream.Stream<PluginSubscriptionEvent, PluginRequestError>,
    out: Queue.Queue<PluginSubscriptionEvent, PluginRequestError | Cause.Done>,
  ) {
    const lock = yield* Semaphore.make(1);
    let pending: { items: Array<unknown>; itemBytes: number; revision: string } | undefined;
    let flushScheduled = false;

    const emitPending = Effect.suspend(() => {
      const batch = pending;
      pending = undefined;
      return batch === undefined
        ? Effect.void
        : Queue.offer(out, { type: "batch", items: batch.items, revision: batch.revision });
    });
    const batchBytes = (items: number, itemBytes: number, revision: string) =>
      jsonBytes({ type: "batch", items: [], revision }) + itemBytes + Math.max(items - 1, 0);

    const addChunk = Effect.fnUntraced(function* (items: Array<unknown>, revision: string) {
      const itemBytes = items.reduce<number>((sum, item) => sum + jsonBytes(item), 0);
      if (
        pending !== undefined &&
        (pending.items.length + items.length > MAX_BATCH_ITEMS ||
          batchBytes(pending.items.length + items.length, pending.itemBytes + itemBytes, revision) >
            PLUGIN_LIMITS.maxBatchBytes)
      ) {
        yield* emitPending;
      }
      if (pending === undefined) {
        pending = { items, itemBytes, revision };
      } else {
        pending.items.push(...items);
        pending.itemBytes += itemBytes;
        pending.revision = revision;
      }
      if (pending.items.length >= MAX_BATCH_ITEMS) return yield* emitPending;
      if (flushScheduled) return;
      flushScheduled = true;
      yield* Effect.sleep(COALESCE_WINDOW).pipe(
        Effect.andThen(
          lock.withPermit(
            Effect.suspend(() => {
              flushScheduled = false;
              return emitPending;
            }),
          ),
        ),
        Effect.forkScoped,
      );
    });

    const onEvent = (event: PluginSubscriptionEvent) =>
      lock.withPermit(
        Effect.gen(function* () {
          switch (event.type) {
            case "batch": {
              if (event.items.length === 0) return yield* addChunk([], event.revision);
              for (let start = 0; start < event.items.length; start += MAX_BATCH_ITEMS) {
                yield* addChunk(event.items.slice(start, start + MAX_BATCH_ITEMS), event.revision);
              }
              return;
            }
            case "resync":
              pending = undefined;
              return yield* Queue.offer(out, event);
            case "snapshot":
            case "closed":
              yield* emitPending;
              return yield* Queue.offer(out, event);
          }
        }),
      );

    yield* Stream.runForEach(upstream, onEvent);
    yield* lock.withPermit(emitPending);
    yield* Queue.end(out);
  });

  const subscribe: PluginService["Service"]["subscribe"] = (input) =>
    Stream.callback<PluginSubscriptionEvent, PluginRequestError>(
      (out) =>
        Effect.gen(function* () {
          const record = yield* requireEnabled(input.pluginId, input.expectedVersion);
          if (!record.manifest.backend?.topics.some((topic) => topic.name === input.topic)) {
            return yield* requestError("unknown-operation", `No topic "${input.topic}".`);
          }
          yield* requireWithinPayload(input.params, "subscription parameters");
          yield* acquireSubscriptionSlot(input.connectionId, input.pluginId);
          yield* coalesce(supervisor.subscribe(input.pluginId, input.topic, input.params), out);
        }),
      { bufferSize: SUBSCRIPTION_QUEUE_BATCHES, strategy: "suspend" },
    );

  const agentCatalog: PluginService["Service"]["agentCatalog"] = Effect.map(
    store.snapshot,
    (snapshot) =>
      snapshot.installed.flatMap((record) =>
        record.enabled && record.manifest.backend !== undefined
          ? [
              {
                pluginId: record.pluginId,
                name: record.name,
                operations: record.manifest.backend.operations,
                resources: record.manifest.backend.resources,
              },
            ]
          : [],
      ),
  );

  yield* Effect.flatMap(store.snapshot, (snapshot) =>
    Effect.forEach(
      snapshot.installed,
      (record) =>
        lifecycleLock
          .withLock(record.pluginId, startCurrent(record.pluginId))
          .pipe(Effect.ignoreCause({ log: true })),
      { concurrency: "unbounded", discard: true },
    ),
  ).pipe(Effect.forkScoped);

  return PluginService.of({
    list: currentRegistry,
    subscribeRegistry: SubscriptionRef.changes(registry),
    install,
    update,
    uninstall,
    deleteData,
    setEnabled,
    start,
    stop,
    restart,
    configure,
    readConfig,
    logs,
    query,
    mutate,
    subscribe,
    resolveReference,
    callOperation,
    agentCatalog,
  });
});

export const layer = Layer.effect(PluginService, make);
