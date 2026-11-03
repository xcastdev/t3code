import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PLUGIN_LIMITS,
  type PluginId,
  type PluginManifest,
  type PluginOperationDecl,
  PluginRequestError,
  type PluginSubscriptionEvent,
} from "@t3tools/contracts";
import { packPlugin } from "@t3tools/plugin-sdk/pack";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { attachmentFileExtension, createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PluginPackageStore from "./PluginPackageStore.ts";
import * as PluginService from "./PluginService.ts";
import * as PluginWorkerSupervisor from "./PluginWorkerSupervisor.ts";

const PROBE = "probe" as PluginId;
const encoder = new TextEncoder();

const operation = (name: string, mutates: boolean, agent: boolean): PluginOperationDecl => ({
  name,
  title: name,
  description: `The ${name} operation.`,
  inputSchema: { type: "object" },
  mutates,
  agent,
});

const manifest = (version: string): PluginManifest => ({
  manifestVersion: 1,
  id: PROBE,
  name: "Probe",
  version,
  hostApi: "1.0",
  author: "T3 Tests",
  backend: {
    entry: "backend/index.cjs",
    operations: [
      operation("read", false, true),
      operation("write", true, true),
      operation("internal", false, false),
    ],
    topics: [{ name: "ticks" }],
    resources: [],
    prerequisites: [],
  },
  capabilities: [],
});

const uploadPackage = Effect.fn("test.uploadPackage")(function* (version: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const source = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-plugin-source-" });
  yield* fileSystem.makeDirectory(path.join(source, "backend"));
  yield* fileSystem.writeFileString(
    path.join(source, "t3-plugin.json"),
    JSON.stringify(manifest(version)),
  );
  yield* fileSystem.writeFileString(path.join(source, "backend", "index.ts"), "export {};\n");
  const extension = attachmentFileExtension("probe.t3plugin");
  const attachmentId = createPendingAttachmentId(extension);
  const archive = path.join(config.attachmentsDir, `${attachmentId}${extension}`);
  yield* Effect.promise(() => packPlugin(source, archive));
  return attachmentId;
});

const memoryWorker = Effect.gen(function* () {
  const input = yield* Queue.unbounded<Uint8Array>();
  const output = yield* Queue.unbounded<string>();
  const connection = yield* PluginWorkerSupervisor.makeWorkerConnection(
    Stream.fromQueue(input),
    output,
  );
  return {
    connection,
    feed: (message: unknown) => Queue.offer(input, encoder.encode(`${JSON.stringify(message)}\n`)),
    sent: Effect.map(
      Queue.take(output),
      (line) =>
        JSON.parse(line) as {
          readonly id: number;
          readonly method: string;
          readonly params: { readonly subscriptionId: string };
        },
    ),
  };
});
type MemoryWorker = Effect.Success<typeof memoryWorker>;

/** Stands in for worker processes; subscriptions run through the real worker connection. */
const makeFakeSupervisor = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const store = yield* PluginPackageStore.PluginPackageStore;
  const statusHub = yield* PubSub.unbounded<PluginWorkerSupervisor.PluginWorkerStatusChange>();
  const statuses = new Map<PluginId, PluginWorkerSupervisor.PluginWorkerStatus>();
  const workers = new Map<PluginId, MemoryWorker>();
  const events: Array<string> = [];
  const failingVersions = new Set<string>();
  const subscriptionOverride: {
    current?: Stream.Stream<PluginSubscriptionEvent, PluginRequestError>;
  } = {};
  const stopGate: {
    current?: {
      readonly entered: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    };
  } = {};

  const setStatus = (pluginId: PluginId, status: PluginWorkerSupervisor.PluginWorkerStatus) =>
    Effect.suspend(() => {
      statuses.set(pluginId, status);
      return PubSub.publish(statusHub, { pluginId, ...status });
    });
  const notRunning = () => new PluginRequestError({ reason: "not-running" });

  const service = PluginWorkerSupervisor.PluginWorkerSupervisor.of({
    start: (input) =>
      Effect.gen(function* () {
        yield* workers.get(input.pluginId)?.connection.close("plugin-updated") ?? Effect.void;
        workers.delete(input.pluginId);
        events.push(`start ${input.version} from ${input.previousVersion ?? "none"}`);
        if (failingVersions.has(input.version)) {
          yield* setStatus(input.pluginId, { status: "failed", detail: "Migration failed." });
          return yield* new PluginRequestError({ reason: "worker-failed" });
        }
        workers.set(input.pluginId, yield* memoryWorker.pipe(Scope.provide(scope)));
        yield* setStatus(input.pluginId, { status: "running" });
      }),
    stop: (pluginId, reason) =>
      Effect.gen(function* () {
        const gate = stopGate.current;
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.entered, undefined);
          yield* Deferred.await(gate.release);
        }
        yield* workers.get(pluginId)?.connection.close(reason) ?? Effect.void;
        workers.delete(pluginId);
        const installed = (yield* store.snapshot).installed.some(
          (record) => record.pluginId === pluginId,
        );
        events.push(`stop ${reason}${installed ? "" : " after uninstall"}`);
        yield* setStatus(pluginId, { status: "stopped" });
      }),
    invoke: (pluginId, request) =>
      Effect.suspend(() => {
        if (!workers.has(pluginId)) return Effect.fail(notRunning());
        events.push(`invoke ${request.operation}`);
        return Effect.succeed({ echoed: request.input });
      }),
    subscribe: (pluginId, topic, params) =>
      Stream.unwrap(
        Effect.suspend(() => {
          const worker = workers.get(pluginId);
          if (worker === undefined) return Effect.fail(notRunning());
          return Effect.succeed(
            subscriptionOverride.current ?? worker.connection.subscribe(topic, params),
          );
        }),
      ),
    resolveReference: () => Effect.succeed({ title: "Request", detail: "GET /" }),
    status: (pluginId) => Effect.sync(() => statuses.get(pluginId) ?? { status: "stopped" }),
    statusChanges: Stream.fromPubSub(statusHub),
    logs: () => Effect.succeed([]),
  });

  return {
    service,
    events,
    failingVersions,
    subscriptionOverride,
    stopGate,
    worker: (pluginId: PluginId) =>
      Effect.suspend(() => {
        const worker = workers.get(pluginId);
        return worker === undefined ? Effect.die("no worker") : Effect.succeed(worker);
      }),
  };
});
type FakeSupervisor = Effect.Success<typeof makeFakeSupervisor>;

