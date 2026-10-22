import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const MANAGED_TEXT_RESOURCE_ID_MAX_LENGTH = 128;
const MANAGED_TEXT_RESOURCE_KEY_MAX_LENGTH = 64;
const MANAGED_TEXT_RESOURCE_NAME_MAX_LENGTH = 128;
const MANAGED_TEXT_RESOURCE_REVISION_MAX_LENGTH = 128;
const MANAGED_TEXT_RESOURCE_BODY_MAX_LENGTH = 65_536;
const MANAGED_TEXT_RESOURCE_SUMMARY_LIMIT = 512;
const MANAGED_TEXT_RESOURCE_CHANGE_LIMIT = 128;
const MANAGED_TEXT_RESOURCE_MESSAGE_MAX_LENGTH = 1_000;

const MANAGED_TEXT_RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MANAGED_TEXT_RESOURCE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_PATH_COMPONENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const ManagedTextResourceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MANAGED_TEXT_RESOURCE_ID_MAX_LENGTH),
  Schema.isPattern(MANAGED_TEXT_RESOURCE_ID_PATTERN),
  Schema.makeFilter((value) => !WINDOWS_RESERVED_PATH_COMPONENT.test(value), {
    identifier: "ManagedTextResourceId",
  }),
).pipe(Schema.brand("ManagedTextResourceId"));
export type ManagedTextResourceId = typeof ManagedTextResourceId.Type;

export const ManagedTextResourceKey = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MANAGED_TEXT_RESOURCE_KEY_MAX_LENGTH),
  Schema.isPattern(MANAGED_TEXT_RESOURCE_KEY_PATTERN),
  Schema.makeFilter((value) => !WINDOWS_RESERVED_PATH_COMPONENT.test(value), {
    identifier: "ManagedTextResourceKey",
  }),
).pipe(Schema.brand("ManagedTextResourceKey"));
export type ManagedTextResourceKey = typeof ManagedTextResourceKey.Type;

/** Opaque content revisions are stable equality tokens, usually content hashes. */
export const ManagedTextResourceRevision = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MANAGED_TEXT_RESOURCE_REVISION_MAX_LENGTH),
).pipe(Schema.brand("ManagedTextResourceRevision"));
export type ManagedTextResourceRevision = typeof ManagedTextResourceRevision.Type;

/** Monotonic catalog revisions are used to protect mutations to a scope. */
export const ManagedTextResourceCatalogRevision = NonNegativeInt.pipe(
  Schema.brand("ManagedTextResourceCatalogRevision"),
);
export type ManagedTextResourceCatalogRevision = typeof ManagedTextResourceCatalogRevision.Type;

export const ManagedTextResourceKind = Schema.Literals(["command", "snippet"]);
export type ManagedTextResourceKind = typeof ManagedTextResourceKind.Type;

export const ManagedTextResourceName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MANAGED_TEXT_RESOURCE_NAME_MAX_LENGTH),
);
export type ManagedTextResourceName = typeof ManagedTextResourceName.Type;

export const ManagedTextResourceScope = Schema.Literals(["environment", "project"]);
export type ManagedTextResourceScope = typeof ManagedTextResourceScope.Type;

/** Project state is keyed by kind and key; `inherit` is represented by no stored entry. */
export const ManagedTextResourceProjectState = Schema.Literals([
  "inherit",
  "override",
  "disabled",
  "invalid",
  "orphan",
]);
export type ManagedTextResourceProjectState = typeof ManagedTextResourceProjectState.Type;

export const ManagedTextResourceKeyRef = Schema.Struct({
  kind: ManagedTextResourceKind,
  key: ManagedTextResourceKey,
});
export type ManagedTextResourceKeyRef = typeof ManagedTextResourceKeyRef.Type;

/** Body text is fetched on demand and never appears in catalog summaries. */
export const ManagedTextResourceBody = Schema.String.check(
  Schema.isMaxLength(MANAGED_TEXT_RESOURCE_BODY_MAX_LENGTH),
);
export type ManagedTextResourceBody = typeof ManagedTextResourceBody.Type;

export const ManagedTextResourceSummary = Schema.Struct({
  kind: ManagedTextResourceKind,
  /** Disabled project tombstones have no content ID but still carry their own revision. */
  id: Schema.optionalKey(ManagedTextResourceId),
  key: ManagedTextResourceKey,
  name: Schema.optionalKey(ManagedTextResourceName),
  scope: ManagedTextResourceScope,
  scopeId: TrimmedNonEmptyString,
  environmentState: Schema.optionalKey(Schema.Literals(["active", "disabled"])),
  projectState: ManagedTextResourceProjectState,
  revision: ManagedTextResourceRevision,
  effective: Schema.Boolean,
});
export type ManagedTextResourceSummary = typeof ManagedTextResourceSummary.Type;

