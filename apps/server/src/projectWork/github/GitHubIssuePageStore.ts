import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { readIssueRepositoryState } from "../ProjectIssueRepositoryState.ts";
import { acceptPage, type IssuePageSnapshot, type IssueSyncRequest } from "./GitHubIssueSync.ts";

const maxPayloadBytes = 2 * 1024 * 1024;
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
);
const Host = Text.check(
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
);
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
const Repository = Schema.Struct({
  host: Host,
  nodeId: Text,
  nameWithOwner: Text.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
});
const Account = Schema.Struct({ host: Host, nodeId: Text, credentialFingerprint: Text });
const Query = Schema.Struct({
  since: Timestamp,
  state: Schema.Literal("all"),
  sort: Schema.Literal("updated"),
  direction: Schema.Literal("asc"),
  pageSize: Schema.Literal(25),
});
const ReadKey = Schema.Struct({
  repository: Repository,
  account: Account,
  generation: Natural,
  query: Query,
  page: Page,
});
const Request = Schema.Struct({ ...ReadKey.fields, leaseId: Text });
const Issue = Schema.Struct({
  nodeId: Text,
  number: Positive,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  titleTruncated: Schema.Boolean,
  body: Schema.String.check(Schema.isMaxLength(32000)),
  bodyTruncated: Schema.Boolean,
  state: Schema.Literals(["open", "closed"]),
  updatedAt: Timestamp,
  closedAt: Schema.NullOr(Timestamp),
  url: Schema.String.check(Schema.isMaxLength(4096)),
  commentCount: Natural,
});
const Snapshot = Schema.Struct({
  ...ReadKey.fields,
  etag: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(?:W\/)?"[\x21\x23-\x7e]{0,512}"$/u))),
  entries: Schema.Array(Issue).check(Schema.isMaxLength(25)),
  nextPage: Schema.NullOr(Page),
  rawEntryCount: Natural.check(Schema.isLessThanOrEqualTo(25)),
});
const Row = Schema.Struct({
  host: Host,
  repositoryNodeId: Text,
  readKey: Schema.String.check(Schema.isMaxLength(20000)),
  pageKind: Schema.Literal("issues"),
  sequence: Positive,
  payloadBytes: Natural,
  payload: Schema.NullOr(Schema.String),
});
const decodeRequest = Schema.decodeUnknownEffect(Request);
const decodeSnapshot = Schema.decodeUnknownEffect(Snapshot);
const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));
const decodeRow = Schema.decodeUnknownEffect(Row);
const decodeSequence = Schema.decodeUnknownEffect(Schema.Struct({ sequence: Positive }));
const encodeKey = Schema.encodeEffect(Schema.fromJsonString(ReadKey));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Snapshot));

export class IssuePageStoreError extends Schema.TaggedError<IssuePageStoreError>()(
  "IssuePageStoreError",
  {
    reason: Schema.Literals([
      "invalid-request",
      "invalid-snapshot",
      "invalid-storage",
      "payload-too-large",
      "stale-authority",
      "transaction-required",
      "storage",
    ]),
  },
) {}
const fail = (reason: IssuePageStoreError["reason"]) => new IssuePageStoreError({ reason });
const requestKey = Effect.fn("IssuePageStore.requestKey")(function* (request: IssueSyncRequest) {
  const validated = yield* decodeRequest(request).pipe(
    Effect.mapError(() => fail("invalid-request")),
  );
  if (validated.account.host !== validated.repository.host) return yield* fail("invalid-request");
  const readKey = yield* encodeKey({
    repository: validated.repository,
    account: validated.account,
    generation: validated.generation,
    query: validated.query,
    page: validated.page,
  }).pipe(Effect.mapError(() => fail("invalid-request")));
  return { request: validated, readKey };
});
const authority = Effect.fn("IssuePageStore.authority")(function* (
  sql: SqlClient.SqlClient,
  request: typeof Request.Type,
) {
  const state = yield* readIssueRepositoryState(sql, {
    host: request.repository.host,
    repositoryNodeId: request.repository.nodeId,
  }).pipe(Effect.mapError(() => fail("invalid-storage")));
  return state !== undefined &&
    state.status === "ready" &&
    state.repositoryName === request.repository.nameWithOwner &&
    state.accountNodeId === request.account.nodeId &&
    state.credentialEpoch === request.account.credentialFingerprint &&
    state.authorityGeneration === request.generation &&
    state.pageSize === request.query.pageSize
    ? state
    : undefined;
});
const validateSnapshot = Effect.fn("IssuePageStore.validateSnapshot")(function* (
  request: typeof Request.Type,
  input: unknown,
) {
  const snapshot = yield* decodeSnapshot(input).pipe(
    Effect.mapError(() => fail("invalid-snapshot")),
  );
  if (
    snapshot.account.host !== request.account.host ||
    snapshot.account.nodeId !== request.account.nodeId ||
    snapshot.account.credentialFingerprint !== request.account.credentialFingerprint ||
    snapshot.generation !== request.generation ||
    snapshot.page !== request.page ||
    snapshot.query.since !== request.query.since ||
    snapshot.query.pageSize !== request.query.pageSize ||
    snapshot.query.state !== request.query.state ||
    snapshot.query.sort !== request.query.sort ||
    snapshot.query.direction !== request.query.direction
  )
    return yield* fail("invalid-snapshot");
  const accepted = acceptPage({
    request,
    currentFence: request,
    observedAt: request.query.since,
    response: {
      status: "changed",
      repository: snapshot.repository,
      etag: snapshot.etag,
      entries: snapshot.entries,
      nextPage: snapshot.nextPage,
      rawEntryCount: snapshot.rawEntryCount,
    },
  });
  if (accepted.status !== "accepted") return yield* fail("invalid-snapshot");
  return snapshot;
});

