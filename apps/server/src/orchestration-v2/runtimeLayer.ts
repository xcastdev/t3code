import * as ExternalNotificationDispatcher from "../notifications/ExternalNotificationDispatcher.ts";
import * as ExternalNotificationGateway from "../notifications/ExternalNotificationGateway.ts";
import * as ExternalNotificationRuntime from "../notifications/ExternalNotificationRuntime.ts";
import * as HomeAssistantWebhookAdapter from "../notifications/HomeAssistantWebhookAdapter.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ProjectWorkQuery from "../projectWork/ProjectWorkQuery.ts";
import * as ThreadHistoryService from "./ThreadHistoryService.ts";
import * as AssistantEventBus from "../assistants/AssistantEventBus.ts";
import * as AssistantActivity from "../assistants/AssistantActivity.ts";
import * as AssistantThreadOwnerRead from "../assistants/AssistantThreadOwnerRead.ts";
import * as AssistantRosterStream from "../assistants/AssistantRosterStream.ts";
import * as AssistantRoutines from "../assistants/AssistantRoutines.ts";
import * as AssistantRoutineGateway from "../assistants/AssistantRoutineGateway.ts";
import * as AssistantRoutineRepository from "../assistants/AssistantRoutineRepository.ts";
import * as AssistantMemoryGateway from "../assistants/AssistantMemoryGateway.ts";
import * as AssistantMemoryActivity from "../assistants/AssistantMemoryActivity.ts";
import * as AssistantMemoryLayers from "../assistants/AssistantMemoryLayers.ts";
import * as AssistantMemoryRuntime from "../assistants/AssistantMemoryRuntime.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Context from "effect/Context";
import * as AssistantRuntime from "../assistants/AssistantRuntime.ts";
import * as AssistantProvisioning from "../assistants/AssistantProvisioning.ts";
import * as AssistantService from "../assistants/AssistantService.ts";
import * as AssistantOwnership from "../assistants/AssistantOwnership.ts";
import * as AssistantAdmission from "../assistants/AssistantAdmission.ts";
import * as AssistantRepository from "../assistants/AssistantRepository.ts";
import * as AssistantResources from "../assistants/AssistantResources.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as Result from "effect/Result";
import * as InstructionDelivery from "./InstructionDelivery.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as ThreadHistoryArchive from "./ThreadHistoryArchiveService.ts";
import * as ThreadHistoryRecovery from "./ThreadHistoryRecoveryService.ts";
import * as ThreadHistoryRecoveryAssistantPolicy from "./ThreadHistoryRecoveryAssistantPolicy.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadLifecycleService from "./ThreadLifecycleService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ProjectWorkRunAdmission from "../projectWork/ProjectWorkRunAdmission.ts";
import * as ProjectWorkEventBus from "../projectWork/ProjectWorkEventBus.ts";
import * as OwnerDeadlineControl from "./OwnerDeadlineControl.ts";
import * as Effect from "effect/Effect";

export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

const layerRuntimePolicyProvided = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(ProjectStore.layer),
);

const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);
const layerCommandReceiptStoreProvided = CommandReceiptStore.layerFromApplicationReceipts.pipe(
  Layer.provide(layerEventInfrastructure),
);

const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerAssistantPersistence = AssistantRepository.layer;
export const layerAssistantRoutinePersistence = AssistantRoutineRepository.layer.pipe(
  Layer.provide(layerAssistantPersistence),
);
export const layerRunAdmission = AssistantAdmission.layer.pipe(
  Layer.provide(layerAssistantRoutinePersistence),
  Layer.provide(
    AssistantResources.layer.pipe(Layer.provide(AssistantMemoryLayers.layerInstructionContext)),
  ),
  Layer.provide(AssistantMemoryLayers.layerInstructionContext),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(
    Layer.mergeAll(layerAssistantPersistence, ProjectionStore.layer, ProjectStore.layer),
  ),
  Layer.provide(
    ProjectWorkRunAdmission.layer.pipe(Layer.provide(ProjectWorkEventBus.ProjectWorkEventBusLive)),
  ),
);
export const layerEventSink = EventSink.layerWithAdmission.pipe(
  Layer.provide(Layer.merge(layerStores, layerRunAdmission)),
);
const layerEventSinkProvided = layerEventSink;
const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);
const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSinkProvided),
);

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
    ),
  ),
);

const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
      GitVcsDriver.layer,
    ),
  ),
);

const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);
const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(AssistantMemoryLayers.layerHandoffEpoch),
  Layer.provide(IdAllocator.layer),
);

