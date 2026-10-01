import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024));
const Host = Text.check(
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
);
const RepositoryName = Text.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u));
const Natural = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Positive = Natural.check(Schema.isGreaterThanOrEqualTo(1));
const Page = Positive.check(Schema.isLessThanOrEqualTo(10_000));
const Etag = Schema.String.check(Schema.isPattern(/^(?:W\/)?"[\x21\x23-\x7e]{0,512}"$/u));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value.replace("Z", ".000Z")
    );
  }),
);
const Repository = Schema.Struct({ host: Host, nodeId: Text, nameWithOwner: RepositoryName });
const Account = Schema.Struct({ host: Host, nodeId: Text, credentialFingerprint: Text });
const Query = Schema.Struct({
  since: Timestamp,
  pageSize: Positive.check(Schema.isLessThanOrEqualTo(100)),
  state: Schema.Literal("all"),
  sort: Schema.Literal("updated"),
  direction: Schema.Literal("asc"),
});
const Fence = Schema.Struct({ generation: Natural, leaseId: Text });
const Request = Schema.Struct({
  repository: Repository,
  account: Account,
  query: Query,
  ...Fence.fields,
  page: Page,
});
export type IssueSyncRequest = typeof Request.Type;
const Issue = Schema.Struct({
  nodeId: Text,
  number: Positive,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  titleTruncated: Schema.Boolean,
  body: Schema.String.check(Schema.isMaxLength(32_000)),
  bodyTruncated: Schema.Boolean,
  state: Schema.Literals(["open", "closed"]),
  updatedAt: Timestamp,
  closedAt: Schema.NullOr(Timestamp),
  url: Schema.String.check(Schema.isMaxLength(4096)),
  commentCount: Natural,
});
const PageData = {
  repository: Repository,
  etag: Schema.NullOr(Etag),
  entries: Schema.Array(Issue).check(Schema.isMaxLength(100)),
  nextPage: Schema.NullOr(Page),
  rawEntryCount: Natural.check(Schema.isLessThanOrEqualTo(100)),
};
const Snapshot = Schema.Struct({
  ...PageData,
  account: Account,
  query: Query,
  page: Page,
  generation: Natural,
});
export type IssuePageSnapshot = typeof Snapshot.Type;
const CommittedSnapshot = Schema.Struct({ ...Snapshot.fields, commitId: Text });
const PlanningInput = Schema.Struct({
  request: Request,
  currentFence: Fence,
  priorCommittedSnapshot: Schema.optionalKey(CommittedSnapshot),
});
const AcceptanceInput = Schema.Struct({
  ...PlanningInput.fields,
  observedAt: Timestamp,
  sentEtag: Schema.optionalKey(Etag),
  response: Schema.Union([
    Schema.Struct({ status: Schema.Literal("changed"), ...PageData }),
    Schema.Struct({
      status: Schema.Literal("not-modified"),
      repository: Repository,
      etag: Schema.NullOr(Etag),
    }),
  ]),
});
const decodePlanning = Schema.decodeUnknownOption(PlanningInput);
const decodeAcceptance = Schema.decodeUnknownOption(AcceptanceInput);
type Rejection = {
  readonly status: "rejected";
  readonly reason:
    | "invalid-input"
    | "stale-fence"
    | "invalid-page"
    | "snapshot-mismatch"
    | "account-mismatch";
};
const reject = (reason: Rejection["reason"]): Rejection => ({ status: "rejected", reason });
const current = (request: IssueSyncRequest, fence: typeof Fence.Type) =>
  request.generation === fence.generation && request.leaseId === fence.leaseId;
const sameRead = (request: IssueSyncRequest, snapshot: IssuePageSnapshot) =>
  request.repository.host === snapshot.repository.host &&
  request.repository.nodeId === snapshot.repository.nodeId &&
  request.repository.nameWithOwner === snapshot.repository.nameWithOwner &&
  request.account.host === snapshot.account.host &&
  request.account.nodeId === snapshot.account.nodeId &&
  request.account.credentialFingerprint === snapshot.account.credentialFingerprint &&
  request.generation === snapshot.generation &&
  request.page === snapshot.page &&
  request.query.since === snapshot.query.since &&
  request.query.pageSize === snapshot.query.pageSize &&
  request.query.state === snapshot.query.state &&
  request.query.sort === snapshot.query.sort &&
  request.query.direction === snapshot.query.direction;
