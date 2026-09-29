import { CommandId, EventId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TerminalManager from "./Manager.ts";
import type { ProjectTerminalRuntimeEvent } from "./RuntimeTypes.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProjectTerminalActivityReactor,
  type ProjectTerminalActivityReactorShape,
} from "../orchestration/Services/ProjectTerminalActivityReactor.ts";

type CreatedProjectTerminalEvent = Extract<ProjectTerminalRuntimeEvent, { type: "created" }>;

const make = Effect.gen(function* () {
  const terminalManager = yield* TerminalManager.TerminalManager;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const appendCreatedActivity = Effect.fn("ProjectTerminalActivityReactor.appendCreatedActivity")(
    function* (event: CreatedProjectTerminalEvent) {
      if (event.target.owner.kind !== "project") return;
      const threadId = ThreadId.make(event.creatingThreadId);
      const thread = yield* snapshots.getThreadShellById(threadId);
      if (Option.isNone(thread) || thread.value.projectId !== event.target.owner.projectId) return;

      const stableId = [
        "project-terminal-created",
        event.target.owner.projectId,
        event.target.terminalId,
        event.generation,
      ].join(":");
      const command: OrchestrationCommand = {
        type: "thread.activity.append",
        commandId: CommandId.make(stableId),
        threadId,
        createdAt: event.updatedAt,
        activity: {
          id: EventId.make(`${stableId}:activity`),
          tone: "info",
          kind: "terminal.project.created",
          summary: `Project terminal started: ${event.label}`,
          payload: {
            projectId: event.target.owner.projectId,
            terminalId: event.target.terminalId,
            label: event.label,
            status: event.status,
          },
          turnId: null,
          createdAt: event.updatedAt,
        },
      };
      yield* engine.dispatch(command);
    },
  );

  const processSafely = (event: CreatedProjectTerminalEvent) =>
    appendCreatedActivity(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("project terminal creation activity failed", {
          projectId: event.target.owner.kind === "project" ? event.target.owner.projectId : null,
          terminalId: event.target.terminalId,
          generation: event.generation,
          cause: Cause.pretty(cause),
        });
      }),
    );
  const worker = yield* makeDrainableWorker(processSafely);

  const start: ProjectTerminalActivityReactorShape["start"] = Effect.fn(
    "ProjectTerminalActivityReactor.start",
  )(function* () {
    const unsubscribe = yield* terminalManager.subscribeProjectEvents((event) =>
      event.type === "created" ? worker.enqueue(event).pipe(Effect.asVoid) : Effect.void,
    );
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  });

  const drain: ProjectTerminalActivityReactorShape["drain"] = worker.drain;
  return { start, drain } satisfies ProjectTerminalActivityReactorShape;
});

export const ProjectTerminalActivityReactorLive = Layer.effect(
  ProjectTerminalActivityReactor,
  make,
);
