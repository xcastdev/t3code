import {
  ProjectIssueRepositoryIdentityRead,
  type ProjectIssueRepositoryIdentityInput,
  ProjectIssueRepositoryBindInput,
  ProjectIssueRepositoryBindingsInput,
  type ProjectIssueRepositoryBindingsRead,
  type ProjectIssueRepositoryBindReceipt,
} from "@t3tools/contracts";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  IssueBindingGatewayError,
  makeIssueProjectGuard,
  readIssueBinding,
  writeIssueBinding,
  type IssueBindingKey,
} from "./ProjectIssueRepositoryState.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { issueIntakeHash } from "./ProjectIssueIntakeService.ts";

export { IssueBindingGatewayError } from "./ProjectIssueRepositoryState.ts";

/** Trusted transport callback rechecks the durable human session at commit. */
export type IssueHumanAuthorization = Effect.Effect<void, IssueBindingGatewayError>;

export class ProjectIssueBindingGateway extends Context.Service<
  ProjectIssueBindingGateway,
  {
    readonly identity: (
      input: ProjectIssueRepositoryIdentityInput,
      authorize: IssueHumanAuthorization,
    ) => Effect.Effect<ProjectIssueRepositoryIdentityRead, IssueBindingGatewayError>;
    readonly bind: (
      input: ProjectIssueRepositoryBindInput,
      authorize: IssueHumanAuthorization,
    ) => Effect.Effect<typeof ProjectIssueRepositoryBindReceipt.Type, IssueBindingGatewayError>;
    readonly list: (
      input: ProjectIssueRepositoryBindingsInput,
      authorize: IssueHumanAuthorization,
    ) => Effect.Effect<ProjectIssueRepositoryBindingsRead, IssueBindingGatewayError>;
    readonly detach: (
      input: IssueBindingKey & { readonly bindingRevision: number },
      authorize: IssueHumanAuthorization,
    ) => Effect.Effect<void, IssueBindingGatewayError>;
    readonly assertRefinable: (
      input: { readonly projectId: IssueBindingKey["projectId"]; readonly issueRecordId: string },
      authorize: IssueHumanAuthorization,
    ) => Effect.Effect<void, IssueBindingGatewayError>;
  }
>()("t3/projectWork/ProjectIssueBindingGateway") {}

