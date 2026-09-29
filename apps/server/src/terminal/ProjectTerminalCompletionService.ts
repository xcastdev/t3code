import {
  CommandId,
  EventId,
  ProjectId,
  TerminalToolError,
  ThreadId,
  type ProjectTerminalCompletionMode,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectTerminalWake from "../orchestration/Services/ProjectTerminalWakeService.ts";
import * as TerminalManager from "./Manager.ts";
import type { ProjectTerminalRuntimeEvent } from "./RuntimeTypes.ts";

const MAX_SUBSCRIBERS_PER_TERMINAL = 32;
const MAX_DELIVERED_GENERATIONS = 256;

export interface ProjectTerminalCompletionSubscriptionInput {
  readonly projectId: ProjectId;
  readonly terminalId: string;
  readonly threadId: ThreadId;
  readonly mode: ProjectTerminalCompletionMode;
}

export interface ProjectTerminalCompletionServiceShape {
  readonly subscribe: (
    input: ProjectTerminalCompletionSubscriptionInput,
  ) => Effect.Effect<void, TerminalToolError>;
  readonly unsubscribe: (
    input: Pick<
      ProjectTerminalCompletionSubscriptionInput,
      "projectId" | "terminalId" | "threadId"
    >,
  ) => Effect.Effect<void>;
  readonly closeProject: (projectId: ProjectId) => Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ProjectTerminalCompletionService extends Context.Service<
  ProjectTerminalCompletionService,
  ProjectTerminalCompletionServiceShape
>()("t3/terminal/ProjectTerminalCompletionService") {}

type ExitedProjectTerminalEvent = Extract<ProjectTerminalRuntimeEvent, { type: "exited" }>;
type ClosedProjectTerminalEvent = Extract<ProjectTerminalRuntimeEvent, { type: "closed" }>;

type CompletionWork =
  | { readonly type: "exited"; readonly observation: CompletionObservation }
  | { readonly type: "closed"; readonly event: ClosedProjectTerminalEvent };

interface CompletionObservation {
  readonly projectId: ProjectId;
  readonly terminalId: string;
  readonly generation: string;
  readonly label: string;
  readonly creatingThreadId: ThreadId;
  readonly status: "exited" | "killed";
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly updatedAt: string;
}

interface CompletionSubscription {
  readonly token: object;
  readonly projectId: ProjectId;
  readonly terminalId: string;
  readonly threadId: ThreadId;
  readonly generation: string | null;
  readonly mode: ProjectTerminalCompletionMode;
}

interface PendingObservation {
  readonly projectId: ProjectId;
  readonly terminalId: string;
  readonly byGeneration: ReadonlyMap<string, CompletionObservation>;
}

interface CompletionState {
  readonly subscriptions: ReadonlyMap<string, CompletionSubscription>;
  readonly pending: ReadonlyMap<string, PendingObservation>;
  readonly delivered: ReadonlyMap<string, ProjectId>;
  readonly deliveredOrder: ReadonlyArray<string>;
}

const tupleKey = (...parts: ReadonlyArray<string>) =>
  parts.map((part) => `${part.length}:${part}`).join("");

const handleKey = (projectId: ProjectId, terminalId: string) => tupleKey(projectId, terminalId);

const subscriberKey = (projectId: ProjectId, terminalId: string, threadId: ThreadId) =>
  tupleKey(projectId, terminalId, String(threadId));

const generationKey = (projectId: ProjectId, terminalId: string, generation: string) =>
  tupleKey(projectId, terminalId, generation);

const fromEvent = (event: ExitedProjectTerminalEvent): CompletionObservation => ({
  projectId: ProjectId.make(
    event.target.owner.kind === "project" ? event.target.owner.projectId : "",
  ),
  terminalId: event.target.terminalId,
  generation: event.generation,
  label: event.label,
  creatingThreadId: ThreadId.make(event.creatingThreadId),
  status: event.status,
  exitCode: event.exitCode,
  exitSignal: event.exitSignal,
  updatedAt: event.updatedAt,
});

const unavailable = (
  operation: "subscribeCompletion" | "unsubscribeCompletion",
  input: {
    readonly projectId: ProjectId;
    readonly terminalId: string;
  },
) => new TerminalToolError({ operation, reason: "unavailable", ...input });

const make = Effect.gen(function* () {
  const manager = yield* TerminalManager.TerminalManager;
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const wakeService = yield* ProjectTerminalWake.ProjectTerminalWakeService;
  const state = yield* SynchronizedRef.make<CompletionState>({
    subscriptions: new Map(),
    pending: new Map(),
    delivered: new Map(),
    deliveredOrder: [],
  });

  const addDelivered = (current: CompletionState, key: string, projectId: ProjectId) => {
    const delivered = new Map(current.delivered);
    const deliveredOrder = [...current.deliveredOrder];
    if (!delivered.has(key)) deliveredOrder.push(key);
    delivered.set(key, projectId);
    while (deliveredOrder.length > MAX_DELIVERED_GENERATIONS) {
      const oldest = deliveredOrder.shift();
      if (oldest !== undefined) delivered.delete(oldest);
    }
    return { delivered, deliveredOrder };
  };

  const releasePendingForHandle = (
    current: CompletionState,
    projectId: ProjectId,
    terminalId: string,
  ): readonly [ReadonlyArray<CompletionObservation>, CompletionState] => {
    const pendingKey = handleKey(projectId, terminalId);
    const pendingEntry = current.pending.get(pendingKey);
    if (!pendingEntry) return [[], current] as const;
    const matchingSubscriptions = [...current.subscriptions.values()].filter(
      (subscription) =>
        subscription.projectId === projectId && subscription.terminalId === terminalId,
    );
    if (matchingSubscriptions.some((subscription) => subscription.generation === null)) {
      return [[], current] as const;
    }
    const generations = new Set(
      matchingSubscriptions
        .map((subscription) => subscription.generation)
        .filter((generation): generation is string => generation !== null),
    );
    const observations = [...pendingEntry.byGeneration].flatMap(([generation, observation]) =>
      generations.has(generation) &&
      !current.delivered.has(generationKey(projectId, terminalId, generation))
        ? [observation]
        : [],
    );
    const pending = new Map(current.pending);
    pending.delete(pendingKey);
    return [observations, { ...current, pending }] as const;
  };

  const enqueueObservations = (observations: ReadonlyArray<CompletionObservation>) =>
    Effect.forEach(observations, (observation) => worker.enqueue({ type: "exited", observation }), {
      concurrency: 1,
      discard: true,
    });

  const dispatchCompletion = Effect.fn("ProjectTerminalCompletionService.dispatchCompletion")(
    function* (observation: CompletionObservation, shouldWake: boolean) {
      const thread = yield* snapshots.getThreadShellById(observation.creatingThreadId);
      if (Option.isNone(thread) || thread.value.projectId !== observation.projectId) return;

      const stableId = [
        "project-terminal-completed",
        observation.projectId,
        observation.terminalId,
        observation.generation,
      ].join(":");
      const commandId = CommandId.make(stableId);
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId,
        threadId: observation.creatingThreadId,
        createdAt: observation.updatedAt,
        activity: {
          id: EventId.make(`${stableId}:activity`),
          tone: observation.status === "exited" && observation.exitCode !== 0 ? "error" : "info",
          kind: "terminal.project.completed",
          summary: `Project terminal finished: ${observation.label}`,
          payload: {
            projectId: observation.projectId,
            terminalId: observation.terminalId,
            label: observation.label,
            status: observation.status,
            exitCode: observation.exitCode,
            exitSignal: observation.exitSignal,
          },
          turnId: null,
          createdAt: observation.updatedAt,
        },
      });

      if (shouldWake) {
        yield* wakeService.request({
          projectId: observation.projectId,
          terminalId: observation.terminalId,
          generation: observation.generation,
          threadId: observation.creatingThreadId,
          label: observation.label,
          status: observation.status,
          exitCode: observation.exitCode,
          exitSignal: observation.exitSignal,
        });
      }
    },
  );

  const claimAndDispatch = Effect.fn("ProjectTerminalCompletionService.claimAndDispatch")(
    function* (observation: CompletionObservation) {
      const key = generationKey(
        observation.projectId,
        observation.terminalId,
        observation.generation,
      );
      const claim = yield* SynchronizedRef.modify(
        state,
        (
          current,
        ): readonly [
          { readonly claimed: boolean; readonly shouldWake: boolean },
          CompletionState,
        ] => {
          if (current.delivered.has(key)) {
            const subscriptions = new Map(current.subscriptions);
            for (const [subscriptionKey, subscription] of subscriptions) {
              if (
                subscription.projectId === observation.projectId &&
                subscription.terminalId === observation.terminalId &&
                subscription.generation === observation.generation
              ) {
                subscriptions.delete(subscriptionKey);
              }
            }
            return [
              { claimed: false, shouldWake: false },
              { ...current, subscriptions },
            ] as const;
          }
          const subscriptions = new Map(current.subscriptions);
          const pending = new Map(current.pending);
          const matched: CompletionSubscription[] = [];
          let hasUnbound = false;
          for (const [key, subscription] of subscriptions) {
            if (
              subscription.projectId !== observation.projectId ||
              subscription.terminalId !== observation.terminalId
            ) {
              continue;
            }
            if (subscription.generation === null) {
              hasUnbound = true;
              continue;
            }
            if (subscription.generation !== observation.generation) continue;
            subscriptions.delete(key);
            matched.push(subscription);
          }
          if (hasUnbound) {
            const pendingKey = handleKey(observation.projectId, observation.terminalId);
            const existing = pending.get(pendingKey);
            const byGeneration = new Map(existing?.byGeneration ?? []);
            byGeneration.set(observation.generation, observation);
            pending.set(pendingKey, {
              projectId: observation.projectId,
              terminalId: observation.terminalId,
              byGeneration,
            });
            return [
              { claimed: false, shouldWake: false },
              { ...current, pending },
            ] as const;
          }
          if (matched.length === 0) {
            return [
              { claimed: false, shouldWake: false },
              { ...current, subscriptions, pending },
            ] as const;
          }
          pending.delete(handleKey(observation.projectId, observation.terminalId));
          const next = addDelivered(
            { ...current, subscriptions, pending },
            key,
            observation.projectId,
          );
          return [
            {
              claimed: true,
              shouldWake: matched.some((subscription) => subscription.mode === "noticeAndWake"),
            },
            { ...current, subscriptions, pending, ...next },
          ] as const;
        },
      );
      if (claim.claimed) yield* dispatchCompletion(observation, claim.shouldWake);
    },
  );

  const processWork = (work: CompletionWork) => {
    if (work.type === "exited") return claimAndDispatch(work.observation);
    const event = work.event;
    if (event.target.owner.kind !== "project") return Effect.void;
    const projectId = event.target.owner.projectId;
    const terminalId = event.target.terminalId;
    return SynchronizedRef.update(state, (current) => {
      const pendingKey = handleKey(projectId, terminalId);
      const hasObservedExit =
        current.pending.get(pendingKey)?.byGeneration.has(event.generation) ?? false;
      const subscriptions = new Map(
        [...current.subscriptions].filter(
          ([, subscription]) =>
            subscription.projectId !== projectId ||
            subscription.terminalId !== terminalId ||
            subscription.generation === null ||
            subscription.generation !== event.generation ||
            hasObservedExit,
        ),
      );
      return { ...current, subscriptions };
    });
  };

  const processSafely = (work: CompletionWork) =>
    processWork(work).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("project terminal completion dispatch failed", {
          workType: work.type,
          cause: Cause.pretty(cause),
        });
      }),
    );
  const worker = yield* makeDrainableWorker(processSafely);

  const removeRegistration = (key: string, token: object) =>
    Effect.uninterruptible(
      SynchronizedRef.modify(
        state,
        (current): readonly [ReadonlyArray<CompletionObservation>, CompletionState] => {
          const existing = current.subscriptions.get(key);
          if (!existing || existing.token !== token) return [[], current] as const;
          const subscriptions = new Map(current.subscriptions);
          subscriptions.delete(key);
          return releasePendingForHandle(
            { ...current, subscriptions },
            existing.projectId,
            existing.terminalId,
          );
        },
      ).pipe(Effect.flatMap(enqueueObservations)),
    );

  const subscribe: ProjectTerminalCompletionServiceShape["subscribe"] = (input) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const key = subscriberKey(input.projectId, input.terminalId, input.threadId);
        const token = {};
        const registered = yield* SynchronizedRef.modify(state, (current) => {
          const existing = current.subscriptions.get(key);
          if (!existing) {
            const count = [...current.subscriptions.values()].filter(
              (subscription) =>
                subscription.projectId === input.projectId &&
                subscription.terminalId === input.terminalId,
            ).length;
            if (count >= MAX_SUBSCRIBERS_PER_TERMINAL) return [false, current] as const;
          }
          const subscriptions = new Map(current.subscriptions);
          subscriptions.set(key, {
            token,
            projectId: input.projectId,
            terminalId: input.terminalId,
            threadId: input.threadId,
            generation: existing?.generation ?? null,
            mode: input.mode,
          });
          return [true, { ...current, subscriptions }] as const;
        });
        if (!registered) {
          return yield* new TerminalToolError({
            operation: "subscribeCompletion",
            reason: "subscription-limit",
            projectId: input.projectId,
            terminalId: input.terminalId,
          });
        }

        const snapshot = yield* restore(manager.getProjectCompletionSnapshot(input)).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) ? Effect.void : removeRegistration(key, token),
          ),
        );
        if (!snapshot) {
          yield* removeRegistration(key, token);
          return yield* unavailable("subscribeCompletion", input);
        }

        const pending = yield* SynchronizedRef.modify(
          state,
          (current): readonly [ReadonlyArray<CompletionObservation>, CompletionState] => {
            const existing = current.subscriptions.get(key);
            if (!existing || existing.token !== token) return [[], current] as const;
            const subscriptions = new Map(current.subscriptions);
            const keyForGeneration = generationKey(
              input.projectId,
              input.terminalId,
              snapshot.generation,
            );
            if (current.delivered.has(keyForGeneration)) {
              subscriptions.delete(key);
              return releasePendingForHandle(
                { ...current, subscriptions },
                input.projectId,
                input.terminalId,
              );
            }
            subscriptions.set(key, { ...existing, generation: snapshot.generation });
            return releasePendingForHandle(
              { ...current, subscriptions },
              input.projectId,
              input.terminalId,
            );
          },
        );
        yield* enqueueObservations(pending);

        if (snapshot.terminal.status === "exited" || snapshot.terminal.status === "killed") {
          yield* worker.enqueue({
            type: "exited",
            observation: {
              projectId: input.projectId,
              terminalId: input.terminalId,
              generation: snapshot.generation,
              label: snapshot.terminal.label,
              creatingThreadId: snapshot.terminal.creatingThreadId,
              status: snapshot.terminal.status,
              exitCode: snapshot.terminal.exitCode,
              exitSignal: snapshot.terminal.exitSignal,
              updatedAt: snapshot.terminal.updatedAt,
            },
          });
        }
      }),
    );

  const unsubscribe: ProjectTerminalCompletionServiceShape["unsubscribe"] = (input) =>
    Effect.uninterruptible(
      SynchronizedRef.modify(
        state,
        (current): readonly [ReadonlyArray<CompletionObservation>, CompletionState] => {
          const key = subscriberKey(input.projectId, input.terminalId, input.threadId);
          if (!current.subscriptions.has(key)) return [[], current] as const;
          const subscriptions = new Map(current.subscriptions);
          subscriptions.delete(key);
          return releasePendingForHandle(
            { ...current, subscriptions },
            input.projectId,
            input.terminalId,
          );
        },
      ).pipe(Effect.flatMap(enqueueObservations)),
    );

  const closeProject: ProjectTerminalCompletionServiceShape["closeProject"] = (projectId) =>
    SynchronizedRef.update(state, (current) => {
      const subscriptions = new Map(
        [...current.subscriptions].filter(
          ([, subscription]) => subscription.projectId !== projectId,
        ),
      );
      const pending = new Map(
        [...current.pending].filter(([, observation]) => observation.projectId !== projectId),
      );
      const delivered = new Map(
        [...current.delivered].filter(([, deliveredProjectId]) => deliveredProjectId !== projectId),
      );
      const deliveredOrder = current.deliveredOrder.filter((key) => delivered.has(key));
      return { subscriptions, pending, delivered, deliveredOrder };
    });

  const start: ProjectTerminalCompletionServiceShape["start"] = Effect.fn(
    "ProjectTerminalCompletionService.start",
  )(function* () {
    const unsubscribe = yield* manager.subscribeProjectEvents((event) => {
      if (event.target.owner.kind !== "project") return Effect.void;
      if (event.type === "exited") {
        return worker
          .enqueue({ type: "exited", observation: fromEvent(event) })
          .pipe(Effect.asVoid);
      }
      if (event.type === "closed")
        return worker.enqueue({ type: "closed", event }).pipe(Effect.asVoid);
      return Effect.void;
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
  });

  return {
    subscribe,
    unsubscribe,
    closeProject,
    start,
    drain: worker.drain,
  } satisfies ProjectTerminalCompletionServiceShape;
});

export const ProjectTerminalCompletionServiceLive = Layer.effect(
  ProjectTerminalCompletionService,
  make,
);
