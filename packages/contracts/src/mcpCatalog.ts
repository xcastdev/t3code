import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { McpServerId, ProjectMcpTransport, ProjectMcpTransportDraft } from "./projectMcp.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const MCP_CATALOG_NAME_MAX_LENGTH = 120;
const MCP_CATALOG_PROVIDER_LIMIT = 50;

export const McpDefinitionId = TrimmedNonEmptyString.pipe(Schema.brand("McpDefinitionId"));
export type McpDefinitionId = typeof McpDefinitionId.Type;

export const McpCatalogSessionId = TrimmedNonEmptyString.pipe(Schema.brand("McpCatalogSessionId"));
export type McpCatalogSessionId = typeof McpCatalogSessionId.Type;

export const McpCatalogOverrideId = TrimmedNonEmptyString.pipe(
  Schema.brand("McpCatalogOverrideId"),
);
export type McpCatalogOverrideId = typeof McpCatalogOverrideId.Type;

export const McpCatalogName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MCP_CATALOG_NAME_MAX_LENGTH),
);
export type McpCatalogName = typeof McpCatalogName.Type;

export const McpCatalogScope = Schema.Literals(["global", "project", "session"]);
export type McpCatalogScope = typeof McpCatalogScope.Type;

export const McpCatalogDefinition = Schema.Struct({
  definitionId: McpDefinitionId,
  logicalServerId: McpServerId,
  scope: McpCatalogScope,
  /** Environment id for global definitions, project id for project definitions,
   * and the logical catalog session id for session definitions. */
  scopeId: TrimmedNonEmptyString,
  name: McpCatalogName,
  transport: ProjectMcpTransport,
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId).check(
    Schema.isMaxLength(MCP_CATALOG_PROVIDER_LIMIT),
  ),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type McpCatalogDefinition = typeof McpCatalogDefinition.Type;

/**
 * A definition draft deliberately accepts only the persisted transport shape.
 * Credential values are prepared by the server's secret store before this
 * contract crosses into orchestration; they never enter events or snapshots.
 */
export const McpCatalogDefinitionDraft = Schema.Struct({
  name: McpCatalogName,
  transport: ProjectMcpTransportDraft,
  enabled: Schema.Boolean,
  providerInstanceIds: Schema.Array(ProviderInstanceId).check(
    Schema.isMaxLength(MCP_CATALOG_PROVIDER_LIMIT),
  ),
});
export type McpCatalogDefinitionDraft = typeof McpCatalogDefinitionDraft.Type;

const McpCatalogOverrideFields = Schema.Struct({
  id: McpCatalogOverrideId,
  scope: Schema.Literals(["project", "session"]),
  scopeId: TrimmedNonEmptyString,
  targetId: McpServerId,
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(McpCatalogName),
  providerInstanceIds: Schema.optional(
    Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(MCP_CATALOG_PROVIDER_LIMIT)),
  ),
  transport: Schema.optional(ProjectMcpTransport),
  transportDefinitionId: Schema.optional(McpDefinitionId),
});

const McpCatalogOverrideDraftFields = Schema.Struct({
  id: McpCatalogOverrideId,
  scope: Schema.Literals(["project", "session"]),
  scopeId: TrimmedNonEmptyString,
  targetId: McpServerId,
  enabled: Schema.optional(Schema.Boolean),
  name: Schema.optional(McpCatalogName),
  providerInstanceIds: Schema.optional(
    Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(MCP_CATALOG_PROVIDER_LIMIT)),
  ),
  transport: Schema.optional(ProjectMcpTransportDraft),
  /** Accepted for clients that already send the persisted shape, but replaced
   * by a server-generated id whenever a draft transport is submitted. */
  transportDefinitionId: Schema.optional(McpDefinitionId),
});

/** A lower-scope patch. Transport replacement is intentionally all-or-nothing. */
export const McpCatalogOverride = McpCatalogOverrideFields.check(
  Schema.makeFilter(
    (override) =>
      (override.transport === undefined && override.transportDefinitionId === undefined) ||
      (override.transport !== undefined && override.transportDefinitionId !== undefined),
    { message: "A transport override requires a complete transport definition id" },
  ),
);
export type McpCatalogOverride = typeof McpCatalogOverride.Type;

/**
 * The RPC form of an override may contain credential values. The server
 * prepares those values before converting this draft into McpCatalogOverride.
 */
export const McpCatalogOverrideDraft = McpCatalogOverrideDraftFields.check(
  Schema.makeFilter(
    (override) => override.transport !== undefined || override.transportDefinitionId === undefined,
    { message: "A transport definition id requires a transport override" },
  ),
);
export type McpCatalogOverrideDraft = typeof McpCatalogOverrideDraft.Type;

