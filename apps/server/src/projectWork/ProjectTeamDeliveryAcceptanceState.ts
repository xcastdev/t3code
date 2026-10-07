import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectTeamDeliveryAcceptanceProof,
  ProjectWorkEvidence,
  ProjectWorkEvidenceId,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import {
  ProjectWorkPolicyError,
  projectWorkCommandFingerprint,
  type ProjectWorkState,
} from "./ProjectWorkPolicy.ts";
import { staleSourceIndex } from "./ProjectTeamIntegrationSourceState.ts";
import { invalidateReviewCriterionProgress } from "./ProjectTeamReviewCriterionProgress.ts";

export const DELIVERY_ACCEPTANCE_PREFIX = "delivery-acceptance:";
export const DELIVERY_ACCEPTANCE_PRODUCER = "project-team-delivery-acceptance";
const canonical = canonicalProjectWorkPayload;
export const deliveryAcceptanceHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonical(value)).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
export const DeliveryAcceptanceDetail = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("project-team.delivery-acceptance"),
  commandId: CommandId,
  commandFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{8}$/u)),
  expectedRevision: Counter,
  expectedTaskRevision: Counter,
  proof: ProjectTeamDeliveryAcceptanceProof,
});
const decodeDetail = Schema.decodeUnknownSync(
  Schema.fromJsonString(DeliveryAcceptanceDetail),
  strict,
);
const decodeEvidence = Schema.decodeUnknownSync(ProjectWorkEvidence, strict);
const decodeProof = Schema.decodeUnknownSync(ProjectTeamDeliveryAcceptanceProof, strict);
const deny = (message: string): never => {
  throw new ProjectWorkPolicyError("authority-required", message);
};
const reducer = (state: ProjectWorkState) => ({
  projectId: state.projectId,
  revision: state.revision,
  tasks: state.tasks,
  attempts: state.attempts,
  criteria: state.criteria,
  evidence: state.evidence,
  relationships: state.relationships,
  blockers: state.blockers,
  attention: state.attention,
  foundationRecords: [...(state.foundationRecords ?? [])],
});
export const deliveryAcceptanceEvidenceId = (proof: ProjectTeamDeliveryAcceptanceProof) =>
  ProjectWorkEvidenceId.make(
    DELIVERY_ACCEPTANCE_PREFIX +
      deliveryAcceptanceHash({
        environmentId: proof.environmentId,
        operationId: proof.operationId,
        receiptSha256: proof.receiptSha256,
      }),
  );

/** Observe existing support, including human waiver bytes; never satisfy a criterion here. */
export function deliveryCriterionSnapshots(
  state: ProjectWorkState,
  source: ProjectTeamDeliveryAcceptanceProof["source"],
) {
  const criteria = state.criteria
    .filter((c) => c.taskId === source.taskId)
    .sort((a, b) => a.criterionId.localeCompare(b.criterionId));
  if (criteria.length > 64 || new Set(criteria.map((c) => c.criterionId)).size !== criteria.length)
    deny("Delivery criteria are ambiguous or exceed their bound");
  const staleProgress = invalidateReviewCriterionProgress({
    state: reducer(state),
    at: criteria[0]?.updatedAt ?? "1970-01-01T00:00:00.000Z",
  });
  if (staleProgress.some((event) => event.taskId === source.taskId))
    deny("Review criterion support is stale");
  const evidence = new Map(state.evidence.map((e) => [String(e.evidenceId), e]));
  const supportIds = new Set<string>();
  for (const criterion of criteria) {
    if (criterion.required) {
      if (criterion.status === "waived") {
        if (
          !criterion.waiver ||
          criterion.waiver.specRevision !== source.specRevision ||
          criterion.waiver.attribution.actor.kind !== "human"
        )
          deny("Required criterion has no current human waiver");
      } else if (criterion.status !== "satisfied" || criterion.satisfiedByEvidenceIds.length === 0)
        deny("Required criterion lacks qualified satisfaction");
    }
    for (const id of [
      ...criterion.satisfiedByEvidenceIds,
      ...(criterion.waiver?.evidenceIds ?? []),
    ]) {
      const matches = state.evidence.filter((e) => e.evidenceId === id);
      const item = matches[0];
      if (matches.length !== 1 || !item) return deny("Criterion support is unavailable");
      if (
        criterion.status !== "waived" &&
        (item.taskId !== source.taskId || item.scopeHash !== source.scopeHash)
      )
        deny("Criterion support belongs to another scope");
      const applicability = (state.foundationRecords ?? []).filter(
        (r) => r.kind === "evidence-applicability" && r.evidenceId === id,
      );
      if (applicability.some((r) => r.kind === "evidence-applicability" && r.status !== "current"))
        deny("Criterion verification support is stale");
      supportIds.add(id);
    }
  }
  if (supportIds.size > 128) deny("Delivery support exceeds its bound");
  return {
    criteria: criteria.map((c) => ({
      criterionId: c.criterionId,
      sha256: deliveryAcceptanceHash(c),
    })),
    support: [...supportIds].sort().map((id) => {
      const item = evidence.get(id);
      if (!item) return deny("Criterion evidence disappeared");
      return { evidenceId: item.evidenceId, sha256: deliveryAcceptanceHash(item) };
    }),
  };
}