const layerProviderAdapterRegistryProvided =
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry;
const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(layerProviderAdapterRegistryProvided),
);

const layerCommandOutputHubProvided = CommandOutputHub.layer.pipe(
  Layer.provide(Layer.merge(layerEventSinkProvided, ProjectionStore.layer)),
);

const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCommandOutputHubProvided,
      layerProviderAdapterRegistryProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
    ),
  ),
);

const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ProjectionStore.layer, layerProviderSessionManagerProvided, layerRunAdmission),
  ),
);

const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      TurnItemPositionStore.layer,
    ),
  ),
);

const layerInstructionDeliveryProvided = InstructionDelivery.layer.pipe(
  Layer.provide(Layer.mergeAll(layerEventSinkProvided, ProjectionStore.layer, IdAllocator.layer)),
);

const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerContextHandoffServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerInstructionDeliveryProvided,
      layerRunAdmission,
      layerRuntimePolicyProvided,
    ),
  ),
);

const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ProjectionStore.layer, layerProviderSessionManagerProvided, layerRunAdmission),
  ),
);
const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ProjectionStore.layer, layerProviderSessionManagerProvided, layerRunAdmission),
  ),
);
export const layerHistoryArchive = ThreadHistoryArchive.layer.pipe(
  Layer.provide(ProjectionStore.layer),
  Layer.tap((context) =>
    Context.get(context, ThreadHistoryArchive.ThreadHistoryArchiveService).resumePreparations.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("History archive preparation remains pending.", {
          cause,
        }),
      ),
    ),
  ),
);

const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerHistoryArchive,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);
const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);
const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSinkProvided,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      layerProviderAdapterRegistryProvided,
      // Same layer reference as the continuation worker and the adapter
      // infrastructure so layer memoization yields one shared request queue.
      ProviderContinuationRequests.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      layerProjectService,
      layerOrchestratorProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
    ),
  ),
);

const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      layerLegacyV1ThreadImporterProvided,
      layerCommandReceiptStoreProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);
export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
);
const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(ProcessRunner.layer),
  Layer.provide(layerProjectService),
);
const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerRunAdmission,
      layerProjectService,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadLifecycleProvided = ThreadLifecycleService.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);
const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(Layer.merge(layerThreadManagementProvided, layerRunAdmission)),
);
export const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(AssistantEventBus.layer),
  Layer.provide(Layer.merge(layerAssistantRoutinePersistence, layerAssistantPersistence)),
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerManagedProjectFoldersProvided,
      layerSecretRequestsProvided,
    ),
  ),
);
const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      layerRunAdmission,
      IdAllocator.layer,
    ),
  ),
);
const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerThreadManagementProvided, ProjectStore.layer, TextGeneration.layer),
  ),
);
export const makeOwnerDeadlineStop = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const terminals = yield* TerminalManager.TerminalManager;
  return OwnerDeadlineControl.OwnerDeadlineStop.of({
    stop: Effect.fn("OwnerDeadlineStop.stop")(function* (input) {
      const [stopped, cleaned] = yield* Effect.all(
        [
          orchestrator.stopOwnedRun(input).pipe(Effect.result),
          terminals.closeProjectOwner(input.control).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      if (Result.isFailure(stopped) || Result.isFailure(cleaned))
        return yield* new OwnerDeadlineControl.OwnerDeadlineControlError({
          controlId: input.control.controlId,
          cause: Result.isFailure(stopped)
            ? stopped.failure
            : Result.isFailure(cleaned)
              ? cleaned.failure
              : undefined,
        });
    }),
  });
});
const layerOwnerDeadlineStopProvided = Layer.effect(
  OwnerDeadlineControl.OwnerDeadlineStop,
  makeOwnerDeadlineStop,
).pipe(Layer.provide(layerOrchestratorProvided));
const layerOwnerDeadlineControlProvided = OwnerDeadlineControl.layer.pipe(
  Layer.provide(Layer.merge(layerRunAdmission, layerOwnerDeadlineStopProvided)),
);
const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOwnerDeadlineControlProvided,
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerThreadManagementProvided,
    ),
  ),
);
const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
);
const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEffectWorkerProvided,
      layerStores,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerCommandOutputHubProvided,
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
);

