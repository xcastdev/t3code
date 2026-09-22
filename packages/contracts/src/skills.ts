import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const MANAGED_SKILL_KEY_MAX_LENGTH = 64;
const MANAGED_SKILL_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MANAGED_SKILL_ID_MAX_LENGTH = 128;
const MANAGED_SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const WINDOWS_RESERVED_PATH_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SKILL_REASON_CODE_MAX_LENGTH = 128;
const SKILL_REASON_MESSAGE_MAX_LENGTH = 1_000;
const SKILL_COMPATIBILITY_REASON_LIMIT = 16;

export const ManagedSkillId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MANAGED_SKILL_ID_MAX_LENGTH),
  Schema.isPattern(MANAGED_SKILL_ID_PATTERN),
  Schema.makeFilter((value) => !WINDOWS_RESERVED_PATH_COMPONENT.test(value), {
    identifier: "ManagedSkillId",
  }),
).pipe(Schema.brand("ManagedSkillId"));
export type ManagedSkillId = typeof ManagedSkillId.Type;

export const SkillNativeObservationId = TrimmedNonEmptyString.pipe(
  Schema.brand("SkillNativeObservationId"),
);
export type SkillNativeObservationId = typeof SkillNativeObservationId.Type;

export const ManagedSkillKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MANAGED_SKILL_KEY_MAX_LENGTH),
  Schema.isPattern(MANAGED_SKILL_KEY_PATTERN),
).pipe(Schema.brand("ManagedSkillKey"));
export type ManagedSkillKey = typeof ManagedSkillKey.Type;

export const SkillContentHash = TrimmedNonEmptyString.pipe(Schema.brand("SkillContentHash"));
export type SkillContentHash = typeof SkillContentHash.Type;

export const SkillCatalogRevision = NonNegativeInt.pipe(Schema.brand("SkillCatalogRevision"));
export type SkillCatalogRevision = typeof SkillCatalogRevision.Type;

export const SkillManagedScope = Schema.Literals(["global", "project"]);
export type SkillManagedScope = typeof SkillManagedScope.Type;

/** `inherit` is a resolved catalog state; project storage represents it by having no entry. */
export const SkillProjectState = Schema.Literals(["inherit", "override", "disabled", "orphan"]);
export type SkillProjectState = typeof SkillProjectState.Type;

export const SkillAuthoredOrigin = Schema.Literals(["created", "imported"]);
export type SkillAuthoredOrigin = typeof SkillAuthoredOrigin.Type;

export const SkillOwnership = Schema.Literals(["t3", "external"]);
export type SkillOwnership = typeof SkillOwnership.Type;

export const SkillRevisionRef = Schema.Struct({
  revision: NonNegativeInt,
  hash: SkillContentHash,
});
export type SkillRevisionRef = typeof SkillRevisionRef.Type;

/**
 * The portable subset of YAML that T3 preserves in a skill's frontmatter.
 * Provider-specific keys (for example Claude's `allowed-tools`) remain in
 * this map while the portable `name` and `description` fields stay owned by
 * the managed-skill model.
 */
export type ManagedSkillFrontmatterValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<ManagedSkillFrontmatterValue>
  | { readonly [key: string]: ManagedSkillFrontmatterValue };

export const isManagedSkillFrontmatterValue = (
  value: unknown,
  seen: ReadonlySet<object> = new Set(),
): value is ManagedSkillFrontmatterValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(value);
  if (Array.isArray(value))
    return value.every((item) => isManagedSkillFrontmatterValue(item, nextSeen));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  return Object.entries(value).every(
    ([key, item]) => key.length > 0 && isManagedSkillFrontmatterValue(item, nextSeen),
  );
};

const ManagedSkillFrontmatterValue = Schema.Unknown.pipe(
  Schema.refine(
    (value): value is ManagedSkillFrontmatterValue => isManagedSkillFrontmatterValue(value),
    { message: "Skill frontmatter contains an unsupported value." },
  ),
);