/** Historical exact-key lookup only; the caller must claim fresh SQL authority before remote reads.
 * credentialFingerprint carries the server-minted opaque epoch, never a token or its digest.
 */
export const readCommittedIssuePage = Effect.fn("readCommittedIssuePage")(function* (
  sql: SqlClient.SqlClient,
  input: IssueSyncRequest,
) {
  const { request, readKey } = yield* requestKey(input);
  if ((yield* authority(sql, request)) === undefined) return undefined;
  const rows =
    yield* sql`SELECT host,repository_node_id AS repositoryNodeId,read_key AS readKey,page_kind AS pageKind,commit_sequence AS sequence,length(CAST(payload_json AS BLOB)) AS payloadBytes,CASE WHEN length(CAST(payload_json AS BLOB)) <= ${maxPayloadBytes} THEN payload_json ELSE NULL END AS payload FROM project_issue_page WHERE host=${request.repository.host} AND repository_node_id=${request.repository.nodeId} AND page_kind='issues' AND read_key=${readKey} LIMIT 1`.pipe(
      Effect.mapError(() => fail("storage")),
    );
  if (rows[0] === undefined) return undefined;
  const row = yield* decodeRow(rows[0]).pipe(Effect.mapError(() => fail("invalid-storage")));
  if (
    row.host !== request.repository.host ||
    row.repositoryNodeId !== request.repository.nodeId ||
    row.readKey !== readKey
  )
    return yield* fail("invalid-storage");
  if (row.payloadBytes > maxPayloadBytes) return yield* fail("payload-too-large");
  if (row.payload === null) return yield* fail("invalid-storage");
  const decoded = yield* decodePayload(row.payload).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  const snapshot = yield* validateSnapshot(request, decoded).pipe(
    Effect.mapError(() => fail("invalid-storage")),
  );
  return { ...snapshot, commitId: String(row.sequence) };
});

/** Joins the supplied client's transaction; never claims a lease or advances repository progress. */
export const writeCommittedIssuePage = Effect.fn("writeCommittedIssuePage")(function* (
  sql: SqlClient.SqlClient,
  input: IssueSyncRequest,
  inputSnapshot: IssuePageSnapshot,
) {
  if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
    return yield* fail("transaction-required");
  const { request, readKey } = yield* requestKey(input);
  const snapshot = yield* validateSnapshot(request, inputSnapshot);
  const payload = yield* encodeSnapshot(snapshot).pipe(
    Effect.mapError(() => fail("invalid-snapshot")),
  );
  if (new TextEncoder().encode(payload).byteLength > maxPayloadBytes)
    return yield* fail("payload-too-large");
  return yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const state = yield* authority(sql, request);
        const now = yield* Clock.currentTimeMillis;
        if (
          !Number.isSafeInteger(now) ||
          now < 0 ||
          state === undefined ||
          state.since !== request.query.since ||
          state.nextPage !== request.page ||
          state.lease === null ||
          state.lease.id !== request.leaseId ||
          state.lease.credentialEpoch !== request.account.credentialFingerprint ||
          state.lease.authorityGeneration !== request.generation ||
          state.lease.expiresAt <= now
        )
          return yield* fail("stale-authority");
        yield* sql`DELETE FROM project_issue_page WHERE host=${request.repository.host} AND repository_node_id=${request.repository.nodeId} AND page_kind='issues' AND read_key=${readKey}`.pipe(
          Effect.mapError(() => fail("storage")),
        );
        const rows =
          yield* sql`INSERT INTO project_issue_page(host,repository_node_id,read_key,page_kind,payload_json) VALUES(${request.repository.host},${request.repository.nodeId},${readKey},'issues',${payload}) RETURNING commit_sequence AS sequence`.pipe(
            Effect.mapError(() => fail("storage")),
          );
        const sequence = yield* decodeSequence(rows[0]).pipe(
          Effect.mapError(() => fail("invalid-storage")),
        );
        yield* sql`DELETE FROM project_issue_page WHERE commit_sequence IN (SELECT commit_sequence FROM project_issue_page WHERE host=${request.repository.host} AND repository_node_id=${request.repository.nodeId} AND page_kind='issues' ORDER BY commit_sequence DESC LIMIT -1 OFFSET 64)`.pipe(
          Effect.mapError(() => fail("storage")),
        );
        return { ...snapshot, commitId: String(sequence.sequence) };
      }),
    )
    .pipe(Effect.catchTag("SqlError", () => fail("storage")));
});

export type CommittedIssuePage = Effect.Success<ReturnType<typeof writeCommittedIssuePage>>;
