import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectWorkTaskId } from "./projectWorkCore.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
export const ProjectIssueIdentity = Schema.Struct({
  host: Text,
  repositoryNodeId: Text,
  issueNodeId: Text,
  number: NonNegativeInt.check(Schema.isGreaterThan(0)),
});
export type ProjectIssueIdentity = typeof ProjectIssueIdentity.Type;
export const ProjectIssueIntake = Schema.Struct({
  kind: Schema.Literal("issue"),
  recordId: Text.check(Schema.isMaxLength(256)),
  projectId: ProjectId,
  revision: NonNegativeInt,
  generation: NonNegativeInt,
  updatedAt: IsoDateTime,
  status: Schema.Literals(["open", "closed", "detached"]),
  identity: ProjectIssueIdentity,
  repositoryName: Text,
  title: Text,
  body: Schema.String.check(Schema.isMaxLength(32_000)),
  sourceRevision: Text,
  observedAt: IsoDateTime,
  taskId: Schema.optionalKey(ProjectWorkTaskId),
  missionId: Schema.optionalKey(Text),
});
export type ProjectIssueIntake = typeof ProjectIssueIntake.Type;
export const ProjectIssueIntakeRead = Schema.Struct({ ...ProjectIssueIntake.fields, status: Text });
export const ProjectIssueRepositoryCursor = Schema.Struct({
  kind: Schema.Literal("intake-cursor"),
  recordId: Text.check(Schema.isMaxLength(256)),
  projectId: ProjectId,
  revision: NonNegativeInt,
  generation: NonNegativeInt,
  updatedAt: IsoDateTime,
  status: Schema.Literals(["ready", "syncing", "unavailable", "detached"]),
  host: Text,
  repositoryNodeId: Text,
  accountId: Text,
  cursor: Schema.optionalKey(Text),
  etag: Schema.optionalKey(Text),
  overlapSince: IsoDateTime,
  lastSuccessfulPageAt: Schema.optionalKey(IsoDateTime),
  error: Schema.optionalKey(Text),
});
export type ProjectIssueRepositoryCursor = typeof ProjectIssueRepositoryCursor.Type;
export const ProjectIssueRepositoryCursorRead = Schema.Struct({
  ...ProjectIssueRepositoryCursor.fields,
  status: Text,
});
