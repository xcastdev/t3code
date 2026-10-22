import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as SkillDeployment from "../skills/SkillDeploymentService.ts";
import * as SkillCatalog from "../skills/SkillCatalogService.ts";
import * as TextCatalog from "../managedTextResources/ManagedTextResourceCatalogService.ts";
import * as ResourceAuthority from "../ResourceMutationAuthority.ts";
import * as IssueSearch from "../sourceControl/IssueSearchService.ts";
import * as McpCatalogClientService from "../mcp/McpCatalogClientService.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as AssistantRuntime from "../assistants/AssistantRuntime.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { AssistantMemoryGateway } from "../assistants/AssistantMemoryGateway.ts";

// Unrelated native and external operations fail on use; no live layer is installed.
export const layerControlledFixtureBoundaries = Layer.mergeAll(
  Layer.mock(AssistantRuntime.AssistantRuntime)({}),
  Layer.mock(AssistantMemoryGateway)({}),
  Layer.mock(SkillCatalog.SkillCatalogService)({
    // Instruction receipts invalidate catalog views even when no skills are selected.
    notifyApplicationChanged: () => Effect.void,
  }),
  Layer.mock(SkillDeployment.SkillDeploymentService)({}),
  Layer.mock(TextCatalog.ManagedTextResourceCatalogService)({}),
  Layer.mock(ResourceAuthority.ResourceMutationAuthority)({}),
  Layer.mock(IssueSearch.IssueSearchService)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({}),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PortScanner.PortDiscovery)({}),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(McpCatalogClientService.McpCatalogClientService)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
);
