import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  type ProjectTeamGuidedIntent,
  type ProjectTeamRecord,
  type ProjectWorkCommand,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  evaluateProjectTeamDependency,
  evaluateProjectTeamGate,
  type ProjectTeamGateTarget,
  assertProjectTeamAssignmentAuthorization,
  projectTeamSpecificationHash,
  projectTeamScopeHash,
  projectTeamPlanHash,
  assertProjectTeamOrdinarySuccessor,
  assertProjectTeamRunAuthority,
} from "./ProjectTeamPolicy.ts";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";
import { ProjectTeamAuthorization, managedActorId } from "./ProjectTeamAuthorization.ts";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { runMigrations } from "../persistence/Migrations.ts";

type Gate = Extract<ProjectTeamRecord, { kind: "gate" }>;
type Membership = Extract<ProjectTeamRecord, { kind: "task-membership" }>;
type RepairEpisode = Extract<ProjectTeamRecord, { kind: "repair-episode" }>;
const projectId = ProjectId.make("project-a");
const taskId = ProjectWorkTaskId.make("task-a");
const now = "2026-09-30T00:00:00.000Z";

type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Role = Extract<ProjectTeamRecord, { kind: "role-revision" }>;
type RunKind = "investigation" | "planning" | "review" | "execution";
const piReadonlyTools = ["pi.read", "project-work.read-project", "project-work.read-task"];
const legacyReadonlyTools = ["read", "search", "project-work", "project-work.report"];
const writableTools = [
  "pi.write",
  "pi.edit",
  "pi.bash",
  "write",
  "edit",
  "bash",
  "project-work.write",
  "project-work.delegate",
];

