import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProjectTerminalDockSummary,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectTerminalWake from "../orchestration/Services/ProjectTerminalWakeService.ts";
import * as TerminalManager from "./Manager.ts";
import {
  ProjectTerminalCompletionService,
  ProjectTerminalCompletionServiceLive,
} from "./ProjectTerminalCompletionService.ts";
import type { ProjectTerminalRuntimeEvent } from "./RuntimeTypes.ts";

const projectId = ProjectId.make("completion-test-project");
const originThreadId = ThreadId.make("completion-origin-thread");
const subscriberThreadId = ThreadId.make("completion-subscriber-thread");
const terminalId = "terminal-completion-test";
const generation = "generation-1";
const now = "2026-09-28T12:00:00.000Z";

const summary = (status: ProjectTerminalDockSummary["status"] = "running", id = terminalId) =>
  ({
    projectId,
    terminalId: id,
    creatingThreadId: originThreadId,
    label: "Build task",
    status,
    cols: 80,
    rows: 24,
    exitCode: status === "exited" ? 2 : null,
    exitSignal: null,
    updatedAt: now,
  }) satisfies ProjectTerminalDockSummary;

const exitEvent = (
  exitGeneration = generation,
  eventTerminalId = terminalId,
): ProjectTerminalRuntimeEvent => ({
  type: "exited",
  target: { owner: { kind: "project", projectId }, terminalId: eventTerminalId },
  generation: exitGeneration,
  sequence: 3,
  status: "exited",
  label: "Build task",
  creatingThreadId: originThreadId,
  updatedAt: now,
  exitCode: 2,
  exitSignal: null,
});

const closedEvent = (eventTerminalId = terminalId): ProjectTerminalRuntimeEvent => ({
  type: "closed",
  target: { owner: { kind: "project", projectId }, terminalId: eventTerminalId },
  generation,
  sequence: 4,
});

const makeHarness = (options?: {
  readonly beforeSnapshot?: (snapshotNumber: number) => Effect.Effect<void>;
  readonly beforeDispatch?: (dispatchNumber: number) => Effect.Effect<void>;
  readonly extraTerminalIds?: ReadonlyArray<string>;
  readonly status?: ProjectTerminalDockSummary["status"];
}) => {
  const commands: Array<OrchestrationCommand> = [];
  const wakeRequests: Array<ProjectTerminalWake.ProjectTerminalWakeRequest> = [];
  const order: Array<string> = [];
  let snapshotNumber = 0;
  const listeners = new Set<(event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>>();
  const terminalSnapshots = new Map(
    [terminalId, ...(options?.extraTerminalIds ?? [])].map((id) => [
      id,
      { generation, terminal: summary(options?.status, id) },
    ]),
  );
  const manager = {
    getProjectCompletionSnapshot: (input: { readonly terminalId: string }) =>
      Effect.suspend(() => {
        snapshotNumber += 1;
        return (options?.beforeSnapshot?.(snapshotNumber) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              order.push("snapshot");
              return terminalSnapshots.get(input.terminalId) ?? null;
            }),
          ),
        );
      }),
    subscribeProjectEvents: (
      listener: (event: ProjectTerminalRuntimeEvent) => Effect.Effect<void>,
    ) =>
      Effect.sync(() => {
        order.push("listen");
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
  } as unknown as TerminalManager.TerminalManager["Service"];
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.suspend(() => {
        const dispatchNumber = commands.length + 1;
        return (options?.beforeDispatch?.(dispatchNumber) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              order.push("activity");
              commands.push(command);
              return { sequence: commands.length };
            }),
          ),
        );
      }),
  } as unknown as OrchestrationEngineService["Service"];
  const snapshots = {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === originThreadId
          ? Option.some({ projectId } as OrchestrationThreadShell)
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
  const wake = {
    serverRunId: "test-server-run",
    request: (request: ProjectTerminalWake.ProjectTerminalWakeRequest) =>
      Effect.sync(() => {
        order.push("wake");
        wakeRequests.push(request);
      }),
  };
  const layer = ProjectTerminalCompletionServiceLive.pipe(
    Layer.provide(Layer.succeed(TerminalManager.TerminalManager, manager)),
    Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots)),
    Layer.provide(Layer.succeed(ProjectTerminalWake.ProjectTerminalWakeService, wake)),
  );
  const publish = (event: ProjectTerminalRuntimeEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });

  return { layer, commands, wakeRequests, order, publish };
};

const activityCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.activity.append");