const isSafeFrontmatterMapping = (
  value: ManagedSkillFrontmatterValue,
): value is { readonly [key: string]: ManagedSkillFrontmatterValue } =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const knownFrontmatterFieldError = (value: ManagedSkillFrontmatterValue): string | undefined => {
  if (!isSafeFrontmatterMapping(value)) return undefined;
  if (Object.hasOwn(value, "license") && typeof value.license !== "string") {
    return "Skill frontmatter license must be a string.";
  }
  if (Object.hasOwn(value, "compatibility") && typeof value.compatibility !== "string") {
    return "Skill frontmatter compatibility must be a string.";
  }
  if (
    Object.hasOwn(value, "disable-model-invocation") &&
    typeof value["disable-model-invocation"] !== "boolean"
  ) {
    return "Skill frontmatter disable-model-invocation must be a boolean.";
  }
  if (Object.hasOwn(value, "user-invocable") && typeof value["user-invocable"] !== "boolean") {
    return "Skill frontmatter user-invocable must be a boolean.";
  }
  if (Object.hasOwn(value, "argument-hint") && typeof value["argument-hint"] !== "string") {
    return "Skill frontmatter argument-hint must be a string.";
  }
  if (Object.hasOwn(value, "allowed-tools")) {
    const allowedTools = value["allowed-tools"];
    if (
      typeof allowedTools !== "string" &&
      !(Array.isArray(allowedTools) && allowedTools.every((tool) => typeof tool === "string"))
    ) {
      return "Skill frontmatter allowed-tools must be a string or an array of strings.";
    }
  }
  const metadata = value.metadata;
  if (metadata !== undefined && !isSafeFrontmatterMapping(metadata)) {
    return "Skill frontmatter metadata must be a mapping.";
  }
  return undefined;
};

export const ManagedSkillFrontmatter = Schema.Record(
  Schema.String,
  ManagedSkillFrontmatterValue,
).pipe(
  Schema.check(
    Schema.makeFilter((value) => {
      if (Object.hasOwn(value, "name") || Object.hasOwn(value, "description")) {
        return "Skill frontmatter extensions cannot redefine name or description.";
      }
      return knownFrontmatterFieldError(value);
    }),
  ),
);
export type ManagedSkillFrontmatter = typeof ManagedSkillFrontmatter.Type;

export const ManagedSkillAuthoredMetadata = Schema.Struct({
  id: ManagedSkillId,
  key: ManagedSkillKey,
  name: TrimmedNonEmptyString,
  scope: SkillManagedScope,
  scopeId: TrimmedNonEmptyString,
  origin: SkillAuthoredOrigin,
  ownership: SkillOwnership,
  revision: SkillRevisionRef,
});
export type ManagedSkillAuthoredMetadata = typeof ManagedSkillAuthoredMetadata.Type;

export const ManagedSkillContent = Schema.Struct({
  key: ManagedSkillKey,
  name: TrimmedNonEmptyString,
  body: Schema.String,
  assetPaths: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  frontmatter: Schema.optionalKey(ManagedSkillFrontmatter),
});
export type ManagedSkillContent = typeof ManagedSkillContent.Type;

export const ManagedSkillContentDraft = Schema.Struct({
  name: TrimmedNonEmptyString,
  body: Schema.String,
  assetPaths: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  frontmatter: Schema.optionalKey(ManagedSkillFrontmatter),
});
export type ManagedSkillContentDraft = typeof ManagedSkillContentDraft.Type;

export const ManagedSkillManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("managed-skill"),
  id: ManagedSkillId,
  key: ManagedSkillKey,
  scope: SkillManagedScope,
  revision: SkillRevisionRef,
  origin: SkillAuthoredOrigin,
  ownership: SkillOwnership,
});
export type ManagedSkillManifest = typeof ManagedSkillManifest.Type;

export const SkillReasonSummary = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_REASON_CODE_MAX_LENGTH)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(SKILL_REASON_MESSAGE_MAX_LENGTH)),
});
export type SkillReasonSummary = typeof SkillReasonSummary.Type;

export const SkillDiscoveryError = SkillReasonSummary;
export type SkillDiscoveryError = typeof SkillDiscoveryError.Type;

