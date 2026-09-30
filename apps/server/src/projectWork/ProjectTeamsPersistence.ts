import {
  ProjectTeamRecord,
  ProjectTeamRecordRead,
  type ProjectTeamRecord as TeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeTeamRecordJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamRecord));
const decodeTeamRecordReadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamRecordRead),
);

export const PROJECT_WORK_CHECKPOINT_VERSION = 2;
const projectionKinds = [
  "mission",
  "task-membership",
  "role-revision",
  "member",
  "plan-revision",
  "gate",
  "run-binding",
  "message",
  "question",
  "evidence-applicability",
  "repair-episode",
  "limits",
  "issue",
  "memory-source",
  "memory-extraction",
  "memory-observation",
] as const;
const authorityKinds = ["reservation", "effect", "intake-cursor"] as const;
const table = (kind: TeamRecord["kind"]) => "project_team_" + kind.replaceAll("-", "_");
const allKinds = [...projectionKinds, ...authorityKinds];
const json = (value: unknown) => JSON.stringify(value);

/** Production migration and pre-migration focused fixtures share exactly one definition. */
export const ensureProjectTeamsTables = Effect.fn("ensureProjectTeamsTables")(function* (
  sql: SqlClient.SqlClient,
) {
  for (const kind of allKinds) {
    yield* sql`CREATE TABLE IF NOT EXISTS ${sql(table(kind))} (
      record_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
      revision INTEGER NOT NULL, generation INTEGER NOT NULL, updated_at TEXT NOT NULL,
      task_id TEXT, attempt_id TEXT, member_id TEXT, source_id TEXT,
      scope_key TEXT, slot INTEGER, unique_key TEXT, provider_instance_id TEXT, thread_id TEXT, session_id TEXT, payload_json TEXT NOT NULL
    )`;
    yield* sql`CREATE INDEX IF NOT EXISTS ${sql(table(kind) + "_page")} ON ${sql(table(kind))}(project_id, record_id)`;
    yield* sql`CREATE INDEX IF NOT EXISTS ${sql(table(kind) + "_status")} ON ${sql(table(kind))}(project_id, status, record_id)`;
  }
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_one_coordinator ON project_team_member(project_id) WHERE unique_key = 'coordinator' AND status IN ('active', 'paused')`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_one_binding ON project_team_run_binding(attempt_id) WHERE status IN ('reserved', 'running', 'stopping', 'quarantined')`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_source_observation ON project_team_memory_observation(project_id, unique_key)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_message_command ON project_team_message(project_id, unique_key)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_external_effect ON project_team_effect(unique_key)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_repository_cursor ON project_team_intake_cursor(unique_key)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_stable_issue ON project_team_issue(project_id, unique_key)`;
  yield* sql`CREATE INDEX IF NOT EXISTS project_team_binding_session ON project_team_run_binding(provider_instance_id, thread_id, session_id, status)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS project_team_capacity ON project_team_reservation(scope_key, slot) WHERE status = 'held'`;
});
const uniqueKey = (r: TeamRecord): string | null => {
  switch (r.kind) {
    case "member":
      return r.coordinator ? "coordinator" : null;
    case "message":
      return r.commandId;
    case "effect":
      return r.effectId;
    case "intake-cursor":
      return json([r.host, r.repositoryNodeId]);
    case "issue":
      return json([r.identity.host, r.identity.repositoryNodeId, r.identity.issueNodeId]);
    case "memory-observation":
      return json([r.sourceId, r.sourceRevision, r.sourceGeneration, r.observationKey]);
    default:
      return null;
  }
};
const writeRecord = Effect.fn("ProjectTeams.writeRecord")(function* (
  sql: SqlClient.SqlClient,
  r: TeamRecord,
) {
  const scopeKey =
    r.kind === "reservation"
      ? json([
          r.environmentId,
          r.scope,
          r.scope === "environment"
            ? "model-call"
            : r.scope === "project"
              ? r.projectId
              : r.resourceKey,
        ])
      : null;
  yield* sql`INSERT INTO ${sql(table(r.kind))} (record_id, project_id, status, revision, generation, updated_at, task_id, attempt_id, member_id, source_id, scope_key, slot, unique_key, provider_instance_id, thread_id, session_id, payload_json)
    VALUES (${r.recordId}, ${r.projectId}, ${r.status}, ${r.revision}, ${r.generation}, ${r.updatedAt}, ${"taskId" in r ? (r.taskId ?? null) : null}, ${"attemptId" in r ? r.attemptId : null}, ${"memberId" in r ? r.memberId : null}, ${"sourceId" in r ? (r.sourceId ?? null) : null}, ${scopeKey}, ${r.kind === "reservation" ? r.slot : null}, ${uniqueKey(r)}, ${r.kind === "run-binding" ? r.providerInstanceId : null}, ${r.kind === "run-binding" ? r.threadId : null}, ${r.kind === "run-binding" ? (r.sessionId ?? null) : null}, ${json(r)})
    ON CONFLICT(record_id) DO UPDATE SET status = excluded.status, revision = excluded.revision, generation = excluded.generation, updated_at = excluded.updated_at, task_id = excluded.task_id, attempt_id = excluded.attempt_id, member_id = excluded.member_id, source_id = excluded.source_id, scope_key = excluded.scope_key, slot = excluded.slot, unique_key = excluded.unique_key, provider_instance_id = excluded.provider_instance_id, thread_id = excluded.thread_id, session_id = excluded.session_id, payload_json = excluded.payload_json
    WHERE project_id = excluded.project_id`;
});

/** Rebuilding derived rows cannot allocate capacity or enqueue/retry external work. */
export const persistProjectTeamProjections = Effect.fn("persistProjectTeamProjections")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
  records: ReadonlyArray<TeamRecord>,
  previous?: ReadonlyArray<TeamRecord>,
) {
  for (const kind of projectionKinds) {
    if (previous === undefined)
      yield* sql`DELETE FROM ${sql(table(kind))} WHERE project_id = ${projectId}`;
    for (const r of records.filter((entry) => entry.kind === kind)) {
      const prior = previous?.find(
        (entry) => entry.kind === r.kind && entry.recordId === r.recordId,
      );
      if (prior !== undefined && json(prior) === json(r)) continue;
      yield* writeRecord(sql, r);
    }
  }
});

/** Called only inside the command transaction after decision, never from replay. */
export const commitProjectTeamAuthority = Effect.fn("commitProjectTeamAuthority")(function* (
  sql: SqlClient.SqlClient,
  records: ReadonlyArray<TeamRecord>,
) {
  for (const r of records) {
    const owners = allKinds.map(
      (kind) =>
        sql`SELECT project_id AS projectId, ${kind} AS kind FROM ${sql(table(kind))} WHERE record_id = ${r.recordId}`,
    );
    const owner = yield* sql<{
      projectId: string;
      kind: string;
    }>`SELECT * FROM (${sql.join(" UNION ALL ")(owners)}) LIMIT 1`;
    if (owner[0] !== undefined && (owner[0].projectId !== r.projectId || owner[0].kind !== r.kind))
      return yield* Effect.fail(
        new ProjectWorkPolicyError("invalid-state", "Foundation record belongs to another project"),
      );
    if ((authorityKinds as ReadonlyArray<string>).includes(r.kind)) yield* writeRecord(sql, r);
  }
});

export const readProjectTeamRecords = Effect.fn("readProjectTeamRecords")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
) {
  const records: Array<TeamRecord> = [];
  for (const kind of allKinds) {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM ${sql(table(kind))} WHERE project_id = ${projectId} ORDER BY record_id`;
    for (const row of rows) records.push(yield* decodeTeamRecordJson(row.payload));
  }
  return records;
});

export const readProjectTeamPage = Effect.fn("readProjectTeamPage")(function* (
  sql: SqlClient.SqlClient,
  input: { projectId: string; cursor?: string; limit?: number; kinds?: ReadonlyArray<string> },
) {
  const limit = Math.min(
    128,
    Math.max(1, Number.isFinite(input.limit) ? Math.floor(input.limit!) : 50),
  );
  const selected = allKinds.filter(
    (kind) => input.kinds === undefined || input.kinds.includes(kind),
  );
  if (selected.length === 0) return { items: [] };
  const selects = selected.map(
    (kind) =>
      sql`SELECT ${kind} || ':' || record_id AS page_key, payload_json FROM ${sql(table(kind))} WHERE project_id = ${input.projectId}`,
  );
  const rows = yield* sql<{
    pageKey: string;
    payload: string;
  }>`SELECT page_key AS pageKey, payload_json AS payload FROM (${sql.join(" UNION ALL ")(selects)}) WHERE page_key > ${input.cursor ?? ""} ORDER BY page_key LIMIT ${limit + 1}`;
  const items = yield* Effect.forEach(rows.slice(0, limit), (row) =>
    decodeTeamRecordReadJson(row.payload),
  );
  return { items, ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.pageKey } : {}) };
});
