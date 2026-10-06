import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamReviewCompletionProof,
  ProjectTeamReviewCompletionDenialReason,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamDispatchJournal,
  type ProjectTeamDispatchSnapshot,
  type ProjectTeamDispatchStageReceipt,
} from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamReviewCompletionProposals } from "./ProjectTeamReviewCompletionProposals.ts";
import { makeProjectTeamReviewTargets } from "./ProjectTeamReviewTargets.ts";
import { makeProjectTeamReviewFreshness } from "./ProjectTeamReviewFreshness.ts";
import { makeProjectTeamSessionReceipts } from "./ProjectTeamSessionReceipts.ts";
import { makeProjectWorkVerificationResultReader } from "./ProjectWorkVerificationExecutionJournal.ts";
import { snapshotReviewCriterionAssessments } from "./ProjectTeamReviewCriterionAssessments.ts";
import { ProjectTeamReviewCurrentTarget } from "./ProjectTeamReviewCurrentTarget.ts";
import {
  evaluateProjectTeamDependency,
  projectTeamDerivedRecordId,
  projectTeamScopeHash,
} from "./ProjectTeamPolicy.ts";

const strict = { onExcessProperty: "error" } as const;
const canonical = canonicalProjectWorkPayload;
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const hash = (value: unknown) => digest(canonical(value));
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isTrimmed());
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Options = Schema.Struct({
  environmentId: Id,
  maximumEnvironmentModelCalls: Safe.check(Schema.isBetween({ minimum: 1, maximum: 128 })),
});
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
const InputRow = Schema.Struct({
  reservation_id: Id,
  operation_id: Id,
  request_id: Safe.check(Schema.isGreaterThan(0)),
  worker_id: Id,
  generation: Safe,
  route_id: Id,
  provider: Schema.Literal("command-code"),
  model: Id,
  system_text_sha256: Digest,
  encoded_request_sha256: Digest,
});
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot, strict);
const decodeJoin = Schema.decodeUnknownSync(Join, strict);
const decodeProof = Schema.decodeUnknownEffect(ProjectTeamReviewCompletionProof, strict);
const decodeInputs = Schema.decodeUnknownEffect(
  Schema.Array(InputRow).check(Schema.isMaxLength(256)),
  strict,
);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject), strict);
const staleTargetReasons = new Set([
  "Original review dispatch changed",
  "Original reviewer assignment is missing",
  "Original reviewer role is missing",
  "Original consumed human review assignment is missing",
  "Review target ownership is ambiguous",
  "Retained review target exceeds its bound",
  "Retained review target is malformed",
  "Retained review target owner or hash changed",
  "Retained review assignment changed",
  "Original human verification approval changed",
  "Original consumed approval lacks exact consumption identity",
  "Original verification approval was replaced",
  "Original verification job does not match inherited review scope",
  "Original prepared verification job is missing",
  "Original prepared verification job changed",
  "The original review target is missing",
]);
const staleVerificationReasons = new Set([
  "Verification task or selected manifest changed",
  "Original settled verification binding changed",
  "Original verification role changed",
  "Verification specification or plan changed",
  "Human specification or plan approval changed",
  "Verification criterion changed",
  "Prepared verification storage changed",
  "Original settled dispatch changed",
  "Original implementation dispatch changed",
  "Original implementation identity changed",
  "Original workspace receipt changed",
  "Invalid original workspace receipt",
  "Original workspace no longer matches verification",
]);
const sameBinding = (
  binding: Extract<import("@t3tools/contracts").ProjectTeamRecord, { kind: "run-binding" }>,
) => {
  const { revision: _r, status: _s, updatedAt: _u, sessionId: _session, ...identity } = binding;
  return canonical(identity);
};
const approvalContent = (
  gate: Extract<import("@t3tools/contracts").ProjectTeamRecord, { kind: "gate" }>,
) => {
  const {
    status: _status,
    revision: _revision,
    updatedAt: _updatedAt,
    consumedByRunId: _run,
    consumedByCommandId: _command,
    ...content
  } = gate;
  return content;
};

export class ProjectTeamReviewCompletionError extends Schema.TaggedError<ProjectTeamReviewCompletionError>()(
  "ProjectTeamReviewCompletionError",
  { reason: Schema.String },
) {}
const fail = (reason: string) => new ProjectTeamReviewCompletionError({ reason });