const decodeIdentityRead = Schema.decodeUnknownEffect(ProjectIssueRepositoryIdentityRead);
const decodeBind = Schema.decodeUnknownEffect(ProjectIssueRepositoryBindInput);
const decodeList = Schema.decodeUnknownEffect(ProjectIssueRepositoryBindingsInput);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* GitHubIssueApi.GitHubIssueApi;
  const guard = yield* makeIssueProjectGuard;
  const assertOwnTransaction = Effect.fn("ProjectIssueBindingGateway.assertOwnTransaction")(
    function* () {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* new IssueBindingGatewayError({ reason: "invalid-input" });
    },
  );
  const identity = Effect.fn("ProjectIssueBindingGateway.identity")(
    function* (raw: ProjectIssueRepositoryIdentityInput, authorize: IssueHumanAuthorization) {
      yield* assertOwnTransaction();
      const input = yield* decodeList(raw).pipe(
        Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-input" })),
      );
      yield* sql.withTransaction(authorize);
      const current = yield* guard.identity(input.projectId);
      const account = yield* api
        .getAccount({ cwd: current.workspaceRoot, host: current.host })
        .pipe(Effect.mapError(() => new IssueBindingGatewayError({ reason: "unavailable" })));
      if (account.host !== current.host)
        return yield* new IssueBindingGatewayError({ reason: "account-mismatch" });
      const remote = yield* api
        .lookupRepository({
          cwd: current.workspaceRoot,
          account,
          repository: current.repositoryName,
        })
        .pipe(
          Effect.mapError(() => new IssueBindingGatewayError({ reason: "repository-mismatch" })),
        );
      if (
        remote.status !== "changed" ||
        remote.data.host !== current.host ||
        `${remote.data.host}/${remote.data.nameWithOwner}`.toLowerCase() !==
          current.canonicalKey.toLowerCase()
      )
        return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
      const refreshedAccount = yield* api
        .getAccount({ cwd: current.workspaceRoot, host: current.host })
        .pipe(Effect.mapError(() => new IssueBindingGatewayError({ reason: "unavailable" })));
      if (
        refreshedAccount.host !== account.host ||
        refreshedAccount.accountId !== account.accountId ||
        refreshedAccount.viewer !== account.viewer ||
        refreshedAccount.credentialFingerprint !== account.credentialFingerprint
      )
        return yield* new IssueBindingGatewayError({ reason: "account-mismatch" });
      const refreshed = yield* guard.identity(input.projectId);
      if (
        refreshed.workspaceRoot !== current.workspaceRoot ||
        refreshed.canonicalKey !== current.canonicalKey
      )
        return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* authorize;
          const project = yield* guard.project(input.projectId);
          if (project.workspaceRoot !== current.workspaceRoot)
            return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
          return yield* decodeIdentityRead({
            host: remote.data.host,
            repositoryNodeId: remote.data.nodeId,
            repositoryName: remote.data.nameWithOwner,
            accountLogin: account.viewer,
          }).pipe(
            Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-storage" })),
          );
        }),
      );
    },
    Effect.catchTags({
      SqlError: () => Effect.fail(new IssueBindingGatewayError({ reason: "storage" })),
    }),
  );

  const bind = Effect.fn("ProjectIssueBindingGateway.bind")(
    function* (raw: ProjectIssueRepositoryBindInput, authorize: IssueHumanAuthorization) {
      yield* assertOwnTransaction();
      const input = yield* decodeBind(raw).pipe(
        Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-input" })),
      );
      yield* sql.withTransaction(authorize);
      const identity = yield* guard.identity(input.projectId);
      if (input.expectedRepositoryKey.host !== identity.host)
        return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
      const account = yield* api
        .getAccount({ cwd: identity.workspaceRoot, host: identity.host })
        .pipe(Effect.mapError(() => new IssueBindingGatewayError({ reason: "unavailable" })));
      if (account.viewer.toLowerCase() !== input.accountLogin.toLowerCase())
        return yield* new IssueBindingGatewayError({ reason: "account-mismatch" });
      const remote = yield* api
        .lookupRepository({
          cwd: identity.workspaceRoot,
          account,
          repository: identity.repositoryName,
          expectedRepositoryNodeId: input.expectedRepositoryKey.repositoryNodeId,
        })
        .pipe(
          Effect.mapError(() => new IssueBindingGatewayError({ reason: "repository-mismatch" })),
        );
      if (
        remote.status !== "changed" ||
        remote.data.host !== identity.host ||
        remote.data.nodeId !== input.expectedRepositoryKey.repositoryNodeId ||
        `${remote.data.host}/${remote.data.nameWithOwner}`.toLowerCase() !==
          identity.canonicalKey.toLowerCase()
      )
        return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
      const refreshed = yield* guard.identity(input.projectId);
      if (
        refreshed.workspaceRoot !== identity.workspaceRoot ||
        refreshed.canonicalKey !== identity.canonicalKey
      )
        return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* authorize;
          const project = yield* guard.project(input.projectId);
          if (project.workspaceRoot !== identity.workspaceRoot)
            return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
          const key = { projectId: input.projectId, ...input.expectedRepositoryKey };
          const existing = yield* readIssueBinding(sql, key);
          const same =
            existing?.status === "active" &&
            existing.workspaceRoot === identity.workspaceRoot &&
            existing.canonicalKey === identity.canonicalKey &&
            existing.account.host === account.host &&
            existing.account.accountId === account.accountId &&
            existing.account.viewer === account.viewer &&
            existing.account.credentialFingerprint === account.credentialFingerprint;
          const initialRetry =
            input.expectedTargetBindingRevision === null &&
            existing?.revision === 0 &&
            same &&
            input.previous === undefined;
          if (!initialRetry && (existing?.revision ?? null) !== input.expectedTargetBindingRevision)
            return yield* new IssueBindingGatewayError({ reason: "stale-binding" });
          if (input.previous !== undefined) {
            if (
              input.previous.key.host === key.host &&
              input.previous.key.repositoryNodeId === key.repositoryNodeId
            )
              return yield* new IssueBindingGatewayError({ reason: "invalid-input" });
            const previous = yield* readIssueBinding(sql, {
              projectId: input.projectId,
              ...input.previous.key,
            });
            if (
              previous === undefined ||
              previous.revision !== input.previous.expectedBindingRevision ||
              previous.status !== "active"
            )
              return yield* new IssueBindingGatewayError({ reason: "stale-binding" });
            yield* writeIssueBinding(sql, {
              ...previous,
              status: "detached",
              revision: previous.revision + 1,
            });
          }
          if (same)
            return {
              ...input.expectedRepositoryKey,
              bindingRevision: existing.revision,
              status: "ready" as const,
            };
          const bindingRevision = existing === undefined ? 0 : existing.revision + 1;
          const rows =
            yield* sql`SELECT host FROM t3_workflow_v2_issue_bindings WHERE project_id=${input.projectId} LIMIT 33`;
          if (existing === undefined && rows.length >= 32)
            return yield* new IssueBindingGatewayError({ reason: "invalid-input" });
          yield* writeIssueBinding(sql, {
            ...key,
            revision: bindingRevision,
            status: "active",
            ...identity,
            repositoryName: remote.data.nameWithOwner,
            account,
            since: "1970-01-01T00:00:00Z",
            highWater: "1970-01-01T00:00:00Z",
            nextPage: 1,
            syncRevision: 0,
            retryAt: null,
          });
          yield* sql`DELETE FROM t3_workflow_v2_issue_pages WHERE project_id=${key.projectId} AND host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
          return { ...input.expectedRepositoryKey, bindingRevision, status: "ready" as const };
        }),
      );
    },
    Effect.catchTags({
      SqlError: () => Effect.fail(new IssueBindingGatewayError({ reason: "storage" })),
    }),
  );

  const list = Effect.fn("ProjectIssueBindingGateway.list")(
    function* (raw: ProjectIssueRepositoryBindingsInput, authorize: IssueHumanAuthorization) {
      const input = yield* decodeList(raw).pipe(
        Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-input" })),
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* authorize;
          yield* guard.project(input.projectId);
          const rows = yield* sql<{
            host: string;
            repositoryNodeId: string;
          }>`SELECT host,repository_node_id AS repositoryNodeId FROM t3_workflow_v2_issue_bindings WHERE project_id=${input.projectId} ORDER BY host,repository_node_id LIMIT 33`;
          if (rows.length > 32)
            return yield* new IssueBindingGatewayError({ reason: "invalid-storage" });
          const items = yield* Effect.forEach(
            rows,
            Effect.fn("ProjectIssueBindingGateway.binding")(function* (row) {
              const state = yield* readIssueBinding(sql, { projectId: input.projectId, ...row });
              if (state === undefined)
                return yield* new IssueBindingGatewayError({ reason: "invalid-storage" });
              return {
                host: state.host,
                repositoryNodeId: state.repositoryNodeId,
                bindingRevision: state.revision,
                status: state.status,
                repositoryName: state.repositoryName,
                accountLogin: state.account.viewer,
              };
            }),
          );
          return { items };
        }),
      );
    },
    Effect.catchTags({
      SqlError: () => Effect.fail(new IssueBindingGatewayError({ reason: "storage" })),
    }),
  );

  const detach = Effect.fn("ProjectIssueBindingGateway.detach")(
    function* (
      input: IssueBindingKey & { readonly bindingRevision: number },
      authorize: IssueHumanAuthorization,
    ) {
      yield* assertOwnTransaction();
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* authorize;
          yield* guard.project(input.projectId);
          const state = yield* readIssueBinding(sql, input);
          if (state === undefined || state.revision !== input.bindingRevision)
            return yield* new IssueBindingGatewayError({ reason: "stale-binding" });
          if (state.status === "detached") return;
          yield* writeIssueBinding(sql, {
            ...state,
            revision: state.revision + 1,
            status: "detached",
          });
          yield* sql`DELETE FROM t3_workflow_v2_issue_pages WHERE project_id=${input.projectId} AND host=${input.host} AND repository_node_id=${input.repositoryNodeId}`;
        }),
      );
    },
    Effect.catchTags({
      SqlError: () => Effect.fail(new IssueBindingGatewayError({ reason: "storage" })),
    }),
  );
  const assertRefinable = Effect.fn("ProjectIssueBindingGateway.assertRefinable")(
    function* (
      input: { readonly projectId: IssueBindingKey["projectId"]; readonly issueRecordId: string },
      authorize: IssueHumanAuthorization,
    ) {
      yield* authorize;
      const project = yield* guard.project(input.projectId);
      const state = yield* readCurrentState(sql, input.projectId);
      const issue = state.foundationRecords?.find(
        (record) => record.kind === "issue" && record.recordId === input.issueRecordId,
      );
      if (issue?.kind !== "issue" || issue.status === "detached")
        return yield* new IssueBindingGatewayError({ reason: "detached" });
      const binding = yield* readIssueBinding(sql, {
        projectId: input.projectId,
        host: issue.identity.host,
        repositoryNodeId: issue.identity.repositoryNodeId,
      });
      if (
        binding === undefined ||
        binding.status !== "active" ||
        project.workspaceRoot !== binding.workspaceRoot ||
        input.issueRecordId !==
          `issue:${issueIntakeHash([binding.projectId, binding.workspaceRoot, binding.host, binding.repositoryNodeId, binding.account.accountId, issue.identity.issueNodeId])}`
      )
        return yield* new IssueBindingGatewayError({ reason: "stale-binding" });
      if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
        yield* guard.assertBinding(binding);
    },
    Effect.catchTags({
      SqlError: () => Effect.fail(new IssueBindingGatewayError({ reason: "storage" })),
    }),
  );
  return ProjectIssueBindingGateway.of({ identity, bind, list, detach, assertRefinable });
});

export const layer = Layer.effect(ProjectIssueBindingGateway, make);
