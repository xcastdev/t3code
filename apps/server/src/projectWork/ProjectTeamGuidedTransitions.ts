import { RunId, type ProjectWorkCommand, type ProjectTeamRecord } from "@t3tools/contracts";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import {
  deriveProjectWorkClaimPrerequisites,
  ProjectWorkPolicyError,
} from "./ProjectWorkPolicy.ts";
import {
  assertProjectTeamRunAuthority,
  assertProjectTeamOrdinarySuccessor,
} from "./ProjectTeamPolicy.ts";
import {
  assertReviewResolution,
  assertReviewCompletionProof,
  reviewCompletionDrafts,
} from "./ProjectTeamReviewState.ts";
import {
  assertDeliveryAcceptanceCurrent,
  prepareDeliveryAcceptanceEvidence,
} from "./ProjectTeamDeliveryAcceptanceState.ts";
type Command = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
type Draft<T = ProjectWorkEvent> = T extends ProjectWorkEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
export const decideProjectTeamGuidedTransition = (
  initial: ProjectWorkReducerState,
  command: Command,
  event: (draft: Draft, index: number) => ProjectWorkEvent,
  apply: (
    state: ProjectWorkReducerState,
    events: ReadonlyArray<ProjectWorkEvent>,
  ) => ProjectWorkReducerState,
): ReadonlyArray<ProjectWorkEvent> => {
  const reject = (message: string): never => {
    throw new ProjectWorkPolicyError("authority-required", message);
  };
  const t = command.transition;
  if (t?.kind === "memory.invalidate") {
    if (
      command.attribution.actor.kind !== "human" ||
      t.owner.kind !== "project" ||
      t.owner.projectId !== command.projectId
    )
      return reject("Memory invalidation requires its authorized project owner");
    const owner = t.owner;
    const recordId = `memory-revision:${command.projectId}`;
    const prior = initial.foundationRecords?.find((record) => record.recordId === recordId);
    if (
      prior !== undefined &&
      (prior.kind !== "memory-revision" ||
        prior.owner.kind !== "project" ||
        prior.owner.projectId !== owner.projectId ||
        prior.revision >= Number.MAX_SAFE_INTEGER)
    )
      return reject("Memory revision identity changed");
    return [
      event(
        {
          type: "project-work.foundation.recorded",
          record: {
            kind: "memory-revision",
            recordId,
            projectId: command.projectId,
            revision: prior === undefined ? 0 : prior.revision + 1,
            generation: 0,
            updatedAt: command.committedAt,
            status: "current",
            owner: t.owner,
          },
          occurredAt: command.committedAt,
        },
        0,
      ),
    ];
  }
  if (t?.kind === "delivery.accept") {
    if (
      command.attribution.actor.kind !== "system" ||
      command.attribution.actor.id !== "project-team-delivery-acceptance" ||
      command.attribution.source.kind !== "system" ||
      command.attribution.source.id !== "project-team-delivery-acceptance" ||
      initial.tasks.find((task) => task.taskId === t.proof.source.taskId)?.revision !==
        t.expectedTaskRevision
    )
      return reject("Delivery acceptance requires its private audited producer");
    assertDeliveryAcceptanceCurrent(initial, t.proof);
    const evidence = prepareDeliveryAcceptanceEvidence(command);
    if (initial.evidence.some((item) => item.evidenceId === evidence.evidenceId))
      return reject("Delivery acceptance already recorded");
    return [
      event(
        {
          type: "project-work.evidence.added",
          evidence,
          addedAt: command.committedAt,
          occurredAt: command.committedAt,
        },
        0,
      ),
    ];
  }
  if (t?.kind === "review.resolve") {
    assertReviewResolution(initial, t.finding, t.proof);
    if (
      command.attribution.actor.kind !== "agent" ||
      command.attribution.source.kind !== "mcp" ||
      command.attribution.actor.id !== t.finding.reportedBy.threadId ||
      command.attribution.source.id !== t.finding.reportedBy.sessionId
    )
      return reject("Review resolution requires the current reviewer");
    return [
      event(
        {
          type: "project-work.foundation.recorded",
          record: t.finding,
          occurredAt: command.committedAt,
        },
        0,
      ),
    ];
  }
  if (t?.kind === "run.settle") {
    if (
      command.attribution.actor.kind !== "system" ||
      command.attribution.actor.id !== "project-team-runtime" ||
      t.failure !== undefined
    )
      return reject("Settlement requires the private V2 receipt producer");
    const records = initial.foundationRecords ?? [];
    const binding = records.find(
      (record) => record.kind === "run-binding" && record.recordId === t.bindingId,
    );
    const task = initial.tasks.find((task) => task.taskId === t.taskId);
    const attempt = initial.attempts.find((attempt) => attempt.attemptId === t.attemptId);
    if (
      binding?.kind !== "run-binding" ||
      binding.status === "settled" ||
      binding.revision !== t.expectedBindingRevision ||
      binding.generation !== t.generation ||
      binding.leaseGeneration !== t.generation ||
      binding.taskId !== t.taskId ||
      binding.attemptId !== t.attemptId ||
      task?.revision !== t.expectedTaskRevision ||
      attempt?.revision !== t.expectedAttemptRevision
    )
      return reject("Settlement identity or generation changed");
    if (t.reviewCompletion !== undefined) {
      assertReviewCompletionProof(initial, t.reviewCompletion);
      if (
        t.reviewCompletion.provenance.bindingId !== binding.recordId ||
        t.reviewCompletion.provenance.generation !== binding.generation
      )
        return reject("Review completion targets another binding");
    }
    const effects = records.filter(
      (record): record is Extract<ProjectTeamRecord, { kind: "effect" }> =>
        record.kind === "effect" &&
        record.effectKind === "stop" &&
        record.sourceId === binding.recordId &&
        record.sourceGeneration === binding.generation &&
        record.status !== "succeeded",
    );
    if (
      effects.length !== new Set(t.effectIds).size ||
      effects.some((effect) => !t.effectIds.includes(effect.recordId))
    )
      return reject("Settlement stop effect set changed");
    const drafts: Array<Draft> = [
      {
        type: "project-work.foundation.recorded",
        record: {
          ...binding,
          status: "settled",
          revision: binding.revision + 1,
          updatedAt: command.committedAt,
        },
        occurredAt: command.committedAt,
      },
      ...effects.map((effect) => ({
        type: "project-work.foundation.recorded" as const,
        record: {
          ...effect,
          status: "succeeded" as const,
          revision: effect.revision + 1,
          updatedAt: command.committedAt,
        },
        occurredAt: command.committedAt,
      })),
      {
        type: "project-work.attempt.stopped",
        taskId: t.taskId,
        attemptId: t.attemptId,
        bindingId: t.bindingId,
        receiptId: t.receiptId,
        stoppedAt: command.committedAt,
        occurredAt: command.committedAt,
      },
    ];
    if (t.reviewCompletion !== undefined)
      drafts.push(...reviewCompletionDrafts(initial, t.reviewCompletion, command.committedAt));
    return drafts.map(event);
  }
  if (t?.kind !== "claim") return reject("Unsupported execution transition");
  if (t.repair !== undefined || t.dispatch !== undefined)
    return reject("Repair claims require canonical repair debit");
  const records = initial.foundationRecords ?? [];
  const task = initial.tasks.find((entry) => entry.taskId === t.taskId);
  const binding = t.binding;
  const role = records.find(
    (entry) => entry.kind === "role-revision" && entry.recordId === binding.roleRevisionId,
  );
  const member = records.find(
    (entry) => entry.kind === "member" && entry.recordId === binding.memberId,
  );
  const membership = records.find(
    (entry) => entry.kind === "task-membership" && entry.taskId === t.taskId,
  );
  const grant = records.find(
    (entry) => entry.kind === "gate" && entry.recordId === t.authorizationGateId,
  );
  if (
    !task ||
    task.revision !== t.expectedTaskRevision ||
    !deriveProjectWorkClaimPrerequisites(initial, t.taskId).claimable ||
    t.claim.projectId !== command.projectId ||
    t.claim.commandId !== command.commandId ||
    t.claim.taskId !== t.taskId ||
    t.claim.attemptId !== binding.attemptId ||
    t.claim.claimedAt !== command.committedAt ||
    t.claim.leasedUntil <= command.committedAt ||
    binding.projectId !== command.projectId ||
    binding.taskId !== t.taskId ||
    binding.status !== "reserved" ||
    binding.revision !== 0 ||
    binding.generation !== binding.leaseGeneration ||
    binding.runId !== undefined ||
    role?.kind !== "role-revision" ||
    role.model !== binding.model ||
    member?.kind !== "member" ||
    member.roleRevisionId !== role.recordId ||
    membership?.kind !== "task-membership" ||
    membership.assignment?.authorizationGateId !== grant?.recordId ||
    (membership.requestedSuccessorMemberId !== undefined &&
      membership.requestedSuccessorMemberId !== member.recordId) ||
    grant?.kind !== "gate" ||
    grant.status !== "approved" ||
    grant.revision !== t.expectedGateRevision ||
    grant.attribution.actor.kind !== "human" ||
    binding.authorizationGateId !== grant.recordId ||
    records.some((entry) => entry.recordId === binding.recordId) ||
    records.some(
      (entry) =>
        entry.kind === "run-binding" &&
        entry.taskId === t.taskId &&
        (entry.status !== "settled" || entry.generation >= binding.generation),
    ) ||
    initial.attempts.some(
      (attempt) =>
        attempt.taskId === t.taskId &&
        !records.some(
          (entry) =>
            entry.kind === "run-binding" &&
            entry.attemptId === attempt.attemptId &&
            entry.status === "settled",
        ),
    )
  )
    return reject("Claim authority, identity or generation changed");
  assertProjectTeamOrdinarySuccessor(initial, t.taskId);
  const events: Array<ProjectWorkEvent> = [];
  let state = initial;
  const emit = (draft: Draft) => {
    const next = event(draft, events.length);
    events.push(next);
    state = apply(state, [next]);
  };
  const record = (record: ProjectTeamRecord) =>
    emit({ type: "project-work.foundation.recorded", record, occurredAt: command.committedAt });
  record({
    ...grant,
    status: "consumed",
    revision: grant.revision + 1,
    updatedAt: command.committedAt,
    consumedByRunId: RunId.make(binding.recordId),
    consumedByCommandId: command.commandId,
  });
  emit({
    type: "project-work.task.claimed",
    taskId: t.taskId,
    occurredAt: command.committedAt,
    attempt: {
      attemptId: binding.attemptId,
      taskId: t.taskId,
      state: "leased",
      leaseToken: t.claim.leaseToken,
      leasedUntil: t.claim.leasedUntil,
      checkpointIds: [],
      revision: 0,
      attribution: command.attribution,
    },
  });
  record(binding);
  assertProjectTeamRunAuthority(state, binding, role, true);
  return events;
};