/** Qualification inside the original joined settlement. Reading this proof grants no execution authority. */
export const makeProjectTeamReviewCompletion = (input: typeof Options.Type) => {
  let options: typeof Options.Type;
  try {
    const copy: unknown = structuredClone(input);
    options = decodeOptions(copy);
    if (!same(copy, options)) return Effect.fail(fail("Invalid completion options"));
  } catch {
    return Effect.fail(fail("Invalid completion options"));
  }
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const journal = yield* makeProjectTeamDispatchJournal(options);
    const targets = yield* makeProjectTeamReviewTargets(options);
    const freshness = yield* makeProjectTeamReviewFreshness({
      environmentId: options.environmentId,
    });
    const sessions = yield* makeProjectTeamSessionReceipts(options);
    const currentTarget = yield* Effect.serviceOption(ProjectTeamReviewCurrentTarget);
    const verificationResults = yield* makeProjectWorkVerificationResultReader({
      environmentId: options.environmentId,
    });
    // Only its error-preserving retained reader is used. No current authority is resolved here.
    const proposals = yield* makeProjectTeamReviewCompletionProposals(() =>
      Effect.succeed(undefined),
    );
    const caller = Effect.gen(function* () {
      const suppliedSql = yield* Effect.serviceOption(SqlClient.SqlClient);
      const suppliedRepo = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(suppliedSql) ||
        suppliedSql.value !== sql ||
        Option.isNone(suppliedRepo) ||
        suppliedRepo.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* fail(
          "Completion requires its original SQL, repository, and caller transaction",
        );
    });
    const prepareInside = Effect.fn("ProjectTeamReviewCompletion.prepareInside")(function* (
      snapshot: ProjectTeamDispatchSnapshot,
      joined: ProjectTeamDispatchStageReceipt,
    ) {
      const original = yield* journal.readRetained(snapshot.fence.dispatchId);
      yield* journal.readStageReceipts(snapshot.fence.dispatchId);
      if (!same(original, snapshot)) return yield* fail("Original completion dispatch changed");
      const claim = original.intent.compiledClaim.transition;
      if (claim?.kind !== "claim" || claim.binding.environmentId !== options.environmentId)
        return yield* fail("Completion dispatch has no original environment claim");
      const originalBinding = claim.binding;
      const state = yield* readCurrentState(sql, originalBinding.projectId);
      const records = state.foundationRecords ?? [];
      const roles = records.filter((r) => r.recordId === originalBinding.roleRevisionId);
      if (roles.length === 1 && roles[0]?.kind === "role-revision" && roles[0].role !== "reviewer")
        return undefined;
      const rows = yield* sql<{
        command_id: string;
      }>`SELECT command_id FROM project_team_review_completion_proposal WHERE environment_id=${options.environmentId} AND assignment_operation_id=${original.intent.request.assignmentOperationId} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* fail("Original completion proposal is ambiguous");
      const receipt = yield* proposals.readRetained({
        environmentId: options.environmentId,
        projectId: originalBinding.projectId,
        commandId: rows[0]!.command_id,
      });
      if (!receipt) return yield* fail("Original completion proposal disappeared");
      const manifest = receipt.manifest;
      const report = manifest.report;
      const deny = (reason: typeof ProjectTeamReviewCompletionDenialReason.Type) =>
        decodeProof({
          status: "denied",
          proposalCommandId: report.commandId,
          proposalSha256: receipt.sha256,
          assignmentOperationId: original.intent.request.assignmentOperationId,
          reason,
        });
      if (report.type !== "project-team.assignment.report" || report.outcome !== "complete")
        return yield* deny("invalid-proof");
      if (
        roles.length !== 1 ||
        roles[0]?.kind !== "role-revision" ||
        roles[0].status !== "available" ||
        roles[0].role !== "reviewer"
      )
        return yield* deny("control-changed");
      const bindings = records.filter(
        (r) => r.kind === "run-binding" && r.recordId === originalBinding.recordId,
      );
      const binding = bindings[0];
      const tasks = state.tasks.filter((t) => t.taskId === originalBinding.taskId);
      const task = tasks[0];
      const attempts = state.attempts.filter((a) => a.attemptId === originalBinding.attemptId);
      const attempt = attempts[0];
      const members = records.filter(
        (r) => r.kind === "member" && r.recordId === originalBinding.memberId,
      );
      const member = members[0];
      const memberships = records.filter(
        (r) => r.kind === "task-membership" && r.taskId === originalBinding.taskId,
      );
      const membership = memberships[0];
      if (
        original.fence.claimGeneration < 1 ||
        original.fence.stage === "settled" ||
        bindings.length !== 1 ||
        binding?.kind !== "run-binding" ||
        !["running", "stopping"].includes(binding.status) ||
        sameBinding(binding) !== sameBinding(originalBinding) ||
        binding.sessionId !== manifest.provenance.sessionId ||
        tasks.length !== 1 ||
        !task ||
        task.state !== "in-progress" ||
        task.activeAttemptId !== originalBinding.attemptId ||
        attempts.length !== 1 ||
        !attempt ||
        attempt.taskId !== task.taskId ||
        !["leased", "running"].includes(attempt.state) ||
        members.length !== 1 ||
        member?.kind !== "member" ||
        member.status !== "active" ||
        member.roleRevisionId !== originalBinding.roleRevisionId ||
        memberships.length !== 1 ||
        membership?.kind !== "task-membership" ||
        !same(membership, manifest.assignment) ||
        (membership.controlState !== undefined && membership.controlState !== "active") ||
        membership.requestedSuccessorMemberId !== undefined ||
        records.some(
          (r) =>
            r.kind === "run-binding" &&
            r.taskId === task.taskId &&
            r.recordId !== binding.recordId &&
            (r.generation > binding.generation ||
              ["reserved", "running", "stopping"].includes(r.status)),
        )
      )
        return yield* deny("control-changed");
      const plans = records
        .filter(
          (r) =>
            r.kind === "plan-revision" &&
            r.taskId === task.taskId &&
            r.status === "proposed" &&
            r.specRevision === task.specRevision,
        )
        .sort(
          (a, b) =>
            (b.kind === "plan-revision" ? b.planRevision : 0) -
            (a.kind === "plan-revision" ? a.planRevision : 0),
        );
      const plan = plans[0]?.kind === "plan-revision" ? plans[0] : undefined;
      if (
        task.revision !== report.expectedTaskRevision ||
        task.specRevision !== report.specRevision ||
        (plan?.planRevision ?? 0) !== report.planRevision ||
        binding.scopeHash !== projectTeamScopeHash(state, task.taskId, plan)
      )
        return yield* deny("scope-changed");
      const dependencies = new Set(plan?.dependencyTaskIds ?? []);
      for (const relation of state.relationships) {
        if (relation.kind === "depends-on" && relation.fromTaskId === task.taskId)
          dependencies.add(relation.toTaskId);
        if (relation.kind === "blocks" && relation.toTaskId === task.taskId)
          dependencies.add(relation.fromTaskId);
      }
      for (const dependency of dependencies)
        if (
          !evaluateProjectTeamDependency({
            projectId: task.projectId,
            taskId: dependency,
            task: state.tasks.find((t) => t.taskId === dependency),
            memberships: records.filter((r) => r.kind === "task-membership"),
          }).available
        )
          return yield* deny("dependency-incomplete");
      for (const child of records.filter(
        (r) =>
          r.kind === "task-membership" && r.status === "active" && r.parentTaskId === task.taskId,
      )) {
        if (
          child.kind === "task-membership" &&
          !evaluateProjectTeamDependency({
            projectId: task.projectId,
            taskId: child.taskId,
            task: state.tasks.find((t) => t.taskId === child.taskId),
            memberships: records.filter((r) => r.kind === "task-membership"),
          }).available
        )
          return yield* deny("dependency-incomplete");
      }
      if (
        manifest.operation.operationId !== original.intent.request.assignmentOperationId ||
        manifest.operation.bindingId !== binding.recordId ||
        manifest.operation.generation !== binding.generation ||
        manifest.provenance.dispatchId !== original.fence.dispatchId ||
        manifest.provenance.memberId !== binding.memberId
      )
        return yield* deny("invalid-proof");
      const operations = yield* sql<{
        status: string;
        terminal_json: string | null;
      }>`SELECT status,CASE WHEN length(CAST(terminal_json AS BLOB))<=262144 THEN terminal_json END AS terminal_json FROM project_team_pi_operation WHERE operation_id=${manifest.operation.operationId} LIMIT 2`;
      if (
        operations.length === 0 ||
        (operations.length === 1 &&
          ["prepared", "starting", "running"].includes(operations[0]!.status))
      )
        return yield* deny("assignment-incomplete");
      if (
        operations.length !== 1 ||
        operations[0]!.status !== "settled" ||
        !operations[0]!.terminal_json
      )
        return yield* deny("assignment-failed");
      const decodedTerminal = yield* decodeJson(operations[0]!.terminal_json).pipe(Effect.result);
      if (decodedTerminal._tag === "Failure") return yield* deny("invalid-proof");
      const terminal = decodedTerminal.success;
      if (terminal.outcome !== "success") return yield* deny("assignment-failed");
      const assignment = yield* sessions
        .readAssignment(original)
        .pipe(
          Effect.catchTag("ProjectTeamSessionReceiptError", (error) =>
            error.code === "unavailable" ? Effect.fail(error) : Effect.succeed(undefined),
          ),
        );
      if (!assignment) return yield* deny("invalid-proof");
      if (
        assignment.requestHash !== manifest.assignmentRequestHash ||
        assignment.ordinal !== manifest.operation.ordinal ||
        assignment.identity.workerId !== manifest.operation.workerId ||
        assignment.operation.operationId !== manifest.operation.operationId ||
        assignment.native.sessionId !== manifest.provenance.sessionId
      )
        return yield* deny("invalid-proof");
      const target = yield* targets.readRetainedForDispatch(original).pipe(
        Effect.catchTag("ProjectTeamReviewTargetError", (error) =>
          staleTargetReasons.has(error.reason) ? Effect.succeed(undefined) : Effect.fail(error),
        ),
        Effect.catchTag("ProjectWorkVerificationGateError", (error) =>
          staleVerificationReasons.has(error.reason)
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
      if (!target) return yield* deny("stale-proof");
      const fresh = yield* freshness
        .readForSessionInTransaction({
          projectId: task.projectId,
          taskId: task.taskId,
          bindingId: binding.recordId,
          generation: binding.generation,
          providerInstanceId: binding.providerInstanceId,
          threadId: binding.threadId,
          sessionId: manifest.provenance.sessionId,
          specRevision: binding.specRevision,
          planRevision: binding.planRevision,
        })
        .pipe(
          Effect.catchTag("ProjectTeamReviewFreshnessError", (error) =>
            ["not-fresh", "conflict", "invalid-operation"].includes(error.reason)
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
      if (!fresh) return yield* deny("stale-proof");
      if (
        hash(target) !== manifest.provenance.targetSha256 ||
        target.prepared.sha256 !== manifest.prepared.sha256 ||
        target.prepared.manifest.jobId !== manifest.prepared.jobId ||
        target.verificationGate.recordId !== manifest.prepared.gateId ||
        target.verificationGate.revision !== manifest.prepared.gateRevision ||
        hash(target.verificationGate) !== manifest.prepared.gateSha256 ||
        fresh.operationId !== manifest.freshness.initializeOperationId ||
        fresh.contentSHA256 !== manifest.freshness.contentSHA256 ||
        fresh.briefingSHA256 !== manifest.freshness.briefingSHA256 ||
        hash(fresh.native) !== manifest.freshness.sessionSHA256
      )
        return yield* deny("stale-proof");
      if (report.criterionAssessments !== undefined) {
        const verification = yield* verificationResults
          .readInTransaction({
            jobId: manifest.prepared.jobId,
            expectedManifestHash: target.prepared.sha256,
          })
          .pipe(
            Effect.catchTag("ProjectWorkVerificationExecutionError", (error) =>
              error.reason === "Verification result manifest does not match expected target"
                ? Effect.succeed(undefined)
                : Effect.fail(error),
            ),
          );
        if (
          verification?._tag !== "Terminal" ||
          (report.criterionAssessments.some((a) => a.verdict === "met") &&
            (verification.result.outcome !== "success" || verification.result.exitCode !== 0))
        )
          return yield* deny("stale-proof");
        const originalApproval = verification.snapshot.intent.gate;
        const consumedApproval = records.find(
          (r) => r.recordId === target.verificationGate.recordId,
        );
        if (
          originalApproval.status !== "approved" ||
          originalApproval.consumedByRunId !== undefined ||
          originalApproval.consumedByCommandId !== undefined ||
          consumedApproval?.kind !== "gate" ||
          consumedApproval.status !== "consumed" ||
          consumedApproval.revision !== originalApproval.revision + 1 ||
          consumedApproval.consumedByRunId !== verification.snapshot.attemptId ||
          !consumedApproval.consumedByCommandId ||
          !same(approvalContent(consumedApproval), approvalContent(originalApproval))
        )
          return yield* deny("stale-proof");
        const assessments = yield* snapshotReviewCriterionAssessments({
          assessments: report.criterionAssessments,
          state,
          target: manifest.target,
          prepared: target.prepared.manifest,
        }).pipe(
          Effect.catchTag("ProjectTeamReviewCriterionAssessmentError", (error) =>
            [
              "Assessment parent scope is unavailable",
              "Assessment requires an exact selected parent criterion revision",
              "An open critical finding prevents a positive assessment",
              "Assessment evidence is unavailable, foreign or stale",
            ].includes(error.reason)
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
        if (assessments === undefined || !same(assessments, manifest.criterionAssessments))
          return yield* deny("stale-proof");
        if (Option.isNone(currentTarget))
          return yield* fail("Current review target service is unavailable");
        const targetCurrent = yield* currentTarget.value
          .assertInTransaction({
            snapshot: original,
            jobId: manifest.prepared.jobId,
            manifestHash: target.prepared.sha256,
          })
          .pipe(
            Effect.as(true),
            Effect.catchTag("ProjectTeamReviewCurrentTargetError", (error) =>
              error.reason === "changed" &&
              error.detail === "Current committed review target changed"
                ? Effect.succeed(false)
                : Effect.fail(error),
            ),
          );
        if (!targetCurrent) return yield* deny("stale-proof");
      }
      for (const prior of records.filter(
        (r) => r.kind === "run-binding" && r.taskId === manifest.target.taskId,
      )) {
        if (prior.kind !== "run-binding") continue;
        const oldRoles = records.filter((r) => r.recordId === prior.roleRevisionId);
        if (oldRoles.length !== 1 || oldRoles[0]?.kind !== "role-revision")
          return yield* deny("invalid-proof");
        if (
          ["implementer", "integrator"].includes(oldRoles[0].role) &&
          (prior.memberId === binding.memberId ||
            prior.recordId === binding.recordId ||
            prior.threadId === binding.threadId ||
            (prior.sessionId !== undefined &&
              prior.providerInstanceId === binding.providerInstanceId &&
              prior.sessionId === manifest.provenance.sessionId))
        )
          return yield* deny("invalid-proof");
      }
      const criteria = state.criteria
        .filter(
          (c) =>
            c.taskId === task.taskId &&
            (c.required || task.specification?.criterionIds.includes(c.criterionId)),
        )
        .map((c) => ({ id: c.criterionId, revision: c.revision, sha256: hash(c) }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const evidence = state.evidence
        .filter(
          (e) =>
            e.taskId === task.taskId &&
            new Set([...report.evidenceIds, ...report.outputArtifactIds]).has(e.evidenceId),
        )
        .map((e) => ({ id: e.evidenceId, revision: e.revision, sha256: hash(e) }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const findings = records
        .flatMap((r) =>
          r.kind === "review-finding" &&
          r.taskId === manifest.target.taskId &&
          same(r.target, manifest.target)
            ? [{ findingId: r.findingId, revision: r.revision, sha256: hash(r) }]
            : [],
        )
        .sort((a, b) => a.findingId.localeCompare(b.findingId));
      const outputs = (report.outputs ?? []).map((output, index) => ({
        evidenceId: projectTeamDerivedRecordId(report.commandId, `report-output:${index}`),
        criterionId: output.criterionId,
        sha256: hash({
          ...output,
          summary:
            output.summary ??
            state.criteria.find(
              (c) => c.criterionId === output.criterionId && c.taskId === task.taskId,
            )?.description,
        }),
      }));
      if (
        !same(criteria, manifest.criteria) ||
        !same(evidence, manifest.evidence) ||
        !same(findings, manifest.findings) ||
        !same(outputs, manifest.outputs) ||
        manifest.reportEvidenceId !==
          projectTeamDerivedRecordId(report.commandId, "report-evidence") ||
        manifest.reportCommentId !== projectTeamDerivedRecordId(report.commandId, "report")
      )
        return yield* deny("stale-proof");
      const batches =
        yield* sql`SELECT environment_id,project_id,dispatch_id,binding_id,generation,system_text_sha256,CASE WHEN length(CAST(system_text AS BLOB))<=65536 THEN system_text END AS system_text FROM project_team_mailbox_batch WHERE operation_id=${manifest.operation.operationId} LIMIT 2`;
      const batch = batches[0];
      const inputRows =
        yield* sql`SELECT * FROM project_team_mailbox_input WHERE operation_id=${manifest.operation.operationId} LIMIT 257`;
      const decodedInputs = yield* decodeInputs(inputRows).pipe(Effect.result);
      if (decodedInputs._tag === "Failure") return yield* deny("invalid-proof");
      const inputs = decodedInputs.success;
      if (
        batches.length !== 1 ||
        !batch ||
        batch.environment_id !== options.environmentId ||
        batch.project_id !== task.projectId ||
        batch.dispatch_id !== original.fence.dispatchId ||
        batch.binding_id !== binding.recordId ||
        batch.generation !== binding.generation ||
        typeof batch.system_text !== "string" ||
        digest(batch.system_text) !== batch.system_text_sha256 ||
        inputs.length === 0 ||
        inputs.length !== assignment.terminal.accountingReceipts.length
      )
        return yield* deny("invalid-proof");
      for (const input of inputs) {
        const accounting = assignment.terminal.accountingReceipts.filter(
          (r) => r.reservationId === input.reservation_id,
        );
        const entry = accounting[0];
        if (
          accounting.length !== 1 ||
          !entry ||
          input.worker_id !== manifest.operation.workerId ||
          input.generation !== binding.generation ||
          input.request_id !== entry.requestId ||
          input.route_id !== entry.routeId ||
          input.provider !== entry.provider ||
          input.model !== entry.model ||
          input.system_text_sha256 !== batch.system_text_sha256
        )
          return yield* deny("invalid-proof");
      }
      const joinedEvidence = joined.evidence;
      if (
        joinedEvidence.version !== 1 ||
        joinedEvidence.dispatchId !== original.fence.dispatchId ||
        joinedEvidence.bindingId !== binding.recordId ||
        joinedEvidence.generation !== binding.generation ||
        joinedEvidence.claimGeneration !== original.fence.claimGeneration ||
        !Array.isArray(joinedEvidence.operations)
      )
        return yield* deny("invalid-proof");
      const matching = joinedEvidence.operations.filter(
        (operation) =>
          typeof operation === "object" &&
          operation !== null &&
          !Array.isArray(operation) &&
          operation.operationId === assignment.operation.operationId,
      );
      const observed = matching[0];
      if (
        matching.length !== 1 ||
        typeof observed !== "object" ||
        observed === null ||
        Array.isArray(observed) ||
        !same(observed.owner, assignment.owner)
      )
        return yield* deny("invalid-proof");
      const reconciliation = observed.reconciliation;
      if (
        typeof reconciliation !== "object" ||
        reconciliation === null ||
        Array.isArray(reconciliation) ||
        reconciliation.state !== "drained" ||
        reconciliation.unit !== assignment.owner.unit ||
        reconciliation.invocation !== assignment.owner.invocation ||
        reconciliation.cgroup !== assignment.owner.cgroup ||
        typeof reconciliation.kernel !== "string" ||
        (reconciliation.kernel !== "removed" &&
          (!/^populated 0$/mu.test(reconciliation.kernel) ||
            /^populated 1$/mu.test(reconciliation.kernel)))
      )
        return yield* deny("invalid-proof");
      return yield* decodeProof({
        status: "completed",
        proposalCommandId: report.commandId,
        proposalSha256: receipt.sha256,
        assignmentOperationId: manifest.operation.operationId,
        assignmentRequestHash: manifest.assignmentRequestHash,
        assignmentReceiptSha256: hash(assignment),
        joinedReceiptId: joined.receiptId,
        joinedEvidenceSha256: hash(joined.evidence),
        report,
        reportAttribution: manifest.attribution,
        assignment: manifest.assignment,
        target: manifest.target,
        provenance: manifest.provenance,
        criteria: manifest.criteria,
        evidence: manifest.evidence,
        outputs: manifest.outputs,
        reportEvidenceId: manifest.reportEvidenceId,
        reportCommentId: manifest.reportCommentId,
        findings: manifest.findings,
      });
    });
    return {
      prepare: (
        snapshot: ProjectTeamDispatchSnapshot,
        joinedReceipt: ProjectTeamDispatchStageReceipt,
      ) => {
        let owned: ProjectTeamDispatchSnapshot;
        let joined: ProjectTeamDispatchStageReceipt;
        try {
          owned = structuredClone(snapshot);
          joined = structuredClone(joinedReceipt);
          if (!same(owned, decodeSnapshot(owned)) || !same(joined, decodeJoin(joined)))
            return Effect.fail(fail("Invalid completion input"));
        } catch {
          return Effect.fail(fail("Invalid completion input"));
        }
        return Effect.gen(function* () {
          yield* caller;
          return yield* prepareInside(owned, joined).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(ProjectWorkRepository, repository),
          );
        });
      },
    };
  });
};
