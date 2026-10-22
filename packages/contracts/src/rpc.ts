import { AssistantResolveThreadInput, AssistantResolveThreadResult } from "./assistantUi.ts";
import {
  ExternalNotificationTestInput,
  ExternalNotificationTestResult,
} from "./externalNotifications.ts";
import {
  ThreadHistoryArchiveIdentity,
  ThreadHistoryDetailInput,
  ThreadHistoryDetailResult,
  ThreadHistoryFileRestoreStatusInput,
  ThreadHistoryFileRestoreStatusResult,
  ThreadHistoryListInput,
  ThreadHistoryListResult,
  ThreadHistoryReconcileInput,
  ThreadHistoryReconcileResult,
  ThreadHistoryRecoverInput,
  ThreadHistoryRecoveryResult,
  ThreadHistoryRestoreFilesInput,
  ThreadHistoryRestoreFilesResult,
  ThreadHistoryRpcError,
} from "./threadHistory.ts";
import {
  AssistantRoutineReadInput,
  AssistantRoutineReadResult,
  AssistantRoutineWriteInput,
  AssistantRoutineWriteResult,
} from "./assistantRoutines.ts";
import {
  AssistantMemoryReadInput,
  AssistantMemoryReadResult,
  AssistantMemoryWriteInput,
  AssistantMemoryWriteResult,
  AssistantMemoryRpcError,
} from "./assistantMemory.ts";
import {
  AssistantActivityListInput,
  AssistantRunListResult,
  AssistantCreateInput,
  AssistantGetInput,
  AssistantListInput,
  AssistantListResult,
  AssistantUpdateConfigurationInput,
  AssistantLifecycleInput,
  AssistantDetail,
  AssistantRpcError,
} from "./assistants.ts";
import { IssueSearchInput, IssueSearchResult } from "./issueSearch.ts";
import {
  ProjectTerminalAttachStreamEvent,
  ProjectTerminalDockListInput,
  ProjectTerminalDockListResult,
  ProjectTerminalHandle,
  ProjectTerminalMetadataStreamEvent,
  ProjectTerminalResizeInput,
  ProjectTerminalWriteInput,
  ProjectTerminalKillInput,
  ProjectTerminalStopResult,
  TerminalToolError,
} from "./terminalToolkit.ts";
import {
  SkillApplicationGetInput,
  SkillApplicationGetResult,
  SkillCatalogChanged,
  SkillCatalogListInput,
  SkillCatalogListResult,
  SkillContentGetInput,
  SkillContentGetResult,
  SkillDeploymentChangeInput,
  SkillDeploymentChangeResult,
  SkillDeploymentListInput,
  SkillDeploymentListResult,
  SkillGlobalCreateInput,
  SkillGlobalCreateResult,
  SkillGlobalDeleteInput,
  SkillGlobalDeleteResult,
  SkillGlobalRenameInput,
  SkillGlobalRenameResult,
  SkillGlobalRollbackInput,
  SkillGlobalRollbackResult,
  SkillGlobalUpdateInput,
  SkillGlobalUpdateResult,
  SkillHistoryListInput,
  SkillHistoryListResult,
  SkillNativeContentGetInput,
  SkillNativeContentGetResult,
  SkillNativeImportInput,
  SkillNativeImportResult,
  SkillProjectDeleteStateInput,
  SkillProjectDeleteStateResult,
  SkillProjectRenameInput,
  SkillProjectRenameResult,
  SkillProjectSetDisabledInput,
  SkillProjectSetDisabledResult,
  SkillProjectSetOverrideInput,
  SkillProjectSetOverrideResult,
  SkillRpcError,
  SkillSessionResetInput,
  SkillSessionResetResult,
  SkillSessionSetEnabledInput,
  SkillSessionSetEnabledResult,
} from "./skills.ts";
import {
  ManagedTextResourceCatalogListInput,
  ManagedTextResourceCatalogListResult,
  ManagedTextResourceChanged,
  ManagedTextResourceContentGetInput,
  ManagedTextResourceContentGetResult,
  ManagedTextResourceEnvironmentCreateInput,
  ManagedTextResourceEnvironmentDeleteInput,
  ManagedTextResourceEnvironmentSetEnabledInput,
  ManagedTextResourceEnvironmentUpdateInput,
  ManagedTextResourceMutationResult,
  ManagedTextResourceProjectDeleteStateInput,
  ManagedTextResourceProjectSetDisabledInput,
  ManagedTextResourceProjectSetOverrideInput,
  ManagedTextResourceRpcError,
  ManagedTextResourceThreadResetInput,
  ManagedTextResourceThreadSetEnabledInput,
} from "./managedTextResources.ts";
import {
  McpCatalogSessionForThreadInput,
  McpCatalogSessionForThreadResult,
  McpCatalogOAuthTarget,
  McpCatalogOAuthStatusResult,
  McpCatalogSecretPrepareInput,
  McpCatalogSecretPrepareResult,
  McpCatalogReadInput,
  McpCatalogReadResult,
  McpCatalogWriteInput,
  McpCatalogSessionRequest,
  McpCatalogSessionMutationInput,
  McpCatalogSnapshot,
  McpCatalogMutationError,
  McpCatalogOAuthBeginInput,
  McpCatalogOAuthContinueInput,
  McpCatalogOAuthDisconnectInput,
} from "./mcpCatalog.ts";
import { ProjectMcpOAuthBeginResult } from "./projectMcp.ts";
import { ProjectIssueRequest } from "./projectIssueIntake.ts";
import {
  ProjectWorkReadIntent,
  ProjectWorkWriteIntent,
  ProjectWorkWriteResult,
  ProjectWorkStreamInput,
  ProjectWorkStreamItem,
  ProjectWorkDeliveryRequest,
  ProjectWorkDeliveryResult,
} from "./projectWork.ts";
import {
  OrchestrationV2SearchThreadError,
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "./orchestrationV2.ts";
import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import {
  McpAppCallToolInput,
  McpAppCallToolResult,
  McpAppReadResourceInput,
  McpAppReadResourceResult,
  McpAppRequestError,
  McpAppToolInfo,
  McpAppToolInfoInput,
  McpAppUpdateModelContextInput,
} from "./mcpApps.ts";
import {
  ChatGptReconnectProfileInput,
  ChatGptReconnectProfile,
  ChatGptImportProfileInput,
  ChatGptHandoffInput,
  ChatGptHandoffState,
} from "./providerSetup.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  CodexAuthCallbackInput,
  CodexAuthCallbackState,
  ProviderAuthCancelInput,
  ProviderAuthCompleteInput,
  ProviderAuthState,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderInstallCancelInput,
  ProviderInstallState,
  ProviderSetupError,
  ProviderSetupInput,
} from "./providerSetup.ts";