export const ResolvedMcpCatalogEntry = Schema.Struct({
  logicalServerId: McpServerId,
  transportDefinitionId: McpDefinitionId,
  name: McpCatalogName,
  transport: ProjectMcpTransport,
  providerInstanceId: ProviderInstanceId,
  scope: McpCatalogScope,
  scopeId: TrimmedNonEmptyString,
});
export type ResolvedMcpCatalogEntry = typeof ResolvedMcpCatalogEntry.Type;

/** Raw state used by editors. Resolution intentionally remains a separate view. */
export const McpCatalogProjectState = Schema.Struct({
  globalDefinitions: Schema.Array(McpCatalogDefinition),
  projectDefinitions: Schema.Array(McpCatalogDefinition),
  projectOverrides: Schema.Array(McpCatalogOverride),
  globalRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  projectRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type McpCatalogProjectState = typeof McpCatalogProjectState.Type;

/** Raw environment-wide catalog state used by global editors. */
export const McpCatalogGlobalState = Schema.Struct({
  definitions: Schema.Array(McpCatalogDefinition),
  globalRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type McpCatalogGlobalState = typeof McpCatalogGlobalState.Type;

export const McpCatalogApplication = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("applied"),
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    appliedAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    failedAt: IsoDateTime,
    reason: TrimmedNonEmptyString,
  }),
]);
export type McpCatalogApplication = typeof McpCatalogApplication.Type;

/**
 * The logical-session snapshot owns the complete resolved transport and its
 * definition id. This is what lets runtime recovery resolve credentials for
 * an old definition after the saved global/project catalog has rotated.
 */
export const McpCatalogSnapshot = Schema.Struct({
  catalogSessionId: McpCatalogSessionId,
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  baseline: Schema.Array(McpCatalogDefinition),
  desired: Schema.Array(McpCatalogDefinition),
  applied: Schema.Array(McpCatalogDefinition).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  desiredRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  appliedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  application: Schema.optional(McpCatalogApplication),
  disposedAt: Schema.optional(IsoDateTime),
});
export type McpCatalogSnapshot = typeof McpCatalogSnapshot.Type;

export class McpCatalogNameConflictError extends Schema.TaggedErrorClass<McpCatalogNameConflictError>()(
  "McpCatalogNameConflictError",
  {
    conflicts: Schema.Array(
      Schema.Struct({
        logicalServerId: McpServerId,
        name: McpCatalogName,
        scope: McpCatalogScope,
        scopeId: TrimmedNonEmptyString,
        providerInstanceIds: Schema.Array(ProviderInstanceId),
      }),
    ),
  },
) {
  override get message(): string {
    return `MCP catalog names conflict for ${this.conflicts.length} definition(s).`;
  }
}

export class McpCatalogProviderLimitExceededError extends Schema.TaggedErrorClass<McpCatalogProviderLimitExceededError>()(
  "McpCatalogProviderLimitExceededError",
  {
    providerInstanceId: ProviderInstanceId,
    limit: Schema.Int,
  },
) {
  override get message(): string {
    return `Provider '${this.providerInstanceId}' cannot expose more than ${this.limit} MCP servers.`;
  }
}

export class McpCatalogStaleRevisionError extends Schema.TaggedErrorClass<McpCatalogStaleRevisionError>()(
  "McpCatalogStaleRevisionError",
  {
    scope: McpCatalogScope,
    scopeId: TrimmedNonEmptyString,
    expectedRevision: Schema.Int,
    actualRevision: Schema.Int,
  },
) {}

export class McpCatalogStaleSessionError extends Schema.TaggedErrorClass<McpCatalogStaleSessionError>()(
  "McpCatalogStaleSessionError",
  {
    threadId: ThreadId,
    requestedSessionId: McpCatalogSessionId,
    activeSessionId: McpCatalogSessionId,
  },
) {}

export class McpCatalogUnsupportedProviderError extends Schema.TaggedErrorClass<McpCatalogUnsupportedProviderError>()(
  "McpCatalogUnsupportedProviderError",
  {
    providerInstanceId: ProviderInstanceId,
  },
) {}

export class McpCatalogOperationError extends Schema.TaggedErrorClass<McpCatalogOperationError>()(
  "McpCatalogOperationError",
  { message: Schema.String },
) {}