export function assertDeliveryAcceptanceCurrent(
  state: ProjectWorkState,
  proof: ProjectTeamDeliveryAcceptanceProof,
) {
  const decoded = decodeProof(proof);
  if (
    canonical(decoded) !== canonical(proof) ||
    proof.sourceRef.taskId !== proof.source.taskId ||
    proof.sourceRef.bindingId !== proof.source.bindingId ||
    proof.sourceRef.verificationJobId !== proof.source.jobId ||
    proof.sourceRef.expectedManifestHash !== proof.source.manifestHash
  )
    deny("Delivery source association changed");
  if (staleSourceIndex(reducer(state))(proof.source)) deny("Delivered source is no longer current");
  const gates = (state.foundationRecords ?? []).filter((r) => r.recordId === proof.gateId);
  if (
    gates.length !== 1 ||
    gates[0]?.kind !== "gate" ||
    gates[0].gate !== "merge" ||
    gates[0].status !== "approved" ||
    gates[0].taskId !== proof.source.taskId ||
    deliveryAcceptanceHash(gates[0]) !== proof.gateSha256
  )
    deny("Original human merge approval changed");
  const snapshots = deliveryCriterionSnapshots(state, proof.source);
  if (
    canonical(snapshots.criteria) !== canonical(proof.criteria) ||
    canonical(snapshots.support) !== canonical(proof.support)
  )
    deny("Accepted criterion support changed");
  if (
    (state.foundationRecords ?? []).some(
      (r) =>
        r.kind === "run-binding" &&
        r.taskId === proof.source.taskId &&
        ["reserved", "running", "stopping", "quarantined"].includes(r.status),
    )
  )
    deny("A run still owns delivered work");
  if (
    state.attempts.some(
      (a) => a.taskId === proof.source.taskId && ["leased", "running"].includes(a.state),
    )
  )
    deny("An attempt still owns delivered work");
}

export function prepareDeliveryAcceptanceEvidence(
  command: Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>,
) {
  const transition = command.transition;
  if (transition?.kind !== "delivery.accept") return deny("Delivery transition is missing");
  const detail = canonical({
    version: 1,
    kind: "project-team.delivery-acceptance",
    commandId: command.commandId,
    commandFingerprint: projectWorkCommandFingerprint(command),
    expectedRevision: command.expectedRevision,
    expectedTaskRevision: transition.expectedTaskRevision,
    proof: transition.proof,
  });
  if (Buffer.byteLength(detail) > 32000) deny("Delivery association exceeds its byte bound");
  return decodeEvidence({
    evidenceId: deliveryAcceptanceEvidenceId(transition.proof),
    taskId: transition.proof.source.taskId,
    kind: "observation",
    summary: "Reviewed delivery was accepted",
    detail,
    scopeHash: transition.proof.source.scopeHash,
    recordedAt: command.committedAt,
    revision: 0,
    attribution: {
      actor: { kind: "system", id: DELIVERY_ACCEPTANCE_PRODUCER },
      source: { kind: "system", id: DELIVERY_ACCEPTANCE_PRODUCER },
      recordedAt: command.committedAt,
    },
  });
}