export const SkillNativeFreshness = Schema.Literals(["fresh", "stale", "unavailable"]);
export type SkillNativeFreshness = typeof SkillNativeFreshness.Type;

const SkillNativeObservationFields = {
  observationId: SkillNativeObservationId,
  providerInstanceId: ProviderInstanceId,
  nativeIdentity: TrimmedNonEmptyString,
  contentAccess: Schema.optionalKey(Schema.Literals(["local", "external"])),
  key: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  source: TrimmedNonEmptyString,
  scopeSummary: TrimmedNonEmptyString,
  providerEnabled: Schema.optionalKey(Schema.Boolean),
  modelAvailable: Schema.optionalKey(Schema.Boolean),
  userInvocable: Schema.optionalKey(Schema.Boolean),
  freshness: SkillNativeFreshness,
  observedAt: Schema.optionalKey(IsoDateTime),
  attemptedAt: IsoDateTime,
  discoveryError: Schema.optionalKey(SkillDiscoveryError),
};

/** Client-safe native discovery state. Full server paths belong only in the server-only form. */
export const SkillNativeObservation = Schema.Struct(SkillNativeObservationFields);
export type SkillNativeObservation = typeof SkillNativeObservation.Type;

export const SkillNativeObservationWithPath = Schema.Struct({
  ...SkillNativeObservationFields,
  nativePath: TrimmedNonEmptyString,
});
export type SkillNativeObservationWithPath = typeof SkillNativeObservationWithPath.Type;

export const SkillNativeDiscoveryResult = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  freshness: SkillNativeFreshness,
  attemptedAt: IsoDateTime,
  observations: Schema.Array(SkillNativeObservation),
  discoveryError: Schema.optionalKey(SkillDiscoveryError),
});
export type SkillNativeDiscoveryResult = typeof SkillNativeDiscoveryResult.Type;

export const SkillCompatibilitySupport = Schema.Literals([
  "supported",
  "supported_with_limitations",
  "unsupported",
]);
export type SkillCompatibilitySupport = typeof SkillCompatibilitySupport.Type;

export const SkillApplicationMode = Schema.Literals([
  "live",
  "new_session_required",
  "restart_required",
  "unsupported",
]);
export type SkillApplicationMode = typeof SkillApplicationMode.Type;

export const SkillCompatibility = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  support: SkillCompatibilitySupport,
  applicationMode: SkillApplicationMode,
  reasons: Schema.Array(SkillReasonSummary).check(
    Schema.isMaxLength(SKILL_COMPATIBILITY_REASON_LIMIT),
  ),
});
export type SkillCompatibility = typeof SkillCompatibility.Type;

export const SkillApplicationStatus = Schema.Literals([
  "applied",
  "pending_new_session",
  "pending_restart",
  "failed",
  "unsupported",
]);
export type SkillApplicationStatus = typeof SkillApplicationStatus.Type;

export const SkillApplicationFailure = SkillReasonSummary;
export type SkillApplicationFailure = typeof SkillApplicationFailure.Type;

export const SkillApplicationSummary = Schema.Struct({
  desiredRevision: SkillCatalogRevision,
  appliedRevision: SkillCatalogRevision,
  status: SkillApplicationStatus,
  failure: Schema.optionalKey(SkillApplicationFailure),
});
export type SkillApplicationSummary = typeof SkillApplicationSummary.Type;

