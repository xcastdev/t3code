import { ProjectIssueRepositoryCursor } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ensureIssueRepositoryTables,
  IssueRepositoryStateError,
  readIssueRepositoryState,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";

const decodeCursor = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectIssueRepositoryCursor),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeKey = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const invalid = () => new IssueRepositoryStateError({ reason: "invalid-input" });
const seconds = (value: string) => {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed)
    ? Effect.succeed(DateTime.formatIso(parsed.value).replace(/\.\d{3}Z$/u, "Z"))
    : Effect.fail(invalid());
};

/** Preserve old progress without treating an old account, cursor or ETag as verified read authority. */
export const importLegacyIssueRepositories = Effect.fn("importLegacyIssueRepositories")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* ensureIssueRepositoryTables(sql);
  yield* sql`CREATE TABLE IF NOT EXISTS project_issue_repository_legacy (
    record_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, host TEXT NOT NULL,
    repository_node_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    import_status TEXT NOT NULL CHECK(import_status IN ('imported','retained','unsupported'))
  )`;
  let after = "";
  while (true) {
    const rows = yield* sql<{
      recordId: string;
      projectId: string;
      status: string;
      revision: number;
      generation: number;
      uniqueKey: string;
      payload: string;
    }>`SELECT record_id AS recordId,project_id AS projectId,status,revision,generation,
      unique_key AS uniqueKey,payload_json AS payload FROM project_team_intake_cursor
      WHERE record_id > ${after} ORDER BY record_id LIMIT 128`;
    for (const row of rows) {
      const cursor = yield* decodeCursor(row.payload).pipe(Effect.mapError(invalid));
      const selectedKey = yield* decodeKey(row.uniqueKey).pipe(Effect.mapError(invalid));
      if (
        cursor.recordId !== row.recordId ||
        cursor.projectId !== row.projectId ||
        cursor.status !== row.status ||
        cursor.revision !== row.revision ||
        cursor.generation !== row.generation ||
        cursor.host !== selectedKey[0] ||
        cursor.repositoryNodeId !== selectedKey[1]
      )
        return yield* invalid();
      const key = { host: cursor.host, repositoryNodeId: cursor.repositoryNodeId };
      const prior = yield* readIssueRepositoryState(sql, key);
      let importStatus = "retained";
      if (prior === undefined) {
        const state = {
          ...key,
          repositoryName: "",
          accountNodeId: cursor.accountId,
          credentialEpoch: "",
          revision: cursor.revision,
          authorityGeneration: cursor.generation,
          status: cursor.status === "detached" ? "detached" : "unavailable",
          since: yield* seconds(cursor.overlapSince),
          pageSize: 25,
          sweepStartedAt: null,
          nextPage: 1,
          lastSuccessfulPageAt:
            cursor.lastSuccessfulPageAt === undefined
              ? null
              : yield* seconds(cursor.lastSuccessfulPageAt),
          retryAt: 0,
          error: null,
          legacyCursor: null,
          lease: null,
        } satisfies IssueRepositoryState;
        const payload = yield* encodeJson(state);
        yield* sql`INSERT INTO project_issue_repository(host,repository_node_id,payload_json)
          VALUES(${key.host},${key.repositoryNodeId},${payload})`;
        // Valid older metadata outside the new domain stays inspectable without read authority.
        const valid = yield* readIssueRepositoryState(sql, key).pipe(
          Effect.catchTag("IssueRepositoryStateError", () => Effect.succeed(undefined)),
        );
        importStatus = valid === undefined ? "unsupported" : "imported";
        if (valid === undefined) {
          yield* sql`DELETE FROM project_issue_repository WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
        }
        const live = yield* sql`SELECT p.project_id FROM projection_projects p
          LEFT JOIN project_lifecycle l ON l.project_id=p.project_id
          WHERE p.project_id=${cursor.projectId} AND p.deleted_at IS NULL
            AND (l.state IS NULL OR l.state!='tombstoned')`;
        if (valid !== undefined && live.length === 1) {
          yield* sql`INSERT INTO project_issue_binding(project_id,host,repository_node_id,account_node_id,status,revision,generation)
            VALUES(${cursor.projectId},${cursor.host},${cursor.repositoryNodeId},${cursor.accountId},
              ${cursor.status === "detached" ? "detached" : "active"},${cursor.revision},${cursor.generation})`;
        }
      }
      yield* sql`INSERT INTO project_issue_repository_legacy(record_id,project_id,host,repository_node_id,payload_json,import_status)
        VALUES(${cursor.recordId},${cursor.projectId},${cursor.host},${cursor.repositoryNodeId},${row.payload},${importStatus})
        ON CONFLICT(record_id) DO NOTHING`;
      after = row.recordId;
    }
    if (rows.length < 128) break;
  }
});
