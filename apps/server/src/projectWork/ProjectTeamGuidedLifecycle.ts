import {
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectWorkCommentId,
  ProjectWorkEvidenceId,
  canonicalProjectWorkPayload,
  type ProjectTeamGuidedIntent,
  type ProjectTeamRecord,
  type ProjectWorkCommand,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import {
  ProjectWorkPolicyError,
  assertKnownTask,
  assertNoActiveAttempt,
} from "./ProjectWorkPolicy.ts";
import {
  evaluateProjectTeamDependency,
  evaluateProjectTeamGate,
  projectTeamSpecificationHash,
  projectTeamPlanHash,
  projectTeamScopeHash,
  assertProjectTeamRunAuthority,
  assertProjectTeamAssignmentAuthorization,
  projectTeamDerivedRecordId,
} from "./ProjectTeamPolicy.ts";

type FoundationCommand = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Plan = Extract<ProjectTeamRecord, { kind: "plan-revision" }>;
type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Draft<T = ProjectWorkEvent> = T extends ProjectWorkEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
function reject(message: string): never {
  throw new ProjectWorkPolicyError("invalid-state", message);
}
const unique = (values: ReadonlyArray<string>) => {
  if (new Set(values).size !== values.length) reject("Record references must be unique");
};
const unresolvedWriter = (r: ProjectTeamRecord) =>
  r.kind === "run-binding" && r.status !== "settled";

/** All generated records share the command transaction and its authenticated envelope. */
export const decideProjectTeamGuidedLifecycle = (
  initial: ProjectWorkReducerState,
  command: FoundationCommand,
  event: (draft: Draft, index: number) => ProjectWorkEvent,
  apply: (
    state: ProjectWorkReducerState,
    events: ReadonlyArray<ProjectWorkEvent>,
  ) => ProjectWorkReducerState,
): ReadonlyArray<ProjectWorkEvent> => {
  const guided = command.guided;
  if (guided === undefined) return reject("Missing guided intent");
  const intent = guided.intent;
  if (
    intent.commandId !== command.commandId ||
    intent.projectId !== command.projectId ||
    intent.expectedRevision !== command.expectedRevision
  )
    reject("Guided intent does not match its enclosing command");
  if (command.records.length !== 0 || command.claim !== undefined)
    reject("Guided intent cannot carry caller-created records or a raw claim");
  let state = initial;
  const events: Array<ProjectWorkEvent> = [];
  const at = command.committedAt;
  const id = (suffix: string) => projectTeamDerivedRecordId(command.commandId, suffix);
  const fields = (suffix: string) => ({
    recordId: id(suffix),
    projectId: command.projectId,
    revision: 0,
    generation: 0,
    updatedAt: at,
  });
  const emit = (draft: Draft) => {
    const next = event(draft, events.length);
    events.push(next);
    state = apply(state, [next]);
  };
  const record = (r: ProjectTeamRecord) =>
    emit({
      type: "project-work.foundation.recorded",
      occurredAt: at,
      record: validateProjectTeamRecord(state, r, command.attribution),
    });
  const records = () => state.foundationRecords ?? [];
  const task = assertKnownTask(state, intent.taskId);
  if (task.revision !== intent.expectedTaskRevision)
    throw new ProjectWorkPolicyError("stale-revision", "Guided task revision changed");
  let binding: Binding | undefined;
  let plannerAssignment: Membership | undefined;
  if (command.attribution.actor.kind !== "human") {
    binding = records().find(
      (r): r is Binding => r.kind === "run-binding" && r.recordId === guided.bindingId,
    );
    const attempt = state.attempts.find((entry) => entry.attemptId === binding?.attemptId);
    if (
      binding === undefined ||
      (binding.taskId !== task.taskId && intent.type !== "project-team.plan.propose") ||
      binding.generation !== guided.generation ||
      binding.leaseGeneration !== guided.generation ||
      binding.status !== "running" ||
      attempt === undefined ||
      (attempt.state !== "leased" && attempt.state !== "running") ||
      attempt.leasedUntil === undefined ||
      attempt.leasedUntil <= at ||
      state.tasks.find((t) => t.taskId === binding!.taskId)?.activeAttemptId !== binding.attemptId
    )
      reject("Guided managed identity is no longer current");
    const member = records().find((r) => r.kind === "member" && r.recordId === binding!.memberId);
    const role = records().find(
      (r) => r.kind === "role-revision" && r.recordId === binding!.roleRevisionId,
    );
    if (
      member?.kind !== "member" ||
      member.status !== "active" ||
      role?.kind !== "role-revision" ||
      role.status !== "available"
    )
      reject("Guided member or frozen role is no longer active");
    assertProjectTeamRunAuthority(state, binding!, role, false);
    if (binding.taskId !== task.taskId) {
      const child = records().find(
        (r): r is Membership => r.kind === "task-membership" && r.taskId === binding!.taskId,
      );
      const authorization = records().find(
        (r): r is Gate => r.kind === "gate" && r.recordId === binding!.authorizationGateId,
      );
      if (
        intent.type !== "project-team.plan.propose" ||
        role.role !== "planner" ||
        child?.parentTaskId !== task.taskId ||
        child.assignment?.authorizationGateId !== authorization?.recordId ||
        (authorization?.gate !== "assignment" && authorization?.gate !== "repair") ||
        authorization.assignmentAuthorization?.assignmentKind !== "planning" ||
        authorization.assignmentAuthorization.parentTaskId !== task.taskId
      )
        reject("Planner proposal requires exact inherited parent authorization");
      plannerAssignment = child;
    }
    if (
      intent.type !== "project-team.assignment.report" &&
      !(
        intent.type === "project-team.plan.propose" &&
        (role.role === "planner" || role.role === "coordinator")
      )
    )
      reject("This guided action requires human authority");
  }
  const membership = (taskId: string): Membership | undefined => {
    const all = records().filter(
      (r): r is Membership => r.kind === "task-membership" && r.taskId === taskId,
    );
    if (all.length > 1) reject("Ambiguous task membership");
    return all[0];
  };
  const ensureMembership = (
    target: ProjectWorkTask,
    deliverableKind: Membership["deliverableKind"] = "code",
  ) => {
    const existing = membership(target.taskId);
    if (existing !== undefined) {
      if (existing.executionKind === "legacy" || existing.status !== "active")
        reject("Task assignment is not active guided work");
      return existing;
    }
    assertNoActiveAttempt(state, target.taskId);
    const r: Membership = {
      ...fields(`membership:${target.taskId}`),
      kind: "task-membership",
      status: "active",
      taskId: target.taskId,
      executionKind: deliverableKind === "reminder" ? "human" : "managed",
      deliverableKind,
      controlState: "active",
    };
    record(r);
    return r;
  };
  const currentPlan = (targetId: string) =>
    records()
      .filter(
        (r): r is Plan =>
          r.kind === "plan-revision" && r.taskId === targetId && r.status === "proposed",
      )
      .sort((a, b) => b.planRevision - a.planRevision)[0];
  const dependencies = (target: ProjectWorkTask, plan?: Plan) => {
    const ids = new Set(plan?.dependencyTaskIds ?? []);
    for (const rel of state.relationships) {
      if (rel.kind === "depends-on" && rel.fromTaskId === target.taskId) ids.add(rel.toTaskId);
      if (rel.kind === "blocks" && rel.toTaskId === target.taskId) ids.add(rel.fromTaskId);
    }
    for (const taskId of ids) {
      const result = evaluateProjectTeamDependency({
        projectId: target.projectId,
        taskId,
        task: state.tasks.find((t) => t.taskId === taskId),
        memberships: records().filter((r): r is Membership => r.kind === "task-membership"),
      });
      if (!result.available) reject(`Dependency is ineligible: ${result.reason}`);
    }
  };
  const anchors = (target: ProjectWorkTask, plan: Plan) => {
    if (
      target.specification === undefined ||
      plan.specRevision !== target.specRevision ||
      plan.contentHash !== projectTeamPlanHash(plan)
    )
      reject("Plan or specification is stale");
    const specHash = projectTeamSpecificationHash(state, target.taskId);
    for (const [kind, hash] of [
      ["specification", specHash],
      ["plan", plan.contentHash],
    ] as const) {
      const gate = records().find(
        (r): r is Gate =>
          r.kind === "gate" &&
          r.taskId === target.taskId &&
          r.gate === kind &&
          r.status === "approved" &&
          r.specRevision === target.specRevision &&
          r.planRevision === (kind === "specification" ? 0 : plan.planRevision) &&
          r.contentHash === hash,
      );
      const result = evaluateProjectTeamGate(gate, {
        projectId: target.projectId,
        taskId: target.taskId,
        gate: kind,
        specRevision: target.specRevision,
        planRevision: kind === "specification" ? 0 : plan.planRevision,
        contentHash: hash,
        evidenceIds: [],
      });
      if (!result.available) reject(`Current human ${kind} approval required: ${result.reason}`);
    }
    dependencies(target, plan);
  };
  const stop = (targetId: string, reason: string, quarantine = false) => {
    for (const run of records().filter(
      (r): r is Binding =>
        r.kind === "run-binding" && r.taskId === targetId && r.status !== "settled",
    )) {
      if (run.status !== "stopping" && run.status !== "quarantined")
        record({
          ...run,
          status: quarantine ? "quarantined" : "stopping",
          revision: run.revision + 1,
          updatedAt: at,
        });
      if (
        !records().some(
          (r) =>
            r.kind === "effect" &&
            r.effectKind === "stop" &&
            r.runId === run.recordId &&
            r.claimGeneration === run.generation &&
            r.status !== "canceled",
        )
      )
        record({
          ...fields(`stop:${run.recordId}`),
          kind: "effect",
          status: "pending",
          effectId: id(`stop:${run.recordId}`),
          effectKind: "stop",
          taskId: run.taskId,
          runId: run.recordId,
          targetId: run.recordId,
          payload: { recordIds: [run.recordId], expectedRevision: run.revision, summary: reason },
          claimGeneration: run.generation,
          availableAt: at,
        });
    }
    for (const effect of records().filter(
      (r): r is Extract<ProjectTeamRecord, { kind: "effect" }> =>
        r.kind === "effect" &&
        r.taskId === targetId &&
        (r.effectKind === "dispatch" || r.effectKind === "setup") &&
        r.status === "pending",
    ))
      record({ ...effect, status: "canceled", revision: effect.revision + 1, updatedAt: at });
  };
  const invalidate = (
    targetId: string,
    reason: string,
    includeSpecification = true,
    preservePlan = false,
  ) => {
    for (const r of records()) {
      if (
        r.kind === "gate" &&
        r.taskId === targetId &&
        r.status !== "invalidated" &&
        (includeSpecification || r.gate !== "specification") &&
        (!preservePlan || r.gate !== "plan")
      )
        record({ ...r, status: "invalidated", revision: r.revision + 1, updatedAt: at });
      if (r.kind === "evidence-applicability" && r.taskId === targetId && r.status === "current")
        record({ ...r, status: "stale", revision: r.revision + 1, updatedAt: at });
    }
    stop(targetId, reason);
    const descendants = new Set([targetId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const m of records()) {
        if (
          m.kind !== "task-membership" ||
          m.parentTaskId === undefined ||
          !descendants.has(m.parentTaskId) ||
          descendants.has(m.taskId)
        )
          continue;
        descendants.add(m.taskId);
        changed = true;
      }
    }
    for (const childId of descendants) {
      if (childId === targetId) continue;
      for (const r of records()) {
        if (r.kind === "gate" && r.taskId === childId && r.status !== "invalidated")
          record({ ...r, status: "invalidated", revision: r.revision + 1, updatedAt: at });
        if (r.kind === "evidence-applicability" && r.taskId === childId && r.status === "current")
          record({ ...r, status: "stale", revision: r.revision + 1, updatedAt: at });
      }
      stop(childId, reason);
    }
  };
  const gate = (
    suffix: string,
    target: ProjectWorkTask,
    kind: Gate["gate"],
    contentHash: string,
    planRevision = 0,
    status: Gate["status"] = "pending",
  ) => {
    const r: Gate = {
      ...fields(suffix),
      kind: "gate",
      status,
      taskId: target.taskId,
      gate: kind,
      contentHash,
      specRevision: target.specRevision,
      planRevision,
      evidenceIds: [],
      attribution: command.attribution,
    };
    record(r);
    return r;
  };
  switch (intent.type) {
    case "project-team.assignment.start":
    case "project-team.investigation.start": {
      if (task.state === "completed" || task.state === "canceled")
        reject("Terminal work must be reopened before investigation");
      if (
        intent.type === "project-team.investigation.start" &&
        intent.issueRecordId !== undefined
      ) {
        const issue = records().find(
          (r) => r.kind === "issue" && r.recordId === intent.issueRecordId,
        );
        if (issue?.kind !== "issue" || issue.revision !== intent.expectedIssueRevision)
          reject("Investigation issue revision changed");
      }
      ensureMembership(task);
      const inherited = intent.type === "project-team.assignment.start";
      let assignmentAuthorization: Gate["assignmentAuthorization"];
      if (inherited) {
        if (intent.assignmentKind === "planning" && intent.outputDescriptions.length !== 1)
          reject("Planning requires exactly one proposed plan artifact output");
        if (task.specification === undefined || task.specRevision !== intent.specRevision)
          reject("Assignment requires current approved parent specification");
        const spec = records().find(
          (r): r is Gate => r.kind === "gate" && r.recordId === intent.specificationGateId,
        );
        const hash = projectTeamSpecificationHash(state, task.taskId);
        if (
          spec?.revision !== intent.expectedSpecificationGateRevision ||
          !evaluateProjectTeamGate(spec, {
            projectId: task.projectId,
            taskId: task.taskId,
            gate: "specification",
            specRevision: task.specRevision,
            planRevision: 0,
            contentHash: hash,
            evidenceIds: [],
          }).available
        )
          reject("Parent specification approval changed");
        const plan = currentPlan(task.taskId);
        if (intent.parentPlan === undefined) {
          if (intent.assignmentKind === "review" || plan !== undefined)
            reject("Assignment requires exact current approved parent plan");
          dependencies(task);
        } else {
          if (
            plan === undefined ||
            plan.recordId !== intent.parentPlan.recordId ||
            plan.revision !== intent.parentPlan.expectedRecordRevision ||
            plan.planRevision !== intent.parentPlan.planRevision
          )
            reject("Parent plan target changed");
          const planGate = records().find(
            (r): r is Gate => r.kind === "gate" && r.recordId === intent.parentPlan!.gateId,
          );
          if (
            planGate?.revision !== intent.parentPlan.expectedGateRevision ||
            !evaluateProjectTeamGate(planGate, {
              projectId: task.projectId,
              taskId: task.taskId,
              gate: "plan",
              specRevision: task.specRevision,
              planRevision: plan.planRevision,
              contentHash: plan.contentHash,
              evidenceIds: [],
            }).available
          )
            reject("Parent plan approval changed");
          anchors(task, plan);
        }
        assignmentAuthorization = {
          assignmentKind: intent.assignmentKind,
          parentTaskId: task.taskId,
          parentSpecRevision: task.specRevision,
          parentSpecificationGateId: spec!.recordId,
          parentSpecificationHash: hash,
          parentScopeHash: projectTeamScopeHash(state, task.taskId, plan),
          ...(plan === undefined
            ? {}
            : {
                parentPlan: {
                  recordId: plan.recordId,
                  planRevision: plan.planRevision,
                  contentHash: plan.contentHash,
                  gateId: intent.parentPlan!.gateId,
                },
              }),
        };
      }
      const childId = ProjectWorkTaskId.make(id(inherited ? intent.assignmentKind : "research"));
      const criterionIds = intent.outputDescriptions.map((_, index) =>
        ProjectWorkCriterionId.make(id(`output:${index}`)),
      );
      emit({
        type: "project-work.task.created",
        occurredAt: at,
        task: {
          taskId: childId,
          projectId: command.projectId,
          title: `${inherited ? (intent.assignmentKind === "planning" ? "Plan" : "Review") : "Investigate"}: ${task.title}`,
          summary: intent.objective,
          state: "draft",
          watchers: [],
          revision: 0,
          specRevision: 0,
          createdAt: at,
          updatedAt: at,
          attribution: command.attribution,
        },
      });
      for (const [index, description] of intent.outputDescriptions.entries())
        emit({
          type: "project-work.criterion.upserted",
          taskId: childId,
          occurredAt: at,
          updatedAt: at,
          criterion: {
            criterionId: criterionIds[index]!,
            taskId: childId,
            description,
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
        });
      emit({
        type: "project-work.task.specified",
        taskId: childId,
        occurredAt: at,
        updatedAt: at,
        specification: {
          objective: intent.objective,
          scopeIn: intent.outputDescriptions.join("\n"),
          scopeOut:
            "Read-only investigation. No implementation, publishing, merging, or delegation.",
          criterionIds,
          revision: 1,
          protected: false,
        },
      });
      const child = assertKnownTask(state, childId);
      const authorization: Gate = {
        ...fields(inherited ? "assignment" : "investigation"),
        kind: "gate",
        status: "approved",
        taskId: childId,
        gate: inherited ? "assignment" : "investigation",
        contentHash: projectTeamScopeHash(state, childId),
        specRevision: child.specRevision,
        planRevision: 0,
        evidenceIds: [],
        attribution: command.attribution,
        ...(assignmentAuthorization === undefined ? {} : { assignmentAuthorization }),
      };
      record(authorization);
      record({
        ...fields("research-membership"),
        kind: "task-membership",
        status: "active",
        taskId: childId,
        parentTaskId: task.taskId,
        executionKind: "managed",
        deliverableKind: inherited
          ? intent.assignmentKind === "review"
            ? "review"
            : "plan"
          : "research",
        controlState: "active",
        assignment: {
          authorizationGateId: authorization.recordId,
          outputDescriptions: intent.outputDescriptions,
        },
      });
      record({
        ...fields("investigator-role"),
        kind: "role-revision",
        status: "available",
        roleId: id("investigator"),
        roleRevision: 0,
        role: inherited
          ? intent.assignmentKind === "planning"
            ? "planner"
            : "reviewer"
          : "investigator",
        instructions: intent.objective,
        skills: [],
        tools: [
          "read",
          "search",
          "project-work",
          "project-work.report",
          ...(inherited && intent.assignmentKind === "planning" ? ["project-work.plan"] : []),
        ],
        model: "unconfigured",
        memoryAccess: "project",
        delegationDepth: 0,
      });
      emit({ type: "project-work.task.ready", taskId: childId, occurredAt: at });
      break;
    }
    case "project-team.specification.propose": {
      ensureMembership(task);
      if (
        task.specRevision !== intent.expectedSpecRevision ||
        intent.specification.revision !== task.specRevision + 1
      )
        reject("Specification revision must advance exactly once");
      if (task.state === "completed" || task.state === "canceled")
        reject("Terminal task requires an explicit reopen");
      unique(intent.specification.criterionIds);
      unique(intent.criterionSnapshots.map((c) => c.criterionId));
      if (
        intent.specification.protected ||
        intent.criterionSnapshots.some(
          (c) =>
            c.taskId !== task.taskId ||
            c.status !== "unsatisfied" ||
            c.waiver !== undefined ||
            c.satisfiedByEvidenceIds.length !== 0,
        ) ||
        intent.specification.criterionIds.some(
          (criterionId) => !intent.criterionSnapshots.some((c) => c.criterionId === criterionId),
        ) ||
        state.criteria.some(
          (c) =>
            c.taskId === task.taskId &&
            c.required &&
            !intent.criterionSnapshots.some((next) => next.criterionId === c.criterionId),
        )
      )
        reject(
          "Specification proposal requires complete unsatisfied criterion snapshots without authority",
        );
      invalidate(task.taskId, "Specification changed");
      for (const c of intent.criterionSnapshots) {
        const old = state.criteria.find((entry) => entry.criterionId === c.criterionId);
        if (old !== undefined && old.taskId !== task.taskId)
          reject("Criterion identity belongs to another task");
        emit({
          type: "project-work.criterion.upserted",
          taskId: task.taskId,
          criterion: { ...c, revision: old === undefined ? 0 : old.revision + 1, updatedAt: at },
          updatedAt: at,
          occurredAt: at,
        });
      }
      emit({
        type: "project-work.task.specified",
        taskId: task.taskId,
        specification: intent.specification,
        updatedAt: at,
        occurredAt: at,
      });
      gate(
        "specification",
        assertKnownTask(state, task.taskId),
        "specification",
        projectTeamSpecificationHash(state, task.taskId),
      );
      break;
    }
    case "project-team.plan.propose": {
      ensureMembership(task);
      if (task.specification === undefined || intent.specRevision !== task.specRevision)
        reject("Plan requires current specification");
      const previous = currentPlan(task.taskId);
      if (
        previous?.recordId !== intent.previousPlanId ||
        previous?.revision !== intent.expectedPreviousPlanRevision
      )
        reject("Previous plan target changed");
      unique(intent.dependencyTaskIds);
      if (
        intent.dependencyTaskIds.some(
          (dependency) =>
            dependency === task.taskId || !state.tasks.some((t) => t.taskId === dependency),
        )
      )
        reject("Plan requires known distinct dependencies");
      if (plannerAssignment !== undefined) {
        const child = assertKnownTask(state, plannerAssignment.taskId);
        const criteria = state.criteria.filter(
          (c) =>
            c.taskId === child.taskId &&
            (c.required || child.specification?.criterionIds.includes(c.criterionId)),
        );
        if (criteria.length !== 1)
          reject("Planner assignment requires exactly one retained plan output criterion");
        record({
          ...plannerAssignment,
          controlState: "paused",
          revision: plannerAssignment.revision + 1,
          updatedAt: at,
        });
        const criterion = criteria[0]!;
        emit({
          type: "project-work.evidence.added",
          addedAt: at,
          occurredAt: at,
          evidence: {
            evidenceId: ProjectWorkEvidenceId.make(id("plan-output:0")),
            taskId: child.taskId,
            criterionId: criterion.criterionId,
            kind: "artifact",
            summary: criterion.description,
            detail: intent.content,
            scopeHash: projectTeamScopeHash(state, child.taskId),
            recordedAt: at,
            revision: 0,
            attribution: command.attribution,
          },
        });
        emit({
          type: "project-work.task.completed",
          taskId: child.taskId,
          attemptId: binding!.attemptId,
          satisfiedCriterionIds: criteria.map((c) => c.criterionId),
          completedAt: at,
          occurredAt: at,
        });
        stop(child.taskId, "Planner proposal retained; await authoritative process drain");
      }
      invalidate(task.taskId, "Plan changed", false);
      if (previous !== undefined)
        record({ ...previous, status: "retired", revision: previous.revision + 1, updatedAt: at });
      const plan: Plan = {
        ...fields("plan"),
        kind: "plan-revision",
        status: "proposed",
        taskId: task.taskId,
        specRevision: task.specRevision,
        planRevision: (previous?.planRevision ?? 0) + 1,
        content: intent.content,
        dependencyTaskIds: intent.dependencyTaskIds,
        contentHash: projectTeamPlanHash(intent),
      };
      record(plan);
      gate("plan-gate", task, "plan", plan.contentHash, plan.planRevision);
      break;
    }
    case "project-team.execution.start": {
      const m = ensureMembership(task);
      if (m.controlState !== undefined && m.controlState !== "active")
        reject("Controlled task cannot start execution");
      if (records().some((r) => unresolvedWriter(r) && "taskId" in r && r.taskId === task.taskId))
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
        task.state === "completed" ||
        task.state === "canceled" ||
        task.specRevision !== intent.specRevision
      )
        reject("Execution task revision is stale or terminal");
      const plan = currentPlan(task.taskId);
      if (
        plan === undefined ||
        plan.recordId !== intent.planId ||
        plan.revision !== intent.expectedPlanRecordRevision ||
        plan.planRevision !== intent.planRevision
      )
        reject("Execution plan target changed");
      for (const [gateId, revision, kind] of [
        [intent.specGateId, intent.expectedSpecGateRevision, "specification"],
        [intent.planGateId, intent.expectedPlanGateRevision, "plan"],
      ] as const) {
        const g = records().find((r): r is Gate => r.kind === "gate" && r.recordId === gateId);
        if (g?.revision !== revision) reject("Execution approval record changed");
        const result = evaluateProjectTeamGate(g, {
          projectId: task.projectId,
          taskId: task.taskId,
          gate: kind,
          specRevision: task.specRevision,
          planRevision: kind === "specification" ? 0 : plan.planRevision,
          contentHash:
            kind === "specification"
              ? projectTeamSpecificationHash(state, task.taskId)
              : plan.contentHash,
          evidenceIds: [],
        });
        if (!result.available) reject(`Execution approval is ineligible: ${result.reason}`);
      }
      anchors(task, plan);
      const hash = projectTeamScopeHash(state, task.taskId, plan);
      if (
        records().some(
          (r) =>
            r.kind === "gate" &&
            r.taskId === task.taskId &&
            r.gate === "execution" &&
            r.contentHash === hash &&
            (r.status === "approved" || r.status === "consumed"),
        )
      )
        reject("Execution scope already has a grant");
      const authorization = gate(
        "execution",
        task,
        "execution",
        hash,
        plan.planRevision,
        "approved",
      );
      record({
        ...m,
        revision: m.revision + 1,
        updatedAt: at,
        assignment: {
          authorizationGateId: authorization.recordId,
          outputDescriptions: [
            "Deliver the approved specification and every required acceptance criterion.",
          ],
        },
      });
      if (task.state !== "ready")
        emit({ type: "project-work.task.ready", taskId: task.taskId, occurredAt: at });
      break;
    }
    case "project-team.task.control": {
      const m = ensureMembership(task);
      const action = intent.control.action;
      if (
        (action === "pause" || action === "defer" || action === "reassign") &&
        (task.state === "completed" || task.state === "canceled")
      )
        reject("Terminal task requires reopen before steering");
      if (intent.control.action === "reassign") {
        const control = intent.control;
        const recipient = records().find(
          (r) => r.kind === "member" && r.recordId === control.recipientMemberId,
        );
        if (
          recipient?.kind !== "member" ||
          recipient.revision !== intent.control.expectedMemberRevision ||
          recipient.status !== "active"
        )
          reject("Reassignment recipient changed or is inactive");
      }
      if (action === "resume" || action === "reopen" || action === "resolve-failure") {
        if (records().some((r) => unresolvedWriter(r) && "taskId" in r && r.taskId === task.taskId))
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
          reject("Prior attempt has no authoritative drain proof");
        const plan = currentPlan(task.taskId);
        let renewedGrant: Gate | undefined;
        const ancestors = new Set<string>();
        let rootTaskId: string = task.taskId;
        while (membership(rootTaskId)?.parentTaskId !== undefined) {
          if (ancestors.has(rootTaskId)) reject("Task lineage has a cycle");
          ancestors.add(rootTaskId);
          rootTaskId = membership(rootTaskId)!.parentTaskId!;
        }
        if (
          action !== "resolve-failure" &&
          (task.state === "failed" ||
            task.state === "blocked" ||
            records().some(
              (r) =>
                r.kind === "repair-episode" &&
                (r.rootTaskId ?? r.taskId) === rootTaskId &&
                r.status === "exhausted",
            ))
        )
          reject("Failed or exhausted work requires exact failure resolution before resume");
        if (action === "reopen" && task.specification === undefined) {
          dependencies(task);
        } else if (
          m.executionKind === "human" &&
          m.deliverableKind === "reminder" &&
          task.specRevision === 0
        ) {
          dependencies(task);
        } else {
          const prior = records().find(
            (r): r is Gate => r.kind === "gate" && r.recordId === m.assignment?.authorizationGateId,
          );
          const inherited =
            prior?.assignmentAuthorization !== undefined &&
            (prior.gate === "assignment" || prior.gate === "repair");
          const research = m.deliverableKind === "research";
          if (inherited) {
            if (plan !== undefined)
              reject("Inherited assignment cannot have its own implementation plan");
            assertProjectTeamAssignmentAuthorization(state, prior);
            dependencies(task);
          } else if (research) dependencies(task);
          else {
            if (plan === undefined) reject("Resume requires approved plan");
            anchors(task, plan);
          }
          if (m.assignment !== undefined && action !== "resolve-failure") {
            const scopeHash = projectTeamScopeHash(
              state,
              task.taskId,
              research || inherited ? undefined : plan,
            );
            const targetKind = inherited ? "assignment" : research ? "investigation" : "execution";
            if (
              prior === undefined ||
              prior.projectId !== task.projectId ||
              prior.taskId !== task.taskId ||
              prior.specRevision !== task.specRevision ||
              prior.planRevision !== (research || inherited ? 0 : plan!.planRevision) ||
              prior.contentHash !== scopeHash ||
              prior.evidenceIds.length !== 0 ||
              prior.attribution.actor.kind !== "human" ||
              (prior.gate !== targetKind && prior.gate !== "repair")
            )
              reject("Assignment grant is no longer current");
            if (
              prior.status === "consumed" ||
              (action === "reopen" && prior.status === "invalidated")
            ) {
              if (
                prior.status === "consumed" &&
                !records().some(
                  (r) =>
                    r.kind === "run-binding" &&
                    r.recordId === prior.consumedByRunId &&
                    r.taskId === task.taskId &&
                    r.authorizationGateId === prior.recordId &&
                    r.status === "settled",
                )
              )
                reject("Consumed predecessor grant lacks authoritative drain proof");
              renewedGrant = {
                ...fields("resumed-authorization"),
                kind: "gate",
                status: "approved",
                taskId: task.taskId,
                gate: targetKind,
                specRevision: task.specRevision,
                planRevision: research || inherited ? 0 : plan!.planRevision,
                contentHash: scopeHash,
                evidenceIds: [],
                attribution: prior.attribution,
                ...(prior.assignmentAuthorization === undefined
                  ? {}
                  : { assignmentAuthorization: prior.assignmentAuthorization }),
              };
              record(renewedGrant);
            } else if (prior.status !== "approved") reject("Assignment grant is no longer current");
          }
        }
        if (action === "resolve-failure") {
          const episode = records().find(
            (r) =>
              r.kind === "repair-episode" && r.taskId === task.taskId && r.status === "exhausted",
          );
          if (
            task.state !== "failed" &&
            !(task.state === "blocked" && episode?.kind === "repair-episode")
          )
            reject("Task has no failure to resolve");
          if (
            episode?.kind === "repair-episode" &&
            !records().some(
              (r) =>
                r.kind === "gate" &&
                r.recordId === episode.exceptionGrantId &&
                r.status === "approved",
            )
          )
            reject("Exhausted failure requires one exact human repair grant");
        }
        if (action === "reopen" && task.state !== "canceled" && task.state !== "completed")
          reject("Task is not terminal");
        record({
          ...m,
          revision: m.revision + 1,
          updatedAt: at,
          controlState: "active",
          ...(renewedGrant === undefined
            ? {}
            : {
                assignment: {
                  ...m.assignment!,
                  authorizationGateId: renewedGrant.recordId,
                },
              }),
        });
        if (action !== "resume") {
          if (task.blockerId !== undefined)
            emit({
              type: "project-work.task.blocker-resolved",
              taskId: task.taskId,
              blockerId: task.blockerId,
              resolvedAt: at,
              occurredAt: at,
            });
          emit({
            type: "project-work.task.reopened",
            taskId: task.taskId,
            reopenedAt: at,
            state:
              task.specification === undefined
                ? "draft"
                : action === "resolve-failure" || renewedGrant !== undefined
                  ? "ready"
                  : "specified",
            occurredAt: at,
          });
        }
      } else {
        const descendants = new Set<string>([task.taskId]);
        for (let size = -1; size !== descendants.size;) {
          size = descendants.size;
          for (const r of records())
            if (
              r.kind === "task-membership" &&
              r.parentTaskId !== undefined &&
              descendants.has(r.parentTaskId)
            )
              descendants.add(r.taskId);
        }
        for (const targetId of descendants) {
          const targetMembership = membership(targetId);
          if (targetMembership !== undefined)
            record({
              ...targetMembership,
              revision: targetMembership.revision + 1,
              updatedAt: at,
              controlState:
                action === "cancel"
                  ? records().some(
                      (r) => unresolvedWriter(r) && "taskId" in r && r.taskId === targetId,
                    )
                    ? "canceling"
                    : "canceled"
                  : action === "defer"
                    ? "deferred"
                    : "paused",
              ...(action === "reassign" && targetId === task.taskId
                ? { requestedSuccessorMemberId: intent.control.recipientMemberId }
                : {}),
            });
          stop(targetId, intent.control.reason);
          if (action === "cancel") {
            invalidate(targetId, intent.control.reason, false, true);
            emit({
              type: "project-work.task.canceled",
              taskId: ProjectWorkTaskId.make(targetId),
              canceledAt: at,
              occurredAt: at,
            });
          }
        }
      }
      break;
    }
    case "project-team.assignment.report": {
      const m = membership(task.taskId);
      if (
        m === undefined ||
        m.recordId !== intent.assignmentId ||
        m.revision !== intent.expectedAssignmentRevision ||
        m.status !== "active" ||
        (m.controlState !== undefined && m.controlState !== "active")
      )
        reject("Assignment is no longer current");
      const plan = currentPlan(task.taskId);
      if (
        task.specRevision !== intent.specRevision ||
        (plan?.planRevision ?? 0) !== intent.planRevision
      )
        reject("Report scope revision changed");
      if (
        binding !== undefined &&
        binding.scopeHash !== projectTeamScopeHash(state, task.taskId, plan)
      )
        reject("Report binding scope changed");
      unique(intent.evidenceIds);
      unique(intent.outputArtifactIds);
      const evidence = intent.evidenceIds.map((evidenceId) => {
        const e = state.evidence.find(
          (entry) => entry.evidenceId === evidenceId && entry.taskId === task.taskId,
        );
        if (e === undefined) reject("Report references missing retained evidence");
        if (e.scopeHash !== projectTeamScopeHash(state, task.taskId, plan))
          reject("Report evidence scope is stale");
        if (e.detail === undefined || e.detail.trim().length === 0)
          reject("Report references evidence without actual retained detail");
        return e;
      });
      unique((intent.outputs ?? []).map((output) => output.criterionId));
      for (const [index, output] of (intent.outputs ?? []).entries()) {
        const criterion = state.criteria.find(
          (c) => c.criterionId === output.criterionId && c.taskId === task.taskId,
        );
        if (criterion === undefined || output.detail.trim().length === 0)
          reject("Reported output requires an exact current criterion and retained detail");
        const retained = {
          evidenceId: ProjectWorkEvidenceId.make(id(`report-output:${index}`)),
          taskId: task.taskId,
          criterionId: output.criterionId,
          kind: output.kind,
          summary: output.summary ?? criterion.description,
          detail: output.detail,
          recordedAt: at,
          revision: 0,
          attribution: command.attribution,
          scopeHash: projectTeamScopeHash(state, task.taskId, plan),
        };
        emit({
          type: "project-work.evidence.added",
          evidence: retained,
          addedAt: at,
          occurredAt: at,
        });
        evidence.push(retained);
      }
      for (const artifactId of intent.outputArtifactIds) {
        const artifact = state.evidence.find(
          (e) =>
            e.evidenceId === artifactId &&
            e.taskId === task.taskId &&
            e.kind === "artifact" &&
            e.detail !== undefined &&
            e.detail.trim().length > 0,
        );
        if (artifact === undefined) reject("Output must identify actual retained artifact detail");
        if (artifact.scopeHash !== projectTeamScopeHash(state, task.taskId, plan))
          reject("Report artifact scope is stale");
        if (!evidence.some((e) => e.evidenceId === artifactId)) evidence.push(artifact);
      }
      emit({
        type: "project-work.evidence.added",
        addedAt: at,
        occurredAt: at,
        evidence: {
          evidenceId: ProjectWorkEvidenceId.make(id("report-evidence")),
          taskId: task.taskId,
          kind: "observation",
          summary: intent.summary,
          detail: intent.summary,
          outputArtifactIds: intent.outputArtifactIds.map((value) =>
            ProjectWorkEvidenceId.make(value),
          ),
          scopeHash: projectTeamScopeHash(state, task.taskId, plan),
          recordedAt: at,
          revision: 0,
          attribution: command.attribution,
        },
      });
      emit({
        type: "project-work.comment.added",
        occurredAt: at,
        addedAt: at,
        attribution: command.attribution,
        comment: {
          commentId: ProjectWorkCommentId.make(id("report")),
          projectId: command.projectId,
          taskId: task.taskId,
          body: intent.summary,
          createdAt: at,
          revision: 0,
          attribution: command.attribution,
        },
      });
      if (intent.outcome === "complete") {
        if (m.deliverableKind === "code")
          reject("Managed code completion requires authoritative actual delivery proof");
        dependencies(task, plan);
        for (const child of records().filter(
          (r): r is Membership =>
            r.kind === "task-membership" && r.parentTaskId === task.taskId && r.status === "active",
        )) {
          const result = evaluateProjectTeamDependency({
            projectId: task.projectId,
            taskId: child.taskId,
            task: state.tasks.find((t) => t.taskId === child.taskId),
            memberships: [child],
          });
          if (!result.available)
            reject(`Required child deliverable is incomplete: ${result.reason}`);
        }
        const required = state.criteria.filter(
          (c) =>
            c.taskId === task.taskId &&
            (c.required || task.specification?.criterionIds.includes(c.criterionId)),
        );
        if (
          (required.length === 0 &&
            !(
              m.executionKind === "human" &&
              m.deliverableKind === "reminder" &&
              task.specRevision === 0 &&
              intent.summary.trim().length > 0
            )) ||
          required.some(
            (c) =>
              c.status !== "waived" &&
              !evidence.some(
                (e) =>
                  e.criterionId === c.criterionId &&
                  e.detail !== undefined &&
                  e.detail.trim().length > 0,
              ),
          )
        )
          reject("Completion requires retained outputs for every required criterion");
        emit({
          type: "project-work.task.completed",
          taskId: task.taskId,
          satisfiedCriterionIds: required
            .filter((c) => c.status !== "waived")
            .map((c) => c.criterionId),
          ...(binding === undefined ? {} : { attemptId: binding.attemptId }),
          completedAt: at,
          occurredAt: at,
        });
        stop(task.taskId, "Assignment report complete; await authoritative process drain");
      } else if (intent.outcome === "review-ready") {
        // A retained report is a proposal; P11 decides when code evidence qualifies for review.
        if (evidence.length === 0) reject("Review-ready report requires retained evidence");
      }
      break;
    }
    case "project-team.repair.resolve": {
      const episode = records().find(
        (r) => r.kind === "repair-episode" && r.recordId === intent.episodeId,
      );
      if (
        episode?.kind !== "repair-episode" ||
        episode.taskId !== task.taskId ||
        episode.revision !== intent.expectedEpisodeRevision ||
        episode.failureFingerprint !== intent.failureFingerprint ||
        episode.relevantRevision !== intent.relevantRevision
      )
        reject("Repair decision target changed");
      if (intent.decision === "approve-one-repair") {
        if (
          episode.exceptionGrantId !== undefined &&
          records().some(
            (r) =>
              r.kind === "gate" &&
              r.recordId === episode.exceptionGrantId &&
              r.status === "approved",
          )
        )
          reject("Episode already has an unconsumed exception");
        const grant = gate(
          "repair",
          task,
          "repair",
          projectTeamRepairHash(episode),
          currentPlan(task.taskId)?.planRevision ?? 0,
          "approved",
        );
        record({
          ...episode,
          exceptionGrantId: grant.recordId,
          revision: episode.revision + 1,
          updatedAt: at,
        });
      } else if (intent.decision === "abandon") {
        record({ ...episode, status: "resolved", revision: episode.revision + 1, updatedAt: at });
        invalidate(task.taskId, intent.reason);
        emit({
          type: "project-work.task.canceled",
          taskId: task.taskId,
          canceledAt: at,
          occurredAt: at,
        });
      } else {
        stop(task.taskId, intent.reason);
        emit({
          type: "project-work.comment.added",
          occurredAt: at,
          addedAt: at,
          attribution: command.attribution,
          comment: {
            commentId: ProjectWorkCommentId.make(id("repair-decision")),
            projectId: command.projectId,
            taskId: task.taskId,
            body: intent.reason,
            createdAt: at,
            revision: 0,
            attribution: command.attribution,
          },
        });
      }
      break;
    }
  }
  return events;
};

export const projectTeamRepairHash = (
  episode: Extract<ProjectTeamRecord, { kind: "repair-episode" }>,
) =>
  projectTeamPlanHash({
    content: `${episode.recordId}\n${episode.failureFingerprint}\n${episode.relevantRevision}\n${episode.semanticRepairs}`,
    dependencyTaskIds: [],
  });

/** A receipt proves the old write, while current authority still governs replay. */
export const assertProjectTeamGuidedReplayCurrent = (
  state: ProjectWorkReducerState,
  input: ProjectTeamGuidedIntent,
  events: ReadonlyArray<ProjectWorkEvent>,
): void => {
  const finalRecords = new Map<string, ProjectTeamRecord>();
  const createdTasks = new Map<string, ProjectWorkTask>();
  const taskChanges = new Map<string, number>();
  const unchangedTaskEvents = new Set([
    "project-work.comment.added",
    "project-work.criterion.upserted",
    "project-work.evidence.added",
    "project-work.foundation.recorded",
  ]);
  for (const event of events) {
    if (event.type === "project-work.foundation.recorded")
      finalRecords.set(event.record.recordId, event.record);
    if (event.type === "project-work.task.created") createdTasks.set(event.task.taskId, event.task);
    else if ("taskId" in event && !unchangedTaskEvents.has(event.type))
      taskChanges.set(event.taskId, (taskChanges.get(event.taskId) ?? 0) + 1);
    if (event.type === "project-work.criterion.upserted") {
      const current = state.criteria.find((c) => c.criterionId === event.criterion.criterionId);
      if (canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(event.criterion))
        reject("Replay criterion target changed");
    }
    if (
      event.type === "project-work.evidence.added" &&
      !state.evidence.some(
        (e) => canonicalProjectWorkPayload(e) === canonicalProjectWorkPayload(event.evidence),
      )
    )
      reject("Replay report evidence is no longer retained");
    if (
      event.type === "project-work.comment.added" &&
      !state.comments?.some(
        (c) => canonicalProjectWorkPayload(c) === canonicalProjectWorkPayload(event.comment),
      )
    )
      reject("Replay report is no longer retained");
  }
  for (const [recordId, original] of finalRecords) {
    if (original.kind === "effect") continue;
    const current = state.foundationRecords?.find((r) => r.recordId === recordId);
    if (
      original.kind === "run-binding" &&
      current?.kind === "run-binding" &&
      current.status === "settled" &&
      (original.status === "stopping" || original.status === "quarantined")
    ) {
      if (
        canonicalProjectWorkPayload({
          ...current,
          status: original.status,
          revision: original.revision,
          updatedAt: original.updatedAt,
        }) !== canonicalProjectWorkPayload(original)
      )
        reject("Replay stopped binding identity changed");
    } else if (canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(original))
      reject("Replay semantic authority target changed");
  }
  const targets = new Set([input.taskId, ...createdTasks.keys(), ...taskChanges.keys()]);
  for (const taskId of targets) {
    const current = state.tasks.find((t) => t.taskId === taskId);
    const base = createdTasks.get(taskId)?.revision ?? input.expectedTaskRevision;
    if (
      current === undefined ||
      ((taskId === input.taskId || createdTasks.has(taskId)) &&
        current.revision !== base + (taskChanges.get(taskId) ?? 0))
    )
      reject("Replay task target changed");
    if (
      taskId !== input.taskId &&
      !createdTasks.has(taskId) &&
      events.some(
        (event) =>
          event.type === "project-work.task.canceled" &&
          event.taskId === taskId &&
          (current.state !== "canceled" || current.updatedAt !== event.canceledAt),
      )
    )
      reject("Replay descendant control target changed");
  }
  if (input.type === "project-team.assignment.report") {
    const plan = state.foundationRecords
      ?.filter(
        (r): r is Plan =>
          r.kind === "plan-revision" && r.taskId === input.taskId && r.status === "proposed",
      )
      .sort((a, b) => b.planRevision - a.planRevision)[0];
    const target = assertKnownTask(state, input.taskId);
    if (
      target.specRevision !== input.specRevision ||
      (plan?.planRevision ?? 0) !== input.planRevision ||
      [...input.evidenceIds, ...input.outputArtifactIds].some(
        (id) =>
          !state.evidence.some(
            (e) =>
              e.evidenceId === id &&
              e.taskId === input.taskId &&
              e.detail !== undefined &&
              e.detail.trim().length > 0 &&
              (!input.outputArtifactIds.includes(id) || e.kind === "artifact") &&
              e.scopeHash === projectTeamScopeHash(state, input.taskId, plan),
          ),
      )
    )
      reject("Replay output applicability changed");
  }
};
