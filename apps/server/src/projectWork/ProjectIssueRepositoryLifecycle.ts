import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  IssueRepositoryStateError,
  readIssueRepositoryState,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const increment = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER
    ? Effect.succeed(value + 1)
    : Effect.fail(new IssueRepositoryStateError({ reason: "counter-exhausted" }));

/** Join the lifecycle transaction: retirement must roll back with its tombstone and receipt. */
export const retireProjectIssueRepositories = Effect.fn("retireProjectIssueRepositories")(
  function* (sql: SqlClient.SqlClient, projectId: string, remove: boolean) {
    if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new IssueRepositoryStateError({ reason: "invalid-input" });
    let after: { host: string; repositoryNodeId: string } | undefined;
    while (true) {
      const rows = yield* sql<{
        host: string;
        repositoryNodeId: string;
        status: string;
        revision: number;
        generation: number;
      }>`SELECT host,repository_node_id AS repositoryNodeId,status,revision,generation
        FROM project_issue_binding WHERE project_id=${projectId}
        ${after === undefined ? sql`` : sql`AND (host,repository_node_id)>(${after.host},${after.repositoryNodeId})`}
        ORDER BY host,repository_node_id LIMIT 128`;
      for (const row of rows) {
        const state = yield* readIssueRepositoryState(sql, row);
        if (state === undefined)
          return yield* new IssueRepositoryStateError({ reason: "invalid-input" });
        if (remove) {
          yield* sql`DELETE FROM project_issue_binding WHERE project_id=${projectId}
            AND host=${row.host} AND repository_node_id=${row.repositoryNodeId}`;
        } else if (row.status === "active") {
          const revision = yield* increment(row.revision);
          const generation = yield* increment(row.generation);
          yield* sql`UPDATE project_issue_binding SET status='detached',revision=${revision},generation=${generation}
            WHERE project_id=${projectId} AND host=${row.host} AND repository_node_id=${row.repositoryNodeId}`;
        } else {
          after = row;
          continue;
        }
        const owners = yield* sql<{ status: string }>`SELECT b.status FROM project_issue_binding b
          JOIN projection_projects p ON p.project_id=b.project_id
          LEFT JOIN project_lifecycle l ON l.project_id=b.project_id
          WHERE b.host=${row.host} AND b.repository_node_id=${row.repositoryNodeId}
          AND p.deleted_at IS NULL AND (l.state IS NULL OR l.state!='tombstoned') LIMIT 1`;
        if (remove && owners.length === 0) {
          // No surviving explicit owner: remove derived data before its foreign-key parent.
          for (const table of [
            "project_issue_page",
            "project_issue_external",
            "project_issue_binding",
          ])
            yield* sql`DELETE FROM ${sql(table)} WHERE host=${row.host} AND repository_node_id=${row.repositoryNodeId}`;
          yield* sql`DELETE FROM project_issue_repository WHERE host=${row.host} AND repository_node_id=${row.repositoryNodeId}`;
        } else {
          const active = yield* sql`SELECT b.project_id FROM project_issue_binding b
            JOIN projection_projects p ON p.project_id=b.project_id
            LEFT JOIN project_lifecycle l ON l.project_id=b.project_id
            WHERE b.host=${row.host} AND b.repository_node_id=${row.repositoryNodeId}
            AND b.status='active' AND p.deleted_at IS NULL AND (l.state IS NULL OR l.state='active') LIMIT 1`;
          const next: IssueRepositoryState = {
            ...state,
            status: active.length === 0 ? "detached" : state.status,
            revision: yield* increment(state.revision),
            authorityGeneration: yield* increment(state.authorityGeneration),
            lease: null,
          };
          yield* sql`UPDATE project_issue_repository SET payload_json=${yield* encodeJson(next)}
            WHERE host=${row.host} AND repository_node_id=${row.repositoryNodeId}`;
        }
        after = row;
      }
      if (rows.length < 128) break;
    }
    if (remove) {
      // Imported inactive projects have raw history but no binding. Retire only
      // repositories without a surviving explicit owner; history grants no ownership.
      let legacyAfter: string | undefined;
      while (true) {
        const legacy = yield* sql<{ recordId: string; host: string; repositoryNodeId: string }>`
          SELECT record_id AS recordId,host,repository_node_id AS repositoryNodeId
          FROM project_issue_repository_legacy WHERE project_id=${projectId}
          ${legacyAfter === undefined ? sql`` : sql`AND record_id>${legacyAfter}`}
          ORDER BY record_id LIMIT 128`;
        for (const row of legacy) {
          const state = yield* readIssueRepositoryState(sql, row);
          if (state !== undefined) {
            const owners = yield* sql`SELECT b.project_id FROM project_issue_binding b
              JOIN projection_projects p ON p.project_id=b.project_id
              LEFT JOIN project_lifecycle l ON l.project_id=b.project_id
              WHERE b.host=${row.host} AND b.repository_node_id=${row.repositoryNodeId}
                AND p.deleted_at IS NULL AND (l.state IS NULL OR l.state!='tombstoned') LIMIT 1`;
            if (owners.length === 0) {
              for (const table of [
                "project_issue_page",
                "project_issue_external",
                "project_issue_binding",
              ])
                yield* sql`DELETE FROM ${sql(table)} WHERE host=${row.host} AND repository_node_id=${row.repositoryNodeId}`;
              yield* sql`DELETE FROM project_issue_repository WHERE host=${row.host} AND repository_node_id=${row.repositoryNodeId}`;
            }
          }
          legacyAfter = row.recordId;
        }
        if (legacy.length < 128) break;
      }
      yield* sql`DELETE FROM project_issue_repository_legacy WHERE project_id=${projectId}`;
    }
  },
);
