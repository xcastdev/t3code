import { ProjectIssueIntake, canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import {
  readIssueRepositoryState,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import { GitHubIssueClient, type GitHubIssueComment } from "./github/GitHubIssueClient.ts";
import { weaklyMatchesEtag } from "./github/GitHubIssueSync.ts";

const maxPageBytes = 2 * 1024 * 1024;
const maxSourceBytes = 256 * 1024;
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
);
const Id = Text.check(Schema.isMaxLength(256));
const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Natural.check(Schema.isGreaterThanOrEqualTo(1));
const Page = Positive.check(Schema.isLessThanOrEqualTo(10000));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value.replace("Z", ".000Z")
    );
  }),
);
const Host = Text.check(
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
);
const Repository = Schema.Struct({
  host: Host,
  nodeId: Text,
  nameWithOwner: Text.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
});
const Etag = Schema.String.check(Schema.isPattern(/^(?:W\/)?"[\x21\x23-\x7e]{0,512}"$/u));
const Input = Schema.Struct({
  projectId: Id,
  issueRecordId: Id,
  expectedRevision: Natural,
  page: Schema.optionalKey(Page),
});
const boundedProjectIssueIntake = Schema.Struct({
  ...ProjectIssueIntake.fields,
  recordId: Id,
  projectId: Id,
  revision: Natural,
  generation: Natural,
  identity: Schema.Struct({
    host: Host,
    repositoryNodeId: Text,
    issueNodeId: Text,
    number: Positive,
  }),
  sourceRevision: Timestamp,
  repositoryName: Repository.fields.nameWithOwner,
});
const Comment = Schema.Struct({
  nodeId: Text,
  body: Schema.String.check(Schema.isMaxLength(32000)),
  bodyTruncated: Schema.Boolean,
  updatedAt: Timestamp,
  url: Schema.String.check(Schema.isMaxLength(4096)),
});
const External = Schema.Struct({
  repository: Repository,
  issue: Schema.Struct({
    nodeId: Text,
    number: Positive,
    title: ProjectIssueIntake.fields.title,
    titleTruncated: Schema.Boolean,
    body: Schema.String.check(Schema.isMaxLength(32000)),
    bodyTruncated: Schema.Boolean,
    state: Schema.Literals(["open", "closed"]),
    updatedAt: Timestamp,
    closedAt: Schema.NullOr(Timestamp),
    url: Schema.String.check(Schema.isMaxLength(4096)),
    commentCount: Natural,
  }),
});
const Binding = Schema.Struct({
  accountNodeId: Text,
  revision: Natural,
  generation: Natural,
  status: Schema.Literal("active"),
});
const ReadKey = Schema.Tuple([
  Host,
  Text,
  Repository.fields.nameWithOwner,
  Text,
  Text,
  Natural,
  Text,
  Positive,
  Timestamp,
  Page,
  Schema.Literal(25),
]);
const Snapshot = Schema.Struct({
  readKey: Schema.String.check(Schema.isMaxLength(20000)),
  entries: Schema.Array(Comment).check(Schema.isMaxLength(25)),
  nextPage: Schema.NullOr(Page),
  rawEntryCount: Natural.check(Schema.isLessThanOrEqualTo(25)),
  etag: Schema.NullOr(Etag),
  observedAt: Timestamp,
});
const PayloadRow = Schema.Struct({ payloadBytes: Natural, payload: Schema.NullOr(Schema.String) });
const IntakeRow = Schema.Struct({
  ...PayloadRow.fields,
  recordId: Id,
  projectId: Id,
  revision: Natural,
  generation: Natural,
  status: Schema.String,
  updatedAt: Schema.String,
});
const ExternalRow = Schema.Struct({
  ...PayloadRow.fields,
  host: Host,
  repositoryNodeId: Text,
  issueNodeId: Text,
  issueNumber: Positive,
  sourceRevision: Timestamp,
});
const CacheRow = Schema.Struct({ ...PayloadRow.fields, sequence: Positive });
const Credential = Schema.Struct({
  cwd: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
    Schema.isTrimmed(),
    Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
  ),
  host: Host,
  accountNodeId: Text,
  credentialEpoch: Text,
  token: Schema.Redacted(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384))),
});
const decodeInput = Schema.decodeUnknownEffect(Input, { onExcessProperty: "error" });
const decodeIntake = Schema.decodeUnknownEffect(Schema.fromJsonString(boundedProjectIssueIntake), {
  onExcessProperty: "error",
});
const decodeExternal = Schema.decodeUnknownEffect(Schema.fromJsonString(External), {
  onExcessProperty: "error",
});
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot), {
  onExcessProperty: "error",
});
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Snapshot));
const encodeKey = Schema.encodeEffect(Schema.fromJsonString(ReadKey));
const decodeComment = Schema.decodeUnknownEffect(Comment, { onExcessProperty: "error" });
const decodeCredential = Schema.decodeUnknownEffect(Credential, { onExcessProperty: "error" });
const decodePayloadRow = Schema.decodeUnknownEffect(PayloadRow);
const decodeIntakeRow = Schema.decodeUnknownEffect(IntakeRow);
const decodeExternalRow = Schema.decodeUnknownEffect(ExternalRow);
const decodeBinding = Schema.decodeUnknownEffect(Binding);
const decodeCacheRow = Schema.decodeUnknownEffect(CacheRow);
const decodeSequence = Schema.decodeUnknownEffect(Schema.Struct({ sequence: Positive }));

