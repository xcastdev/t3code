import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectWorkCommand } from "@t3tools/contracts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";

const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
);
const Timestamp = Text.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value.replace("Z", ".000Z")
    );
  }),
);
const RepositoryName = Text.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u));
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Binding = Schema.Struct({ projectId: Text, revision: Counter, generation: Counter });
const Lease = Schema.Struct({
  id: Text,
  expiresAt: Counter,
  authorityGeneration: Counter,
  credentialEpoch: Text,
  bindings: Schema.Array(Binding).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
const State = Schema.Struct({
  host: Text.check(
    Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  ),
  repositoryNodeId: Text,
  repositoryName: Schema.Union([RepositoryName, Schema.Literal("")]),
  accountNodeId: Text,
  credentialEpoch: Schema.String.check(Schema.isMaxLength(1024)),
  revision: Counter,
  authorityGeneration: Counter,
  status: Schema.Literals(["ready", "unavailable", "detached"]),
  since: Timestamp,
  pageSize: Schema.Literal(25),
  sweepStartedAt: Schema.NullOr(Timestamp),
  nextPage: Counter.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
  lastSuccessfulPageAt: Schema.NullOr(Timestamp),
  retryAt: Counter,
  error: Schema.NullOr(
    Schema.Literals(["authentication", "rate-limit", "transport", "invalid-page"]),
  ),
  legacyCursor: Schema.NullOr(Text),
  lease: Schema.NullOr(Lease),
});
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(State));
const encodeState = Schema.encodeSync(Schema.fromJsonString(State));
const isBinding = Schema.is(Binding);
const isState = Schema.is(State);
export type IssueRepositoryState = typeof State.Type;
export type IssueRepositoryLease = typeof Lease.Type;
export type IssueRepositoryKey = Pick<IssueRepositoryState, "host" | "repositoryNodeId">;

export class IssueRepositoryStateError extends Schema.TaggedError<IssueRepositoryStateError>()(
  "IssueRepositoryStateError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "inactive-project",
      "account-mismatch",
      "binding-limit",
      "stale-state",
      "counter-exhausted",
    ]),
  },
) {}
const fail = (reason: IssueRepositoryStateError["reason"]) =>
  new IssueRepositoryStateError({ reason });
const increment = (value: number) =>
  value < Number.MAX_SAFE_INTEGER
    ? Effect.succeed(value + 1)
    : Effect.fail(fail("counter-exhausted"));

/** The shared state owns read authority; legacy cursors are retained only as historical projections. */
export const ensureIssueRepositoryTables = Effect.fn("ensureIssueRepositoryTables")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`CREATE TABLE IF NOT EXISTS project_issue_repository (
    host TEXT NOT NULL, repository_node_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY(host, repository_node_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS project_issue_binding (
    project_id TEXT NOT NULL, host TEXT NOT NULL, repository_node_id TEXT NOT NULL,
    account_node_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','detached')),
    revision INTEGER NOT NULL CHECK(revision >= 0), generation INTEGER NOT NULL CHECK(generation >= 0),
    PRIMARY KEY(project_id, host, repository_node_id),
    FOREIGN KEY(host, repository_node_id) REFERENCES project_issue_repository(host, repository_node_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS project_issue_binding_repository ON project_issue_binding(host, repository_node_id, status, project_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS project_issue_page (
    commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    host TEXT NOT NULL, repository_node_id TEXT NOT NULL, read_key TEXT NOT NULL,
    page_kind TEXT NOT NULL CHECK(page_kind IN ('issues','comments')), payload_json TEXT NOT NULL,
    UNIQUE(host, repository_node_id, page_kind, read_key),
    FOREIGN KEY(host, repository_node_id) REFERENCES project_issue_repository(host, repository_node_id)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS project_issue_external (
    host TEXT NOT NULL, repository_node_id TEXT NOT NULL, issue_node_id TEXT NOT NULL,
    issue_number INTEGER NOT NULL CHECK(issue_number > 0), source_revision TEXT NOT NULL,
    payload_json TEXT NOT NULL, PRIMARY KEY(host, repository_node_id, issue_node_id),
    UNIQUE(host, repository_node_id, issue_number),
    FOREIGN KEY(host, repository_node_id) REFERENCES project_issue_repository(host, repository_node_id)
  )`;
});

