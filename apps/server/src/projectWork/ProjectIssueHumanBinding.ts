import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import { ProjectIssueCredentialSnapshot } from "./ProjectIssueCredentialSnapshot.ts";
import {
  bindIssueRepositoryProject,
  readIssueRepositoryState,
  rebindIssueRepositoryProject,
  type IssueRepositoryKey,
} from "./ProjectIssueRepositoryState.ts";
import { GitHubIssueClient } from "./github/GitHubIssueClient.ts";

const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
);
const Workspace = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
);
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Host = Text.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  ),
);
const Key = Schema.Struct({ host: Host, repositoryNodeId: Text });
const Login = Schema.String.check(
  Schema.isMaxLength(39),
  Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/u),
);
const Input = Schema.Struct({
  projectId: Text.check(Schema.isMaxLength(256)),
  expectedRepositoryKey: Key,
  expectedTargetBindingRevision: Schema.NullOr(Counter),
  accountLogin: Login,
  previous: Schema.optionalKey(Schema.Struct({ key: Key, expectedBindingRevision: Counter })),
});
const Binding = Schema.Struct({
  ...Key.fields,
  projectId: Text,
  accountNodeId: Text,
  status: Schema.Literals(["active", "detached"]),
  revision: Counter,
  generation: Counter,
});
const Project = Schema.Struct({
  workspace: Workspace,
  updatedAt: Text,
  lifecycleState: Schema.NullOr(Schema.Literals(["active", "archived", "tombstoned"])),
  lifecycleRevision: Schema.NullOr(Counter),
  lifecycleWorkspace: Schema.NullOr(Workspace),
  lifecycleChangedAt: Schema.NullOr(Text),
  deletedAt: Schema.NullOr(Text),
});
const Owner = Schema.Struct({
  ...Binding.fields,
  ...Project.fields,
  workspace: Schema.NullOr(Project.fields.workspace),
  updatedAt: Schema.NullOr(Text),
});
const Payload = Schema.Struct({ bytes: Counter, raw: Schema.NullOr(Schema.String) });
const decodeInput = Schema.decodeUnknownEffect(Input, { onExcessProperty: "error" });
const decodeBindings = Schema.decodeUnknownEffect(Schema.Array(Binding));
const decodeOwners = Schema.decodeUnknownEffect(Schema.Array(Owner));
const decodeProject = Schema.decodeUnknownEffect(Project);
const decodePayload = Schema.decodeUnknownEffect(Payload);
const isName = Schema.is(Text.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)));
const sameKey = (left: IssueRepositoryKey, right: IssueRepositoryKey) =>
  left.host === right.host && left.repositoryNodeId === right.repositoryNodeId;

