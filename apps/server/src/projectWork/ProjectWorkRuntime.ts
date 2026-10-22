import * as AssistantMemoryLayers from "../assistants/AssistantMemoryLayers.ts";
import * as RunAdmission from "./ProjectWorkRunAdmission.ts";
import * as Dispatch from "./ProjectTeamDispatch.ts";
import * as Supervision from "./ProjectTeamSupervisionGateway.ts";
import * as IssueBindings from "./ProjectIssueBindingGateway.ts";
import * as IssueSync from "./ProjectIssueSyncWorker.ts";
import * as TeamAuthorization from "./ProjectTeamAuthorization.ts";
import * as Layer from "effect/Layer";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Query from "./ProjectWorkQuery.ts";
import * as Search from "./ProjectWorkSearch.ts";
import * as Briefing from "./ProjectWorkBriefing.ts";
import * as Export from "./ProjectWorkExport.ts";
import * as WorkStream from "./ProjectWorkStream.ts";
import * as EventBus from "./ProjectWorkEventBus.ts";
import * as ContentGuard from "./ProjectWorkContentGuard.ts";
import * as Gateway from "./ProjectWorkGateway.ts";
import * as Verification from "./ProjectWorkVerification.ts";
import * as VerificationGateway from "./ProjectWorkVerificationGateway.ts";
import * as Reviews from "./ProjectTeamReviewFreshness.ts";
import * as IntegrationSources from "./ProjectTeamIntegrationSources.ts";
import * as MemoryQuery from "./memory/ProjectMemoryQuery.ts";
import * as MemoryProcessing from "./memory/ProjectMemoryProcessing.ts";
import * as MemoryBackend from "./memory/MemoryBackend.ts";
import * as MemoryModelRoutes from "./memory/ProjectMemoryModelRoutes.ts";
import * as Publication from "./ProjectWorkHumanPublicationRequest.ts";
import * as PublicationAuthorization from "./ProjectWorkPublicationAuthorization.ts";
import * as PublicationHost from "./ProjectWorkPublicationHostLive.ts";
import * as PublicationJournal from "./ProjectWorkPublicationJournal.ts";
import * as Merge from "./ProjectWorkManagedMerge.ts";
import * as Acceptance from "./ProjectTeamDeliveryAcceptance.ts";
import * as DeliveryGateway from "./ProjectWorkDeliveryGateway.ts";
import * as MemoryRuntime from "./memory/ProjectMemoryRuntime.ts";
import * as MemoryConfiguration from "./memory/ProjectMemoryConfiguration.ts";

// Both transports share one committed-event bus and the V2-backed dispatch service.
const persistence = Layer.mergeAll(
  Repository.ProjectWorkRepositoryLive,
  Query.ProjectWorkQueryLive,
  Search.ProjectWorkSearchLive,
  Export.layer,
  WorkStream.ProjectWorkStreamLive,
).pipe(Layer.provideMerge(EventBus.ProjectWorkEventBusLive), Layer.provide(ContentGuard.layer));

export const coreLayer = Gateway.layer.pipe(
  Layer.provide(TeamAuthorization.layer),
  Layer.provideMerge(Briefing.ProjectWorkBriefingLive.pipe(Layer.provideMerge(persistence))),
);

export const layer = Gateway.layer.pipe(
  Layer.provide(Supervision.layer),
  Layer.provide(TeamAuthorization.layer),
  Layer.provide(
    Layer.mergeAll(IssueBindings.layer, IssueSync.layer).pipe(Layer.provideMerge(persistence)),
  ),
  Layer.provideMerge(Briefing.ProjectWorkBriefingLive.pipe(Layer.provideMerge(persistence))),
);

const deliveryAuthority = PublicationAuthorization.layer.pipe(
  Layer.provideMerge(PublicationHost.layer),
  Layer.provideMerge(PublicationJournal.layer),
);
const productionFeatures = Layer.mergeAll(
  VerificationGateway.layer,
  MemoryQuery.layer,
  Publication.layer,
  Merge.layer,
  Acceptance.layer,
  DeliveryGateway.layer,
).pipe(
  Layer.provideMerge(MemoryRuntime.layer.pipe(Layer.provideMerge(MemoryProcessing.layer))),
  Layer.provideMerge(deliveryAuthority),
  Layer.provideMerge(TeamAuthorization.layer.pipe(Layer.provide(RunAdmission.layer))),
  Layer.provideMerge(IntegrationSources.layer.pipe(Layer.provideMerge(Reviews.layer))),
  Layer.provideMerge(Verification.layer),
  Layer.provideMerge(AssistantMemoryLayers.layerSharedMemory),
  Layer.provideMerge(MemoryConfiguration.layer),
  Layer.provideMerge(MemoryBackend.layer.pipe(Layer.provideMerge(MemoryModelRoutes.layer))),
  Layer.provideMerge(persistence),
);

export const executionLayer = Gateway.layer.pipe(
  Layer.provide(Supervision.layer),
  Layer.provide(MemoryRuntime.workerLayer.pipe(Layer.provide(productionFeatures))),
  Layer.provide(
    Dispatch.workerLayer.pipe(
      Layer.provideMerge(Dispatch.layer),
      Layer.provideMerge(productionFeatures),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(IssueBindings.layer, IssueSync.layer).pipe(Layer.provideMerge(persistence)),
  ),
  Layer.provideMerge(Briefing.ProjectWorkBriefingLive.pipe(Layer.provideMerge(persistence))),
  Layer.provideMerge(productionFeatures),
);
