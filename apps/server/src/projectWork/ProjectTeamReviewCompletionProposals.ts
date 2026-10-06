import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectTeamCredential,
  ProjectTeamGuidedIntent,
  ProjectTeamTaskMembership,
  ProjectTeamRunBinding,
  ProjectTeamRoleRevision,
  ProjectTeamReviewFinding,
  ProjectTeamReviewFindingProvenance,
  ProjectWorkActor,
  ProjectWorkAttribution,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkCriterion,
  ProjectWorkEvidence,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectTeamAuthority, ProjectTeamPrincipal } from "./ProjectTeamAuthorization.ts";
import { makeProjectTeamReviewQualification } from "./ProjectTeamReviewQualification.ts";
import { projectTeamDerivedRecordId, projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import {
  ProjectWorkContentGuard,
  assertProjectWorkContentSafe,
} from "./ProjectWorkContentGuard.ts";
import { PiNativeReference } from "../provider/pi/PiWorkerProtocol.ts";
import { PiManagedProcessAllocationSchema } from "../provider/pi/PiManagedProcess.ts";

const strict = { onExcessProperty: "error" } as const;
const Id = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isTrimmed(),
  Schema.makeFilter((value) => !value.includes("\0")),
);
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Positive = Safe.check(Schema.isGreaterThan(0));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const ProjectTeamReviewReportOperationFacts = Schema.Struct({
  environmentId: Id,
  projectId: Id,
  reviewTaskId: Id,
  bindingId: Id,
  generation: Safe,
  providerInstanceId: Id,
  threadId: Id,
  operationId: Id,
  operationKind: Schema.Literal("prompt"),
  workerId: Id,
  ordinal: Safe,
});
export class ProjectTeamReviewReportOperation extends Context.Service<
  ProjectTeamReviewReportOperation,
  typeof ProjectTeamReviewReportOperationFacts.Type
