import {
  CommandId,
  CorrelationId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  TerminalToolError,
  ThreadId,
  type OrchestrationEvent,
  type ProjectTerminalCreateInput,
  type ProjectTerminalSummary,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ProjectionSnapshotQuery from "../Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationEngine from "../Services/OrchestrationEngine.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { ServerActivation } from "../../serverActivation.ts";
import {
  ProjectTerminalService,
  ProjectTerminalServiceLive,
  type ProjectTerminalServiceShape,
} from "../../terminal/ProjectTerminalService.ts";
import { ProjectTerminalReactor } from "../Services/ProjectTerminalReactor.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import { ProjectTerminalReactorLive } from "./ProjectTerminalReactor.ts";

const projectId = ProjectId.make("project-terminal-reaction");
const threadId = ThreadId.make("thread-terminal-reaction");
const now = "2026-09-28T00:00:00.000Z";

const deletedEvent = (sequence: number): OrchestrationEvent => ({
  sequence,
  eventId: EventId.make(`project-terminal-deleted-${sequence}`),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.deleted",
  occurredAt: now,
  commandId: CommandId.make(`project-terminal-delete-${sequence}`),
  causationEventId: null,
  correlationId: CorrelationId.make(`project-terminal-delete-${sequence}`),
  metadata: {},
  payload: { projectId, deletedAt: now },
});

effectIt.effect(
  "serializes project deletion with an in-flight spawn and publishes a drainable cleanup receipt",
  () =>
    Effect.gen(function* () {
      const projectActive = yield* Ref.make(true);
      const spawnEntered = yield* Deferred.make<void>();
      const releaseSpawn = yield* Deferred.make<void>();
      const releaseDeletionEvent = yield* Deferred.make<OrchestrationEvent>();
      const eventSubscriptionReady = yield* Deferred.make<void>();
      const receiptSubscriptionReady = yield* Deferred.make<void>();
      const receiptObserved = yield* Deferred.make<unknown>();
      const spawnedProcesses = new Map<string, ProjectTerminalSummary>();
      const retainedHistories = new Set<string>();
      const closeCalls: Array<ProjectId> = [];
      const projectShell = {
        id: projectId,
        title: "Project",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      };
      const threads = new Map([[threadId, { id: threadId, projectId }]]);

      const manager = {
        createProject: (input: ProjectTerminalCreateInput) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(spawnEntered, undefined);
            yield* Deferred.await(releaseSpawn);
            const summary: ProjectTerminalSummary = {
              projectId: input.projectId,
              terminalId: input.terminalId,
              title: input.title ?? null,
              command: input.command ?? null,
              args: input.args ?? [],
              cwd: input.cwd,
              creatingThreadId: input.creatingThreadId,
              label: input.title ?? input.command ?? "Terminal",
              status: "running",
              pid: 99123,
              exitCode: null,
              exitSignal: null,
              updatedAt: now,
            };
            spawnedProcesses.set(summary.terminalId, summary);
            retainedHistories.add(summary.terminalId);
            return summary;
          }),
        listProject: () => Effect.succeed([...spawnedProcesses.values()]),
        writeProject: () => Effect.void,
        resizeProject: () => Effect.void,
        killProjectTerminal: () => Effect.void,
        closeProject: (id: ProjectId) =>
          Effect.sync(() => {
            closeCalls.push(id);
            spawnedProcesses.clear();
            retainedHistories.clear();
          }),
        subscribeProjectEvents: () => Effect.succeed(() => undefined),
      } as unknown as TerminalManager.TerminalManager["Service"];

      const snapshots = {
        getThreadShellById: (id: ThreadId) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
        getProjectShellById: (id: ProjectId) =>
          Ref.get(projectActive).pipe(
            Effect.map((isActive) =>
              isActive && id === projectId ? Option.some(projectShell) : Option.none(),
            ),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQueryShape;
      const engine = {
        latestSequence: Effect.succeed(0),
        subscribeDomainEvents: Deferred.succeed(eventSubscriptionReady, undefined).pipe(
          Effect.as(Stream.fromEffect(Deferred.await(releaseDeletionEvent))),
        ),
        streamDomainEvents: Stream.fromEffect(Deferred.await(releaseDeletionEvent)).pipe(
          Stream.onStart(Deferred.succeed(eventSubscriptionReady, undefined)),
        ),
      } as unknown as OrchestrationEngine.OrchestrationEngineShape;
      const crypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(7),
        digest: (_algorithm, data) => Effect.succeed(data),
      });
      const serviceLayer = ProjectTerminalServiceLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TerminalManager.TerminalManager, manager),
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots),
            Layer.succeed(Crypto.Crypto, crypto),
          ),
        ),
      );
      const layer = ProjectTerminalReactorLive.pipe(
        Layer.provideMerge(serviceLayer),
        Layer.provideMerge(RuntimeReceiptBusTest),
        Layer.provide(Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* ProjectTerminalService;
          const reactor = yield* ProjectTerminalReactor;
          const receiptBus = yield* RuntimeReceiptBus;

          yield* receiptBus.streamEventsForTest.pipe(
            Stream.onStart(Deferred.succeed(receiptSubscriptionReady, undefined)),
            Stream.runForEach((receipt) =>
              receipt.type === "project.terminals.closed"
                ? Deferred.succeed(receiptObserved, receipt).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(receiptSubscriptionReady);

          yield* reactor.start();
          yield* Deferred.await(eventSubscriptionReady);

          const spawn = yield* Effect.forkChild(
            service.spawn({ title: "spawn racing deletion" }).pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("environment-terminal-reaction"),
                threadId,
                providerSessionId: "provider-session-terminal-reaction",
                providerInstanceId: ProviderInstanceId.make("codex"),
                capabilities: new Set<McpInvocationContext.McpCapability>(["terminal"]),
                issuedAt: 1,
              }),
            ),
          );
          yield* Deferred.await(spawnEntered);

          // This models the projection transaction commit that precedes event publication.
          yield* Ref.set(projectActive, false);
          yield* Deferred.succeed(releaseDeletionEvent, deletedEvent(42));
          const drain = yield* Effect.forkChild(reactor.drainThrough(42));

          yield* Deferred.succeed(releaseSpawn, undefined);
          const spawned = yield* Fiber.join(spawn);
          yield* Fiber.join(drain);
          const receipt = yield* Deferred.await(receiptObserved);

          expect(spawned.projectId).toBe(projectId);
          expect(closeCalls).toEqual([projectId]);
          expect(spawnedProcesses.size).toBe(0);
          expect(retainedHistories.size).toBe(0);
          expect(receipt).toMatchObject({
            type: "project.terminals.closed",
            projectId,
            sequence: 42,
          });
        }),
      ).pipe(Effect.provide(layer));
    }),
);