import {
  AcpRegistryAcceptUrlAuthInput,
  AcpRegistryAcceptUrlAuthResult,
  AcpRegistryDeleteSessionInput,
  AcpRegistryDeleteSessionResult,
  AcpRegistryDisableProviderInput,
  AcpRegistryDisableProviderResult,
  AcpRegistryImportSessionInput,
  AcpRegistryImportSessionResult,
  AcpRegistryListSessionsInput,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersInput,
  AcpRegistryListProvidersResult,
  AcpRegistryLogoutInput,
  AcpRegistryLogoutResult,
  AcpRegistryManagedBinaryUninstallInput,
  AcpRegistryManagedBinaryUninstallResult,
  AcpRegistryOperationError,
  AcpRegistryPrepareInput,
  AcpRegistryPrepareResult,
  AcpRegistrySearchInput,
  AcpRegistrySearchResult,
  AcpRegistrySetProviderInput,
  AcpRegistrySetProviderResult,
} from "./acpRegistry.ts";
import { ExternalLauncherError, LaunchEditorInput } from "./editor.ts";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  BackgroundPolicySnapshot,
  ClientActivityReportInput,
  HostPowerSnapshot,
} from "./background.ts";
import {
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  AgentSessionImportInput,
  AgentSessionImportProjectChangedError,
  AgentSessionImportProjectNotFoundError,
  AgentSessionImportResult,
  AgentSessionScanInput,
  AgentSessionScanResult,
  AgentSessionScanError,
} from "./agentSessions.ts";
import {
  AssetAccessError,
  AssetCreateUrlInput,
  AssetCreateUrlResult,
  AttachmentCreateUploadUrlInput,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  AttachmentUploadSigningKeyError,
} from "./assets.ts";
import {
  PersistChatAttachmentsError,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
} from "./chatAttachment.ts";
import {
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetTurnDiffError,
} from "./checkpointDiff.ts";
import {
  WorktreeSetupCancelInput,
  WorktreeSetupCancelResult,
  WorktreeSetupStreamEvent,
  WorktreeSetupSubscribeInput,
} from "./worktreeSetup.ts";
import {
  GitActionProgressEvent,
  GitDiscoverRepositoriesInput,
  GitDiscoverRepositoriesResult,
  GitIndexStatusInput,
  GitIndexStatusResult,
  GitMutateIndexInput,
  GitCommitStagedInput,
  GitCommitStagedResult,
  GitHistoryInput,
  GitHistoryResult,
  GitHistoryDiffInput,
  GitHistoryDiffResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  GitCommandError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  VcsPullInput,
  GitPullRequestRefInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  VcsStatusInput,
  VcsStatusSubscriptionInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "./git.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";
import {
  ProviderUploadFeedbackError,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "./provider.ts";
import { ProviderInstanceId, ProviderInstanceMutation } from "./providerInstance.ts";
import { PullRequestReviewGuideResult } from "./pullRequestReviewGuide.ts";
import {
  PullRequestActionInput,
  PullRequestActivity,
  PullRequestChangeBreakdown,
  PullRequestCommentInput,
  PullRequestCommentUpdateInput,
  PullRequestDetail,
  PullRequestPreview,
  PullRequestChecks,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestFilesViewedResult,
  PullRequestInvalidateInput,
  PullRequestReportStateInput,
  PullRequestListInput,
  PullRequestListResult,
  PullRequestListStatsInput,
  PullRequestListStatsResult,
  PullRequestOperationError,
  PullRequestReactionInput,
  PullRequestRef,
  PullRequestRoutingResult,
  PullRequestRoutingIdentityInput,
  PullRequestRoutingIdentityResult,
  PullRequestStack,
  PullRequestLinkedThreadsResult,
  PullRequestSummary,
  PullRequestReviewerCandidateList,
  PullRequestReviewerRequestInput,
  PullRequestLabelCandidateList,
  PullRequestLabelChangeInput,
  PullRequestSetFilesViewedInput,
  PullRequestSubmitReviewInput,
  PullRequestThreadCommentsInput,
  PullRequestThreadCommentsResult,
  PullRequestThreadReplyInput,
  PullRequestThreadResolutionInput,
  PullRequestUnavailableError,
  PullRequestUpdateInput,
} from "./pullRequest.ts";
import {
  RelayClientInstallFailedError,
  RelayClientInstallProgressEventSchema,
  RelayClientStatusSchema,
} from "./relayClient.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationGetWorkflowScriptError,
  OrchestrationV2StopWorkflowError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetShellSnapshotError,
  OrchestrationV2CommandOutputError,
  OrchestrationV2GetThreadProjectionError,
  OrchestrationV2RpcSchemas,
  OrchestrationV2ThreadLaunchError,
} from "./orchestrationV2.ts";
import {
  ProjectCreateNewInput,
  ProjectCreateNewResult,
  ProjectEnsureScratchResult,
  ProjectListEntriesError,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectSearchContentsError,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  TerminalAttachInput,
  TerminalObserveInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  DiscoveredLocalServerList,
  ConfiguredLocalServerUrls,
  PreviewCloseInput,
  PreviewError,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewClearProfileError,
  PreviewClearProfileInput,
  PreviewReportProfilesInput,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewAdjustInput,
  PreviewSessionSnapshot,
} from "./preview.ts";
import {
  DeviceActionInput,
  DeviceCloseInput,
  DeviceConfigureInput,
  DeviceDetail,
  DeviceDetailInput,
  DeviceError,
  DeviceListInput,
  SshDeviceHostConfig,
  DeviceEasAccount,
  DeviceEasAccountError,
  DeviceEasAccountInput,
  DeviceHostSummary,
  DeviceOpenInput,
  DeviceServiceState,
  DeviceSession,
  DeviceShutdownInput,
} from "./device.ts";
import {
  ServerConfigStreamEvent,
  DesktopUpdateCommitInput,
  OtlpEndpointCheckInput,
  OtlpEndpointCheckResult,
  ServerConfig,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerLifecycleStreamEvent,
  ServerRemoveKeybindingInput,
  ServerRemoveKeybindingResult,
  ServerProviderUpdatedPayload,
  ServerSelfUpdateError,
  ServerSelfUpdateInput,
  ServerSelfUpdateProgressEvent,
  ServerSelfUpdateResult,
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import {
  HostResourcesSnapshot,
  ResourceTelemetryHistory,
  ResourceTelemetryHistoryInput,
  ResourceTelemetryRetryResult,
  ResourceTelemetrySnapshot,
} from "./resourceTelemetry.ts";
import {
  UsageLimitSourceError,
  ProviderConsumeResetCreditInput,
  ProviderConsumeResetCreditResult,
} from "./providerUsageLimits.ts";
import { UsagePricing, UsageReadError, UsageSummary, UsageSummaryInput } from "./usage.ts";
import {
  StorageCleanupReport,
  DatabaseStorageStatus,
  ServerSettings,
  ServerSettingsError,
  ServerSettingsPatch,
} from "./settings.ts";
import {
  ScheduledTaskDeleteInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskError,
  ScheduledTaskListInput,
  ScheduledTaskListResult,
  ScheduledTaskRunNowInput,
  ScheduledTaskRotateWebhookTokenInput,
  ScheduledTaskListWebhookDeliveriesInput,
  ScheduledTaskListWebhookDeliveriesResult,
  ScheduledTaskGetWebhookDeliveryInput,
  ScheduledTaskGetWebhookDeliveryResult,
  ScheduledTaskRunNowResult,
  ScheduledTaskSetEnabledInput,
  ScheduledTaskUpsertInput,
  ScheduledTaskMutationResult,
} from "./scheduledTask.ts";
import { SecretRequestAnswerInput, SecretRequestError } from "./secretRequest.ts";
import {
  ProjectCloneActionInput,
  ProjectCloneActionResult,
  ProjectCloneListEvent,
  ProjectCloneStartInput,
  ProjectCloneStartResult,
  ProjectCloneSubscribeInput,
} from "./projectClone.ts";
import {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlPublishRepositoryInput,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryError,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { VcsError } from "./vcs.ts";
import { Project, ProjectMutation, ProjectMutationError } from "./project.ts";

export class ProjectWorkRpcError extends Schema.TaggedError<ProjectWorkRpcError>()(
  "ProjectWorkRpcError",
  {
    operation: Schema.Literals(["read", "write", "subscribe"]),
    reason: Schema.Literals(["unavailable", "invalid-request", "forbidden", "rejected"]),
  },
) {
  override get message(): string {
    return `Project Work ${this.operation} failed (${this.reason}).`;
  }
}

export const WS_METHODS = {
  mcpCatalogSessionSubscribeForThread: "mcpCatalog.sessionSubscribeForThread",
  mcpCatalogSessionForThread: "mcpCatalog.sessionForThread",
  mcpCatalogOAuthStatus: "mcpCatalog.oauthStatus",
  mcpCatalogSecretPrepare: "mcpCatalog.secretPrepare",
  mcpCatalogRead: "mcpCatalog.read",
  mcpCatalogWrite: "mcpCatalog.write",
  mcpCatalogSessionGet: "mcpCatalog.sessionGet",
  mcpCatalogSessionReset: "mcpCatalog.sessionReset",
  mcpCatalogOAuthBegin: "mcpCatalog.oauthBegin",
  mcpCatalogOAuthContinue: "mcpCatalog.oauthContinue",
  mcpCatalogOAuthDisconnect: "mcpCatalog.oauthDisconnect",
  projectWorkRead: "projectWork.read",
  projectWorkWrite: "projectWork.write",
  projectWorkIssue: "projectWork.issue",
  projectWorkDelivery: "projectWork.delivery",
  assistantsRoutineRead: "assistants.routines.read",
  assistantsRoutineWrite: "assistants.routines.write",
  assistantsActivity: "assistants.activity",
  assistantsSubscribeRoster: "assistants.subscribeRoster",
  assistantsMemoryRead: "assistants.memory.read",
  assistantsMemoryWrite: "assistants.memory.write",
  assistantsCreate: "assistants.create",
  assistantsGet: "assistants.get",
  assistantsResolveThread: "assistants.resolveThread",
  threadHistoryList: "threadHistory.list",
  threadHistoryDetail: "threadHistory.detail",
  threadHistoryRecover: "threadHistory.recover",
  threadHistoryRestoreFiles: "threadHistory.restoreFiles",
  threadHistoryFileRestoreStatus: "threadHistory.fileRestoreStatus",
  threadHistoryRelease: "threadHistory.release",
  threadHistoryReconcile: "threadHistory.reconcile",
  assistantsList: "assistants.list",
  assistantsUpdateConfiguration: "assistants.updateConfiguration",
  assistantsLifecycle: "assistants.lifecycle",
  projectWorkSubscribe: "projectWork.subscribe",
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsListEntries: "projects.listEntries",
  projectsListIgnoredFiles: "projects.listIgnoredFiles",
  projectsReadFile: "projects.readFile",
  projectsSearchContents: "projects.searchContents",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsMutate: "projects.mutate",
  projectsEnsureScratch: "projects.ensureScratch",
  projectsCreateNew: "projects.createNew",

  shellOpenInEditor: "shell.openInEditor",

  filesystemBrowse: "filesystem.browse",
  filesystemGetMetadata: "filesystem.getMetadata",
  agentSessionsScan: "agentSessions.scan",
  agentSessionsImport: "agentSessions.import",
  assetsCreateUrl: "assets.createUrl",
  assetsPersistChatAttachments: "assets.persistChatAttachments",
  attachmentsCreateUploadUrl: "attachments.createUploadUrl",
  attachmentsDelete: "attachments.delete",

  mcpAppsCallTool: "mcpApps.callTool",
  mcpAppsToolInfo: "mcpApps.toolInfo",
  mcpAppsReadResource: "mcpApps.readResource",
  mcpAppsUpdateModelContext: "mcpApps.updateModelContext",

  providerUploadFeedback: "provider.uploadFeedback",
  providerAuthStart: "provider.auth.start",
  providerConsumeResetCredit: "provider.consumeResetCredit",
  providerAuthComplete: "provider.auth.complete",
  chatGptReconnectProfile: "provider.chatgpt.reconnect-profile",
  chatGptImportProfile: "provider.chatgpt.import-profile",
  chatGptHandoffSubscribe: "provider.chatgpt.handoff.subscribe",
  codexAuthCallbackSubscribe: "provider.codex.auth-callback.subscribe",
  providerAuthRespond: "provider.auth.respond",
  providerAuthCancel: "provider.auth.cancel",
  providerAuthLogout: "provider.auth.logout",
  providerAuthSubscribe: "provider.auth.subscribe",
  providerInstallStart: "provider.install.start",
  providerInstallCancel: "provider.install.cancel",
  providerInstallSubscribe: "provider.install.subscribe",
  providerInstallRemove: "provider.install.remove",

  vcsPull: "vcs.pull",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsInit: "vcs.init",

  gitDiscoverRepositories: "git.discoverRepositories",
  gitIndexStatus: "git.indexStatus",
  gitMutateIndex: "git.mutateIndex",
  gitCommitStaged: "git.commitStaged",
  gitHistory: "git.history",
  gitHistoryDiff: "git.historyDiff",
  gitRunStackedAction: "git.runStackedAction",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",

  skillsCatalogList: "skills.catalog.list",
  skillsCatalogSubscribe: "skills.catalog.subscribe",
  skillsContentGet: "skills.content.get",
  skillsHistoryList: "skills.history.list",
  skillsNativeContentGet: "skills.native.content.get",
  skillsApplicationGet: "skills.application.get",
  skillsDeploymentList: "skills.deployment.list",
  skillsDeploymentChange: "skills.deployment.change",
  skillsGlobalCreate: "skills.global.create",
  skillsGlobalUpdate: "skills.global.update",
  skillsGlobalDelete: "skills.global.delete",
  skillsGlobalRename: "skills.global.rename",
  skillsGlobalRollback: "skills.global.rollback",
  skillsProjectSetOverride: "skills.project.setOverride",
  skillsProjectSetDisabled: "skills.project.setDisabled",
  skillsProjectDeleteState: "skills.project.deleteState",
  skillsProjectRename: "skills.project.rename",
  skillsSessionSetEnabled: "skills.session.setEnabled",
  skillsSessionReset: "skills.session.reset",
  skillsNativeImport: "skills.native.import",
  managedTextResourcesCatalogList: "managedTextResources.catalog.list",
  managedTextResourcesCatalogSubscribe: "managedTextResources.catalog.subscribe",
  managedTextResourcesContentGet: "managedTextResources.content.get",
  managedTextResourcesEnvironmentCreate: "managedTextResources.environment.create",
  managedTextResourcesEnvironmentUpdate: "managedTextResources.environment.update",
  managedTextResourcesEnvironmentDelete: "managedTextResources.environment.delete",
  managedTextResourcesEnvironmentSetEnabled: "managedTextResources.environment.setEnabled",
  managedTextResourcesProjectSetOverride: "managedTextResources.project.setOverride",
  managedTextResourcesProjectSetDisabled: "managedTextResources.project.setDisabled",
  managedTextResourcesProjectDeleteState: "managedTextResources.project.deleteState",
  managedTextResourcesThreadSetEnabled: "managedTextResources.thread.setEnabled",
  managedTextResourcesThreadReset: "managedTextResources.thread.reset",
  projectTerminalAttach: "projectTerminal.attach",
  projectTerminalMetadata: "projectTerminal.metadata",
  projectTerminalList: "projectTerminal.list",
  projectTerminalWrite: "projectTerminal.write",
  projectTerminalResize: "projectTerminal.resize",
  projectTerminalKill: "projectTerminal.kill",
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalObserve: "terminal.observe",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  previewOpen: "preview.open",
  previewNavigate: "preview.navigate",
  previewResize: "preview.resize",
  previewAdjust: "preview.adjust",
  previewRefresh: "preview.refresh",
  previewClose: "preview.close",
  previewList: "preview.list",
  previewClearProfile: "preview.clearProfile",
  previewReportProfiles: "preview.reportProfiles",
  previewReportStatus: "preview.reportStatus",

  deviceConfigure: "device.configure",
  deviceList: "device.list",
  deviceTestHost: "device.testHost",
  deviceEasAccount: "device.easAccount",
  deviceOpen: "device.open",
  deviceClose: "device.close",
  deviceShutdown: "device.shutdown",
  deviceDetail: "device.detail",
  deviceAction: "device.action",

  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpdateProvider: "server.updateProvider",
  serverUpdateServer: "server.updateServer",
  serverUpdateServerWithProgress: "server.updateServerWithProgress",
  serverCommitDesktopUpdate: "server.commitDesktopUpdate",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverRemoveKeybinding: "server.removeKeybinding",
  serverRunStorageCleanup: "server.runStorageCleanup",
  serverGetStorageCleanupReport: "server.getStorageCleanupReport",
  serverGetDatabaseStorage: "server.getDatabaseStorage",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  serverTestExternalNotification: "server.testExternalNotification",
  serverDiscoverSourceControl: "server.discoverSourceControl",
  serverSearchAcpRegistry: "server.searchAcpRegistry",
  serverPrepareAcpRegistryAgent: "server.prepareAcpRegistryAgent",
  serverUninstallAcpRegistryManagedBinary: "server.uninstallAcpRegistryManagedBinary",
  serverAcceptAcpRegistryUrlAuth: "server.acceptAcpRegistryUrlAuth",
  serverListAcpRegistrySessions: "server.listAcpRegistrySessions",
  serverImportAcpRegistrySession: "server.importAcpRegistrySession",
  serverDeleteAcpRegistrySession: "server.deleteAcpRegistrySession",
  serverListAcpRegistryProviders: "server.listAcpRegistryProviders",
  serverSetAcpRegistryProvider: "server.setAcpRegistryProvider",
  serverDisableAcpRegistryProvider: "server.disableAcpRegistryProvider",
  serverLogoutAcpRegistry: "server.logoutAcpRegistry",
  serverGetTraceDiagnostics: "server.getTraceDiagnostics",
  serverGetProcessDiagnostics: "server.getProcessDiagnostics",
  serverGetHostResources: "server.getHostResources",
  serverGetProcessResourceHistory: "server.getProcessResourceHistory",
  serverGetResourceTelemetryHistory: "server.getResourceTelemetryHistory",
  serverRetryResourceTelemetry: "server.retryResourceTelemetry",
  serverCheckOtlpEndpoint: "server.checkOtlpEndpoint",
  serverSignalProcess: "server.signalProcess",
  serverReportClientActivity: "server.reportClientActivity",
  serverReportHostPowerState: "server.reportHostPowerState",
  serverGetBackgroundPolicy: "server.getBackgroundPolicy",
  serverGetUsageSummary: "server.getUsageSummary",
  serverRefreshUsageRates: "server.refreshUsageRates",

  scheduledTasksList: "scheduledTasks.list",
  scheduledTasksSubscribe: "scheduledTasks.subscribe",
  scheduledTasksUpsert: "scheduledTasks.upsert",
  scheduledTasksSetEnabled: "scheduledTasks.setEnabled",
  scheduledTasksDelete: "scheduledTasks.delete",
  scheduledTasksRunNow: "scheduledTasks.runNow",
  scheduledTasksRotateWebhookToken: "scheduledTasks.rotateWebhookToken",
  secretsAnswerRequest: "secrets.answerRequest",
  scheduledTasksListWebhookDeliveries: "scheduledTasks.listWebhookDeliveries",
  scheduledTasksGetWebhookDelivery: "scheduledTasks.getWebhookDelivery",

  cloudGetRelayClientStatus: "cloud.getRelayClientStatus",
  cloudInstallRelayClient: "cloud.installRelayClient",

  issuesSearch: "issues.search",
  pullRequestsList: "pullRequests.list",
  pullRequestsListStats: "pullRequests.listStats",
  pullRequestsSummary: "pullRequests.summary",
  pullRequestsRouting: "pullRequests.routing",
  pullRequestsRoutingIdentity: "pullRequests.routingIdentity",
  pullRequestsStack: "pullRequests.stack",
  pullRequestsLinkedThreads: "pullRequests.linkedThreads",
  pullRequestsDetail: "pullRequests.detail",
  pullRequestsPreview: "pullRequests.preview",
  pullRequestsChecks: "pullRequests.checks",
  pullRequestsActivity: "pullRequests.activity",
  pullRequestsReviewGuide: "pullRequests.reviewGuide",
  pullRequestsGenerateReviewGuide: "pullRequests.generateReviewGuide",
  pullRequestsThreadComments: "pullRequests.threadComments",
  pullRequestsDiffFileContents: "pullRequests.diffFileContents",
  pullRequestsFilesViewed: "pullRequests.filesViewed",
  pullRequestsChangeBreakdown: "pullRequests.changeBreakdown",
  pullRequestsSetFilesViewed: "pullRequests.setFilesViewed",
  pullRequestsRunAction: "pullRequests.runAction",
  pullRequestsUpdate: "pullRequests.update",
  pullRequestsComment: "pullRequests.comment",
  pullRequestsUpdateComment: "pullRequests.updateComment",
  pullRequestsSubmitReview: "pullRequests.submitReview",
  pullRequestsReplyToThread: "pullRequests.replyToThread",
  pullRequestsSetThreadResolution: "pullRequests.setThreadResolution",
  pullRequestsSetReaction: "pullRequests.setReaction",
  pullRequestsInvalidate: "pullRequests.invalidate",
  pullRequestsReportState: "pullRequests.reportState",
  pullRequestsSubscribeRefreshes: "pullRequests.subscribeRefreshes",
  pullRequestsReviewerCandidates: "pullRequests.reviewerCandidates",
  pullRequestsRequestReviewers: "pullRequests.requestReviewers",
  pullRequestsLabelCandidates: "pullRequests.labelCandidates",
  pullRequestsSetLabels: "pullRequests.setLabels",

  sourceControlLookupRepository: "sourceControl.lookupRepository",
  sourceControlCloneRepository: "sourceControl.cloneRepository",
  sourceControlPublishRepository: "sourceControl.publishRepository",
  projectCloneStart: "projectClone.start",
  projectCloneCancel: "projectClone.cancel",
  projectCloneRetry: "projectClone.retry",
  subscribeProjectClones: "subscribeProjectClones",

  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeWorktreeSetup: "subscribeWorktreeSetup",
  worktreeSetupCancel: "worktreeSetup.cancel",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribePreviewEvents: "subscribePreviewEvents",
  subscribeDiscoveredLocalServers: "subscribeDiscoveredLocalServers",
  subscribeDeviceState: "subscribeDeviceState",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
  subscribeBackgroundPolicy: "subscribeBackgroundPolicy",
  subscribeResourceTelemetry: "subscribeResourceTelemetry",
} as const;

const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerRemoveKeybindingRpc = Rpc.make(WS_METHODS.serverRemoveKeybinding, {
  payload: ServerRemoveKeybindingInput,
  success: ServerRemoveKeybindingResult,
  error: Schema.Union([KeybindingsConfigError, EnvironmentAuthorizationError]),
});

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
  error: EnvironmentAuthorizationError,
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({
    instanceId: Schema.optional(ProviderInstanceId),
    cwd: Schema.optional(TrimmedNonEmptyString),
    fresh: Schema.optional(Schema.Boolean),
    /** Explicit user request: bypass T3-owned caches and rediscover models.
     * Background status refreshes must not open agent sessions. */
    refreshModels: Schema.optional(Schema.Boolean),
  }),
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([EnvironmentAuthorizationError, ProviderSetupError]),
});

const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdatedPayload,
  error: Schema.Union([ServerProviderUpdateError, EnvironmentAuthorizationError]),
});

