import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  ProjectIssueIntake,
  type ProjectWorkCommand,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { mergeIssueObservation } from "./ProjectIssueIntake.ts";
import {
  commitIssueRepositoryRead,
  type IssueRepositoryLease,
  type IssueRepositoryState,
} from "./ProjectIssueRepositoryState.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";
import { acceptPage, type IssueSyncRequest } from "./github/GitHubIssueSync.ts";
import {
  readCommittedIssuePage,
  writeCommittedIssuePage,
  type CommittedIssuePage,
} from "./github/GitHubIssuePageStore.ts";

const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1024),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !/\p{Cc}/u.test(value)),
);
const Natural = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Natural.check(Schema.isGreaterThanOrEqualTo(1));
const Page = Positive.check(Schema.isLessThanOrEqualTo(10000));
const Timestamp = Text.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u),
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return (
      Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value.replace("Z", ".000Z")
    );
  }),
);
const Repository = Schema.Struct({
  host: Text.check(
    Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u),
  ),
  nodeId: Text,
  nameWithOwner: Text.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
});
const Etag = Schema.String.check(Schema.isPattern(/^(?:W\/)?"[\x21\x23-\x7e]{0,512}"$/u));
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
const Request = Schema.Struct({
  repository: Repository,
  account: Schema.Struct({
    host: Repository.fields.host,
    nodeId: Text,
    credentialFingerprint: Text,
  }),
  query: Schema.Struct({
    since: Timestamp,
    pageSize: Schema.Literal(25),
    state: Schema.Literal("all"),
    sort: Schema.Literal("updated"),
    direction: Schema.Literal("asc"),
  }),
  page: Page,
  generation: Natural,
  leaseId: Text,
});
const Lease = Schema.Struct({
  id: Text,
  expiresAt: Natural,
  authorityGeneration: Natural,
  credentialEpoch: Text,
  bindings: Schema.Array(
    Schema.Struct({ projectId: Text, revision: Natural, generation: Natural }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
const Input = Schema.Struct({
  request: Request,
  lease: Lease,
  nextSweepDelayMs: Schema.optionalKey(Positive.check(Schema.isLessThanOrEqualTo(3_600_000))),
  sentEtag: Schema.optionalKey(Etag),
  response: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("changed"),
      repository: Repository,
      etag: Schema.NullOr(Etag),
      entries: Schema.Array(Issue).check(Schema.isMaxLength(25)),
      nextPage: Schema.NullOr(Page),
      rawEntryCount: Natural.check(Schema.isLessThanOrEqualTo(25)),
    }),
    Schema.Struct({
      status: Schema.Literal("not-modified"),
      repository: Repository,
      etag: Schema.NullOr(Etag),
    }),
  ]),
});
const External = Schema.Struct({ repository: Repository, issue: Issue });
const ExternalRow = Schema.Struct({
  host: Text,
  repositoryNodeId: Text,
  issueNodeId: Text,
  issueNumber: Positive,
  sourceRevision: Timestamp,
  payloadBytes: Natural.check(Schema.isLessThanOrEqualTo(256 * 1024)),
  payload: Schema.String,
});
const decodeInput = Schema.decodeUnknownEffect(Input, { onExcessProperty: "error" });
const decodeRow = Schema.decodeUnknownEffect(ExternalRow);
const decodeExternal = Schema.decodeUnknownEffect(Schema.fromJsonString(External), {
  onExcessProperty: "error",
});
const encodeExternal = Schema.encodeEffect(Schema.fromJsonString(External));
const decodeIntake = Schema.decodeUnknownEffect(ProjectIssueIntake);
const seconds = (value: DateTime.Utc) => DateTime.formatIso(value).replace(/\.\d{3}Z$/u, "Z");
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");