/** Real guided grants and atomic claims; no worker process is launched by this fixture. */
const currentRun = (kind: RunKind, toolIds = piReadonlyTools) => {
  let state = emptyProjectWorkReducerState(projectId);
  const commands: ProjectWorkCommand[] = [];
  const attribution = gate().attribution;
  const advance = (command: ProjectWorkCommand) => {
    state = applyProjectWorkEvents(state, decideProjectWorkCommand(state, command));
    commands.push(command);
  };
  const commit = (records: ProjectTeamRecord[]) =>
    advance({
      type: "project-work.foundation.commit",
      projectId,
      commandId: CommandId.make(`records-${state.revision}`),
      expectedRevision: state.revision,
      records,
      attribution,
      committedAt: now,
    });
  const envelope = () => ({
    projectId,
    taskId,
    commandId: CommandId.make(`guided-${state.revision}`),
    expectedRevision: state.revision,
    expectedTaskRevision: state.tasks.find((entry) => entry.taskId === taskId)!.revision,
  });
  const guided = (intent: ProjectTeamGuidedIntent) =>
    advance({
      type: "project-work.foundation.commit",
      projectId,
      commandId: intent.commandId,
      expectedRevision: intent.expectedRevision,
      attribution,
      records: [],
      committedAt: now,
      guided: { intent },
    });
  const approval = (kind: "specification" | "plan") =>
    state.foundationRecords!.find(
      (record): record is Gate =>
        record.kind === "gate" && record.taskId === taskId && record.gate === kind,
    )!;
  const approve = (kind: "specification" | "plan") => {
    const record = approval(kind);
    commit([{ ...record, status: "approved", revision: record.revision + 1 }]);
  };
  advance({
    type: "project-work.task.create",
    projectId,
    taskId,
    commandId: CommandId.make("capture-readonly"),
    title: "Investigate a bounded issue",
    createdAt: now,
  });
  if (kind !== "investigation") {
    guided({
      ...envelope(),
      type: "project-team.specification.propose",
      expectedSpecRevision: 0,
      specification: {
        objective: "Deliver one behavior",
        scopeIn: "The approved behavior",
        scopeOut: "Other implementation",
        criterionIds: [],
        revision: 1,
        protected: false,
      },
      criterionSnapshots: [],
    });
    approve("specification");
    if (kind !== "planning") {
      guided({
        ...envelope(),
        type: "project-team.plan.propose",
        specRevision: 1,
        content: "Implement and verify the approved behavior",
        dependencyTaskIds: [],
      });
      approve("plan");
    }
  }
  const plan = state.foundationRecords!.find(
    (record): record is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
      record.kind === "plan-revision",
  );
  if (kind === "investigation") {
    guided({
      ...envelope(),
      type: "project-team.investigation.start",
      objective: "Read source and report the cause",
      outputDescriptions: ["Sourced findings"],
    });
  } else if (kind === "execution") {
    guided({
      ...envelope(),
      type: "project-team.execution.start",
      specRevision: 1,
      planRevision: 1,
      specGateId: approval("specification").recordId,
      expectedSpecGateRevision: approval("specification").revision,
      planId: plan!.recordId,
      expectedPlanRecordRevision: plan!.revision,
      planGateId: approval("plan").recordId,
      expectedPlanGateRevision: approval("plan").revision,
    });
  } else {
    guided({
      ...envelope(),
      type: "project-team.assignment.start",
      assignmentKind: kind,
      objective: kind === "planning" ? "Draft the first plan" : "Review approved scope",
      outputDescriptions: [kind === "planning" ? "Proposed plan" : "Review findings"],
      specRevision: 1,
      specificationGateId: approval("specification").recordId,
      expectedSpecificationGateRevision: approval("specification").revision,
      ...(plan === undefined
        ? {}
        : {
            parentPlan: {
              recordId: plan.recordId,
              expectedRecordRevision: plan.revision,
              planRevision: plan.planRevision,
              gateId: approval("plan").recordId,
              expectedGateRevision: approval("plan").revision,
            },
          }),
    });
  }
  const assignedTask = state.tasks.find((entry) =>
    kind === "execution" ? entry.taskId === taskId : entry.taskId !== taskId,
  )!;
  const template = state.foundationRecords!.find(
    (record): record is Role => record.kind === "role-revision",
  );
  const role: Role = {
    kind: "role-revision",
    recordId: "frozen-pi-role",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: now,
    status: "available",
    roleId: kind,
    roleRevision: 1,
    role: template?.role ?? "implementer",
    instructions: "Stay in the granted scope",
    skills: [],
    tools: [
      ...legacyReadonlyTools,
      ...piReadonlyTools,
      ...(kind === "planning" ? ["project-work.plan"] : []),
      ...(kind === "execution" ? writableTools : []),
    ],
    model: "fixture-model",
    memoryAccess: "project",
    delegationDepth: 0,
  };
  commit([
    role,
    {
      kind: "member",
      recordId: "pi-member",
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: now,
      status: "active",
      name: "Assigned worker",
      coordinator: false,
      roleRevisionId: role.recordId,
    },
  ]);
  const grant = state.foundationRecords!.find(
    (record): record is Gate =>
      record.kind === "gate" &&
      record.taskId === assignedTask.taskId &&
      (record.gate === "investigation" ||
        record.gate === "assignment" ||
        record.gate === "execution"),
  )!;
  const binding: Binding = {
    kind: "run-binding",
    recordId: "pi-run",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: now,
    status: "reserved",
    taskId: assignedTask.taskId,
    attemptId: ProjectWorkAttemptId.make("pi-attempt"),
    memberId: "pi-member",
    roleRevisionId: role.recordId,
    providerInstanceId: ProviderInstanceId.make("pi"),
    threadId: ThreadId.make("pi-readonly-thread"),
    environmentId: EnvironmentId.make("policy-test"),
    model: role.model,
    configuration: {
      instructionsHash: "fixture-instructions",
      toolIds,
      skillIds: [],
      runtimeVersion: "fixture",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    worktree: "/fixture/pi-worktree",
    branch: "fixture-branch",
    leaseGeneration: 0,
    specRevision: assignedTask.specRevision,
    planRevision: kind === "execution" ? plan!.planRevision : 0,
    authorizationGateId: grant.recordId,
    ...(kind === "execution"
      ? {
          specificationGateId: approval("specification").recordId,
          planGateId: approval("plan").recordId,
        }
      : {}),
    scopeHash: projectTeamScopeHash(
      state,
      assignedTask.taskId,
      kind === "execution" ? plan : undefined,
    ),
  };
  const commandId = CommandId.make("claim-pi-run");
  advance({
    type: "project-work.foundation.commit",
    projectId,
    commandId,
    expectedRevision: state.revision,
    records: [],
    attribution: {
      actor: { kind: "system", id: "scheduler" },
      source: { kind: "system", id: "scheduler" },
      recordedAt: now,
    },
    committedAt: now,
    transition: {
      kind: "claim",
      taskId: binding.taskId,
      expectedTaskRevision: assignedTask.revision,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      binding,
      claim: {
        type: "project-work.task.claim",
        projectId,
        taskId: binding.taskId,
        commandId,
        attemptId: binding.attemptId,
        leaseToken: "pi-lease",
        leasedUntil: "2026-10-01T00:00:00.000Z",
        claimedAt: now,
      },
    },
  });
  const running = { ...binding, status: "running" as const, revision: 1, sessionId: "pi-native" };
  commit([running]);
  return { state, commands, role, binding: running };
};

describe("Pi readonly run capabilities", () => {
  it.each(["investigation", "planning", "review"] as const)(
    "permits exact readonly Pi capabilities under the real %s grant",
    (kind) => {
      const { state, binding, role } = currentRun(kind);
      expect(() => assertProjectTeamRunAuthority(state, binding, role, false)).not.toThrow();
      expect(
        state.foundationRecords!.filter(
          (record) => record.kind === "gate" && record.gate === "execution",
        ),
      ).toEqual([]);
      expect(
        state.foundationRecords!.find((record) => record.recordId === binding.authorizationGateId),
      ).toMatchObject({
        gate: kind === "investigation" ? "investigation" : "assignment",
        status: "consumed",
        consumedByRunId: binding.recordId,
      });
      expect(binding.configuration.toolIds.every((tool) => role.tools.includes(tool))).toBe(true);
    },
  );

  it.each(["investigation", "planning", "review"] as const)(
    "preserves legacy readonly capabilities for %s",
    (kind) => {
      const { state, binding, role } = currentRun(kind, legacyReadonlyTools);
      expect(() => assertProjectTeamRunAuthority(state, binding, role, false)).not.toThrow();
    },
  );

  it.each(["investigation", "planning", "review"] as const)(
    "denies writable and delegated tools even when the frozen %s role advertises them",
    (kind) => {
      const { state, binding, role } = currentRun(kind, legacyReadonlyTools);
      for (const tool of [
        ...writableTools,
        "pi.read-extra",
        "project-work.read-task-extra",
        ...(kind === "planning" ? [] : ["project-work.plan"]),
      ]) {
        const grantedRole = { ...role, tools: [...role.tools, tool] };
        const selected = {
          ...binding,
          configuration: { ...binding.configuration, toolIds: [tool] },
        };
        expect(() => assertProjectTeamRunAuthority(state, selected, grantedRole, false)).toThrow(
          "writable implementation authority",
        );
      }
    },
  );

  it("permits planning output only for the inherited planner", () => {
    const { state, binding, role } = currentRun("planning", [
      "project-work.plan",
      ...piReadonlyTools,
    ]);
    expect(() => assertProjectTeamRunAuthority(state, binding, role, false)).not.toThrow();
  });

  it.each(["investigation", "planning", "review"] as const)(
    "requires selected Pi tools to remain a subset of the frozen %s role",
    (kind) => {
      const { state, binding, role } = currentRun(kind);
      for (const tool of piReadonlyTools) {
        const narrowed = { ...role, tools: role.tools.filter((entry) => entry !== tool) };
        expect(() => assertProjectTeamRunAuthority(state, binding, narrowed, false)).toThrow(
          "frozen capabilities changed",
        );
      }
    },
  );

  it.each(["investigation", "planning", "review"] as const)(
    "does not renew stale or revoked %s authority for readonly tools",
    (kind) => {
      const { state, binding, role } = currentRun(kind);
      const staleSpecification = {
        ...state,
        tasks: state.tasks.map((entry) =>
          entry.taskId === binding.taskId
            ? { ...entry, specRevision: entry.specRevision + 1 }
            : entry,
        ),
      };
      expect(() => assertProjectTeamRunAuthority(staleSpecification, binding, role, false)).toThrow(
        "scope changed",
      );
      for (const status of ["invalidated", "rejected", "approved"] as const) {
        const revoked = {
          ...state,
          foundationRecords: state.foundationRecords!.map((record) =>
            record.recordId === binding.authorizationGateId && record.kind === "gate"
              ? { ...record, status }
              : record,
          ),
        };
        expect(() => assertProjectTeamRunAuthority(revoked, binding, role, false)).toThrow(
          "consumed human grant",
        );
      }
      expect(() =>
        assertProjectTeamRunAuthority(state, { ...binding, status: "revoked" }, role, false),
      ).toThrow("no longer active");
      expect(() =>
        assertProjectTeamRunAuthority(state, binding, { ...role, status: "retired" }, false),
      ).toThrow("no longer available");
      if (kind !== "investigation") {
        const staleParent = {
          ...state,
          tasks: state.tasks.map((entry) =>
            entry.taskId === taskId ? { ...entry, specRevision: entry.specRevision + 1 } : entry,
          ),
        };
        expect(() => assertProjectTeamRunAuthority(staleParent, binding, role, false)).toThrow(
          "parent specification",
        );
        const revokedParent = {
          ...state,
          foundationRecords: state.foundationRecords!.map((record) =>
            record.kind === "gate" && record.taskId === taskId
              ? { ...record, status: "invalidated" as const }
              : record,
          ),
        };
        expect(() => assertProjectTeamRunAuthority(revokedParent, binding, role, false)).toThrow(
          "specification approval is stale",
        );
      }
    },
  );

  it("preserves ordinary execution's explicitly approved writable capabilities", () => {
    const { state, binding, role } = currentRun("execution", [
      ...piReadonlyTools,
      ...writableTools,
    ]);
    expect(() => assertProjectTeamRunAuthority(state, binding, role, false)).not.toThrow();
  });
});

for (const kind of ["investigation", "planning", "review", "execution"] as const) {
  effectIt.effect(`resolves genuine ${kind} authority from current SQLite history`, () =>
    scoped(
      Effect.gen(function* () {
        const fixture = currentRun(kind);
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectWorkRepository;
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/fixture','[]',${now},${now})`;
        for (const command of fixture.commands) yield* repository.execute(command);
        yield* TestClock.setTime(Date.parse(now));
        const auth = yield* ProjectTeamAuthorization;
        const authority = yield* auth.issueCredential({
          providerInstanceId: fixture.binding.providerInstanceId,
          threadId: fixture.binding.threadId,
        });
        expect(authority).toBeDefined();
        const credential = authority!.credential;
        const principal = {
          actor: { kind: "agent" as const, id: managedActorId(credential) },
          managed: credential,
        };
        expect(yield* auth.resolve(principal)).toMatchObject({
          binding: { recordId: "pi-run", configuration: { toolIds: piReadonlyTools } },
        });
        yield* auth.read(principal, {
          projectId,
          taskId: fixture.binding.taskId,
          operation: "task",
        });
        expect(
          (yield* auth
            .resolve({
              ...principal,
              managed: { ...credential, generation: credential.generation + 1 },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00.000Z"));
        expect((yield* auth.resolve(principal).pipe(Effect.result))._tag).toBe("Failure");
        yield* TestClock.setTime(Date.parse(now));
        expect(yield* auth.resolve(principal)).toBeDefined();
        yield* repository.execute({
          type: "project-work.foundation.commit",
          projectId,
          commandId: CommandId.make("revoke-pi-run"),
          expectedRevision: fixture.state.revision,
          attribution: gate().attribution,
          records: [
            { ...fixture.binding, status: "revoked", revision: fixture.binding.revision + 1 },
          ],
          committedAt: now,
        });
        expect((yield* auth.resolve(principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
  );
}

describe("ordinary successor repair fence", () => {
  const episode: RepairEpisode = {
    kind: "repair-episode",
    recordId: "episode",
    projectId,
    taskId,
    rootTaskId: taskId,
    revision: 0,
    generation: 0,
    updatedAt: now,
    status: "active",
    failureFingerprint: "failure",
    relevantRevision: "tree-a",
    allowance: 2,
    semanticRepairs: 0,
    transportRetries: 0,
    timeoutCount: 0,
    attemptIds: [],
  };
  it.each([undefined, true])("denies pending or ambiguous semantic history %s", (pending) => {
    const current =
      pending === undefined ? episode : { ...episode, pendingSemanticRepair: pending };
    const state = { ...emptyProjectWorkReducerState(projectId), foundationRecords: [current] };
    expect(() => assertProjectTeamOrdinarySuccessor(state, taskId)).toThrow(
      "exact repair authorization",
    );
  });
  it("allows explicit transport-only or already debited history without resetting counters", () => {
    const current = {
      ...episode,
      pendingSemanticRepair: false,
      transportRetries: 3,
      semanticRepairs: 1,
    };
    const state = { ...emptyProjectWorkReducerState(projectId), foundationRecords: [current] };
    expect(() => assertProjectTeamOrdinarySuccessor(state, taskId)).not.toThrow();
    expect(current.semanticRepairs).toBe(1);
    expect(current.transportRetries).toBe(3);
  });
  it("denies exhausted history even after a prior debit", () => {
    const state = {
      ...emptyProjectWorkReducerState(projectId),
      foundationRecords: [
        { ...episode, status: "exhausted" as const, pendingSemanticRepair: false },
      ],
    };
    expect(() => assertProjectTeamOrdinarySuccessor(state, taskId)).toThrow();
  });
  it("ignores another task's episode", () => {
    const state = { ...emptyProjectWorkReducerState(projectId), foundationRecords: [episode] };
    expect(() => assertProjectTeamOrdinarySuccessor(state, "other-task")).not.toThrow();
  });
});
const gate = (overrides: Partial<Gate> = {}): Gate => ({
  kind: "gate",
  recordId: "execution-approval",
  projectId,
  taskId,
  revision: 1,
  generation: 0,
  updatedAt: now,
  gate: "execution",
  status: "approved",
  specRevision: 3,
  planRevision: 2,
  contentHash: "approved-assignment",
  evidenceIds: ["validation", "review"],
  attribution: {
    actor: { kind: "human", id: "maintainer" },
    source: { kind: "web", id: "client" },
    recordedAt: now,
  },
  ...overrides,
});
const target = (overrides: Partial<ProjectTeamGateTarget> = {}): ProjectTeamGateTarget => ({
  projectId,
  taskId,
  gate: "execution",
  specRevision: 3,
  planRevision: 2,
  contentHash: "approved-assignment",
  evidenceIds: ["validation", "review"],
  ...overrides,
});
const mergeTarget = (): ProjectTeamGateTarget =>
  target({
    gate: "merge",
    repository: "github.com/team/repo",
    pullRequestNumber: 17,
    headSha: "approved-head",
    targetBranch: "main",
    mergeMethod: "squash",
  });
const task = (overrides: Partial<ProjectWorkTask> = {}): ProjectWorkTask => ({
  projectId,
  taskId,
  title: "Dependency",
  state: "completed",
  watchers: [],
  revision: 4,
  specRevision: 3,
  createdAt: now,
  updatedAt: now,
  completedAt: now,
  ...overrides,
});
const membership = (overrides: Partial<Membership> = {}): Membership => ({
  kind: "task-membership",
  recordId: "membership-a",
  projectId,
  taskId,
  revision: 0,
  generation: 0,
  updatedAt: now,
  status: "active",
  executionKind: "managed",
  deliverableKind: "research",
  ...overrides,
});

describe("inherited assignment authorization", () => {
  const fixture = () => {
    const state = emptyProjectWorkReducerState(projectId);
    state.tasks.push(
      task({
        state: "ready",
        specification: {
          objective: "Approved objective",
          scopeIn: "One deliverable",
          scopeOut: "Unapproved implementation",
          criterionIds: [],
          revision: 3,
          protected: true,
        },
      }),
    );
    state.foundationRecords = [membership({ deliverableKind: "code" })];
    const specificationHash = projectTeamSpecificationHash(state, taskId);
    state.foundationRecords.push(
      gate({
        recordId: "specification",
        gate: "specification",
        contentHash: specificationHash,
        planRevision: 0,
        evidenceIds: [],
      }),
    );
    const assignment = gate({
      recordId: "planning",
      taskId: ProjectWorkTaskId.make("child"),
      gate: "assignment",
      specRevision: 1,
      planRevision: 0,
      evidenceIds: [],
      assignmentAuthorization: {
        assignmentKind: "planning",
        parentTaskId: taskId,
        parentSpecRevision: 3,
        parentSpecificationGateId: "specification",
        parentSpecificationHash: specificationHash,
        parentScopeHash: projectTeamScopeHash(state, taskId),
      },
    });
    return { state, assignment };
  };

  it("permits first-plan drafting from the exact Human-approved specification", () => {
    const { state, assignment } = fixture();
    expect(assertProjectTeamAssignmentAuthorization(state, assignment)).toEqual(
      assignment.assignmentAuthorization,
    );
  });

  it("rejects stale, foreign, unapproved and paused parent authority", () => {
    for (const change of ["specification", "approval", "pause", "project"] as const) {
      const { state, assignment } = fixture();
      if (change === "specification") state.tasks[0] = { ...state.tasks[0]!, specRevision: 4 };
      if (change === "approval")
        state.foundationRecords = state.foundationRecords!.map((record) =>
          record.kind === "gate" ? { ...record, status: "invalidated" } : record,
        );
      if (change === "pause")
        state.foundationRecords = state.foundationRecords!.map((record) =>
          record.kind === "task-membership" ? { ...record, controlState: "paused" } : record,
        );
      if (change === "project")
        state.tasks[0] = { ...state.tasks[0]!, projectId: ProjectId.make("foreign") };
      expect(() => assertProjectTeamAssignmentAuthorization(state, assignment)).toThrow();
    }
  });

  it("requires the review's exact approved parent plan and invalidates moved scope", () => {
    const { state, assignment } = fixture();
    const plan: Extract<ProjectTeamRecord, { kind: "plan-revision" }> = {
      kind: "plan-revision",
      recordId: "parent-plan",
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: now,
      status: "proposed",
      taskId,
      specRevision: 3,
      planRevision: 1,
      content: "Approved bounded plan",
      dependencyTaskIds: [],
      contentHash: projectTeamPlanHash({ content: "Approved bounded plan", dependencyTaskIds: [] }),
    };
    state.foundationRecords!.push(
      plan,
      gate({
        recordId: "plan-approval",
        gate: "plan",
        contentHash: plan.contentHash,
        specRevision: 3,
        planRevision: 1,
        evidenceIds: [],
      }),
    );
    expect(() => assertProjectTeamAssignmentAuthorization(state, assignment)).toThrow();
    const review = {
      ...assignment,
      assignmentAuthorization: {
        ...assignment.assignmentAuthorization!,
        assignmentKind: "review" as const,
        parentScopeHash: projectTeamScopeHash(state, taskId, plan),
        parentPlan: {
          recordId: plan.recordId,
          planRevision: 1,
          contentHash: plan.contentHash,
          gateId: "plan-approval",
        },
      },
    };
    expect(assertProjectTeamAssignmentAuthorization(state, review)).toEqual(
      review.assignmentAuthorization,
    );
    state.foundationRecords = state.foundationRecords!.map((record) =>
      record.recordId === plan.recordId && record.kind === "plan-revision"
        ? { ...record, content: "Changed plan" }
        : record,
    );
    expect(() => assertProjectTeamAssignmentAuthorization(state, review)).toThrow();
  });
});

describe("evaluateProjectTeamGate", () => {
  it.each(["investigation", "specification", "plan", "execution"] as const)(
    "accepts an exact human-approved %s target",
    (kind) => {
      expect(evaluateProjectTeamGate(gate({ gate: kind }), target({ gate: kind }))).toEqual({
        available: true,
      });
    },
  );

  it("rejects a missing approval", () => {
    expect(evaluateProjectTeamGate(undefined, target())).toEqual({
      available: false,
      reason: "missing-gate",
    });
  });

  it.each(["proposed", "pending", "rejected", "invalidated", "consumed"] as const)(
    "rejects a %s gate without renewing it",
    (status) => {
      expect(evaluateProjectTeamGate(gate({ status }), target())).toEqual({
        available: false,
        reason: "gate-not-approved",
      });
    },
  );

  it("rejects agent-attributed approval", () => {
    const approval = gate();
    expect(
      evaluateProjectTeamGate(
        { ...approval, attribution: { ...approval.attribution, actor: { kind: "agent" } } },
        target(),
      ),
    ).toEqual({ available: false, reason: "human-approval-required" });
  });

  it.each([
    { projectId: ProjectId.make("project-b") },
    { taskId: ProjectWorkTaskId.make("task-b") },
    { gate: "plan" as const },
    { specRevision: 4 },
    { planRevision: 3 },
    { contentHash: "new-assignment" },
  ])("rejects approval for another target: %j", (change) => {
    expect(evaluateProjectTeamGate(gate(), target(change))).toEqual({
      available: false,
      reason: "stale-gate-target",
    });
  });

  it("treats evidence identity as a set", () => {
    expect(
      evaluateProjectTeamGate(gate(), target({ evidenceIds: ["review", "validation"] })),
    ).toEqual({ available: true });
  });

  it.each([["review"], ["review", "validation", "integration"], ["review", "other"]])(
    "rejects changed applicable evidence: %j",
    (...evidenceIds) => {
      expect(evaluateProjectTeamGate(gate(), target({ evidenceIds }))).toEqual({
        available: false,
        reason: "stale-gate-evidence",
      });
    },
  );

  it.each([
    ["review", "review"],
    [""],
    ["   "],
    [" review"],
    ["review "],
    ["x".repeat(257)],
    Array.from({ length: 65 }, (_, index) => `evidence-${index}`),
  ])("rejects malformed evidence in either side: %j", (...evidenceIds) => {
    expect(evaluateProjectTeamGate(gate({ evidenceIds }), target())).toEqual({
      available: false,
      reason: "invalid-gate-evidence",
    });
    expect(evaluateProjectTeamGate(gate(), target({ evidenceIds }))).toEqual({
      available: false,
      reason: "invalid-gate-evidence",
    });
  });

  it("accepts a merge approval for the exact remote target", () => {
    const current = mergeTarget();
    expect(evaluateProjectTeamGate(gate(current), current)).toEqual({ available: true });
  });

  it.each([
    { repository: "github.com/team/other" },
    { pullRequestNumber: 18 },
    { headSha: "new-head" },
    { targetBranch: "release" },
    { mergeMethod: "rebase" as const },
  ])("rejects changed merge target: %j", (change) => {
    const current = mergeTarget();
    expect(evaluateProjectTeamGate(gate(current), { ...current, ...change })).toEqual({
      available: false,
      reason: "stale-merge-target",
    });
  });

  it.each(["repository", "pullRequestNumber", "headSha", "targetBranch", "mergeMethod"] as const)(
    "rejects absent merge %s in either side",
    (field) => {
      const current = mergeTarget();
      const incomplete = { ...current };
      delete incomplete[field];
      expect(evaluateProjectTeamGate(gate(incomplete), current)).toEqual({
        available: false,
        reason: "invalid-merge-target",
      });
      expect(evaluateProjectTeamGate(gate(current), incomplete)).toEqual({
        available: false,
        reason: "invalid-merge-target",
      });
    },
  );

  it.each([
    { repository: " " },
    { headSha: "" },
    { targetBranch: " main" },
    { pullRequestNumber: 0 },
    { pullRequestNumber: -1 },
    { pullRequestNumber: 1.5 },
  ])("rejects malformed merge tuple: %j", (change) => {
    const current = mergeTarget();
    expect(evaluateProjectTeamGate(gate({ ...current, ...change }), current)).toEqual({
      available: false,
      reason: "invalid-merge-target",
    });
  });

  it("permits empty applicable evidence without inventing evidence requirements", () => {
    expect(evaluateProjectTeamGate(gate({ evidenceIds: [] }), target({ evidenceIds: [] }))).toEqual(
      { available: true },
    );
  });
});

describe("evaluateProjectTeamDependency", () => {
  const evaluate = (
    dependency: ProjectWorkTask | undefined,
    memberships: ReadonlyArray<Membership>,
  ) => evaluateProjectTeamDependency({ projectId, taskId, task: dependency, memberships });

  it("accepts completed legacy work without membership", () => {
    expect(evaluate(task(), [])).toEqual({ available: true });
  });

  it.each(["legacy", "human"] as const)("accepts completed %s work", (executionKind) => {
    expect(evaluate(task(), [membership({ executionKind, deliverableKind: "code" })])).toEqual({
      available: true,
    });
  });

  it.each(["research", "plan", "review", "reminder", "non-code"] as const)(
    "accepts completed managed %s without requiring a PR",
    (deliverableKind) => {
      expect(evaluate(task(), [membership({ deliverableKind })])).toEqual({ available: true });
    },
  );

  it("does not treat completed managed code as delivered", () => {
    expect(evaluate(task(), [membership({ deliverableKind: "code" })])).toEqual({
      available: false,
      reason: "delivery-proof-required",
    });
  });

  it.each([
    "draft",
    "specified",
    "ready",
    "in-progress",
    "blocked",
    "in-review",
    "failed",
    "canceled",
  ] as const)("does not treat %s as dependency success", (state) => {
    expect(evaluate(task({ state }), [membership()])).toEqual({
      available: false,
      reason: "dependency-not-completed",
    });
  });

  it("rejects a missing dependency", () => {
    expect(evaluate(undefined, [])).toEqual({ available: false, reason: "missing-dependency" });
  });

  it("rejects a dependency from another project", () => {
    expect(evaluate(task({ projectId: ProjectId.make("project-b") }), [])).toEqual({
      available: false,
      reason: "dependency-project-mismatch",
    });
  });

  it("rejects another task passed as the dependency", () => {
    expect(evaluate(task({ taskId: ProjectWorkTaskId.make("task-b") }), [])).toEqual({
      available: false,
      reason: "dependency-task-mismatch",
    });
  });

  it("rejects a matching membership from another project", () => {
    expect(evaluate(task(), [membership({ projectId: ProjectId.make("project-b") })])).toEqual({
      available: false,
      reason: "dependency-project-mismatch",
    });
  });

  it("does not downgrade removed managed code membership to legacy", () => {
    expect(evaluate(task(), [membership({ status: "removed", deliverableKind: "code" })])).toEqual({
      available: false,
      reason: "dependency-membership-removed",
    });
  });

  it("rejects conflicting memberships regardless of input order", () => {
    const records = [
      membership(),
      membership({ recordId: "membership-b", deliverableKind: "code" }),
    ];
    expect(evaluate(task(), records)).toEqual({
      available: false,
      reason: "ambiguous-dependency-membership",
    });
    expect(evaluate(task(), records.toReversed())).toEqual({
      available: false,
      reason: "ambiguous-dependency-membership",
    });
  });

  it("ignores unrelated task membership", () => {
    expect(
      evaluate(task(), [
        membership({ taskId: ProjectWorkTaskId.make("task-b"), deliverableKind: "code" }),
      ]),
    ).toEqual({ available: true });
  });
});