const switchedAccount = (request: IssueSyncRequest, snapshot: IssuePageSnapshot | undefined) =>
  snapshot !== undefined &&
  request.repository.host === snapshot.repository.host &&
  request.repository.nodeId === snapshot.repository.nodeId &&
  request.account.nodeId !== snapshot.account.nodeId;
const validPage = (page: IssuePageSnapshot) => {
  if (
    page.account.host !== page.repository.host ||
    page.rawEntryCount > page.query.pageSize ||
    page.entries.length > page.rawEntryCount ||
    (page.nextPage !== null && (page.nextPage !== page.page + 1 || page.rawEntryCount === 0))
  )
    return false;
  const nodes = new Set<string>();
  const numbers = new Set<number>();
  for (const entry of page.entries) {
    if (
      nodes.has(entry.nodeId) ||
      numbers.has(entry.number) ||
      entry.url !==
        `https://${page.repository.host}/${page.repository.nameWithOwner}/issues/${entry.number}`
    )
      return false;
    nodes.add(entry.nodeId);
    numbers.add(entry.number);
  }
  return true;
};

/** Pure planning only. The caller supplies a snapshot read from a committed atomic page transaction. */
export const planPage = (
  input: unknown,
):
  | Rejection
  | { readonly status: "ready"; readonly request: IssueSyncRequest; readonly etag?: string } => {
  const decoded = decodePlanning(input);
  if (Option.isNone(decoded)) return reject("invalid-input");
  const { request, currentFence, priorCommittedSnapshot } = decoded.value;
  if (!current(request, currentFence)) return reject("stale-fence");
  if (switchedAccount(request, priorCommittedSnapshot)) return reject("account-mismatch");
  if (
    request.account.host !== request.repository.host ||
    (priorCommittedSnapshot !== undefined && !validPage(priorCommittedSnapshot))
  )
    return reject("invalid-input");
  return {
    status: "ready",
    request,
    ...(priorCommittedSnapshot !== undefined &&
    sameRead(request, priorCommittedSnapshot) &&
    priorCommittedSnapshot.etag !== null
      ? { etag: priorCommittedSnapshot.etag }
      : {}),
  };
};

/** Return the page and progress together; this function cannot commit either or establish a durable lease. */
export const acceptPage = (
  input: unknown,
):
  | Rejection
  | {
      readonly status: "accepted";
      readonly snapshot: IssuePageSnapshot;
      readonly progress: {
        readonly overlapSince: string;
        readonly nextPage: number | null;
        readonly lastSuccessfulPageAt: string;
      };
    } => {
  const decoded = decodeAcceptance(input);
  if (Option.isNone(decoded)) return reject("invalid-input");
  const { request, currentFence, response, priorCommittedSnapshot, observedAt, sentEtag } =
    decoded.value;
  if (!current(request, currentFence)) return reject("stale-fence");
  if (switchedAccount(request, priorCommittedSnapshot)) return reject("account-mismatch");
  if (
    request.account.host !== request.repository.host ||
    response.repository.host !== request.repository.host ||
    response.repository.nodeId !== request.repository.nodeId
  )
    return reject("invalid-page");
  let snapshot: IssuePageSnapshot;
  if (response.status === "not-modified") {
    if (
      priorCommittedSnapshot === undefined ||
      !sameRead(request, priorCommittedSnapshot) ||
      priorCommittedSnapshot.etag === null ||
      sentEtag !== priorCommittedSnapshot.etag ||
      (response.etag !== null && response.etag !== priorCommittedSnapshot.etag) ||
      response.repository.nameWithOwner !== request.repository.nameWithOwner
    )
      return reject("snapshot-mismatch");
    const { commitId: _commitId, ...prior } = priorCommittedSnapshot;
    snapshot = prior;
  } else {
    snapshot = {
      repository: response.repository,
      account: request.account,
      query: request.query,
      page: request.page,
      generation: request.generation,
      etag: response.etag,
      entries: response.entries,
      nextPage: response.nextPage,
      rawEntryCount: response.rawEntryCount,
    };
  }
  if (!validPage(snapshot)) return reject("invalid-page");
  return {
    status: "accepted",
    snapshot,
    // A partial/PR-only page never advances the reconciliation window.
    progress: {
      overlapSince: request.query.since,
      nextPage: snapshot.nextPage,
      lastSuccessfulPageAt: observedAt,
    },
  };
};
