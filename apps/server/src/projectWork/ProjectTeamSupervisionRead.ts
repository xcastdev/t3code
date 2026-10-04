import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../persistence/Errors.ts";

const operation = "readProjectTeamSupervision";
const Integer = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000));
const Id = Text.check(Schema.isMaxLength(256));
const Caption = Schema.String.check(Schema.isMaxLength(240));
const base = {
  recordId: Id,
  projectId: Text,
  revision: Integer,
  generation: Integer,
  status: Text,
};
const Metadata = Schema.Union([
  Schema.Struct({ ...base, kind: Schema.Literal("mission"), title: Caption }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("member"),
    name: Caption,
    coordinator: Schema.Literals([0, 1]),
    roleRevisionId: Id,
  }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("role-revision"),
    roleId: Text,
    roleRevision: Integer,
    role: Text,
    model: Text,
  }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("run-binding"),
    taskId: Id,
    attemptId: Id,
    memberId: Id,
    roleRevisionId: Id,
    providerInstanceId: Text,
    threadId: Text,
    model: Text,
  }),
  Schema.Struct({
    ...base,
    kind: Schema.Literal("question"),
    taskId: Id,
    senderId: Id,
    targetGateId: Id,
    targetRevision: Integer,
  }),
]);
const decodeMetadata = Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata));
const PhysicalRow = Schema.Struct({
  ...base,
  taskId: Schema.NullOr(Text),
  attemptId: Schema.NullOr(Text),
  memberId: Schema.NullOr(Text),
  providerInstanceId: Schema.NullOr(Text),
  threadId: Schema.NullOr(Text),
  metadataJson: Schema.NullOr(Schema.String),
});
const decodePhysicalRows = Schema.decodeUnknownEffect(Schema.Array(PhysicalRow));
type PhysicalRow = typeof PhysicalRow.Type;
type Metadata = typeof Metadata.Type;
const statuses = {
  mission: ["draft", "active", "paused", "completed", "canceled"],
  member: ["active", "paused", "retired"],
  "role-revision": ["available", "retired"],
  "run-binding": ["reserved", "running", "stopping", "settled", "revoked", "quarantined"],
  question: ["pending", "answered", "canceled"],
};
const roles = new Set([
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
]);
const marker = (row: PhysicalRow) => ({
  recordId: row.recordId,
  revision: row.revision,
  status: row.status,
  supported: false as const,
  issue: "malformed" as const,
});
const common = (value: Metadata) => ({
  recordId: value.recordId,
  revision: value.revision,
  generation: value.generation,
  status: value.status,
  supported: statuses[value.kind].includes(value.status),
});