export class IssueIntakeCommitError extends Schema.TaggedError<IssueIntakeCommitError>()(
  "IssueIntakeCommitError",
  {
    reason: Schema.Literals([
      "invalid-input",
      "request-mismatch",
      "invalid-page",
      "invalid-storage",
      "identity-conflict",
      "source-conflict",
      "detached",
    ]),
  },
) {}
const fail = (reason: IssueIntakeCommitError["reason"]) => new IssueIntakeCommitError({ reason });
const requestFromState = (current: IssueRepositoryState): IssueSyncRequest => ({
  repository: {
    host: current.host,
    nodeId: current.repositoryNodeId,
    nameWithOwner: current.repositoryName,
  },
  account: {
    host: current.host,
    nodeId: current.accountNodeId,
    credentialFingerprint: current.credentialEpoch,
  },
  query: {
    since: current.since,
    pageSize: current.pageSize,
    state: "all",
    sort: "updated",
    direction: "asc",
  },
  page: current.nextPage,
  generation: current.authorityGeneration,
  leaseId: current.lease!.id,
});

/** Private page commit only: the caller obtains remote data using a server-owned lease first. */
export const commitIssueRepositoryPage = Effect.fn("commitIssueRepositoryPage")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly request: IssueSyncRequest;
    readonly lease: IssueRepositoryLease;
    readonly response: unknown;
    readonly sentEtag?: string;
    readonly nextSweepDelayMs?: number;
  },
) {
  const validated = yield* decodeInput(input).pipe(Effect.mapError(() => fail("invalid-input")));
  let page: CommittedIssuePage | undefined;
  const result = yield* commitIssueRepositoryRead(
    sql,
    {
      host: validated.request.repository.host,
      repositoryNodeId: validated.request.repository.nodeId,
    },
    validated.lease,
    (current) =>
      Effect.gen(function* () {
        const request = requestFromState(current);
        if (canonicalProjectWorkPayload(request) !== canonicalProjectWorkPayload(validated.request))
          return yield* fail("request-mismatch");
        const observedAt = seconds(yield* DateTime.now);
        const prior = yield* readCommittedIssuePage(sql, request);
        const accepted = acceptPage({
          request,
          currentFence: { generation: current.authorityGeneration, leaseId: current.lease!.id },
          observedAt,
          response: validated.response,
          ...(prior === undefined ? {} : { priorCommittedSnapshot: prior }),
          ...(validated.sentEtag === undefined ? {} : { sentEtag: validated.sentEtag }),
        });
        if (accepted.status !== "accepted") return yield* fail("invalid-page");
        const { snapshot } = accepted;

        // Validate physical identities before replacing either cache or external observations.
        const observations: Array<typeof External.Type> = [];
        for (const issue of snapshot.entries) {
          const rows =
            yield* sql`SELECT host,repository_node_id AS repositoryNodeId,issue_node_id AS issueNodeId,issue_number AS issueNumber,source_revision AS sourceRevision,length(CAST(payload_json AS BLOB)) AS payloadBytes,CASE WHEN length(CAST(payload_json AS BLOB)) <= ${256 * 1024} THEN payload_json ELSE NULL END AS payload FROM project_issue_external WHERE host=${current.host} AND repository_node_id=${current.repositoryNodeId} AND (issue_node_id=${issue.nodeId} OR issue_number=${issue.number}) LIMIT 2`;
          if (rows.length > 1) return yield* fail("identity-conflict");
          const candidate = { repository: snapshot.repository, issue };
          if (rows[0] === undefined) {
            observations.push(candidate);
            continue;
          }
          const row = yield* decodeRow(rows[0]).pipe(
            Effect.mapError(() => fail("invalid-storage")),
          );
          const old = yield* decodeExternal(row.payload).pipe(
            Effect.mapError(() => fail("invalid-storage")),
          );
          if (
            row.host !== old.repository.host ||
            row.repositoryNodeId !== old.repository.nodeId ||
            row.issueNodeId !== old.issue.nodeId ||
            row.issueNumber !== old.issue.number ||
            row.sourceRevision !== old.issue.updatedAt ||
            old.issue.url !==
              `https://${old.repository.host}/${old.repository.nameWithOwner}/issues/${old.issue.number}`
          )
            return yield* fail("invalid-storage");
          if (row.issueNodeId !== issue.nodeId || row.issueNumber !== issue.number)
            return yield* fail("identity-conflict");
          if (issue.updatedAt < old.issue.updatedAt) {
            observations.push(old);
            continue;
          }
          if (issue.updatedAt === old.issue.updatedAt) {
            // Same-node rename changes only repository display name and its canonical issue URL.
            if (
              canonicalProjectWorkPayload({ ...issue, url: old.issue.url }) !==
              canonicalProjectWorkPayload(old.issue)
            )
              return yield* fail("source-conflict");
          }
          observations.push(candidate);
        }

        const commands: Array<ProjectWorkCommand> = [];
        for (const binding of current.lease!.bindings) {
          const state = yield* readCurrentState(sql, binding.projectId);
          const records: Array<ProjectIssueIntake> = [];
          const foundation = state.foundationRecords ?? [];
          for (const { repository, issue } of observations) {
            const matches = foundation.filter(
              (record) =>
                record.kind === "issue" &&
                record.identity.host === repository.host &&
                record.identity.repositoryNodeId === repository.nodeId &&
                (record.identity.issueNodeId === issue.nodeId ||
                  record.identity.number === issue.number),
            );
            if (matches.length > 1) return yield* fail("identity-conflict");
            const old =
              matches[0] === undefined
                ? undefined
                : yield* decodeIntake(matches[0]).pipe(
                    Effect.mapError(() => fail("invalid-storage")),
                  );
            const recordId =
              old?.recordId ??
              `github-issue-${hash([binding.projectId, repository.host, repository.nodeId, issue.nodeId])}`;
            if (foundation.some((record) => record.recordId === recordId && record !== matches[0]))
              return yield* fail("identity-conflict");
            const merged = mergeIssueObservation({
              projectId: binding.projectId,
              recordId,
              repository,
              issue,
              observedAt,
              ...(old === undefined ? {} : { existing: old }),
            });
            if (merged.status === "rejected")
              return yield* fail(
                merged.reason === "detached"
                  ? "detached"
                  : merged.reason === "source-conflict"
                    ? "source-conflict"
                    : "identity-conflict",
              );
            if (merged.status === "changed") records.push(merged.record);
          }
          if (records.length > 0)
            commands.push({
              type: "project-work.foundation.commit",
              projectId: ProjectId.make(binding.projectId),
              commandId: CommandId.make(
                `github-intake-${hash([request, validated.lease, binding.projectId])}`,
              ),
              expectedRevision: state.revision,
              attribution: {
                actor: { kind: "system", id: "github-intake" },
                source: { kind: "import", id: "github-intake" },
                recordedAt: observedAt,
              },
              records,
              committedAt: observedAt,
            });
        }
        page = yield* writeCommittedIssuePage(sql, request, snapshot);
        for (const observation of observations) {
          const payload = yield* encodeExternal(observation);
          if (new TextEncoder().encode(payload).byteLength > 256 * 1024)
            return yield* fail("invalid-storage");
          yield* sql`INSERT INTO project_issue_external(host,repository_node_id,issue_node_id,issue_number,source_revision,payload_json) VALUES(${observation.repository.host},${observation.repository.nodeId},${observation.issue.nodeId},${observation.issue.number},${observation.issue.updatedAt},${payload}) ON CONFLICT(host,repository_node_id,issue_node_id) DO UPDATE SET source_revision=excluded.source_revision,payload_json=excluded.payload_json`;
        }
        const terminal = accepted.progress.nextPage === null;
        const sweep =
          current.sweepStartedAt === null ? Option.none() : DateTime.make(current.sweepStartedAt);
        if (Option.isNone(sweep)) return yield* fail("invalid-storage");
        return {
          commands,
          progress: {
            since: terminal
              ? seconds(DateTime.subtract(sweep.value, { minutes: 5 }))
              : current.since,
            nextPage: accepted.progress.nextPage ?? 1,
            sweepStartedAt: terminal ? null : current.sweepStartedAt,
            lastSuccessfulPageAt: observedAt,
          },
        };
      }),
    validated.nextSweepDelayMs === undefined
      ? undefined
      : { nextSweepDelayMs: validated.nextSweepDelayMs },
  );
  // Neither a page sequence nor a project receipt is observable until the outer commit returns.
  return { ...result, ...(result.accepted && page !== undefined ? { page } : {}) };
});