const ProviderSetupRpcError = Schema.Union([ProviderSetupError, EnvironmentAuthorizationError]);

const WsProviderConsumeResetCreditRpc = Rpc.make(WS_METHODS.providerConsumeResetCredit, {
  payload: ProviderConsumeResetCreditInput,
  success: ProviderConsumeResetCreditResult,
  error: Schema.Union([ProviderSetupError, UsageLimitSourceError, EnvironmentAuthorizationError]),
});

const WsProviderAuthStartRpc = Rpc.make(WS_METHODS.providerAuthStart, {
  payload: ProviderAuthStartInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthRespondRpc = Rpc.make(WS_METHODS.providerAuthRespond, {
  payload: ProviderAuthRespondInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthCompleteRpc = Rpc.make(WS_METHODS.providerAuthComplete, {
  payload: ProviderAuthCompleteInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsChatGptReconnectProfileRpc = Rpc.make(WS_METHODS.chatGptReconnectProfile, {
  payload: ChatGptReconnectProfileInput,
  success: Schema.NullOr(ChatGptReconnectProfile),
  error: ProviderSetupRpcError,
});
const WsChatGptImportProfileRpc = Rpc.make(WS_METHODS.chatGptImportProfile, {
  payload: ChatGptImportProfileInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});
const WsChatGptHandoffSubscribeRpc = Rpc.make(WS_METHODS.chatGptHandoffSubscribe, {
  payload: ChatGptHandoffInput,
  success: ChatGptHandoffState,
  error: ProviderSetupRpcError,
  stream: true,
});
const WsCodexAuthCallbackSubscribeRpc = Rpc.make(WS_METHODS.codexAuthCallbackSubscribe, {
  payload: CodexAuthCallbackInput,
  success: CodexAuthCallbackState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderAuthCancelRpc = Rpc.make(WS_METHODS.providerAuthCancel, {
  payload: ProviderAuthCancelInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthLogoutRpc = Rpc.make(WS_METHODS.providerAuthLogout, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
});

const WsProviderAuthSubscribeRpc = Rpc.make(WS_METHODS.providerAuthSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderAuthState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallStartRpc = Rpc.make(WS_METHODS.providerInstallStart, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallCancelRpc = Rpc.make(WS_METHODS.providerInstallCancel, {
  payload: ProviderInstallCancelInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsProviderInstallSubscribeRpc = Rpc.make(WS_METHODS.providerInstallSubscribe, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
  stream: true,
});

const WsProviderInstallRemoveRpc = Rpc.make(WS_METHODS.providerInstallRemove, {
  payload: ProviderSetupInput,
  success: ProviderInstallState,
  error: ProviderSetupRpcError,
});

const WsServerUpdateServerRpc = Rpc.make(WS_METHODS.serverUpdateServer, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerUpdateServerWithProgressRpc = Rpc.make(WS_METHODS.serverUpdateServerWithProgress, {
  payload: ServerSelfUpdateInput,
  success: ServerSelfUpdateProgressEvent,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerCommitDesktopUpdateRpc = Rpc.make(WS_METHODS.serverCommitDesktopUpdate, {
  payload: DesktopUpdateCommitInput,
  success: ServerSelfUpdateResult,
  error: Schema.Union([ServerSelfUpdateError, EnvironmentAuthorizationError]),
});

const WsServerRunStorageCleanupRpc = Rpc.make(WS_METHODS.serverRunStorageCleanup, {
  payload: Schema.Struct({}),
  success: StorageCleanupReport,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});
const WsServerGetStorageCleanupReportRpc = Rpc.make(WS_METHODS.serverGetStorageCleanupReport, {
  payload: Schema.Struct({}),
  success: Schema.NullOr(StorageCleanupReport),
  stream: true,
  error: EnvironmentAuthorizationError,
});

const WsServerGetDatabaseStorageRpc = Rpc.make(WS_METHODS.serverGetDatabaseStorage, {
  payload: Schema.Struct({}),
  success: Schema.NullOr(DatabaseStorageStatus),
  stream: true,
  error: EnvironmentAuthorizationError,
});

const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerTestExternalNotificationRpc = Rpc.make(WS_METHODS.serverTestExternalNotification, {
  payload: ExternalNotificationTestInput,
  success: ExternalNotificationTestResult,
  error: EnvironmentAuthorizationError,
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
  success: ServerSettings,
  error: Schema.Union([ServerSettingsError, EnvironmentAuthorizationError]),
});

const WsServerDiscoverSourceControlRpc = Rpc.make(WS_METHODS.serverDiscoverSourceControl, {
  payload: Schema.Struct({}),
  success: SourceControlDiscoveryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerSearchAcpRegistryRpc = Rpc.make(WS_METHODS.serverSearchAcpRegistry, {
  payload: AcpRegistrySearchInput,
  success: AcpRegistrySearchResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerPrepareAcpRegistryAgentRpc = Rpc.make(WS_METHODS.serverPrepareAcpRegistryAgent, {
  payload: AcpRegistryPrepareInput,
  success: AcpRegistryPrepareResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerUninstallAcpRegistryManagedBinaryRpc = Rpc.make(
  WS_METHODS.serverUninstallAcpRegistryManagedBinary,
  {
    payload: AcpRegistryManagedBinaryUninstallInput,
    success: AcpRegistryManagedBinaryUninstallResult,
    error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
  },
);

const WsServerAcceptAcpRegistryUrlAuthRpc = Rpc.make(WS_METHODS.serverAcceptAcpRegistryUrlAuth, {
  payload: AcpRegistryAcceptUrlAuthInput,
  success: AcpRegistryAcceptUrlAuthResult,
  error: EnvironmentAuthorizationError,
});

const WsServerListAcpRegistrySessionsRpc = Rpc.make(WS_METHODS.serverListAcpRegistrySessions, {
  payload: AcpRegistryListSessionsInput,
  success: AcpRegistryListSessionsResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerImportAcpRegistrySessionRpc = Rpc.make(WS_METHODS.serverImportAcpRegistrySession, {
  payload: AcpRegistryImportSessionInput,
  success: AcpRegistryImportSessionResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerDeleteAcpRegistrySessionRpc = Rpc.make(WS_METHODS.serverDeleteAcpRegistrySession, {
  payload: AcpRegistryDeleteSessionInput,
  success: AcpRegistryDeleteSessionResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerListAcpRegistryProvidersRpc = Rpc.make(WS_METHODS.serverListAcpRegistryProviders, {
  payload: AcpRegistryListProvidersInput,
  success: AcpRegistryListProvidersResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerSetAcpRegistryProviderRpc = Rpc.make(WS_METHODS.serverSetAcpRegistryProvider, {
  payload: AcpRegistrySetProviderInput,
  success: AcpRegistrySetProviderResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerDisableAcpRegistryProviderRpc = Rpc.make(
  WS_METHODS.serverDisableAcpRegistryProvider,
  {
    payload: AcpRegistryDisableProviderInput,
    success: AcpRegistryDisableProviderResult,
    error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
  },
);

const WsServerLogoutAcpRegistryRpc = Rpc.make(WS_METHODS.serverLogoutAcpRegistry, {
  payload: AcpRegistryLogoutInput,
  success: AcpRegistryLogoutResult,
  error: Schema.Union([AcpRegistryOperationError, EnvironmentAuthorizationError]),
});

const WsServerGetTraceDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetTraceDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerTraceDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetProcessDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerProcessDiagnosticsResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetHostResourcesRpc = Rpc.make(WS_METHODS.serverGetHostResources, {
  payload: Schema.Struct({}),
  success: HostResourcesSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetProcessResourceHistoryRpc = Rpc.make(WS_METHODS.serverGetProcessResourceHistory, {
  payload: ServerProcessResourceHistoryInput,
  success: ServerProcessResourceHistoryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetResourceTelemetryHistoryRpc = Rpc.make(
  WS_METHODS.serverGetResourceTelemetryHistory,
  {
    payload: ResourceTelemetryHistoryInput,
    success: ResourceTelemetryHistory,
    error: EnvironmentAuthorizationError,
  },
);

const WsServerRetryResourceTelemetryRpc = Rpc.make(WS_METHODS.serverRetryResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetryRetryResult,
  error: EnvironmentAuthorizationError,
});

const WsServerCheckOtlpEndpointRpc = Rpc.make(WS_METHODS.serverCheckOtlpEndpoint, {
  payload: OtlpEndpointCheckInput,
  success: OtlpEndpointCheckResult,
  error: EnvironmentAuthorizationError,
});

const WsServerGetUsageSummaryRpc = Rpc.make(WS_METHODS.serverGetUsageSummary, {
  payload: UsageSummaryInput,
  success: UsageSummary,
  error: Schema.Union([EnvironmentAuthorizationError, UsageReadError]),
});

const WsServerRefreshUsageRatesRpc = Rpc.make(WS_METHODS.serverRefreshUsageRates, {
  payload: Schema.Struct({}),
  success: UsagePricing,
  error: EnvironmentAuthorizationError,
});

const WsServerSignalProcessRpc = Rpc.make(WS_METHODS.serverSignalProcess, {
  payload: ServerSignalProcessInput,
  success: ServerSignalProcessResult,
  error: EnvironmentAuthorizationError,
});

const WsCloudGetRelayClientStatusRpc = Rpc.make(WS_METHODS.cloudGetRelayClientStatus, {
  payload: Schema.Struct({}),
  success: RelayClientStatusSchema,
  error: EnvironmentAuthorizationError,
});

const WsCloudInstallRelayClientRpc = Rpc.make(WS_METHODS.cloudInstallRelayClient, {
  payload: Schema.Struct({}),
  success: RelayClientInstallProgressEventSchema,
  error: Schema.Union([RelayClientInstallFailedError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsServerReportClientActivityRpc = Rpc.make(WS_METHODS.serverReportClientActivity, {
  payload: ClientActivityReportInput,
  error: EnvironmentAuthorizationError,
});

const WsServerReportHostPowerStateRpc = Rpc.make(WS_METHODS.serverReportHostPowerState, {
  payload: HostPowerSnapshot,
  error: EnvironmentAuthorizationError,
});

const WsServerGetBackgroundPolicyRpc = Rpc.make(WS_METHODS.serverGetBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
});

const PullRequestRpcError = Schema.Union([
  PullRequestUnavailableError,
  PullRequestOperationError,
  EnvironmentAuthorizationError,
]);

export const WsIssuesSearchRpc = Rpc.make(WS_METHODS.issuesSearch, {
  payload: IssueSearchInput,
  success: IssueSearchResult,
  error: PullRequestRpcError,
});

const WsPullRequestsListRpc = Rpc.make(WS_METHODS.pullRequestsList, {
  payload: PullRequestListInput,
  success: PullRequestListResult,
  error: PullRequestRpcError,
});

/**
 * The line counts for rows already on the page. Its own call because on GitHub the pair costs
 * 40-60% of the listing read that answers everything else on the row, so the rows arrive first
 * and their stats a moment later.
 */
const WsPullRequestsListStatsRpc = Rpc.make(WS_METHODS.pullRequestsListStats, {
  payload: PullRequestListStatsInput,
  success: PullRequestListStatsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingRpc = Rpc.make(WS_METHODS.pullRequestsRouting, {
  payload: PullRequestRef,
  success: PullRequestRoutingResult,
  error: PullRequestRpcError,
});

const WsPullRequestsRoutingIdentityRpc = Rpc.make(WS_METHODS.pullRequestsRoutingIdentity, {
  payload: PullRequestRoutingIdentityInput,
  success: PullRequestRoutingIdentityResult,
  error: PullRequestRpcError,
});

const WsPullRequestsSummaryRpc = Rpc.make(WS_METHODS.pullRequestsSummary, {
  payload: PullRequestRef,
  success: PullRequestSummary,
  error: PullRequestRpcError,
});

const WsPullRequestsStackRpc = Rpc.make(WS_METHODS.pullRequestsStack, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestStack),
  error: PullRequestRpcError,
});

const WsPullRequestsLinkedThreadsRpc = Rpc.make(WS_METHODS.pullRequestsLinkedThreads, {
  payload: PullRequestRef,
  success: PullRequestLinkedThreadsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestRef,
  success: PullRequestDetail,
  error: PullRequestRpcError,
});

const WsPullRequestsPreviewRpc = Rpc.make(WS_METHODS.pullRequestsPreview, {
  payload: PullRequestRef,
  success: PullRequestPreview,
  error: PullRequestRpcError,
});

const WsPullRequestsChecksRpc = Rpc.make(WS_METHODS.pullRequestsChecks, {
  payload: PullRequestRef,
  success: Schema.NullOr(PullRequestChecks),
  error: PullRequestRpcError,
});

const WsPullRequestsActivityRpc = Rpc.make(WS_METHODS.pullRequestsActivity, {
  payload: PullRequestRef,
  success: PullRequestActivity,
  error: PullRequestRpcError,
});

const WsPullRequestsReviewGuideRpc = Rpc.make(WS_METHODS.pullRequestsReviewGuide, {
  payload: PullRequestRef,
  success: PullRequestReviewGuideResult,
  error: PullRequestRpcError,
});

const WsPullRequestsGenerateReviewGuideRpc = Rpc.make(WS_METHODS.pullRequestsGenerateReviewGuide, {
  payload: PullRequestRef,
  success: PullRequestReviewGuideResult,
  error: PullRequestRpcError,
});

const WsPullRequestsThreadCommentsRpc = Rpc.make(WS_METHODS.pullRequestsThreadComments, {
  payload: PullRequestThreadCommentsInput,
  success: PullRequestThreadCommentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsDiffFileContentsRpc = Rpc.make(WS_METHODS.pullRequestsDiffFileContents, {
  payload: PullRequestDiffFileContentsInput,
  success: PullRequestDiffFileContentsResult,
  error: PullRequestRpcError,
});

const WsPullRequestsFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsFilesViewed, {
  payload: PullRequestRef,
  success: PullRequestFilesViewedResult,
  error: PullRequestRpcError,
});

const WsPullRequestsChangeBreakdownRpc = Rpc.make(WS_METHODS.pullRequestsChangeBreakdown, {
  payload: PullRequestRef,
  success: PullRequestChangeBreakdown,
  error: PullRequestRpcError,
});

const WsPullRequestsSetFilesViewedRpc = Rpc.make(WS_METHODS.pullRequestsSetFilesViewed, {
  payload: PullRequestSetFilesViewedInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsRunActionRpc = Rpc.make(WS_METHODS.pullRequestsRunAction, {
  payload: PullRequestActionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateRpc = Rpc.make(WS_METHODS.pullRequestsUpdate, {
  payload: PullRequestUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsUpdateCommentRpc = Rpc.make(WS_METHODS.pullRequestsUpdateComment, {
  payload: PullRequestCommentUpdateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubmitReviewRpc = Rpc.make(WS_METHODS.pullRequestsSubmitReview, {
  payload: PullRequestSubmitReviewInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReplyToThreadRpc = Rpc.make(WS_METHODS.pullRequestsReplyToThread, {
  payload: PullRequestThreadReplyInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetThreadResolutionRpc = Rpc.make(WS_METHODS.pullRequestsSetThreadResolution, {
  payload: PullRequestThreadResolutionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSetReactionRpc = Rpc.make(WS_METHODS.pullRequestsSetReaction, {
  payload: PullRequestReactionInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsInvalidateRpc = Rpc.make(WS_METHODS.pullRequestsInvalidate, {
  payload: PullRequestInvalidateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsReportStateRpc = Rpc.make(WS_METHODS.pullRequestsReportState, {
  payload: PullRequestReportStateInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsSubscribeRefreshesRpc = Rpc.make(WS_METHODS.pullRequestsSubscribeRefreshes, {
  payload: Schema.Struct({}),
  success: NonNegativeInt,
  error: EnvironmentAuthorizationError,
  stream: true,
});

/**
 * Read on its own rather than as part of the detail: the people who may be asked are only wanted
 * once somebody opens the menu, and reading them with every change request would spend a request
 * per host on a list nobody looked at.
 */
const WsPullRequestsReviewerCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsReviewerCandidates, {
  payload: PullRequestRef,
  success: PullRequestReviewerCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsRequestReviewersRpc = Rpc.make(WS_METHODS.pullRequestsRequestReviewers, {
  payload: PullRequestReviewerRequestInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsPullRequestsLabelCandidatesRpc = Rpc.make(WS_METHODS.pullRequestsLabelCandidates, {
  payload: PullRequestRef,
  success: PullRequestLabelCandidateList,
  error: PullRequestRpcError,
});

const WsPullRequestsSetLabelsRpc = Rpc.make(WS_METHODS.pullRequestsSetLabels, {
  payload: PullRequestLabelChangeInput,
  success: Schema.Void,
  error: PullRequestRpcError,
});

const WsSourceControlLookupRepositoryRpc = Rpc.make(WS_METHODS.sourceControlLookupRepository, {
  payload: SourceControlRepositoryLookupInput,
  success: SourceControlRepositoryInfo,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSourceControlCloneRepositoryRpc = Rpc.make(WS_METHODS.sourceControlCloneRepository, {
  payload: SourceControlCloneRepositoryInput,
  success: SourceControlCloneRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

// Clone-backed project creation. `start` returns once the project exists and
// the clone is running; progress arrives on the subscription.
const WsProjectCloneStartRpc = Rpc.make(WS_METHODS.projectCloneStart, {
  payload: ProjectCloneStartInput,
  success: ProjectCloneStartResult,
  error: Schema.Union([
    SourceControlRepositoryError,
    OrchestrationDispatchCommandError,
    EnvironmentAuthorizationError,
  ]),
});

const WsProjectCloneCancelRpc = Rpc.make(WS_METHODS.projectCloneCancel, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: EnvironmentAuthorizationError,
});

const WsProjectCloneRetryRpc = Rpc.make(WS_METHODS.projectCloneRetry, {
  payload: ProjectCloneActionInput,
  success: ProjectCloneActionResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsSubscribeProjectClonesRpc = Rpc.make(WS_METHODS.subscribeProjectClones, {
  payload: ProjectCloneSubscribeInput,
  success: ProjectCloneListEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSourceControlPublishRepositoryRpc = Rpc.make(WS_METHODS.sourceControlPublishRepository, {
  payload: SourceControlPublishRepositoryInput,
  success: SourceControlPublishRepositoryResult,
  error: Schema.Union([SourceControlRepositoryError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: Schema.Union([ProjectSearchEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsSearchContentsRpc = Rpc.make(WS_METHODS.projectsSearchContents, {
  payload: ProjectSearchContentsInput,
  success: ProjectSearchContentsResult,
  error: Schema.Union([ProjectSearchContentsError, EnvironmentAuthorizationError]),
});

const WsProjectsListEntriesRpc = Rpc.make(WS_METHODS.projectsListEntries, {
  payload: ProjectListEntriesInput,
  success: ProjectListEntriesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsListIgnoredFilesRpc = Rpc.make(WS_METHODS.projectsListIgnoredFiles, {
  payload: ProjectListIgnoredFilesInput,
  success: ProjectListIgnoredFilesResult,
  error: Schema.Union([ProjectListEntriesError, EnvironmentAuthorizationError]),
});

const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: Schema.Union([ProjectReadFileError, EnvironmentAuthorizationError]),
});

const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: Schema.Union([ProjectWriteFileError, EnvironmentAuthorizationError]),
});

const WsProjectsMutateRpc = Rpc.make(WS_METHODS.projectsMutate, {
  payload: ProjectMutation,
  success: Project,
  error: Schema.Union([ProjectMutationError, EnvironmentAuthorizationError]),
});

const WsProjectsEnsureScratchRpc = Rpc.make(WS_METHODS.projectsEnsureScratch, {
  payload: Schema.Struct({}),
  success: ProjectEnsureScratchResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsProjectsCreateNewRpc = Rpc.make(WS_METHODS.projectsCreateNew, {
  payload: ProjectCreateNewInput,
  success: ProjectCreateNewResult,
  error: Schema.Union([OrchestrationDispatchCommandError, EnvironmentAuthorizationError]),
});

const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: LaunchEditorInput,
  error: Schema.Union([ExternalLauncherError, EnvironmentAuthorizationError]),
});

const WsFilesystemGetMetadataRpc = Rpc.make(WS_METHODS.filesystemGetMetadata, {
  payload: FilesystemGetMetadataInput,
  success: FilesystemGetMetadataResult,
  error: EnvironmentAuthorizationError,
});

const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: Schema.Union([FilesystemBrowseError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsScanRpc = Rpc.make(WS_METHODS.agentSessionsScan, {
  payload: AgentSessionScanInput,
  success: AgentSessionScanResult,
  error: Schema.Union([AgentSessionScanError, EnvironmentAuthorizationError]),
});

const WsAgentSessionsImportRpc = Rpc.make(WS_METHODS.agentSessionsImport, {
  payload: AgentSessionImportInput,
  success: AgentSessionImportResult,
  error: Schema.Union([
    AgentSessionImportProjectChangedError,
    AgentSessionImportProjectNotFoundError,
    AgentSessionScanError,
    EnvironmentAuthorizationError,
  ]),
});

const WsAssetsCreateUrlRpc = Rpc.make(WS_METHODS.assetsCreateUrl, {
  payload: AssetCreateUrlInput,
  success: AssetCreateUrlResult,
  error: Schema.Union([AssetAccessError, EnvironmentAuthorizationError]),
});

const WsAssetsPersistChatAttachmentsRpc = Rpc.make(WS_METHODS.assetsPersistChatAttachments, {
  payload: PersistChatAttachmentsInput,
  success: PersistChatAttachmentsResult,
  error: Schema.Union([PersistChatAttachmentsError, EnvironmentAuthorizationError]),
});

const WsAttachmentsCreateUploadUrlRpc = Rpc.make(WS_METHODS.attachmentsCreateUploadUrl, {
  payload: AttachmentCreateUploadUrlInput,
  success: AttachmentCreateUploadUrlResult,
  error: Schema.Union([AttachmentUploadSigningKeyError, EnvironmentAuthorizationError]),
});

const WsAttachmentsDeleteRpc = Rpc.make(WS_METHODS.attachmentsDelete, {
  payload: AttachmentDeleteInput,
  error: EnvironmentAuthorizationError,
});

const WsMcpAppsCallToolRpc = Rpc.make(WS_METHODS.mcpAppsCallTool, {
  payload: McpAppCallToolInput,
  success: McpAppCallToolResult,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsToolInfoRpc = Rpc.make(WS_METHODS.mcpAppsToolInfo, {
  payload: McpAppToolInfoInput,
  success: McpAppToolInfo,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsUpdateModelContextRpc = Rpc.make(WS_METHODS.mcpAppsUpdateModelContext, {
  payload: McpAppUpdateModelContextInput,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsMcpAppsReadResourceRpc = Rpc.make(WS_METHODS.mcpAppsReadResource, {
  payload: McpAppReadResourceInput,
  success: McpAppReadResourceResult,
  error: Schema.Union([McpAppRequestError, EnvironmentAuthorizationError]),
});

const WsProviderUploadFeedbackRpc = Rpc.make(WS_METHODS.providerUploadFeedback, {
  payload: ProviderUploadFeedbackInput,
  success: ProviderUploadFeedbackResult,
  error: Schema.Union([ProviderUploadFeedbackError, EnvironmentAuthorizationError]),
});

const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusSubscriptionInput,
  success: VcsStatusStreamEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsVcsPullRpc = Rpc.make(WS_METHODS.vcsPull, {
  payload: VcsPullInput,
  success: VcsPullResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsSubscribeWorktreeSetupRpc = Rpc.make(WS_METHODS.subscribeWorktreeSetup, {
  payload: WorktreeSetupSubscribeInput,
  success: WorktreeSetupStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsWorktreeSetupCancelRpc = Rpc.make(WS_METHODS.worktreeSetupCancel, {
  payload: WorktreeSetupCancelInput,
  success: WorktreeSetupCancelResult,
  error: EnvironmentAuthorizationError,
});

const WsGitDiscoverRepositoriesRpc = Rpc.make(WS_METHODS.gitDiscoverRepositories, {
  payload: GitDiscoverRepositoriesInput,
  success: GitDiscoverRepositoriesResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsGitIndexStatusRpc = Rpc.make(WS_METHODS.gitIndexStatus, {
  payload: GitIndexStatusInput,
  success: GitIndexStatusResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsGitMutateIndexRpc = Rpc.make(WS_METHODS.gitMutateIndex, {
  payload: GitMutateIndexInput,
  success: GitIndexStatusResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsGitCommitStagedRpc = Rpc.make(WS_METHODS.gitCommitStaged, {
  payload: GitCommitStagedInput,
  success: GitCommitStagedResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsGitHistoryRpc = Rpc.make(WS_METHODS.gitHistory, {
  payload: GitHistoryInput,
  success: GitHistoryResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsGitHistoryDiffRpc = Rpc.make(WS_METHODS.gitHistoryDiff, {
  payload: GitHistoryDiffInput,
  success: GitHistoryDiffResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: Schema.Union([GitManagerServiceError, EnvironmentAuthorizationError]),
});

const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  // Clients cannot choose the folder: new worktrees go in the server's managed
  // worktrees folder. `path` stays a required null because older servers
  // require the key.
  payload: Schema.Struct({
    ...VcsCreateWorktreeInput.fields,
    path: Schema.Null,
  }),
  success: VcsCreateWorktreeResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: Schema.Union([GitCommandError, EnvironmentAuthorizationError]),
});

const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: Schema.Union([VcsError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: Schema.Union([ReviewDiffPreviewError, EnvironmentAuthorizationError]),
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalObserveRpc = Rpc.make(WS_METHODS.terminalObserve, {
  payload: TerminalObserveInput,
  success: TerminalAttachStreamEvent,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: Schema.Union([TerminalError, EnvironmentAuthorizationError]),
});

const WsPreviewOpenRpc = Rpc.make(WS_METHODS.previewOpen, {
  payload: PreviewOpenInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewNavigateRpc = Rpc.make(WS_METHODS.previewNavigate, {
  payload: PreviewNavigateInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewResizeRpc = Rpc.make(WS_METHODS.previewResize, {
  payload: PreviewResizeInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewAdjustRpc = Rpc.make(WS_METHODS.previewAdjust, {
  payload: PreviewAdjustInput,
  success: PreviewSessionSnapshot,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewRefreshRpc = Rpc.make(WS_METHODS.previewRefresh, {
  payload: PreviewRefreshInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewCloseRpc = Rpc.make(WS_METHODS.previewClose, {
  payload: PreviewCloseInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsPreviewListRpc = Rpc.make(WS_METHODS.previewList, {
  payload: PreviewListInput,
  success: PreviewListResult,
  error: EnvironmentAuthorizationError,
});

const WsPreviewClearProfileRpc = Rpc.make(WS_METHODS.previewClearProfile, {
  payload: PreviewClearProfileInput,
  error: Schema.Union([PreviewClearProfileError, EnvironmentAuthorizationError]),
});

const WsPreviewReportProfilesRpc = Rpc.make(WS_METHODS.previewReportProfiles, {
  payload: PreviewReportProfilesInput,
  error: EnvironmentAuthorizationError,
});

const WsPreviewReportStatusRpc = Rpc.make(WS_METHODS.previewReportStatus, {
  payload: PreviewReportStatusInput,
  error: Schema.Union([PreviewError, EnvironmentAuthorizationError]),
});

const WsSubscribePreviewEventsRpc = Rpc.make(WS_METHODS.subscribePreviewEvents, {
  payload: Schema.Struct({}),
  success: PreviewEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeDiscoveredLocalServersRpc = Rpc.make(WS_METHODS.subscribeDiscoveredLocalServers, {
  payload: Schema.Struct({
    configuredUrls: Schema.optional(ConfiguredLocalServerUrls),
  }),
  success: DiscoveredLocalServerList,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsDeviceTestHostRpc = Rpc.make(WS_METHODS.deviceTestHost, {
  payload: SshDeviceHostConfig,
  success: DeviceHostSummary,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceEasAccountRpc = Rpc.make(WS_METHODS.deviceEasAccount, {
  payload: DeviceEasAccountInput,
  success: DeviceEasAccount,
  error: Schema.Union([DeviceEasAccountError, EnvironmentAuthorizationError]),
});

const WsDeviceListRpc = Rpc.make(WS_METHODS.deviceList, {
  payload: DeviceListInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceConfigureRpc = Rpc.make(WS_METHODS.deviceConfigure, {
  payload: DeviceConfigureInput,
  success: DeviceServiceState,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceOpenRpc = Rpc.make(WS_METHODS.deviceOpen, {
  payload: DeviceOpenInput,
  success: DeviceSession,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceCloseRpc = Rpc.make(WS_METHODS.deviceClose, {
  payload: DeviceCloseInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceShutdownRpc = Rpc.make(WS_METHODS.deviceShutdown, {
  payload: DeviceShutdownInput,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceDetailRpc = Rpc.make(WS_METHODS.deviceDetail, {
  payload: DeviceDetailInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsDeviceActionRpc = Rpc.make(WS_METHODS.deviceAction, {
  payload: DeviceActionInput,
  success: DeviceDetail,
  error: Schema.Union([DeviceError, EnvironmentAuthorizationError]),
});

const WsSubscribeDeviceStateRpc = Rpc.make(WS_METHODS.subscribeDeviceState, {
  payload: Schema.Struct({}),
  success: DeviceServiceState,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsOrchestrationV2DispatchCommandRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
  payload: OrchestrationV2RpcSchemas.dispatchCommand.input,
  success: OrchestrationV2RpcSchemas.dispatchCommand.output,
  error: Schema.Union([OrchestrationV2DispatchCommandError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetTurnDiffRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnDiff, {
  payload: OrchestrationV2RpcSchemas.getTurnDiff.input,
  success: OrchestrationV2RpcSchemas.getTurnDiff.output,
  error: Schema.Union([OrchestrationGetTurnDiffError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationV2RpcSchemas.getFullThreadDiff.input,
    success: OrchestrationV2RpcSchemas.getFullThreadDiff.output,
    error: Schema.Union([OrchestrationGetFullThreadDiffError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2SearchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.searchThread, {
  payload: OrchestrationV2SearchThreadInput,
  success: OrchestrationV2SearchThreadResult,
  error: Schema.Union([OrchestrationV2SearchThreadError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SearchThreadStreamRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  {
    payload: OrchestrationV2SearchThreadInput,
    success: OrchestrationV2SearchThreadResult,
    error: Schema.Union([OrchestrationV2SearchThreadError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsOrchestrationV2SearchThreadsRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationSearchThreadsResult,
  error: Schema.Union([OrchestrationSearchThreadsError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationV2RpcSchemas.getArchivedShellSnapshot.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetThreadProjectionRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  {
    payload: OrchestrationV2RpcSchemas.getThreadProjection.input,
    success: OrchestrationV2RpcSchemas.getThreadProjection.output,
    error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2StopWorkflowRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.stopWorkflow, {
  payload: OrchestrationV2RpcSchemas.stopWorkflow.input,
  success: OrchestrationV2RpcSchemas.stopWorkflow.output,
  error: Schema.Union([OrchestrationV2StopWorkflowError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2GetWorkflowScriptRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
  {
    payload: OrchestrationV2RpcSchemas.getWorkflowScript.input,
    success: OrchestrationV2RpcSchemas.getWorkflowScript.output,
    error: Schema.Union([OrchestrationGetWorkflowScriptError, EnvironmentAuthorizationError]),
  },
);

const WsOrchestrationV2GetTurnItemRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.getTurnItem, {
  payload: OrchestrationV2RpcSchemas.getTurnItem.input,
  success: OrchestrationV2RpcSchemas.getTurnItem.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2LaunchThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.launchThread, {
  payload: OrchestrationV2RpcSchemas.launchThread.input,
  success: OrchestrationV2RpcSchemas.launchThread.output,
  error: Schema.Union([OrchestrationV2ThreadLaunchError, EnvironmentAuthorizationError]),
});

const WsOrchestrationV2SubscribeArchivedShellRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell,
  {
    payload: OrchestrationV2RpcSchemas.subscribeArchivedShell.input,
    success: OrchestrationV2RpcSchemas.subscribeArchivedShell.output,
    error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsOrchestrationV2SubscribeShellRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeShell, {
  payload: OrchestrationV2RpcSchemas.subscribeShell.input,
  success: OrchestrationV2RpcSchemas.subscribeShell.output,
  error: Schema.Union([OrchestrationV2GetShellSnapshotError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeThreadRpc = Rpc.make(ORCHESTRATION_V2_WS_METHODS.subscribeThread, {
  payload: OrchestrationV2RpcSchemas.subscribeThread.input,
  success: OrchestrationV2RpcSchemas.subscribeThread.output,
  error: Schema.Union([OrchestrationV2GetThreadProjectionError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsOrchestrationV2SubscribeCommandOutputRpc = Rpc.make(
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  {
    payload: OrchestrationV2RpcSchemas.subscribeCommandOutput.input,
    success: OrchestrationV2RpcSchemas.subscribeCommandOutput.output,
    error: Schema.Union([OrchestrationV2CommandOutputError, EnvironmentAuthorizationError]),
    stream: true,
  },
);

const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({
    /**
     * Already-shipped clients decode the stream against the old event union and
     * would die on an unknown member, so the server emits the theme stream only
     * to subscribers that ask for it.
     */
    environmentThemes: Schema.optional(Schema.Boolean),
    usageLimitSources: Schema.optional(Schema.Boolean),
    /**
     * Whether this client answers `/usage-limits` itself. The server injects
     * that command into provider catalogs only for such clients; an older
     * client would send it to the provider as an ordinary prompt.
     */
    usageLimitsCommand: Schema.optional(Schema.Boolean),
  }),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsThreadHistoryListRpc = Rpc.make(WS_METHODS.threadHistoryList, {
  payload: ThreadHistoryListInput,
  success: ThreadHistoryListResult,
  error: Schema.Union([ThreadHistoryRpcError, EnvironmentAuthorizationError]),
});
const WsThreadHistoryDetailRpc = Rpc.make(WS_METHODS.threadHistoryDetail, {
  payload: ThreadHistoryDetailInput,
  success: ThreadHistoryDetailResult,
  error: Schema.Union([ThreadHistoryRpcError, EnvironmentAuthorizationError]),
});
const WsThreadHistoryRecoverRpc = Rpc.make(WS_METHODS.threadHistoryRecover, {
  payload: ThreadHistoryRecoverInput,
  success: ThreadHistoryRecoveryResult,
  error: Schema.Union([ThreadHistoryRpcError, EnvironmentAuthorizationError]),
});
const WsThreadHistoryRestoreFilesRpc = Rpc.make(WS_METHODS.threadHistoryRestoreFiles, {
  payload: ThreadHistoryRestoreFilesInput,
  success: ThreadHistoryRestoreFilesResult,
  error: Schema.Union([ThreadHistoryRpcError, EnvironmentAuthorizationError]),
});
const WsThreadHistoryFileRestoreStatusRpc = Rpc.make(WS_METHODS.threadHistoryFileRestoreStatus, {
  payload: ThreadHistoryFileRestoreStatusInput,
  success: ThreadHistoryFileRestoreStatusResult,
  error: Schema.Union([ThreadHistoryRpcError, EnvironmentAuthorizationError]),
});
const WsThreadHistoryReleaseRpc = Rpc.make(WS_METHODS.threadHistoryRelease, {
  payload: ThreadHistoryArchiveIdentity,
  success: Schema.Void,
  error: Schema.Union([ThreadHistoryRpcError, EnvironmentAuthorizationError]),
});
const WsThreadHistoryReconcileRpc = Rpc.make(WS_METHODS.threadHistoryReconcile, {
  payload: ThreadHistoryReconcileInput,
  success: ThreadHistoryReconcileResult,
  error: Schema.Union([ThreadHistoryRpcError, EnvironmentAuthorizationError]),
});

const WsAssistantsMemoryReadRpc = Rpc.make(WS_METHODS.assistantsMemoryRead, {
  payload: AssistantMemoryReadInput,
  success: AssistantMemoryReadResult,
  error: Schema.Union([AssistantMemoryRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsMemoryWriteRpc = Rpc.make(WS_METHODS.assistantsMemoryWrite, {
  payload: AssistantMemoryWriteInput,
  success: AssistantMemoryWriteResult,
  error: Schema.Union([AssistantMemoryRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsRoutineReadRpc = Rpc.make(WS_METHODS.assistantsRoutineRead, {
  payload: AssistantRoutineReadInput,
  success: AssistantRoutineReadResult,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsRoutineWriteRpc = Rpc.make(WS_METHODS.assistantsRoutineWrite, {
  payload: AssistantRoutineWriteInput,
  success: AssistantRoutineWriteResult,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsActivityRpc = Rpc.make(WS_METHODS.assistantsActivity, {
  payload: AssistantActivityListInput,
  success: AssistantRunListResult,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsSubscribeRosterRpc = Rpc.make(WS_METHODS.assistantsSubscribeRoster, {
  payload: AssistantListInput,
  success: AssistantListResult,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
  stream: true,
});
const WsAssistantsCreateRpc = Rpc.make(WS_METHODS.assistantsCreate, {
  payload: AssistantCreateInput,
  success: AssistantDetail,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsResolveThreadRpc = Rpc.make(WS_METHODS.assistantsResolveThread, {
  payload: AssistantResolveThreadInput,
  success: AssistantResolveThreadResult,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsGetRpc = Rpc.make(WS_METHODS.assistantsGet, {
  payload: AssistantGetInput,
  success: AssistantDetail,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsListRpc = Rpc.make(WS_METHODS.assistantsList, {
  payload: AssistantListInput,
  success: AssistantListResult,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsUpdateConfigurationRpc = Rpc.make(WS_METHODS.assistantsUpdateConfiguration, {
  payload: AssistantUpdateConfigurationInput,
  success: AssistantDetail,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsAssistantsLifecycleRpc = Rpc.make(WS_METHODS.assistantsLifecycle, {
  payload: AssistantLifecycleInput,
  success: AssistantDetail,
  error: Schema.Union([AssistantRpcError, EnvironmentAuthorizationError]),
});
const WsProjectWorkIssueRpc = Rpc.make(WS_METHODS.projectWorkIssue, {
  payload: ProjectIssueRequest,
  success: Schema.Unknown,
  error: Schema.Union([ProjectWorkRpcError, EnvironmentAuthorizationError]),
});
const WsProjectWorkDeliveryRpc = Rpc.make(WS_METHODS.projectWorkDelivery, {
  payload: ProjectWorkDeliveryRequest,
  success: ProjectWorkDeliveryResult,
  error: Schema.Union([ProjectWorkRpcError, EnvironmentAuthorizationError]),
});
const catalogRpcError = Schema.Union([McpCatalogMutationError, EnvironmentAuthorizationError]);
const WsMcpCatalogSessionSubscribeForThreadRpc = Rpc.make(
  WS_METHODS.mcpCatalogSessionSubscribeForThread,
  {
    payload: McpCatalogSessionForThreadInput,
    success: McpCatalogSessionForThreadResult,
    error: catalogRpcError,
    stream: true,
  },
);
const WsMcpCatalogSessionForThreadRpc = Rpc.make(WS_METHODS.mcpCatalogSessionForThread, {
  payload: McpCatalogSessionForThreadInput,
  success: McpCatalogSessionForThreadResult,
  error: catalogRpcError,
});
const WsMcpCatalogOAuthStatusRpc = Rpc.make(WS_METHODS.mcpCatalogOAuthStatus, {
  payload: McpCatalogOAuthTarget,
  success: McpCatalogOAuthStatusResult,
  error: catalogRpcError,
});
const WsMcpCatalogSecretPrepareRpc = Rpc.make(WS_METHODS.mcpCatalogSecretPrepare, {
  payload: McpCatalogSecretPrepareInput,
  success: McpCatalogSecretPrepareResult,
  error: catalogRpcError,
});
const WsMcpCatalogReadRpc = Rpc.make(WS_METHODS.mcpCatalogRead, {
  payload: McpCatalogReadInput,
  success: McpCatalogReadResult,
  error: catalogRpcError,
});
const WsMcpCatalogWriteRpc = Rpc.make(WS_METHODS.mcpCatalogWrite, {
  payload: McpCatalogWriteInput,
  success: McpCatalogReadResult,
  error: catalogRpcError,
});
const WsMcpCatalogSessionGetRpc = Rpc.make(WS_METHODS.mcpCatalogSessionGet, {
  payload: McpCatalogSessionRequest,
  success: McpCatalogSnapshot,
  error: catalogRpcError,
});
const WsMcpCatalogSessionResetRpc = Rpc.make(WS_METHODS.mcpCatalogSessionReset, {
  payload: McpCatalogSessionMutationInput,
  success: McpCatalogSnapshot,
  error: catalogRpcError,
});
const WsMcpCatalogOAuthBeginRpc = Rpc.make(WS_METHODS.mcpCatalogOAuthBegin, {
  payload: McpCatalogOAuthBeginInput,
  success: ProjectMcpOAuthBeginResult,
  error: catalogRpcError,
});
const WsMcpCatalogOAuthContinueRpc = Rpc.make(WS_METHODS.mcpCatalogOAuthContinue, {
  payload: McpCatalogOAuthContinueInput,
  success: Schema.Void,
  error: catalogRpcError,
});
const WsMcpCatalogOAuthDisconnectRpc = Rpc.make(WS_METHODS.mcpCatalogOAuthDisconnect, {
  payload: McpCatalogOAuthDisconnectInput,
  success: Schema.Void,
  error: catalogRpcError,
});

const WsProjectWorkReadRpc = Rpc.make(WS_METHODS.projectWorkRead, {
  payload: ProjectWorkReadIntent,
  success: Schema.Unknown,
  error: Schema.Union([ProjectWorkRpcError, EnvironmentAuthorizationError]),
});
const WsProjectWorkWriteRpc = Rpc.make(WS_METHODS.projectWorkWrite, {
  payload: ProjectWorkWriteIntent,
  success: ProjectWorkWriteResult,
  error: Schema.Union([ProjectWorkRpcError, EnvironmentAuthorizationError]),
});
const WsProjectWorkSubscribeRpc = Rpc.make(WS_METHODS.projectWorkSubscribe, {
  payload: ProjectWorkStreamInput,
  success: ProjectWorkStreamItem,
  stream: true,
  error: Schema.Union([ProjectWorkRpcError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksListRpc = Rpc.make(WS_METHODS.scheduledTasksList, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksSubscribeRpc = Rpc.make(WS_METHODS.scheduledTasksSubscribe, {
  payload: ScheduledTaskListInput,
  success: ScheduledTaskListResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsScheduledTasksUpsertRpc = Rpc.make(WS_METHODS.scheduledTasksUpsert, {
  payload: ScheduledTaskUpsertInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksSetEnabledRpc = Rpc.make(WS_METHODS.scheduledTasksSetEnabled, {
  payload: ScheduledTaskSetEnabledInput,
  success: ScheduledTaskMutationResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksDeleteRpc = Rpc.make(WS_METHODS.scheduledTasksDelete, {
  payload: ScheduledTaskDeleteInput,
  success: ScheduledTaskDeleteResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRunNowRpc = Rpc.make(WS_METHODS.scheduledTasksRunNow, {
  payload: ScheduledTaskRunNowInput,
  success: ScheduledTaskRunNowResult,
  error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksRotateWebhookTokenRpc = Rpc.make(
  WS_METHODS.scheduledTasksRotateWebhookToken,
  {
    payload: ScheduledTaskRotateWebhookTokenInput,
    success: ScheduledTaskMutationResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSecretsAnswerRequestRpc = Rpc.make(WS_METHODS.secretsAnswerRequest, {
  payload: SecretRequestAnswerInput,
  error: Schema.Union([SecretRequestError, EnvironmentAuthorizationError]),
});

const WsScheduledTasksListWebhookDeliveriesRpc = Rpc.make(
  WS_METHODS.scheduledTasksListWebhookDeliveries,
  {
    payload: ScheduledTaskListWebhookDeliveriesInput,
    success: ScheduledTaskListWebhookDeliveriesResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsScheduledTasksGetWebhookDeliveryRpc = Rpc.make(
  WS_METHODS.scheduledTasksGetWebhookDelivery,
  {
    payload: ScheduledTaskGetWebhookDeliveryInput,
    success: ScheduledTaskGetWebhookDeliveryResult,
    error: Schema.Union([ScheduledTaskError, EnvironmentAuthorizationError]),
  },
);

const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});

const WsSubscribeBackgroundPolicyRpc = Rpc.make(WS_METHODS.subscribeBackgroundPolicy, {
  payload: Schema.Struct({}),
  success: BackgroundPolicySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsSubscribeResourceTelemetryRpc = Rpc.make(WS_METHODS.subscribeResourceTelemetry, {
  payload: Schema.Struct({}),
  success: ResourceTelemetrySnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export class RpcScopeAuthorization extends RpcMiddleware.Service<RpcScopeAuthorization>()(
  "t3/contracts/RpcScopeAuthorization",
  { error: EnvironmentAuthorizationError },
) {}

const skillRpcError = Schema.Union([SkillRpcError, EnvironmentAuthorizationError]);
export const WsSkillsCatalogListRpc = Rpc.make(WS_METHODS.skillsCatalogList, {
  payload: SkillCatalogListInput,
  success: SkillCatalogListResult,
  error: skillRpcError,
});
export const WsSkillsCatalogSubscribeRpc = Rpc.make(WS_METHODS.skillsCatalogSubscribe, {
  payload: SkillCatalogListInput,
  success: SkillCatalogChanged,
  error: skillRpcError,
  stream: true,
});
export const WsSkillsContentGetRpc = Rpc.make(WS_METHODS.skillsContentGet, {
  payload: SkillContentGetInput,
  success: SkillContentGetResult,
  error: skillRpcError,
});
export const WsSkillsHistoryListRpc = Rpc.make(WS_METHODS.skillsHistoryList, {
  payload: SkillHistoryListInput,
  success: SkillHistoryListResult,
  error: skillRpcError,
});
export const WsSkillsNativeContentGetRpc = Rpc.make(WS_METHODS.skillsNativeContentGet, {
  payload: SkillNativeContentGetInput,
  success: SkillNativeContentGetResult,
  error: skillRpcError,
});
export const WsSkillsApplicationGetRpc = Rpc.make(WS_METHODS.skillsApplicationGet, {
  payload: SkillApplicationGetInput,
  success: SkillApplicationGetResult,
  error: skillRpcError,
});
export const WsSkillsDeploymentListRpc = Rpc.make(WS_METHODS.skillsDeploymentList, {
  payload: SkillDeploymentListInput,
  success: SkillDeploymentListResult,
  error: skillRpcError,
});
export const WsSkillsDeploymentChangeRpc = Rpc.make(WS_METHODS.skillsDeploymentChange, {
  payload: SkillDeploymentChangeInput,
  success: SkillDeploymentChangeResult,
  error: skillRpcError,
});
export const WsSkillsGlobalCreateRpc = Rpc.make(WS_METHODS.skillsGlobalCreate, {
  payload: SkillGlobalCreateInput,
  success: SkillGlobalCreateResult,
  error: skillRpcError,
});
export const WsSkillsGlobalUpdateRpc = Rpc.make(WS_METHODS.skillsGlobalUpdate, {
  payload: SkillGlobalUpdateInput,
  success: SkillGlobalUpdateResult,
  error: skillRpcError,
});
export const WsSkillsGlobalDeleteRpc = Rpc.make(WS_METHODS.skillsGlobalDelete, {
  payload: SkillGlobalDeleteInput,
  success: SkillGlobalDeleteResult,
  error: skillRpcError,
});
export const WsSkillsGlobalRenameRpc = Rpc.make(WS_METHODS.skillsGlobalRename, {
  payload: SkillGlobalRenameInput,
  success: SkillGlobalRenameResult,
  error: skillRpcError,
});
export const WsSkillsGlobalRollbackRpc = Rpc.make(WS_METHODS.skillsGlobalRollback, {
  payload: SkillGlobalRollbackInput,
  success: SkillGlobalRollbackResult,
  error: skillRpcError,
});
export const WsSkillsProjectSetOverrideRpc = Rpc.make(WS_METHODS.skillsProjectSetOverride, {
  payload: SkillProjectSetOverrideInput,
  success: SkillProjectSetOverrideResult,
  error: skillRpcError,
});
export const WsSkillsProjectSetDisabledRpc = Rpc.make(WS_METHODS.skillsProjectSetDisabled, {
  payload: SkillProjectSetDisabledInput,
  success: SkillProjectSetDisabledResult,
  error: skillRpcError,
});
export const WsSkillsProjectDeleteStateRpc = Rpc.make(WS_METHODS.skillsProjectDeleteState, {
  payload: SkillProjectDeleteStateInput,
  success: SkillProjectDeleteStateResult,
  error: skillRpcError,
});
export const WsSkillsProjectRenameRpc = Rpc.make(WS_METHODS.skillsProjectRename, {
  payload: SkillProjectRenameInput,
  success: SkillProjectRenameResult,
  error: skillRpcError,
});
export const WsSkillsSessionSetEnabledRpc = Rpc.make(WS_METHODS.skillsSessionSetEnabled, {
  payload: SkillSessionSetEnabledInput,
  success: SkillSessionSetEnabledResult,
  error: skillRpcError,
});
export const WsSkillsSessionResetRpc = Rpc.make(WS_METHODS.skillsSessionReset, {
  payload: SkillSessionResetInput,
  success: SkillSessionResetResult,
  error: skillRpcError,
});
export const WsSkillsNativeImportRpc = Rpc.make(WS_METHODS.skillsNativeImport, {
  payload: SkillNativeImportInput,
  success: SkillNativeImportResult,
  error: skillRpcError,
});

const managedTextResourceRpcError = Schema.Union([
  ManagedTextResourceRpcError,
  EnvironmentAuthorizationError,
]);
export const WsManagedTextResourcesCatalogListRpc = Rpc.make(
  WS_METHODS.managedTextResourcesCatalogList,
  {
    payload: ManagedTextResourceCatalogListInput,
    success: ManagedTextResourceCatalogListResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesCatalogSubscribeRpc = Rpc.make(
  WS_METHODS.managedTextResourcesCatalogSubscribe,
  {
    payload: ManagedTextResourceCatalogListInput,
    success: ManagedTextResourceChanged,
    error: managedTextResourceRpcError,
    stream: true,
  },
);
export const WsManagedTextResourcesContentGetRpc = Rpc.make(
  WS_METHODS.managedTextResourcesContentGet,
  {
    payload: ManagedTextResourceContentGetInput,
    success: ManagedTextResourceContentGetResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesEnvironmentCreateRpc = Rpc.make(
  WS_METHODS.managedTextResourcesEnvironmentCreate,
  {
    payload: ManagedTextResourceEnvironmentCreateInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesEnvironmentUpdateRpc = Rpc.make(
  WS_METHODS.managedTextResourcesEnvironmentUpdate,
  {
    payload: ManagedTextResourceEnvironmentUpdateInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesEnvironmentDeleteRpc = Rpc.make(
  WS_METHODS.managedTextResourcesEnvironmentDelete,
  {
    payload: ManagedTextResourceEnvironmentDeleteInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesEnvironmentSetEnabledRpc = Rpc.make(
  WS_METHODS.managedTextResourcesEnvironmentSetEnabled,
  {
    payload: ManagedTextResourceEnvironmentSetEnabledInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesProjectSetOverrideRpc = Rpc.make(
  WS_METHODS.managedTextResourcesProjectSetOverride,
  {
    payload: ManagedTextResourceProjectSetOverrideInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesProjectSetDisabledRpc = Rpc.make(
  WS_METHODS.managedTextResourcesProjectSetDisabled,
  {
    payload: ManagedTextResourceProjectSetDisabledInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesProjectDeleteStateRpc = Rpc.make(
  WS_METHODS.managedTextResourcesProjectDeleteState,
  {
    payload: ManagedTextResourceProjectDeleteStateInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesThreadSetEnabledRpc = Rpc.make(
  WS_METHODS.managedTextResourcesThreadSetEnabled,
  {
    payload: ManagedTextResourceThreadSetEnabledInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);
export const WsManagedTextResourcesThreadResetRpc = Rpc.make(
  WS_METHODS.managedTextResourcesThreadReset,
  {
    payload: ManagedTextResourceThreadResetInput,
    success: ManagedTextResourceMutationResult,
    error: managedTextResourceRpcError,
  },
);

const projectTerminalRpcError = Schema.Union([TerminalToolError, EnvironmentAuthorizationError]);
export const WsProjectTerminalAttachRpc = Rpc.make(WS_METHODS.projectTerminalAttach, {
  payload: ProjectTerminalHandle,
  success: ProjectTerminalAttachStreamEvent,
  error: projectTerminalRpcError,
  stream: true,
});
export const WsProjectTerminalMetadataRpc = Rpc.make(WS_METHODS.projectTerminalMetadata, {
  payload: ProjectTerminalDockListInput.fields.projectId,
  success: ProjectTerminalMetadataStreamEvent,
  error: projectTerminalRpcError,
  stream: true,
});
export const WsProjectTerminalListRpc = Rpc.make(WS_METHODS.projectTerminalList, {
  payload: ProjectTerminalDockListInput,
  success: ProjectTerminalDockListResult,
  error: projectTerminalRpcError,
});
export const WsProjectTerminalWriteRpc = Rpc.make(WS_METHODS.projectTerminalWrite, {
  payload: ProjectTerminalWriteInput,
  success: Schema.Void,
  error: projectTerminalRpcError,
});
export const WsProjectTerminalResizeRpc = Rpc.make(WS_METHODS.projectTerminalResize, {
  payload: ProjectTerminalResizeInput,
  success: Schema.Void,
  error: projectTerminalRpcError,
});
export const WsProjectTerminalKillRpc = Rpc.make(WS_METHODS.projectTerminalKill, {
  payload: ProjectTerminalKillInput,
  success: ProjectTerminalStopResult,
  error: projectTerminalRpcError,
});

export const WsRpcGroup = RpcGroup.make(
  WsIssuesSearchRpc,
  WsProjectTerminalAttachRpc,
  WsProjectTerminalMetadataRpc,
  WsProjectTerminalListRpc,
  WsProjectTerminalWriteRpc,
  WsProjectTerminalResizeRpc,
  WsProjectTerminalKillRpc,

  WsSkillsCatalogListRpc,
  WsSkillsCatalogSubscribeRpc,
  WsSkillsContentGetRpc,
  WsSkillsHistoryListRpc,
  WsSkillsNativeContentGetRpc,
  WsSkillsApplicationGetRpc,
  WsSkillsDeploymentListRpc,
  WsSkillsDeploymentChangeRpc,
  WsSkillsGlobalCreateRpc,
  WsSkillsGlobalUpdateRpc,
  WsSkillsGlobalDeleteRpc,
  WsSkillsGlobalRenameRpc,
  WsSkillsGlobalRollbackRpc,
  WsSkillsProjectSetOverrideRpc,
  WsSkillsProjectSetDisabledRpc,
  WsSkillsProjectDeleteStateRpc,
  WsSkillsProjectRenameRpc,
  WsSkillsSessionSetEnabledRpc,
  WsSkillsSessionResetRpc,
  WsSkillsNativeImportRpc,
  WsManagedTextResourcesCatalogListRpc,
  WsManagedTextResourcesCatalogSubscribeRpc,
  WsManagedTextResourcesContentGetRpc,
  WsManagedTextResourcesEnvironmentCreateRpc,
  WsManagedTextResourcesEnvironmentUpdateRpc,
  WsManagedTextResourcesEnvironmentDeleteRpc,
  WsManagedTextResourcesEnvironmentSetEnabledRpc,
  WsManagedTextResourcesProjectSetOverrideRpc,
  WsManagedTextResourcesProjectSetDisabledRpc,
  WsManagedTextResourcesProjectDeleteStateRpc,
  WsManagedTextResourcesThreadSetEnabledRpc,
  WsManagedTextResourcesThreadResetRpc,

  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsProviderConsumeResetCreditRpc,
  WsProviderAuthStartRpc,
  WsProviderAuthCompleteRpc,
  WsChatGptReconnectProfileRpc,
  WsChatGptImportProfileRpc,
  WsChatGptHandoffSubscribeRpc,
  WsCodexAuthCallbackSubscribeRpc,
  WsProviderAuthRespondRpc,
  WsProviderAuthCancelRpc,
  WsProviderAuthLogoutRpc,
  WsProviderAuthSubscribeRpc,
  WsProviderInstallStartRpc,
  WsProviderInstallCancelRpc,
  WsProviderInstallSubscribeRpc,
  WsProviderInstallRemoveRpc,
  WsServerUpdateServerRpc,
  WsServerUpdateServerWithProgressRpc,
  WsServerCommitDesktopUpdateRpc,
  WsServerUpsertKeybindingRpc,
  WsServerRemoveKeybindingRpc,
  WsServerRunStorageCleanupRpc,
  WsServerGetStorageCleanupReportRpc,
  WsServerGetDatabaseStorageRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerTestExternalNotificationRpc,
  WsServerDiscoverSourceControlRpc,
  WsServerSearchAcpRegistryRpc,
  WsServerPrepareAcpRegistryAgentRpc,
  WsServerUninstallAcpRegistryManagedBinaryRpc,
  WsServerAcceptAcpRegistryUrlAuthRpc,
  WsServerListAcpRegistrySessionsRpc,
  WsServerImportAcpRegistrySessionRpc,
  WsServerDeleteAcpRegistrySessionRpc,
  WsServerListAcpRegistryProvidersRpc,
  WsServerSetAcpRegistryProviderRpc,
  WsServerDisableAcpRegistryProviderRpc,
  WsServerLogoutAcpRegistryRpc,
  WsServerGetTraceDiagnosticsRpc,
  WsServerGetProcessDiagnosticsRpc,
  WsServerGetHostResourcesRpc,
  WsServerGetProcessResourceHistoryRpc,
  WsServerGetResourceTelemetryHistoryRpc,
  WsServerRetryResourceTelemetryRpc,
  WsServerCheckOtlpEndpointRpc,
  WsServerGetUsageSummaryRpc,
  WsServerRefreshUsageRatesRpc,
  WsServerSignalProcessRpc,
  WsThreadHistoryListRpc,
  WsThreadHistoryDetailRpc,
  WsThreadHistoryRecoverRpc,
  WsThreadHistoryRestoreFilesRpc,
  WsThreadHistoryFileRestoreStatusRpc,
  WsThreadHistoryReleaseRpc,
  WsThreadHistoryReconcileRpc,
  WsAssistantsMemoryReadRpc,
  WsAssistantsMemoryWriteRpc,
  WsAssistantsRoutineReadRpc,
  WsAssistantsRoutineWriteRpc,
  WsAssistantsActivityRpc,
  WsAssistantsSubscribeRosterRpc,
  WsAssistantsCreateRpc,
  WsAssistantsGetRpc,
  WsAssistantsResolveThreadRpc,
  WsAssistantsListRpc,
  WsAssistantsUpdateConfigurationRpc,
  WsAssistantsLifecycleRpc,
  WsProjectWorkIssueRpc,
  WsProjectWorkDeliveryRpc,
  WsMcpCatalogSessionSubscribeForThreadRpc,
  WsMcpCatalogSessionForThreadRpc,
  WsMcpCatalogOAuthStatusRpc,
  WsMcpCatalogSecretPrepareRpc,
  WsMcpCatalogReadRpc,
  WsMcpCatalogWriteRpc,
  WsMcpCatalogSessionGetRpc,
  WsMcpCatalogSessionResetRpc,
  WsMcpCatalogOAuthBeginRpc,
  WsMcpCatalogOAuthContinueRpc,
  WsMcpCatalogOAuthDisconnectRpc,
  WsProjectWorkReadRpc,
  WsProjectWorkWriteRpc,
  WsProjectWorkSubscribeRpc,
  WsScheduledTasksListRpc,
  WsScheduledTasksSubscribeRpc,
  WsScheduledTasksUpsertRpc,
  WsScheduledTasksSetEnabledRpc,
  WsScheduledTasksDeleteRpc,
  WsScheduledTasksRunNowRpc,
  WsScheduledTasksRotateWebhookTokenRpc,
  WsSecretsAnswerRequestRpc,
  WsScheduledTasksListWebhookDeliveriesRpc,
  WsScheduledTasksGetWebhookDeliveryRpc,
  WsServerReportClientActivityRpc,
  WsServerReportHostPowerStateRpc,
  WsServerGetBackgroundPolicyRpc,
  WsCloudGetRelayClientStatusRpc,
  WsCloudInstallRelayClientRpc,
  WsPullRequestsListRpc,
  WsPullRequestsListStatsRpc,
  WsPullRequestsSummaryRpc,
  WsPullRequestsRoutingRpc,
  WsPullRequestsRoutingIdentityRpc,
  WsPullRequestsStackRpc,
  WsPullRequestsLinkedThreadsRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsPreviewRpc,
  WsPullRequestsChecksRpc,
  WsPullRequestsActivityRpc,
  WsPullRequestsReviewGuideRpc,
  WsPullRequestsGenerateReviewGuideRpc,
  WsPullRequestsThreadCommentsRpc,
  WsPullRequestsDiffFileContentsRpc,
  WsPullRequestsFilesViewedRpc,
  WsPullRequestsChangeBreakdownRpc,
  WsPullRequestsSetFilesViewedRpc,
  WsPullRequestsRunActionRpc,
  WsPullRequestsUpdateRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsUpdateCommentRpc,
  WsPullRequestsSubmitReviewRpc,
  WsPullRequestsReplyToThreadRpc,
  WsPullRequestsSetThreadResolutionRpc,
  WsPullRequestsSetReactionRpc,
  WsPullRequestsInvalidateRpc,
  WsPullRequestsReportStateRpc,
  WsPullRequestsSubscribeRefreshesRpc,
  WsPullRequestsReviewerCandidatesRpc,
  WsPullRequestsRequestReviewersRpc,
  WsPullRequestsLabelCandidatesRpc,
  WsPullRequestsSetLabelsRpc,
  WsSourceControlLookupRepositoryRpc,
  WsSourceControlCloneRepositoryRpc,
  WsSourceControlPublishRepositoryRpc,
  WsProjectCloneStartRpc,
  WsProjectCloneCancelRpc,
  WsProjectCloneRetryRpc,
  WsSubscribeProjectClonesRpc,
  WsProjectsListEntriesRpc,
  WsProjectsListIgnoredFilesRpc,
  WsProjectsReadFileRpc,
  WsProjectsSearchContentsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsEnsureScratchRpc,
  WsProjectsCreateNewRpc,
  WsProjectsWriteFileRpc,
  WsProjectsMutateRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsFilesystemGetMetadataRpc,
  WsAgentSessionsScanRpc,
  WsAgentSessionsImportRpc,
  WsAssetsCreateUrlRpc,
  WsAssetsPersistChatAttachmentsRpc,
  WsAttachmentsCreateUploadUrlRpc,
  WsAttachmentsDeleteRpc,
  WsMcpAppsCallToolRpc,
  WsMcpAppsToolInfoRpc,
  WsMcpAppsReadResourceRpc,
  WsMcpAppsUpdateModelContextRpc,
  WsProviderUploadFeedbackRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeWorktreeSetupRpc,
  WsWorktreeSetupCancelRpc,
  WsVcsPullRpc,
  WsVcsRefreshStatusRpc,
  WsGitDiscoverRepositoriesRpc,
  WsGitIndexStatusRpc,
  WsGitMutateIndexRpc,
  WsGitCommitStagedRpc,
  WsGitHistoryRpc,
  WsGitHistoryDiffRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalObserveRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsPreviewOpenRpc,
  WsPreviewNavigateRpc,
  WsPreviewResizeRpc,
  WsPreviewAdjustRpc,
  WsPreviewRefreshRpc,
  WsPreviewCloseRpc,
  WsPreviewListRpc,
  WsPreviewClearProfileRpc,
  WsPreviewReportProfilesRpc,
  WsPreviewReportStatusRpc,
  WsSubscribePreviewEventsRpc,
  WsSubscribeDiscoveredLocalServersRpc,
  WsDeviceConfigureRpc,
  WsDeviceListRpc,
  WsDeviceTestHostRpc,
  WsDeviceEasAccountRpc,
  WsDeviceOpenRpc,
  WsDeviceCloseRpc,
  WsDeviceShutdownRpc,
  WsDeviceDetailRpc,
  WsDeviceActionRpc,
  WsSubscribeDeviceStateRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsSubscribeBackgroundPolicyRpc,
  WsSubscribeResourceTelemetryRpc,
  WsOrchestrationV2DispatchCommandRpc,
  WsOrchestrationV2GetWorkflowScriptRpc,
  WsOrchestrationV2StopWorkflowRpc,
  WsOrchestrationV2GetTurnItemRpc,
  WsOrchestrationV2GetTurnDiffRpc,
  WsOrchestrationV2GetFullThreadDiffRpc,
  WsOrchestrationV2SearchThreadsRpc,
  WsOrchestrationV2SearchThreadRpc,
  WsOrchestrationV2SearchThreadStreamRpc,
  WsOrchestrationV2GetArchivedShellSnapshotRpc,
  WsOrchestrationV2GetThreadProjectionRpc,
  WsOrchestrationV2LaunchThreadRpc,
  WsOrchestrationV2SubscribeArchivedShellRpc,
  WsOrchestrationV2SubscribeShellRpc,
  WsOrchestrationV2SubscribeThreadRpc,
  WsOrchestrationV2SubscribeCommandOutputRpc,
).middleware(RpcScopeAuthorization);