const storeLayer = PluginPackageStore.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-service-" })),
  Layer.provideMerge(NodeServices.layer),
);

const withService = <A, E>(
  body: (context: {
    readonly service: PluginService.PluginService["Service"];
    readonly fake: FakeSupervisor;
    readonly installProbe: Effect.Effect<
      void,
      PlatformError.PlatformError | PluginRequestError,
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Scope.Scope
    >;
  }) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeSupervisor;
    return yield* Effect.gen(function* () {
      const service = yield* PluginService.PluginService;
      const installProbe = Effect.flatMap(uploadPackage("0.1.0"), (attachmentId) =>
        service.install({ attachmentId, trustBackendAuthor: true }),
      ).pipe(Effect.asVoid);
      return yield* body({ service, fake, installProbe });
    }).pipe(
      Effect.provide(
        PluginService.layer.pipe(
          Layer.provide(Layer.succeed(PluginWorkerSupervisor.PluginWorkerSupervisor, fake.service)),
        ),
      ),
    );
  }).pipe(Effect.provide(storeLayer), Effect.scoped);

const reasonOf = <A>(effect: Effect.Effect<A, PluginRequestError>) =>
  Effect.match(effect, { onFailure: (error) => error.reason, onSuccess: () => "succeeded" });

const snapshot = (revision: string): PluginSubscriptionEvent => ({
  type: "snapshot",
  items: [],
  revision,
  cursor: null,
});
const batch = (items: ReadonlyArray<unknown>, revision: string): PluginSubscriptionEvent => ({
  type: "batch",
  items,
  revision,
});

/** Consumes the stream into a queue so tests can take events as they arrive. */
const collect = (stream: Stream.Stream<PluginSubscriptionEvent, PluginRequestError>) =>
  Effect.gen(function* () {
    const received = yield* Queue.unbounded<PluginSubscriptionEvent>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((event) => Queue.offer(received, event)),
      Effect.forkScoped,
    );
    return { take: Queue.take(received), fiber };
  });

