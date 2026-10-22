import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as CommandPolicy from "../orchestration-v2/CommandPolicy.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderSwitchService from "../orchestration-v2/ProviderSwitchService.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderRuntimeRecoveryService from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderContinuationService from "../orchestration-v2/ProviderContinuationService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { FixtureNativeDenied } from "./upgradeFixtureNative.ts";

export class UpgradeFixtureScheduler extends Context.Service<
  UpgradeFixtureScheduler,
  {
    readonly tick: Effect.Effect<void>;
    readonly sources: Effect.Effect<ReadonlyArray<string>>;
    readonly nativeAttempts: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/testUtils/upgradeFixtureServices/UpgradeFixtureScheduler") {}

export const layerFixtureServicesForMode = (mode: "preservation" | "controlled-fixture") =>
  Layer.unwrap(
    Effect.sync(() => {
      const callbacks = new Map<string, Effect.Effect<void>>();
      const nativeAttempts: string[] = [];
      const refuse = (operation: string) =>
        Effect.suspend(() => {
          nativeAttempts.push(operation);
          return Effect.die(new FixtureNativeDenied({ operation }));
        });
      const sessions = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => refuse("provider.open"),
          get: () => Effect.succeedNone,
          isLive: () => Effect.succeed(false),
          close: () => refuse("provider.close"),
          closeInstance: () => refuse("provider.closeInstance"),
          release: () => refuse("provider.release"),
          detach: () => refuse("provider.detach"),
        }),
      );
      const registry = Layer.succeed(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
          list: () => Effect.succeed([]),
          get: (instanceId) =>
            Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
            ),
        }),
      );
      const fakes = Layer.mergeAll(
        sessions,
        registry,
        IdAllocator.layer,
        CommandPolicy.layer,
        ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
        RuntimePolicy.layer,
        ThreadForkService.layer,
        ProviderContinuationRequests.layer,
        Layer.mock(CheckpointService.CheckpointServiceV2)({}),
        Layer.mock(ProviderSwitchService.ProviderSwitchServiceV2)({}),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({}),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
      );
      const orchestrator = Orchestrator.layer.pipe(Layer.provideMerge(fakes));
      const threads = ThreadManagementService.layer.pipe(Layer.provideMerge(orchestrator));
      const schedulerLayer = Layer.succeed(
        Scheduler.Scheduler,
        Scheduler.Scheduler.of({
          register: Effect.fn("UpgradeFixtureScheduler.register")(function* (name, work) {
            const context = yield* Effect.context<Effect.Services<typeof work>>();
            callbacks.set(
              name,
              work.pipe(
                Effect.provideContext(context),
                Effect.catchCause(() => Effect.void),
              ),
            );
          }),
        }),
      );
      const tasks = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            schedulerLayer,
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({
              launch: () => refuse("thread.launch"),
            }),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/fixture-only",
              isScratchProject: () => Effect.succeed(false),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
          ),
        ),
        Layer.provide(threads),
      );
      const worker =
        mode === "controlled-fixture"
          ? Layer.succeed(
              EffectWorker.OrchestrationEffectWorkerV2,
              EffectWorker.OrchestrationEffectWorkerV2.of({
                awaitWork: Effect.never,
                awaitControlWork: Effect.never,
                runOnce: Effect.succeed(false),
                runControlOnce: Effect.succeed(false),
                runRecoveryOnce: Effect.succeed(false),
                nextClaimableAt: Effect.succeed(Option.none()),
                nextControlClaimableAt: Effect.succeed(Option.none()),
                drain: () => Effect.succeed(0),
              }),
            )
          : EffectWorker.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  EffectWorker.OrchestrationEffectExecutorV2,
                  EffectWorker.OrchestrationEffectExecutorV2.of({
                    execute: () => refuse("effect.execute"),
                  }),
                ),
              ),
            );
      const start = ProviderTurnStartService.layer.pipe(Layer.provide(fakes));
      const control = ProviderTurnControlService.layer.pipe(Layer.provide(sessions));
      const recovery =
        mode === "controlled-fixture"
          ? Layer.succeed(
              ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService,
              ProviderRuntimeRecoveryService.ProviderRuntimeRecoveryService.of({
                reconcile: () =>
                  Effect.succeed({
                    terminalizedRuns: 0,
                    stoppedSessions: 0,
                    closedRequests: 0,
                    retiredEffects: 0,
                    requeuedEffects: 0,
                  }),
                prepareForShutdown: Effect.void,
                recover: Effect.succeed({
                  terminalizedRuns: 0,
                  stoppedSessions: 0,
                  closedRequests: 0,
                  retiredEffects: 0,
                  requeuedEffects: 0,
                }),
              }),
            )
          : ProviderRuntimeRecoveryService.layer.pipe(Layer.provide(IdAllocator.layer));
      const continuation =
        mode === "controlled-fixture"
          ? Layer.empty
          : ProviderContinuationService.layer.pipe(
              Layer.provide(threads),
              Layer.provide(Layer.mergeAll(IdAllocator.layer, ProviderContinuationRequests.layer)),
            );
      return Layer.mergeAll(
        threads,
        mode === "controlled-fixture"
          ? Layer.effect(
              ScheduledTaskService.ScheduledTaskService,
              Effect.gen(function* () {
                const service = yield* ScheduledTaskService.ScheduledTaskService;
                return ScheduledTaskService.ScheduledTaskService.of({
                  ...service,
                  upsert: () => refuse("schedule.upsert"),
                  setEnabled: () => refuse("schedule.setEnabled"),
                  delete: () => refuse("schedule.delete"),
                  deleteForThread: () => refuse("schedule.deleteForThread"),
                  runNow: () => refuse("schedule.runNow"),
                  rotateWebhookToken: () => refuse("schedule.rotateWebhookToken"),
                  triggerWebhook: () => refuse("webhook.trigger"),
                });
              }),
            ).pipe(Layer.provide(tasks))
          : tasks,
        worker,
        start,
        control,
        recovery,
        continuation,
        Layer.succeed(
          UpgradeFixtureScheduler,
          UpgradeFixtureScheduler.of({
            sources: Effect.sync(() => [...callbacks.keys()]),
            nativeAttempts: Effect.sync(() => [...nativeAttempts]),
            tick:
              mode === "controlled-fixture"
                ? Effect.void
                : Effect.suspend(() =>
                    Effect.forEach(callbacks.values(), (callback) => callback.pipe(Effect.exit), {
                      discard: true,
                    }),
                  ),
          }),
        ),
      );
    }),
  );

export const layerFixtureServices = layerFixtureServicesForMode("preservation");
