import { ServerSettingsPatch, requiredScopesForServerSettingsPatch } from "./settings.ts";
import { ProviderInstanceMutation } from "./providerInstance.ts";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
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
  [WS_METHODS.mcpCatalogSessionReset]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogOAuthBegin]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogOAuthContinue]: AuthSettingsWriteScope,
  [WS_METHODS.mcpCatalogOAuthDisconnect]: AuthSettingsWriteScope,
  [WS_METHODS.assistantsRoutineWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsMemoryWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsUpdateConfiguration]: AuthOrchestrationOperateScope,
  [WS_METHODS.assistantsLifecycle]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectWorkIssue]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectWorkDelivery]: AuthSourceControlWriteScope,
  [WS_METHODS.projectWorkWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
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
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.gitMutateIndex]: AuthSourceControlWriteScope,
  [WS_METHODS.gitCommitStaged]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
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
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as keyof typeof CLIENT_GUARDED_RPC_SCOPES]]
    : [];
}
