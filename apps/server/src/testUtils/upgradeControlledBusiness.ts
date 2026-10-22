import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpAppContext from "../mcpApps/McpAppModelContext.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Continuations from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderAuth from "../provider/ProviderAuthService.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Favicon from "../project/ProjectFaviconResolver.ts";
import * as Identity from "../project/RepositoryIdentityResolver.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as SourceRepositories from "../sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import type { UpgradeSnapshot } from "./prepareUpgradeSnapshot.ts";
import { upgradeFixtureRoots } from "./upgradeFixtureRoots.ts";
import { layerControlledProviders } from "./upgradeControlledProviders.ts";
import {
  layerControlledProcessRunner,
  layerControlledVcsProcess,
} from "./upgradeControlledNative.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as Folders from "../project/ManagedProjectFolders.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsConfig from "../vcs/VcsProjectConfig.ts";
import * as VcsRegistry from "../vcs/VcsDriverRegistry.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as AssistantRepository from "../assistants/AssistantRepository.ts";
import * as AssistantResources from "../assistants/AssistantResources.ts";
import * as AssistantAdmission from "../assistants/AssistantAdmission.ts";
import * as AssistantMemoryLayers from "../assistants/AssistantMemoryLayers.ts";
import * as AssistantProvisioning from "../assistants/AssistantProvisioning.ts";
import * as AssistantService from "../assistants/AssistantService.ts";
import * as AssistantRuntime from "../assistants/AssistantRuntime.ts";
import * as AssistantThreadOwnerRead from "../assistants/AssistantThreadOwnerRead.ts";
import * as AssistantOwnership from "../assistants/AssistantOwnership.ts";
import * as AssistantMemoryGateway from "../assistants/AssistantMemoryGateway.ts";
import * as AssistantMemoryActivity from "../assistants/AssistantMemoryActivity.ts";
import * as Work from "../projectWork/ProjectWorkRuntime.ts";
import * as Supervision from "../projectWork/ProjectTeamSupervisionGateway.ts";
import * as WorkAdmission from "../projectWork/ProjectWorkRunAdmission.ts";
import * as WorkBus from "../projectWork/ProjectWorkEventBus.ts";
import * as Archive from "../orchestration-v2/ThreadHistoryArchiveService.ts";
import * as HistoryRecovery from "../orchestration-v2/ThreadHistoryRecoveryService.ts";
import * as HistoryPolicy from "../orchestration-v2/ThreadHistoryRecoveryAssistantPolicy.ts";
import * as History from "../orchestration-v2/ThreadHistoryService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as CommandPolicy from "../orchestration-v2/CommandPolicy.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderSwitchService from "../orchestration-v2/ProviderSwitchService.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as InstructionDelivery from "../orchestration-v2/InstructionDelivery.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as RuntimeRequestService from "../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointCaptureService from "../orchestration-v2/CheckpointCaptureService.ts";
import * as RunFinalizationService from "../orchestration-v2/RunFinalizationService.ts";
import * as CheckpointRollbackService from "../orchestration-v2/CheckpointRollbackService.ts";
import * as ThreadTitleRegenerationService from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";

