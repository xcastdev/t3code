import {
  ProjectIssueIntake,
  ProjectIssueSyncInput,
  type ProjectIssueSyncReceipt,
} from "@t3tools/contracts";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type { IssueHumanAuthorization } from "./ProjectIssueBindingGateway.ts";
import {
  IssueBindingGatewayError,
  makeIssueProjectGuard,
  readIssueBinding,
  writeIssueBinding,
} from "./ProjectIssueRepositoryState.ts";
import { issueIntakeHash, planIssueIntake } from "./ProjectIssueIntakeService.ts";
import * as Repository from "./ProjectWorkRepository.ts";

const decodeInput = Schema.decodeUnknownEffect(ProjectIssueSyncInput, {
  onExcessProperty: "error",
});

const CachedPage = Schema.Struct({
  etag: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  nextPage: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  entries: Schema.Array(
    Schema.Struct({
      nodeId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
      number: ProjectIssueIntake.fields.identity.fields.number,
      title: ProjectIssueIntake.fields.title,
      body: ProjectIssueIntake.fields.body,
      state: Schema.Literals(["open", "closed"]),
      updatedAt: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ).check(Schema.isMaxLength(25)),
});
const isIssueBindingError = Schema.is(IssueBindingGatewayError);
const decodePage = Schema.decodeEffect(Schema.fromJsonString(CachedPage));
const encodePage = Schema.encodeEffect(Schema.fromJsonString(CachedPage));

export class ProjectIssueSyncWorker extends Context.Service<
  ProjectIssueSyncWorker,
  {
    readonly readOnce: (
      input: ProjectIssueSyncInput,
      authorize: IssueHumanAuthorization,
    ) => Effect.Effect<ProjectIssueSyncReceipt, IssueBindingGatewayError>;
  }
>()("t3/projectWork/ProjectIssueSyncWorker") {}

// Explicit one-page requests only. Acquiring this layer neither reads GitHub nor starts a fiber.
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const api = yield* GitHubIssueApi.GitHubIssueApi;
  const repository = yield* Repository.ProjectWorkRepository;
  const guard = yield* makeIssueProjectGuard;
  const readOnce = Effect.fn("ProjectIssueSyncWorker.readOnce")(
    function* (
      raw: ProjectIssueSyncInput,
      authorize: IssueHumanAuthorization,
    ): Effect.fn.Return<ProjectIssueSyncReceipt, IssueBindingGatewayError | SqlError.SqlError> {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* new IssueBindingGatewayError({ reason: "invalid-input" });
      const input = yield* decodeInput(raw).pipe(
        Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-input" })),
      );
      yield* sql.withTransaction(authorize);
      const binding = yield* readIssueBinding(sql, input);
      if (binding === undefined || binding.revision !== input.bindingRevision)
        return yield* new IssueBindingGatewayError({ reason: "stale-binding" });
      yield* guard.assertBinding(binding);
      const now = yield* Clock.currentTimeMillis;
      if (binding.retryAt !== null && binding.retryAt > now)
        return { status: "paused", retryAt: binding.retryAt };
      const requestHash = issueIntakeHash([
        binding.projectId,
        binding.workspaceRoot,
        binding.host,
        binding.repositoryNodeId,
        binding.revision,
        binding.account,
        binding.since,
        binding.nextPage,
      ]);
      const cachedRows = yield* sql<{
        payload: string;
        bytes: number;
      }>`SELECT payload_json AS payload, length(CAST(payload_json AS BLOB)) AS bytes
      FROM t3_workflow_v2_issue_pages WHERE project_id=${input.projectId} AND host=${input.host}
      AND repository_node_id=${input.repositoryNodeId} AND binding_revision=${binding.revision} AND request_hash=${requestHash}`;
      const cachedRow = cachedRows[0];
      if (cachedRow !== undefined && cachedRow.bytes > 4_194_304)
        return yield* new IssueBindingGatewayError({ reason: "invalid-storage" });
      const cached =
        cachedRow === undefined
          ? undefined
          : yield* decodePage(cachedRow.payload).pipe(
              Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-storage" })),
            );
      const response = yield* api
        .readIssuesPage({
          cwd: binding.workspaceRoot,
          account: binding.account,
          repository: {
            host: binding.host,
            nodeId: binding.repositoryNodeId,
            nameWithOwner: binding.repositoryName,
          },
          since: binding.since,
          page: binding.nextPage,
          pageSize: 25,
          ...(cached?.etag == null ? {} : { etag: cached.etag }),
        })
        .pipe(Effect.result);
      const assertCurrent = Effect.fn("ProjectIssueSyncWorker.assertCurrent")(function* () {
        yield* authorize;
        const project = yield* guard.project(input.projectId);
        const current = yield* readIssueBinding(sql, input);
        if (
          project.workspaceRoot !== binding.workspaceRoot ||
          current === undefined ||
          current.status !== "active" ||
          current.revision !== binding.revision ||
          current.syncRevision !== binding.syncRevision
        )
          return yield* new IssueBindingGatewayError({ reason: "stale-binding" });
      });
      if (response._tag === "Failure") {
        const error = response.failure;
        const retryAt =
          error.reason === "rate-limited" || error.reason === "rate-paused"
            ? Math.max(now + 1_000, error.retryAt ?? now + 60_000)
            : undefined;
        if (retryAt !== undefined)
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* assertCurrent();
              yield* writeIssueBinding(sql, { ...binding, retryAt });
            }),
          );
        return {
          status: "failure",
          reason: error.reason,
          ...(retryAt === undefined ? {} : { retryAt }),
        };
      }
      const page = response.success;
      if (
        page.repository.host !== binding.host ||
        page.repository.nodeId !== binding.repositoryNodeId ||
        page.repository.nameWithOwner.toLowerCase() !== binding.repositoryName.toLowerCase()
      )
        return yield* new IssueBindingGatewayError({ reason: "repository-mismatch" });
      if (
        page.status === "not-modified" &&
        (cached === undefined || cached.etag === null || page.etag !== cached.etag)
      )
        return yield* new IssueBindingGatewayError({ reason: "invalid-storage" });
      const accepted = page.status === "changed" ? page : cached!;
      if (
        accepted.entries.length > 25 ||
        (accepted.nextPage !== null &&
          (accepted.nextPage !== binding.nextPage + 1 || accepted.nextPage > 10_000))
      )
        return yield* new IssueBindingGatewayError({ reason: "invalid-input" });
      yield* guard.assertBinding(binding);
      const highWater = accepted.entries.reduce(
        (latest, entry) => (entry.updatedAt > latest ? entry.updatedAt : latest),
        binding.highWater,
      );
      const highWaterDate = DateTime.make(highWater);
      if (Option.isNone(highWaterDate))
        return yield* new IssueBindingGatewayError({ reason: "invalid-input" });
      const overlap = DateTime.formatIso(
        DateTime.makeUnsafe(Math.max(0, DateTime.toEpochMillis(highWaterDate.value) - 60_000)),
      ).replace(/\.\d{3}Z$/u, "Z");
      const nextSince =
        accepted.nextPage === null && overlap > binding.since ? overlap : binding.since;
      const observedAt = DateTime.formatIso(yield* DateTime.now).replace(/\.\d{3}Z$/u, "Z");
      const current = yield* Repository.readCurrentState(sql, input.projectId).pipe(
        Effect.mapError(() => new IssueBindingGatewayError({ reason: "storage" })),
      );
      const command = yield* Effect.try({
        try: () =>
          planIssueIntake({
            binding,
            state: current,
            entries: accepted.entries,
            observedAt,
            requestHash,
            nextPage: accepted.nextPage ?? 1,
            nextSince,
          }),
        catch: () => new IssueBindingGatewayError({ reason: "invalid-input" }),
      });
      const payload = yield* encodePage({
        etag: page.etag,
        entries: accepted.entries,
        nextPage: accepted.nextPage,
      }).pipe(Effect.mapError(() => new IssueBindingGatewayError({ reason: "invalid-input" })));
      yield* repository
        .executeAuthorized(command, () =>
          Effect.gen(function* () {
            yield* assertCurrent();
            yield* sql`INSERT INTO t3_workflow_v2_issue_pages (project_id,host,repository_node_id,binding_revision,request_hash,payload_json)
        VALUES (${input.projectId},${input.host},${input.repositoryNodeId},${binding.revision},${requestHash},${payload})
        ON CONFLICT(project_id,host,repository_node_id) DO UPDATE SET binding_revision=excluded.binding_revision,request_hash=excluded.request_hash,payload_json=excluded.payload_json`;
            yield* writeIssueBinding(sql, {
              ...binding,
              nextPage: accepted.nextPage ?? 1,
              since: nextSince,
              highWater,
              syncRevision: binding.syncRevision + 1,
              retryAt: null,
            });
            return command;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isIssueBindingError(cause)
              ? cause
              : new IssueBindingGatewayError({ reason: "storage" }),
          ),
        );
      return {
        status: "committed",
        page: binding.nextPage,
        nextPage: accepted.nextPage,
        count: accepted.entries.length,
      };
    },
    Effect.catchTags({
      SqlError: () => Effect.fail(new IssueBindingGatewayError({ reason: "storage" })),
    }),
  );
  return ProjectIssueSyncWorker.of({ readOnce });
});

export const layer = Layer.effect(ProjectIssueSyncWorker, make);