const BoundedManagedTextResourceSummaries = Schema.Array(ManagedTextResourceSummary).check(
  Schema.isMaxLength(MANAGED_TEXT_RESOURCE_SUMMARY_LIMIT),
);

export const ManagedTextResourceThreadOverlay = Schema.Struct({
  threadId: ThreadId,
  kind: ManagedTextResourceKind,
  key: ManagedTextResourceKey,
  enabled: Schema.Boolean,
  revision: ManagedTextResourceRevision,
});
export type ManagedTextResourceThreadOverlay = typeof ManagedTextResourceThreadOverlay.Type;

const BoundedManagedTextResourceThreadOverlays = Schema.Array(
  ManagedTextResourceThreadOverlay,
).check(Schema.isMaxLength(MANAGED_TEXT_RESOURCE_SUMMARY_LIMIT));

export const ManagedTextResourceCatalogListInput = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
});
export type ManagedTextResourceCatalogListInput = typeof ManagedTextResourceCatalogListInput.Type;

export const ManagedTextResourceCatalogListResult = Schema.Struct({
  catalogRevision: ManagedTextResourceCatalogRevision,
  entries: BoundedManagedTextResourceSummaries,
  threadOverlays: Schema.optionalKey(BoundedManagedTextResourceThreadOverlays),
});
export type ManagedTextResourceCatalogListResult = typeof ManagedTextResourceCatalogListResult.Type;

export const ManagedTextResourceContentGetInput = Schema.Struct({
  kind: ManagedTextResourceKind,
  id: ManagedTextResourceId,
  expectedRevision: ManagedTextResourceRevision,
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
});
export type ManagedTextResourceContentGetInput = typeof ManagedTextResourceContentGetInput.Type;

export const ManagedTextResourceContentGetResult = Schema.Struct({
  kind: ManagedTextResourceKind,
  id: ManagedTextResourceId,
  key: ManagedTextResourceKey,
  name: Schema.optionalKey(ManagedTextResourceName),
  revision: ManagedTextResourceRevision,
  body: ManagedTextResourceBody,
});
export type ManagedTextResourceContentGetResult = typeof ManagedTextResourceContentGetResult.Type;

const MANAGED_TEXT_RESOURCE_CHANGED_SCOPES = ["environment", "project", "thread"] as const;
export const ManagedTextResourceChangedScope = Schema.Literals(
  MANAGED_TEXT_RESOURCE_CHANGED_SCOPES,
);
export type ManagedTextResourceChangedScope = typeof ManagedTextResourceChangedScope.Type;

const BoundedManagedTextResourceKeyRefs = Schema.Array(ManagedTextResourceKeyRef).check(
  Schema.isMaxLength(MANAGED_TEXT_RESOURCE_CHANGE_LIMIT),
);

export const ManagedTextResourceChanged = Schema.Struct({
  scope: ManagedTextResourceChangedScope,
  scopeId: TrimmedNonEmptyString,
  catalogRevision: ManagedTextResourceCatalogRevision,
  changedKeys: BoundedManagedTextResourceKeyRefs,
});
export type ManagedTextResourceChanged = typeof ManagedTextResourceChanged.Type;

const ManagedTextResourceExpectedCatalogRevisionFields = {
  expectedCatalogRevision: ManagedTextResourceCatalogRevision,
};

export const ManagedTextResourceEnvironmentCreateInput = Schema.Struct({
  environmentId: EnvironmentId,
  kind: ManagedTextResourceKind,
  ...ManagedTextResourceExpectedCatalogRevisionFields,
  key: ManagedTextResourceKey,
  name: Schema.optionalKey(ManagedTextResourceName),
  body: ManagedTextResourceBody,
});
export type ManagedTextResourceEnvironmentCreateInput =
  typeof ManagedTextResourceEnvironmentCreateInput.Type;

export const ManagedTextResourceEnvironmentUpdateInput = Schema.Struct({
  environmentId: EnvironmentId,
  kind: ManagedTextResourceKind,
  id: ManagedTextResourceId,
  expectedRevision: ManagedTextResourceRevision,
  name: Schema.optionalKey(ManagedTextResourceName),
  body: ManagedTextResourceBody,
});
export type ManagedTextResourceEnvironmentUpdateInput =
  typeof ManagedTextResourceEnvironmentUpdateInput.Type;

export const ManagedTextResourceEnvironmentDeleteInput = Schema.Struct({
  environmentId: EnvironmentId,
  kind: ManagedTextResourceKind,
  id: ManagedTextResourceId,
  expectedRevision: ManagedTextResourceRevision,
});
export type ManagedTextResourceEnvironmentDeleteInput =
  typeof ManagedTextResourceEnvironmentDeleteInput.Type;