>()("t3/projectWork/ProjectTeamReviewCompletionProposals/ProjectTeamReviewReportOperation") {}
export class ProjectTeamReviewCompletionProposalError extends Schema.TaggedError<ProjectTeamReviewCompletionProposalError>()(
  "ProjectTeamReviewCompletionProposalError",
  { reason: Schema.String },
) {}
const deny = (reason: string) => new ProjectTeamReviewCompletionProposalError({ reason });
const isProposalError = Schema.is(ProjectTeamReviewCompletionProposalError);
const Principal = Schema.Struct({
  actor: ProjectWorkActor,
  managed: Schema.optionalKey(ProjectTeamCredential),
});
const Report = ProjectTeamGuidedIntent.check(
  Schema.makeFilter(
    (value) => value.type === "project-team.assignment.report" && value.outcome === "complete",
  ),
);
type CompleteReport = Extract<ProjectTeamGuidedIntent, { type: "project-team.assignment.report" }>;
const decodePrincipal = Schema.decodeUnknownSync(Principal, strict);
const decodeReport = Schema.decodeUnknownSync(Report, strict);
const decodeAttribution = Schema.decodeUnknownSync(ProjectWorkAttribution, strict);
const decodeOperation = Schema.decodeUnknownSync(ProjectTeamReviewReportOperationFacts, strict);
const ReadInput = Schema.Struct({ environmentId: Id, projectId: Id, commandId: Id });
const decodeReadInput = Schema.decodeUnknownSync(ReadInput, strict);
const canonical = canonicalProjectWorkPayload;
const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) => digest(canonical(value));
const exact = <A>(value: unknown, decode: (value: unknown) => A) => {
  const copy: unknown = structuredClone(value);
  const owned = decode(copy);
  if (canonical(copy) !== canonical(owned)) throw deny("Input changed during decoding");
  return owned;
};
const Snapshot = Schema.Struct({ id: Id, revision: Safe, sha256: Digest });
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  report: Report,
  attribution: ProjectWorkAttribution,
  operation: ProjectTeamReviewReportOperationFacts,
  assignmentRequestHash: Digest,
  provenance: ProjectTeamReviewFindingProvenance,
  target: ProjectTeamReviewFinding.fields.target,
  prepared: Schema.Struct({
    jobId: Id,
    sha256: Digest,
    gateId: Id,
    gateRevision: Safe,
    gateSha256: Digest,
  }),
  freshness: Schema.Struct({
    initializeOperationId: Id,
    contentSHA256: Digest,
    briefingSHA256: Digest,
    sessionSHA256: Digest,
  }),
  assignment: ProjectTeamTaskMembership,
  criteria: Schema.Array(Snapshot).check(Schema.isMaxLength(64)),
  evidence: Schema.Array(Snapshot).check(Schema.isMaxLength(128)),
  outputs: Schema.Array(Schema.Struct({ evidenceId: Id, criterionId: Id, sha256: Digest })).check(
    Schema.isMaxLength(64),
  ),
  reportEvidenceId: Id,
  reportCommentId: Id,
  findings: Schema.Array(Schema.Struct({ findingId: Id, revision: Safe, sha256: Digest })).check(
    Schema.isMaxLength(256),
  ),
});
export type ProjectTeamReviewCompletionProposalManifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownSync(Manifest, strict);
const decodeStoredManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest), strict);
const Limits = Schema.Struct({ maximumTokens: Positive, deadlineAtMs: Positive });
const Request = Schema.Struct({
  kind: Schema.Literal("prompt"),
  operationId: Id,
  threadId: Id,
  prompt: Schema.String.check(
    Schema.isMinLength(1),
    Schema.makeFilter((v) => Buffer.byteLength(v) <= 131072),
  ),
  runtimeMode: Schema.optionalKey(Schema.Literal("approval-required")),
  cwd: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(Schema.JsonObject),
  resumeCursor: PiNativeReference,
  skillPlan: Schema.optionalKey(Schema.JsonObject),
});
const OperationIntent = Schema.Struct({
  request: Request,
  binding: ProjectTeamRunBinding,
  role: ProjectTeamRoleRevision,
  allocation: PiManagedProcessAllocationSchema,
  resourceHash: Digest,
  rootBudget: Schema.Struct({ rootTaskId: Id, ...Limits.fields }),
  operationLimits: Limits,
});
const decodeOperationIntent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OperationIntent),
  strict,
);
const decodeAllocation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PiManagedProcessAllocationSchema),
  strict,
);
const Owner = Schema.Struct({
  type: Schema.Literal("owner"),
  unit: Id,
  nonce: Id,
  invocation: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  cgroup: Schema.String,
  pid: Positive,
  memoryBytes: Positive,
  swapBytes: Schema.Literal(0),
  oomGroup: Schema.Literal(1),
});
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(Owner), strict);
const decodeCriterion = Schema.decodeUnknownSync(ProjectWorkCriterion, strict);
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
const decodeFinding = Schema.decodeUnknownSync(ProjectTeamReviewFinding, strict);
const RootIntent = Schema.Struct({
  resourceHash: Digest,
  allocation: PiManagedProcessAllocationSchema,
  rootBudget: Schema.Struct({ rootTaskId: Id, ...Limits.fields }),
});
const decodeRootIntent = Schema.decodeUnknownEffect(Schema.fromJsonString(RootIntent));
const sameBinding = (value: typeof ProjectTeamRunBinding.Type) => {
  const {
    revision: _revision,
    status: _status,
    updatedAt: _at,
    sessionId: _session,
    ...immutable
  } = value;
  return canonical(immutable);
};
const sameRole = (value: typeof ProjectTeamRoleRevision.Type) => {
  const { revision: _revision, status: _status, updatedAt: _at, ...immutable } = value;
  return canonical(immutable);
};

