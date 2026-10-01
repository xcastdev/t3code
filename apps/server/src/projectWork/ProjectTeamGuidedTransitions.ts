import {
  ProjectWorkBlockerId,
  ProjectWorkTaskId,
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
} from "./ProjectWorkPolicy.ts";
import {
  assertProjectTeamRunAuthority,
  evaluateProjectTeamGate,
  evaluateProjectTeamDependency,
  projectTeamScopeHash,
  projectTeamDerivedRecordId,
} from "./ProjectTeamPolicy.ts";
import { projectTeamRepairHash } from "./ProjectTeamGuidedLifecycle.ts";

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
  ) =>
    emit({
      type: "project-work.foundation.recorded",
      record: validateProjectTeamRecord(state, r, command.attribution, consumption),
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
    } else if (
      episode.status !== "active" ||
      episode.semanticRepairs >= episode.allowance ||
      episode.lastSemanticRevision === episode.relevantRevision
    )
      reject("Automatic repair requires remaining allowance and relevant change");
    record({
      ...episode,
      semanticRepairs: episode.semanticRepairs + 1,
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
              transportRetries: 0,
              timeoutCount: 0,
              attemptIds: [run.attemptId],
            }
          : {
              ...old,
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