export const SkillApplicationDiagnostic = Schema.Struct({
  ...SkillReasonSummary.fields,
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type SkillApplicationDiagnostic = typeof SkillApplicationDiagnostic.Type;

export const SkillApplicationDetail = Schema.Struct({
  ...SkillApplicationSummary.fields,
  providerInstanceId: ProviderInstanceId,
  threadId: Schema.optionalKey(ThreadId),
  outcomes: Schema.Array(
    Schema.Struct({
      key: ManagedSkillKey,
      status: SkillApplicationStatus,
      reason: Schema.optionalKey(SkillApplicationDiagnostic),
    }),
  ),
  attemptedAt: Schema.optionalKey(IsoDateTime),
  appliedAt: Schema.optionalKey(IsoDateTime),
});
export type SkillApplicationDetail = typeof SkillApplicationDetail.Type;

export const SkillCatalogValidity = Schema.Literals(["valid", "invalid"]);
export type SkillCatalogValidity = typeof SkillCatalogValidity.Type;

export const SkillConflictShadowSummary = Schema.Struct({
  kind: Schema.Literals(["conflict", "shadows", "shadowed"]),
  keys: Schema.Array(ManagedSkillKey),
  message: TrimmedNonEmptyString,
});
export type SkillConflictShadowSummary = typeof SkillConflictShadowSummary.Type;

const SkillCatalogSummaryCommonFields = {
  key: ManagedSkillKey,
  name: TrimmedNonEmptyString,
  scope: Schema.Literals(["global", "project", "provider"]),
  scopeId: TrimmedNonEmptyString,
  projectState: SkillProjectState,
  revision: SkillRevisionRef,
  validity: SkillCatalogValidity,
  effective: Schema.Boolean,
  compatibility: Schema.Array(SkillCompatibility),
  application: Schema.optionalKey(SkillApplicationSummary),
  conflict: Schema.optionalKey(SkillConflictShadowSummary),
};

export const SkillManagedCatalogSummary = Schema.Struct({
  origin: Schema.Literal("managed"),
  id: ManagedSkillId,
  ...SkillCatalogSummaryCommonFields,
});
export type SkillManagedCatalogSummary = typeof SkillManagedCatalogSummary.Type;

export const SkillNativeCatalogSummary = Schema.Struct({
  origin: Schema.Literal("native"),
  id: SkillNativeObservationId,
  providerInstanceId: ProviderInstanceId,
  ...SkillCatalogSummaryCommonFields,
  key: TrimmedNonEmptyString,
});
export type SkillNativeCatalogSummary = typeof SkillNativeCatalogSummary.Type;

export const SkillCatalogSummary = Schema.Union([
  SkillManagedCatalogSummary,
  SkillNativeCatalogSummary,
]);
export type SkillCatalogSummary = typeof SkillCatalogSummary.Type;

export const SkillCatalogListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
  providerInstanceId: Schema.optionalKey(ProviderInstanceId),
});
export type SkillCatalogListInput = typeof SkillCatalogListInput.Type;

export const SkillCatalogListResult = Schema.Struct({
  catalogRevision: SkillCatalogRevision,
  entries: Schema.Array(SkillCatalogSummary),
  diagnostics: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        scope: SkillManagedScope,
        scopeId: TrimmedNonEmptyString,
        name: Schema.String,
        reasons: Schema.Array(SkillReasonSummary),
      }),
    ),
  ),
  nativeDiscoveries: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        providerInstanceId: ProviderInstanceId,
        freshness: SkillNativeFreshness,
        attemptedAt: IsoDateTime,
        discoveryError: Schema.optionalKey(SkillDiscoveryError),
      }),
    ),
  ),
});
export type SkillCatalogListResult = typeof SkillCatalogListResult.Type;

export const SkillSessionOverlay = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  key: ManagedSkillKey,
  enabled: Schema.Boolean,
  revision: SkillCatalogRevision,
});
export type SkillSessionOverlay = typeof SkillSessionOverlay.Type;

export const SkillContentGetInput = Schema.Struct({
  skillId: ManagedSkillId,
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
});
export type SkillContentGetInput = typeof SkillContentGetInput.Type;

export const SkillContentDetail = Schema.Struct({
  metadata: ManagedSkillAuthoredMetadata,
  content: ManagedSkillContent,
});
export type SkillContentDetail = typeof SkillContentDetail.Type;

export const SkillContentGetResult = SkillContentDetail;
export type SkillContentGetResult = typeof SkillContentGetResult.Type;

export const SkillHistoryListInput = Schema.Struct({ skillId: ManagedSkillId });
export type SkillHistoryListInput = typeof SkillHistoryListInput.Type;