const projectActive = Effect.fn("IssueRepository.projectActive")(function* (
  sql: SqlClient.SqlClient,
  projectId: string,
) {
  const rows = yield* sql`SELECT p.project_id FROM projection_projects p
    LEFT JOIN project_lifecycle l ON l.project_id=p.project_id
    WHERE p.project_id=${projectId} AND p.deleted_at IS NULL AND (l.state IS NULL OR l.state='active')`;
  return rows.length === 1;
});

export const readIssueRepositoryState = Effect.fn("readIssueRepositoryState")(function* (
  sql: SqlClient.SqlClient,
  key: IssueRepositoryKey,
) {
  const rows = yield* sql<{
    payload: string;
  }>`SELECT payload_json AS payload FROM project_issue_repository
    WHERE host=${key.host} AND repository_node_id=${key.repositoryNodeId}`;
  const row = rows[0];
  if (row === undefined) return undefined;
  const state = yield* decodeState(row.payload).pipe(Effect.mapError(() => fail("invalid-input")));
  if (state.host !== key.host || state.repositoryNodeId !== key.repositoryNodeId)
    return yield* fail("invalid-input");
  return state;
});

const writeState = Effect.fn("IssueRepository.writeState")(function* (
  sql: SqlClient.SqlClient,
  state: IssueRepositoryState,
) {
  if (!isState(state)) return yield* fail("invalid-input");
  yield* sql`INSERT INTO project_issue_repository(host,repository_node_id,payload_json)
    VALUES(${state.host},${state.repositoryNodeId},${encodeState(state)})
    ON CONFLICT(host,repository_node_id) DO UPDATE SET payload_json=excluded.payload_json`;
});

const currentBindings = Effect.fn("IssueRepository.currentBindings")(function* (
  sql: SqlClient.SqlClient,
  state: IssueRepositoryState,
) {
  const rows = yield* sql<{
    projectId: string;
    accountNodeId: string;
    revision: number;
    generation: number;
  }>`
    SELECT project_id AS projectId,account_node_id AS accountNodeId,revision,generation FROM project_issue_binding
    WHERE host=${state.host} AND repository_node_id=${state.repositoryNodeId} AND status='active'
    ORDER BY project_id LIMIT 9`;
  if (rows.length === 0 || rows.length > 8) return undefined;
  const bindings: Array<typeof Binding.Type> = [];
  for (const row of rows) {
    if (
      row.accountNodeId !== state.accountNodeId ||
      !isBinding(row) ||
      !(yield* projectActive(sql, row.projectId))
    )
      return undefined;
    bindings.push({ projectId: row.projectId, revision: row.revision, generation: row.generation });
  }
  return bindings;
});
const sameBindings = (
  a: ReadonlyArray<typeof Binding.Type>,
  b: ReadonlyArray<typeof Binding.Type>,
) =>
  a.length === b.length &&
  a.every(
    (item, index) =>
      item.projectId === b[index]?.projectId &&
      item.revision === b[index]?.revision &&
      item.generation === b[index]?.generation,
  );

