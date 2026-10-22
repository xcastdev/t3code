import {
  ProjectWorkEvidenceId,
  type ProjectTeamDeliveryAcceptanceProof,
  type ProjectWorkCommand,
  type ProjectWorkEvidence,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
const rejected = () => new Journal.PublicationError({ reason: "not-ready" });
export function criterionSnapshots(
  state: ProjectWorkReducerState,
  taskId: string,
  scopeHash: string,
) {
  const criteria = state.criteria.filter((c) => c.taskId === taskId);
  if (criteria.some((c) => c.required && c.status !== "satisfied" && c.status !== "waived"))
    throw rejected();
  const ids = [...new Set(criteria.flatMap((c) => c.satisfiedByEvidenceIds))].sort();
  const support = ids.map((id) => {
    const evidence = state.evidence.find((e) => e.evidenceId === id);
    if (!evidence || evidence.taskId !== taskId || evidence.scopeHash !== scopeHash)
      throw rejected();
    return { evidenceId: evidence.evidenceId, sha256: Journal.publicationHash(evidence) };
  });
  if (criteria.some((c) => c.status === "satisfied" && c.satisfiedByEvidenceIds.length === 0))
    throw rejected();
  return {
    criteria: criteria.map((c) => ({
      criterionId: c.criterionId,
      sha256: Journal.publicationHash(c),
    })),
    support,
  };
}
export function assertDeliveryAcceptanceCurrent(
  state: ProjectWorkReducerState,
  proof: ProjectTeamDeliveryAcceptanceProof,
): void {
  const task = state.tasks.find((t) => t.taskId === proof.source.taskId);
  const gate = state.foundationRecords?.find(
    (r) => r.kind === "gate" && r.recordId === proof.gateId,
  );
  if (
    !task ||
    task.specRevision !== proof.source.specRevision ||
    task.activeAttemptId !== undefined ||
    state.attempts.some(
      (attempt) => attempt.taskId === task.taskId && ["leased", "running"].includes(attempt.state),
    ) ||
    ["completed", "canceled", "failed"].includes(task.state) ||
    !gate ||
    gate.kind !== "gate" ||
    gate.gate !== "merge" ||
    gate.status !== "approved" ||
    gate.taskId !== task.taskId ||
    Journal.publicationHash(gate) !== proof.gateSha256 ||
    gate.headSha !== proof.source.headSha ||
    state.foundationRecords?.some(
      (r) =>
        r.kind === "run-binding" &&
        r.taskId === task.taskId &&
        ["reserved", "running", "stopping", "quarantined"].includes(r.status),
    )
  )
    throw rejected();
  const snapshots = criterionSnapshots(state, task.taskId, proof.source.scopeHash);
  if (
    canonicalProjectWorkPayload(snapshots) !==
    canonicalProjectWorkPayload({ criteria: proof.criteria, support: proof.support })
  )
    throw rejected();
}
type AcceptanceCommand = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
export function prepareDeliveryAcceptanceEvidence(command: AcceptanceCommand): ProjectWorkEvidence {
  if (command.transition?.kind !== "delivery.accept") throw rejected();
  const proof = command.transition.proof;
  return {
    evidenceId: ProjectWorkEvidenceId.make(`delivery-acceptance:${proof.operationId}`),
    taskId: proof.source.taskId,
    kind: "observation",
    summary: "Reviewed delivery accepted",
    detail: canonicalProjectWorkPayload(proof),
    scopeHash: proof.source.scopeHash,
    recordedAt: command.committedAt,
    revision: 0,
    attribution: command.attribution,
  };
}
