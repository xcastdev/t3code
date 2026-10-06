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
  memoryReflection?: Extract<ProjectWorkTeamTransition, { kind: "memory.reflect" }>,
  publicationTransition?: Extract<
    ProjectWorkTeamTransition,
    { kind: "publication.claim" | "publication.reflect" }
  >,
): TeamRecord => {
  const r = decodeTeamRecord(input);
  const records = state.foundationRecords ?? [];
  if (r.projectId !== state.projectId) reject("Foundation record project does not match command");
  const old = records.find((entry) => entry.recordId === r.recordId);
  if (r.kind === "review-finding") {
    if (r.generation !== 0) reject("Review finding ledger generation cannot change");
    if (r.status !== "open") reject("Finding resolution requires trusted repair evidence");
    if (
      r.criterionIds.some(
        (id) => !state.criteria.some((c) => c.criterionId === id && c.taskId === r.taskId),
      )
    )
      reject("Review finding requires criteria from its parent task");
    if (
      records.some(
        (entry) =>
          entry.kind === "review-finding" &&
          entry.taskId === r.taskId &&
          entry.findingId === r.findingId &&
          entry.recordId !== r.recordId,
      )
    )
      reject("Review finding identity already has a ledger");
    if (old?.kind === "review-finding") {
      if (stable(old) !== stable(r)) reject("Original review target and reviewer cannot change");
      if (canonicalProjectWorkPayload(old) === canonicalProjectWorkPayload(r)) return old;
    }
  }
  // Only the dedicated private transition can reconcile an original memory effect.
  const reflectedMemory =
    memoryReflection !== undefined &&
    origin.actor.kind === "system" &&
    origin.actor.id === "project-memory-indexer" &&
    old?.kind === "effect" &&
    r.kind === "effect" &&
    r.effectId === memoryReflection.effectId &&
    r.revision === memoryReflection.expectedEffectRevision + 1 &&
    old.revision === memoryReflection.expectedEffectRevision &&
    r.claimGeneration === old.claimGeneration &&
    r.targetId === memoryReflection.sourceId &&
    r.generation === memoryReflection.sourceGeneration &&
    r.payload.expectedRevision === memoryReflection.sourceRevision &&
    r.status === "succeeded" &&
    ((r.effectKind === "memory-delete" &&
      memoryReflection.outcomeKind === "delete-source-complete" &&
      memoryReflection.observationIds.length === 0) ||
      (r.effectKind === "memory-index" &&
        memoryReflection.outcomeKind !== "delete-source-complete" &&
        r.claimGeneration === memoryReflection.claimGeneration)) &&
    r.outcome ===
      canonicalProjectWorkPayload({
        effectId: memoryReflection.effectId,
        claimGeneration: memoryReflection.claimGeneration,
        kind: memoryReflection.outcomeKind,
        sourceId: memoryReflection.sourceId,
        sourceRevision: memoryReflection.sourceRevision,
        sourceGeneration: memoryReflection.sourceGeneration,
        observationIds: memoryReflection.observationIds,
      });
  const memoryCleanup = reflectedMemory && r.kind === "effect" && r.effectKind === "memory-delete";
  const reflectedPublication =
    publicationTransition?.kind === "publication.reflect" &&
    origin.actor.kind === "system" &&
    origin.actor.id === "project-work-github-outbox" &&
    origin.source.kind === "system" &&
    origin.source.id === "project-work-github-outbox" &&
    old?.kind === "effect" &&
    r.kind === "effect" &&
    r.effectKind === "publication" &&
    r.effectId === publicationTransition.effectId &&
    old.revision === publicationTransition.expectedEffectRevision &&
    r.revision === old.revision + 1 &&
    old.claimGeneration === publicationTransition.claimGeneration &&
    r.claimGeneration === old.claimGeneration &&
    r.outcome === canonicalProjectWorkPayload(publicationTransition.receipt) &&
    r.status === (publicationTransition.receipt.kind === "confirmed" ? "succeeded" : "uncertain");

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
    !state.tasks.some((entry) => entry.taskId === r.taskId) &&
    !memoryCleanup
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
    case "run-binding": {
      if (
        old?.kind === "run-binding" &&
        old.status !== r.status &&
        (old.status === "stopping" ||
          old.status === "quarantined" ||
          old.status === "revoked" ||
          old.status === "settled") &&
        (r.status === "running" || r.status === "reserved")
      )
        reject("Stopped run cannot regain writable authority");
      if (
        old?.kind === "run-binding" &&
        old.sessionId !== undefined &&
        old.sessionId !== r.sessionId
      )
        reject("A bound native session cannot change");
      requireRecord(r.memberId, "member");
      requireRecord(r.roleRevisionId, "role-revision");
      const attempt = state.attempts.find(
        (entry) => entry.attemptId === r.attemptId && entry.taskId === r.taskId,
      );
      if (r.generation !== r.leaseGeneration)
        reject("Run generation must match its frozen lease generation");
      if (attempt === undefined) reject("Run binding requires a matching durable attempt");
      if (
        (r.status === "reserved" || r.status === "running") &&
        attempt!.state !== "leased" &&
        attempt!.state !== "running"
      )
        reject("Run binding requires active ownership");
      if (r.parentRunId !== undefined) requireRecord(r.parentRunId, "run-binding");
      break;
    }
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
      if (
        old?.kind === "repair-episode" &&
        old.pendingSemanticRepair !== false &&
        r.pendingSemanticRepair === false &&
        (r.semanticRepairs !== old.semanticRepairs + 1 ||
          r.lastSemanticRevision !== old.relevantRevision)
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
    case "reservation": {
      if (old?.kind === "reservation" && old.status === "released" && r.status === "held")
        reject("Released reservation cannot regain capacity");
      if (
        old?.kind === "reservation" &&
        (r.maximumTokens !== old.maximumTokens ||
          r.consumedTokens < old.consumedTokens ||
          r.runId !== old.runId ||
          r.scope !== old.scope ||
          r.environmentId !== old.environmentId ||
          r.slot !== old.slot ||
          r.resourceKey !== old.resourceKey)
      )
        reject("Reservation ownership and budgets cannot be reset");
      const run = requireRecord(r.runId, "run-binding");
      if (run.kind !== "run-binding") return reject("Invalid run kind");
      if (
        run.attemptId !== r.attemptId ||
        run.taskId !== r.taskId ||
        run.environmentId !== r.environmentId
      )
        reject("Reservation requires exact run ownership");
      if (r.consumedTokens > r.maximumTokens) reject("Reservation exceeds maximum tokens");
      // Only the private joined-run transition may release an original reservation
      // after configuration/authority has been revoked. It grants no new capacity.
      if (
        settlement !== undefined &&
        old?.kind === "reservation" &&
        old.status === "held" &&
        r.status === "released" &&
        run.recordId === settlement.bindingId &&
        run.generation === settlement.generation &&
        run.status === "settled"
      )
        break;
      const limits = records.find(
        (entry) =>
          entry.kind === "limits" && entry.status === "configured" && entry.model === run.model,
      );
      if (limits?.kind !== "limits") return reject("Missing explicit managed limits");
      if (limits.tokenLimit <= 0 || limits.durationLimitMs <= 0)
        reject("Missing explicit managed token/time limits");
      const maximum =
        r.scope === "environment"
          ? limits!.environmentModelCalls
          : r.scope === "project"
            ? limits!.projectWritableWorkers
            : limits!.modelCalls;
      if (r.slot >= maximum || r.maximumTokens > limits!.tokenLimit)
        reject("Reservation exceeds configured capacity/budget");
      break;
    }
    case "memory-source":
      if (r.status === "retracted" && r.tombstonedAt === undefined)
        reject("Retraction requires a retained tombstone");
      if (
        old?.kind === "memory-source" &&
        (r.sourceId !== old.sourceId ||
          r.sourceRevision < old.sourceRevision ||
          ((r.sourceRevision !== old.sourceRevision ||
            r.contentHash !== old.contentHash ||
            r.content !== old.content ||
            r.sourceKind !== old.sourceKind ||
            canonicalProjectWorkPayload(r.attribution) !==
              canonicalProjectWorkPayload(old.attribution)) &&
            r.generation <= old.generation))
      )
        reject("Source change requires generation fencing");
      break;
    case "memory-extraction":
    case "memory-observation": {
      const source = requireRecord(r.sourceId, "memory-source");
      if (
        source.kind !== "memory-source" ||
        source.sourceRevision !== r.sourceRevision ||
        (r.status !== "retracted" &&
          (source.generation !== r.sourceGeneration || source.status === "retracted"))
      )
        reject("Memory source is stale or retracted");
      if (r.kind === "memory-extraction") {
        if (
          old?.kind === "memory-extraction" &&
          canonicalProjectWorkPayload([
            old.sourceId,
            old.sourceRevision,
            old.sourceGeneration,
            old.engine,
            old.engineVersion,
            old.extractionModel,
            old.embeddingModel,
            old.embeddingDimensions,
          ]) !==
            canonicalProjectWorkPayload([
              r.sourceId,
              r.sourceRevision,
              r.sourceGeneration,
              r.engine,
              r.engineVersion,
              r.extractionModel,
              r.embeddingModel,
              r.embeddingDimensions,
            ])
        )
          reject("Extraction source and model tuple is immutable");
        if (
          new Set(r.expectedObservationIds).size !== r.expectedObservationIds.length ||
          new Set(r.completedObservationIds).size !== r.completedObservationIds.length ||
          r.completedObservationIds.some((id) => !r.expectedObservationIds.includes(id))
        )
          reject("Invalid extraction manifest");
        if (
          (r.status === "extracted" || r.status === "no-facts" || r.status === "indexed") &&
          r.extractionHash === undefined
        )
          reject("Durable extraction requires a frozen payload hash");
        if (r.status === "extracted" && r.expectedObservationIds.length === 0)
          reject("Empty extraction requires explicit no-facts outcome");
        if (r.status === "no-facts" && r.expectedObservationIds.length !== 0)
          reject("No-facts extraction must have empty manifest");
        if (
          r.status === "indexed" &&
          (r.expectedObservationIds.length === 0 ||
            r.expectedObservationIds.length !== r.completedObservationIds.length)
        )
          reject("Index receipt requires complete expected set");
        if (
          r.status === "indexed" &&
          r.expectedObservationIds.some(
            (id) =>
              !records.some(
                (entry) =>
                  entry.kind === "memory-observation" &&
                  entry.recordId === id &&
                  entry.extractionId === r.recordId &&
                  entry.sourceId === r.sourceId &&
                  entry.sourceRevision === r.sourceRevision &&
                  entry.sourceGeneration === r.sourceGeneration,
              ),
          )
        )
          reject("Index receipt requires retained observation payloads");
        if (
          old?.kind === "memory-extraction" &&
          old.extractionHash !== undefined &&
          stable(old) !== stable(r)
        )
          reject("Durable extraction manifest is immutable");
      } else {
        if (old?.kind === "memory-observation" && stable(old) !== stable(r))
          reject("Observation payload and provenance are immutable");
        const extraction = requireRecord(r.extractionId, "memory-extraction");
        if (
          extraction.kind !== "memory-extraction" ||
          extraction.sourceId !== r.sourceId ||
          extraction.sourceRevision !== r.sourceRevision ||
          extraction.sourceGeneration !== r.sourceGeneration ||
          !extraction.expectedObservationIds.includes(r.recordId)
        )
          reject("Observation requires extraction provenance and manifest membership");
      }
      break;
    }
    case "effect":
      if (r.effectKind === "publication") {
        if (
          old === undefined &&
          (r.status !== "pending" || r.claimGeneration !== 0 || r.outcome !== undefined)
        )
          reject("New publication must be an unsent pending effect");
        if (
          old?.kind === "effect" &&
          (r.status !== old.status ||
            r.claimGeneration !== old.claimGeneration ||
            r.outcome !== old.outcome) &&
          !reflectedPublication &&
          !(
            publicationTransition?.kind === "publication.claim" &&
            origin.actor.kind === "system" &&
            origin.actor.id === "project-work-github-outbox" &&
            origin.source.kind === "system" &&
            origin.source.id === "project-work-github-outbox" &&
            publicationTransition.effectId === r.effectId &&
            old.status === "pending" &&
            r.status === "claimed" &&
            old.revision === publicationTransition.expectedEffectRevision &&
            old.claimGeneration === publicationTransition.expectedClaimGeneration &&
            r.claimGeneration === old.claimGeneration + 1 &&
            r.outcome === undefined
          )
        )
          reject("Publication status requires a typed private transition");
      }
      if (old?.kind === "effect" && stable(old) !== stable(r))
        reject("Effect identity and semantic envelope are immutable");
      if (r.runId !== undefined && !memoryCleanup) requireRecord(r.runId, "run-binding");
      if (r.sourceId !== undefined) {
        const source = requireRecord(r.sourceId, "memory-source");
        if (source.generation !== r.sourceGeneration) reject("Effect source generation is stale");
      }
      if (old?.kind === "effect" && (old.status === "succeeded" || old.status === "canceled"))
        reject("Completed effect cannot be retried");
      // A text outcome cannot prove reconciliation. P11 will add the typed receipt path.
      if (
        old?.kind === "effect" &&
        old.status === "uncertain" &&
        r.status !== "uncertain" &&
        r.status !== "canceled" &&
        !reflectedMemory &&
        !reflectedPublication
      )
        reject("Uncertain effect requires durable reconciliation");
      if (old?.kind === "effect" && old.status === "claimed" && r.status === "pending")
        reject("Claimed effect cannot return to dispatch without a recorded outcome");
      if ((r.status === "succeeded" || r.status === "failed") && r.outcome === undefined)
        reject("Settled effect requires a recorded outcome");
      break;
    default:
      break;
  }
  return r;
};
