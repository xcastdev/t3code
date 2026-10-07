import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  canonicalProjectWorkPayload,
  ProjectWorkBlockerId,
  ProjectWorkTaskId,
  ProjectWorkEvidenceId,
  ProjectWorkCommentId,
  ProjectTeamReviewCompletionProof,
  type ProjectTeamRecord,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import type { ProjectWorkReducerState, ProjectWorkEvent } from "./ProjectWorkDecider.ts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import {
  assertKnownTask,
  assertNoActiveAttempt,
  deriveProjectWorkClaimPrerequisites,
  ProjectWorkPolicyError,
  projectWorkCommandFingerprint,
} from "./ProjectWorkPolicy.ts";
import {
  assertProjectTeamRunAuthority,
  assertProjectTeamOrdinarySuccessor,
  evaluateProjectTeamGate,
  evaluateProjectTeamDependency,
  projectTeamScopeHash,
  projectTeamDerivedRecordId,
} from "./ProjectTeamPolicy.ts";
import { projectTeamRepairHash } from "./ProjectTeamGuidedLifecycle.ts";
import { prepareReviewCriterionProgress } from "./ProjectTeamReviewCriterionProgress.ts";
import {
  assertDeliveryAcceptanceCurrent,
  prepareDeliveryAcceptanceEvidence,
  DELIVERY_ACCEPTANCE_PRODUCER,
} from "./ProjectTeamDeliveryAcceptanceState.ts";

const isReviewCompletionProof = Schema.is(ProjectTeamReviewCompletionProof);

type Command = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Episode = Extract<ProjectTeamRecord, { kind: "repair-episode" }>;
type Draft<T = ProjectWorkEvent> = T extends ProjectWorkEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
function reject(message: string): never {
  throw new ProjectWorkPolicyError("authority-required", message);
}
const projectTeamRepairGrantId = (commandId: string, episodeId: string, generation: number) =>
  projectTeamDerivedRecordId(commandId, `repair-grant:${episodeId}:${generation}`);