export class IssueHumanBindingError extends Schema.TaggedError<IssueHumanBindingError>()(
  "IssueHumanBindingError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "invalid-storage",
      "inactive-project",
      "feature-disabled",
      "human-required",
      "stale-state",
      "account-mismatch",
      "counter-exhausted",
      "binding-limit",
      "credential",
      "github",
      "storage",
      "stopped",
      "busy",
      "deadline",
    ]),
  },
) {
  override get message() {
    return `GitHub repository binding could not be completed (${this.reason}).`;
  }
}
const fail = (reason: IssueHumanBindingError["reason"]) => new IssueHumanBindingError({ reason });
export type HumanRepositoryBindingInput = typeof Input.Type;
export interface HumanRepositoryBindingReceipt {
  readonly host: string;
  readonly repositoryNodeId: string;
  readonly bindingRevision: number;
  readonly status: "ready";
}
export class ProjectIssueHumanBinding extends Context.Service<
  ProjectIssueHumanBinding,
  {
    readonly bind: (
      input: HumanRepositoryBindingInput,
      authorization?: Effect.Effect<void, IssueHumanBindingError>,
    ) => Effect.Effect<HumanRepositoryBindingReceipt, IssueHumanBindingError>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/projectWork/ProjectIssueHumanBinding") {}

const captureRepository = Effect.fn("ProjectIssueHumanBinding.captureRepository")(function* (
  sql: SqlClient.SqlClient,
  key: IssueRepositoryKey,
) {
  const rows =
    yield* sql`SELECT length(CAST(payload_json AS BLOB)) AS bytes,CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json ELSE NULL END AS raw FROM project_issue_repository WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
  if (rows.length === 0) return undefined;
  const row = yield* decodePayload(rows[0]).pipe(Effect.mapError(() => fail("invalid-storage")));
  if (row.bytes > 262144 || row.raw === null) return yield* fail("invalid-storage");
  const state = yield* readIssueRepositoryState(sql, key).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  if (state === undefined) return yield* fail("stale-state");
  const owners =
    yield* sql`SELECT b.host,b.repository_node_id AS repositoryNodeId,b.project_id AS projectId,b.account_node_id AS accountNodeId,b.status,b.revision,b.generation,p.workspace_root AS workspace,p.updated_at AS updatedAt,p.deleted_at AS deletedAt,l.state AS lifecycleState,l.revision AS lifecycleRevision,l.workspace_root AS lifecycleWorkspace,l.changed_at AS lifecycleChangedAt FROM project_issue_binding b LEFT JOIN projection_projects p ON p.project_id=b.project_id LEFT JOIN project_lifecycle l ON l.project_id=b.project_id WHERE b.host=${key.host} AND b.repository_node_id=${key.repositoryNodeId} AND b.status='active' ORDER BY b.project_id LIMIT 9`;
  if (owners.length > 8) return yield* fail("binding-limit");
  const bindings = yield* decodeOwners(owners).pipe(Effect.mapError(() => fail("invalid-storage")));
  for (const binding of bindings)
    if (
      binding.accountNodeId !== state.accountNodeId ||
      binding.workspace === null ||
      binding.deletedAt !== null ||
      (binding.lifecycleState !== null && binding.lifecycleState !== "active") ||
      (binding.lifecycleWorkspace !== null && binding.lifecycleWorkspace !== binding.workspace)
    )
      return yield* fail("stale-state");
  return { raw: row.raw, state, bindings };
});
const capture = Effect.fn("ProjectIssueHumanBinding.capture")(function* (
  sql: SqlClient.SqlClient,
  input: HumanRepositoryBindingInput,
) {
  const projects =
    yield* sql`SELECT p.workspace_root AS workspace,p.updated_at AS updatedAt,p.deleted_at AS deletedAt,l.state AS lifecycleState,l.revision AS lifecycleRevision,l.workspace_root AS lifecycleWorkspace,l.changed_at AS lifecycleChangedAt FROM projection_projects p LEFT JOIN project_lifecycle l ON l.project_id=p.project_id WHERE p.project_id=${input.projectId}`;
  if (projects.length !== 1) return yield* fail("inactive-project");
  const project = yield* decodeProject(projects[0]).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  if (
    project.deletedAt !== null ||
    (project.lifecycleState !== null && project.lifecycleState !== "active") ||
    (project.lifecycleWorkspace !== null && project.lifecycleWorkspace !== project.workspace)
  )
    return yield* fail("inactive-project");
  const rows =
    yield* sql`SELECT host,repository_node_id AS repositoryNodeId,project_id AS projectId,account_node_id AS accountNodeId,status,revision,generation FROM project_issue_binding WHERE project_id=${input.projectId} ORDER BY host,repository_node_id LIMIT 33`;
  if (rows.length > 32) return yield* fail("binding-limit");
  const bindings = yield* decodeBindings(rows).pipe(Effect.mapError(() => fail("invalid-storage")));
  if (bindings.filter((binding) => binding.status === "active").length > 1)
    return yield* fail("human-required");
  const targetBinding = bindings.find((binding) => sameKey(binding, input.expectedRepositoryKey));
  if (targetBinding === undefined && bindings.length >= 32) return yield* fail("binding-limit");
  if ((targetBinding?.revision ?? null) !== input.expectedTargetBindingRevision)
    return yield* fail("stale-state");
  const previousBinding =
    input.previous === undefined
      ? undefined
      : bindings.find((binding) => sameKey(binding, input.previous!.key));
  if (
    input.previous !== undefined &&
    (previousBinding === undefined ||
      previousBinding.revision !== input.previous.expectedBindingRevision)
  )
    return yield* fail("stale-state");
  if (
    input.previous !== undefined &&
    sameKey(input.previous.key, input.expectedRepositoryKey) &&
    input.previous.expectedBindingRevision !== input.expectedTargetBindingRevision
  )
    return yield* fail("stale-state");
  if (
    bindings.some(
      (binding) =>
        binding.status === "active" &&
        !sameKey(binding, input.expectedRepositoryKey) &&
        (input.previous === undefined || !sameKey(binding, input.previous.key)),
    )
  )
    return yield* fail("human-required");
  if (
    input.previous === undefined &&
    bindings.some((binding) => !sameKey(binding, input.expectedRepositoryKey))
  )
    return yield* fail("human-required");
  const target = yield* captureRepository(sql, input.expectedRepositoryKey);
  const previous =
    input.previous === undefined || sameKey(input.previous.key, input.expectedRepositoryKey)
      ? undefined
      : yield* captureRepository(sql, input.previous.key);
  if (
    (targetBinding !== undefined && target === undefined) ||
    (previousBinding !== undefined &&
      !sameKey(previousBinding, input.expectedRepositoryKey) &&
      previous === undefined)
  )
    return yield* fail("invalid-storage");
  if (targetBinding !== undefined && targetBinding.accountNodeId !== target?.state.accountNodeId)
    return yield* fail("account-mismatch");
  if (
    previousBinding !== undefined &&
    previous !== undefined &&
    previousBinding.accountNodeId !== previous.state.accountNodeId
  )
    return yield* fail("account-mismatch");
  if (target?.state.accountLogin !== undefined && target.state.accountLogin !== input.accountLogin)
    return yield* fail("account-mismatch");
  const counters = [
    targetBinding?.revision,
    targetBinding?.generation,
    target?.state.revision,
    target?.state.authorityGeneration,
    previous?.state.revision,
    previous?.state.authorityGeneration,
    ...(previous === undefined ? [] : [previousBinding?.revision, previousBinding?.generation]),
  ];
  if (counters.some((counter) => counter === Number.MAX_SAFE_INTEGER))
    return yield* fail("counter-exhausted");
  return { project, bindings, target, previous };
});

/** Trusted server-local callable. Human RPC supplies a read-only recheck using this SqlClient. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
    return yield* fail("invalid-input");
  const resolver = yield* RepositoryIdentityResolver;
  const snapshots = yield* ProjectIssueCredentialSnapshot;
  const client = yield* GitHubIssueClient;
  const settings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const admission = yield* Semaphore.make(1);
  const running = new Set<Fiber.Fiber<HumanRepositoryBindingReceipt, IssueHumanBindingError>>();
  let stopped = false;
  const enabled = Effect.gen(function* () {
    if (!(yield* settings.getSettings).projectWorkEnabled) return yield* fail("feature-disabled");
  }).pipe(
    Effect.mapError((error) =>
      error._tag === "IssueHumanBindingError" ? error : fail("feature-disabled"),
    ),
  );
  const guard = Effect.fn("ProjectIssueHumanBinding.guard")(function* (deadline: number) {
    if (stopped) return yield* fail("stopped");
    if ((yield* Clock.currentTimeMillis) >= deadline) return yield* fail("deadline");
  });
  const operation = Effect.fn("ProjectIssueHumanBinding.operation")(
    function* (
      input: HumanRepositoryBindingInput,
      authorization: Effect.Effect<void, IssueHumanBindingError>,
    ) {
      const deadline = (yield* Clock.currentTimeMillis) + 55000;
      yield* enabled;
      const fence = yield* sql.withTransaction(
        authorization.pipe(Effect.andThen(capture(sql, input))),
      );
      yield* guard(deadline);
      const identity = yield* resolver.resolve(fence.project.workspace, { refresh: true });
      if (identity === null || identity.provider !== "github") return yield* fail("human-required");
      const [host, ...parts] = identity.canonicalKey.split("/");
      const repositoryName = parts.join("/");
      if (host !== input.expectedRepositoryKey.host || !isName(repositoryName))
        return yield* fail("human-required");
      yield* enabled;
      yield* guard(deadline);
      const credential = yield* snapshots
        .read({
          cwd: fence.project.workspace,
          host,
          accountLogin: input.accountLogin,
          ...(fence.target === undefined
            ? {}
            : { expectedAccountNodeId: fence.target.state.accountNodeId }),
        })
        .pipe(
          Effect.mapError((error) =>
            fail(error.reason === "account-mismatch" ? "account-mismatch" : "credential"),
          ),
        );
      yield* enabled;
      yield* guard(deadline);
      const response = yield* client
        .lookupRepository({
          cwd: fence.project.workspace,
          account: {
            host: credential.host,
            nodeId: credential.accountNodeId,
            credentialFingerprint: credential.credentialEpoch,
          },
          repository: repositoryName,
          expectedRepositoryNodeId: input.expectedRepositoryKey.repositoryNodeId,
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: credential.host,
            token: credential.token,
            credentialFingerprint: credential.credentialEpoch,
          }),
          Effect.mapError((error) =>
            fail(
              error.reason === "repository-mismatch"
                ? "human-required"
                : error.reason === "account-mismatch"
                  ? "account-mismatch"
                  : "github",
            ),
          ),
        );
      if (
        response.status !== "changed" ||
        response.data.host !== input.expectedRepositoryKey.host ||
        response.data.nodeId !== input.expectedRepositoryKey.repositoryNodeId
      )
        return yield* fail("human-required");
      const currentIdentity = yield* resolver.resolve(fence.project.workspace, { refresh: true });
      if (canonicalProjectWorkPayload(currentIdentity) !== canonicalProjectWorkPayload(identity))
        return yield* fail("stale-state");
      yield* guard(deadline);
      // Only a successfully verified same-account credential can recover a rejected epoch.
      const credentialEpoch =
        fence.target?.state.error === "authentication" &&
        fence.target.state.credentialEpoch === credential.credentialEpoch
          ? yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => fail("credential")))
          : credential.credentialEpoch;
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* guard(deadline);
          yield* enabled;
          const current = yield* capture(sql, input);
          if (canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(fence))
            return yield* fail("stale-state");
          yield* authorization;
          yield* guard(deadline);
          const target = {
            key: input.expectedRepositoryKey,
            projectId: input.projectId,
            repositoryName: response.data.nameWithOwner,
            accountNodeId: credential.accountNodeId,
            accountLogin: credential.accountLogin,
            credentialEpoch,
            since: "1970-01-01T00:00:00Z",
            expectedBindingRevision: input.expectedTargetBindingRevision,
          };
          const bound = yield* (
            input.previous !== undefined &&
            !sameKey(input.previous.key, input.expectedRepositoryKey)
              ? rebindIssueRepositoryProject(sql, {
                  previousKey: input.previous.key,
                  expectedPreviousBindingRevision: input.previous.expectedBindingRevision,
                  target,
                })
              : bindIssueRepositoryProject(sql, target)
          ).pipe(
            Effect.mapError((error) =>
              error._tag === "SqlError" ? fail("storage") : fail(error.reason),
            ),
          );
          yield* guard(deadline);
          yield* authorization;
          yield* enabled;
          yield* guard(deadline);
          return {
            host: bound.state.host,
            repositoryNodeId: bound.state.repositoryNodeId,
            bindingRevision: bound.binding.revision,
            status: "ready" as const,
          };
        }),
      );
      yield* guard(deadline);
      return result;
    },
    Effect.catchTag("SqlError", () => fail("storage")),
    Effect.timeoutOrElse({ duration: "55 seconds", orElse: () => fail("deadline") }),
  );
  const stop = Effect.uninterruptible(
    Effect.gen(function* () {
      const active = yield* admission.withPermit(
        Effect.sync(() => {
          stopped = true;
          return [...running];
        }),
      );
      yield* Fiber.interruptAll(active);
    }),
  );
  yield* Effect.addFinalizer(() => stop);
  const bind: ProjectIssueHumanBinding["Service"]["bind"] = Effect.fn(
    "ProjectIssueHumanBinding.bind",
  )(function* (raw, authorization: Effect.Effect<void, IssueHumanBindingError> = Effect.void) {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* fail("invalid-input");
    const input = yield* decodeInput(raw).pipe(Effect.mapError(() => fail("invalid-input")));
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fiber = yield* admission.withPermit(
          Effect.gen(function* () {
            if (stopped) return yield* fail("stopped");
            if (running.size >= 32) return yield* fail("busy");
            const fiber = yield* operation(input, authorization).pipe(
              Effect.interruptible,
              Effect.forkIn(scope),
            );
            running.add(fiber);
            return fiber;
          }),
        );
        return yield* restore(Fiber.join(fiber)).pipe(
          Effect.ensuring(Fiber.interrupt(fiber)),
          Effect.ensuring(
            Effect.sync(() => {
              running.delete(fiber);
            }),
          ),
        );
      }),
    );
  });
  return ProjectIssueHumanBinding.of({ bind, stop });
});
