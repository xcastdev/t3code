import {
  canonicalProjectWorkPayload,
  ProjectWorkPublicationRequest,
  ProjectWorkPublicationOutcome,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as GitHubCli from "../../sourceControl/GitHubCli.ts";

export interface PublicationCredential {
  readonly cwd: string;
  readonly host: string;
  readonly repositoryNodeId: string;
  readonly headRepositoryNodeId: string;
  readonly credentialFingerprint: string;
  readonly token: Redacted.Redacted<string>;
}
export class PublicationError extends Schema.TaggedError<PublicationError>()("PublicationError", {
  reason: Schema.Literals([
    "authorization-denied",
    "credential-mismatch",
    "invalid-request",
    "operation-missing",
    "invalid-state",
    "persistence",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
type Request = typeof ProjectWorkPublicationRequest.Type;
type Outcome = typeof ProjectWorkPublicationOutcome.Type;
type Reason = Extract<Outcome, { kind: "uncertain" }>["reason"];
const markerPrefix = "<!-- t3-project-work-publication:";
export const publicationMarker = (request: Request) => `${markerPrefix}v1:${request.marker} -->`;
export const publicationRequestHash = (request: Request) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(request)).digest("hex");
const isRequest = Schema.is(
  ProjectWorkPublicationRequest.check(
    Schema.makeFilter((request) =>
      [
        request.operationId,
        request.marker,
        request.title,
        request.repository.host,
        request.repository.nodeId,
        request.repository.nameWithOwner,
        request.target.projectId,
        request.target.taskId,
        request.target.scopeHash,
        request.target.baseSha,
        request.target.headSha,
        request.target.baseRef,
        request.target.headRef,
        request.target.headRepositoryNodeId,
        request.target.headSelector,
        ...(request.threadId === undefined ? [] : [request.threadId]),
        ...request.authorizationRecordIds,
      ].every((value) => value.length > 0 && value === value.trim()),
    ),
  ),
);
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProjectWorkPublicationRequest),
);
/** Validate original values before encoding; never repair a caller's envelope by trimming. */
export const validatePublicationRequest = (request: Request) =>
  isRequest(request) &&
  canonicalProjectWorkPayload(request).length <= 32_000 &&
  !request.body.includes(markerPrefix);
export const capturePublicationRequest = (input: Request): Request | undefined => {
  if (!validatePublicationRequest(input)) return undefined;
  let request: Request;
  try {
    request = decodeRequest(canonicalProjectWorkPayload(input));
  } catch {
    return undefined;
  }
  return Object.freeze({
    ...request,
    repository: Object.freeze(request.repository),
    target: Object.freeze(request.target),
    authorizationRecordIds: Object.freeze([...request.authorizationRecordIds]),
  });
};
const captureCredential = (credential: PublicationCredential) => Object.freeze({ ...credential });
const Text = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_000),
  Schema.makeFilter((value) => value === value.trim()),
);
const Repository = Schema.Struct({ node_id: Text, full_name: Text });
const PullRequest = Schema.Struct({
  node_id: Text,
  number: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  html_url: Text,
  state: Schema.Literals(["open", "closed"]),
  merged_at: Schema.NullOr(Text),
  body: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128_000))),
  base: Schema.Struct({ sha: Text, ref: Text, repo: Schema.NullOr(Repository) }),
  head: Schema.Struct({
    sha: Text,
    ref: Text,
    repo: Schema.NullOr(Schema.Struct({ node_id: Text })),
  }),
});
const decodeRepository = Schema.decodeUnknownEffect(Schema.fromJsonString(Repository));
const decodePage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(PullRequest).check(Schema.isMaxLength(100))),
);
const RefRepository = Schema.Struct({
  id: Text,
  nameWithOwner: Text,
  ref: Schema.NullOr(
    Schema.Struct({ name: Text, target: Schema.NullOr(Schema.Struct({ oid: Text })) }),
  ),
});
const decodeRefs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.NullOr(
        Schema.Struct({ base: Schema.NullOr(RefRepository), head: Schema.NullOr(RefRepository) }),
      ),
      errors: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    }),
  ),
);
const refsQuery =
  "query PublicationRefs($baseId:ID!,$headId:ID!,$baseRef:String!,$headRef:String!){base:node(id:$baseId){... on Repository{id nameWithOwner ref(qualifiedName:$baseRef){name target{... on Commit{oid}}}}}head:node(id:$headId){... on Repository{id nameWithOwner ref(qualifiedName:$headRef){name target{... on Commit{oid}}}}}}";
const isOutcome = Schema.is(ProjectWorkPublicationOutcome);
const MAX_PAGES = 10;

