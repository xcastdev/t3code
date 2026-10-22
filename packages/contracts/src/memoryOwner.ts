import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const AssistantId = TrimmedNonEmptyString.pipe(Schema.brand("AssistantId"));
export type AssistantId = typeof AssistantId.Type;

export const MemoryOwner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("assistant"), assistantId: AssistantId }),
]);
export type MemoryOwner = typeof MemoryOwner.Type;

export function memoryOwnerEquals(left: MemoryOwner, right: MemoryOwner): boolean {
  return left.kind === "project"
    ? right.kind === "project" && left.projectId === right.projectId
    : right.kind === "assistant" && left.assistantId === right.assistantId;
}

export const MemoryOwnerRevision = NonNegativeInt;
export type MemoryOwnerRevision = typeof MemoryOwnerRevision.Type;

export const MemorySourceReference = Schema.Struct({
  owner: MemoryOwner,
  sourceId: TrimmedNonEmptyString,
  sourceRevision: NonNegativeInt,
});
export type MemorySourceReference = typeof MemorySourceReference.Type;

export const MemoryGrantId = TrimmedNonEmptyString.pipe(Schema.brand("MemoryGrantId"));
export type MemoryGrantId = typeof MemoryGrantId.Type;

const MemoryGrantAuthority = {
  environmentId: EnvironmentId,
  source: MemorySourceReference,
  recipient: MemoryOwner,
  ownerRevision: MemoryOwnerRevision,
  recipientRevision: MemoryOwnerRevision,
};

export const MemoryGrant = Schema.Struct({
  ...MemoryGrantAuthority,
  id: MemoryGrantId,
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type MemoryGrant = typeof MemoryGrant.Type;

export const MemoryGrantInput = Schema.Struct(MemoryGrantAuthority);
export type MemoryGrantInput = typeof MemoryGrantInput.Type;

export const MemoryGrantRevokeInput = Schema.Struct({
  ...MemoryGrantAuthority,
  grantId: MemoryGrantId,
});
export type MemoryGrantRevokeInput = typeof MemoryGrantRevokeInput.Type;

export const MemoryGrantListInput = Schema.Struct({
  environmentId: EnvironmentId,
  owner: MemoryOwner,
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
});
export type MemoryGrantListInput = typeof MemoryGrantListInput.Type;

export const MemoryGrantListResult = Schema.Struct({
  grants: Schema.Array(MemoryGrant).check(Schema.isMaxLength(100)),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))),
});
export type MemoryGrantListResult = typeof MemoryGrantListResult.Type;
