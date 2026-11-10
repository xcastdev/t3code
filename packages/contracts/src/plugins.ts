import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PLUGIN_LIMITS = {
  maxPayloadBytes: 240 * 1024,
  maxMessageBytes: 256 * 1024,
  maxBatchBytes: 64 * 1024,
  maxBodyChunkBytes: 128 * 1024,
  maxPendingRequests: 16,
  maxSaveBytes: 32 * 1024 * 1024,
  maxChatTargets: 50,
} as const;

export const PLUGIN_HOST_API = { major: 1, minor: 1 } as const;

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLUGIN_OPERATION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const PLUGIN_CONTRIBUTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const PLUGIN_SETTING_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HOST_API_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const PluginIdString = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(23),
  Schema.isPattern(PLUGIN_ID_PATTERN),
);
const PluginContributionIdString = Schema.String.check(
  Schema.isPattern(PLUGIN_CONTRIBUTION_ID_PATTERN),
);

export const PluginId = PluginIdString.pipe(Schema.brand("PluginId"));
export type PluginId = typeof PluginId.Type;

export const PluginOperationName = Schema.String.check(
  Schema.isPattern(PLUGIN_OPERATION_NAME_PATTERN),
);
export type PluginOperationName = typeof PluginOperationName.Type;

export const PluginContributionId = PluginContributionIdString;
export type PluginContributionId = typeof PluginContributionId.Type;

const boundedText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

const isRelativePackagePath = (extension: string) =>
  Schema.makeFilter(
    (path: string) =>
      path.length <= 256 &&
      path.endsWith(extension) &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { expected: `a relative package path ending in ${extension}` },
  );

const PluginPanelEntry = Schema.String.check(isRelativePackagePath(".html"));
const PluginBackendEntry = Schema.String.check(isRelativePackagePath(".cjs"));

export const PluginPanelDecl = Schema.Struct({
  id: PluginContributionId,
  title: boundedText(128),
  entry: PluginPanelEntry,
  icon: Schema.optional(boundedText(64)),
});
export type PluginPanelDecl = typeof PluginPanelDecl.Type;

export const PluginCommandDecl = Schema.Struct({
  id: PluginContributionId,
  title: boundedText(128),
  opens: Schema.Struct({ panel: PluginContributionId }),
});
export type PluginCommandDecl = typeof PluginCommandDecl.Type;

export const PluginOperationDecl = Schema.Struct({
  name: PluginOperationName,
  title: boundedText(128),
  description: boundedText(1024),
  inputSchema: Schema.JsonObject,
  mutates: Schema.Boolean,
  agent: Schema.Boolean,
});
export type PluginOperationDecl = typeof PluginOperationDecl.Type;

export const PluginTopicDecl = Schema.Struct({ name: PluginOperationName });
export type PluginTopicDecl = typeof PluginTopicDecl.Type;

export const PluginResourceDecl = Schema.Struct({
  name: PluginOperationName,
  title: boundedText(128),
  operation: PluginOperationName,
});
export type PluginResourceDecl = typeof PluginResourceDecl.Type;

export const PluginPrerequisiteDecl = Schema.Struct({
  executable: Schema.String.check(
    Schema.isMaxLength(128),
    Schema.isPattern(EXECUTABLE_NAME_PATTERN),
  ),
  hint: boundedText(1024),
});
export type PluginPrerequisiteDecl = typeof PluginPrerequisiteDecl.Type;

export const PluginSettingFieldType = Schema.Literals([
  "string",
  "number",
  "boolean",
  "enum",
  "secret",
]);
export type PluginSettingFieldType = typeof PluginSettingFieldType.Type;

export const PluginSettingField = Schema.Struct({
  key: Schema.String.check(Schema.isPattern(PLUGIN_SETTING_KEY_PATTERN)),
  label: boundedText(128),
  type: PluginSettingFieldType,
  default: Schema.optional(
    Schema.Union([Schema.String.check(Schema.isMaxLength(1024)), Schema.Finite, Schema.Boolean]),
  ),
  options: Schema.optional(Schema.Array(boundedText(128)).check(Schema.isMaxLength(64))),
});
export type PluginSettingField = typeof PluginSettingField.Type;

export const PluginCapability = Schema.Literals([
  "chat.attach",
  "chat.reference",
  "file.save",
  "clipboard.write",
]);
export type PluginCapability = typeof PluginCapability.Type;