effectIt.effect("project deletion cleanup works without any remaining project thread", () =>
  Effect.gen(function* () {
    const closed: Array<ProjectId> = [];
    const engine = {
      latestSequence: Effect.succeed(0),
      subscribeDomainEvents: Effect.succeed(Stream.make(deletedEvent(9))),
      streamDomainEvents: Stream.make(deletedEvent(9)),
    } as unknown as OrchestrationEngine.OrchestrationEngineShape;
    const service = {
      closeProject: (id: ProjectId) =>
        Effect.sync(() => {
          closed.push(id);
        }),
    } as unknown as ProjectTerminalServiceShape;
    const reactorLayer = ProjectTerminalReactorLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectTerminalService, service),
          Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
          RuntimeReceiptBusTest,
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* ProjectTerminalReactor;
        yield* reactor.start();
        yield* reactor.drainThrough(9);
        expect(closed).toEqual([projectId]);
      }),
    ).pipe(Effect.provide(reactorLayer));
  }),
);

effectIt.effect("subscribes before parking its consumer during startup", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const activation = yield* Deferred.make<void>();
    const eventPulled = yield* Deferred.make<void>();
    const releaseEventToConsumer = yield* Deferred.make<void>();
    const drainCompleted = yield* Deferred.make<void>();
    const latestSequence = yield* Ref.make(0);
    const closed: Array<ProjectId> = [];
    const published: Array<unknown> = [];
    const committedDeletion = deletedEvent(11);
    const engine = {
      latestSequence: Ref.get(latestSequence),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) =>
          Stream.fromSubscription(subscription).pipe(
            Stream.tap(() =>
              Deferred.succeed(eventPulled, undefined).pipe(
                Effect.andThen(Deferred.await(releaseEventToConsumer)),
              ),
            ),
          ),
        ),
      ),
      get streamDomainEvents() {
        return Stream.fromPubSub(events);
      },
    } as unknown as OrchestrationEngine.OrchestrationEngineShape;
    const service = {
      closeProject: (id: ProjectId) =>
        Effect.sync(() => {
          closed.push(id);
        }),
    } as unknown as ProjectTerminalServiceShape;
    const reactorLayer = ProjectTerminalReactorLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectTerminalService, service),
          Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
          Layer.succeed(RuntimeReceiptBus, {
            publish: (receipt) =>
              Effect.sync(() => {
                published.push(receipt);
              }),
            streamEventsForTest: Stream.empty,
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* ProjectTerminalReactor;
        yield* reactor
          .start()
          .pipe(Effect.provideService(ServerActivation, Deferred.await(activation)));

        // Commit and publish while the reactor consumer is parked at startup.
        yield* Ref.set(latestSequence, committedDeletion.sequence);
        yield* PubSub.publish(events, committedDeletion);
        const drain = yield* Effect.forkChild(
          reactor
            .drainThrough(committedDeletion.sequence)
            .pipe(Effect.andThen(Deferred.succeed(drainCompleted, undefined))),
        );
        yield* Deferred.succeed(activation, undefined);
        yield* Deferred.await(eventPulled);
        yield* Effect.yieldNow;
        const drainResult = yield* Deferred.poll(drainCompleted);
        expect(Option.isNone(drainResult)).toBe(true);
        yield* Deferred.succeed(releaseEventToConsumer, undefined);
        yield* Fiber.join(drain);

        expect(closed).toEqual([projectId]);
        expect(published).toEqual([
          {
            type: "project.terminals.closed",
            projectId,
            sequence: committedDeletion.sequence,
          },
        ]);
      }),
    ).pipe(Effect.provide(reactorLayer));
  }),
);

