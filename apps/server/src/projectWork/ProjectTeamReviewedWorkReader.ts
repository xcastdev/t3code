import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  EnvironmentId,
  ProjectId,
  ProjectTeamIntegrationSourceRef,
  ProjectTeamIntegrationSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { staleSourceIndex } from "./ProjectTeamIntegrationSourceState.ts";
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
const Options = Schema.Struct({ environmentId: EnvironmentId });
const Input = Schema.Struct({ projectId: ProjectId, ref: ProjectTeamIntegrationSourceRef });
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeInput = Schema.decodeUnknownSync(Input, strict);
const decodeProject = Schema.decodeUnknownSync(ProjectId, strict);
const decodeRef = Schema.decodeUnknownSync(ProjectTeamIntegrationSourceRef, strict);
const decodeSource = Schema.decodeUnknownSync(ProjectTeamIntegrationSource, strict);
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

export { ProjectTeamIntegrationSourcesError as ProjectTeamReviewedWorkError };

/** Qualified retained review and verification, with current SQL permissions; no physical Git authority. */
export const makeProjectTeamReviewedWorkReader = (input: typeof Options.Encoded) => {
  let captured: typeof Options.Type | undefined;
  try {
    captured = capture(decodeOptions, input);
  } catch {}
  return Effect.gen(function* () {
    if (!captured) return yield* deny("Invalid reviewed work environment", "invalid");
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
      const owner = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(owner) ||
        owner.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny(
          "Reviewed work requires its original SQL, repository and caller transaction",
          "invalid",
        );
    });
    const staleIndexes = new WeakMap<object, ReturnType<typeof staleSourceIndex>>();
    const qualify = Effect.fn("ProjectTeamReviewedWorkReader.qualify")(function* (
      state: Effect.Success<ReturnType<typeof readCurrentState>>,
      ref: ProjectTeamIntegrationSourceRef,
    ) {
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
    const withCurrentInTransaction = <A, E, R>(
      input: { readonly projectId: ProjectId },
      use: (
        read: (ref: ProjectTeamIntegrationSourceRef) => ReturnType<typeof qualify>,
      ) => Effect.Effect<A, E, R>,
    ) => {
      let projectId: ProjectId | undefined;
      try {
        projectId = capture(decodeProject, input.projectId);
      } catch {}
      return boundary(
        Effect.gen(function* () {
          if (!projectId) return yield* deny("Invalid reviewed work project", "invalid");
          yield* caller;
          const state = yield* readCurrentState(sql, projectId);
          let active = true;
          const read = (input: ProjectTeamIntegrationSourceRef) => {
            let ref: ProjectTeamIntegrationSourceRef | undefined;
            try {
              ref = capture(decodeRef, input);
            } catch {}
            return Effect.gen(function* () {
              if (!active || !ref)
                return yield* deny("Reviewed work read escaped its transaction", "invalid");
              yield* caller;
              const qualified = yield* qualify(state, ref);
              if (!active)
                return yield* deny("Reviewed work read escaped its transaction", "invalid");
              yield* caller;
              return qualified;
            });
          };
          return yield* Effect.gen(function* () {
            const result = yield* use(read);
            yield* caller;
            return result;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active = false;
              }),
            ),
          );
        }),
      );
    };
    return {
      withCurrentInTransaction,
      readCurrentInTransaction(input: typeof Input.Type) {
        let capturedInput: typeof Input.Type | undefined;
        try {
          capturedInput = capture(decodeInput, input);
        } catch {}
        return boundary(
          Effect.gen(function* () {
            if (!capturedInput) return yield* deny("Invalid reviewed work identity", "invalid");
            yield* caller;
            const state = yield* readCurrentState(sql, capturedInput.projectId);
            return yield* qualify(state, capturedInput.ref);
          }),
        );
      },
    };
  });
};