describe("ProjectTerminalCompletionService", () => {
  effectIt.effect(
    "routes one subscribed completion and optional wake to the creator thread",
    () => {
      const harness = makeHarness();
      return Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ProjectTerminalCompletionService;
          yield* service.start();
          yield* service.subscribe({
            projectId,
            terminalId,
            threadId: subscriberThreadId,
            mode: "noticeAndWake",
          });
          yield* harness.publish(exitEvent());
          yield* service.drain;

          const activities = activityCommands(harness.commands);
          expect(activities).toHaveLength(1);
          expect(activities[0]).toMatchObject({
            type: "thread.activity.append",
            threadId: originThreadId,
            commandId: CommandId.make(
              `project-terminal-completed:${projectId}:${terminalId}:${generation}`,
            ),
            activity: {
              id: EventId.make(
                `project-terminal-completed:${projectId}:${terminalId}:${generation}:activity`,
              ),
              kind: "terminal.project.completed",
              payload: {
                projectId,
                terminalId,
                label: "Build task",
                status: "exited",
                exitCode: 2,
                exitSignal: null,
              },
            },
          });
          expect(harness.wakeRequests).toHaveLength(1);
          expect(harness.wakeRequests[0]).toMatchObject({
            projectId,
            terminalId,
            generation,
            threadId: originThreadId,
          });
          expect(harness.order.indexOf("listen")).toBeLessThan(harness.order.indexOf("snapshot"));
        }),
      ).pipe(Effect.provide(harness.layer));
    },
  );

  effectIt.effect(
    "preserves a queued exit through cleanup until in-flight registrations bind",
    () => {
      return Effect.gen(function* () {
        const snapshotStarted = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        const harness = makeHarness({
          beforeSnapshot: (snapshotNumber) =>
            snapshotNumber === 2
              ? Deferred.succeed(snapshotStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSnapshot)),
                )
              : Effect.void,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ProjectTerminalCompletionService;
            yield* service.start();
            yield* service.subscribe({
              projectId,
              terminalId,
              threadId: subscriberThreadId,
              mode: "notice",
            });

            const registeringWake = yield* service
              .subscribe({
                projectId,
                terminalId,
                threadId: ThreadId.make("completion-wake-subscriber"),
                mode: "noticeAndWake",
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(snapshotStarted);
            yield* harness.publish(exitEvent());
            yield* service.drain;
            expect(harness.commands).toEqual([]);
            expect(harness.wakeRequests).toEqual([]);
            yield* harness.publish(closedEvent());
            yield* service.drain;

            yield* Deferred.succeed(releaseSnapshot, undefined);
            yield* Fiber.join(registeringWake);
            yield* service.drain;
            expect(activityCommands(harness.commands)).toHaveLength(1);
            expect(harness.wakeRequests).toHaveLength(1);
          }).pipe(Effect.provide(harness.layer)),
        );
      });
    },
  );

  effectIt.effect(
    "releases a pending exit to bound subscribers when an unresolved wake is canceled",
    () =>
      Effect.gen(function* () {
        const snapshotStarted = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        const harness = makeHarness({
          beforeSnapshot: (snapshotNumber) =>
            snapshotNumber === 2
              ? Deferred.succeed(snapshotStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSnapshot)),
                )
              : Effect.void,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ProjectTerminalCompletionService;
            yield* service.start();
            yield* service.subscribe({
              projectId,
              terminalId,
              threadId: subscriberThreadId,
              mode: "notice",
            });
            const wakeThreadId = ThreadId.make("completion-unresolved-wake");
            const registeringWake = yield* service
              .subscribe({
                projectId,
                terminalId,
                threadId: wakeThreadId,
                mode: "noticeAndWake",
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(snapshotStarted);
            yield* harness.publish(exitEvent());
            yield* service.drain;
            yield* service.unsubscribe({ projectId, terminalId, threadId: wakeThreadId });
            yield* service.drain;
            expect(activityCommands(harness.commands)).toHaveLength(1);
            expect(harness.wakeRequests).toEqual([]);

            yield* Deferred.succeed(releaseSnapshot, undefined);
            yield* Fiber.join(registeringWake);
            yield* service.drain;
            expect(activityCommands(harness.commands)).toHaveLength(1);
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
  );

  effectIt.effect(
    "removes an interrupted unresolved subscription and releases pending notices",
    () =>
      Effect.gen(function* () {
        const snapshotStarted = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        const harness = makeHarness({
          beforeSnapshot: (snapshotNumber) =>
            snapshotNumber === 2
              ? Deferred.succeed(snapshotStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSnapshot)),
                )
              : Effect.void,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const service = yield* ProjectTerminalCompletionService;
            yield* service.start();
            yield* service.subscribe({
              projectId,
              terminalId,
              threadId: subscriberThreadId,
              mode: "notice",
            });
            const registeringWake = yield* service
              .subscribe({
                projectId,
                terminalId,
                threadId: ThreadId.make("completion-interrupted-wake"),
                mode: "noticeAndWake",
              })
              .pipe(Effect.forkChild);
            yield* Deferred.await(snapshotStarted);
            yield* harness.publish(exitEvent());
            yield* service.drain;
            yield* Fiber.interrupt(registeringWake);
            yield* service.drain;
            expect(activityCommands(harness.commands)).toHaveLength(1);
            expect(harness.wakeRequests).toEqual([]);
          }),
        ).pipe(Effect.provide(harness.layer));
      }),
  );

  effectIt.effect("updates mode per subscribing thread and delivers a late exit once", () => {
    const harness = makeHarness({ status: "exited" });
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ProjectTerminalCompletionService;
        yield* service.start();
        const input = {
          projectId,
          terminalId,
          threadId: subscriberThreadId,
          mode: "notice" as const,
        };
        yield* service.subscribe(input);
        yield* service.subscribe({ ...input, mode: "noticeAndWake" });
        yield* service.drain;
        yield* service.subscribe({ ...input, mode: "noticeAndWake" });
        yield* harness.publish(exitEvent());
        yield* service.drain;

        expect(activityCommands(harness.commands)).toHaveLength(1);
        expect(harness.wakeRequests).toHaveLength(1);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  effectIt.effect("does not create completion activity without a subscription", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ProjectTerminalCompletionService;
        yield* service.start();
        yield* harness.publish(exitEvent());
        yield* service.drain;
        expect(harness.commands).toEqual([]);
        expect(harness.wakeRequests).toEqual([]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  effectIt.effect("honors unsubscribe before a queued generation reaches its claim point", () =>
    Effect.gen(function* () {
      const dispatchStarted = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const otherTerminalId = "terminal-completion-queued";
      const harness = makeHarness({
        extraTerminalIds: [otherTerminalId],
        beforeDispatch: (dispatchNumber) =>
          dispatchNumber === 1
            ? Deferred.succeed(dispatchStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseDispatch)),
              )
            : Effect.void,
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ProjectTerminalCompletionService;
          yield* service.start();
          yield* service.subscribe({
            projectId,
            terminalId,
            threadId: subscriberThreadId,
            mode: "notice",
          });
          yield* service.subscribe({
            projectId,
            terminalId: otherTerminalId,
            threadId: ThreadId.make("queued-subscriber"),
            mode: "noticeAndWake",
          });
          yield* harness.publish(exitEvent(generation, terminalId));
          yield* Deferred.await(dispatchStarted);
          yield* harness.publish(exitEvent(generation, otherTerminalId));
          yield* service.unsubscribe({
            projectId,
            terminalId: otherTerminalId,
            threadId: ThreadId.make("queued-subscriber"),
          });
          yield* Deferred.succeed(releaseDispatch, undefined);
          yield* service.drain;

          expect(activityCommands(harness.commands)).toHaveLength(1);
          expect(harness.wakeRequests).toEqual([]);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );

  effectIt.effect("does not retract a notice or wake after the worker claim", () =>
    Effect.gen(function* () {
      const dispatchStarted = yield* Deferred.make<void>();
      const releaseDispatch = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeDispatch: () =>
          Deferred.succeed(dispatchStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseDispatch)),
          ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ProjectTerminalCompletionService;
          yield* service.start();
          yield* service.subscribe({
            projectId,
            terminalId,
            threadId: subscriberThreadId,
            mode: "noticeAndWake",
          });
          yield* harness.publish(exitEvent());
          yield* Deferred.await(dispatchStarted);
          yield* service.unsubscribe({ projectId, terminalId, threadId: subscriberThreadId });
          yield* Deferred.succeed(releaseDispatch, undefined);
          yield* service.drain;
          expect(activityCommands(harness.commands)).toHaveLength(1);
          expect(harness.wakeRequests).toHaveLength(1);
        }),
      ).pipe(Effect.provide(harness.layer));
    }),
  );

  effectIt.effect("caps subscribers at 32 threads for one terminal", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ProjectTerminalCompletionService;
        for (let index = 0; index < 32; index += 1) {
          yield* service.subscribe({
            projectId,
            terminalId,
            threadId: ThreadId.make(`completion-subscriber-${index}`),
            mode: "notice",
          });
        }
        const overLimit = yield* Effect.result(
          service.subscribe({
            projectId,
            terminalId,
            threadId: ThreadId.make("completion-subscriber-over-limit"),
            mode: "notice",
          }),
        );
        expect(overLimit._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  effectIt.effect("clears subscriptions after cleanup without fabricating completion", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const service = yield* ProjectTerminalCompletionService;
        yield* service.start();
        yield* service.subscribe({
          projectId,
          terminalId,
          threadId: subscriberThreadId,
          mode: "noticeAndWake",
        });
        yield* harness.publish(closedEvent());
        yield* harness.publish(exitEvent());
        yield* service.drain;
        expect(harness.commands).toEqual([]);
        expect(harness.wakeRequests).toEqual([]);
      }),
    ).pipe(Effect.provide(harness.layer));
  });
});
