import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  GitCommandError,
  ProjectVerificationJobManifest,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
  type ProjectTeamDispatchSnapshot,
  type ProjectTeamDispatchStageReceipt,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewCompletionProposals } from "./ProjectTeamReviewCompletionProposals.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";

const strict = { onExcessProperty: "error" } as const;
const canonical = canonicalProjectWorkPayload;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Options = Schema.Struct({ environmentId: Id });
const Snapshot = Schema.Struct({
  fence: Schema.Struct({
    dispatchId: Id,
    revision: Safe,
    claimGeneration: Safe,
    stage: Schema.Literals([
      "reserved",
      "workspace-ready",
      "setup-complete",
      "session-bound",
      "assignment-intent",
      "assignment-observed",
      "stopping",
      "quarantine",
      "settled",
    ]),
  }),
  intent: Schema.JsonObject,
}).check(Schema.makeFilter((value) => Buffer.byteLength(canonical(value)) <= 262144));
const Join = Schema.Struct({
  receiptId: Id,
  stage: Schema.Literal("settled"),
  evidence: Schema.JsonObject,
}).check(Schema.makeFilter((value) => Buffer.byteLength(canonical(value)) <= 262144));
const Assertion = Schema.Struct({ snapshot: Snapshot, jobId: Id, manifestHash: Digest });
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot, strict);
const decodeJoin = Schema.decodeUnknownSync(Join, strict);
const decodeAssertion = Schema.decodeUnknownSync(Assertion, strict);
const decodeJob = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectVerificationJobManifest),
  strict,
);
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
  strict,
);
const capture = <A>(input: A, decode: (input: unknown) => unknown): A => {
  const owned: A = structuredClone(input);
  if (!same(owned, decode(owned))) throw new Error("Current target input changed during decoding");
  return owned;
};
export class ProjectTeamReviewCurrentTargetError extends Schema.TaggedError<ProjectTeamReviewCurrentTargetError>()(
  "ProjectTeamReviewCurrentTargetError",
  {
    reason: Schema.Literals(["invalid-input", "inherited-transaction", "unavailable", "changed"]),
    detail: Schema.String.check(Schema.isMaxLength(4096)),
  },
) {}
const fail = (reason: ProjectTeamReviewCurrentTargetError["reason"], detail: string) =>
  new ProjectTeamReviewCurrentTargetError({ reason, detail });

class CurrentTargetLoan extends Context.Service<CurrentTargetLoan, { readonly token: symbol }>()(
  "t3/projectWork/ProjectTeamReviewCurrentTarget/CurrentTargetLoan",
) {}