export const make = Effect.fn("ProjectWorkGitHubOutbox.make")(function* () {
  const gh = yield* GitHubCli.GitHubCli;
  const check = (request: Request, credential: PublicationCredential, claimGeneration: number) => {
    if (
      !validatePublicationRequest(request) ||
      !Number.isSafeInteger(claimGeneration) ||
      claimGeneration < 1
    )
      return Effect.fail(new PublicationError({ reason: "invalid-request" }));
    if (
      credential.host !== request.repository.host ||
      credential.repositoryNodeId !== request.repository.nodeId ||
      credential.headRepositoryNodeId !== request.target.headRepositoryNodeId ||
      credential.cwd.trim().length === 0 ||
      credential.credentialFingerprint.trim().length === 0 ||
      !Redacted.isRedacted(credential.token)
    )
      return Effect.fail(new PublicationError({ reason: "credential-mismatch" }));
    return Effect.void;
  };
  const request = (
    input: Request,
    credential: PublicationCredential,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) =>
    gh
      .execute({
        cwd: credential.cwd,
        args: [
          "api",
          "--hostname",
          input.repository.host,
          ...args,
          ...(stdin === undefined ? [] : ["--input", "-"]),
        ],
        ...(stdin === undefined ? {} : { stdin }),
        maxOutputBytes: 1024 * 1024,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.provideService(GitHubCli.PinnedGitHubCredential, {
          host: credential.host,
          credentialFingerprint: credential.credentialFingerprint,
          token: credential.token,
        }),
      );
  const outcomeFields = Effect.fn("ProjectWorkGitHubOutbox.outcomeFields")(function* (
    input: Request,
    claimGeneration: number,
  ) {
    return {
      version: 1 as const,
      operationId: input.operationId,
      requestHash: publicationRequestHash(input),
      claimGeneration,
      observedAt: DateTime.formatIso(yield* DateTime.now),
    };
  });
  const uncertain = Effect.fn("ProjectWorkGitHubOutbox.uncertain")(function* (
    input: Request,
    claimGeneration: number,
    reason: Reason,
  ) {
    return {
      ...(yield* outcomeFields(input, claimGeneration)),
      kind: "uncertain" as const,
      reason,
    };
  });
  const scan = Effect.fn("ProjectWorkGitHubOutbox.scan")(function* (
    input: Request,
    credential: PublicationCredential,
  ) {
    const repo = yield* request(input, credential, [
      "--method",
      "GET",
      `repos/${input.repository.nameWithOwner}`,
    ]);
    if (repo.exitCode !== 0 || repo.stdoutTruncated || repo.stdoutInvalidUtf8)
      return { reason: "incomplete-response" as const };
    const repository = yield* decodeRepository(repo.stdout).pipe(Effect.result);
    if (repository._tag === "Failure") return { reason: "incomplete-response" as const };
    if (
      repository.success.node_id !== input.repository.nodeId ||
      repository.success.full_name !== input.repository.nameWithOwner
    )
      return { reason: "changed-identity" as const };
    const matches: Array<typeof PullRequest.Type> = [];
    let occupied = false;
    const marker = publicationMarker(input);
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = yield* request(input, credential, [
        "--method",
        "GET",
        `repos/${input.repository.nameWithOwner}/pulls?state=all&per_page=100&page=${page}`,
      ]);
      if (response.exitCode !== 0 || response.stdoutTruncated || response.stdoutInvalidUtf8)
        return { reason: "incomplete-response" as const };
      const decoded = yield* decodePage(response.stdout).pipe(Effect.result);
      if (decoded._tag === "Failure") return { reason: "incomplete-response" as const };
      for (const pr of decoded.success) {
        if (pr.body?.includes(marker)) {
          if (pr.body.split(marker).length !== 2) return { reason: "ambiguous-match" as const };
          matches.push(pr);
        } else if (
          pr.state === "open" &&
          pr.head.repo?.node_id === input.target.headRepositoryNodeId &&
          pr.head.ref === input.target.headRef &&
          pr.base.ref === input.target.baseRef
        )
          occupied = true;
      }
      if (decoded.success.length < 100) return { matches, occupied };
    }
    return { reason: "incomplete-response" as const };
  });
  const reconcile = Effect.fn("ProjectWorkGitHubOutbox.reconcile")(function* (
    raw: Request,
    rawCredential: PublicationCredential,
    claimGeneration: number,
  ): Effect.fn.Return<Outcome, PublicationError> {
    const input = capturePublicationRequest(raw);
    const credential = captureCredential(rawCredential);
    if (input === undefined) return yield* new PublicationError({ reason: "invalid-request" });
    yield* check(input, credential, claimGeneration);
    const result = yield* scan(input, credential).pipe(Effect.result);
    if (result._tag === "Failure")
      return yield* uncertain(input, claimGeneration, "incomplete-response");
    if ("reason" in result.success)
      return yield* uncertain(input, claimGeneration, result.success.reason);
    if (result.success.matches.length === 0)
      return yield* uncertain(
        input,
        claimGeneration,
        result.success.occupied ? "changed-identity" : "missing-match",
      );
    if (result.success.matches.length !== 1)
      return yield* uncertain(input, claimGeneration, "ambiguous-match");
    const pr = result.success.matches[0]!;
    if (
      pr.base.repo?.node_id !== input.repository.nodeId ||
      pr.base.repo.full_name !== input.repository.nameWithOwner ||
      pr.head.repo?.node_id !== input.target.headRepositoryNodeId ||
      pr.base.sha !== input.target.baseSha ||
      pr.head.sha !== input.target.headSha ||
      pr.base.ref !== input.target.baseRef ||
      pr.head.ref !== input.target.headRef ||
      pr.html_url !==
        `https://${input.repository.host}/${input.repository.nameWithOwner}/pull/${pr.number}` ||
      (pr.merged_at !== null &&
        (pr.state !== "closed" || DateTime.make(pr.merged_at)._tag === "None"))
    )
      return yield* uncertain(input, claimGeneration, "changed-identity");
    const confirmed: Outcome = {
      ...(yield* outcomeFields(input, claimGeneration)),
      kind: "confirmed",
      marker: input.marker,
      repository: input.repository,
      pullRequest: {
        nodeId: pr.node_id,
        number: pr.number,
        url: pr.html_url,
        state: pr.merged_at !== null ? "MERGED" : pr.state === "open" ? "OPEN" : "CLOSED",
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
        headRepositoryNodeId: pr.head.repo.node_id,
      },
    };
    if (!isOutcome(confirmed) || canonicalProjectWorkPayload(confirmed).length > 4_000)
      return yield* uncertain(input, claimGeneration, "incomplete-response");
    return confirmed;
  });
  const create = Effect.fn("ProjectWorkGitHubOutbox.create")(function* (
    raw: Request,
    rawCredential: PublicationCredential,
    claimGeneration: number,
  ): Effect.fn.Return<Outcome, PublicationError> {
    const input = capturePublicationRequest(raw);
    const credential = captureCredential(rawCredential);
    if (input === undefined) return yield* new PublicationError({ reason: "invalid-request" });
    const prior = yield* reconcile(input, credential, claimGeneration);
    if (prior.kind === "confirmed" || prior.reason !== "missing-match") return prior;
    // A read query resolves fork identity by node ID, without guessing its repository name.
    // PR creation has no atomic head precondition; the final scan still proves the requested target.
    const refsResult = yield* request(input, credential, [
      "graphql",
      "-f",
      `query=${refsQuery}`,
      "-f",
      `baseId=${input.repository.nodeId}`,
      "-f",
      `headId=${input.target.headRepositoryNodeId}`,
      "-f",
      `baseRef=refs/heads/${input.target.baseRef}`,
      "-f",
      `headRef=refs/heads/${input.target.headRef}`,
    ]).pipe(Effect.result);
    if (
      refsResult._tag === "Failure" ||
      refsResult.success.exitCode !== 0 ||
      refsResult.success.stdoutTruncated ||
      refsResult.success.stdoutInvalidUtf8
    )
      return yield* uncertain(input, claimGeneration, "incomplete-response");
    const refs = yield* decodeRefs(refsResult.success.stdout).pipe(Effect.result);
    if (
      refs._tag === "Failure" ||
      (refs.success.errors !== undefined && refs.success.errors.length !== 0)
    )
      return yield* uncertain(input, claimGeneration, "incomplete-response");
    const base = refs.success.data?.base;
    const head = refs.success.data?.head;
    if (
      base?.id !== input.repository.nodeId ||
      base.nameWithOwner !== input.repository.nameWithOwner ||
      base.ref?.name !== input.target.baseRef ||
      base.ref.target?.oid !== input.target.baseSha ||
      head?.id !== input.target.headRepositoryNodeId ||
      head.ref?.name !== input.target.headRef ||
      head.ref.target?.oid !== input.target.headSha ||
      (input.target.headSelector !==
        `${head.nameWithOwner.split("/")[0]}:${input.target.headRef}` &&
        !(head.id === base.id && input.target.headSelector === input.target.headRef))
    )
      return yield* uncertain(input, claimGeneration, "changed-identity");
    const write = yield* request(
      input,
      credential,
      ["--method", "POST", `repos/${input.repository.nameWithOwner}/pulls`],
      canonicalProjectWorkPayload({
        base: input.target.baseRef,
        head: input.target.headSelector,
        title: input.title,
        body: `${input.body}\n\n${publicationMarker(input)}`,
      }),
    ).pipe(Effect.result);
    const confirmed = yield* reconcile(input, credential, claimGeneration);
    if (confirmed.kind === "confirmed") return confirmed;
    if (
      write._tag === "Failure" ||
      write.success.exitCode !== 0 ||
      write.success.stdoutTruncated ||
      write.success.stdoutInvalidUtf8
    )
      return yield* uncertain(input, claimGeneration, "interrupted-write");
    return confirmed;
  });
  return { reconcile, create };
});