/** Actual services without startup recovery, copied outbox consumption or provider subprocesses. */
export function layerControlledBusiness(snapshot: UpgradeSnapshot) {
  const boundaries = Layer.mergeAll(
    Layer.succeed(HostProcess.Environment, {}),
    Layer.mock(SourceControl.SourceControlProviderRegistry)({
      discover: Effect.succeed([]),
      resolveLink: () => undefined,
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      extractMemoryFacts: (input) => {
        const match = /the project uses an? (blue|amber) release label/i.exec(input.sourceText);
        return Effect.succeed({
          facts: match
            ? [
                {
                  key: "release-label",
                  body: `The project uses ${match[1]!.toLowerCase() === "amber" ? "an" : "a"} ${match[1]!.toLowerCase()} release label.`,
                  quote: match[0],
                },
              ]
            : [],
        });
      },
    }),
    Layer.succeed(Favicon.ProjectFaviconResolver, {
      resolvePath: () => Effect.succeed(null),
      invalidate: () => Effect.void,
    }),
    Layer.succeed(Identity.RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) }),
    WorktreeSetupTracker.layer,
    CloneTracker.layer.pipe(
      Layer.provide(Layer.mock(SourceRepositories.SourceControlRepositoryService)({})),
    ),
  );
  const native = layerControlledProcessRunner(snapshot).pipe(Layer.provideMerge(boundaries));
  const vcs = layerControlledVcsProcess.pipe(Layer.provideMerge(native));
  const config = Layer.succeed(VcsConfig.VcsProjectConfig, {
    resolveKind: (input) =>
      Effect.succeed(
        input.requestedKind === undefined || input.requestedKind === "auto"
          ? "git"
          : input.requestedKind,
      ),
  }).pipe(Layer.provideMerge(vcs));
  const git = Layer.mergeAll(
    Git.layer,
    Layer.effect(VcsRegistry.VcsDriverRegistry, VcsRegistry.make),
  ).pipe(Layer.provideMerge(config));
  const ids = Layer.mergeAll(
    IdAllocator.layer,
    CommandReceiptStore.layer,
    TurnItemPositionStore.layer,
    AssistantRepository.layer,
    Continuations.layer,
  ).pipe(Layer.provideMerge(git));
  const memory = AssistantMemoryLayers.layerInstructionContext.pipe(Layer.provideMerge(ids));
  const resources = AssistantResources.layer.pipe(Layer.provideMerge(memory));
  const workAdmission = WorkAdmission.layer
    .pipe(Layer.provide(WorkBus.ProjectWorkEventBusLive))
    .pipe(Layer.provideMerge(resources));
  const admission = AssistantAdmission.layer.pipe(Layer.provideMerge(workAdmission));
  const sink = Layer.fresh(EventSink.layerWithAdmission).pipe(Layer.provideMerge(admission));
  const commands = ThreadCommandExecutor.layer.pipe(Layer.provideMerge(sink));
  const legacy = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(commands));
  const enrichment = ProjectEnrichment.layer.pipe(Layer.provideMerge(legacy));
  const projects = ProjectService.layer.pipe(Layer.provideMerge(enrichment));
  const registeredProjects = Layer.effect(
    ProjectService.ProjectService,
    Effect.gen(function* () {
      const service = yield* ProjectService.ProjectService;
      return ProjectService.ProjectService.of({
        ...service,
        create: Effect.fn("ControlledProject.create")(function* (input) {
          const match = /\/(assistant-[a-f0-9]{64})$/.exec(input.workspaceRoot);
          if (match?.[1])
            upgradeFixtureRoots(snapshot).registerAssistantProject(
              match[1],
              input.projectId,
              input.workspaceRoot,
            );
          return yield* service.create(input);
        }),
      });
    }),
  ).pipe(Layer.provideMerge(projects));
  const setup = Setup.layer.pipe(Layer.provideMerge(registeredProjects));
  const manager = GitManager.layer.pipe(Layer.provideMerge(setup));
  const workflow = GitWorkflow.layer.pipe(Layer.provideMerge(manager));
  const folders = Folders.layer.pipe(Layer.provideMerge(workflow));
  const claimedFolders = Layer.effect(
    Folders.ManagedProjectFolders,
    Effect.gen(function* () {
      const service = yield* Folders.ManagedProjectFolders;
      return Folders.ManagedProjectFolders.of({
        ...service,
        ensureAssistantRepository: Effect.fn("ControlledFolders.ensureAssistantRepository")(
          function* (input) {
            upgradeFixtureRoots(snapshot).claimAssistant(input.assistantId);
            return yield* service.ensureAssistantRepository(input);
          },
        ),
      });
    }),
  ).pipe(Layer.provideMerge(folders));
  const checkpointStore = CheckpointStore.layer.pipe(Layer.provideMerge(claimedFolders));
  const archive = Archive.layer.pipe(Layer.provideMerge(checkpointStore));
  const checkpoints = CheckpointService.layer.pipe(Layer.provideMerge(archive));
  const handoffEpoch = AssistantMemoryLayers.layerHandoffEpoch.pipe(
    Layer.provideMerge(checkpoints),
  );
  const handoff = ContextHandoffService.layer.pipe(Layer.provideMerge(handoffEpoch));
  const policy = RuntimePolicy.layerFromProjectStore.pipe(Layer.provideMerge(handoff));
  const provider = layerControlledProviders.pipe(Layer.provideMerge(policy));
  const hub = CommandOutputHub.layer.pipe(Layer.provideMerge(provider));
  const ingest = ProviderEventIngestor.layer.pipe(Layer.provideMerge(hub));
  const mcp = Layer.mergeAll(McpProviderSessions.layer, McpSessionRegistryTestkit.layer).pipe(
    Layer.provideMerge(ingest),
  );
  const sessions = ProviderSessionManager.layerWithOptions({ configureMcp: false }).pipe(
    Layer.provideMerge(mcp),
  );
  const auth = ProviderAuth.layer.pipe(Layer.provideMerge(sessions));
  const apps = McpAppContext.layerEmpty.pipe(Layer.provideMerge(auth));
  const execution = RunExecutionService.layer.pipe(Layer.provideMerge(apps));
  const delivery = InstructionDelivery.layer.pipe(Layer.provideMerge(execution));
  const start = ProviderTurnStartService.layer.pipe(Layer.provideMerge(delivery));
  const control = ProviderTurnControlService.layer.pipe(Layer.provideMerge(start));
  const requests = RuntimeRequestService.layer.pipe(Layer.provideMerge(control));
  const switching = ProviderSwitchService.layer.pipe(Layer.provideMerge(requests));
  const commandPolicy = Layer.mergeAll(CommandPolicy.layer, ThreadForkService.layer).pipe(
    Layer.provideMerge(switching),
  );
  const orchestrator = Orchestrator.layer.pipe(Layer.provideMerge(commandPolicy));
  const threads = ThreadManagementService.layer.pipe(Layer.provideMerge(orchestrator));
  const launch = ThreadLaunchService.layer.pipe(Layer.provideMerge(threads));
  const provisioning = AssistantProvisioning.layer.pipe(Layer.provideMerge(launch));
  const assistantService = AssistantService.layer.pipe(Layer.provideMerge(provisioning));
  const ownership = AssistantOwnership.layer.pipe(Layer.provideMerge(assistantService));
  const bus = WorkBus.ProjectWorkEventBusLive.pipe(Layer.provideMerge(ownership));
  const threadOwner = AssistantThreadOwnerRead.layer.pipe(Layer.provideMerge(bus));
  const assistants = AssistantRuntime.layer.pipe(Layer.provideMerge(threadOwner));
  const capture = CheckpointCaptureService.layer.pipe(Layer.provideMerge(assistants));
  const finalization = RunFinalizationService.layer.pipe(Layer.provideMerge(capture));
  const rollback = CheckpointRollbackService.layer.pipe(Layer.provideMerge(finalization));
  const title = Layer.succeed(
    ThreadTitleRegenerationService.ThreadTitleRegenerationService,
    ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
      execute: () => Effect.void,
    }),
  ).pipe(Layer.provideMerge(rollback));
  const executor = EffectWorker.layerExecutor.pipe(Layer.provideMerge(title));
  const work = Work.coreLayer.pipe(Layer.provide(Supervision.layer), Layer.provideMerge(executor));
  const memoryActivity = AssistantMemoryActivity.layer.pipe(Layer.provideMerge(work));
  const memoryServices = AssistantMemoryLayers.layer.pipe(Layer.provideMerge(memoryActivity));
  const memoryGateway = AssistantMemoryGateway.layer.pipe(Layer.provideMerge(memoryServices));
  const historyPolicy = HistoryPolicy.layer.pipe(Layer.provideMerge(memoryGateway));
  const historyRecovery = HistoryRecovery.layer.pipe(Layer.provideMerge(historyPolicy));
  return History.layer.pipe(Layer.provideMerge(historyRecovery));
}
