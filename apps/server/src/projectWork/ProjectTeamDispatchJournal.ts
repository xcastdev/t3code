import { ProjectTeamDispatchIntent, ProjectWorkWriteResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
export class ProjectTeamDispatchJournalError extends Schema.TaggedError<ProjectTeamDispatchJournalError>()(
  "ProjectTeamDispatchJournalError",
  {
    reason: Schema.Literals(["storage", "identity-conflict", "stale-fence"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
export const DispatchSnapshot = Schema.Struct({
  dispatchId: Schema.String,
  projectId: Schema.String,
  taskId: Schema.String,
  bindingId: Schema.String,
  threadId: Schema.String,
  generation: Schema.Number,
  fingerprint: Schema.String,
  assignment: Schema.String,
  request: ProjectTeamDispatchIntent,
  result: ProjectWorkWriteResult,
  stage: Schema.Literals(["reserved", "uncertain", "observed", "stopping", "settled"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type DispatchSnapshot = typeof DispatchSnapshot.Type;
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamDispatchIntent));
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectWorkWriteResult));
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(ProjectTeamDispatchIntent));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(ProjectWorkWriteResult));
interface Row {
  dispatch_id: string;
  project_id: string;
  task_id: string;
  binding_id: string;
  thread_id: string;
  generation: number;
  fingerprint: string;
  request_json: string;
  assignment: string;
  result_json: string;
  stage: DispatchSnapshot["stage"];
  created_at: string;
  updated_at: string;
}
export class ProjectTeamDispatchJournal extends Context.Service<
  ProjectTeamDispatchJournal,
  {
    readonly read: (
      dispatchId: string,
    ) => Effect.Effect<Option.Option<DispatchSnapshot>, ProjectTeamDispatchJournalError>;
    readonly retain: (
      snapshot: DispatchSnapshot,
    ) => Effect.Effect<void, ProjectTeamDispatchJournalError>;
    readonly advance: (
      snapshot: DispatchSnapshot,
      stage: DispatchSnapshot["stage"],
      at: string,
    ) => Effect.Effect<DispatchSnapshot, ProjectTeamDispatchJournalError>;
    readonly recoverable: (
      after?: string,
    ) => Effect.Effect<ReadonlyArray<string>, ProjectTeamDispatchJournalError>;
  }
>()("t3/projectWork/ProjectTeamDispatchJournal") {}
const isJournalError = Schema.is(ProjectTeamDispatchJournalError);
const allowedTransitions: Record<
  DispatchSnapshot["stage"],
  ReadonlyArray<DispatchSnapshot["stage"]>
> = {
  reserved: ["uncertain", "stopping"],
  uncertain: ["observed", "stopping"],
  observed: ["stopping"],
  stopping: ["settled"],
  settled: [],
};
const storage = (cause: unknown) =>
  new ProjectTeamDispatchJournalError({ reason: "storage", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const read = Effect.fn("ProjectTeamDispatchJournal.read")(function* (id: string) {
    const row =
      (yield* sql<Row>`SELECT * FROM t3_workflow_v2_team_dispatches WHERE dispatch_id=${id}`)[0];
    if (row === undefined) return Option.none<DispatchSnapshot>();
    return Option.some({
      dispatchId: row.dispatch_id,
      projectId: row.project_id,
      taskId: row.task_id,
      bindingId: row.binding_id,
      threadId: row.thread_id,
      generation: row.generation,
      fingerprint: row.fingerprint,
      assignment: row.assignment,
      request: yield* decodeRequest(row.request_json),
      result: yield* decodeResult(row.result_json),
      stage: row.stage,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }, Effect.mapError(storage));
  const retain = Effect.fn("ProjectTeamDispatchJournal.retain")(function* (s: DispatchSnapshot) {
    if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new ProjectTeamDispatchJournalError({ reason: "storage" });
    yield* sql`INSERT INTO t3_workflow_v2_team_dispatches VALUES(${s.dispatchId},${s.projectId},${s.taskId},${s.bindingId},${s.threadId},${s.generation},${s.fingerprint},${yield* encodeRequest(s.request)},${s.assignment},${yield* encodeResult(s.result)},${s.stage},${s.createdAt},${s.updatedAt})`;
  }, Effect.mapError(storage));
  const advance = Effect.fn("ProjectTeamDispatchJournal.advance")(
    function* (s: DispatchSnapshot, stage: DispatchSnapshot["stage"], at: string) {
      if (stage !== s.stage && !allowedTransitions[s.stage].includes(stage))
        return yield* new ProjectTeamDispatchJournalError({ reason: "stale-fence" });
      const rows =
        yield* sql`UPDATE t3_workflow_v2_team_dispatches SET stage=${stage},updated_at=${stage === s.stage ? s.updatedAt : at} WHERE dispatch_id=${s.dispatchId} AND binding_id=${s.bindingId} AND generation=${s.generation} AND fingerprint=${s.fingerprint} AND stage=${s.stage} RETURNING dispatch_id`;
      if (rows.length !== 1)
        return yield* new ProjectTeamDispatchJournalError({ reason: "stale-fence" });
      const current = yield* read(s.dispatchId);
      if (Option.isNone(current))
        return yield* new ProjectTeamDispatchJournalError({ reason: "stale-fence" });
      return current.value;
    },
    Effect.mapError((cause) => (isJournalError(cause) ? cause : storage(cause))),
  );
  const recoverable = Effect.fn("ProjectTeamDispatchJournal.recoverable")(function* (after = "") {
    return (yield* sql<{
      dispatch_id: string;
    }>`SELECT dispatch_id FROM t3_workflow_v2_team_dispatches WHERE stage IN ('reserved','uncertain') AND dispatch_id > ${after} ORDER BY dispatch_id LIMIT 128`).map(
      (row) => row.dispatch_id,
    );
  }, Effect.mapError(storage));
  return ProjectTeamDispatchJournal.of({ read, retain, advance, recoverable });
});
export const layer = Layer.effect(ProjectTeamDispatchJournal, make);