effectIt.effect("failed cleanup does not publish a receipt or report a successful drain", () =>
  Effect.gen(function* () {
    const published: Array<unknown> = [];
    const engine = {
      latestSequence: Effect.succeed(0),
      subscribeDomainEvents: Effect.succeed(Stream.make(deletedEvent(10))),
      streamDomainEvents: Stream.make(deletedEvent(10)),
    } as unknown as OrchestrationEngine.OrchestrationEngineShape;
    const service = {
      closeProject: () =>
        Effect.fail(
          new TerminalToolError({
            operation: "close",
            reason: "kill-failed",
            projectId,
          }),
        ),
    } as unknown as ProjectTerminalServiceShape;
    const reactorLayer = ProjectTerminalReactorLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectTerminalService, service),
          Layer.succeed(OrchestrationEngine.OrchestrationEngineService, engine),
          Layer.succeed(RuntimeReceiptBus, {
            publish: (receipt) =>
              Effect.sync(() => {
                published.push(receipt);
              }),
            streamEventsForTest: Stream.empty,
          }),
        ),
      ),
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        const reactor = yield* ProjectTerminalReactor;
        yield* reactor.start();
        const drain = yield* reactor.drainThrough(10).pipe(Effect.exit);
        expect(Exit.isFailure(drain)).toBe(true);
        expect(published).toEqual([]);
      }),
    ).pipe(Effect.provide(reactorLayer));
  }),
);