/** Extract only bounded scalar metadata inside SQLite. Body/configuration fields never leave SQL. */
const readRows = Effect.fn("ProjectTeamSupervision.readRows")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  kind: Metadata["kind"],
  limit: number,
  recordId?: string,
) {
  const scalar = (key: string, max = 4_000) => sql`CASE
    WHEN json_type(payload_json, ${"$." + key}) = 'text'
      AND length(json_extract(payload_json, ${"$." + key})) BETWEEN 1 AND ${max}
    THEN json_extract(payload_json, ${"$." + key}) END`;
  const integer = (key: string) => sql`CASE WHEN json_type(payload_json, ${"$." + key}) = 'integer'
    THEN json_extract(payload_json, ${"$." + key}) END`;
  const caption = (key: string) => sql`CASE WHEN json_type(payload_json, ${"$." + key}) = 'text'
    THEN substr(json_extract(payload_json, ${"$." + key}), 1, 240) END`;
  const fields = [
    sql`'recordId', ${scalar("recordId", 256)}, 'projectId', ${scalar("projectId")},
    'revision', ${integer("revision")}, 'generation', ${integer("generation")},
    'status', ${scalar("status")}, 'kind', ${scalar("kind")}`,
  ];
  switch (kind) {
    case "mission":
      fields.push(sql`'title', ${caption("title")}`);
      break;
    case "member":
      fields.push(sql`'name', ${caption("name")}, 'coordinator', CASE
      WHEN json_type(payload_json, '$.coordinator') IN ('true','false')
      THEN json_extract(payload_json, '$.coordinator') END, 'roleRevisionId', ${scalar("roleRevisionId", 256)}`);
      break;
    case "role-revision":
      fields.push(sql`'roleId', ${scalar("roleId")},
      'roleRevision', ${integer("roleRevision")}, 'role', ${scalar("role")}, 'model', ${scalar("model")}`);
      break;
    case "run-binding":
      fields.push(sql`'taskId', ${scalar("taskId", 256)}, 'attemptId', ${scalar("attemptId", 256)},
      'memberId', ${scalar("memberId", 256)}, 'roleRevisionId', ${scalar("roleRevisionId", 256)},
      'providerInstanceId', ${scalar("providerInstanceId")}, 'threadId', ${scalar("threadId")}, 'model', ${scalar("model")}`);
      break;
    case "question":
      fields.push(sql`'taskId', ${scalar("taskId", 256)}, 'senderId', ${scalar("senderId", 256)},
      'targetGateId', ${scalar("targetGateId", 256)}, 'targetRevision', ${integer("targetRevision")}`);
      break;
  }
  const filter =
    recordId !== undefined
      ? sql`AND record_id = ${recordId}`
      : kind === "member"
        ? sql`AND unique_key = 'coordinator' AND status <> 'retired'`
        : kind === "run-binding"
          ? sql`AND status <> 'settled'`
          : kind === "question"
            ? sql`AND status NOT IN ('answered', 'canceled')`
            : sql``;
  // Recorded status priority protects unresolved work from old revoked rows; IDs break ties, not time.
  const ordering =
    kind === "run-binding"
      ? sql`CASE status WHEN 'running' THEN 0 WHEN 'stopping' THEN 1
    WHEN 'quarantined' THEN 2 WHEN 'reserved' THEN 3 WHEN 'revoked' THEN 4 ELSE 5 END, record_id`
      : kind === "question"
        ? sql`CASE status WHEN 'pending' THEN 0 ELSE 1 END, record_id`
        : sql`record_id`;
  const rows =
    yield* sql`SELECT record_id AS recordId, project_id AS projectId, revision, generation, status,
    task_id AS taskId, attempt_id AS attemptId, member_id AS memberId,
    provider_instance_id AS providerInstanceId, thread_id AS threadId,
    CASE WHEN json_valid(payload_json) THEN json_object(${sql.join(", ", false)(fields)}) END AS metadataJson
    FROM ${sql("project_team_" + kind.replaceAll("-", "_"))}
    WHERE project_id = ${projectId} ${filter} ORDER BY ${ordering} LIMIT ${limit}`;
  return yield* decodePhysicalRows(rows).pipe(Effect.mapError(toPersistenceDecodeError(operation)));
});