/** Acknowledges the worker subscribe request and sends its first snapshot. */
const openWorkerSubscription = Effect.fn("test.openWorkerSubscription")(function* (
  worker: MemoryWorker,
  revision: string,
) {
  const request = yield* worker.sent;
  expect(request).toMatchObject({ method: "subscribe", params: { topic: "ticks" } });
  yield* worker.feed({ jsonrpc: "2.0", id: request.id, result: null });
  yield* worker.feed({
    jsonrpc: "2.0",
    method: "event",
    params: { subscriptionId: request.params.subscriptionId, event: snapshot(revision) },
  });
  return request.params.subscriptionId;
});

const subscribeInput = (connectionId = "socket-a") => ({
  pluginId: PROBE,
  topic: "ticks",
  params: {},
  expectedVersion: "0.1.0",
  connectionId,
});

describe("PluginService", () => {
  it.effect("query refuses mutating operations and mutate refuses read-only ones", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const call = (op: string) => ({ pluginId: PROBE, operation: op, input: {} });
        expect(yield* reasonOf(service.query(call("write")))).toBe("operation-mutates");
        expect(yield* reasonOf(service.mutate(call("read")))).toBe("operation-mutates");
        expect(yield* service.query(call("read"))).toEqual({ echoed: {} });
        expect(yield* service.mutate(call("write"))).toEqual({ echoed: {} });
        expect(
          yield* reasonOf(
            service.callOperation({
              pluginId: PROBE,
              operation: "internal",
              input: {},
              caller: "agent",
            }),
          ),
        ).toBe("unknown-operation");
        expect(fake.events.filter((event) => event.startsWith("invoke"))).toEqual([
          "invoke read",
          "invoke write",
        ]);
      }),
    ),
  );

  it.effect("calls after disable fail with plugin-disabled and re-enable restores them", () =>
    withService(({ service, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const read = service.query({ pluginId: PROBE, operation: "read", input: {} });
        expect(yield* read).toEqual({ echoed: {} });
        yield* service.setEnabled(PROBE, false);
        expect(yield* reasonOf(read)).toBe("disabled");
        expect((yield* service.list).installed[0]?.status).toBe("disabled");
        expect((yield* service.agentCatalog).length).toBe(0);
        yield* service.setEnabled(PROBE, true);
        expect(yield* read).toEqual({ echoed: {} });
        expect((yield* service.list).installed[0]?.status).toBe("running");
      }),
    ),
  );

  it.effect("disable closes live subscriptions with plugin-disabled", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const events = yield* collect(service.subscribe(subscribeInput()));
        yield* openWorkerSubscription(yield* fake.worker(PROBE), "1");
        expect(yield* events.take).toEqual(snapshot("1"));
        yield* service.setEnabled(PROBE, false);
        expect(yield* events.take).toEqual({ type: "closed", reason: "plugin-disabled" });
        yield* Fiber.join(events.fiber);
      }),
    ),
  );

  it.effect(
    "subscription overflow emits resync, resubscribes the worker, drops events from the old worker subscription, and the next event is a snapshot",
    () =>
      withService(({ service, fake, installProbe }) =>
        Effect.gen(function* () {
          yield* installProbe;
          const worker = yield* fake.worker(PROBE);
          const pull = yield* service.subscribe(subscribeInput()).pipe(Stream.toPull);
          const first = yield* pull.pipe(Effect.forkChild);
          const oldId = yield* openWorkerSubscription(worker, "0");
          expect(yield* Fiber.join(first)).toEqual([snapshot("0")]);

          const event = (subscriptionId: string, value: PluginSubscriptionEvent) =>
            worker.feed({
              jsonrpc: "2.0",
              method: "event",
              params: { subscriptionId, event: value },
            });
          const fullBatch = (index: number) =>
            batch(
              Array.from({ length: 200 }, (_, item) => index * 200 + item),
              `${index}`,
            );
          // About 1.3 KB a line, so 1000 lines pass the supervisor's 1 MiB inbox bound.
          for (let index = 0; index < 1000; index += 1) yield* event(oldId, fullBatch(index));
          expect(yield* worker.sent).toMatchObject({
            method: "unsubscribe",
            params: { subscriptionId: oldId },
          });
          yield* event(oldId, fullBatch(999));

          const delivered: Array<PluginSubscriptionEvent> = [];
          while (!delivered.some((item) => item.type === "resync"))
            delivered.push(...(yield* pull));
          const resyncAt = delivered.findIndex((item) => item.type === "resync");
          expect(delivered.slice(0, resyncAt)).toEqual(
            delivered.slice(0, resyncAt).map((_, index) => fullBatch(index)),
          );

          const resubscribe = yield* worker.sent;
          expect(resubscribe).toMatchObject({ method: "subscribe", params: { topic: "ticks" } });
          const newId = resubscribe.params.subscriptionId;
          expect(newId).not.toBe(oldId);
          yield* worker.feed({ jsonrpc: "2.0", id: resubscribe.id, result: null });
          yield* event(oldId, batch(["stale"], "stale"));
          yield* event(newId, snapshot("fresh"));
          yield* event(newId, batch(["after"], "fresh-1"));
          yield* event(newId, { type: "closed", reason: "worker-failed" });

          const rest = delivered.slice(resyncAt + 1);
          while (rest.at(-1)?.type !== "closed") rest.push(...(yield* pull));
          expect(rest).toEqual([
            snapshot("fresh"),
            batch(["after"], "fresh-1"),
            { type: "closed", reason: "worker-failed" },
          ]);
        }),
      ),
  );

  it.effect("coalesces batches for 250 ms and splits ones over 200 items, keeping revisions", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const upstream = yield* Queue.unbounded<PluginSubscriptionEvent>();
        const pulls = yield* Queue.unbounded<void>();
        // A pull means the service finished handling the previous event; one pull precedes the first.
        fake.subscriptionOverride.current = Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(upstream))),
        );
        const awaitPulls = (count: number) =>
          Effect.forEach(Array.from({ length: count }), () => Queue.take(pulls), { discard: true });
        const events = yield* collect(service.subscribe(subscribeInput()));

        for (const item of [snapshot("0"), batch([1], "1"), batch([2], "2"), batch([3], "3")]) {
          yield* Queue.offer(upstream, item);
        }
        yield* awaitPulls(5);
        expect(yield* events.take).toEqual(snapshot("0"));
        yield* TestClock.adjust("250 millis");
        expect(yield* events.take).toEqual(batch([1, 2, 3], "3"));

        const large = Array.from({ length: 450 }, (_, index) => index);
        yield* Queue.offer(upstream, batch(large, "9"));
        yield* awaitPulls(1);
        expect(yield* events.take).toEqual(batch(large.slice(0, 200), "9"));
        expect(yield* events.take).toEqual(batch(large.slice(200, 400), "9"));
        yield* TestClock.adjust("250 millis");
        expect(yield* events.take).toEqual(batch(large.slice(400), "9"));
      }),
    ),
  );

  it.effect(
    "calls with a stale expectedVersion fail with version-changed without reaching the worker",
    () =>
      withService(({ service, fake, installProbe }) =>
        Effect.gen(function* () {
          yield* installProbe;
          const stale = { pluginId: PROBE, input: {}, expectedVersion: "0.0.9" };
          expect(yield* reasonOf(service.query({ ...stale, operation: "read" }))).toBe(
            "version-changed",
          );
          expect(yield* reasonOf(service.mutate({ ...stale, operation: "write" }))).toBe(
            "version-changed",
          );
          expect(
            yield* reasonOf(
              Stream.runDrain(service.subscribe({ ...subscribeInput(), expectedVersion: "0.0.9" })),
            ),
          ).toBe("version-changed");
          expect(fake.events.some((event) => event.startsWith("invoke"))).toBe(false);
        }),
      ),
  );

  it.effect("update closes live subscriptions with plugin-updated", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const events = yield* collect(service.subscribe(subscribeInput()));
        yield* openWorkerSubscription(yield* fake.worker(PROBE), "1");
        expect(yield* events.take).toEqual(snapshot("1"));

        const attachmentId = yield* uploadPackage("0.2.0");
        const updated = yield* service.update({
          pluginId: PROBE,
          attachmentId,
          trustBackendAuthor: true,
        });
        expect(yield* events.take).toEqual({ type: "closed", reason: "plugin-updated" });
        expect(updated).toMatchObject({ version: "0.2.0", status: "running" });
        expect(updated.failedUpdate).toBeUndefined();
        expect(fake.events.slice(-2)).toEqual(["stop plugin-updated", "start 0.2.0 from 0.1.0"]);
      }),
    ),
  );

  it.effect("ninth subscription from one connection fails with subscription-limit", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const worker = yield* fake.worker(PROBE);
        for (let index = 0; index < 8; index += 1) {
          yield* Stream.runDrain(service.subscribe(subscribeInput())).pipe(Effect.forkScoped);
          expect(yield* worker.sent).toMatchObject({ method: "subscribe" });
        }
        expect(yield* reasonOf(Stream.runDrain(service.subscribe(subscribeInput())))).toBe(
          "subscription-limit",
        );
        yield* Stream.runDrain(service.subscribe(subscribeInput("socket-b"))).pipe(
          Effect.forkScoped,
        );
        expect(yield* worker.sent).toMatchObject({ method: "subscribe" });
      }),
    ),
  );

  it.effect(
    "query input over maxPayloadBytes fails with too-large without reaching the worker",
    () =>
      withService(({ service, fake, installProbe }) =>
        Effect.gen(function* () {
          yield* installProbe;
          const input = { blob: "x".repeat(PLUGIN_LIMITS.maxPayloadBytes) };
          expect(
            yield* reasonOf(service.query({ pluginId: PROBE, operation: "read", input })),
          ).toBe("too-large");
          expect(fake.events.some((event) => event.startsWith("invoke"))).toBe(false);
        }),
      ),
  );

  it.effect(
    "failed update records failedUpdate and does not report the new version as running",
    () =>
      withService(({ service, fake, installProbe }) =>
        Effect.gen(function* () {
          yield* installProbe;
          fake.failingVersions.add("0.2.0");
          const attachmentId = yield* uploadPackage("0.2.0");
          yield* service.update({ pluginId: PROBE, attachmentId, trustBackendAuthor: true });
          const [record] = (yield* service.list).installed;
          expect(record).toMatchObject({
            version: "0.2.0",
            status: "failed",
            failedUpdate: {
              from: "0.1.0",
              to: "0.2.0",
              reason: "Update to 0.2.0 failed during start; data may already be migrated.",
            },
          });

          fake.failingVersions.delete("0.2.0");
          const restarted = yield* service.restart(PROBE);
          expect(restarted).toMatchObject({ version: "0.2.0", status: "running" });
          expect(restarted.failedUpdate).toBeUndefined();
        }),
      ),
  );

  it.effect("start leaves a running worker alone; restart replaces it and stop closes it", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const starts = () => fake.events.filter((event) => event.startsWith("start")).length;
        expect(starts()).toBe(1);
        yield* service.start(PROBE);
        expect(starts()).toBe(1);

        const beforeRestart = yield* collect(service.subscribe(subscribeInput()));
        yield* openWorkerSubscription(yield* fake.worker(PROBE), "1");
        expect(yield* beforeRestart.take).toEqual(snapshot("1"));
        yield* service.restart(PROBE);
        expect(starts()).toBe(2);
        expect(yield* beforeRestart.take).toEqual({ type: "closed", reason: "plugin-updated" });

        const beforeStop = yield* collect(service.subscribe(subscribeInput()));
        yield* openWorkerSubscription(yield* fake.worker(PROBE), "2");
        expect(yield* beforeStop.take).toEqual(snapshot("2"));
        yield* service.stop(PROBE);
        expect(yield* beforeStop.take).toEqual({ type: "closed", reason: "worker-failed" });
        yield* service.start(PROBE);
        expect(starts()).toBe(3);
      }),
    ),
  );

  it.effect("a lifecycle operation finishes when its caller is interrupted", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        const gate = {
          entered: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        fake.stopGate.current = gate;
        const call = yield* service.setEnabled(PROBE, false).pipe(Effect.forkChild);
        yield* Deferred.await(gate.entered);
        yield* Fiber.interrupt(call);
        yield* Deferred.succeed(gate.release, undefined);

        // Taking the lifecycle lock waits for the detached operation.
        expect(yield* reasonOf(service.start(PROBE))).toBe("disabled");
        expect(fake.events.at(-1)).toBe("stop plugin-disabled");
        expect(yield* fake.service.status(PROBE)).toEqual({ status: "stopped" });
      }),
    ),
  );

  it.effect("uninstall while running stops the worker first", () =>
    withService(({ service, fake, installProbe }) =>
      Effect.gen(function* () {
        yield* installProbe;
        yield* service.uninstall(PROBE);
        expect(fake.events.at(-1)).toBe("stop plugin-uninstalled");
        expect((yield* service.list).installed).toEqual([]);
      }),
    ),
  );
});