/** Pure association only. Authority consumers also audit the original SQL commands and delivery journal. */
export function readDeliveryAcceptance(
  state: ProjectWorkState,
  taskId: string,
  operationId?: string,
) {
  const matches = state.evidence.filter(
    (e) => e.taskId === taskId && e.evidenceId.startsWith(DELIVERY_ACCEPTANCE_PREFIX),
  );
  const retained = matches
    .map((evidence) => {
      if (!evidence.detail || Buffer.byteLength(evidence.detail) > 32000)
        return deny("Delivery association is unavailable");
      const detail = decodeDetail(evidence.detail);
      const attribution = evidence.attribution;
      if (
        canonical(detail) !== evidence.detail ||
        detail.proof.source.taskId !== taskId ||
        evidence.evidenceId !== deliveryAcceptanceEvidenceId(detail.proof) ||
        evidence.kind !== "observation" ||
        evidence.revision !== 0 ||
        evidence.scopeHash !== detail.proof.source.scopeHash ||
        attribution?.actor.kind !== "system" ||
        attribution.actor.id !== DELIVERY_ACCEPTANCE_PRODUCER ||
        attribution.source.kind !== "system" ||
        attribution.source.id !== DELIVERY_ACCEPTANCE_PRODUCER ||
        attribution.recordedAt !== evidence.recordedAt
      )
        return deny("Delivery association has no exact producer identity");
      return { evidence, detail };
    })
    .filter((retained) => {
      if (operationId !== undefined) return retained.detail.proof.operationId === operationId;
      const task = state.tasks.find((t) => t.taskId === taskId);
      if (task?.state !== "completed" || task.completedAt !== retained.evidence.recordedAt)
        return false;
      try {
        assertDeliveryAcceptanceCurrent(state, retained.detail.proof);
        return true;
      } catch {
        return false;
      }
    });
  const result = retained[0];
  if (retained.length > 1) deny("Delivery acceptance is ambiguous");
  return result;
}
export function isDeliveryAcceptedCurrent(state: ProjectWorkState, taskId: string) {
  try {
    const tasks = state.tasks.filter((t) => t.taskId === taskId);
    const retained = readDeliveryAcceptance(state, taskId);
    if (
      tasks.length !== 1 ||
      tasks[0]?.state !== "completed" ||
      !retained ||
      tasks[0].completedAt !== retained.evidence.recordedAt
    )
      return false;
    assertDeliveryAcceptanceCurrent(state, retained.detail.proof);
    return true;
  } catch {
    return false;
  }
}

/** Include ordinary relationships and the inherited plan of review/plan children. */
export function deliveryDependencyIds(state: ProjectWorkState, selectedTaskId: string) {
  const owners = new Set<string>(),
    dependencies = new Set<string>();
  let taskId: string | undefined = selectedTaskId;
  while (taskId !== undefined) {
    if (owners.has(taskId)) deny("Inherited dependency lineage is cyclic");
    owners.add(taskId);
    const plans = (state.foundationRecords ?? [])
      .filter((r) => r.kind === "plan-revision" && r.taskId === taskId && r.status === "proposed")
      .sort((a, b) =>
        a.kind === "plan-revision" && b.kind === "plan-revision"
          ? b.planRevision - a.planRevision
          : 0,
      );
    const plan = plans[0];
    if (plan?.kind === "plan-revision") {
      if (plans[1]?.kind === "plan-revision" && plans[1].planRevision === plan.planRevision)
        deny("Dependency plan is ambiguous");
      for (const id of plan.dependencyTaskIds) dependencies.add(id);
    }
    for (const relation of state.relationships) {
      if (relation.kind === "depends-on" && relation.fromTaskId === taskId)
        dependencies.add(relation.toTaskId);
      if (relation.kind === "blocks" && relation.toTaskId === taskId)
        dependencies.add(relation.fromTaskId);
    }
    const memberships = (state.foundationRecords ?? []).filter(
      (r) => r.kind === "task-membership" && r.taskId === taskId,
    );
    if (memberships.length > 1) deny("Dependency membership is ambiguous");
    const member = memberships[0];
    taskId =
      member?.kind === "task-membership" && ["plan", "review"].includes(member.deliverableKind)
        ? member.parentTaskId
        : undefined;
  }
  return [...dependencies].filter((id) => {
    const memberships = (state.foundationRecords ?? []).filter(
      (r) => r.kind === "task-membership" && r.taskId === id,
    );
    if (memberships.length > 1) deny("Dependency membership is ambiguous");
    const member = memberships[0];
    return (
      member?.kind === "task-membership" &&
      member.executionKind === "managed" &&
      member.deliverableKind === "code"
    );
  });
}