export class IssueCommentsError extends Schema.TaggedError<IssueCommentsError>()(
  "IssueCommentsError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "unavailable",
      "stale-authority",
      "invalid-storage",
      "payload-too-large",
      "credential-mismatch",
      "invalid-response",
      "storage",
      "stopped",
      "busy",
      "deadline",
      "github",
    ]),
    githubReason: Schema.optionalKey(Schema.String),
    retryAt: Schema.optionalKey(Schema.Finite),
  },
) {}
const fail = (reason: IssueCommentsError["reason"]) => new IssueCommentsError({ reason });
export interface IssueCommentsPage {
  readonly projectId: string;
  readonly issueRecordId: string;
  readonly issueRevision: number;
  readonly sourceRevision: string;
  readonly page: number;
  readonly entries: ReadonlyArray<GitHubIssueComment>;
  readonly nextPage: number | null;
  readonly observedAt: string;
}
export class ProjectIssueComments extends Context.Service<
  ProjectIssueComments,
  {
    readonly read: (input: {
      readonly projectId: string;
      readonly issueRecordId: string;
      readonly expectedRevision: number;
      readonly page?: number;
    }) => Effect.Effect<IssueCommentsPage, IssueCommentsError>;
    readonly stop: Effect.Effect<void>;
  }
>()("t3/projectWork/ProjectIssueComments") {}

const boundedPayload = (row: typeof PayloadRow.Type, maximum: number) =>
  row.payloadBytes > maximum
    ? Effect.fail(fail("payload-too-large"))
    : row.payload === null
      ? Effect.fail(fail("invalid-storage"))
      : Effect.succeed(row.payload);
