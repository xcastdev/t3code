import { EventId, ProjectId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectTerminalActivityReactorService from "../orchestration/Services/ProjectTerminalActivityReactor.ts";
import * as TerminalManager from "./Manager.ts";
import type { ProjectTerminalRuntimeEvent } from "./RuntimeTypes.ts";
import { ProjectTerminalActivityReactorLive } from "./ProjectTerminalActivityReactor.ts";

const projectId = ProjectId.make("project-terminal-activity");
const threadId = ThreadId.make("thread-terminal-activity");

function makeLayer(options?: { readonly threadExists?: boolean }) {
  type Listener = (event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>;
  let listener: Listener | undefined;
  const commands = new Map<string, OrchestrationCommand>();
  const dispatches: OrchestrationCommand[] = [];
  const manager = {
    subscribeProjectEvents: (next: Listener) =>
      Effect.sync(() => {
        listener = next;
        return () => {
          listener = undefined;
        };
      }),
  } as unknown as TerminalManager.TerminalManager["Service"];
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatches.push(command);
        const key = String(command.commandId);
        if (!commands.has(key)) commands.set(key, command);
        return { sequence: commands.size };
      }),
  } as unknown as OrchestrationEngine.OrchestrationEngineShape;
  const snapshots = {
    getThreadShellById: () =>
      Effect.succeed(
        options?.threadExists === false ? Option.none() : Option.some({ threadId, projectId }),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  const layer = ProjectTerminalActivityReactorLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TerminalManager.TerminalManager, manager),
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots),
      ),
    ),
  );
  return {
    layer,
    get commands() {
      return [...commands.values()];
    },
    dispatches,
    get listener(): Listener {
      if (!listener) throw new Error("project terminal listener is not started");
      return listener;
    },
  };
}

const createdEvent = (): ProjectTerminalRuntimeEvent => ({
  type: "created",
  target: { owner: { kind: "project", projectId }, terminalId: "terminal-1" },
  generation: "generation-1",
  sequence: 1,
  creatingThreadId: threadId,
  label: "Build task",
  status: "running",
  cols: 80,
  rows: 24,
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-09-28T12:00:00.000Z",
});

describe("ProjectTerminalActivityReactor", () => {
  effectIt.effect(
    "queues bounded creation activity and keeps captured data through project cleanup",
    () => {
      const test = makeLayer();
      return Effect.scoped(
        Effect.gen(function* () {
          const reactor =
            yield* ProjectTerminalActivityReactorService.ProjectTerminalActivityReactor;
          yield* reactor.start();
          yield* test.listener(createdEvent());
          yield* test.listener({
            type: "closed",
            target: createdEvent().target,
            generation: "generation-1",
            sequence: 2,
          });
          yield* reactor.drain;
          yield* Effect.sync(() => {
            expect(test.commands).toHaveLength(1);
            expect(test.commands[0]).toMatchObject({
              type: "thread.activity.append",
              threadId,
              activity: {
                id: EventId.make(
                  `project-terminal-created:${projectId}:terminal-1:generation-1:activity`,
                ),
                kind: "terminal.project.created",
                payload: {
                  projectId,
                  terminalId: "terminal-1",
                  label: "Build task",
                  status: "running",
                },
              },
            });
            const command = test.commands[0];
            if (command?.type === "thread.activity.append") {
              expect(command.activity.payload).not.toHaveProperty("data");
            }
          });
        }),
      ).pipe(Effect.provide(test.layer));
    },
  );

  effectIt.effect(
    "uses stable IDs for duplicate runtime events and skips a deleted creator thread",
    () =>
      Effect.gen(function* () {
        const duplicate = makeLayer();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor =
              yield* ProjectTerminalActivityReactorService.ProjectTerminalActivityReactor;
            yield* reactor.start();
            yield* testEventTwice(duplicate.listener);
            yield* reactor.drain;
          }),
        ).pipe(Effect.provide(duplicate.layer));
        expect(duplicate.dispatches).toHaveLength(2);
        expect(duplicate.commands).toHaveLength(1);
        expect(duplicate.dispatches[1]).toMatchObject({
          commandId: duplicate.dispatches[0]?.commandId,
          activity: {
            id:
              duplicate.dispatches[0]?.type === "thread.activity.append"
                ? duplicate.dispatches[0].activity.id
                : "",
          },
        });

        const deleted = makeLayer({ threadExists: false });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reactor =
              yield* ProjectTerminalActivityReactorService.ProjectTerminalActivityReactor;
            yield* reactor.start();
            yield* deleted.listener(createdEvent());
            yield* reactor.drain;
          }),
        ).pipe(Effect.provide(deleted.layer));
        expect(deleted.commands).toEqual([]);
      }),
  );
});

function testEventTwice(listener: (event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>) {
  return Effect.gen(function* () {
    yield* listener(createdEvent());
    yield* listener(createdEvent());
  });
}
