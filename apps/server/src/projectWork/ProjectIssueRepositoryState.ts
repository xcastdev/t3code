import { assertOrdinaryAssistantDestination } from "../assistants/AssistantGuards.ts";
import { ProjectId, ProjectIssueRepositoryKey } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";

export class IssueBindingGatewayError extends Schema.TaggedError<IssueBindingGatewayError>()(
  "IssueBindingGatewayError",
  {
    reason: Schema.Literals([
      "human-required",
      "invalid-input",
      "inactive-project",
      "repository-mismatch",
      "account-mismatch",
      "stale-binding",
      "detached",
      "invalid-storage",
      "storage",
      "unavailable",
    ]),
  },
) {
  override get message() {
    return `Repository issue request could not be completed (${this.reason}).`;
  }
}

const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const IssueBindingState = Schema.Struct({
  projectId: ProjectId,
  ...ProjectIssueRepositoryKey.fields,
  revision: Counter,
  status: Schema.Literals(["active", "detached"]),
  workspaceRoot: Text,
  canonicalKey: Text,
  repositoryName: Text,
  account: Schema.Struct({
    host: Text,
    accountId: Text,
    viewer: Text,
    credentialFingerprint: Text,
  }),
  since: Text,
  highWater: Text,
  nextPage: Counter.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
  syncRevision: Counter,
  retryAt: Schema.NullOr(Schema.Finite),
});
export type IssueBindingState = typeof IssueBindingState.Type;
export interface IssueBindingKey {
  readonly projectId: ProjectId;
  readonly host: string;
  readonly repositoryNodeId: string;
}
const decodeState = Schema.decodeEffect(Schema.fromJsonString(IssueBindingState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(IssueBindingState));

export const readIssueBinding = Effect.fn("ProjectIssueRepositoryState.read")(function* (
  sql: SqlClient.SqlClient,
  key: IssueBindingKey,
) {
  const rows = yield* sql<{ payload: string; bytes: number }>`
    SELECT payload_json AS payload, length(CAST(payload_json AS BLOB)) AS bytes
    FROM t3_workflow_v2_issue_bindings WHERE project_id=${key.projectId}
    AND host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
  if (rows.length === 0) return undefined;
  const row = rows[0]!;
  if (row.bytes > 131_072)
    return yield* new IssueBindingGatewayError({ reason: "invalid-storage" });
  const state = yield* decodeState(row.payload).pipe(
    Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-storage" })),
  );
  if (
    state.projectId !== key.projectId ||
    state.host !== key.host ||
    state.repositoryNodeId !== key.repositoryNodeId
  )
    return yield* new IssueBindingGatewayError({ reason: "invalid-storage" });
  return state;
});

export const writeIssueBinding = Effect.fn("ProjectIssueRepositoryState.write")(function* (
  sql: SqlClient.SqlClient,
  state: IssueBindingState,
) {
  const payload = yield* encodeState(state).pipe(
    Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-storage" })),
  );
  yield* sql`INSERT INTO t3_workflow_v2_issue_bindings
    (project_id,host,repository_node_id,payload_json)
    VALUES (${state.projectId},${state.host},${state.repositoryNodeId},${payload})
    ON CONFLICT(project_id,host,repository_node_id) DO UPDATE SET payload_json=excluded.payload_json`;
});

export const makeIssueProjectGuard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStoreV2;
  const identities = yield* RepositoryIdentityResolver;
  const project = Effect.fn("ProjectIssueRepositoryState.project")(function* (
    projectId: ProjectId,
  ) {
    yield* assertOrdinaryAssistantDestination({ projectId }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(() => new IssueBindingGatewayError({ reason: "inactive-project" })),
    );
    const row = yield* projects
      .get(projectId)
      .pipe(Effect.mapError(() => new IssueBindingGatewayError({ reason: "storage" })));
    if (Option.isNone(row) || row.value.deletedAt !== null)
      return yield* new IssueBindingGatewayError({ reason: "inactive-project" });
    return row.value;
  });
  const identity = Effect.fn("ProjectIssueRepositoryState.identity")(function* (
    projectId: ProjectId,
  ) {
    const row = yield* project(projectId);
    const identity = yield* identities.resolve(row.workspaceRoot, { refresh: true });
    const match = identity?.canonicalKey.match(/^([^/]+)\/([^/]+\/[^/]+)$/u);
    if (
      identity === null ||
      identity.provider !== "github" ||
      match === undefined ||
      match === null
    )
      return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
    return {
      workspaceRoot: row.workspaceRoot,
      canonicalKey: identity.canonicalKey,
      host: match[1]!,
      repositoryName: identity.displayName ?? match[2]!,
    };
  });
  const assertBinding = Effect.fn("ProjectIssueRepositoryState.assertBinding")(function* (
    state: IssueBindingState,
  ) {
    const current = yield* identity(state.projectId);
    if (state.status !== "active")
      return yield* new IssueBindingGatewayError({ reason: "detached" });
    if (
      current.workspaceRoot !== state.workspaceRoot ||
      current.canonicalKey !== state.canonicalKey ||
      current.host !== state.host
    )
      return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
    return current;
  });
  return { project, identity, assertBinding };
});
