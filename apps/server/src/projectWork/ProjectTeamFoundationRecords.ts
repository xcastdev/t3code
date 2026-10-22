import { assertProjectTeamQuestionUpdate } from "./ProjectTeamMailboxTurns.ts";
import { assertReviewFindingCurrent } from "./ProjectTeamReviewState.ts";
import {
  canonicalProjectWorkPayload,
  ProjectTeamRecord,
  type ProjectTeamRecord as TeamRecord,
  type ProjectWorkAttribution,
  type ProjectWorkTeamTransition,
} from "@t3tools/contracts";

import * as Schema from "effect/Schema";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import {
  projectTeamSpecificationHash,
  projectTeamPlanHash,
  assertProjectTeamAssignmentAuthorization,
} from "./ProjectTeamPolicy.ts";

const decodeTeamRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const reject = (message: string): never => {
  throw new ProjectWorkPolicyError("invalid-state", message);
};
const stable = (record: TeamRecord) => {
  const mutable = new Set(["status", "revision", "generation", "updatedAt"]);
  if (record.kind === "run-binding") mutable.add("sessionId");
  if (record.kind === "review-finding") {
    for (const field of [
      "severity",
      "criterionIds",
      "detail",
      "resolutionArtifactIds",
      "reportedBy",
    ])
      mutable.add(field);
  }
  if (record.kind === "gate") {
    mutable.add("attribution");
    mutable.add("consumedByRunId");
    mutable.add("consumedByCommandId");
  }
  if (record.kind === "message") {
    mutable.add("deliveryGeneration");
    mutable.add("deliveryCursor");
    mutable.add("acknowledgedAt");
    mutable.add("resolvedAt");
  }
  if (record.kind === "effect") {
    mutable.add("claimGeneration");
    mutable.add("availableAt");
    mutable.add("outcome");
  }
  if (record.kind === "memory-extraction") {
    mutable.add("completedObservationIds");
    mutable.add("error");
  }
  if (record.kind === "memory-observation") {
    mutable.add("supersedes");
    mutable.add("tombstonedAt");
  }
  return canonicalProjectWorkPayload(
    Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key))),
  );
};
export type ProjectTeamSemanticRepairResolution = {
  readonly episodeId: string;
  readonly priorRevision: number;
  readonly reviewerBindingId: string;
  readonly reviewerGeneration: number;
  readonly receiptId: string;
};
/** Foundation consistency only; session authorization and eligibility are separate gates. */
export const validateProjectTeamRecord = (
  state: ProjectWorkReducerState,
  input: TeamRecord,
  origin: ProjectWorkAttribution,
  consumption?: {
    readonly runId: string;
    readonly commandId: string;
    readonly inheritedGateId?: string;
  },
  settlement?: {
    readonly bindingId: string;
    readonly generation: number;
    readonly receiptId: string;
  },
  _memoryReflection?: Extract<ProjectWorkTeamTransition, { kind: "memory.reflect" }>,
  _publicationTransition?: Extract<
    ProjectWorkTeamTransition,
    { kind: "publication.claim" | "publication.reflect" }
  >,
  _reviewResolution?: Extract<ProjectWorkTeamTransition, { kind: "review.resolve" }>,
  semanticRepairResolution?: ProjectTeamSemanticRepairResolution,
): TeamRecord => {
  const r = decodeTeamRecord(input);
  const records = state.foundationRecords ?? [];
  if (!("projectId" in r) || r.projectId !== state.projectId)
    reject("Foundation record project does not match command");
  const old = records.find((entry) => entry.recordId === r.recordId);
  if (old !== undefined) {
    if (old.kind !== r.kind) reject("Record identity cannot change kind");
    if (r.revision !== old.revision + 1 || r.generation < old.generation)
      reject("Record revision/generation is stale");
    if (old.status === "retracted" && r.status !== "retracted")
      reject("Retracted memory cannot be resurrected");
    if (
      (r.kind === "role-revision" || r.kind === "plan-revision" || r.kind === "run-binding") &&
      stable(old) !== stable(r)
    )
      reject("Frozen revision/binding cannot change content");
  } else if (r.revision !== 0) reject("New records start at revision zero");
  const requireRecord = (id: string, kind: TeamRecord["kind"]) => {
    const found = records.find((entry) => entry.recordId === id && entry.kind === kind);
    if (found === undefined) reject(`Missing ${kind} '${id}'`);
    return found!;
  };
  if (
    "taskId" in r &&
    r.taskId !== undefined &&
    !state.tasks.some((entry) => entry.taskId === r.taskId)
  )
    reject("Unknown task in foundation record");
  switch (r.kind) {
    case "issue":
      if (
        old?.kind === "issue" &&
        canonicalProjectWorkPayload(old.identity) !== canonicalProjectWorkPayload(r.identity)
      )
        reject("Canonical issue identity is immutable");
      break;
    case "intake-cursor":
      if (
        old?.kind === "intake-cursor" &&
        (old.host !== r.host ||
          old.repositoryNodeId !== r.repositoryNodeId ||
          old.accountId !== r.accountId)
      )
        reject("Canonical cursor repository and account are immutable");
      break;
    case "mission":
      if (
        new Set(r.requiredTaskIds).size !== r.requiredTaskIds.length ||
        r.requiredTaskIds.some((id) => !state.tasks.some((t) => t.taskId === id))
      )
        reject("Mission requires unique known tasks");
      break;
    case "task-membership":
      if (
        records.some(
          (entry) =>
            entry.kind === "task-membership" &&
            entry.taskId === r.taskId &&
            entry.recordId !== r.recordId,
        )
      )
        reject("Task already has a durable membership");
      if (
        old?.kind === "task-membership" &&
        (old.taskId !== r.taskId ||
          old.executionKind !== r.executionKind ||
          old.deliverableKind !== r.deliverableKind ||
          old.parentTaskId !== r.parentTaskId)
      )
        reject("Task classification and lineage are immutable");
      if (
        old?.kind === "task-membership" &&
        old.rootConstraints !== undefined &&
        canonicalProjectWorkPayload(old.rootConstraints) !==
          canonicalProjectWorkPayload(r.rootConstraints)
      )
        reject("Frozen root constraints cannot change");
      if (r.rootConstraints !== undefined && r.parentTaskId !== undefined) {
        const parent = records.find(
          (entry) => entry.kind === "task-membership" && entry.taskId === r.parentTaskId,
        );
        if (
          parent?.kind !== "task-membership" ||
          canonicalProjectWorkPayload(parent.rootConstraints) !==
            canonicalProjectWorkPayload(r.rootConstraints)
        )
          reject("Child must inherit exact frozen root constraints");
      }
      if (r.missionId !== undefined) requireRecord(r.missionId, "mission");
      if (r.parentTaskId !== undefined && !state.tasks.some((t) => t.taskId === r.parentTaskId))
        reject("Unknown parent task");
      if (r.parentTaskId === r.taskId) reject("Task cannot be its own parent");
      if (r.assignment !== undefined) {
        const grant = requireRecord(r.assignment.authorizationGateId, "gate");
        if (
          grant.kind !== "gate" ||
          grant.taskId !== r.taskId ||
          (grant.gate !== "investigation" &&
            grant.gate !== "execution" &&
            grant.gate !== "repair" &&
            grant.gate !== "assignment")
        )
          reject("Assignment requires its exact task grant");
      }
      break;
    case "member":
      requireRecord(r.roleRevisionId, "role-revision");
      if (
        r.coordinator &&
        r.status !== "retired" &&
        records.some(
          (entry) =>
            entry.kind === "member" &&
            entry.recordId !== r.recordId &&
            entry.coordinator &&
            entry.status !== "retired",
        )
      )
        reject("Project already has a live coordinator");
      break;
    case "run-binding":
      return reject("Native run bindings require admission");
    case "plan-revision":
      if (r.dependencyTaskIds.some((id) => !state.tasks.some((t) => t.taskId === id)))
        reject("Unknown plan dependency");
      break;
    case "gate": {
      if (
        r.gate === "assignment" ||
        (r.gate === "repair" && r.assignmentAuthorization !== undefined)
      ) {
        if (r.status !== "invalidated" && r.status !== "rejected")
          assertProjectTeamAssignmentAuthorization(state, r);
      } else if (r.assignmentAuthorization !== undefined)
        reject("Only a bounded assignment grant can carry inherited authority");
      if (
        old?.kind === "gate" &&
        ((old.status === "consumed" && r.status !== "consumed" && r.status !== "invalidated") ||
          (old.status === "invalidated" && r.status !== "invalidated"))
      )
        reject("Consumed or invalidated grant cannot be reapproved");
      if (
        r.status === "consumed" &&
        (r.consumedByRunId === undefined || r.consumedByCommandId === undefined)
      )
        reject("Consumed grant requires exact run and command ownership");
      const inherited =
        consumption?.inheritedGateId === undefined
          ? undefined
          : records.find(
              (entry) => entry.kind === "gate" && entry.recordId === consumption.inheritedGateId,
            );
      const inheritedConsumption =
        old === undefined &&
        r.status === "consumed" &&
        inherited?.kind === "gate" &&
        inherited.taskId === r.taskId &&
        inherited.projectId === r.projectId &&
        (inherited.status === "approved" || inherited.status === "consumed") &&
        inherited.attribution.actor.kind === "human" &&
        canonicalProjectWorkPayload(inherited.attribution) ===
          canonicalProjectWorkPayload(r.attribution) &&
        consumption?.runId === r.consumedByRunId &&
        consumption?.commandId === r.consumedByCommandId;
      if (old?.kind === "gate") {
        if (stable(old) !== stable(r)) reject("Gate target revision cannot change");
        if (
          (old.status === "approved" || old.status === "consumed") &&
          canonicalProjectWorkPayload(old.attribution) !==
            canonicalProjectWorkPayload(r.attribution)
        )
          reject("Approval attribution is immutable");
      }
      if (
        (r.status === "approved" || r.status === "rejected" || r.status === "consumed") &&
        ((origin.actor.kind !== "human" &&
          !inheritedConsumption &&
          !(
            r.status === "consumed" &&
            old?.kind === "gate" &&
            old.status === "approved" &&
            consumption?.runId === r.consumedByRunId &&
            consumption?.commandId === r.consumedByCommandId
          )) ||
          r.attribution.actor.kind !== "human")
      )
        reject("Approval gate requires human attribution");
      if (
        old?.kind === "gate" &&
        old.status === "consumed" &&
        (r.consumedByRunId !== old.consumedByRunId ||
          r.consumedByCommandId !== old.consumedByCommandId)
      )
        reject("Consumed grant ownership is immutable");
      if (
        r.status === "approved" &&
        r.gate === "specification" &&
        r.contentHash !== projectTeamSpecificationHash(state, r.taskId)
      )
        reject("Specification approval target is stale");
      if (
        r.status === "approved" &&
        r.gate === "plan" &&
        !records.some(
          (entry) =>
            entry.kind === "plan-revision" &&
            entry.taskId === r.taskId &&
            entry.status === "proposed" &&
            entry.specRevision === r.specRevision &&
            entry.planRevision === r.planRevision &&
            entry.contentHash === r.contentHash &&
            projectTeamPlanHash(entry) === r.contentHash,
        )
      )
        reject("Plan approval target is stale");
      if (
        r.gate === "merge" &&
        (r.repository === undefined ||
          r.pullRequestNumber === undefined ||
          r.headSha === undefined ||
          r.targetBranch === undefined ||
          r.mergeMethod === undefined)
      )
        reject("Merge gate requires exact remote revision and method");
      break;
    }
    case "message":
      if (old?.kind === "message" && stable(old) !== stable(r))
        reject("Message identity and semantic envelope are immutable");
      requireRecord(r.senderId, "member");
      requireRecord(r.recipientId, "member");
      if (r.taskId === undefined && r.missionId === undefined)
        reject("Messages require task or mission scope");
      if (r.missionId !== undefined) requireRecord(r.missionId, "mission");
      if (r.replyTo !== undefined) requireRecord(r.replyTo, "message");
      break;
    case "question":
      if (old?.kind === "question") assertProjectTeamQuestionUpdate(old, r);
      requireRecord(r.senderId, "member");
      requireRecord(r.targetGateId, "gate");
      if (old?.kind === "question" && old.status === "answered")
        reject("Question has already been answered");
      if (
        r.status === "answered" &&
        (origin.actor.kind !== "human" ||
          r.answer === undefined ||
          r.answeredBy?.actor.kind !== "human")
      )
        reject("Answer requires human attribution");
      break;
    case "repair-episode":
      if (old?.kind === "repair-episode" && semanticRepairResolution !== undefined) {
        const reviewerBinding = records.find(
          (entry): entry is Extract<TeamRecord, { kind: "run-binding" }> =>
            entry.kind === "run-binding" &&
            entry.recordId === semanticRepairResolution.reviewerBindingId,
        );
        const reviewerRole = records.find(
          (entry) =>
            entry.kind === "role-revision" &&
            reviewerBinding?.kind === "run-binding" &&
            entry.recordId === reviewerBinding.roleRevisionId,
        );
        const permitsQualifiedResolution =
          origin.actor.kind === "system" &&
          origin.actor.id === "project-team-runtime" &&
          origin.source.kind === "system" &&
          origin.source.id === "project-team-runtime" &&
          semanticRepairResolution.episodeId === old.recordId &&
          semanticRepairResolution.priorRevision === old.revision &&
          semanticRepairResolution.receiptId.length > 0 &&
          reviewerBinding?.kind === "run-binding" &&
          reviewerBinding.projectId === old.projectId &&
          (reviewerBinding.status === "running" || reviewerBinding.status === "stopping") &&
          reviewerBinding.generation === semanticRepairResolution.reviewerGeneration &&
          reviewerBinding.leaseGeneration === semanticRepairResolution.reviewerGeneration &&
          reviewerRole?.kind === "role-revision" &&
          reviewerRole.role === "reviewer" &&
          reviewerRole.status === "available" &&
          old.pendingSemanticRepair !== false &&
          old.status !== "resolved" &&
          r.status === "resolved" &&
          r.pendingSemanticRepair === false &&
          r.revision === old.revision + 1 &&
          r.generation === old.generation &&
          r.taskId === old.taskId &&
          r.failureFingerprint === old.failureFingerprint &&
          r.relevantRevision === old.relevantRevision &&
          r.lastSemanticRevision === old.lastSemanticRevision &&
          r.semanticRepairs === old.semanticRepairs &&
          r.allowance === old.allowance &&
          r.rootTaskId === old.rootTaskId &&
          r.transportRetries === old.transportRetries &&
          r.timeoutCount === old.timeoutCount &&
          canonicalProjectWorkPayload(r.attemptIds) === canonicalProjectWorkPayload(old.attemptIds);
        if (!permitsQualifiedResolution)
          reject("Pending semantic repair requires its exact canonical debit");
      }
      if (
        old?.kind === "repair-episode" &&
        old.pendingSemanticRepair !== false &&
        r.pendingSemanticRepair === false &&
        (r.semanticRepairs !== old.semanticRepairs + 1 ||
          r.lastSemanticRevision !== old.relevantRevision) &&
        semanticRepairResolution === undefined
      )
        reject("Pending semantic repair requires its exact canonical debit");
      if (
        old?.kind === "repair-episode" &&
        old.pendingSemanticRepair !== undefined &&
        r.pendingSemanticRepair === undefined
      )
        reject("Semantic repair state cannot be discarded");
      if (r.semanticRepairs > r.allowance && r.status === "active")
        reject("Exhausted repair allowance must be visible");
      if (
        old?.kind === "repair-episode" &&
        (r.allowance !== old.allowance ||
          r.rootTaskId !== old.rootTaskId ||
          r.failureFingerprint !== old.failureFingerprint ||
          old.attemptIds.some((id) => !r.attemptIds.includes(id)) ||
          r.semanticRepairs < old.semanticRepairs ||
          r.transportRetries < old.transportRetries ||
          r.timeoutCount < old.timeoutCount)
      )
        reject("Repair episode limits cannot reset");
      if (
        r.rootTaskId !== undefined &&
        records.some(
          (entry) =>
            entry.kind === "repair-episode" &&
            entry.recordId !== r.recordId &&
            entry.rootTaskId === r.rootTaskId &&
            entry.failureFingerprint === r.failureFingerprint,
        )
      )
        reject("Canonical failure already has a persistent repair episode");
      break;
    case "evidence-applicability":
      if (old?.kind === "evidence-applicability" && stable(old) !== stable(r))
        reject("Evidence applicability retains its original tested revision and payload");
      if (
        old?.kind === "evidence-applicability" &&
        old.status !== "current" &&
        r.status === "current"
      )
        reject("Stale evidence cannot be blessed for a later revision");
      break;
    case "reservation":
    case "effect":
    case "memory-source":
    case "memory-revision":
    case "memory-extraction":
    case "memory-observation":
      reject("Execution-owned records are unavailable in human Work");
      break;
    case "review-finding":
      assertReviewFindingCurrent(state, r, origin);
      break;
    default:
      break;
  }
  return r;
};