/** The producer is private; exact persisted grants, scope and ownership remain mandatory. */
export const decideProjectTeamGuidedTransition = (
  initial: ProjectWorkReducerState,
  command: Command,
  event: (draft: Draft, index: number) => ProjectWorkEvent,
  apply: (
    state: ProjectWorkReducerState,
    events: ReadonlyArray<ProjectWorkEvent>,
  ) => ProjectWorkReducerState,
): ReadonlyArray<ProjectWorkEvent> => {
  const transition = command.transition;
  if (
    transition === undefined ||
    command.guided !== undefined ||
    command.claim !== undefined ||
    command.records.length !== 0
  )
    reject("Private transition cannot mix raw records or another intent");
  let state = initial;
  const events: Array<ProjectWorkEvent> = [];
  const at = command.committedAt;
  const emit = (draft: Draft) => {
    const next = event(draft, events.length);
    events.push(next);
    state = apply(state, [next]);
  };
  const record = (
    r: ProjectTeamRecord,
    consumption?: { runId: string; commandId: string; inheritedGateId?: string },
    settlement?: { bindingId: string; generation: number; receiptId: string },
  ) =>
    emit({
      type: "project-work.foundation.recorded",
      record: validateProjectTeamRecord(state, r, command.attribution, consumption, settlement),
      occurredAt: at,
    });
  const records = () => state.foundationRecords ?? [];
  const id = (suffix: string) => projectTeamDerivedRecordId(command.commandId, suffix);
  const fields = (suffix: string) => ({
    recordId: id(suffix),
    projectId: command.projectId,
    revision: 0,
    generation: 0,
    updatedAt: at,
  });
  const lookupBinding = (bindingId: string, generation: number, expectedRevision?: number) => {
    const run = records().find(
      (r): r is Binding => r.kind === "run-binding" && r.recordId === bindingId,
    );
    if (
      run === undefined ||
      run.generation !== generation ||
      run.leaseGeneration !== generation ||
      (expectedRevision !== undefined && run.revision !== expectedRevision) ||
      run.status !== "running"
    )
      reject("Run receipt binding is no longer current");
    const role = records().find(
      (r) => r.kind === "role-revision" && r.recordId === run!.roleRevisionId,
    );
    if (role?.kind !== "role-revision") reject("Frozen role is missing");
    assertProjectTeamRunAuthority(state, run!, role!, false);
    const task = assertKnownTask(state, run!.taskId);
    const attempt = state.attempts.find((a) => a.attemptId === run!.attemptId);
    if (
      task.activeAttemptId !== run!.attemptId ||
      attempt === undefined ||
      (attempt.state !== "leased" && attempt.state !== "running") ||
      attempt.leasedUntil === undefined ||
      attempt.leasedUntil <= at
    )
      reject("Run receipt attempt expired or no longer owns task");
    return run!;
  };
  const canonicalRoot = (taskId: string) => {
    const seen = new Set<string>();
    let current = taskId;
    while (true) {
      if (seen.has(current)) reject("Task lineage has a cycle");
      seen.add(current);
      const m = records().find((r) => r.kind === "task-membership" && r.taskId === current);
      if (m?.kind !== "task-membership" || m.parentTaskId === undefined) return current;
      current = m.parentTaskId;
    }
  };
  const stop = (run: Binding, summary: string) => {
    record({ ...run, status: "stopping", revision: run.revision + 1, updatedAt: at });
    record({
      ...fields(`stop:${run.recordId}`),
      kind: "effect",
      status: "pending",
      effectId: id(`stop:${run.recordId}`),
      effectKind: "stop",
      taskId: run.taskId,
      runId: run.recordId,
      targetId: run.recordId,
      payload: { recordIds: [run.recordId], expectedRevision: run.revision, summary },
      claimGeneration: run.generation,
      availableAt: at,
    });
  };
  const escalate = (run: Binding, episode: Episode, summary: string) => {
    emit({
      type: "project-work.task.failed",
      taskId: run.taskId,
      attemptId: run.attemptId,
      failureKind: "manual-triage",
      reason: summary,
      evidenceIds: [],
      failedAt: at,
      occurredAt: at,
      attribution: command.attribution,
    });
    emit({
      type: "project-work.task.blocked",
      taskId: run.taskId,
      blockedAt: at,
      occurredAt: at,
      blocker: {
        blockerId: ProjectWorkBlockerId.make(id("repair-blocker")),
        taskId: run.taskId,
        reason: `Repair episode ${episode.recordId}: ${summary}. Diagnose, revise scope, authorize one exact repair, or abandon.`,
        resolver: "Human diagnosis or one exact repair decision",
        referenceIds: [episode.recordId],
        attention: true,
        revision: 0,
        attribution: command.attribution,
      },
    });
    stop(run, summary);
  };
  const debit = (
    episode: Episode,
    run: Binding,
    exceptionGateId?: string,
    expectedExceptionGateRevision?: number,
  ) => {
    if (exceptionGateId !== undefined) {
      const grant = records().find(
        (r): r is Gate => r.kind === "gate" && r.recordId === exceptionGateId,
      );
      if (
        episode.exceptionGrantId !== exceptionGateId ||
        grant?.revision !== expectedExceptionGateRevision
      )
        reject("Repair exception record changed");
      const result = evaluateProjectTeamGate(grant, {
        projectId: run.projectId,
        taskId: episode.taskId,
        gate: "repair",
        specRevision: run.specRevision,
        planRevision: run.planRevision,
        contentHash: projectTeamRepairHash(episode),
        evidenceIds: [],
      });
      if (!result.available) reject(`Repair exception is ineligible: ${result.reason}`);
      record(
        {
          ...grant!,
          status: "consumed",
          revision: grant!.revision + 1,
          updatedAt: at,
          consumedByRunId: run.recordId,
          consumedByCommandId: command.commandId,
        },
        { runId: run.recordId, commandId: command.commandId },
      );
    } else if (episode.pendingSemanticRepair !== true)
      reject("Automatic repair requires a current pending semantic failure");
    else if (
      episode.status !== "active" ||
      episode.semanticRepairs >= episode.allowance ||
      episode.lastSemanticRevision === episode.relevantRevision
    )
      reject("Automatic repair requires remaining allowance and relevant change");
    record({
      ...episode,
      semanticRepairs: episode.semanticRepairs + 1,
      pendingSemanticRepair: false,
      lastSemanticRevision: episode.relevantRevision,
      status: episode.semanticRepairs + 1 > episode.allowance ? "exhausted" : "active",
      revision: episode.revision + 1,
      updatedAt: at,
      attemptIds: episode.attemptIds.includes(run.attemptId)
        ? episode.attemptIds
        : [...episode.attemptIds, run.attemptId],
    });
  };
  switch (transition!.kind) {
    case "delivery.accept": {
      const t = transition!;
      if (
        command.attribution.actor.kind !== "system" ||
        command.attribution.actor.id !== DELIVERY_ACCEPTANCE_PRODUCER ||
        command.attribution.source.kind !== "system" ||
        command.attribution.source.id !== DELIVERY_ACCEPTANCE_PRODUCER ||
        command.attribution.recordedAt !== at
      )
        reject("Delivery acceptance requires its private producer");
      const tasks = state.tasks.filter((task) => task.taskId === t.proof.source.taskId);
      const task = tasks[0];
      if (
        tasks.length !== 1 ||
        !task ||
        task.projectId !== command.projectId ||
        task.revision !== t.expectedTaskRevision ||
        ["completed", "canceled", "failed"].includes(task.state) ||
        task.activeAttemptId !== undefined
      )
        reject("Delivered task is no longer available for acceptance");
      assertDeliveryAcceptanceCurrent(state, t.proof);
      const evidence = prepareDeliveryAcceptanceEvidence(command);
      if (state.evidence.some((e) => e.evidenceId === evidence.evidenceId))
        reject("Delivery acceptance is already retained");
      emit({ type: "project-work.evidence.added", evidence, addedAt: at, occurredAt: at });
      emit({
        type: "project-work.task.completed",
        taskId: task.taskId,
        satisfiedCriterionIds: [],
        completedAt: at,
        occurredAt: at,
      });
      return events;
    }
    case "verification.claim":
      return reject("Verification consumption requires its dedicated private producer");
    case "memory.reflect":
      return reject("Memory reflection requires its dedicated private producer");
    case "run.settle": {
      const t = transition!;
      if (
        command.attribution.actor.kind !== "system" ||
        command.attribution.actor.id !== "project-team-runtime"
      )
        reject("Joined run settlement requires the private runtime producer");
      const run = records().find(
        (r): r is Binding => r.kind === "run-binding" && r.recordId === t.bindingId,
      );
      const task = assertKnownTask(state, t.taskId);
      const attempt = state.attempts.find((a) => a.attemptId === t.attemptId);
      if (
        run === undefined ||
        run.status === "settled" ||
        run.generation !== t.generation ||
        run.leaseGeneration !== t.generation ||
        run.revision !== t.expectedBindingRevision ||
        run.taskId !== t.taskId ||
        run.attemptId !== t.attemptId ||
        task.revision !== t.expectedTaskRevision ||
        attempt === undefined ||
        attempt.taskId !== task.taskId ||
        attempt.revision !== t.expectedAttemptRevision
      )
        reject("Joined run settlement identity changed");
      const effects = records().filter(
        (r): r is Extract<ProjectTeamRecord, { kind: "effect" }> =>
          r.kind === "effect" &&
          r.runId === run!.recordId &&
          (r.effectKind === "dispatch" || r.effectKind === "stop") &&
          (r.status === "pending" || r.status === "claimed" || r.status === "uncertain"),
      );
      if (
        new Set(t.effectIds).size !== t.effectIds.length ||
        effects.length !== t.effectIds.length ||
        effects.some((e) => !t.effectIds.includes(e.recordId)) ||
        !effects.some((e) => e.effectKind === "dispatch" && e.effectId === t.dispatchId)
      )
        reject("Joined run settlement must close the exact original dispatch and stop effects");
      const writers = records().filter(
        (r): r is Extract<ProjectTeamRecord, { kind: "reservation" }> =>
          r.kind === "reservation" &&
          r.runId === run!.recordId &&
          r.scope === "project" &&
          r.resourceKey === "writable",
      );
      if (
        writers.length !== (t.writableReservationId === undefined ? 0 : 1) ||
        writers.some((r) => r.recordId !== t.writableReservationId || r.status !== "held")
      )
        reject("Joined run settlement writer ownership changed");
      const completion = t.reviewCompletion;
      if (completion !== undefined && !isReviewCompletionProof(completion))
        reject("Joined review completion proof is malformed");
      const memberships = records().filter(
        (r) => r.kind === "task-membership" && r.taskId === task.taskId,
      );
      const membership = memberships[0];
      const member = records().find((r) => r.kind === "member" && r.recordId === run!.memberId);
      const attention =
        completion?.status === "denied" &&
        task.state === "in-progress" &&
        task.activeAttemptId === attempt!.attemptId &&
        memberships.length === 1 &&
        membership?.kind === "task-membership" &&
        membership.status === "active" &&
        (membership.controlState === undefined || membership.controlState === "active") &&
        membership.requestedSuccessorMemberId === undefined &&
        member?.kind === "member" &&
        member.status === "active" &&
        !state.blockers.some((b) => b.taskId === task.taskId && b.resolvedAt === undefined);
      const hash = (value: unknown) =>
        NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
      const same = (left: unknown, right: unknown) =>
        canonicalProjectWorkPayload(left) === canonicalProjectWorkPayload(right);
      const required = state.criteria.filter(
        (c) =>
          c.taskId === task.taskId &&
          (c.required || task.specification?.criterionIds.includes(c.criterionId)),
      );
      if (completion?.status === "completed") {
        const report = completion.report;
        const role = records().find(
          (r) => r.kind === "role-revision" && r.recordId === run!.roleRevisionId,
        );
        const plan = records()
          .filter(
            (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
              r.kind === "plan-revision" &&
              r.taskId === task.taskId &&
              r.status === "proposed" &&
              r.specRevision === task.specRevision,
          )
          .sort((a, b) => b.planRevision - a.planRevision)[0];
        if (
          report.type !== "project-team.assignment.report" ||
          report.outcome !== "complete" ||
          task.state !== "in-progress" ||
          task.activeAttemptId !== attempt!.attemptId ||
          (attempt!.state !== "running" && attempt!.state !== "leased") ||
          (run!.status !== "running" && run!.status !== "stopping") ||
          role?.kind !== "role-revision" ||
          role.role !== "reviewer" ||
          role.status !== "available" ||
          member?.kind !== "member" ||
          member.status !== "active" ||
          member.roleRevisionId !== role.recordId ||
          memberships.length !== 1 ||
          membership?.kind !== "task-membership" ||
          !same(membership, completion.assignment) ||
          (membership.controlState !== undefined && membership.controlState !== "active") ||
          membership.requestedSuccessorMemberId !== undefined ||
          report.projectId !== command.projectId ||
          report.taskId !== task.taskId ||
          report.commandId !== completion.proposalCommandId ||
          report.expectedTaskRevision !== task.revision ||
          report.assignmentId !== membership.recordId ||
          report.expectedAssignmentRevision !== membership.revision ||
          report.specRevision !== task.specRevision ||
          report.planRevision !== (plan?.planRevision ?? 0) ||
          completion.target.projectId !== command.projectId ||
          completion.target.taskId !== membership.parentTaskId ||
          completion.provenance.reviewTaskId !== task.taskId ||
          completion.provenance.bindingId !== run!.recordId ||
          completion.provenance.generation !== run!.generation ||
          completion.provenance.memberId !== run!.memberId ||
          completion.provenance.providerInstanceId !== run!.providerInstanceId ||
          completion.provenance.threadId !== run!.threadId ||
          completion.provenance.sessionId !== run!.sessionId ||
          completion.provenance.dispatchId !== t.dispatchId ||
          completion.joinedReceiptId !== t.receiptId ||
          run!.scopeHash !== projectTeamScopeHash(state, task.taskId, plan) ||
          records().some(
            (r) =>
              r.kind === "run-binding" &&
              r.taskId === task.taskId &&
              r.recordId !== run!.recordId &&
              (r.generation > run!.generation ||
                r.status === "reserved" ||
                r.status === "running" ||
                r.status === "stopping"),
          )
        )
          reject("Joined reviewer report identity or scope changed");
        const dependencies = new Set(plan?.dependencyTaskIds ?? []);
        for (const relationship of state.relationships) {
          if (relationship.kind === "depends-on" && relationship.fromTaskId === task.taskId)
            dependencies.add(relationship.toTaskId);
          if (relationship.kind === "blocks" && relationship.toTaskId === task.taskId)
            dependencies.add(relationship.fromTaskId);
        }
        for (const dependency of dependencies) {
          const result = evaluateProjectTeamDependency({
            state,
            projectId: command.projectId,
            taskId: dependency,
            task: state.tasks.find((t) => t.taskId === dependency),
            memberships: records().filter(
              (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
                r.kind === "task-membership",
            ),
          });
          if (!result.available) reject("Joined reviewer dependency is incomplete");
        }
        for (const child of records().filter(
          (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
            r.kind === "task-membership" && r.parentTaskId === task.taskId && r.status === "active",
        )) {
          const result = evaluateProjectTeamDependency({
            state,
            projectId: command.projectId,
            taskId: child.taskId,
            task: state.tasks.find((t) => t.taskId === child.taskId),
            memberships: [child],
          });
          if (!result.available) reject("Joined reviewer child deliverable is incomplete");
        }
        const criterionSnapshots = required
          .map((c) => ({ id: c.criterionId, revision: c.revision, sha256: hash(c) }))
          .sort((a, b) => a.id.localeCompare(b.id));
        const evidenceIds = [...new Set([...report.evidenceIds, ...report.outputArtifactIds])];
        const evidence = evidenceIds.map((id) =>
          state.evidence.find((e) => e.evidenceId === id && e.taskId === task.taskId),
        );
        if (
          evidence.some(
            (e) => e === undefined || !e.detail?.trim() || e.scopeHash !== run!.scopeHash,
          ) ||
          report.outputArtifactIds.some(
            (id) => !evidence.some((e) => e?.evidenceId === id && e.kind === "artifact"),
          )
        )
          reject("Joined reviewer evidence is unavailable or stale");
        const evidenceSnapshots = evidence
          .flatMap((e) => (e ? [{ id: e.evidenceId, revision: e.revision, sha256: hash(e) }] : []))
          .sort((a, b) => a.id.localeCompare(b.id));
        const findings = records()
          .flatMap((r) =>
            r.kind === "review-finding" &&
            r.taskId === completion.target.taskId &&
            same(r.target, completion.target)
              ? [{ findingId: r.findingId, revision: r.revision, sha256: hash(r) }]
              : [],
          )
          .sort((a, b) => a.findingId.localeCompare(b.findingId));
        if (
          !same(criterionSnapshots, completion.criteria) ||
          !same(evidenceSnapshots, completion.evidence) ||
          !same(findings, completion.findings) ||
          new Set(criterionSnapshots.map((c) => c.id)).size !== criterionSnapshots.length ||
          new Set(findings.map((f) => f.findingId)).size !== findings.length
        )
          reject("Joined reviewer retained snapshots changed");
        const outputs = report.outputs ?? [];
        const outputSnapshots = outputs.map((output, index) => {
          const criterion = state.criteria.find(
            (c) => c.criterionId === output.criterionId && c.taskId === task.taskId,
          );
          if (!criterion || !output.detail.trim())
            reject("Joined reviewer output criterion changed");
          return {
            evidenceId: projectTeamDerivedRecordId(report.commandId, `report-output:${index}`),
            criterionId: output.criterionId,
            sha256: hash({ ...output, summary: output.summary ?? criterion!.description }),
          };
        });
        if (
          new Set(outputs.map((o) => o.criterionId)).size !== outputs.length ||
          !same(outputSnapshots, completion.outputs) ||
          completion.reportEvidenceId !==
            projectTeamDerivedRecordId(report.commandId, "report-evidence") ||
          completion.reportCommentId !== projectTeamDerivedRecordId(report.commandId, "report") ||
          required.length === 0 ||
          required.some(
            (c) =>
              c.status !== "waived" &&
              !outputs.some((o) => o.criterionId === c.criterionId) &&
              !evidence.some((e) => e?.criterionId === c.criterionId),
          ) ||
          state.evidence.some(
            (e) =>
              e.evidenceId === completion.reportEvidenceId ||
              completion.outputs.some((o) => o.evidenceId === e.evidenceId),
          ) ||
          (state.comments ?? []).some((c) => c.commentId === completion.reportCommentId)
        )
          reject("Joined reviewer outputs or original report identity changed");
      }
      const parentProgress =
        completion?.status === "completed"
          ? prepareReviewCriterionProgress({
              state,
              completion,
              settlementCommandId: String(command.commandId),
              settlementCommandFingerprint: projectWorkCommandFingerprint(command),
              at,
            })
          : [];
      const revisions = [
        ...parentProgress.flatMap((draft) =>
          draft.type === "project-work.criterion.upserted" ? [draft.criterion.revision - 1] : [],
        ),
        run!.revision,
        ...effects.map((r) => r.revision),
        ...writers.map((r) => r.revision),
        ...(completion?.status === "completed"
          ? required.filter((c) => c.status !== "waived").map((c) => c.revision)
          : []),
      ];
      if (attempt!.state === "leased" || attempt!.state === "running")
        revisions.push(attempt!.revision, task.revision);
      if (
        revisions.some((value) => !Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER)
      )
        reject("Joined run settlement revision is exhausted");
      if (attention && task.revision > Number.MAX_SAFE_INTEGER - 2)
        reject("Joined review attention task revision is exhausted");
      const eventCount =
        1 +
        parentProgress.length +
        writers.length +
        effects.length +
        (completion?.status === "completed"
          ? completion.outputs.length + 3
          : attempt!.state === "leased" || attempt!.state === "running"
            ? 1
            : 0) +
        (attention ? 1 : 0);
      if (
        !Number.isSafeInteger(state.revision) ||
        state.revision < 0 ||
        state.revision > Number.MAX_SAFE_INTEGER - eventCount
      )
        reject("Joined run settlement aggregate revision is exhausted");
      if (completion?.status === "completed") {
        const report = completion.report;
        if (report.type !== "project-team.assignment.report") reject("Joined report kind changed");
        const scopeHash = run!.scopeHash;
        if (scopeHash === undefined) reject("Joined reviewer scope is missing");
        const recordedAt = completion.reportAttribution.recordedAt;
        for (const [index, output] of (report.outputs ?? []).entries()) {
          const criterion = state.criteria.find(
            (c) => c.criterionId === output.criterionId && c.taskId === task.taskId,
          )!;
          emit({
            type: "project-work.evidence.added",
            addedAt: at,
            occurredAt: at,
            evidence: {
              evidenceId: ProjectWorkEvidenceId.make(completion.outputs[index]!.evidenceId),
              taskId: task.taskId,
              criterionId: output.criterionId,
              kind: output.kind,
              summary: output.summary ?? criterion.description,
              detail: output.detail,
              recordedAt,
              revision: 0,
              attribution: completion.reportAttribution,
              scopeHash,
            },
          });
        }
        emit({
          type: "project-work.evidence.added",
          addedAt: at,
          occurredAt: at,
          evidence: {
            evidenceId: ProjectWorkEvidenceId.make(completion.reportEvidenceId),
            taskId: task.taskId,
            kind: "observation",
            summary: report.summary,
            detail: report.summary,
            outputArtifactIds: report.outputArtifactIds.map((value) =>
              ProjectWorkEvidenceId.make(value),
            ),
            scopeHash,
            recordedAt,
            revision: 0,
            attribution: completion.reportAttribution,
          },
        });
        emit({
          type: "project-work.comment.added",
          occurredAt: at,
          addedAt: at,
          attribution: completion.reportAttribution,
          comment: {
            commentId: ProjectWorkCommentId.make(completion.reportCommentId),
            projectId: command.projectId,
            taskId: task.taskId,
            body: report.summary,
            createdAt: recordedAt,
            revision: 0,
            attribution: completion.reportAttribution,
          },
        });
        for (const draft of parentProgress) emit(draft);
        emit({
          type: "project-work.task.completed",
          taskId: task.taskId,
          attemptId: attempt!.attemptId,
          satisfiedCriterionIds: required
            .filter((c) => c.status !== "waived")
            .map((c) => c.criterionId),
          completedAt: at,
          occurredAt: at,
        });
      }
      record({ ...run!, status: "settled", revision: run!.revision + 1, updatedAt: at });
      for (const writer of writers)
        record(
          { ...writer, status: "released", revision: writer.revision + 1, updatedAt: at },
          undefined,
          { bindingId: run!.recordId, generation: run!.generation, receiptId: t.receiptId },
        );
      const outcome = canonicalProjectWorkPayload({
        dispatchId: t.dispatchId,
        receiptId: t.receiptId,
      });
      for (const effect of effects)
        record({
          ...effect,
          status: "canceled",
          outcome,
          revision: effect.revision + 1,
          updatedAt: at,
        });
      const currentAttempt = state.attempts.find((a) => a.attemptId === t.attemptId);
      if (currentAttempt?.state === "leased" || currentAttempt?.state === "running")
        emit({
          type: "project-work.attempt.stopped",
          taskId: task.taskId,
          attemptId: attempt!.attemptId,
          bindingId: run!.recordId,
          receiptId: t.receiptId,
          stoppedAt: at,
          occurredAt: at,
        });
      if (attention && completion?.status === "denied")
        emit({
          type: "project-work.task.blocked",
          taskId: task.taskId,
          blockedAt: at,
          occurredAt: at,
          blocker: {
            blockerId: ProjectWorkBlockerId.make(id("review-completion-blocker")),
            taskId: task.taskId,
            reason:
              "The saved review report could not complete this assignment. Check the current review evidence before assigning another review.",
            resolver: "Review current evidence and decide whether another review is needed",
            referenceIds: [completion.proposalCommandId],
            attention: true,
            revision: 0,
            attribution: command.attribution,
          },
        });
      break;
    }
    case "claim": {
      const t = transition!;
      const task = assertKnownTask(state, t.taskId);
      let run = t.binding;
      const claim = t.claim;
      if (
        task.revision !== t.expectedTaskRevision ||
        claim.commandId !== command.commandId ||
        claim.projectId !== command.projectId ||
        claim.taskId !== task.taskId ||
        run.projectId !== command.projectId ||
        run.taskId !== task.taskId ||
        run.attemptId !== claim.attemptId ||
        run.revision !== 0 ||
        run.generation !== run.leaseGeneration ||
        run.status !== "reserved" ||
        claim.claimedAt !== at ||
        (claim.expectedRevision !== undefined &&
          claim.expectedRevision !== command.expectedRevision) ||
        claim.leasedUntil <= at
      )
        reject("Atomic claim envelope or ownership does not match");
      const m = records().find((r) => r.kind === "task-membership" && r.taskId === task.taskId);
      if (
        m?.kind !== "task-membership" ||
        m.executionKind !== "managed" ||
        m.status !== "active" ||
        (m.controlState !== undefined && m.controlState !== "active")
      )
        reject("Claim assignment is not active managed work");
      if (
        m.requestedSuccessorMemberId !== undefined &&
        run.memberId !== m.requestedSuccessorMemberId
      )
        reject("Claim must use the exact requested successor member");
      if (t.repair === undefined) assertProjectTeamOrdinarySuccessor(state, task.taskId);
      if (
        records().some(
          (r) => r.kind === "run-binding" && r.taskId === task.taskId && r.status !== "settled",
        )
      )
        reject("Prior writer has not authoritatively drained");
      if (
        state.attempts.some(
          (attempt) =>
            attempt.taskId === task.taskId &&
            !records().some(
              (r) =>
                r.kind === "run-binding" &&
                r.attemptId === attempt.attemptId &&
                r.status === "settled",
            ),
        )
      )
        reject("Unbound legacy attempt has no authoritative drain proof");
      if (
        state.attempts.some((a) => a.attemptId === claim.attemptId) ||
        records().some((r) => r.recordId === run.recordId)
      )
        reject("Run or attempt identity already exists");
      const priorGenerations = records()
        .filter((r): r is Binding => r.kind === "run-binding" && r.taskId === task.taskId)
        .map((r) => r.generation);
      if (priorGenerations.some((generation) => generation >= run.generation))
        reject("Lease generation must advance");
      assertNoActiveAttempt(state, task.taskId);
      if (!deriveProjectWorkClaimPrerequisites(state, task.taskId).claimable)
        reject("Ordinary claim prerequisites remain unsatisfied");
      const member = records().find((r) => r.kind === "member" && r.recordId === run.memberId);
      const role = records().find(
        (r) => r.kind === "role-revision" && r.recordId === run.roleRevisionId,
      );
      if (
        member?.kind !== "member" ||
        member.status !== "active" ||
        member.roleRevisionId !== run.roleRevisionId ||
        role?.kind !== "role-revision" ||
        role.status !== "available" ||
        role.model !== run.model ||
        role.model === "unconfigured" ||
        run.configuration.toolIds.some((tool) => !role.tools.includes(tool)) ||
        run.configuration.skillIds.some((skill) => !role.skills.includes(skill))
      )
        reject("Claim requires current member and explicit frozen role configuration");
      const plan = records()
        .filter(
          (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
            r.kind === "plan-revision" && r.taskId === task.taskId && r.status === "proposed",
        )
        .sort((a, b) => b.planRevision - a.planRevision)[0];
      if (
        run.specRevision !== task.specRevision ||
        run.planRevision !== (plan?.planRevision ?? 0) ||
        run.scopeHash !== projectTeamScopeHash(state, task.taskId, plan)
      )
        reject("Claim frozen specification or plan scope changed");
      const grant = records().find(
        (r): r is Gate => r.kind === "gate" && r.recordId === t.authorizationGateId,
      );
      if (
        grant?.revision !== t.expectedGateRevision ||
        m.assignment?.authorizationGateId !== t.authorizationGateId ||
        (t.repair === undefined && run.authorizationGateId !== t.authorizationGateId)
      )
        reject("Claim authorization target changed");
      const target = {
        projectId: task.projectId,
        taskId: task.taskId,
        gate:
          grant?.gate === "assignment"
            ? ("assignment" as const)
            : m.deliverableKind === "research"
              ? ("investigation" as const)
              : ("execution" as const),
        specRevision: task.specRevision,
        planRevision: plan?.planRevision ?? 0,
        contentHash: run.scopeHash!,
        evidenceIds: [],
      };
      if (t.repair !== undefined) {
        const episode = records().find(
          (r): r is Episode => r.kind === "repair-episode" && r.recordId === t.repair!.episodeId,
        );
        const previous = records().find(
          (r): r is Binding => r.kind === "run-binding" && r.recordId === grant?.consumedByRunId,
        );
        if (
          episode === undefined ||
          episode.revision !== t.repair.expectedEpisodeRevision ||
          (episode.rootTaskId ?? episode.taskId) !== canonicalRoot(task.taskId) ||
          run.repairEpisodeId !== episode.recordId ||
          grant?.status !== "consumed" ||
          previous === undefined ||
          previous.status !== "settled" ||
          !episode.attemptIds.includes(previous.attemptId) ||
          grant.taskId !== task.taskId ||
          grant.contentHash !== target.contentHash ||
          grant.specRevision !== target.specRevision ||
          grant.planRevision !== target.planRevision ||
          (grant.gate !== target.gate && grant.gate !== "repair") ||
          grant.attribution.actor.kind !== "human"
        )
          reject(
            "Repair successor lacks exact drained predecessor authority and canonical episode",
          );
        run = {
          ...run,
          authorizationGateId: projectTeamRepairGrantId(
            command.commandId,
            episode.recordId,
            run.generation,
          ),
        };
        debit(episode, run, t.repair.exceptionGateId, t.repair.expectedExceptionGateRevision);
        const derived: Gate = {
          ...fields("repair-grant"),
          recordId: run.authorizationGateId!,
          kind: "gate",
          status: "consumed",
          taskId: run.taskId,
          gate: "repair",
          specRevision: run.specRevision,
          planRevision: run.planRevision,
          contentHash: run.scopeHash!,
          evidenceIds: [],
          attribution: grant.attribution,
          consumedByRunId: run.recordId,
          consumedByCommandId: command.commandId,
          ...(grant.assignmentAuthorization === undefined
            ? {}
            : { assignmentAuthorization: grant.assignmentAuthorization }),
          repairAuthorization: {
            episodeId: episode.recordId,
            failureFingerprint: episode.failureFingerprint,
            relevantRevision: episode.relevantRevision,
            semanticRepairNumber: episode.semanticRepairs + 1,
            inheritedGateId: grant.recordId,
            ...(t.repair.exceptionGateId === undefined
              ? {}
              : { exceptionGateId: t.repair.exceptionGateId }),
          },
        };
        record(derived, {
          runId: run.recordId,
          commandId: command.commandId,
          inheritedGateId: grant.recordId,
        });
        record({
          ...m,
          assignment: {
            ...m.assignment!,
            authorizationGateId: derived.recordId,
            repairEpisodeId: episode.recordId,
          },
          revision: m.revision + 1,
          updatedAt: at,
        });
      } else {
        const eligible = evaluateProjectTeamGate(grant, target);
        if (!eligible.available) reject(`Claim grant is ineligible: ${eligible.reason}`);
        record(
          {
            ...grant!,
            status: "consumed",
            revision: grant!.revision + 1,
            updatedAt: at,
            consumedByRunId: run.recordId,
            consumedByCommandId: command.commandId,
          },
          { runId: run.recordId, commandId: command.commandId },
        );
      }
      for (const dependency of plan?.dependencyTaskIds ?? []) {
        const result = evaluateProjectTeamDependency({
          state,
          projectId: task.projectId,
          taskId: dependency,
          task: state.tasks.find((entry) => entry.taskId === dependency),
          memberships: records().filter(
            (r): r is Extract<ProjectTeamRecord, { kind: "task-membership" }> =>
              r.kind === "task-membership",
          ),
        });
        if (!result.available) reject(`Claim dependency is ineligible: ${result.reason}`);
      }
      emit({
        type: "project-work.task.claimed",
        taskId: task.taskId,
        occurredAt: at,
        attempt: {
          attemptId: claim.attemptId,
          taskId: task.taskId,
          state: "leased",
          leaseToken: claim.leaseToken,
          leasedUntil: claim.leasedUntil,
          checkpointIds: [],
          revision: 0,
          attribution: command.attribution,
        },
      });
      record(run);
      assertProjectTeamRunAuthority(state, run, role!, true);
      if (t.dispatch !== undefined) {
        const effect = t.dispatch.effect;
        if (
          effect.kind !== "effect" ||
          effect.effectKind !== "dispatch" ||
          effect.status !== "pending" ||
          effect.projectId !== run.projectId ||
          effect.runId !== run.recordId ||
          effect.taskId !== run.taskId ||
          effect.targetId !== run.recordId ||
          effect.generation !== run.generation ||
          effect.revision !== 0 ||
          effect.claimGeneration !== 0 ||
          effect.availableAt !== at
        )
          reject("Dispatch intent must match the atomic claim");
        record(effect);
        const reservation = t.dispatch.writableReservation;
        if (reservation !== undefined) {
          if (
            reservation.kind !== "reservation" ||
            reservation.status !== "held" ||
            reservation.scope !== "project" ||
            reservation.projectId !== run.projectId ||
            reservation.environmentId !== run.environmentId ||
            reservation.runId !== run.recordId ||
            reservation.taskId !== run.taskId ||
            reservation.attemptId !== run.attemptId ||
            reservation.resourceKey !== "writable" ||
            reservation.generation !== run.generation ||
            reservation.revision !== 0 ||
            reservation.consumedTokens !== 0
          )
            reject("Writable reservation must match the atomic claim");
          record(reservation);
        }
      }
      break;
    }
    case "failure": {
      const t = transition!;
      const run = lookupBinding(t.bindingId, t.generation, t.expectedBindingRevision);
      const root = canonicalRoot(run.taskId);
      const old = records().find(
        (r): r is Episode =>
          r.kind === "repair-episode" &&
          (r.rootTaskId ?? r.taskId) === root &&
          r.failureFingerprint === t.failureFingerprint,
      );
      const episode: Episode =
        old === undefined
          ? {
              ...fields("repair-episode"),
              kind: "repair-episode",
              status: "active",
              taskId: run.taskId,
              rootTaskId: ProjectWorkTaskId.make(root),
              failureFingerprint: t.failureFingerprint,
              relevantRevision: t.relevantRevision,
              allowance: 2,
              semanticRepairs: 0,
              pendingSemanticRepair: t.failureKind === "semantic",
              transportRetries: 0,
              timeoutCount: 0,
              attemptIds: [run.attemptId],
            }
          : {
              ...old,
              ...(t.failureKind === "semantic" ? { pendingSemanticRepair: true } : {}),
              taskId: run.taskId,
              relevantRevision: t.relevantRevision,
              revision: old.revision + 1,
              updatedAt: at,
              attemptIds: old.attemptIds.includes(run.attemptId)
                ? old.attemptIds
                : [...old.attemptIds, run.attemptId],
            };
      const unchanged = old?.lastSemanticRevision === t.relevantRevision;
      const exhausted =
        t.failureKind === "semantic" &&
        (unchanged || episode.semanticRepairs >= episode.allowance || old?.status === "resolved");
      const next = {
        ...episode,
        status: exhausted ? ("exhausted" as const) : episode.status,
        transportRetries: episode.transportRetries + (t.failureKind === "transport" ? 1 : 0),
        timeoutCount: episode.timeoutCount + (t.failureKind === "timeout" ? 1 : 0),
      };
      record(next);
      if (exhausted)
        escalate(run, next, unchanged ? "Repeated failure without relevant change" : t.summary);
      break;
    }
    case "repair.consume": {
      const t = transition!;
      const run = lookupBinding(t.bindingId, t.generation);
      const episode = records().find(
        (r): r is Episode => r.kind === "repair-episode" && r.recordId === t.episodeId,
      );
      if (
        episode === undefined ||
        episode.revision !== t.expectedEpisodeRevision ||
        episode.relevantRevision !== t.relevantRevision ||
        (episode.rootTaskId ?? episode.taskId) !== canonicalRoot(run.taskId)
      )
        reject("Repair episode target or canonical lineage changed");
      debit(episode!, run, t.exceptionGateId, t.expectedExceptionGateRevision);
      break;
    }
  }
  return events;
};
