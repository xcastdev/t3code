import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const Integer = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000));
const Id = Text.check(Schema.isMaxLength(256));
const Caption = Schema.String.check(Schema.isMaxLength(240));
const Metadata = {
  recordId: Id,
  revision: Integer,
  generation: Integer,
  status: Text,
  supported: Schema.Boolean,
};

// Malformed physical rows expose identity only; they cannot carry navigable assignments.
const Malformed = Schema.Struct({
  recordId: Id,
  revision: Integer,
  status: Text,
  supported: Schema.Literal(false),
  issue: Schema.Literal("malformed"),
});
const Profile = Schema.Union([
  Malformed,
  Schema.Struct({
    ...Metadata,
    roleId: Text,
    roleRevision: Integer,
    role: Text,
    model: Text,
  }),
]);
const Coordinator = Schema.Union([
  Malformed,
  Schema.Struct({
    ...Metadata,
    name: Caption,
    roleRevisionId: Id,
    profile: Schema.optionalKey(Profile),
  }),
]);
const Mission = Schema.Union([Malformed, Schema.Struct({ ...Metadata, title: Caption })]);
const Binding = Schema.Union([
  Malformed,
  Schema.Struct({
    ...Metadata,
    taskId: Id,
    attemptId: Id,
    memberId: Id,
    roleRevisionId: Id,
    providerInstanceId: Text,
    model: Text,
    workerThreadId: Schema.optionalKey(ThreadId.check(Schema.isMaxLength(256))),
    profile: Schema.optionalKey(Profile),
  }),
]);
const Blocker = Schema.Struct({
  recordId: Id,
  taskId: Id,
  revision: Integer,
  reason: Caption,
  resolver: Text,
});
const Question = Schema.Union([
  Malformed,
  Schema.Struct({
    ...Metadata,
    taskId: Id,
    senderId: Id,
    targetGateId: Id,
    targetRevision: Integer,
  }),
]);
const TaskCounts = Schema.Struct({
  draft: Integer,
  specified: Integer,
  ready: Integer,
  "in-progress": Integer,
  blocked: Integer,
  "in-review": Integer,
  completed: Integer,
  failed: Integer,
  canceled: Integer,
  unknown: Integer,
  total: Integer,
});

/** Bounded project metadata for portfolio/supervision views, without bodies or command authority. */
export const ProjectTeamSupervisionSummary = Schema.Union([
  Schema.Struct({
    projectId: ProjectId,
    availability: Schema.Literals(["missing", "deleted", "archived", "tombstoned", "unsupported"]),
  }),
  Schema.Struct({
    projectId: ProjectId,
    availability: Schema.Literal("available"),
    revision: Integer,
    lifecycleRevision: Schema.optionalKey(Integer),
    taskCounts: TaskCounts,
    coordinator: Schema.optionalKey(Coordinator),
    missions: Schema.Struct({
      items: Schema.Array(Mission).check(Schema.isMaxLength(5)),
      hasMore: Schema.Boolean,
    }),
    bindings: Schema.Struct({
      items: Schema.Array(Binding).check(Schema.isMaxLength(8)),
      hasMore: Schema.Boolean,
    }),
    blockers: Schema.Struct({
      items: Schema.Array(Blocker).check(Schema.isMaxLength(5)),
      hasMore: Schema.Boolean,
    }),
    questions: Schema.Struct({
      items: Schema.Array(Question).check(Schema.isMaxLength(5)),
      hasMore: Schema.Boolean,
    }),
  }),
]);
export type ProjectTeamSupervisionSummary = typeof ProjectTeamSupervisionSummary.Type;
