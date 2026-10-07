import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamIntegrationSourceRef,
  ProjectTeamIntegrationSourceRefs,
  ProjectTeamIntegrationSource,
  ProjectTeamIntegrationSources,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { staleSourceIndex } from "./ProjectTeamIntegrationSourceState.ts";
export { staleIntegrationTaskIds } from "./ProjectTeamIntegrationSourceState.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamCompletedReviewReader } from "./ProjectTeamReviewCompleted.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectWorkVerificationResultReader } from "./ProjectWorkVerificationExecutionJournal.ts";
import {
  projectTeamPlanHash,
  projectTeamScopeHash,
  projectTeamSpecificationHash,
} from "./ProjectTeamPolicy.ts";
import { indexReviewFindings, selectReviewFindings } from "./ProjectTeamReviewResolutionRecords.ts";

const strict = { onExcessProperty: "error" } as const;
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Options = Schema.Struct({ environmentId: EnvironmentId });
const Owner = { projectId: ProjectId, integrationTaskId: ProjectWorkTaskId };
const CompileInput = Schema.Struct({ ...Owner, refs: ProjectTeamIntegrationSourceRefs });
const CurrentInput = Schema.Struct({ ...Owner, sources: ProjectTeamIntegrationSources });
const PageInput = Schema.Struct({
  ...Owner,
  offset: Safe,
  limit: Safe.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
});
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeCompile = Schema.decodeUnknownSync(CompileInput, strict);
const decodeCurrent = Schema.decodeUnknownSync(CurrentInput, strict);
const decodePage = Schema.decodeUnknownSync(PageInput, strict);
const decodeRef = Schema.decodeUnknownSync(ProjectTeamIntegrationSourceRef, strict);
const decodeSource = Schema.decodeUnknownSync(ProjectTeamIntegrationSource, strict);
const decodeSources = Schema.decodeUnknownSync(ProjectTeamIntegrationSources, strict);
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
  strict,
);
const canonical = canonicalProjectWorkPayload;
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
export class ProjectTeamIntegrationSourcesError extends Schema.TaggedError<ProjectTeamIntegrationSourcesError>()(
  "ProjectTeamIntegrationSourcesError",
  {
    code: Schema.Literals(["invalid", "ineligible", "unavailable"]),
    reason: Schema.String,
  },
) {}
const isSourceError = Schema.is(ProjectTeamIntegrationSourcesError);
const deny = (reason: string, code: ProjectTeamIntegrationSourcesError["code"] = "ineligible") =>
  new ProjectTeamIntegrationSourcesError({ code, reason });
const boundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      isSourceError(error)
        ? error
        : deny("Integration source history is unavailable", "unavailable"),
    ),
  );
function capture<A>(decode: (input: unknown) => A, input: unknown): A {
  const copy: unknown = structuredClone(input);
  const value = decode(copy);
  if (canonical(value) !== canonical(copy))
    throw deny("Integration source identity changed during decoding", "invalid");
  return value;
}

