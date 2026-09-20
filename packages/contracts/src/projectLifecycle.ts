import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RepositoryIdentity } from "./environment.ts";

export const ProjectLifecycleState = Schema.Literals(["active", "archived", "tombstoned"]);
export type ProjectLifecycleState = typeof ProjectLifecycleState.Type;

export const ProjectLifecycleRecord = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  state: ProjectLifecycleState,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryKey: Schema.optionalKey(TrimmedNonEmptyString),
  revision: NonNegativeInt,
  changedAt: IsoDateTime,
});
export type ProjectLifecycleRecord = typeof ProjectLifecycleRecord.Type;

export const ProjectLifecycleGetInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectLifecycleGetInput = typeof ProjectLifecycleGetInput.Type;

export const ProjectLifecycleTombstone = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryKey: Schema.optionalKey(TrimmedNonEmptyString),
  tombstonedAt: IsoDateTime,
  reason: Schema.Literals(["permanent-local-delete", "legacy-project-delete"]),
  /** External repositories, remotes, and provider records are never deleted. */
  externalDataPreserved: Schema.Literal(true),
});
export type ProjectLifecycleTombstone = typeof ProjectLifecycleTombstone.Type;

export const ProjectLifecycleArchiveInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectLifecycleArchiveInput = typeof ProjectLifecycleArchiveInput.Type;

export const ProjectLifecycleRestoreInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  workspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectLifecycleRestoreInput = typeof ProjectLifecycleRestoreInput.Type;

export const ProjectLifecycleRelocationCheckInput = Schema.Struct({
  projectId: ProjectId,
  currentWorkspaceRoot: TrimmedNonEmptyString,
  candidateWorkspaceRoot: TrimmedNonEmptyString,
  expectedRepositoryKey: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectLifecycleRelocationCheckInput = typeof ProjectLifecycleRelocationCheckInput.Type;

export const ProjectLifecycleRelocationCheckResult = Schema.Struct({
  projectId: ProjectId,
  allowed: Schema.Boolean,
  reason: Schema.optionalKey(
    Schema.Literals([
      "unknown-project",
      "tombstoned",
      "stale-current-path",
      "same-path",
      "missing-path",
      "not-directory",
      "repository-identity-unavailable",
      "repository-mismatch",
    ]),
  ),
  candidateWorkspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optionalKey(RepositoryIdentity),
});
export type ProjectLifecycleRelocationCheckResult =
  typeof ProjectLifecycleRelocationCheckResult.Type;

export const ProjectLifecyclePermanentDeleteInput = Schema.Struct({
  commandId: CommandId,
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** UI must send the literal confirmation; there is no implicit destructive path. */
  confirmation: Schema.Literal("permanent-local-delete"),
});
export type ProjectLifecyclePermanentDeleteInput = typeof ProjectLifecyclePermanentDeleteInput.Type;

export const ProjectLifecycleMutationResult = Schema.Struct({
  project: ProjectLifecycleRecord,
  tombstone: Schema.optionalKey(ProjectLifecycleTombstone),
  /** This service only removes local project metadata; files and external data remain. */
  filesDeleted: Schema.Literal(false),
  externalDataPreserved: Schema.Literal(true),
});
export type ProjectLifecycleMutationResult = typeof ProjectLifecycleMutationResult.Type;