export const SkillHistoryEntry = Schema.Struct({
  revision: SkillRevisionRef,
  createdAt: IsoDateTime,
  name: TrimmedNonEmptyString,
});
export type SkillHistoryEntry = typeof SkillHistoryEntry.Type;

export const SkillHistoryListResult = Schema.Struct({ entries: Schema.Array(SkillHistoryEntry) });
export type SkillHistoryListResult = typeof SkillHistoryListResult.Type;

export const SkillNativeContentGetInput = Schema.Struct({
  observationId: SkillNativeObservationId,
  maxBytes: NonNegativeInt.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(256 * 1024),
  ),
});
export type SkillNativeContentGetInput = typeof SkillNativeContentGetInput.Type;

export const SkillNativeContentDetail = Schema.Struct({
  observation: SkillNativeObservation,
  content: Schema.String,
  truncated: Schema.Boolean,
  provenance: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SkillNativeContentDetail = typeof SkillNativeContentDetail.Type;

export const SkillNativeContentGetResult = SkillNativeContentDetail;
export type SkillNativeContentGetResult = typeof SkillNativeContentGetResult.Type;

export const SkillApplicationGetInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  threadId: Schema.optionalKey(ThreadId),
});
export type SkillApplicationGetInput = typeof SkillApplicationGetInput.Type;

export const SkillApplicationGetResult = SkillApplicationDetail;
export type SkillApplicationGetResult = typeof SkillApplicationGetResult.Type;

const SkillGlobalScopeFields = { environmentId: EnvironmentId };
const SkillProjectScopeFields = { projectId: ProjectId };
const ExpectedCatalogRevisionFields = { expectedRevision: SkillCatalogRevision };
const ExpectedContentHashFields = { expectedHash: SkillContentHash };

export const SkillGlobalCreateInput = Schema.Struct({
  ...SkillGlobalScopeFields,
  ...ExpectedCatalogRevisionFields,
  content: ManagedSkillContent,
});
export type SkillGlobalCreateInput = typeof SkillGlobalCreateInput.Type;

export const SkillGlobalUpdateInput = Schema.Struct({
  ...SkillGlobalScopeFields,
  skillId: ManagedSkillId,
  ...ExpectedContentHashFields,
  content: ManagedSkillContentDraft,
});
export type SkillGlobalUpdateInput = typeof SkillGlobalUpdateInput.Type;

export const SkillGlobalDeleteInput = Schema.Struct({
  ...SkillGlobalScopeFields,
  skillId: ManagedSkillId,
  ...ExpectedContentHashFields,
});
export type SkillGlobalDeleteInput = typeof SkillGlobalDeleteInput.Type;

export const SkillGlobalRenameInput = Schema.Struct({
  ...SkillGlobalScopeFields,
  skillId: ManagedSkillId,
  ...ExpectedContentHashFields,
  key: ManagedSkillKey,
});
export type SkillGlobalRenameInput = typeof SkillGlobalRenameInput.Type;

export const SkillGlobalRollbackInput = Schema.Struct({
  ...SkillGlobalScopeFields,
  skillId: ManagedSkillId,
  ...ExpectedContentHashFields,
  revision: NonNegativeInt,
});
export type SkillGlobalRollbackInput = typeof SkillGlobalRollbackInput.Type;

export const SkillProjectSetOverrideInput = Schema.Struct({
  ...SkillProjectScopeFields,
  ...ExpectedCatalogRevisionFields,
  key: ManagedSkillKey,
  content: ManagedSkillContentDraft,
});
export type SkillProjectSetOverrideInput = typeof SkillProjectSetOverrideInput.Type;

export const SkillProjectSetDisabledInput = Schema.Struct({
  ...SkillProjectScopeFields,
  ...ExpectedCatalogRevisionFields,
  key: ManagedSkillKey,
});
export type SkillProjectSetDisabledInput = typeof SkillProjectSetDisabledInput.Type;

export const SkillProjectDeleteStateInput = Schema.Struct({
  ...SkillProjectScopeFields,
  ...ExpectedCatalogRevisionFields,
  key: ManagedSkillKey,
});
export type SkillProjectDeleteStateInput = typeof SkillProjectDeleteStateInput.Type;

