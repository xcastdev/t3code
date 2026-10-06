import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EventId, ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ServerSecrets from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { ProjectWorkEventBus, ProjectWorkEventBusLive } from "./ProjectWorkEventBus.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { makeProjectWorkVerificationExecutionWorker } from "./ProjectWorkVerificationExecutionRuntime.ts";

const services = Layer.mergeAll(
  Settings.layer.pipe(
    Layer.provide(ServerSecrets.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3-verification-wake-" })),
    ),
  ),
  ProjectWorkEventBusLive,
  Layer.effect(ProjectTeamPiRuntime, makeProjectTeamPiRuntime()),
);
it.effect(
  "reconciles each generation before event-driven discovery and joins settings shutdown",
  () =>
    Effect.gen(function* () {
      const settings = yield* Settings.ServerSettingsService;
      const bus = yield* ProjectWorkEventBus;
      const calls = yield* Queue.unbounded<string>();
      yield* settings.updateSettings({
        projectWorkEnabled: true,
        projectTeamExecutionEnabled: true,
      });
      let generations = 0;
      const worker = yield* makeProjectWorkVerificationExecutionWorker(
        Effect.sync(() => {
          const generation = ++generations;
          return {
            ready: Queue.offer(calls, "recovery:" + generation).pipe(Effect.asVoid),
            sweep: Queue.offer(calls, "sweep:" + generation).pipe(Effect.asVoid),
            stop: Queue.offer(calls, "stop:" + generation).pipe(Effect.asVoid),
          };
        }),
      );
      yield* worker.ready;
      expect(yield* Queue.take(calls)).toBe("recovery:1");
      expect(yield* Queue.take(calls)).toBe("sweep:1");
      yield* bus.publish([
        {
          cursor: 1,
          event: {
            type: "project-work.task.ready",
            eventId: EventId.make("verification-wake"),
            projectId: ProjectId.make("project"),
            revision: 1,
            occurredAt: "2026-10-06T12:00:00.000Z",
            taskId: ProjectWorkTaskId.make("task"),
          },
        },
      ]);
      yield* worker.observed(1);
      expect(yield* Queue.take(calls)).toBe("sweep:1");
      yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
      expect(yield* Queue.take(calls)).toBe("stop:1");
      expect((yield* worker.drain()).status).toBe("disabled");
      yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
      expect(yield* Queue.take(calls)).toBe("recovery:2");
      expect(yield* Queue.take(calls)).toBe("sweep:2");
      yield* worker.stop;
      expect(yield* Queue.take(calls)).toBe("stop:2");
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(NodeServices.layer))), Effect.scoped),
);
