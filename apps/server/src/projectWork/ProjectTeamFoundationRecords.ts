import {
  canonicalProjectWorkPayload,
  ProjectTeamRecord,
  type ProjectTeamRecord as TeamRecord,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

const decodeTeamRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const reject = (message: string): never => {
  throw new ProjectWorkPolicyError("invalid-state", message);
};
const stable = (record: TeamRecord) => {
  const mutable = new Set(["status", "revision", "generation", "updatedAt"]);
  if (record.kind === "run-binding") mutable.add("sessionId");
  if (record.kind === "gate") mutable.add("attribution");
  return canonicalProjectWorkPayload(
    Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key))),
  );
};
/** Foundation consistency only; session authorization and eligibility are separate gates. */
export const validateProjectTeamRecord = (
  state: ProjectWorkReducerState,
  input: TeamRecord,
  origin: ProjectWorkAttribution,
): TeamRecord => {
  const r = decodeTeamRecord(input);
  const records = state.foundationRecords ?? [];
  if (r.projectId !== state.projectId) reject("Foundation record project does not match command");
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
    case "mission":
      if (
        new Set(r.requiredTaskIds).size !== r.requiredTaskIds.length ||
        r.requiredTaskIds.some((id) => !state.tasks.some((t) => t.taskId === id))
      )
        reject("Mission requires unique known tasks");
      break;
    case "task-membership":
      if (r.missionId !== undefined) requireRecord(r.missionId, "mission");
      if (r.parentTaskId !== undefined && !state.tasks.some((t) => t.taskId === r.parentTaskId))
        reject("Unknown parent task");
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
    case "gate":
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
        (origin.actor.kind !== "human" || r.attribution.actor.kind !== "human")
      )
        reject("Approval gate requires human attribution");
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
    case "message":
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
      if (r.semanticRepairs > r.allowance && r.status === "active")
        reject("Exhausted repair allowance must be visible");
      if (
        old?.kind === "repair-episode" &&
        (r.allowance !== old.allowance ||
          r.semanticRepairs < old.semanticRepairs ||
          r.transportRetries < old.transportRetries ||
          r.timeoutCount < old.timeoutCount)
      )
        reject("Repair episode limits cannot reset");
      break;
    case "reservation": {
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
          ((r.sourceRevision !== old.sourceRevision || r.contentHash !== old.contentHash) &&
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
                  entry.sourceRevision === r.sourceRevision &&
                  entry.sourceGeneration === r.sourceGeneration,
              ),
          )
        )
          reject("Index receipt requires retained observation payloads");
        if (
          old?.kind === "memory-extraction" &&
          old.extractionHash !== undefined &&
          (r.extractionHash !== old.extractionHash ||
            canonicalProjectWorkPayload(r.expectedObservationIds) !==
              canonicalProjectWorkPayload(old.expectedObservationIds))
        )
          reject("Durable extraction manifest is immutable");
      } else {
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
      if (r.runId !== undefined) requireRecord(r.runId, "run-binding");
      if (r.sourceId !== undefined) {
        const source = requireRecord(r.sourceId, "memory-source");
        if (source.generation !== r.sourceGeneration) reject("Effect source generation is stale");
      }
      if (old?.kind === "effect" && (old.status === "succeeded" || old.status === "canceled"))
        reject("Completed effect cannot be retried");
      if (old?.kind === "effect" && old.status === "uncertain" && r.status === "pending")
        reject("Uncertain effect requires reconciliation, not blind retry");
      break;
    default:
      break;
  }
  return r;
};
