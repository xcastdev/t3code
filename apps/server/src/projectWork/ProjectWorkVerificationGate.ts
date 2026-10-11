import { canonicalProjectWorkPayload, ProjectVerificationJobManifest } from "@t3tools/contracts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { projectTeamPlanHash, projectTeamSpecificationHash } from "./ProjectTeamPolicy.ts";
import {
  makeProjectTeamDispatchJournal,
  ProjectTeamWorkspaceReceipt,
  ProjectTeamWorkspaceEvidence,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { ProjectWorkVerificationPreparationSelection } from "./ProjectWorkVerificationPreparation.ts";
import type { ProjectWorkPreparedVerificationReceipt } from "./ProjectWorkVerificationJobs.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Options = Schema.Struct({
  environmentId: Id,
  maximumEnvironmentModelCalls: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(128),
  ),
});
const decodeOptions = Schema.decodeUnknownSync(Options, { onExcessProperty: "error" });
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    manifest: ProjectVerificationJobManifest,
    sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  }),
  { onExcessProperty: "error" },
);
const decodeSelection = Schema.decodeUnknownSync(
  Schema.suspend(() => ProjectWorkVerificationPreparationSelection),
  {
    onExcessProperty: "error",
  },
);
const decodeEvidence = Schema.decodeUnknownEffect(ProjectTeamWorkspaceEvidence, {
  onExcessProperty: "error",
});
// Preserve exact schema-encoded workspace receipts alongside retained canonical receipts.
const encodeWorkspace = Schema.encodeSync(Schema.fromJsonString(ProjectTeamWorkspaceReceipt));
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectTeamWorkspaceReceipt),
  { onExcessProperty: "error" },
);
const canonical = canonicalProjectWorkPayload;
const sameIntegration = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const hash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
export class ProjectWorkVerificationGateError extends Schema.TaggedError<ProjectWorkVerificationGateError>()(
  "ProjectWorkVerificationGateError",
  { reason: Schema.String },
) {}
/** Request-owned private capability, supplied only after Root prepares or loads the exact job. */
export class ProjectWorkVerificationApproval extends Context.Service<
  ProjectWorkVerificationApproval,
  {
    readonly receipt: ProjectWorkPreparedVerificationReceipt;
    readonly selection: typeof ProjectWorkVerificationPreparationSelection.Type;
    readonly assertCurrent: (
      state: ProjectWorkReducerState,
      duplicate: boolean,
    ) => Effect.Effect<void, ProjectWorkVerificationGateError, SqlClient.SqlClient>;
  }
>()("t3/projectWork/ProjectWorkVerificationGate/ProjectWorkVerificationApproval") {}

const deny = (reason: string) => new ProjectWorkVerificationGateError({ reason });
const capture = <A>(decode: (input: unknown) => A, input: unknown) => {
  const copy: unknown = structuredClone(input);
  const value = decode(copy);
  if (canonical(copy) !== canonical(value))
    throw deny("Verification values changed during decoding");
  return value;
};

/** Called in the command transaction with a private Root-produced receipt.
 * Matching storage alone never supplies that receipt's host provenance. */