export const McpCatalogListInput = Schema.Struct({
  scope: McpCatalogScope,
  scopeId: TrimmedNonEmptyString,
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type McpCatalogListInput = typeof McpCatalogListInput.Type;

export const McpCatalogMutationBase = Schema.Struct({
  scope: McpCatalogScope,
  scopeId: TrimmedNonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type McpCatalogMutationBase = typeof McpCatalogMutationBase.Type;

const McpCatalogGlobalScope = Schema.Struct({
  scope: Schema.Literal("global"),
  scopeId: EnvironmentId,
});

const McpCatalogProjectScope = Schema.Struct({
  scope: Schema.Literal("project"),
  scopeId: ProjectId,
});

const McpCatalogSessionScope = Schema.Struct({
  scope: Schema.Literal("session"),
  scopeId: McpCatalogSessionId,
});

export const McpCatalogGlobalListInput = Schema.Struct({
  ...McpCatalogGlobalScope.fields,
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type McpCatalogGlobalListInput = typeof McpCatalogGlobalListInput.Type;

export const McpCatalogProjectListInput = Schema.Struct({
  ...McpCatalogProjectScope.fields,
  providerInstanceId: Schema.optional(ProviderInstanceId),
});
export type McpCatalogProjectListInput = typeof McpCatalogProjectListInput.Type;

export const McpCatalogGlobalCreateInput = Schema.Struct({
  ...McpCatalogGlobalScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  definition: McpCatalogDefinitionDraft,
  logicalServerId: Schema.optional(McpServerId),
});
export type McpCatalogGlobalCreateInput = typeof McpCatalogGlobalCreateInput.Type;

export const McpCatalogGlobalUpdateInput = Schema.Struct({
  ...McpCatalogGlobalScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  logicalServerId: McpServerId,
  definition: McpCatalogDefinitionDraft,
});
export type McpCatalogGlobalUpdateInput = typeof McpCatalogGlobalUpdateInput.Type;

export const McpCatalogGlobalRemoveInput = Schema.Struct({
  ...McpCatalogGlobalScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  logicalServerId: McpServerId,
});
export type McpCatalogGlobalRemoveInput = typeof McpCatalogGlobalRemoveInput.Type;

export const McpCatalogProjectCreateInput = Schema.Struct({
  ...McpCatalogProjectScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  definition: McpCatalogDefinitionDraft,
  logicalServerId: Schema.optional(McpServerId),
});
export type McpCatalogProjectCreateInput = typeof McpCatalogProjectCreateInput.Type;

export const McpCatalogProjectUpdateInput = Schema.Struct({
  ...McpCatalogProjectScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  logicalServerId: McpServerId,
  definition: McpCatalogDefinitionDraft,
});
export type McpCatalogProjectUpdateInput = typeof McpCatalogProjectUpdateInput.Type;

export const McpCatalogProjectRemoveInput = Schema.Struct({
  ...McpCatalogProjectScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  logicalServerId: McpServerId,
});
export type McpCatalogProjectRemoveInput = typeof McpCatalogProjectRemoveInput.Type;

export const McpCatalogProjectOverrideInput = Schema.Struct({
  ...McpCatalogProjectScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  override: McpCatalogOverrideDraft,
}).check(
  Schema.makeFilter(
    (input) => input.override.scope === "project" && input.override.scopeId === input.scopeId,
    { message: "The MCP project override must target the request project." },
  ),
);
export type McpCatalogProjectOverrideInput = typeof McpCatalogProjectOverrideInput.Type;

export const McpCatalogProjectDeleteOverrideInput = Schema.Struct({
  ...McpCatalogProjectScope.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  overrideId: McpCatalogOverrideId,
});
export type McpCatalogProjectDeleteOverrideInput = typeof McpCatalogProjectDeleteOverrideInput.Type;

const McpCatalogSessionMutationScope = Schema.Struct({
  ...McpCatalogSessionScope.fields,
  threadId: ThreadId,
  mcpCatalogSessionId: McpCatalogSessionId,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).check(
  Schema.makeFilter((input) => input.scopeId === input.mcpCatalogSessionId, {
    message: "The MCP session scope id must match the catalog session id.",
  }),
);

export const McpCatalogSessionCreateInput = Schema.Struct({
  ...McpCatalogSessionMutationScope.fields,
  definition: McpCatalogDefinitionDraft,
  logicalServerId: Schema.optional(McpServerId),
}).check(
  Schema.makeFilter((input) => input.scopeId === input.mcpCatalogSessionId, {
    message: "The MCP session scope id must match the catalog session id.",
  }),
);
export type McpCatalogSessionCreateInput = typeof McpCatalogSessionCreateInput.Type;

export const McpCatalogSessionUpdateInput = Schema.Struct({
  ...McpCatalogSessionMutationScope.fields,
  logicalServerId: McpServerId,
  definition: McpCatalogDefinitionDraft,
}).check(
  Schema.makeFilter((input) => input.scopeId === input.mcpCatalogSessionId, {
    message: "The MCP session scope id must match the catalog session id.",
  }),
);
export type McpCatalogSessionUpdateInput = typeof McpCatalogSessionUpdateInput.Type;

export const McpCatalogSessionRemoveInput = Schema.Struct({
  ...McpCatalogSessionMutationScope.fields,
  logicalServerId: McpServerId,
}).check(
  Schema.makeFilter((input) => input.scopeId === input.mcpCatalogSessionId, {
    message: "The MCP session scope id must match the catalog session id.",
  }),
);
export type McpCatalogSessionRemoveInput = typeof McpCatalogSessionRemoveInput.Type;

export const McpCatalogCreateInput = Schema.Struct({
  ...McpCatalogMutationBase.fields,
  scope: Schema.Literals(["global", "project", "session"]),
  definition: McpCatalogDefinitionDraft,
  logicalServerId: Schema.optional(McpServerId),
});
export type McpCatalogCreateInput = typeof McpCatalogCreateInput.Type;

export const McpCatalogUpdateInput = Schema.Struct({
  ...McpCatalogMutationBase.fields,
  logicalServerId: McpServerId,
  definition: McpCatalogDefinitionDraft,
});
export type McpCatalogUpdateInput = typeof McpCatalogUpdateInput.Type;

export const McpCatalogRemoveInput = Schema.Struct({
  ...McpCatalogMutationBase.fields,
  logicalServerId: McpServerId,
});
export type McpCatalogRemoveInput = typeof McpCatalogRemoveInput.Type;

export const McpCatalogOverrideInput = Schema.Struct({
  scope: Schema.Literals(["project", "session"]),
  scopeId: TrimmedNonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  override: McpCatalogOverrideDraft,
});
export type McpCatalogOverrideInput = typeof McpCatalogOverrideInput.Type;

export const McpCatalogDeleteOverrideInput = Schema.Struct({
  scope: Schema.Literals(["project", "session"]),
  scopeId: TrimmedNonEmptyString,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  overrideId: McpCatalogOverrideId,
});
export type McpCatalogDeleteOverrideInput = typeof McpCatalogDeleteOverrideInput.Type;

export const McpCatalogSessionRequest = Schema.Struct({
  threadId: ThreadId,
  mcpCatalogSessionId: McpCatalogSessionId,
});
export type McpCatalogSessionRequest = typeof McpCatalogSessionRequest.Type;

export const McpCatalogOAuthTarget = Schema.Struct({
  projectId: ProjectId,
  logicalServerId: McpServerId,
  transportDefinitionId: McpDefinitionId,
  threadId: Schema.optional(ThreadId),
  mcpCatalogSessionId: Schema.optional(McpCatalogSessionId),
}).check(
  Schema.makeFilter(
    (target) => (target.threadId === undefined) === (target.mcpCatalogSessionId === undefined),
    { message: "A scoped MCP OAuth session target requires both thread and session ids." },
  ),
);
export type McpCatalogOAuthTarget = typeof McpCatalogOAuthTarget.Type;

export const McpCatalogOAuthBeginInput = McpCatalogOAuthTarget;
export type McpCatalogOAuthBeginInput = typeof McpCatalogOAuthBeginInput.Type;
export const McpCatalogOAuthContinueInput = McpCatalogOAuthTarget;
export type McpCatalogOAuthContinueInput = typeof McpCatalogOAuthContinueInput.Type;
export const McpCatalogOAuthDisconnectInput = McpCatalogOAuthTarget;
export type McpCatalogOAuthDisconnectInput = typeof McpCatalogOAuthDisconnectInput.Type;

export const McpCatalogSessionMutationInput = Schema.Struct({
  ...McpCatalogSessionRequest.fields,
  expectedRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type McpCatalogSessionMutationInput = typeof McpCatalogSessionMutationInput.Type;

export const McpCatalogChanged = Schema.Struct({
  scope: McpCatalogScope,
  scopeId: TrimmedNonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type McpCatalogChanged = typeof McpCatalogChanged.Type;

export const McpCatalogSubscriptionInput = Schema.Struct({
  catalog: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type McpCatalogSubscriptionInput = typeof McpCatalogSubscriptionInput.Type;

export const McpCatalogMutationError = Schema.Union([
  McpCatalogNameConflictError,
  McpCatalogProviderLimitExceededError,
  McpCatalogStaleRevisionError,
  McpCatalogStaleSessionError,
  McpCatalogUnsupportedProviderError,
  McpCatalogOperationError,
]);
export type McpCatalogMutationError = typeof McpCatalogMutationError.Type;

export const MCP_CATALOG_PROVIDER_ENTRY_LIMIT = MCP_CATALOG_PROVIDER_LIMIT;
export const MCP_CATALOG_NAME_MAX_CHARS = MCP_CATALOG_NAME_MAX_LENGTH;

// Keep the environment/project aliases discoverable to callers that need to
// build a scope-specific request without importing implementation details.
export type McpCatalogScopeId = EnvironmentId | ProjectId | McpCatalogSessionId;