const capture = Effect.fn("ProjectIssueComments.capture")(function* (
  sql: SqlClient.SqlClient,
  input: typeof Input.Type,
) {
  const projects =
    yield* sql`SELECT p.project_id FROM projection_projects p LEFT JOIN project_lifecycle l ON l.project_id=p.project_id WHERE p.project_id=${input.projectId} AND p.deleted_at IS NULL AND (l.state IS NULL OR l.state='active')`;
  if (projects.length !== 1) return yield* fail("unavailable");
  const issues =
    yield* sql`SELECT record_id AS recordId,project_id AS projectId,revision,generation,status,updated_at AS updatedAt,length(CAST(payload_json AS BLOB)) AS payloadBytes,CASE WHEN length(CAST(payload_json AS BLOB)) <= ${maxSourceBytes} THEN payload_json ELSE NULL END AS payload FROM project_team_issue WHERE project_id=${input.projectId} AND record_id=${input.issueRecordId} LIMIT 1`;
  if (issues[0] === undefined) return yield* fail("unavailable");
  const row = yield* decodeIntakeRow(issues[0]).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  const issue = yield* decodeIntake(yield* boundedPayload(row, maxSourceBytes)).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  if (
    issue.projectId !== row.projectId ||
    issue.recordId !== row.recordId ||
    issue.revision !== row.revision ||
    issue.generation !== row.generation ||
    issue.status !== row.status ||
    issue.updatedAt !== row.updatedAt
  )
    return yield* fail("invalid-storage");
  if (issue.status === "detached" || issue.revision !== input.expectedRevision)
    return yield* fail("stale-authority");
  const { identity } = issue;
  const bindings =
    yield* sql`SELECT account_node_id AS accountNodeId,revision,generation,status FROM project_issue_binding WHERE project_id=${input.projectId} AND host=${identity.host} AND repository_node_id=${identity.repositoryNodeId} LIMIT 1`;
  if (bindings[0] === undefined) return yield* fail("unavailable");
  const binding = yield* decodeBinding(bindings[0]).pipe(
    Effect.mapError(() => fail("stale-authority")),
  );
  // Bound the raw repository payload before the shared decoder sees it.
  const repositories =
    yield* sql`SELECT length(CAST(payload_json AS BLOB)) AS payloadBytes,CASE WHEN length(CAST(payload_json AS BLOB)) <= ${maxSourceBytes} THEN payload_json ELSE NULL END AS payload FROM project_issue_repository WHERE host=${identity.host} AND repository_node_id=${identity.repositoryNodeId} LIMIT 1`;
  if (repositories[0] === undefined) return yield* fail("unavailable");
  const repositoryRow = yield* decodePayloadRow(repositories[0]).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  yield* boundedPayload(repositoryRow, maxSourceBytes);
  const state = yield* readIssueRepositoryState(sql, {
    host: identity.host,
    repositoryNodeId: identity.repositoryNodeId,
  }).pipe(Effect.mapError(() => fail("invalid-storage")));
  if (
    state === undefined ||
    state.status !== "ready" ||
    state.credentialEpoch.length === 0 ||
    state.repositoryName !== issue.repositoryName ||
    state.accountNodeId !== binding.accountNodeId
  )
    return yield* fail("stale-authority");
  const externalRows =
    yield* sql`SELECT host,repository_node_id AS repositoryNodeId,issue_node_id AS issueNodeId,issue_number AS issueNumber,source_revision AS sourceRevision,length(CAST(payload_json AS BLOB)) AS payloadBytes,CASE WHEN length(CAST(payload_json AS BLOB)) <= ${maxSourceBytes} THEN payload_json ELSE NULL END AS payload FROM project_issue_external WHERE host=${identity.host} AND repository_node_id=${identity.repositoryNodeId} AND issue_node_id=${identity.issueNodeId} LIMIT 1`;
  if (externalRows[0] === undefined) return yield* fail("unavailable");
  const externalRow = yield* decodeExternalRow(externalRows[0]).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  const external = yield* decodeExternal(yield* boundedPayload(externalRow, maxSourceBytes)).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  if (
    externalRow.host !== identity.host ||
    externalRow.repositoryNodeId !== identity.repositoryNodeId ||
    externalRow.issueNodeId !== identity.issueNodeId ||
    externalRow.issueNumber !== identity.number ||
    externalRow.sourceRevision !== issue.sourceRevision ||
    external.repository.host !== identity.host ||
    external.repository.nodeId !== identity.repositoryNodeId ||
    external.repository.nameWithOwner !== state.repositoryName ||
    external.issue.nodeId !== identity.issueNodeId ||
    external.issue.number !== identity.number ||
    external.issue.updatedAt !== issue.sourceRevision ||
    external.issue.title !== issue.title ||
    external.issue.body !== issue.body ||
    external.issue.state !== issue.status
  )
    return yield* fail("stale-authority");
  const readKey = yield* encodeKey([
    identity.host,
    identity.repositoryNodeId,
    state.repositoryName,
    state.accountNodeId,
    state.credentialEpoch,
    state.authorityGeneration,
    identity.issueNodeId,
    identity.number,
    issue.sourceRevision,
    input.page ?? 1,
    25,
  ]).pipe(Effect.mapError(() => fail("invalid-storage")));
  return { issue, binding, state, external, readKey };
});
type Fence = Effect.Success<ReturnType<typeof capture>>;
const sameFence = (left: Fence, right: Fence) =>
  left.readKey === right.readKey &&
  canonicalProjectWorkPayload(left.issue) === canonicalProjectWorkPayload(right.issue) &&
  canonicalProjectWorkPayload(left.binding) === canonicalProjectWorkPayload(right.binding) &&
  canonicalProjectWorkPayload(left.external) === canonicalProjectWorkPayload(right.external);
const validateSnapshot = Effect.fn("ProjectIssueComments.validateSnapshot")(function* (
  fence: Fence,
  page: number,
  snapshot: typeof Snapshot.Type,
) {
  if (
    snapshot.readKey !== fence.readKey ||
    snapshot.entries.length > snapshot.rawEntryCount ||
    (snapshot.nextPage !== null && snapshot.nextPage !== page + 1) ||
    snapshot.observedAt < fence.issue.sourceRevision
  )
    return yield* fail("invalid-response");
  const ids = new Set<string>();
  const prefix = `https://${fence.state.host}/${fence.state.repositoryName}/issues/${fence.issue.identity.number}#issuecomment-`;
  for (const entry of snapshot.entries) {
    if (
      ids.has(entry.nodeId) ||
      !entry.url.startsWith(prefix) ||
      !/^\d+$/u.test(entry.url.slice(prefix.length)) ||
      entry.updatedAt > snapshot.observedAt
    )
      return yield* fail("invalid-response");
    ids.add(entry.nodeId);
  }
  return snapshot;
});
const currentTime = Effect.fn("ProjectIssueComments.currentTime")(function* () {
  const now = yield* Clock.currentTimeMillis;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 55000))
    return yield* fail("deadline");
  return now;
});
const beforeDeadline = Effect.fn("ProjectIssueComments.beforeDeadline")(function* (
  deadline: number,
) {
  if ((yield* currentTime()) >= deadline) return yield* fail("deadline");
});