const parse = Effect.fn("ProjectTeamSupervision.parse")(function* (
  row: PhysicalRow,
  kind: Metadata["kind"],
  revision: number,
) {
  if (row.metadataJson === null || row.revision > revision) return undefined;
  const parsed = yield* decodeMetadata(row.metadataJson).pipe(Effect.result);
  if (parsed._tag === "Failure") return undefined;
  const value = parsed.success;
  if (
    value.kind !== kind ||
    value.recordId !== row.recordId ||
    value.projectId !== row.projectId ||
    value.revision !== row.revision ||
    value.generation !== row.generation ||
    value.status !== row.status
  )
    return undefined;
  if (
    value.kind === "run-binding" &&
    (value.taskId !== row.taskId ||
      value.attemptId !== row.attemptId ||
      value.memberId !== row.memberId ||
      value.threadId !== row.threadId ||
      value.providerInstanceId !== row.providerInstanceId)
  )
    return undefined;
  if (value.kind === "question" && value.taskId !== row.taskId) return undefined;
  return value;
});
const page = <A>(items: ReadonlyArray<A>, hasMore: boolean) => ({ items, hasMore });
const Fence = Schema.Struct({ revision: Integer, valid: Schema.Literal(1) });
const decodeFence = Schema.decodeUnknownEffect(Fence);
const Availability = Schema.Struct({
  deletedAt: Schema.NullOr(Schema.String),
  lifecycleState: Schema.NullOr(Schema.String),
  lifecycleRevision: Schema.NullOr(Integer),
});
const decodeAvailability = Schema.decodeUnknownEffect(Availability);
const Counts = Schema.Struct({
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
const decodeCounts = Schema.decodeUnknownEffect(Counts);
const Blocker = Schema.Struct({
  recordId: Id,
  taskId: Id,
  revision: Integer,
  reason: Caption,
  resolver: Text,
});
const decodeBlockers = Schema.decodeUnknownEffect(Schema.Array(Blocker));

/** A single project snapshot for supervision. Recorded metadata grants no execution or command authority. */
export const readProjectTeamSupervision = Effect.fn(operation)(function* (
  sql: SqlClient.SqlClient,
  input: { readonly projectId: string },
) {
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const projectId = input.projectId;
        const projects = yield* sql`SELECT project.deleted_at AS deletedAt,
      lifecycle.state AS lifecycleState, lifecycle.revision AS lifecycleRevision
      FROM projection_projects project LEFT JOIN project_lifecycle lifecycle ON lifecycle.project_id = project.project_id
      WHERE project.project_id = ${projectId} LIMIT 1`;
        if (projects.length === 0) {
          const lifecycle = yield* sql<{
            state: string;
          }>`SELECT state FROM project_lifecycle WHERE project_id = ${projectId} LIMIT 1`;
          return {
            projectId,
            availability:
              lifecycle[0]?.state === "tombstoned" ? ("tombstoned" as const) : ("missing" as const),
          };
        }
        const availability = yield* decodeAvailability(projects[0]).pipe(
          Effect.mapError(toPersistenceDecodeError(operation)),
        );
        if (availability.lifecycleState === "tombstoned")
          return { projectId, availability: "tombstoned" as const };
        if (availability.deletedAt !== null) return { projectId, availability: "deleted" as const };
        if (availability.lifecycleState === "archived")
          return { projectId, availability: "archived" as const };
        if (availability.lifecycleState !== null && availability.lifecycleState !== "active")
          return { projectId, availability: "unsupported" as const };
        const fences = yield* sql`SELECT
      COALESCE(MAX(CAST(json_extract(payload_json, '$.revision') AS INTEGER)), 0) AS revision,
      COALESCE(MIN(CASE WHEN json_type(payload_json, '$.revision') = 'integer'
        AND json_extract(payload_json, '$.revision') BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}
        AND json_extract(payload_json, '$.projectId') = ${projectId} THEN 1 ELSE 0 END), 1) AS valid
      FROM project_work_events WHERE project_id = ${projectId}`;
        const { revision } = yield* decodeFence(fences[0]).pipe(
          Effect.mapError(toPersistenceDecodeError(operation)),
        );
        const countRows = yield* sql`SELECT COUNT(*) AS total,
      COALESCE(MIN(CASE WHEN typeof(revision) = 'integer' AND revision BETWEEN 0 AND ${revision}
        THEN 1 ELSE 0 END),1) AS valid,
      COUNT(CASE WHEN state = 'draft' THEN 1 END) AS draft,
      COUNT(CASE WHEN state = 'specified' THEN 1 END) AS specified,
      COUNT(CASE WHEN state = 'ready' THEN 1 END) AS ready,
      COUNT(CASE WHEN state = 'in-progress' THEN 1 END) AS ${sql("in-progress")},
      COUNT(CASE WHEN state = 'blocked' THEN 1 END) AS blocked,
      COUNT(CASE WHEN state = 'in-review' THEN 1 END) AS ${sql("in-review")},
      COUNT(CASE WHEN state = 'completed' THEN 1 END) AS completed,
      COUNT(CASE WHEN state = 'failed' THEN 1 END) AS failed,
      COUNT(CASE WHEN state = 'canceled' THEN 1 END) AS canceled,
      COUNT(CASE WHEN state NOT IN ('draft','specified','ready','in-progress','blocked','in-review','completed','failed','canceled') THEN 1 END) AS unknown
      FROM project_work_tasks WHERE project_id = ${projectId}`;
        yield* decodeFence({ revision, valid: countRows[0]?.valid }).pipe(
          Effect.mapError(toPersistenceDecodeError(operation)),
        );
        const taskCounts = yield* decodeCounts(countRows[0]).pipe(
          Effect.mapError(toPersistenceDecodeError(operation)),
        );
        const role = Effect.fn("ProjectTeamSupervision.role")(function* (recordId: string) {
          const rows = yield* readRows(sql, projectId, "role-revision", 1, recordId);
          const row = rows[0];
          if (row === undefined) return undefined;
          const value = yield* parse(row, "role-revision", revision);
          if (value?.kind !== "role-revision") return marker(row);
          return {
            ...common(value),
            roleId: value.roleId,
            roleRevision: value.roleRevision,
            role: value.role,
            model: value.model,
            supported: common(value).supported && roles.has(value.role),
          };
        });
        const coordinatorRows = yield* readRows(sql, projectId, "member", 2);
        const coordinatorRow = coordinatorRows[0];
        const coordinatorValue =
          coordinatorRow === undefined
            ? undefined
            : yield* parse(coordinatorRow, "member", revision);
        const coordinator =
          coordinatorRow === undefined
            ? undefined
            : coordinatorRows.length !== 1 ||
                coordinatorValue?.kind !== "member" ||
                coordinatorValue.coordinator !== 1
              ? marker(coordinatorRow)
              : {
                  ...common(coordinatorValue),
                  name: coordinatorValue.name,
                  roleRevisionId: coordinatorValue.roleRevisionId,
                  profile: yield* role(coordinatorValue.roleRevisionId),
                };
        const missionRows = yield* readRows(sql, projectId, "mission", 6);
        const missions = yield* Effect.forEach(
          missionRows.slice(0, 5),
          Effect.fn(function* (row) {
            const value = yield* parse(row, "mission", revision);
            return value?.kind === "mission"
              ? { ...common(value), title: value.title }
              : marker(row);
          }),
        );
        const bindingRows = yield* readRows(sql, projectId, "run-binding", 9);
        const bindings = yield* Effect.forEach(
          bindingRows.slice(0, 8),
          Effect.fn(function* (row) {
            const value = yield* parse(row, "run-binding", revision);
            if (value?.kind !== "run-binding") return marker(row);
            const owners =
              yield* sql`SELECT 1 FROM project_work_tasks task JOIN project_work_attempts attempt
        ON attempt.project_id = task.project_id AND attempt.task_id = task.task_id
        WHERE task.project_id = ${projectId} AND task.task_id = ${value.taskId} AND attempt.attempt_id = ${value.attemptId} LIMIT 1`;
            const members = yield* readRows(sql, projectId, "member", 1, value.memberId);
            const memberRow = members[0];
            const member =
              memberRow === undefined ? undefined : yield* parse(memberRow, "member", revision);
            if (owners.length === 0 || member?.kind !== "member") return marker(row);
            const threads = yield* sql`SELECT 1 FROM projection_threads
        WHERE project_id = ${projectId} AND thread_id = ${value.threadId} AND deleted_at IS NULL LIMIT 1`;
            return {
              ...common(value),
              taskId: value.taskId,
              attemptId: value.attemptId,
              memberId: value.memberId,
              roleRevisionId: value.roleRevisionId,
              providerInstanceId: value.providerInstanceId,
              model: value.model,
              ...(threads.length === 0 ? {} : { workerThreadId: value.threadId }),
              profile: yield* role(value.roleRevisionId),
            };
          }),
        );
        const blockerRows =
          yield* sql`SELECT blocker.blocker_id AS recordId, blocker.task_id AS taskId,
      blocker.revision, substr(blocker.reason, 1, 240) AS reason, blocker.resolver
      FROM project_work_blockers blocker JOIN project_work_tasks task
        ON task.task_id = blocker.task_id AND task.project_id = blocker.project_id
      WHERE blocker.project_id = ${projectId} AND blocker.resolved_at IS NULL
      ORDER BY blocker.blocker_id LIMIT 6`;
        const blockers = yield* decodeBlockers(blockerRows.slice(0, 5)).pipe(
          Effect.mapError(toPersistenceDecodeError(operation)),
        );
        yield* decodeFence({
          revision,
          valid: blockers.every((blocker) => blocker.revision <= revision) ? 1 : 0,
        }).pipe(Effect.mapError(toPersistenceDecodeError(operation)));
        const questionRows = yield* readRows(sql, projectId, "question", 6);
        const questions = yield* Effect.forEach(
          questionRows.slice(0, 5),
          Effect.fn(function* (row) {
            const value = yield* parse(row, "question", revision);
            if (value?.kind !== "question") return marker(row);
            const owners =
              yield* sql`SELECT 1 FROM project_work_tasks task JOIN project_team_gate gate
        ON gate.project_id = task.project_id AND gate.task_id = task.task_id
        WHERE task.project_id = ${projectId} AND task.task_id = ${value.taskId} AND gate.record_id = ${value.targetGateId} LIMIT 1`;
            return owners.length === 0
              ? marker(row)
              : {
                  ...common(value),
                  taskId: value.taskId,
                  senderId: value.senderId,
                  targetGateId: value.targetGateId,
                  targetRevision: value.targetRevision,
                };
          }),
        );
        return {
          projectId,
          availability: "available" as const,
          revision,
          ...(availability.lifecycleRevision === null
            ? {}
            : { lifecycleRevision: availability.lifecycleRevision }),
          taskCounts,
          ...(coordinator === undefined ? {} : { coordinator }),
          missions: page(missions, missionRows.length > 5),
          bindings: page(bindings, bindingRows.length > 8),
          blockers: page(blockers, blockerRows.length > 5),
          questions: page(questions, questionRows.length > 5),
        };
      }),
    )
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "SqlError" ? toPersistenceSqlError(operation)(cause) : cause,
      ),
    );
});
export type ProjectTeamSupervisionSummary = Effect.Success<
  ReturnType<typeof readProjectTeamSupervision>
>;