/** Human/account verification happens in the caller; no public mutation or automatic account fallback. */
export const bindIssueRepositoryProject = Effect.fn("bindIssueRepositoryProject")(function* (
  sql: SqlClient.SqlClient,
  input: {
    key: IssueRepositoryKey;
    projectId: string;
    repositoryName: string;
    accountNodeId: string;
    credentialEpoch: string;
    since: string;
    expectedBindingRevision: number | null;
  },
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* projectActive(sql, input.projectId))) return yield* fail("inactive-project");
      let state = yield* readIssueRepositoryState(sql, input.key);
      if (state !== undefined && state.accountNodeId !== input.accountNodeId)
        return yield* fail("account-mismatch");
      if (state?.error === "authentication" && state.credentialEpoch === input.credentialEpoch)
        return yield* fail("invalid-input");
      const prior = yield* sql<{
        revision: number;
        generation: number;
      }>`SELECT revision,generation FROM project_issue_binding
      WHERE project_id=${input.projectId} AND host=${input.key.host} AND repository_node_id=${input.key.repositoryNodeId}`;
      if ((prior[0]?.revision ?? null) !== input.expectedBindingRevision)
        return yield* fail("stale-state");
      const count = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM project_issue_binding
      WHERE host=${input.key.host} AND repository_node_id=${input.key.repositoryNodeId} AND status='active' AND project_id!=${input.projectId}`;
      if ((count[0]?.count ?? 0) >= 8) return yield* fail("binding-limit");
      const binding = {
        projectId: input.projectId,
        revision: prior[0] === undefined ? 0 : yield* increment(prior[0].revision),
        generation: prior[0] === undefined ? 0 : yield* increment(prior[0].generation),
      };
      if (!isBinding(binding)) return yield* fail("invalid-input");
      state =
        state === undefined
          ? {
              ...input.key,
              repositoryName: input.repositoryName,
              accountNodeId: input.accountNodeId,
              credentialEpoch: input.credentialEpoch,
              revision: 0,
              authorityGeneration: 0,
              status: "ready",
              since: input.since,
              pageSize: 25,
              sweepStartedAt: null,
              nextPage: 1,
              lastSuccessfulPageAt: null,
              retryAt: 0,
              error: null,
              legacyCursor: null,
              lease: null,
            }
          : {
              ...state,
              repositoryName: input.repositoryName,
              credentialEpoch: input.credentialEpoch,
              status: "ready",
              revision: yield* increment(state.revision),
              authorityGeneration: yield* increment(state.authorityGeneration),
              lease: null,
              error: null,
              retryAt: 0,
            };
      yield* writeState(sql, state);
      yield* sql`INSERT INTO project_issue_binding(project_id,host,repository_node_id,account_node_id,status,revision,generation)
      VALUES(${binding.projectId},${input.key.host},${input.key.repositoryNodeId},${input.accountNodeId},'active',${binding.revision},${binding.generation})
      ON CONFLICT(project_id,host,repository_node_id) DO UPDATE SET status='active',account_node_id=excluded.account_node_id,revision=excluded.revision,generation=excluded.generation`;
      return { state, binding };
    }),
  );
});

/** A server-minted opaque epoch fences restart/rotation without persisting a token or its digest. */
export const rotateIssueRepositoryCredential = Effect.fn("rotateIssueRepositoryCredential")(
  function* (
    sql: SqlClient.SqlClient,
    key: IssueRepositoryKey,
    input: { accountNodeId: string; credentialEpoch: string; expectedRevision: number },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* readIssueRepositoryState(sql, key);
        if (current === undefined || current.revision !== input.expectedRevision)
          return yield* fail("stale-state");
        if (current.status === "detached") return yield* fail("stale-state");
        if (current.accountNodeId !== input.accountNodeId) return yield* fail("account-mismatch");
        if (current.credentialEpoch === input.credentialEpoch || input.credentialEpoch.length === 0)
          return yield* fail("invalid-input");
        const state: IssueRepositoryState = {
          ...current,
          credentialEpoch: input.credentialEpoch,
          status: "ready",
          lease: null,
          error: null,
          retryAt: 0,
          revision: yield* increment(current.revision),
          authorityGeneration: yield* increment(current.authorityGeneration),
        };
        yield* writeState(sql, state);
        return state;
      }),
    );
  },
);

/** Lease ids come from the server, never a client; successful progress is unchanged by a claim. */
export const claimIssueRepositoryRead = Effect.fn("claimIssueRepositoryRead")(function* (
  sql: SqlClient.SqlClient,
  key: IssueRepositoryKey,
  input: { leaseId: string; durationMs: number; sweepStartedAt: string },
) {
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(input.durationMs) ||
        input.durationMs < 1 ||
        input.durationMs > 60000 ||
        !Number.isSafeInteger(now + input.durationMs)
      )
        return yield* fail("invalid-input");
      const state = yield* readIssueRepositoryState(sql, key);
      if (
        state === undefined ||
        state.status !== "ready" ||
        state.credentialEpoch.length === 0 ||
        state.repositoryName.length === 0 ||
        state.retryAt > now ||
        (state.lease !== null && state.lease.expiresAt > now)
      )
        return undefined;
      const bindings = yield* currentBindings(sql, state);
      if (bindings === undefined) return undefined;
      const lease: IssueRepositoryLease = {
        id: input.leaseId,
        expiresAt: now + input.durationMs,
        authorityGeneration: state.authorityGeneration,
        credentialEpoch: state.credentialEpoch,
        bindings,
      };
      const claimed: IssueRepositoryState = {
        ...state,
        lease,
        sweepStartedAt: state.sweepStartedAt ?? input.sweepStartedAt,
        revision: yield* increment(state.revision),
      };
      yield* writeState(sql, claimed);
      return claimed;
    }),
  );
});

const currentLease = Effect.fn("IssueRepository.currentLease")(function* (
  sql: SqlClient.SqlClient,
  key: IssueRepositoryKey,
  lease: IssueRepositoryLease,
) {
  const state = yield* readIssueRepositoryState(sql, key);
  const now = yield* Clock.currentTimeMillis;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    state === undefined ||
    state.status !== "ready" ||
    state.lease === null ||
    state.lease.id !== lease.id ||
    state.lease.expiresAt !== lease.expiresAt ||
    state.lease.expiresAt <= now ||
    state.authorityGeneration !== lease.authorityGeneration ||
    state.credentialEpoch !== lease.credentialEpoch ||
    !sameBindings(state.lease.bindings, lease.bindings)
  )
    return undefined;
  const bindings = yield* currentBindings(sql, state);
  return bindings === undefined || !sameBindings(bindings, state.lease.bindings)
    ? undefined
    : state;
});

/** Prepare only SQL commands/page/cache writes in this callback; external reads occur before it. */
export const commitIssueRepositoryRead = Effect.fn("commitIssueRepositoryRead")(function* <E, R>(
  sql: SqlClient.SqlClient,
  key: IssueRepositoryKey,
  lease: IssueRepositoryLease,
  prepare: (current: IssueRepositoryState) => Effect.Effect<
    {
      readonly commands: ReadonlyArray<ProjectWorkCommand>;
      readonly progress: Pick<
        IssueRepositoryState,
        "since" | "nextPage" | "sweepStartedAt" | "lastSuccessfulPageAt"
      >;
    },
    E,
    R
  >,
) {
  const repository = yield* ProjectWorkRepository;
  if ((yield* SqlClient.SqlClient) !== sql) return yield* fail("invalid-input");
  let accepted = false;
  const results = yield* repository.executeAtomic(
    Effect.gen(function* () {
      if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
        return yield* fail("invalid-input");
      const current = yield* currentLease(sql, key, lease);
      if (current === undefined) return [];
      const prepared = yield* prepare(current);
      if ((yield* currentLease(sql, key, lease)) === undefined) return yield* fail("stale-state");
      if (
        prepared.commands.length > 8 ||
        prepared.commands.some(
          (command) =>
            !current.lease!.bindings.some((binding) => binding.projectId === command.projectId),
        )
      )
        return yield* fail("binding-limit");
      yield* writeState(sql, {
        ...current,
        ...prepared.progress,
        lease: null,
        error: null,
        retryAt: 0,
        revision: yield* increment(current.revision),
      });
      accepted = true;
      return prepared.commands;
    }),
  );
  return { accepted, results };
});

export const recordIssueRepositoryReadFailure = Effect.fn("recordIssueRepositoryReadFailure")(
  function* (
    sql: SqlClient.SqlClient,
    key: IssueRepositoryKey,
    lease: IssueRepositoryLease,
    input: { retryAt: number; error: NonNullable<IssueRepositoryState["error"]> },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* currentLease(sql, key, lease);
        if (state === undefined) return false;
        const now = yield* Clock.currentTimeMillis;
        if (
          !Number.isSafeInteger(input.retryAt) ||
          input.retryAt < now ||
          input.retryAt > now + 3600000
        )
          return yield* fail("invalid-input");
        yield* writeState(sql, {
          ...state,
          status: input.error === "authentication" ? "unavailable" : state.status,
          lease: null,
          revision: yield* increment(state.revision),
          retryAt: input.retryAt,
          error: input.error,
        });
        return true;
      }),
    );
  },
);
