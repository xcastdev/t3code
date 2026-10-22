import { ProjectTerminalSummary, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const ProjectTerminalOwnership = Schema.Struct({
  projectId: Schema.String,
  rootId: Schema.String,
  bindingId: Schema.String,
  generation: Schema.Number,
  fence: Schema.Number,
  expiresAt: Schema.NullOr(Schema.String),
  threadId: Schema.String,
  runId: Schema.String,
  runAttemptId: Schema.String,
  providerThreadId: Schema.String,
  providerSessionId: Schema.String,
});
export type ProjectTerminalOwnership = typeof ProjectTerminalOwnership.Type;
export const ProjectTerminalCompletionAuthority = Schema.Struct({
  runId: Schema.String,
  nativeTarget: Schema.Struct({
    runAttemptId: Schema.String,
    providerThreadId: Schema.String,
    providerSessionId: Schema.String,
  }),
  owner: Schema.optional(ProjectTerminalOwnership),
});
export type ProjectTerminalCompletionAuthority = typeof ProjectTerminalCompletionAuthority.Type;
export const encodeCompletionAuthority = Schema.encodeEffect(
  Schema.fromJsonString(ProjectTerminalCompletionAuthority),
);
export const decodeCompletionAuthority = Schema.decodeEffect(
  Schema.fromJsonString(ProjectTerminalCompletionAuthority),
);
export const projectTerminalOwnerMatches = (
  target: ProjectTerminalOwnership | undefined,
  actor: ProjectTerminalOwnership,
) =>
  target?.projectId === actor.projectId &&
  target.rootId === actor.rootId &&
  target.bindingId === actor.bindingId &&
  target.generation === actor.generation &&
  target.fence === actor.fence &&
  target.expiresAt === actor.expiresAt;
export const ProjectTerminalRecord = Schema.Struct({
  terminal: ProjectTerminalSummary,
  ownership: Schema.optional(ProjectTerminalOwnership),
  cols: Schema.Number,
  rows: Schema.Number,
  history: Schema.String,
  offset: Schema.Number,
  sequence: Schema.Number,
});
export type ProjectTerminalRecord = typeof ProjectTerminalRecord.Type;
export class ProjectTerminalPersistenceError extends Schema.TaggedError<ProjectTerminalPersistenceError>()(
  "ProjectTerminalPersistenceError",
  { cause: Schema.Defect() },
) {}
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(ProjectTerminalRecord));
const decodeExit = Schema.decodeEffect(Schema.fromJsonString(ProjectTerminalSummary));
const encodeExit = Schema.encodeEffect(Schema.fromJsonString(ProjectTerminalSummary));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(ProjectTerminalRecord));
export interface ProjectTerminalPersistence {
  readonly assertProjectActive?: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectTerminalPersistenceError>;
  readonly loadExits?: Effect.Effect<
    ReadonlyArray<typeof ProjectTerminalSummary.Type>,
    ProjectTerminalPersistenceError
  >;
  readonly saveExit?: (
    terminal: typeof ProjectTerminalSummary.Type,
  ) => Effect.Effect<void, ProjectTerminalPersistenceError>;
  readonly remove?: (handle: {
    projectId: ProjectId;
    terminalId: string;
    generation: string;
  }) => Effect.Effect<void, ProjectTerminalPersistenceError>;
  readonly load: Effect.Effect<
    ReadonlyArray<ProjectTerminalRecord>,
    ProjectTerminalPersistenceError
  >;
  readonly save: (
    record: ProjectTerminalRecord,
  ) => Effect.Effect<void, ProjectTerminalPersistenceError>;
}

export const makeSqlPersistence = Effect.fn("ProjectTerminalStore.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    assertProjectActive: Effect.fn("ProjectTerminalStore.assertProjectActive")(
      function* (projectId: ProjectId) {
        const rows =
          yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${projectId} AND deleted_at IS NULL`;
        if (rows.length !== 1)
          return yield* new ProjectTerminalPersistenceError({ cause: "Project unavailable" });
      },
      Effect.mapError((cause) => new ProjectTerminalPersistenceError({ cause })),
    ),
    load: sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_project_terminals`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRecord(row.payload_json))),
      Effect.mapError((cause) => new ProjectTerminalPersistenceError({ cause })),
    ),
    loadExits: sql<{
      terminal_json: string;
    }>`SELECT terminal_json FROM t3_workflow_v2_terminal_exits`.pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeExit(row.terminal_json))),
      Effect.mapError((cause) => new ProjectTerminalPersistenceError({ cause })),
    ),
    saveExit: Effect.fn("ProjectTerminalStore.saveExit")(
      function* (terminal: typeof ProjectTerminalSummary.Type) {
        const payload = yield* encodeExit(terminal);
        yield* sql`INSERT INTO t3_workflow_v2_terminal_exits(project_id,terminal_id,generation,terminal_json) VALUES(${terminal.projectId},${terminal.terminalId},${terminal.generation},${payload}) ON CONFLICT(project_id,terminal_id,generation) DO NOTHING`;
      },
      Effect.mapError((cause) => new ProjectTerminalPersistenceError({ cause })),
    ),
    remove: Effect.fn("ProjectTerminalStore.remove")(
      function* (handle: { projectId: ProjectId; terminalId: string; generation: string }) {
        yield* sql`DELETE FROM t3_workflow_v2_project_terminals WHERE project_id=${handle.projectId} AND terminal_id=${handle.terminalId} AND generation=${handle.generation}`;
      },
      Effect.mapError((cause) => new ProjectTerminalPersistenceError({ cause })),
    ),
    save: Effect.fn("ProjectTerminalStore.save")(
      function* (record: ProjectTerminalRecord) {
        const terminal = record.terminal;
        const payload = yield* encodeRecord(record);
        yield* sql`INSERT INTO t3_workflow_v2_project_terminals (project_id, terminal_id, generation, payload_json)
        VALUES (${terminal.projectId}, ${terminal.terminalId}, ${terminal.generation}, ${payload})
        ON CONFLICT(project_id, terminal_id) DO UPDATE SET generation=excluded.generation, payload_json=excluded.payload_json`;
      },
      Effect.mapError((cause) => new ProjectTerminalPersistenceError({ cause })),
    ),
  } satisfies ProjectTerminalPersistence;
});

export const completionIdentity = (input: {
  readonly projectId: ProjectId;
  readonly terminalId: string;
  readonly generation: string;
  readonly recipientThreadId: string;
}) =>
  JSON.stringify([input.projectId, input.terminalId, input.generation, input.recipientThreadId]);