/** Borrow the original host target without creating a workspace, running verification or granting parent progress. */
export const makeProjectTeamReviewCurrentTarget = (rawOptions: typeof Options.Type) => {
  let options: typeof Options.Type;
  try {
    options = capture(rawOptions, decodeOptions);
  } catch {
    return Effect.fail(fail("invalid-input", "Invalid current target options"));
  }
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const workflow = yield* Effect.serviceOption(GitWorkflowService);
    const pi = yield* Effect.serviceOption(ProjectTeamPiRuntime);
    const filesystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    const spawner = yield* Effect.serviceOption(ChildProcessSpawner.ChildProcessSpawner);
    const platform = yield* HostProcessPlatform;
    const journal = yield* makeProjectTeamDispatchJournal({
      environmentId: options.environmentId,
      maximumEnvironmentModelCalls: 128,
    });
    const proposals = yield* makeProjectTeamReviewCompletionProposals(() =>
      Effect.succeed(undefined),
    );
    const guard = (inTransaction: boolean) =>
      Effect.gen(function* () {
        const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
        const suppliedRepo = yield* Effect.serviceOption(ProjectWorkRepository);
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        if (
          Option.isNone(suppliedSql) ||
          suppliedSql.value !== sql ||
          Option.isNone(suppliedRepo) ||
          suppliedRepo.value !== repository
        )
          return yield* fail(
            "unavailable",
            "Current target requires its original SQL and repository",
          );
        if (Option.isSome(transaction) !== inTransaction)
          return yield* fail(
            "inherited-transaction",
            "Current target transaction ownership changed",
          );
      });
    const select = Effect.fn("ProjectTeamReviewCurrentTarget.select")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
      final = false,
    ) {
      const original = yield* journal.readRetained(snapshot.fence.dispatchId);
      yield* journal.readStageReceipts(snapshot.fence.dispatchId);
      if (!final && original.fence.stage === "settled") return undefined;
      if (
        !same(original.intent, snapshot.intent) ||
        original.fence.claimGeneration !== snapshot.fence.claimGeneration ||
        (!final && !same(original.fence, snapshot.fence))
      )
        return yield* fail("changed", "Original review dispatch changed");
      const claim = original.intent.compiledClaim.transition;
      if (claim?.kind !== "claim" || claim.binding.environmentId !== options.environmentId)
        return yield* fail("changed", "Original review environment changed");
      const rows = yield* sql<{
        command_id: string;
      }>`SELECT command_id FROM project_team_review_completion_proposal WHERE environment_id=${options.environmentId} AND assignment_operation_id=${original.intent.request.assignmentOperationId} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* fail("changed", "Original review proposal is ambiguous");
      const proposal = yield* proposals.readRetained({
        environmentId: options.environmentId,
        projectId: claim.binding.projectId,
        commandId: rows[0]!.command_id,
      });
      if (!proposal) return yield* fail("changed", "Original review proposal disappeared");
      const manifest = proposal.manifest;
      if (
        manifest.report.type !== "project-team.assignment.report" ||
        manifest.provenance.dispatchId !== original.fence.dispatchId ||
        manifest.operation.operationId !== original.intent.request.assignmentOperationId
      )
        return yield* fail("changed", "Original review proposal dispatch changed");
      if (manifest.report.criterionAssessments === undefined) return undefined;
      const jobs = yield* sql<{
        manifest_json: string | null;
        sha256: string;
      }>`SELECT CASE WHEN length(CAST(manifest_json AS BLOB))<=65536 THEN manifest_json END AS manifest_json,sha256 FROM project_work_verification_jobs WHERE environment_id=${options.environmentId} AND job_id=${manifest.prepared.jobId} AND project_id=${manifest.target.projectId} AND task_id=${manifest.target.taskId} LIMIT 2`;
      const row = jobs[0];
      if (jobs.length !== 1 || !row || typeof row.manifest_json !== "string")
        return yield* fail("changed", "Original prepared target is missing or oversized");
      const job = yield* decodeJob(row.manifest_json);
      if (
        canonical(job) !== row.manifest_json ||
        hash(job) !== row.sha256 ||
        row.sha256 !== manifest.prepared.sha256 ||
        job.environmentId !== options.environmentId ||
        job.jobId !== manifest.prepared.jobId ||
        job.projectId !== manifest.target.projectId ||
        job.taskId !== manifest.target.taskId ||
        job.specRevision !== manifest.target.specRevision ||
        job.planRevision !== manifest.target.planRevision ||
        job.target.baseSha !== manifest.target.baseSha ||
        job.target.headSha !== manifest.target.headSha
      )
        return yield* fail("changed", "Original prepared target identity changed");
      const implementation = yield* journal.readRetained(job.dispatchId);
      yield* journal.readStageReceipts(job.dispatchId);
      const implementationClaim = implementation.intent.compiledClaim.transition;
      if (
        implementation.fence.stage !== "settled" ||
        implementationClaim?.kind !== "claim" ||
        implementationClaim.binding.environmentId !== options.environmentId ||
        implementationClaim.binding.projectId !== job.projectId ||
        implementationClaim.binding.taskId !== job.taskId ||
        implementationClaim.binding.recordId !== job.bindingId ||
        implementationClaim.binding.generation !== job.generation
      )
        return yield* fail("changed", "Original implementation target changed");
      const workspaces = yield* sql<{
        receipt_json: string | null;
        assignment_json: string | null;
      }>`SELECT CASE WHEN length(CAST(receipt_json AS BLOB))<=262144 THEN receipt_json END AS receipt_json,CASE WHEN length(CAST(assignment_json AS BLOB))<=262144 THEN assignment_json END AS assignment_json FROM project_team_workspace_receipt WHERE dispatch_id=${job.dispatchId} AND environment_id=${options.environmentId} AND binding_id=${job.bindingId} AND generation=${job.generation} AND claim_generation=${implementation.fence.claimGeneration} LIMIT 2`;
      const workspace = workspaces[0];
      if (
        workspaces.length !== 1 ||
        !workspace ||
        typeof workspace.receipt_json !== "string" ||
        workspace.assignment_json !== canonical(implementation.intent.request.git)
      )
        return yield* fail("changed", "Original implementation workspace changed");
      const receipt = yield* decodeWorkspace(workspace.receipt_json);
      if (
        !same(receipt.assignment, implementation.intent.request.git) ||
        hash(receipt) !== job.workspaceReceiptHash ||
        receipt.assignment.primaryRoot !== job.target.repository ||
        receipt.assignment.worktreePath !== job.target.worktree ||
        receipt.assignment.branchRef !== job.target.branchRef ||
        receipt.assignment.baseOid !== job.target.baseSha
      )
        return yield* fail("changed", "Original implementation workspace identity changed");
      return { proposal, job, implementation, receipt, binding: implementationClaim.binding };
    });
    type Selection = NonNullable<Effect.Success<ReturnType<typeof select>>>;
    const loans = new Map<
      symbol,
      {
        readonly selection: Selection;
        readonly snapshot: ProjectTeamDispatchSnapshot;
        readonly joined: ProjectTeamDispatchStageReceipt;
        readonly context: ManagedGit.ManagedGitExecution;
        readonly assertRuntime: Effect.Effect<void, GitCommandError>;
      }
    >();
    const loan = Effect.gen(function* () {
      yield* guard(true);
      const supplied = yield* Effect.serviceOption(CurrentTargetLoan);
      const owned = Option.isSome(supplied) ? loans.get(supplied.value.token) : undefined;
      if (!owned)
        return yield* fail("unavailable", "Current target requires its original live host loan");
      return owned;
    });
    const check = Effect.fn("ProjectTeamReviewCurrentTarget.check")(function* (
      owned: Effect.Success<typeof loan>,
    ) {
      const current = yield* select(owned.snapshot, true);
      if (!current || !same(current, owned.selection))
        return yield* fail("changed", "Retained original target changed during settlement");
      yield* owned.assertRuntime;
      yield* ManagedGit.withManagedVerificationTarget(owned.context, (target) => {
        const job = current.job;
        return target.cwd === job.target.worktree &&
          target.baseSha === job.target.baseSha &&
          target.headSha === job.target.headSha &&
          target.testedCommit === job.target.testedCommit &&
          target.testedTree === job.target.testedTree &&
          same(target.receipt, current.receipt)
          ? Effect.void
          : Effect.fail(fail("changed", "Current committed review target changed"));
      });
      yield* owned.assertRuntime;
      const after = yield* select(owned.snapshot, true);
      if (!after || !same(after, owned.selection))
        return yield* fail("changed", "Retained original target changed during native validation");
    });
    const assertInTransaction = (raw: {
      readonly snapshot: ProjectTeamDispatchSnapshot;
      readonly jobId: string;
      readonly manifestHash: string;
    }) => {
      let input: typeof raw;
      try {
        input = capture(raw, decodeAssertion);
      } catch {
        return Effect.fail(fail("invalid-input", "Invalid current target assertion"));
      }
      return Effect.gen(function* () {
        const owned = yield* loan;
        if (
          !same(input.snapshot, owned.snapshot) ||
          input.jobId !== owned.selection.job.jobId ||
          input.manifestHash !== owned.selection.proposal.manifest.prepared.sha256
        )
          return yield* fail("changed", "Current target assertion changed its original selection");
        yield* check(owned);
      });
    };
    const assertOriginalInTransaction = (
      rawSnapshot: ProjectTeamDispatchSnapshot,
      rawJoined: ProjectTeamDispatchStageReceipt,
    ) => {
      let snapshot: ProjectTeamDispatchSnapshot;
      let joined: ProjectTeamDispatchStageReceipt;
      try {
        snapshot = capture(rawSnapshot, decodeSnapshot);
        joined = capture(rawJoined, decodeJoin);
      } catch {
        return Effect.fail(fail("invalid-input", "Invalid final current target assertion"));
      }
      return Effect.gen(function* () {
        const owned = yield* loan;
        if (!same(snapshot, owned.snapshot) || !same(joined, owned.joined))
          return yield* fail(
            "changed",
            "Final current target assertion changed its original settlement",
          );
        yield* check(owned);
      });
    };
    const withOriginalTarget = <A, E, R>(
      rawSnapshot: ProjectTeamDispatchSnapshot,
      rawJoined: ProjectTeamDispatchStageReceipt,
      useSettlement: Effect.Effect<A, E, R>,
    ) => {
      let snapshot: ProjectTeamDispatchSnapshot;
      let joined: ProjectTeamDispatchStageReceipt;
      try {
        snapshot = capture(rawSnapshot, decodeSnapshot);
        joined = capture(rawJoined, decodeJoin);
      } catch {
        return Effect.fail(fail("invalid-input", "Invalid current target settlement"));
      }
      return Effect.gen(function* () {
        yield* guard(false);
        const selection = yield* sql.withTransaction(select(snapshot));
        if (selection === undefined) return yield* useSettlement;
        if (
          Option.isNone(workflow) ||
          Option.isNone(pi) ||
          Option.isNone(filesystem) ||
          Option.isNone(path) ||
          Option.isNone(spawner)
        )
          return yield* fail(
            "unavailable",
            "Original current-target host dependencies are unavailable",
          );
        const fs = filesystem.value;
        const paths = path.value;
        const processes = spawner.value;
        const hostPlatform = platform;
        return yield* workflow.value
          .withRepositoryPermit(
            "review.current-target",
            selection.receipt.assignment.primaryRoot,
            pi.value.withInstance(selection.binding.providerInstanceId, (instance) =>
              Effect.gen(function* () {
                const assertRuntime = instance.assertCurrent.pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        operation: "ProjectTeamReviewCurrentTarget",
                        command: "/usr/bin/git",
                        cwd: selection.job.target.worktree,
                        detail: "Original published Pi instance changed",
                        cause,
                      }),
                  ),
                );
                yield* assertRuntime;
                const context = yield* ManagedGit.make({
                  assignment: selection.implementation.intent.request.git,
                  priorReceipt: selection.receipt,
                  revalidate: assertRuntime,
                  persistWorkspace: () =>
                    Effect.fail(
                      new GitCommandError({
                        operation: "ProjectTeamReviewCurrentTarget",
                        command: "/usr/bin/git",
                        cwd: selection.job.target.worktree,
                        detail: "Review target cannot create a workspace",
                      }),
                    ),
                });
                const token = yield* Effect.acquireRelease(
                  Effect.sync(() => {
                    const token = Symbol("original-review-target");
                    loans.set(token, { selection, snapshot, joined, context, assertRuntime });
                    return token;
                  }),
                  (token) =>
                    Effect.sync(() => {
                      loans.delete(token);
                    }),
                );
                return yield* useSettlement.pipe(
                  Effect.provideService(CurrentTargetLoan, { token }),
                );
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, paths),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, processes),
                Effect.provideService(HostProcessPlatform, hostPlatform),
              ),
            ),
          )
          .pipe(Effect.scoped);
      });
    };
    return { withOriginalTarget, assertInTransaction, assertOriginalInTransaction };
  });
};

export class ProjectTeamReviewCurrentTarget extends Context.Service<
  ProjectTeamReviewCurrentTarget,
  Effect.Success<ReturnType<typeof makeProjectTeamReviewCurrentTarget>>
>()("t3/projectWork/ProjectTeamReviewCurrentTarget") {}