/** Pending reports retain original custody, without completing work or granting verification. */
export const makeProjectTeamReviewCompletionProposals = <E, R>(
  resolveAuthority: (
    principal: ProjectTeamPrincipal,
  ) => Effect.Effect<ProjectTeamAuthority | undefined, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const qualification = yield* makeProjectTeamReviewQualification(resolveAuthority);
    const contentGuard = yield* Effect.serviceOption(ProjectWorkContentGuard);
    const assertSafe = (value: unknown) =>
      Option.isSome(contentGuard)
        ? contentGuard.value.assertSafe(value)
        : Effect.try({
            try: () => assertProjectWorkContentSafe(value),
            catch: () => deny("Review proposal contains unsafe retained content"),
          });
    const requireTransaction = Effect.gen(function* () {
      const supplied = yield* Effect.serviceOption(SqlClient.SqlClient);
      if (
        Option.isNone(supplied) ||
        supplied.value !== sql ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny("Review proposals require their original caller transaction");
    });
    const readInside = Effect.fn("ProjectTeamReviewCompletionProposals.readInside")(function* (
      input: typeof ReadInput.Type,
    ) {
      const rows =
        yield* sql`SELECT environment_id,project_id,command_id,dispatch_id,binding_id,generation,review_task_id,parent_task_id,assignment_operation_id,assignment_request_hash,sha256,
      CASE WHEN length(CAST(manifest_json AS BLOB))<=524288 THEN manifest_json END AS manifest_json
      FROM project_team_review_completion_proposal WHERE environment_id=${input.environmentId} AND project_id=${input.projectId} AND command_id=${input.commandId} LIMIT 2`;
      if (rows.length === 0) return undefined;
      if (rows.length !== 1) return yield* deny("Review proposal identity is ambiguous");
      const row = rows[0]!;
      if (typeof row.manifest_json !== "string" || Buffer.byteLength(row.manifest_json) > 524288)
        return yield* deny("Review proposal exceeds its bound");
      const manifest = yield* Effect.try({
        try: () => decodeStoredManifest(row.manifest_json),
        catch: () => deny("Review proposal manifest is invalid"),
      });
      if (
        manifest.report.type !== "project-team.assignment.report" ||
        canonical(manifest) !== row.manifest_json ||
        digest(row.manifest_json) !== row.sha256 ||
        manifest.operation.environmentId !== row.environment_id ||
        manifest.report.projectId !== row.project_id ||
        manifest.operation.projectId !== row.project_id ||
        manifest.target.projectId !== row.project_id ||
        manifest.assignment.projectId !== row.project_id ||
        manifest.report.commandId !== row.command_id ||
        manifest.provenance.dispatchId !== row.dispatch_id ||
        manifest.operation.bindingId !== row.binding_id ||
        manifest.provenance.bindingId !== row.binding_id ||
        manifest.operation.generation !== row.generation ||
        manifest.provenance.generation !== row.generation ||
        manifest.operation.reviewTaskId !== row.review_task_id ||
        manifest.report.taskId !== row.review_task_id ||
        manifest.provenance.reviewTaskId !== row.review_task_id ||
        manifest.assignment.taskId !== row.review_task_id ||
        manifest.target.taskId !== row.parent_task_id ||
        manifest.assignment.parentTaskId !== row.parent_task_id ||
        manifest.assignment.recordId !== manifest.report.assignmentId ||
        manifest.assignment.revision !== manifest.report.expectedAssignmentRevision ||
        manifest.provenance.providerInstanceId !== manifest.operation.providerInstanceId ||
        manifest.provenance.threadId !== manifest.operation.threadId ||
        manifest.provenance.initializeOperationId !== manifest.freshness.initializeOperationId ||
        manifest.operation.operationId !== row.assignment_operation_id ||
        manifest.assignmentRequestHash !== row.assignment_request_hash ||
        row.environment_id !== input.environmentId ||
        row.project_id !== input.projectId ||
        row.command_id !== input.commandId
      )
        return yield* deny("Review proposal immutable identity or hash changed");
      return { manifest, sha256: digest(row.manifest_json) };
    });
    const scope = Effect.fn("ProjectTeamReviewCompletionProposals.scope")(function* (
      principal: ProjectTeamPrincipal,
      report: CompleteReport,
      attribution: ProjectWorkAttribution,
      operation: typeof ProjectTeamReviewReportOperationFacts.Type,
      duplicate: boolean,
    ) {
      const qualified = yield* qualification.qualify({
        principal,
        attribution,
        projectId: report.projectId,
        reviewTaskId: report.taskId,
        specRevision: report.specRevision,
        planRevision: report.planRevision,
        expectedTaskRevision: report.expectedTaskRevision,
        expectedProjectRevision: report.expectedRevision,
        duplicate,
      });
      const { authority, original, retained, fresh, target, provenance } = qualified;
      const { binding, state, role } = authority;
      if (
        canonical(operation) !==
          canonical({
            environmentId: binding.environmentId,
            projectId: binding.projectId,
            reviewTaskId: binding.taskId,
            bindingId: binding.recordId,
            generation: binding.generation,
            providerInstanceId: binding.providerInstanceId,
            threadId: binding.threadId,
            operationId: original.intent.request.assignmentOperationId,
            operationKind: "prompt",
            workerId: operation.workerId,
            ordinal: operation.ordinal,
          }) ||
        (original.fence.stage !== "assignment-intent" &&
          original.fence.stage !== "assignment-observed")
      )
        return yield* deny("Report is not the original live assignment operation");
      const rows =
        yield* sql`SELECT operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,operation_ordinal,operation_kind,status,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,terminal_json,
      CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent_json
      FROM project_team_pi_operation WHERE operation_id=${operation.operationId} LIMIT 2`;
      const row = rows[0];
      if (
        rows.length !== 1 ||
        !row ||
        row.status !== "running" ||
        row.terminal_json !== null ||
        row.operation_kind !== "prompt" ||
        row.environment_id !== operation.environmentId ||
        row.project_id !== operation.projectId ||
        row.binding_id !== operation.bindingId ||
        row.generation !== operation.generation ||
        row.provider_instance_id !== operation.providerInstanceId ||
        row.thread_id !== operation.threadId ||
        row.worker_id !== operation.workerId ||
        row.operation_ordinal !== operation.ordinal ||
        typeof row.intent_json !== "string"
      )
        return yield* deny("Original prompt custody is unavailable");
      const intent = yield* decodeOperationIntent(row.intent_json);
      if (
        canonical(intent) !== row.intent_json ||
        hash(intent.request) !== row.request_hash ||
        intent.request.operationId !== operation.operationId ||
        intent.request.threadId !== binding.threadId ||
        intent.request.prompt !== original.intent.request.assignment ||
        (intent.request.cwd !== undefined && intent.request.cwd !== binding.worktree)
      )
        return yield* deny("Original prompt request changed");
      if (
        canonical(intent.request.resumeCursor) !== canonical(fresh.native) ||
        sameBinding(intent.binding) !== sameBinding(binding) ||
        intent.binding.sessionId !== binding.sessionId ||
        sameRole(intent.role) !== sameRole(role)
      )
        return yield* deny("Original prompt binding or initialized session changed");
      if (
        row.root_task_id !== original.intent.limits.rootTaskId ||
        intent.rootBudget.rootTaskId !== row.root_task_id ||
        intent.rootBudget.maximumTokens !== original.intent.limits.maximumTokens ||
        intent.rootBudget.deadlineAtMs !== original.intent.limits.rootDeadlineAtMs ||
        intent.operationLimits.maximumTokens !== row.maximum_tokens ||
        intent.operationLimits.deadlineAtMs !== row.deadline_at_ms ||
        !Number.isSafeInteger(row.maximum_tokens) ||
        !Number.isSafeInteger(row.deadline_at_ms) ||
        Number(row.maximum_tokens) <= 0 ||
        Number(row.maximum_tokens) > original.intent.limits.attemptMaximumTokens ||
        Number(row.deadline_at_ms) > original.intent.limits.deadlineAtMs ||
        Number(row.deadline_at_ms) <= (yield* Clock.currentTimeMillis)
      )
        return yield* deny("Original prompt frozen budget changed");
      if (intent.allocation.launch.nativeStateRoot + "/sessions" !== fresh.sessionDirectoryRoot)
        return yield* deny("Original prompt native custody root changed");
      const rootBindings =
        state.foundationRecords?.filter(
          (r) =>
            r.kind === "run-binding" &&
            r.recordId === row.root_binding_id &&
            r.taskId === row.root_task_id,
        ) ?? [];
      if (rootBindings.length !== 1) return yield* deny("Original root binding is missing");
      const budgetRows =
        yield* sql`SELECT maximum_tokens,deadline_at_ms FROM project_team_model_budget WHERE environment_id=${binding.environmentId} AND project_id=${binding.projectId} AND root_task_id=${original.intent.limits.rootTaskId} LIMIT 2`;
      if (
        budgetRows.length !== 1 ||
        budgetRows[0]?.maximum_tokens !== intent.rootBudget.maximumTokens ||
        budgetRows[0]?.deadline_at_ms !== intent.rootBudget.deadlineAtMs
      )
        return yield* deny("Original root reservation changed");
      const initialRows =
        yield* sql`SELECT operation_ordinal,CASE WHEN length(CAST(intent_json AS BLOB))<=1048576 THEN intent_json END AS intent_json FROM project_team_pi_operation WHERE operation_id=${fresh.operationId} LIMIT 2`;
      if (
        initialRows.length !== 1 ||
        typeof initialRows[0]?.intent_json !== "string" ||
        Number(initialRows[0].operation_ordinal) + 1 !== operation.ordinal
      )
        return yield* deny("Prompt is not the first assignment after initialization");
      const initial = yield* decodeRootIntent(initialRows[0].intent_json);
      if (
        intent.resourceHash !== initial.resourceHash ||
        intent.allocation.launch.nativeStateRoot !== initial.allocation.launch.nativeStateRoot ||
        canonical(intent.rootBudget) !== canonical(initial.rootBudget)
      )
        return yield* deny("Original initialization resources changed");
      const processes =
        yield* sql`SELECT unit,status,CASE WHEN length(CAST(allocation_json AS BLOB))<=262144 THEN allocation_json END AS allocation_json,
      CASE WHEN length(CAST(owner_json AS BLOB))<=8192 THEN owner_json END AS owner_json FROM project_team_pi_process WHERE operation_id=${operation.operationId} LIMIT 2`;
      const process = processes[0];
      if (
        processes.length !== 1 ||
        !process ||
        process.status !== "captured" ||
        typeof process.allocation_json !== "string" ||
        typeof process.owner_json !== "string"
      )
        return yield* deny("Original prompt process ownership is unavailable");
      const allocation = yield* decodeAllocation(process.allocation_json);
      const owner = yield* decodeOwner(process.owner_json);
      if (
        canonical(allocation) !== process.allocation_json ||
        canonical(allocation) !== canonical(intent.allocation) ||
        canonical(owner) !== process.owner_json ||
        process.unit !== allocation.unit ||
        owner.unit !== allocation.unit ||
        owner.nonce !== allocation.nonce ||
        owner.memoryBytes !== allocation.policy.memoryBytes ||
        !owner.cgroup.startsWith("/sys/fs/cgroup/") ||
        !owner.cgroup.endsWith("/" + allocation.unit) ||
        owner.cgroup.split("/").some((part) => part === "." || part === "..")
      )
        return yield* deny("Original prompt process custody changed");
      const records = state.foundationRecords ?? [];
      const memberships = records.filter(
        (r) => r.kind === "task-membership" && r.taskId === binding.taskId,
      );
      const assignment = memberships[0];
      if (
        memberships.length !== 1 ||
        assignment?.kind !== "task-membership" ||
        assignment.recordId !== report.assignmentId ||
        assignment.revision !== report.expectedAssignmentRevision ||
        assignment.executionKind !== "managed" ||
        assignment.deliverableKind !== "review" ||
        assignment.status !== "active" ||
        (assignment.controlState !== undefined && assignment.controlState !== "active") ||
        assignment.parentTaskId !== target.taskId
      )
        return yield* deny("Original review membership changed");
      const task = state.tasks.find((t) => t.taskId === binding.taskId)!;
      const plan = records
        .filter(
          (r) => r.kind === "plan-revision" && r.taskId === task.taskId && r.status === "proposed",
        )
        .sort(
          (a, b) =>
            (b.kind === "plan-revision" ? b.planRevision : 0) -
            (a.kind === "plan-revision" ? a.planRevision : 0),
        )[0];
      const currentPlan = plan?.kind === "plan-revision" ? plan : undefined;
      const scopeHash = projectTeamScopeHash(state, task.taskId, currentPlan);
      if (
        task.specRevision !== report.specRevision ||
        (currentPlan?.planRevision ?? 0) !== report.planRevision ||
        binding.scopeHash !== scopeHash
      )
        return yield* deny("Report scope changed");
      if (
        new Set(report.evidenceIds).size !== report.evidenceIds.length ||
        new Set(report.outputArtifactIds).size !== report.outputArtifactIds.length ||
        new Set((report.outputs ?? []).map((o) => o.criterionId)).size !==
          (report.outputs ?? []).length
      )
        return yield* deny("Report evidence or output identity is duplicated");
      const evidence = [];
      for (const id of new Set([...report.evidenceIds, ...report.outputArtifactIds])) {
        const matches = state.evidence.filter(
          (e) => e.evidenceId === id && e.taskId === task.taskId,
        );
        const entry = matches[0];
        if (
          matches.length !== 1 ||
          !entry ||
          entry.scopeHash !== scopeHash ||
          !entry.detail?.trim() ||
          (report.outputArtifactIds.includes(id) && entry.kind !== "artifact")
        )
          return yield* deny("Referenced report evidence is unavailable or stale");
        const decoded = exact(entry, decodeEvidence);
        evidence.push({ id, revision: decoded.revision, sha256: hash(decoded) });
      }
      const required = state.criteria.filter(
        (c) =>
          c.taskId === task.taskId &&
          (c.required || task.specification?.criterionIds.includes(c.criterionId)),
      );
      if (required.length === 0 || required.length > 64)
        return yield* deny("Review completion requires bounded child criteria");
      const criteria = required
        .map((c) => {
          const decoded = exact(c, decodeCriterion);
          return { id: decoded.criterionId, revision: decoded.revision, sha256: hash(decoded) };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      const outputs: Array<(typeof Manifest.Type)["outputs"][number]> = [];
      for (const [index, output] of (report.outputs ?? []).entries()) {
        const matches = state.criteria.filter(
          (c) => c.criterionId === output.criterionId && c.taskId === task.taskId,
        );
        if (matches.length !== 1 || !output.detail.trim())
          return yield* deny("Output requires an exact current child criterion");
        outputs.push({
          evidenceId: projectTeamDerivedRecordId(report.commandId, `report-output:${index}`),
          criterionId: output.criterionId,
          sha256: hash({ ...output, summary: output.summary ?? matches[0]!.description }),
        });
      }
      if (
        required.some(
          (c) =>
            c.status !== "waived" &&
            !outputs.some((o) => o.criterionId === c.criterionId) &&
            !state.evidence.some(
              (e) =>
                [...report.evidenceIds, ...report.outputArtifactIds].includes(e.evidenceId) &&
                e.taskId === task.taskId &&
                e.criterionId === c.criterionId,
            ),
        )
      )
        return yield* deny("Completion report does not cover every required child criterion");
      const findings = records.filter(
        (r) =>
          r.kind === "review-finding" &&
          r.taskId === target.taskId &&
          canonical(r.target) === canonical(target),
      );
      if (findings.length > 256) return yield* deny("Original target findings exceed their bound");
      const findingSnapshots = findings
        .flatMap((r) =>
          r.kind === "review-finding"
            ? [
                {
                  findingId: r.findingId,
                  revision: r.revision,
                  sha256: hash(exact(r, decodeFinding)),
                },
              ]
            : [],
        )
        .sort((a, b) => a.findingId.localeCompare(b.findingId));
      if (new Set(findingSnapshots.map((f) => f.findingId)).size !== findingSnapshots.length)
        return yield* deny("Original target findings are ambiguous");
      return {
        operation,
        assignmentRequestHash: String(row.request_hash),
        provenance,
        target,
        prepared: {
          jobId: retained.prepared.manifest.jobId,
          sha256: retained.prepared.sha256,
          gateId: retained.verificationGate.recordId,
          gateRevision: retained.verificationGate.revision,
          gateSha256: hash(retained.verificationGate),
        },
        freshness: {
          initializeOperationId: fresh.operationId,
          contentSHA256: fresh.contentSHA256,
          briefingSHA256: fresh.briefingSHA256,
          sessionSHA256: hash(fresh.native),
        },
        assignment,
        criteria,
        evidence: evidence.sort((a, b) => a.id.localeCompare(b.id)),
        outputs,
        reportEvidenceId: projectTeamDerivedRecordId(report.commandId, "report-evidence"),
        reportCommentId: projectTeamDerivedRecordId(report.commandId, "report"),
        findings: findingSnapshots,
      };
    });
    const processInside = Effect.fn("ProjectTeamReviewCompletionProposals.processInside")(
      function* (
        principal: ProjectTeamPrincipal,
        report: CompleteReport,
        attribution: ProjectWorkAttribution,
        operation: typeof ProjectTeamReviewReportOperationFacts.Type,
        insert: boolean,
        duplicate: boolean,
      ) {
        const retained = yield* readInside({
          environmentId: operation.environmentId,
          projectId: report.projectId,
          commandId: report.commandId,
        });
        if (duplicate && retained === undefined)
          return yield* deny("Original review proposal receipt is missing");
        yield* assertSafe(retained?.manifest ?? report);
        const current = yield* scope(
          principal,
          report,
          attribution,
          operation,
          duplicate || retained !== undefined,
        );
        if (retained) {
          const {
            version: _version,
            report: oldReport,
            attribution: oldAttribution,
            ...previous
          } = retained.manifest;
          if (
            canonical(oldReport) !== canonical(report) ||
            canonical(oldAttribution.actor) !== canonical(attribution.actor) ||
            canonical(oldAttribution.source) !== canonical(attribution.source) ||
            canonical(previous) !== canonical(current)
          )
            return yield* deny("Original review proposal input or qualified scope changed");
          return retained;
        }
        const manifest = yield* Effect.try({
          try: () => decodeManifest({ version: 1, report, attribution, ...current }),
          catch: () => deny("Invalid review proposal manifest"),
        });
        yield* assertSafe(manifest);
        const json = canonical(manifest);
        if (Buffer.byteLength(json) > 524288)
          return yield* deny("Review proposal exceeds its manifest bound");
        const receipt = { manifest, sha256: digest(json) };
        if (!insert) return receipt;
        yield* sql`INSERT INTO project_team_review_completion_proposal(environment_id,project_id,command_id,dispatch_id,binding_id,generation,review_task_id,parent_task_id,assignment_operation_id,assignment_request_hash,manifest_json,sha256)
      VALUES (${operation.environmentId},${report.projectId},${report.commandId},${current.provenance.dispatchId},${operation.bindingId},${operation.generation},${operation.reviewTaskId},${current.target.taskId},${operation.operationId},${current.assignmentRequestHash},${json},${receipt.sha256}) ON CONFLICT DO NOTHING`;
        const winner = yield* readInside({
          environmentId: operation.environmentId,
          projectId: report.projectId,
          commandId: report.commandId,
        });
        if (!winner || canonical(winner) !== canonical(receipt))
          return yield* deny("Review proposal conflicts with its immutable first winner");
        return winner;
      },
    );
    const guard = <A, Err, Req>(effect: Effect.Effect<A, Err, Req>) =>
      effect.pipe(
        Effect.mapError((error) =>
          isProposalError(error)
            ? error
            : deny("Review authority or original retained proof is unavailable"),
        ),
      );
    const captured = (
      principal: ProjectTeamPrincipal,
      input: ProjectTeamGuidedIntent,
      attribution: ProjectWorkAttribution,
      insert: boolean,
      duplicate: boolean,
    ) => {
      try {
        const ownedPrincipal = exact(principal, decodePrincipal);
        const report = exact(input, decodeReport);
        const ownedAttribution = exact(attribution, decodeAttribution);
        if (
          report.type !== "project-team.assignment.report" ||
          report.outcome !== "complete" ||
          typeof duplicate !== "boolean"
        )
          return Effect.fail(deny("Invalid complete review report"));
        return guard(
          Effect.gen(function* () {
            yield* requireTransaction;
            const supplied = yield* Effect.serviceOption(ProjectTeamReviewReportOperation);
            if (Option.isNone(supplied))
              return yield* deny("Original host report operation is required");
            // Snapshot the private context before the first authority or SQL await.
            const operation = yield* Effect.try({
              try: () => exact(supplied.value, decodeOperation),
              catch: () => deny("Invalid host report operation"),
            });
            if (ownedPrincipal.actor.kind !== "agent" || !ownedPrincipal.managed)
              return yield* deny(
                "Only an authenticated original managed reviewer can propose completion",
              );
            const receipt = yield* processInside(
              ownedPrincipal,
              report,
              ownedAttribution,
              operation,
              insert,
              duplicate,
            ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            return { receipt, report, attribution: ownedAttribution };
          }),
        );
      } catch {
        return Effect.fail(deny("Invalid review completion proposal input"));
      }
    };
    return {
      validate: (
        principal: ProjectTeamPrincipal,
        report: ProjectTeamGuidedIntent,
        attribution: ProjectWorkAttribution,
        options: { readonly duplicate: boolean },
      ) => captured(principal, report, attribution, false, options.duplicate).pipe(Effect.asVoid),
      compile: (
        principal: ProjectTeamPrincipal,
        report: ProjectTeamGuidedIntent,
        attribution: ProjectWorkAttribution,
      ) =>
        captured(principal, report, attribution, true, false).pipe(
          Effect.map(
            (owned) =>
              ({
                type: "project-work.foundation.commit",
                commandId: owned.report.commandId,
                projectId: owned.report.projectId,
                expectedRevision: owned.report.expectedRevision,
                attribution: owned.receipt.manifest.attribution,
                committedAt: owned.receipt.manifest.attribution.recordedAt,
                records: [],
              }) satisfies typeof ProjectWorkFoundationCommitCommand.Type,
          ),
        ),
      readRetained: (input: typeof ReadInput.Type) => {
        try {
          const owned = exact(input, decodeReadInput);
          return Effect.gen(function* () {
            yield* requireTransaction;
            return yield* readInside(owned).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          });
        } catch {
          return Effect.fail(deny("Invalid review proposal read identity"));
        }
      },
    };
  });
