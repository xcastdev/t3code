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

const BindingText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
);
const BindingCounter = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const BindingLogin = Schema.String.check(
  Schema.isMaxLength(39),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u),
);
export const ProjectIssueRepositoryKey = Schema.Struct({
  host: BindingText.check(
    Schema.isMaxLength(253),
    Schema.isPattern(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    ),
  ),
  repositoryNodeId: BindingText,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export const ProjectIssueRepositoryBindInput = Schema.Struct({
  projectId: ProjectId,
  expectedRepositoryKey: ProjectIssueRepositoryKey,
  expectedTargetBindingRevision: Schema.NullOr(BindingCounter),
  accountLogin: BindingLogin,
  previous: Schema.optionalKey(
    Schema.Struct({
      key: ProjectIssueRepositoryKey,
      expectedBindingRevision: BindingCounter,
    }).annotate({
      parseOptions: { onExcessProperty: "error" },
    }),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ProjectIssueRepositoryBindInput = typeof ProjectIssueRepositoryBindInput.Type;
export const ProjectIssueRepositoryBindReceipt = Schema.Struct({
  ...ProjectIssueRepositoryKey.fields,
  bindingRevision: BindingCounter,
  status: Schema.Literal("ready"),
});
export const ProjectIssueRepositoryBindingsInput = Schema.Struct({ projectId: ProjectId }).annotate(
  {
    parseOptions: { onExcessProperty: "error" },
  },
);
export type ProjectIssueRepositoryBindingsInput = typeof ProjectIssueRepositoryBindingsInput.Type;
export const ProjectIssueRepositoryBindingRead = Schema.Struct({
  ...ProjectIssueRepositoryKey.fields,
  bindingRevision: BindingCounter,
  status: Schema.Literals(["active", "detached"]),
  repositoryName: Schema.String.check(Schema.isMaxLength(1024)),
  accountLogin: Schema.optionalKey(BindingLogin),
});
export const ProjectIssueRepositoryBindingsRead = Schema.Struct({
  items: Schema.Array(ProjectIssueRepositoryBindingRead).check(Schema.isMaxLength(32)),
});
export type ProjectIssueRepositoryBindingsRead = typeof ProjectIssueRepositoryBindingsRead.Type;
