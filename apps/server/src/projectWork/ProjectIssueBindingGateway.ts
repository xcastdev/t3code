import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProjectIssueRepositoryBindInput,
  ProjectIssueRepositoryBindingsInput,
  ProjectIssueRepositoryBindingsRead,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { authIdentityForSession, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Human from "./ProjectIssueHumanBinding.ts";
import { readIssueRepositoryState } from "./ProjectIssueRepositoryState.ts";
import { ProjectIssueRuntime } from "./ProjectWorkRuntime.ts";

export class IssueBindingGatewayError extends Schema.TaggedError<IssueBindingGatewayError>()(
  "IssueBindingGatewayError",
  {
    reason: Schema.Literals([
      "human-required",
      "invalid-input",
      "inactive-project",
      "invalid-storage",
      "storage",
    ]),
  },
) {
  override get message() {
    return `Repository binding request could not be completed (${this.reason}).`;
  }
}
const fail = (reason: IssueBindingGatewayError["reason"]) =>
  new IssueBindingGatewayError({ reason });
const decodeBind = Schema.decodeUnknownEffect(ProjectIssueRepositoryBindInput, {
  onExcessProperty: "error",
});
const decodeList = Schema.decodeUnknownEffect(ProjectIssueRepositoryBindingsInput, {
  onExcessProperty: "error",
});
const decodeBindings = Schema.decodeUnknownEffect(ProjectIssueRepositoryBindingsRead);

/** The callback captures the same database as binding mutations and performs only durable reads. */
export const makeBindingSessionAuthorization = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessions.make;
  return Effect.fn("ProjectIssueBindingGateway.authorizeSession")(function* (
    session: AuthenticatedSession,
    requiredScope: AuthEnvironmentScope,
  ) {
    if (
      session.identity.kind !== "user" ||
      session.managed !== undefined ||
      !session.scopes.includes(requiredScope) ||
      Option.isNone(yield* Effect.serviceOption(sql.transactionService))
    )
      return yield* fail("human-required");
    const record = yield* sessions
      .getById({ sessionId: session.sessionId })
      .pipe(Effect.mapError(() => fail("human-required")));
    if (Option.isNone(record)) return yield* fail("human-required");
    const current = record.value;
    if (current.subject.startsWith("agent:")) return yield* fail("human-required");
    const identity = authIdentityForSession({
      subject: current.subject,
      client: { deviceType: current.client.deviceType },
    });
    const now = yield* Clock.currentTimeMillis;
    if (
      current.subject !== session.subject ||
      current.method !== session.method ||
      current.revokedAt !== null ||
      DateTime.toEpochMillis(current.expiresAt) <= now ||
      identity.kind !== "user" ||
      identity.id !== session.identity.id ||
      !current.scopes.includes(requiredScope)
    )
      return yield* fail("human-required");
  });
});

export class ProjectIssueBindingGateway extends Context.Service<
  ProjectIssueBindingGateway,
  {
    readonly bind: (
      input: typeof ProjectIssueRepositoryBindInput.Type,
      session: AuthenticatedSession,
    ) => Effect.Effect<
      Human.HumanRepositoryBindingReceipt,
      IssueBindingGatewayError | Human.IssueHumanBindingError
    >;
    readonly list: (
      input: typeof ProjectIssueRepositoryBindingsInput.Type,
      session: AuthenticatedSession,
    ) => Effect.Effect<typeof ProjectIssueRepositoryBindingsRead.Type, IssueBindingGatewayError>;
  }
>()("t3/projectWork/ProjectIssueBindingGateway") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runtime = yield* ProjectIssueRuntime;
  const authorize = yield* makeBindingSessionAuthorization;
  const bind: ProjectIssueBindingGateway["Service"]["bind"] = Effect.fn(
    "ProjectIssueBindingGateway.bind",
  )(
    function* (raw, session) {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* fail("invalid-input");
      const input = yield* decodeBind(raw).pipe(Effect.mapError(() => fail("invalid-input")));
      const authorization = authorize(session, AuthOrchestrationOperateScope);
      yield* sql.withTransaction(authorization);
      return yield* runtime.bindRepository(
        input,
        authorization.pipe(
          Effect.mapError(() => new Human.IssueHumanBindingError({ reason: "human-required" })),
        ),
      );
    },
    Effect.catchTag("SqlError", () => fail("storage")),
  );
  const list: ProjectIssueBindingGateway["Service"]["list"] = Effect.fn(
    "ProjectIssueBindingGateway.list",
  )(
    function* (raw, session) {
      const input = yield* decodeList(raw).pipe(Effect.mapError(() => fail("invalid-input")));
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* authorize(session, AuthOrchestrationReadScope);
          const projects = yield* sql`SELECT project.project_id FROM projection_projects AS project
          LEFT JOIN project_lifecycle AS lifecycle ON lifecycle.project_id=project.project_id
          WHERE project.project_id=${input.projectId} AND project.deleted_at IS NULL
            AND (lifecycle.state IS NULL OR lifecycle.state!='tombstoned')`;
          if (projects.length !== 1) return yield* fail("inactive-project");
          const rows = yield* sql<{
            host: string;
            repositoryNodeId: string;
            bindingRevision: number;
            status: string;
            accountNodeId: string;
            bytes: number | null;
          }>`SELECT binding.host, binding.repository_node_id AS repositoryNodeId,
          binding.revision AS bindingRevision, binding.status, binding.account_node_id AS accountNodeId,
          length(CAST(repository.payload_json AS BLOB)) AS bytes
          FROM project_issue_binding AS binding
          LEFT JOIN project_issue_repository AS repository ON repository.host=binding.host
            AND repository.repository_node_id=binding.repository_node_id
          WHERE binding.project_id=${input.projectId} ORDER BY binding.host,binding.repository_node_id LIMIT 33`;
          if (rows.length > 32) return yield* fail("invalid-storage");
          const items = yield* Effect.forEach(rows, (row) =>
            Effect.gen(function* () {
              if (row.bytes === null || row.bytes > 262144) return yield* fail("invalid-storage");
              const state = yield* readIssueRepositoryState(sql, row).pipe(
                Effect.mapError(() => fail("invalid-storage")),
              );
              if (state === undefined || state.accountNodeId !== row.accountNodeId)
                return yield* fail("invalid-storage");
              return {
                host: row.host,
                repositoryNodeId: row.repositoryNodeId,
                bindingRevision: row.bindingRevision,
                status: row.status,
                repositoryName: state.repositoryName,
                ...(state.accountLogin === undefined ? {} : { accountLogin: state.accountLogin }),
              };
            }),
          );
          return yield* decodeBindings({ items }).pipe(
            Effect.mapError(() => fail("invalid-storage")),
          );
        }),
      );
    },
    Effect.catchTag("SqlError", () => fail("storage")),
  );
  return ProjectIssueBindingGateway.of({ bind, list });
});
export const layer = Layer.effect(ProjectIssueBindingGateway, make);
