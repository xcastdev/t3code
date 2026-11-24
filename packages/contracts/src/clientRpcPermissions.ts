import { ServerSettingsPatch, requiredScopesForServerSettingsPatch } from "./settings.ts";
import { ProviderInstanceMutation } from "./providerInstance.ts";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  mcpClientScopes,
} from "./auth.ts";
import { PeerLinkLinkPairingInput } from "./peerLink.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.serverTestExternalNotification]: AuthSettingsWriteScope,
  [WS_METHODS.threadHistoryRecover]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadHistoryRestoreFiles]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadHistoryRelease]: AuthOrchestrationOperateScope,
  [WS_METHODS.threadHistoryReconcile]: AuthOrchestrationOperateScope,

  [WS_METHODS.skillsDeploymentChange]: AuthSettingsWriteScope,
  [WS_METHODS.skillsGlobalCreate]: AuthSettingsWriteScope,
  [WS_METHODS.skillsGlobalUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.skillsGlobalDelete]: AuthSettingsWriteScope,
  [WS_METHODS.skillsGlobalRename]: AuthSettingsWriteScope,
  [WS_METHODS.skillsGlobalRollback]: AuthSettingsWriteScope,
  [WS_METHODS.skillsProjectSetOverride]: AuthSettingsWriteScope,
  [WS_METHODS.skillsProjectSetDisabled]: AuthSettingsWriteScope,
  [WS_METHODS.skillsProjectDeleteState]: AuthSettingsWriteScope,
  [WS_METHODS.skillsProjectRename]: AuthSettingsWriteScope,
  [WS_METHODS.skillsSessionSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.skillsSessionReset]: AuthSettingsWriteScope,
  [WS_METHODS.skillsNativeImport]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesEnvironmentCreate]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesEnvironmentUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesEnvironmentDelete]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesEnvironmentSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesProjectSetOverride]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesProjectSetDisabled]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesProjectDeleteState]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesThreadSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.managedTextResourcesThreadReset]: AuthSettingsWriteScope,
  [WS_METHODS.projectTerminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.projectTerminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.projectTerminalKill]: AuthTerminalOperateScope,

  [WS_METHODS.mcpCatalogWrite]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogSecretPrepare]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogTestConnection]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogSessionReset]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogOAuthBegin]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogOAuthContinue]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogOAuthDisconnect]: AuthSettingsWriteScope,
  [WS_METHODS.pluginsInstall]: AuthEnvironmentMaintainScope,
  [WS_METHODS.pluginsUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.pluginsUninstall]: AuthEnvironmentMaintainScope,
  [WS_METHODS.pluginsDeleteData]: AuthEnvironmentMaintainScope,
  [WS_METHODS.pluginsSetEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.pluginsStart]: AuthSettingsWriteScope,
  [WS_METHODS.pluginsStop]: AuthSettingsWriteScope,
  [WS_METHODS.pluginsRestart]: AuthSettingsWriteScope,
  [WS_METHODS.pluginsConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.pluginsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsRoutineWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsMemoryWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsUpdateConfiguration]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsLifecycle]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectWorkIssue]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectWorkDelivery]: AuthSourceControlWriteScope,
  [WS_METHODS.projectWorkWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  // An MCP sign-in stores a credential for the agent, as an account sign-in does.
  [WS_METHODS.providerMcpSignInStart]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInComplete]: AuthProvidersManageScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Restarts the server, as an update does.
  [WS_METHODS.serverReclaimDatabaseSpace]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckSecretSource]: AuthSettingsWriteScope,
  // Listing models spends the stored API key, so only those who can choose a model may.
  [WS_METHODS.serverListTextGeneratorModels]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesCreate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesComment]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesSetState]: AuthSourceControlWriteScope,
  [WS_METHODS.issuesReact]: AuthSourceControlWriteScope,
  // A tracker credential and a project's binding are settings, saved under the same grant.
  [WS_METHODS.issueTrackersConnect]: AuthSettingsWriteScope,
  [WS_METHODS.issueTrackersBindProject]: AuthSettingsWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlStar]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.gitMutateIndex]: AuthSourceControlWriteScope,
  [WS_METHODS.gitCommitStaged]: AuthSourceControlWriteScope,
  [WS_METHODS.gitGenerateStagedCommitMessage]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.workspaceAddTaskFolderRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopBackgroundTask]: AuthOrchestrationOperateScope,
  // An answer, a resume and a cancel each decide what a run's agents do next.
  [WS_METHODS.workflowsAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsCancel]: AuthOrchestrationOperateScope,
  // The server runs this file: saving it is running code there, as a terminal does.
  [WS_METHODS.workflowsSaveDefinition]: AuthTerminalOperateScope,
  [WS_METHODS.workflowsDeleteDefinition]: AuthTerminalOperateScope,
  // Force stop kills agent processes, as Stop on a terminal does.
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairClient]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksPairLink]: AuthAccessWriteScope,
  // Send stores and sends a report from a thread's turn: the bar of running that thread.
  [WS_METHODS.agentFeedbackAnswerRequest]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag =
  | keyof typeof CLIENT_GUARDED_RPC_SCOPES
  | typeof ORCHESTRATION_V2_WS_METHODS.dispatchCommand
  | typeof WS_METHODS.assistantsRoutineRead
  | typeof WS_METHODS.serverUpdateSettings;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeSettingsUpdate = Schema.decodeUnknownSync(
  Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);
const decodeLinkPairing = Schema.decodeUnknownSync(PeerLinkLinkPairingInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.assistantsRoutineRead) {
    return typeof input === "object" &&
      input !== null &&
      "operation" in input &&
      input.operation === "webhook"
      ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
      : [];
  }
  if (method === WS_METHODS.serverUpdateSettings) {
    const payload = decodeSettingsUpdate(input ?? { patch: {} });
    const scopes = requiredScopesForServerSettingsPatch(payload.patch);
    if (payload.providerInstanceMutation === undefined) return scopes;
    return Object.values(payload.patch).every((value) => value === undefined)
      ? [AuthProvidersManageScope]
      : [...new Set([...scopes, AuthProvidersManageScope])];
  }
  if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand) {
    return typeof input === "object" &&
      input !== null &&
      "type" in input &&
      input.type === "thread.stop"
      ? [AuthOrchestrationOperateScope]
      : [];
  }
  if (method === WS_METHODS.projectWorkDelivery)
    return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  // Handing out access takes holding it: the caller gets back a credential it can spend itself.
  if (method === WS_METHODS.peerLinksPairLink && input !== undefined) {
    const held = mcpClientScopes(decodeLinkPairing(input).access);
    return [AuthAccessWriteScope, ...held];
  }
  if (method === WS_METHODS.guestShareCreate) {
    return [AuthAccessWriteScope, AuthOrchestrationReadScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as keyof typeof CLIENT_GUARDED_RPC_SCOPES]]
    : [];
}