export const ManagedTextResourceEnvironmentSetEnabledInput = Schema.Struct({
  environmentId: EnvironmentId,
  kind: ManagedTextResourceKind,
  id: ManagedTextResourceId,
  expectedRevision: ManagedTextResourceRevision,
  enabled: Schema.Boolean,
});
export type ManagedTextResourceEnvironmentSetEnabledInput =
  typeof ManagedTextResourceEnvironmentSetEnabledInput.Type;

export const ManagedTextResourceProjectSetOverrideInput = Schema.Struct({
  projectId: ProjectId,
  kind: ManagedTextResourceKind,
  ...ManagedTextResourceExpectedCatalogRevisionFields,
  key: ManagedTextResourceKey,
  name: Schema.optionalKey(ManagedTextResourceName),
  body: ManagedTextResourceBody,
});
export type ManagedTextResourceProjectSetOverrideInput =
  typeof ManagedTextResourceProjectSetOverrideInput.Type;

export const ManagedTextResourceProjectSetDisabledInput = Schema.Struct({
  projectId: ProjectId,
  kind: ManagedTextResourceKind,
  ...ManagedTextResourceExpectedCatalogRevisionFields,
  key: ManagedTextResourceKey,
});
export type ManagedTextResourceProjectSetDisabledInput =
  typeof ManagedTextResourceProjectSetDisabledInput.Type;

export const ManagedTextResourceProjectDeleteStateInput = Schema.Struct({
  projectId: ProjectId,
  kind: ManagedTextResourceKind,
  ...ManagedTextResourceExpectedCatalogRevisionFields,
  key: ManagedTextResourceKey,
});
export type ManagedTextResourceProjectDeleteStateInput =
  typeof ManagedTextResourceProjectDeleteStateInput.Type;

export const ManagedTextResourceThreadSetEnabledInput = Schema.Struct({
  threadId: ThreadId,
  kind: ManagedTextResourceKind,
  ...ManagedTextResourceExpectedCatalogRevisionFields,
  key: ManagedTextResourceKey,
  enabled: Schema.Boolean,
});
export type ManagedTextResourceThreadSetEnabledInput =
  typeof ManagedTextResourceThreadSetEnabledInput.Type;

export const ManagedTextResourceThreadResetInput = Schema.Struct({
  threadId: ThreadId,
  kind: ManagedTextResourceKind,
  ...ManagedTextResourceExpectedCatalogRevisionFields,
  key: ManagedTextResourceKey,
});
export type ManagedTextResourceThreadResetInput = typeof ManagedTextResourceThreadResetInput.Type;

export const ManagedTextResourceMutationAction = Schema.Literals([
  "create",
  "update",
  "delete",
  "set-override",
  "set-disabled",
  "delete-state",
  "set-enabled",
  "reset",
]);
export type ManagedTextResourceMutationAction = typeof ManagedTextResourceMutationAction.Type;

export const ManagedTextResourceMutationScope = Schema.Literals([
  "environment",
  "project",
  "thread",
]);
export type ManagedTextResourceMutationScope = typeof ManagedTextResourceMutationScope.Type;

/** Body-free details suitable for recording in a mutation audit trail. */
export const ManagedTextResourceMutationAudit = Schema.Struct({
  action: ManagedTextResourceMutationAction,
  scope: ManagedTextResourceMutationScope,
  scopeId: TrimmedNonEmptyString,
  kind: ManagedTextResourceKind,
  key: ManagedTextResourceKey,
  id: Schema.optionalKey(ManagedTextResourceId),
  revision: Schema.optionalKey(ManagedTextResourceRevision),
});
export type ManagedTextResourceMutationAudit = typeof ManagedTextResourceMutationAudit.Type;

export const ManagedTextResourceMutationResult = Schema.Struct({
  catalogRevision: ManagedTextResourceCatalogRevision,
  changedKeys: BoundedManagedTextResourceKeyRefs,
  /** Created/changed definitions and project tombstones; deleted entries are omitted. */
  summaries: BoundedManagedTextResourceSummaries,
  audit: ManagedTextResourceMutationAudit,
});
export type ManagedTextResourceMutationResult = typeof ManagedTextResourceMutationResult.Type;

export class ManagedTextResourceRpcError extends Schema.TaggedError<ManagedTextResourceRpcError>()(
  "ManagedTextResourceRpcError",
  {
    code: Schema.Literals([
      "revision-conflict",
      "not-found",
      "already-exists",
      "invalid-content",
      "invalid-override",
    ]),
    message: TrimmedNonEmptyString.check(
      Schema.isMaxLength(MANAGED_TEXT_RESOURCE_MESSAGE_MAX_LENGTH),
    ),
    expectedRevision: Schema.optionalKey(ManagedTextResourceRevision),
    actualRevision: Schema.optionalKey(ManagedTextResourceRevision),
    expectedCatalogRevision: Schema.optionalKey(ManagedTextResourceCatalogRevision),
    actualCatalogRevision: Schema.optionalKey(ManagedTextResourceCatalogRevision),
  },
) {}