export const PluginManifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: PluginId,
  name: boundedText(64),
  version: Schema.String.check(Schema.isMaxLength(64), Schema.isPattern(SEMVER_PATTERN)),
  hostApi: Schema.String.check(Schema.isMaxLength(16), Schema.isPattern(HOST_API_PATTERN)),
  author: boundedText(128),
  description: Schema.optional(boundedText(1024)),
  ui: Schema.optional(
    Schema.Struct({
      panels: Schema.Array(PluginPanelDecl).check(Schema.isMaxLength(32)),
      commands: Schema.Array(PluginCommandDecl).check(Schema.isMaxLength(64)),
    }),
  ),
  backend: Schema.optional(
    Schema.Struct({
      entry: PluginBackendEntry,
      operations: Schema.Array(PluginOperationDecl).check(Schema.isMaxLength(64)),
      topics: Schema.Array(PluginTopicDecl).check(Schema.isMaxLength(32)),
      resources: Schema.Array(PluginResourceDecl).check(Schema.isMaxLength(32)),
      prerequisites: Schema.Array(PluginPrerequisiteDecl).check(Schema.isMaxLength(16)),
    }),
  ),
  settings: Schema.optional(
    Schema.Struct({
      client: Schema.Array(PluginSettingField).check(Schema.isMaxLength(64)),
      environment: Schema.Array(PluginSettingField).check(Schema.isMaxLength(64)),
    }),
  ),
  // Open on the wire so a client can decode a newer manifest and ask for an update;
  // decodePluginManifest rejects unknown ones for a hostApi the host claims.
  capabilities: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(
    Schema.isMaxLength(8),
  ),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginRuntimeStatus = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "failed",
  "missing-prerequisite",
  "disabled",
]);
export type PluginRuntimeStatus = typeof PluginRuntimeStatus.Type;

export const PluginInstallRecord = Schema.Struct({
  pluginId: PluginId,
  version: Schema.String,
  name: Schema.String,
  author: Schema.String,
  enabled: Schema.Boolean,
  status: PluginRuntimeStatus,
  statusDetail: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  failedUpdate: Schema.optional(
    Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      reason: Schema.String.check(Schema.isMaxLength(1024)),
    }),
  ),
  manifest: PluginManifest,
});
export type PluginInstallRecord = typeof PluginInstallRecord.Type;

export const PluginRegistrySnapshot = Schema.Struct({
  installed: Schema.Array(PluginInstallRecord),
  retainedData: Schema.Array(Schema.Struct({ pluginId: PluginId, bytes: NonNegativeInt })),
});
export type PluginRegistrySnapshot = typeof PluginRegistrySnapshot.Type;

export const PluginRequestErrorReason = Schema.Literals([
  "not-installed",
  "disabled",
  "not-running",
  "unknown-operation",
  "operation-mutates",
  "operation-failed",
  "incompatible-host-api",
  "invalid-package",
  "too-large",
  "worker-failed",
  "capability-denied",
  "subscription-limit",
  "timed-out",
  "version-changed",
]);
export type PluginRequestErrorReason = typeof PluginRequestErrorReason.Type;

export class PluginRequestError extends Schema.TaggedError<PluginRequestError>()(
  "PluginRequestError",
  {
    reason: PluginRequestErrorReason,
    detail: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-installed":
        return "This plugin is not installed.";
      case "disabled":
        return "This plugin is disabled.";
      case "not-running":
        return "This plugin's backend is not running.";
      case "unknown-operation":
        return "This plugin has no such operation.";
      case "operation-mutates":
        return "This operation changes state and cannot be called as a query.";
      case "operation-failed":
        return this.detail === undefined
          ? "The plugin operation failed."
          : `The plugin operation failed: ${this.detail}`;
      case "incompatible-host-api":
        return "This plugin needs a newer or different version of T3 Code.";
      case "invalid-package":
        return this.detail === undefined
          ? "This file is not a valid T3 Code plugin package."
          : `This file is not a valid T3 Code plugin package: ${this.detail}`;
      case "too-large":
        return "The plugin request or response is too large.";
      case "worker-failed":
        return "The plugin's backend stopped unexpectedly.";
      case "capability-denied":
        return "This plugin did not declare the capability it tried to use.";
      case "subscription-limit":
        return "This plugin has too many open subscriptions.";
      case "timed-out":
        return "The plugin did not answer in time. A state-changing operation may still finish; check its status before retrying.";
      case "version-changed":
        return "This plugin was updated. Reload the panel.";
    }
  }
}

const PluginRevision = Schema.String.check(Schema.isMaxLength(128));

export const PluginSubscriptionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    items: Schema.Array(Schema.Unknown),
    revision: PluginRevision,
    cursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  }),
  Schema.Struct({
    type: Schema.Literal("batch"),
    items: Schema.Array(Schema.Unknown),
    revision: PluginRevision,
  }),
  Schema.Struct({ type: Schema.Literal("resync") }),
  Schema.Struct({
    type: Schema.Literal("closed"),
    reason: Schema.Literals([
      "plugin-disabled",
      "plugin-updated",
      "plugin-uninstalled",
      "worker-failed",
      "protocol-error",
      "too-large",
    ]),
  }),
]);
export type PluginSubscriptionEvent = typeof PluginSubscriptionEvent.Type;

export const PLUGIN_OPEN_COMMAND_PATTERN = Schema.TemplateLiteral([
  Schema.Literal("plugin."),
  PluginIdString,
  Schema.Literal("."),
  PluginContributionIdString,
]);
export type PluginOpenCommand = typeof PLUGIN_OPEN_COMMAND_PATTERN.Type;

const PluginVersion = Schema.String.check(Schema.isMaxLength(64));

export const PluginSettingValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
export type PluginSettingValue = typeof PluginSettingValue.Type;