export const SkillProjectRenameInput = Schema.Struct({
  ...SkillProjectScopeFields,
  skillId: ManagedSkillId,
  ...ExpectedContentHashFields,
  key: ManagedSkillKey,
});
export type SkillProjectRenameInput = typeof SkillProjectRenameInput.Type;

export const SkillSessionSetEnabledInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  ...ExpectedCatalogRevisionFields,
  key: ManagedSkillKey,
  enabled: Schema.Boolean,
});
export type SkillSessionSetEnabledInput = typeof SkillSessionSetEnabledInput.Type;

export const SkillSessionResetInput = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  ...ExpectedCatalogRevisionFields,
  key: Schema.optionalKey(ManagedSkillKey),
});
export type SkillSessionResetInput = typeof SkillSessionResetInput.Type;

export const SkillNativeImportInput = Schema.Struct({
  ...SkillGlobalScopeFields,
  ...ExpectedCatalogRevisionFields,
  observationId: SkillNativeObservationId,
  key: ManagedSkillKey,
});
export type SkillNativeImportInput = typeof SkillNativeImportInput.Type;

export const SkillMutationResult = Schema.Struct({
  catalogRevision: SkillCatalogRevision,
  changedKeys: Schema.Array(ManagedSkillKey),
  summary: Schema.optionalKey(SkillCatalogSummary),
});
export type SkillMutationResult = typeof SkillMutationResult.Type;

export const SkillGlobalCreateResult = SkillMutationResult;
export type SkillGlobalCreateResult = typeof SkillGlobalCreateResult.Type;
export const SkillGlobalUpdateResult = SkillMutationResult;
export type SkillGlobalUpdateResult = typeof SkillGlobalUpdateResult.Type;
export const SkillGlobalDeleteResult = SkillMutationResult;
export type SkillGlobalDeleteResult = typeof SkillGlobalDeleteResult.Type;
export const SkillGlobalRenameResult = SkillMutationResult;
export type SkillGlobalRenameResult = typeof SkillGlobalRenameResult.Type;
export const SkillGlobalRollbackResult = SkillMutationResult;
export type SkillGlobalRollbackResult = typeof SkillGlobalRollbackResult.Type;
export const SkillProjectSetOverrideResult = SkillMutationResult;
export type SkillProjectSetOverrideResult = typeof SkillProjectSetOverrideResult.Type;
export const SkillProjectSetDisabledResult = SkillMutationResult;
export type SkillProjectSetDisabledResult = typeof SkillProjectSetDisabledResult.Type;
export const SkillProjectDeleteStateResult = SkillMutationResult;
export type SkillProjectDeleteStateResult = typeof SkillProjectDeleteStateResult.Type;
export const SkillProjectRenameResult = SkillMutationResult;
export type SkillProjectRenameResult = typeof SkillProjectRenameResult.Type;
export const SkillSessionSetEnabledResult = SkillMutationResult;
export type SkillSessionSetEnabledResult = typeof SkillSessionSetEnabledResult.Type;
export const SkillSessionResetResult = SkillMutationResult;
export type SkillSessionResetResult = typeof SkillSessionResetResult.Type;
export const SkillNativeImportResult = SkillMutationResult;
export type SkillNativeImportResult = typeof SkillNativeImportResult.Type;

export const SkillChangedScope = Schema.Literals(["global", "project", "session", "provider"]);
export type SkillChangedScope = typeof SkillChangedScope.Type;

export const SkillCatalogChanged = Schema.Struct({
  eventId: Schema.optionalKey(EventId),
  scope: SkillChangedScope,
  scopeId: TrimmedNonEmptyString,
  catalogRevision: SkillCatalogRevision,
  changedKeys: Schema.Array(ManagedSkillKey),
});
export type SkillCatalogChanged = typeof SkillCatalogChanged.Type;

export class SkillRpcError extends Schema.TaggedError<SkillRpcError>()("SkillRpcError", {
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
}) {}

export const MANAGED_SKILL_KEY_MAX_CHARS = MANAGED_SKILL_KEY_MAX_LENGTH;