export const layerAssistantRuntime = AssistantRuntime.layer.pipe(
  Layer.provide(AssistantThreadOwnerRead.layer),
  Layer.provide(AssistantEventBus.layer),
  Layer.provide(layerAssistantRoutinePersistence),
  Layer.provide(ProjectWorkEventBus.ProjectWorkEventBusLive),
  Layer.provideMerge(
    AssistantService.layer.pipe(
      Layer.provideMerge(
        AssistantProvisioning.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerManagedProjectFoldersProvided,
              layerProjectService,
              layerThreadLaunchProvided,
              layerThreadManagementProvided,
            ),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(AssistantOwnership.layer),
  Layer.provideMerge(layerAssistantPersistence),
  Layer.provide(layerThreadManagementProvided),
  Layer.tap((context) =>
    Effect.catch(Context.get(context, AssistantRuntime.AssistantRuntime).recover(), (cause) =>
      Effect.logWarning("Assistant startup reconciliation remains unavailable.", { cause }),
    ),
  ),
);

export const layerAssistantMemoryGateway = AssistantMemoryGateway.layer.pipe(
  Layer.provide(AssistantEventBus.layer),
  Layer.provideMerge(AssistantMemoryLayers.layer),
  Layer.provide(AssistantMemoryActivity.layer),
);

export const layerHistoryRecovery = ThreadHistoryRecovery.layer.pipe(
  Layer.provide(
    ThreadHistoryRecoveryAssistantPolicy.layer.pipe(
      Layer.provide(AssistantMemoryLayers.layerHandoffEpoch),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      layerHistoryArchive,
      ProjectionStore.layer,
      ProjectStore.layer,
      layerThreadManagementProvided,
    ),
  ),
);

export const layerHistory = ThreadHistoryService.layer.pipe(
  Layer.provide(Layer.merge(layerHistoryArchive, layerHistoryRecovery)),
);

export const layerAssistantActivity = AssistantActivity.layer.pipe(
  Layer.provide(layerAssistantPersistence),
);
export const layerAssistantRosterStream = AssistantRosterStream.layer.pipe(
  Layer.provideMerge(layerAssistantActivity),
  Layer.provide(AssistantEventBus.layer),
  Layer.provide(layerEventSink),
);
export const layerAssistantRoutines = AssistantRoutines.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerAssistantPersistence,
      layerAssistantRoutinePersistence,
      layerScheduledTaskProvided,
    ),
  ),
);
export const layerAssistantRoutineGateway = AssistantRoutineGateway.layer.pipe(
  Layer.provideMerge(layerAssistantRoutines),
  Layer.provideMerge(layerAssistantPersistence),
  Layer.provide(AssistantEventBus.layer),
);

const layerExternalNotifications = ExternalNotificationRuntime.layer.pipe(
  Layer.provideMerge(
    ExternalNotificationGateway.layer.pipe(
      Layer.provide(AuthSessions.layer),
      Layer.provideMerge(
        ExternalNotificationDispatcher.layer.pipe(Layer.provide(HomeAssistantWebhookAdapter.layer)),
      ),
    ),
  ),
  Layer.provide(ProjectWorkQuery.ProjectWorkQueryLive.pipe(Layer.provide(ProjectStore.layer))),
  Layer.provide(ProjectWorkEventBus.ProjectWorkEventBusLive),
  Layer.provide(layerOrchestratorProvided),
  Layer.tap(
    (context) =>
      Context.get(context, ExternalNotificationRuntime.ExternalNotificationRuntime).start,
  ),
);

export const layerProduction = Layer.mergeAll(
  layerExternalNotifications,
  layerHistory,
  layerAssistantRosterStream,
  layerAssistantRoutineGateway,
  layerHistoryArchive,
  layerHistoryRecovery,
  layerAssistantMemoryGateway,
  AssistantMemoryRuntime.workerLayer.pipe(
    Layer.provideMerge(AssistantMemoryLayers.layer),
    Layer.provide(AssistantMemoryActivity.layer),
    Layer.provide(layerEventSink),
  ),
  layerAssistantRuntime,
  layer.pipe(Layer.provide(layerProjectService)),
  layerProjectService,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  layerThreadLifecycleProvided,
  layerScheduledTaskProvided,
  layerSecretRequestsProvided,
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ProjectionStore.layer,
        layerThreadManagementProvided,
        layerOrchestratorProvided,
      ),
    ),
  ),
  layerProviderContinuationWorkerProvided,
  layerAgentSessionImporterProvided,
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(
  Layer.provide(
    ResourceCleanupService.layer.pipe(
      Layer.provide(Layer.merge(layerScheduledTaskProvided, layerHistoryArchive)),
    ),
  ),
  Layer.provide(Scheduler.layer),
  Layer.provideMerge(layerEventInfrastructure),
  Layer.provideMerge(layerRunAdmission),
  Layer.provideMerge(layerInstructionDeliveryProvided),
);