export const PluginIdInput = Schema.Struct({ pluginId: PluginId });
export type PluginIdInput = typeof PluginIdInput.Type;

export const PluginInstallInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  trustBackendAuthor: Schema.Boolean,
});
export type PluginInstallInput = typeof PluginInstallInput.Type;

export const PluginUpdateInput = Schema.Struct({
  pluginId: PluginId,
  ...PluginInstallInput.fields,
});
export type PluginUpdateInput = typeof PluginUpdateInput.Type;

export const PluginSetEnabledInput = Schema.Struct({ pluginId: PluginId, enabled: Schema.Boolean });
export type PluginSetEnabledInput = typeof PluginSetEnabledInput.Type;

/** `null` clears a value back to its default, or removes a secret. */
export const PluginConfigureInput = Schema.Struct({
  pluginId: PluginId,
  values: Schema.Record(Schema.String, Schema.NullOr(PluginSettingValue)),
});
export type PluginConfigureInput = typeof PluginConfigureInput.Type;

export const PluginConfig = Schema.Struct({
  values: Schema.Record(Schema.String, PluginSettingValue),
  secrets: Schema.Record(Schema.String, Schema.Struct({ set: Schema.Boolean })),
});
export type PluginConfig = typeof PluginConfig.Type;

export const PluginLogsInput = Schema.Struct({
  pluginId: PluginId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type PluginLogsInput = typeof PluginLogsInput.Type;

export const PluginLogs = Schema.Struct({
  lines: Schema.Array(Schema.Struct({ at: Schema.Number, line: Schema.String })),
});
export type PluginLogs = typeof PluginLogs.Type;

/** Names one thread or one project; carrying both keys is rejected. */
export const PluginChatHint = Schema.Union([
  Schema.Struct({ threadId: ThreadId, projectId: Schema.optionalKey(Schema.Never) }),
  Schema.Struct({ projectId: ProjectId, threadId: Schema.optionalKey(Schema.Never) }),
]);
export type PluginChatHint = typeof PluginChatHint.Type;

/** Resolved by the server from a hint or the agent's thread, never taken from the caller. */
export const PluginCallContext = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  thread: Schema.NullOr(
    Schema.Struct({
      id: ThreadId,
      parentThreadId: Schema.NullOr(ThreadId),
      rootThreadId: ThreadId,
      relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent", "chat"])),
    }),
  ),
});
export type PluginCallContext = typeof PluginCallContext.Type;

export const EMPTY_PLUGIN_CALL_CONTEXT: PluginCallContext = { projectId: null, thread: null };

/** Panels always send `expectedVersion`; agent calls and references omit it. */
export const PluginOperationCallInput = Schema.Struct({
  pluginId: PluginId,
  operation: PluginOperationName,
  input: Schema.Json,
  expectedVersion: Schema.optionalKey(PluginVersion),
  /** Docked panels only: the chat beside the panel, in the install's environment. */
  chat: Schema.optionalKey(PluginChatHint),
});
export type PluginOperationCallInput = typeof PluginOperationCallInput.Type;

export const PluginSubscribeInput = Schema.Struct({
  pluginId: PluginId,
  topic: PluginOperationName,
  params: Schema.Json,
  expectedVersion: Schema.optionalKey(PluginVersion),
});
export type PluginSubscribeInput = typeof PluginSubscribeInput.Type;

export const PluginReferenceLocator = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  Schema.String.check(Schema.isMaxLength(256)),
).check(Schema.isMaxProperties(8));
export type PluginReferenceLocator = typeof PluginReferenceLocator.Type;

export const PluginResolveReferenceInput = Schema.Struct({
  pluginId: PluginId,
  locator: PluginReferenceLocator,
});
export type PluginResolveReferenceInput = typeof PluginResolveReferenceInput.Type;

export const PluginResolvedReference = Schema.Struct({
  title: Schema.String,
  detail: Schema.String,
});
export type PluginResolvedReference = typeof PluginResolvedReference.Type;

/** Worker → host request: validates a thread or project id; unknown or deleted gives `null`. */
export const PLUGIN_WORKER_CONTEXT_RESOLVE_METHOD = "t3/context.resolve";
export const PluginContextResolveParams = PluginChatHint;
export type PluginContextResolveParams = typeof PluginContextResolveParams.Type;
export const PluginContextResolveResult = Schema.NullOr(PluginCallContext);
export type PluginContextResolveResult = typeof PluginContextResolveResult.Type;

/** Panel → host bridge request `t3/chat.targets.list`. */
export const PluginChatTargetsListParams = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
export type PluginChatTargetsListParams = typeof PluginChatTargetsListParams.Type;

export const PluginChatTargets = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      title: Schema.String,
      projectId: ProjectId,
      projectName: Schema.String,
    }),
  ).check(Schema.isMaxLength(PLUGIN_LIMITS.maxChatTargets)),
  projects: Schema.Array(Schema.Struct({ projectId: ProjectId, name: Schema.String })).check(
    Schema.isMaxLength(PLUGIN_LIMITS.maxChatTargets),
  ),
});
export type PluginChatTargets = typeof PluginChatTargets.Type;