/** Resolve explicit current credentials outside SQL transactions. No ambient account selection is permitted. */
export const make = Effect.fn("ProjectIssueComments.make")(function* (options: {
  readonly resolveCredential: (state: IssueRepositoryState) => Effect.Effect<
    {
      readonly cwd: string;
      readonly host: string;
      readonly accountNodeId: string;
      readonly credentialEpoch: string;
      readonly token: Redacted.Redacted<string>;
    },
    IssueCommentsError
  >;
}) {
  const sql = yield* SqlClient.SqlClient;
  const client = yield* GitHubIssueClient;
  const scope = yield* Effect.scope;
  const admission = yield* Semaphore.make(1);
  const serial = yield* Semaphore.make(1);
  const readers = new Set<Fiber.Fiber<IssueCommentsPage, IssueCommentsError>>();
  let stopped = false;
  const operation = Effect.fn("ProjectIssueComments.operation")(
    function* (input: typeof Input.Type) {
      const deadline = (yield* currentTime()) + 55000;
      const page = input.page ?? 1;
      const { fence, cached } = yield* sql.withTransaction(
        Effect.gen(function* () {
          const fence = yield* capture(sql, input);
          const rows =
            yield* sql`SELECT commit_sequence AS sequence,length(CAST(payload_json AS BLOB)) AS payloadBytes,CASE WHEN length(CAST(payload_json AS BLOB)) <= ${maxPageBytes} THEN payload_json ELSE NULL END AS payload FROM project_issue_page WHERE host=${fence.state.host} AND repository_node_id=${fence.state.repositoryNodeId} AND page_kind='comments' AND read_key=${fence.readKey} LIMIT 1`;
          let cached: typeof Snapshot.Type | undefined;
          if (rows[0] !== undefined) {
            const row = yield* decodeCacheRow(rows[0]).pipe(
              Effect.mapError(() => fail("invalid-storage")),
            );
            const snapshot = yield* decodeSnapshot(yield* boundedPayload(row, maxPageBytes)).pipe(
              Effect.mapError(() => fail("invalid-storage")),
            );
            cached = yield* validateSnapshot(fence, page, snapshot).pipe(
              Effect.mapError(() => fail("invalid-storage")),
            );
          }
          yield* beforeDeadline(deadline);
          return { fence, cached };
        }),
      );
      const credential = yield* decodeCredential(
        yield* options.resolveCredential(fence.state),
      ).pipe(Effect.mapError(() => fail("credential-mismatch")));
      if (
        credential.host !== fence.state.host ||
        credential.accountNodeId !== fence.state.accountNodeId ||
        credential.credentialEpoch !== fence.state.credentialEpoch
      )
        return yield* fail("credential-mismatch");
      yield* beforeDeadline(deadline);
      const response = yield* client
        .readCommentsPage({
          cwd: credential.cwd,
          account: {
            host: credential.host,
            nodeId: credential.accountNodeId,
            credentialFingerprint: credential.credentialEpoch,
          },
          repository: {
            host: fence.state.host,
            nodeId: fence.state.repositoryNodeId,
            nameWithOwner: fence.state.repositoryName,
          },
          issue: { nodeId: fence.issue.identity.issueNodeId, number: fence.issue.identity.number },
          expectedSourceRevision: fence.issue.sourceRevision,
          page,
          pageSize: 25,
          ...(cached?.etag === null || cached?.etag === undefined ? {} : { etag: cached.etag }),
        })
        .pipe(
          Effect.provideService(GitHubCli.PinnedGitHubCredential, {
            host: credential.host,
            credentialFingerprint: credential.credentialEpoch,
            token: credential.token,
          }),
          Effect.mapError(
            (error) =>
              new IssueCommentsError({
                reason: "github",
                githubReason: error.reason,
                ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
              }),
          ),
        );
      if (
        response.repository.host !== fence.state.host ||
        response.repository.nodeId !== fence.state.repositoryNodeId ||
        response.repository.nameWithOwner !== fence.state.repositoryName
      )
        return yield* fail("invalid-response");
      const now = yield* currentTime();
      const observedAt = DateTime.formatIso(DateTime.makeUnsafe(now)).replace(/\.\d{3}Z$/u, "Z");
      let snapshot: typeof Snapshot.Type;
      if (response.status === "not-modified") {
        if (
          cached === undefined ||
          cached.etag === null ||
          (response.etag !== null && !weaklyMatchesEtag(response.etag, cached.etag))
        )
          return yield* fail("invalid-response");
        snapshot = { ...cached, observedAt };
      } else {
        const entries = new Map<string, typeof Comment.Type>();
        for (const raw of response.entries) {
          const entry = yield* decodeComment(raw).pipe(
            Effect.mapError(() => fail("invalid-response")),
          );
          const prior = entries.get(entry.nodeId);
          if (
            prior !== undefined &&
            prior.updatedAt === entry.updatedAt &&
            canonicalProjectWorkPayload(prior) !== canonicalProjectWorkPayload(entry)
          )
            return yield* fail("invalid-response");
          if (prior === undefined || prior.updatedAt < entry.updatedAt)
            entries.set(entry.nodeId, entry);
        }
        snapshot = {
          readKey: fence.readKey,
          entries: [...entries.values()],
          nextPage: response.nextPage,
          rawEntryCount: response.rawEntryCount,
          etag: response.etag,
          observedAt,
        };
      }
      snapshot = yield* validateSnapshot(fence, page, snapshot);
      const payload = yield* encodeSnapshot(snapshot).pipe(
        Effect.mapError(() => fail("invalid-response")),
      );
      if (new TextEncoder().encode(payload).byteLength > maxPageBytes)
        return yield* fail("payload-too-large");
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (stopped) return yield* fail("stopped");
          const current = yield* capture(sql, input);
          if (!sameFence(fence, current)) return yield* fail("stale-authority");
          yield* beforeDeadline(deadline);
          yield* sql`DELETE FROM project_issue_page WHERE host=${fence.state.host} AND repository_node_id=${fence.state.repositoryNodeId} AND page_kind='comments' AND read_key=${fence.readKey}`;
          const receipt =
            yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${fence.state.host},${fence.state.repositoryNodeId},${fence.readKey},'comments',${payload}) RETURNING commit_sequence AS sequence`;
          yield* decodeSequence(receipt[0]).pipe(Effect.mapError(() => fail("invalid-storage")));
          yield* sql`DELETE FROM project_issue_page WHERE commit_sequence IN (SELECT commit_sequence FROM project_issue_page WHERE host=${fence.state.host} AND repository_node_id=${fence.state.repositoryNodeId} AND page_kind='comments' ORDER BY commit_sequence DESC LIMIT -1 OFFSET 64)`;
          const final = yield* capture(sql, input);
          if (!sameFence(fence, final)) return yield* fail("stale-authority");
          yield* beforeDeadline(deadline);
        }),
      );
      if (stopped) return yield* fail("stopped");
      yield* beforeDeadline(deadline);
      return {
        projectId: input.projectId,
        issueRecordId: input.issueRecordId,
        issueRevision: fence.issue.revision,
        sourceRevision: fence.issue.sourceRevision,
        page,
        entries: snapshot.entries,
        nextPage: snapshot.nextPage,
        observedAt: snapshot.observedAt,
      };
    },
    Effect.catchTag("SqlError", () => fail("storage")),
    Effect.timeoutOrElse({ duration: "55 seconds", orElse: () => fail("deadline") }),
  );
  const stop = Effect.uninterruptible(
    Effect.gen(function* () {
      const active = yield* admission.withPermit(
        Effect.sync(() => {
          stopped = true;
          return [...readers];
        }),
      );
      yield* Fiber.interruptAll(active);
    }),
  );
  yield* Effect.addFinalizer(() => stop);
  const read: ProjectIssueComments["Service"]["read"] = Effect.fn("ProjectIssueComments.read")(
    function* (raw) {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* fail("invalid-input");
      const input = yield* decodeInput(raw).pipe(Effect.mapError(() => fail("invalid-input")));
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const fiber = yield* admission.withPermit(
            Effect.gen(function* () {
              if (stopped) return yield* fail("stopped");
              if (readers.size >= 32) return yield* fail("busy");
              const fiber = yield* serial.withPermit(operation(input)).pipe(Effect.forkIn(scope));
              readers.add(fiber);
              return fiber;
            }),
          );
          return yield* restore(Fiber.join(fiber)).pipe(
            Effect.ensuring(Fiber.interrupt(fiber)),
            Effect.ensuring(
              Effect.sync(() => {
                readers.delete(fiber);
              }),
            ),
          );
        }),
      );
    },
  );
  return ProjectIssueComments.of({ read, stop });
});