/** SQL-qualified reviewed commits; only the owned Git consumer can establish current physical source identity. */
export const makeProjectTeamIntegrationSources = (input: typeof Options.Encoded) => {
  let captured: typeof Options.Type | undefined;
  try {
    captured = capture(decodeOptions, input);
  } catch {
    /* Deny in the single returned effect. */
  }
  return Effect.gen(function* () {
    if (!captured) return yield* deny("Invalid integration source environment", "invalid");
    const environmentId = captured.environmentId;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const reviews = yield* makeProjectTeamCompletedReviewReader({ environmentId });
    const results = yield* makeProjectWorkVerificationResultReader({ environmentId });
    const history = yield* makeProjectTeamDispatchJournal({
      environmentId,
      maximumEnvironmentModelCalls: 1,
    });
    const targets = yield* makeProjectTeamReviewTargets({
      environmentId,
      maximumEnvironmentModelCalls: 1,
    });
    const caller = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      const supplied = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(supplied) ||
        supplied.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny(
          "Integration sources require their original SQL, repository and caller transaction",
          "invalid",
        );
    });
    const owner = Effect.fn("ProjectTeamIntegrationSources.owner")(function* (input: {
      readonly projectId: ProjectId;
      readonly integrationTaskId: ProjectWorkTaskId;
    }) {
      yield* caller;
      const state = yield* readCurrentState(sql, input.projectId);
      const tasks = state.tasks.filter(
        (task) => task.taskId === input.integrationTaskId && task.projectId === input.projectId,
      );
      const memberships =
        state.foundationRecords?.filter(
          (record) =>
            record.kind === "task-membership" && record.taskId === input.integrationTaskId,
        ) ?? [];
      if (
        tasks.length !== 1 ||
        tasks[0]?.state === "completed" ||
        tasks[0]?.state === "canceled" ||
        tasks[0]?.state === "failed" ||
        memberships.length !== 1 ||
        memberships[0]?.kind !== "task-membership" ||
        memberships[0].executionKind !== "managed" ||
        memberships[0].deliverableKind !== "code"
      )
        return yield* deny("Integration selection requires its own current managed code task");
      return state;
    });
    const staleIndexes = new WeakMap<object, ReturnType<typeof staleSourceIndex>>();
    const qualify = Effect.fn("ProjectTeamIntegrationSources.qualify")(function* (
      state: Effect.Success<ReturnType<typeof readCurrentState>>,
      integrationTaskId: ProjectWorkTaskId,
      ref: ProjectTeamIntegrationSourceRef,
    ) {
      if (ref.taskId === integrationTaskId)
        return yield* deny("An integration task cannot select itself");
      const records = state.foundationRecords ?? [];
      const tasks = state.tasks.filter(
        (task) => task.taskId === ref.taskId && task.projectId === state.projectId,
      );
      const members = records.filter(
        (record) => record.kind === "task-membership" && record.taskId === ref.taskId,
      );
      const bindings = records.filter(
        (record) => record.kind === "run-binding" && record.recordId === ref.bindingId,
      );
      const task = tasks[0],
        membership = members[0],
        binding = bindings[0];
      if (
        tasks.length !== 1 ||
        !task ||
        task.state === "canceled" ||
        task.state === "failed" ||
        members.length !== 1 ||
        membership?.kind !== "task-membership" ||
        membership.executionKind !== "managed" ||
        membership.deliverableKind !== "code" ||
        bindings.length !== 1 ||
        binding?.kind !== "run-binding" ||
        binding.taskId !== task.taskId ||
        binding.projectId !== state.projectId ||
        binding.environmentId !== environmentId ||
        binding.status !== "settled" ||
        binding.revision !== ref.expectedBindingRevision ||
        binding.generation !== ref.generation ||
        binding.leaseGeneration !== ref.generation
      )
        return yield* deny("Selected source task or original settled binding changed");
      const roles = records.filter(
        (record) => record.kind === "role-revision" && record.recordId === binding.roleRevisionId,
      );
      if (
        roles.length !== 1 ||
        roles[0]?.kind !== "role-revision" ||
        !["implementer", "integrator"].includes(roles[0].role)
      )
        return yield* deny("Selected source is not an original code assignment");
      const retained = yield* reviews.readInTransaction({
        dispatchId: ref.reviewDispatchId,
        expectedProposalSha256: ref.expectedReviewProposalSha256,
      });
      const review = retained.proposal.manifest;
      const association = yield* targets.readHistoricalAssociation({
        provenance: review.provenance,
      });
      const verification = yield* results.readInTransaction({
        jobId: ref.verificationJobId,
        expectedManifestHash: ref.expectedManifestHash,
      });
      if (
        verification._tag !== "Terminal" ||
        verification.result.outcome !== "success" ||
        verification.result.exitCode !== 0
      )
        return yield* deny("Selected source has no successful complete verification");
      const receipt = verification.snapshot.intent.receipt,
        job = receipt.manifest;
      const target = review.target;
      if (
        job.environmentId !== environmentId ||
        job.projectId !== state.projectId ||
        job.taskId !== task.taskId ||
        job.bindingId !== binding.recordId ||
        job.generation !== binding.generation ||
        receipt.sha256 !== ref.expectedManifestHash ||
        review.assignment.parentTaskId !== task.taskId ||
        review.prepared.jobId !== job.jobId ||
        review.prepared.sha256 !== receipt.sha256 ||
        association.prepared.sha256 !== receipt.sha256 ||
        canonical(association.prepared.manifest) !== canonical(job) ||
        target.projectId !== state.projectId ||
        target.taskId !== task.taskId ||
        target.specRevision !== job.specRevision ||
        target.planRevision !== job.planRevision ||
        target.baseSha !== job.target.baseSha ||
        target.headSha !== job.target.headSha ||
        ref.expectedBranchRef !== job.target.branchRef ||
        ref.expectedBaseSha !== job.target.baseSha ||
        ref.expectedHeadSha !== job.target.headSha ||
        ref.expectedTestedTree !== job.target.testedTree ||
        binding.branch !== job.target.branchRef ||
        binding.worktree !== job.target.worktree ||
        binding.specRevision !== job.specRevision ||
        binding.planRevision !== job.planRevision ||
        task.specRevision !== job.specRevision ||
        (job.integration === true) !== (roles[0].role === "integrator")
      )
        return yield* deny("Review and verification do not describe the exact selected source");
      const plans = records.filter(
        (record) =>
          record.kind === "plan-revision" &&
          record.taskId === task.taskId &&
          record.status === "proposed",
      );
      const plan = plans.find(
        (record) =>
          record.kind === "plan-revision" &&
          record.planRevision === job.planRevision &&
          record.specRevision === job.specRevision,
      );
      if (
        plan?.kind !== "plan-revision" ||
        plans.filter(
          (record) =>
            record.kind === "plan-revision" &&
            record.planRevision === job.planRevision &&
            record.specRevision === job.specRevision,
        ).length !== 1 ||
        plans.some(
          (record) => record.kind === "plan-revision" && record.planRevision > job.planRevision,
        ) ||
        projectTeamPlanHash(plan) !== job.planHash ||
        plan.contentHash !== job.planHash ||
        projectTeamSpecificationHash(state, task.taskId) !== job.specificationHash ||
        projectTeamScopeHash(state, task.taskId, plan) !== binding.scopeHash
      )
        return yield* deny("Selected source immutable definitions or approved plan changed");
      for (const [kind, contentHash, revision] of [
        ["specification", job.specificationHash, 0],
        ["plan", job.planHash, job.planRevision],
      ] as const) {
        const grants = records.filter(
          (record) =>
            record.kind === "gate" &&
            record.taskId === task.taskId &&
            record.gate === kind &&
            record.specRevision === job.specRevision &&
            record.planRevision === revision &&
            record.contentHash === contentHash &&
            (record.status === "approved" || record.status === "consumed"),
        );
        if (
          grants.length !== 1 ||
          grants[0]?.kind !== "gate" ||
          grants[0].attribution.actor.kind !== "human"
        )
          return yield* deny("Selected source human specification or plan approval changed");
      }
      const originalGate = verification.snapshot.intent.gate;
      const verificationGrants = records.filter(
        (record) => record.kind === "gate" && record.recordId === originalGate.recordId,
      );
      const grant = verificationGrants[0];
      if (
        verificationGrants.length !== 1 ||
        grant?.kind !== "gate" ||
        grant.status !== "consumed" ||
        grant.revision !== originalGate.revision + 1 ||
        grant.consumedByRunId !== verification.snapshot.attemptId ||
        !grant.consumedByCommandId ||
        grant.attribution.actor.kind !== "human"
      )
        return yield* deny("Selected source original human verification grant changed");
      const { consumedByRunId: _run, consumedByCommandId: _command, ...unconsumed } = grant;
      if (
        hash({
          ...unconsumed,
          status: originalGate.status,
          revision: originalGate.revision,
          updatedAt: originalGate.updatedAt,
        }) !== hash(originalGate)
      )
        return yield* deny("Selected source verification approval was replaced");
      const reviewer = retained.snapshot.intent.compiledClaim.transition;
      if (
        reviewer?.kind !== "claim" ||
        reviewer.binding.memberId === binding.memberId ||
        reviewer.binding.threadId === binding.threadId ||
        reviewer.binding.recordId === binding.recordId
      )
        return yield* deny("Source review is not an independent assignment");
      if (
        selectReviewFindings(indexReviewFindings(state), target).records.some(
          (finding) => finding.status === "open" && finding.severity === "critical",
        )
      )
        return yield* deny("An open critical finding blocks this exact source target");
      const original = yield* history.readHistoricalInTransaction(job.dispatchId);
      const originalClaim = original.snapshot.intent.compiledClaim.transition;
      if (
        original.snapshot.fence.stage !== "settled" ||
        originalClaim?.kind !== "claim" ||
        originalClaim.binding.recordId !== binding.recordId ||
        originalClaim.binding.generation !== binding.generation
      )
        return yield* deny("Original source dispatch changed");
      for (const key of [
        "projectId",
        "taskId",
        "attemptId",
        "environmentId",
        "memberId",
        "roleRevisionId",
        "providerInstanceId",
        "threadId",
        "model",
        "configuration",
        "worktree",
        "branch",
        "specRevision",
        "planRevision",
      ] as const)
        if (canonical(originalClaim.binding[key]) !== canonical(binding[key]))
          return yield* deny("Original source assignment identity changed");
      const workspaces =
        yield* sql`SELECT environment_id,binding_id,generation,claim_generation,assignment_json,
        CASE WHEN length(CAST(receipt_json AS BLOB))<=262144 THEN receipt_json END AS receipt_json
        FROM project_team_workspace_receipt WHERE dispatch_id=${job.dispatchId} LIMIT 2`;
      const workspace = workspaces[0];
      if (
        workspaces.length !== 1 ||
        !workspace ||
        workspace.environment_id !== environmentId ||
        workspace.binding_id !== binding.recordId ||
        workspace.generation !== binding.generation ||
        workspace.claim_generation !== original.snapshot.fence.claimGeneration ||
        workspace.assignment_json !== canonical(original.snapshot.intent.request.git) ||
        typeof workspace.receipt_json !== "string"
      )
        return yield* deny("Original source ownership receipt changed");
      const ownership = yield* decodeWorkspace(workspace.receipt_json);
      if (
        hash(ownership) !== job.workspaceReceiptHash ||
        canonical(ownership.assignment) !== canonical(original.snapshot.intent.request.git) ||
        canonical(ownership) !== workspace.receipt_json
      )
        return yield* deny("Original source physical ownership changed");
      // Historical storage rehashes both raw outputs; no current filesystem permission is supplied here.
      const source = yield* Effect.try({
        try: () =>
          decodeSource({
            taskId: task.taskId,
            bindingId: binding.recordId,
            bindingRevision: binding.revision,
            generation: binding.generation,
            dispatchId: job.dispatchId,
            workspaceReceiptSha256: job.workspaceReceiptHash,
            specRevision: job.specRevision,
            planRevision: job.planRevision,
            scopeHash: binding.scopeHash,
            branchRef: job.target.branchRef,
            baseSha: job.target.baseSha,
            headSha: job.target.headSha,
            testedTree: job.target.testedTree,
            reviewDispatchId: ref.reviewDispatchId,
            reviewProposalSha256: retained.proposal.sha256,
            joinedReceiptId: retained.joined.receiptId,
            jobId: job.jobId,
            manifestHash: receipt.sha256,
            attemptId: verification.snapshot.attemptId,
            resultHash: verification.metadata.resultHash,
          }),
        catch: () => deny("Source facts exceed their retained bounds", "invalid"),
      });
      let stale = staleIndexes.get(state);
      if (stale === undefined) {
        stale = staleSourceIndex(state);
        staleIndexes.set(state, stale);
      }
      if (stale(source)) return yield* deny("Selected source has a durable invalidation");
      return { source, taskTitle: task.title };
    });
    const compile = Effect.fn("ProjectTeamIntegrationSources.compile")(function* (
      input: typeof CompileInput.Type,
    ) {
      const state = yield* owner(input);
      const selected = yield* Effect.forEach(input.refs, (ref) =>
        qualify(state, input.integrationTaskId, ref),
      );
      return yield* Effect.try({
        try: () =>
          decodeSources({
            version: 1,
            environmentId,
            sources: selected.map((entry) => entry.source),
          }),
        catch: () => deny("Frozen integration sources exceed their bounds", "invalid"),
      });
    });
    const page = Effect.fn("ProjectTeamIntegrationSources.candidates")(function* (
      input: typeof PageInput.Type,
    ) {
      const state = yield* owner(input);
      const rows = yield* sql<{
        dispatch_id: string;
        sha256: string;
        review_task_id: string;
      }>`SELECT dispatch_id,sha256,review_task_id FROM project_team_review_completion_proposal
        WHERE environment_id=${environmentId} AND project_id=${input.projectId} AND parent_task_id<>${input.integrationTaskId}
        ORDER BY parent_task_id,dispatch_id,command_id LIMIT ${input.limit + 1} OFFSET ${input.offset}`;
      const candidates: Array<{
        ref: ProjectTeamIntegrationSourceRef;
        source: ProjectTeamIntegrationSource;
        taskTitle: string;
      }> = [];
      for (const row of rows.slice(0, input.limit)) {
        if (
          !state.tasks.some(
            (task) => task.taskId === row.review_task_id && task.state === "completed",
          )
        )
          continue;
        const review = yield* reviews.readInTransaction({
          dispatchId: row.dispatch_id,
          expectedProposalSha256: row.sha256,
        });
        const retained = yield* results.readInTransaction({
          jobId: review.proposal.manifest.prepared.jobId,
          expectedManifestHash: review.proposal.manifest.prepared.sha256,
        });
        if (retained._tag !== "Terminal" || retained.result.outcome !== "success") continue;
        const job = retained.snapshot.intent.receipt.manifest;
        const bindings =
          state.foundationRecords?.filter(
            (record) => record.kind === "run-binding" && record.recordId === job.bindingId,
          ) ?? [];
        if (bindings.length !== 1 || bindings[0]?.kind !== "run-binding") continue;
        const binding = bindings[0];
        const ref = yield* Effect.try({
          try: () =>
            decodeRef({
              taskId: job.taskId,
              bindingId: job.bindingId,
              expectedBindingRevision: binding.revision,
              generation: job.generation,
              reviewDispatchId: row.dispatch_id,
              expectedReviewProposalSha256: row.sha256,
              verificationJobId: job.jobId,
              expectedManifestHash: retained.snapshot.intent.receipt.sha256,
              expectedBranchRef: job.target.branchRef,
              expectedBaseSha: job.target.baseSha,
              expectedHeadSha: job.target.headSha,
              expectedTestedTree: job.target.testedTree,
            }),
          catch: () => deny("Candidate source references exceed their bounds", "invalid"),
        });
        const eligible = yield* qualify(state, input.integrationTaskId, ref).pipe(Effect.result);
        if (eligible._tag === "Failure") {
          if (isSourceError(eligible.failure) && eligible.failure.code === "ineligible") continue;
          return yield* Effect.fail(eligible.failure);
        }
        if (!candidates.some((candidate) => candidate.ref.taskId === ref.taskId))
          candidates.push({ ref, ...eligible.success });
      }
      const scanned = Math.min(input.limit, rows.length);
      if (!Number.isSafeInteger(input.offset + scanned))
        return yield* deny("Integration source continuation is exhausted", "invalid");
      return { candidates, nextOffset: input.offset + scanned, hasMore: rows.length > input.limit };
    });
    return {
      candidatesInTransaction(input: typeof PageInput.Type) {
        let owned: typeof PageInput.Type | undefined;
        try {
          owned = capture(decodePage, input);
        } catch {}
        return boundary(
          Effect.gen(function* () {
            if (!owned) return yield* deny("Invalid source page", "invalid");
            return yield* page(owned);
          }),
        );
      },
      compileInTransaction(input: typeof CompileInput.Type) {
        let owned: typeof CompileInput.Type | undefined;
        try {
          owned = capture(decodeCompile, input);
        } catch {}
        return boundary(
          Effect.gen(function* () {
            if (!owned) return yield* deny("Invalid source selection", "invalid");
            return yield* compile(owned);
          }),
        );
      },
      assertCurrentInTransaction(input: typeof CurrentInput.Type) {
        let owned: typeof CurrentInput.Type | undefined;
        try {
          owned = capture(decodeCurrent, input);
        } catch {}
        return boundary(
          Effect.gen(function* () {
            if (!owned || owned.sources.environmentId !== environmentId)
              return yield* deny("Invalid retained source owner", "invalid");
            const refs = yield* Effect.try({
              try: () =>
                owned.sources.sources.map((source) =>
                  decodeRef({
                    taskId: source.taskId,
                    bindingId: source.bindingId,
                    expectedBindingRevision: source.bindingRevision,
                    generation: source.generation,
                    reviewDispatchId: source.reviewDispatchId,
                    expectedReviewProposalSha256: source.reviewProposalSha256,
                    verificationJobId: source.jobId,
                    expectedManifestHash: source.manifestHash,
                    expectedBranchRef: source.branchRef,
                    expectedBaseSha: source.baseSha,
                    expectedHeadSha: source.headSha,
                    expectedTestedTree: source.testedTree,
                  }),
                ),
              catch: () => deny("Stored source references exceed their bounds", "invalid"),
            });
            const current = yield* compile({
              projectId: owned.projectId,
              integrationTaskId: owned.integrationTaskId,
              refs,
            });
            if (canonical(current) !== canonical(owned.sources))
              return yield* deny("Retained integration sources changed");
          }),
        );
      },
    };
  });
};