export function makeProjectWorkVerificationGate(input: typeof Options.Type) {
  let options: typeof Options.Type;
  try {
    options = capture(decodeOptions, input);
  } catch {
    return Effect.fail(deny("Invalid verification environment"));
  }
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* makeProjectTeamDispatchJournal(options);
    const repository = yield* ProjectWorkRepository;
    const assertCurrent = (
      state: ProjectWorkReducerState,
      receipt: ProjectWorkPreparedVerificationReceipt,
      selection: typeof ProjectWorkVerificationPreparationSelection.Type,
      duplicate = false,
    ) => {
      let owned: ProjectWorkPreparedVerificationReceipt;
      let selected: typeof ProjectWorkVerificationPreparationSelection.Type;
      try {
        owned = capture(decodeReceipt, receipt);
        selected = capture(decodeSelection, selection);
      } catch {
        return Effect.fail(deny("Invalid private verification target"));
      }
      return Effect.gen(function* () {
        if ((yield* SqlClient.SqlClient) !== sql)
          return yield* deny("Verification SQL context changed");
        const job = owned.manifest;
        const task = state.tasks.find((row) => row.taskId === selected.taskId);
        if (
          job.environmentId !== options.environmentId ||
          job.jobId !== selected.jobId ||
          job.projectId !== selected.projectId ||
          job.taskId !== selected.taskId ||
          job.specRevision !== selected.specRevision ||
          job.planRevision !== selected.planRevision ||
          job.bindingId !== selected.bindingId ||
          job.generation !== selected.generation ||
          canonical(job.command) !== canonical(selected.command) ||
          canonical(job.criteria.map((row) => row.criterionId)) !==
            canonical(selected.criterionIds) ||
          owned.sha256 !== hash(job) ||
          state.projectId !== selected.projectId ||
          (!duplicate && state.revision !== selected.expectedRevision) ||
          !task ||
          task.projectId !== selected.projectId ||
          task.revision !== selected.expectedTaskRevision ||
          task.specRevision !== job.specRevision ||
          !task.specification ||
          task.state === "draft" ||
          task.state === "canceled" ||
          task.state === "completed"
        )
          return yield* deny("Verification task or selected manifest changed");
        const records = state.foundationRecords ?? [];
        const bindings = records.filter(
          (row) => row.kind === "run-binding" && row.recordId === job.bindingId,
        );
        const binding = bindings[0];
        if (
          bindings.length !== 1 ||
          binding?.kind !== "run-binding" ||
          binding.projectId !== job.projectId ||
          binding.taskId !== job.taskId ||
          binding.environmentId !== options.environmentId ||
          binding.status !== "settled" ||
          binding.revision !== selected.expectedBindingRevision ||
          binding.generation !== job.generation ||
          binding.leaseGeneration !== job.generation ||
          binding.specRevision !== job.specRevision ||
          binding.planRevision !== job.planRevision ||
          binding.worktree !== job.target.worktree ||
          binding.branch !== job.target.branchRef
        )
          return yield* deny("Original settled verification binding changed");
        const roles = records.filter(
          (row) => row.kind === "role-revision" && row.recordId === binding.roleRevisionId,
        );
        if (
          roles.length !== 1 ||
          roles[0]?.kind !== "role-revision" ||
          (roles[0].role !== "implementer" && roles[0].role !== "integrator") ||
          (job.integration === true) !== (roles[0].role === "integrator")
        )
          return yield* deny("Original verification role changed");
        const plans = records.filter(
          (row) =>
            row.kind === "plan-revision" && row.taskId === job.taskId && row.status === "proposed",
        );
        const matching = plans.filter(
          (row) =>
            row.kind === "plan-revision" &&
            row.specRevision === job.specRevision &&
            row.planRevision === job.planRevision,
        );
        const plan = matching[0];
        if (
          matching.length !== 1 ||
          plan?.kind !== "plan-revision" ||
          plans.some(
            (row) => row.kind === "plan-revision" && row.planRevision > job.planRevision,
          ) ||
          plan.contentHash !== job.planHash ||
          projectTeamPlanHash(plan) !== job.planHash ||
          projectTeamSpecificationHash(state, job.taskId) !== job.specificationHash
        )
          return yield* deny("Verification specification or plan changed");
        for (const [gateKind, contentHash, planRevision] of [
          ["specification", job.specificationHash, 0],
          ["plan", job.planHash, job.planRevision],
        ] as const) {
          const gates = records.filter(
            (row) =>
              row.kind === "gate" &&
              row.taskId === job.taskId &&
              row.gate === gateKind &&
              row.specRevision === job.specRevision &&
              row.planRevision === planRevision &&
              row.contentHash === contentHash &&
              (row.status === "approved" || row.status === "consumed"),
          );
          if (
            gates.length !== 1 ||
            gates[0]?.kind !== "gate" ||
            gates[0].attribution.actor.kind !== "human"
          )
            return yield* deny("Human specification or plan approval changed");
        }
        for (const criterion of job.criteria) {
          const rows = state.criteria.filter(
            (row) =>
              row.criterionId === criterion.criterionId &&
              row.taskId === job.taskId &&
              row.revision === criterion.revision,
          );
          if (rows.length !== 1) return yield* deny("Verification criterion changed");
        }
        const retained =
          yield* sql`SELECT manifest_json,sha256 FROM project_work_verification_jobs WHERE environment_id=${options.environmentId} AND job_id=${job.jobId} AND project_id=${job.projectId} AND task_id=${job.taskId} AND length(CAST(manifest_json AS BLOB))<=65536 LIMIT 2`;
        if (
          retained.length !== 1 ||
          retained[0]?.manifest_json !== canonical(job) ||
          retained[0]?.sha256 !== owned.sha256
        )
          return yield* deny("Prepared verification storage changed");
        const dispatch =
          yield* sql`SELECT dispatch_id,claim_generation FROM project_team_dispatch WHERE dispatch_id=${job.dispatchId} AND environment_id=${options.environmentId} AND project_id=${job.projectId} AND task_id=${job.taskId} AND binding_id=${job.bindingId} AND generation=${job.generation} AND stage='settled' LIMIT 2`;
        if (dispatch.length !== 1) return yield* deny("Original settled dispatch changed");
        const snapshot = yield* journal.readRetained(job.dispatchId);
        const transition = snapshot.intent.compiledClaim.transition;
        if (snapshot.fence.stage !== "settled" || transition?.kind !== "claim")
          return yield* deny("Original implementation dispatch changed");
        if (
          plan.integrationSources !== undefined ||
          snapshot.intent.integration !== undefined ||
          job.integrationCoverage !== undefined
        ) {
          const integration = snapshot.intent.integration,
            coverage = job.integrationCoverage;
          if (
            roles[0].role !== "integrator" ||
            job.integration !== true ||
            plan.integrationSources === undefined ||
            integration === undefined ||
            coverage === undefined ||
            integration.planId !== plan.recordId ||
            integration.planContentHash !== plan.contentHash ||
            integration.selectionSha256 !== hash(plan.integrationSources) ||
            !sameIntegration(integration.selection, plan.integrationSources) ||
            coverage.selectionSha256 !== integration.selectionSha256
          )
            return yield* deny("Original integration selection or coverage changed");
          const sources = yield* makeProjectTeamIntegrationSources({
            environmentId: options.environmentId,
          }).pipe(Effect.provideService(ProjectWorkRepository, repository));
          yield* sources.assertCurrentInTransaction({
            projectId: job.projectId,
            integrationTaskId: job.taskId,
            sources: integration.selection,
          });
          const history = yield* journal.readHistoricalInTransaction(job.dispatchId);
          const stages = history.receipts.filter((stage) => stage.stage === "workspace-ready");
          if (stages.length !== 1)
            return yield* deny("Original integration combination is missing or ambiguous");
          const evidence = yield* decodeEvidence(stages[0]?.evidence);
          if (
            !evidence.integration ||
            hash(evidence.integration) !== coverage.combinationSha256 ||
            evidence.integration.selectionSha256 !== coverage.selectionSha256 ||
            evidence.integration.baseSha !== job.target.baseSha ||
            !sameIntegration(
              evidence.integration.sourceHeads,
              integration.selection.sources.map((source) => source.headSha),
            ) ||
            hash(evidence.workspace) !== job.workspaceReceiptHash
          )
            return yield* deny("Verification coverage differs from original combination");
        }
        for (const key of [
          "recordId",
          "projectId",
          "taskId",
          "attemptId",
          "generation",
          "leaseGeneration",
          "memberId",
          "roleRevisionId",
          "providerInstanceId",
          "threadId",
          "environmentId",
          "model",
          "configuration",
          "worktree",
          "branch",
          "specRevision",
          "planRevision",
        ] as const)
          if (canonical(transition.binding[key]) !== canonical(binding[key]))
            return yield* deny("Original implementation identity changed");
        const workspace =
          yield* sql`SELECT receipt_json,assignment_json FROM project_team_workspace_receipt WHERE dispatch_id=${job.dispatchId} AND environment_id=${options.environmentId} AND binding_id=${job.bindingId} AND generation=${job.generation} AND claim_generation=${snapshot.fence.claimGeneration} AND length(CAST(receipt_json AS BLOB))<=262144 AND length(CAST(assignment_json AS BLOB))<=262144 LIMIT 2`;
        const raw = workspace[0]?.receipt_json;
        if (
          workspace.length !== 1 ||
          typeof raw !== "string" ||
          workspace[0]?.assignment_json !== canonical(snapshot.intent.request.git)
        )
          return yield* deny("Original workspace receipt changed");
        const original = yield* decodeWorkspace(raw).pipe(
          Effect.mapError(() => deny("Invalid original workspace receipt")),
        );
        if (
          canonical(original.assignment) !== canonical(snapshot.intent.request.git) ||
          (raw !== canonical(original) && raw !== encodeWorkspace(original)) ||
          hash(original) !== job.workspaceReceiptHash ||
          original.assignment.primaryRoot !== job.target.repository ||
          original.assignment.worktreePath !== job.target.worktree ||
          original.assignment.branchRef !== job.target.branchRef ||
          original.assignment.baseOid !== job.target.baseSha
        )
          return yield* deny("Original workspace no longer matches verification");
      });
    };
    return { assertCurrent };
  });
}
