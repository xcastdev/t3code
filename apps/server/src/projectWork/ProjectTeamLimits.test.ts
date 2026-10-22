import {
  ProjectId,
  RunId,
  ProjectWorkTaskId,
  ProjectTeamLimits,
  ProjectTeamRoleRevision,
  ProjectTeamTaskMembership,
  ProjectTeamRunBinding,
  ProjectWorkTask,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { resolveProjectTeamLimits } from "./ProjectTeamLimits.ts";

const projectId = ProjectId.make("limits-project");
const taskId = ProjectWorkTaskId.make("root");
const at = "2026-01-01T00:00:00.000Z";
const common = { projectId, revision: 3, generation: 0, updatedAt: at };
const decodeLimits = Schema.decodeUnknownSync(ProjectTeamLimits);
const decodeRole = Schema.decodeUnknownSync(ProjectTeamRoleRevision);
const decodeMembership = Schema.decodeUnknownSync(ProjectTeamTaskMembership);
const decodeTask = Schema.decodeUnknownSync(ProjectWorkTask);
const decodeBinding = Schema.decodeUnknownSync(ProjectTeamRunBinding);
const limits = (overrides: Partial<typeof ProjectTeamLimits.Type> = {}) =>
  decodeLimits({
    ...common,
    kind: "limits",
    recordId: "limits",
    status: "configured",
    environmentModelCalls: 8,
    projectWritableWorkers: 1,
    modelCalls: 3,
    delegationDepth: 2,
    repairAllowance: 2,
    model: "configured-model",
    tokenLimit: 1000,
    durationLimitMs: 100,
    ...overrides,
  });
const role = (overrides: Partial<typeof ProjectTeamRoleRevision.Type> = {}) =>
  decodeRole({
    ...common,
    kind: "role-revision",
    recordId: "role",
    status: "available",
    roleId: "implementer",
    roleRevision: 1,
    role: "implementer",
    instructions: "bounded",
    skills: [],
    tools: ["pi.write"],
    model: "configured-model",
    memoryAccess: "none",
    delegationDepth: 2,
    ...overrides,
  });
const membership = (id = taskId, overrides: Partial<typeof ProjectTeamTaskMembership.Type> = {}) =>
  decodeMembership({
    ...common,
    kind: "task-membership",
    recordId: `membership-${id}`,
    status: "active",
    taskId: id,
    executionKind: "managed",
    deliverableKind: "code",
    ...overrides,
  });
const task = (id = taskId) =>
  decodeTask({
    ...common,
    taskId: id,
    title: "Bounded",
    state: "ready",
    specRevision: 0,
    createdAt: at,
  });
const fixture = (records: ProjectTeamRecord[] = [role(), limits(), membership()]) => ({
  state: {
    ...emptyProjectWorkReducerState(projectId),
    tasks: [task()],
    foundationRecords: records,
  },
  taskId,
  roleRevisionId: "role",
  nowMs: 1000,
  environmentModelCalls: 2,
  writable: true,
  attemptConfiguration: { maxTokens: 2000, maxDurationMs: 200, paidFallback: false as const },
});
const binding = (id: string, idTask = taskId, parentRunId?: string) =>
  decodeBinding({
    ...common,
    kind: "run-binding",
    runId: id,
    recordId: id,
    status: "settled",
    taskId: idTask,
    attemptId: `${id}-attempt`,
    memberId: "member",
    roleRevisionId: "role",
    providerInstanceId: "pi",
    threadId: `${id}-thread`,
    environmentId: "env",
    model: "configured-model",
    configuration: {
      instructionsHash: "hash",
      toolIds: [],
      skillIds: [],
      runtimeVersion: "test",
      maxTokens: 1000,
      maxDurationMs: 100,
      paidFallback: false,
    },
    worktree: "/sandbox",
    branch: "task",
    leaseGeneration: 0,
    specRevision: 0,
    planRevision: 0,
    ...(parentRunId === undefined ? {} : { parentRunId }),
  });
const budget = { rootTaskId: taskId, maximumTokens: 1000, deadlineAtMs: 1100 };
const eligible = (input: Parameters<typeof resolveProjectTeamLimits>[0]) => {
  const result = resolveProjectTeamLimits(input);
  expect(result._tag).toBe("Eligible");
  if (result._tag !== "Eligible") throw new Error(result.reason);
  return result.frozen;
};

describe("resolveProjectTeamLimits", () => {
  it("freezes configured policy and conservative environment/depth defaults", () => {
    expect(eligible(fixture())).toEqual({
      rootTaskId: taskId,
      maximumTokens: 1000,
      attemptMaximumTokens: 1000,
      rootDeadlineAtMs: 1100,
      deadlineAtMs: 1100,
      delegationDepth: 0,
      maximumDelegationDepth: 2,
      repairAllowance: 2,
      environmentModelCalls: 2,
      projectWritableWorkers: 1,
      modelCalls: 3,
      writable: true,
      limitsRecordId: "limits",
      limitsRevision: 3,
    });
  });
  it.each([
    [
      "ambiguous",
      [role(), limits(), limits({ recordId: "other" }), membership()],
      "ambiguous-limits",
    ],
    ["disabled", [role(), limits({ status: "disabled" }), membership()], "limits-disabled"],
    ["retired role", [role({ status: "retired" }), limits(), membership()], "invalid-role"],
    ["missing role", [limits(), membership()], "missing-role"],
    ["ambiguous role", [role(), role(), limits(), membership()], "ambiguous-role"],
  ] as const)("blocks %s policy", (_name, records, reason) => {
    expect(resolveProjectTeamLimits(fixture([...records]))).toEqual({ _tag: "Blocked", reason });
  });
  it.each(["tokenLimit", "durationLimitMs", "modelCalls", "environmentModelCalls"] as const)(
    "denies zero %s",
    (field) => {
      expect(
        resolveProjectTeamLimits(fixture([role(), limits({ [field]: 0 }), membership()])),
      ).toEqual({ _tag: "Blocked", reason: "limits-exhausted" });
    },
  );
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe input number %s",
    (value) => {
      for (const input of [
        { ...fixture(), nowMs: value },
        { ...fixture(), environmentModelCalls: value },
        {
          ...fixture(),
          attemptConfiguration: { ...fixture().attemptConfiguration, maxTokens: value },
        },
        {
          ...fixture(),
          attemptConfiguration: { ...fixture().attemptConfiguration, maxDurationMs: value },
        },
        { ...fixture(), rootBudget: { ...budget, maximumTokens: value } },
        { ...fixture(), rootBudget: { ...budget, deadlineAtMs: value } },
      ])
        expect(resolveProjectTeamLimits(input)).toEqual({
          _tag: "Blocked",
          reason: "invalid-input",
        });
    },
  );
  it.each(["maxTokens", "maxDurationMs"] as const)("requires positive explicit %s", (field) => {
    expect(
      resolveProjectTeamLimits({
        ...fixture(),
        attemptConfiguration: { ...fixture().attemptConfiguration, [field]: 0 },
      }),
    ).toEqual({ _tag: "Blocked", reason: "invalid-input" });
  });
  it("rejects paid fallback at runtime", () => {
    const input = fixture();
    Reflect.set(input.attemptConfiguration, "paidFallback", true);
    expect(resolveProjectTeamLimits(input)).toEqual({ _tag: "Blocked", reason: "invalid-input" });
  });
  it.each(["tokenLimit", "durationLimitMs", "revision"] as const)(
    "rejects unsafe configured %s",
    (field) => {
      const policy = limits();
      Reflect.set(policy, field, Number.MAX_SAFE_INTEGER + 1);
      expect(resolveProjectTeamLimits(fixture([role(), policy, membership()]))).toEqual({
        _tag: "Blocked",
        reason: "invalid-limits",
      });
    },
  );
  it("blocks unsafe deadline addition", () => {
    expect(resolveProjectTeamLimits({ ...fixture(), nowMs: Number.MAX_SAFE_INTEGER - 99 })).toEqual(
      { _tag: "Blocked", reason: "deadline-overflow" },
    );
  });
  it("allows the exact safe deadline boundary", () => {
    expect(eligible({ ...fixture(), nowMs: Number.MAX_SAFE_INTEGER - 100 }).rootDeadlineAtMs).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it.each([999, 1000])("denies expired immutable root deadline %s", (deadlineAtMs) => {
    expect(
      resolveProjectTeamLimits({ ...fixture(), rootBudget: { ...budget, deadlineAtMs } }),
    ).toEqual({ _tag: "Blocked", reason: "deadline-expired" });
  });
  it("does not reset root budget after replacement or model change", () => {
    const input = fixture([
      role({ model: "new-model" }),
      limits({ model: "new-model", tokenLimit: 50, durationLimitMs: 10, revision: 4 }),
      membership(),
      binding("prior"),
    ]);
    expect(resolveProjectTeamLimits(input)).toEqual({
      _tag: "Blocked",
      reason: "root-budget-required",
    });
    const frozen = eligible({ ...input, nowMs: 1050, rootBudget: budget });
    expect(frozen).toMatchObject({
      maximumTokens: 1000,
      attemptMaximumTokens: 50,
      rootDeadlineAtMs: 1100,
      deadlineAtMs: 1060,
      delegationDepth: 0,
      limitsRevision: 4,
    });
    expect(resolveProjectTeamLimits({ ...input, nowMs: 1100, rootBudget: budget })).toEqual({
      _tag: "Blocked",
      reason: "deadline-expired",
    });
  });
  it("does not infer a root deadline from mutable binding updatedAt", () => {
    const prior = binding("prior");
    const input = fixture([
      role(),
      limits(),
      membership(),
      { ...prior, updatedAt: "2099-01-01T00:00:00.000Z" },
    ]);
    expect(eligible({ ...input, nowMs: 1099, rootBudget: budget }).deadlineAtMs).toBe(1100);
    expect(resolveProjectTeamLimits(input)).toEqual({
      _tag: "Blocked",
      reason: "root-budget-required",
    });
  });
  const childFixture = (depth: number) => {
    const input = fixture();
    let parent = taskId;
    for (let n = 1; n <= depth; n++) {
      const id = ProjectWorkTaskId.make(`child-${n}`);
      input.state.tasks.push(task(id));
      input.state.foundationRecords.push(membership(id, { parentTaskId: parent }));
      parent = id;
    }
    return { ...input, taskId: parent };
  };
  it("requires immutable root budget for a child", () => {
    expect(resolveProjectTeamLimits(childFixture(1))).toEqual({
      _tag: "Blocked",
      reason: "root-budget-required",
    });
  });
  it("preserves root token/deadline anchors under narrower child caps", () => {
    const input = childFixture(2);
    input.state.foundationRecords = input.state.foundationRecords.map((record) =>
      record.kind === "limits" ? limits({ tokenLimit: 20, durationLimitMs: 5 }) : record,
    );
    expect(eligible({ ...input, rootBudget: budget, nowMs: 1050 })).toMatchObject({
      rootTaskId: taskId,
      maximumTokens: 1000,
      attemptMaximumTokens: 20,
      rootDeadlineAtMs: 1100,
      deadlineAtMs: 1055,
      delegationDepth: 2,
    });
  });
  it.each([3, 7])("denies depth %s beyond product default", (depth) => {
    expect(resolveProjectTeamLimits({ ...childFixture(depth), rootBudget: budget })).toEqual({
      _tag: "Blocked",
      reason: "delegation-depth-exceeded",
    });
  });
  it.each([0, 1])("honors explicit lower delegation cap %s", (cap) => {
    for (const kind of ["limits", "role-revision"] as const) {
      const input = childFixture(cap + 1);
      input.state.foundationRecords = input.state.foundationRecords.map((record) =>
        record.kind === kind ? { ...record, delegationDepth: cap } : record,
      );
      expect(resolveProjectTeamLimits({ ...input, rootBudget: budget })).toEqual({
        _tag: "Blocked",
        reason: "delegation-depth-exceeded",
      });
    }
  });
  it("allows root with delegation disabled", () => {
    expect(
      eligible(
        fixture([role({ delegationDepth: 0 }), limits({ delegationDepth: 0 }), membership()]),
      ).maximumDelegationDepth,
    ).toBe(0);
  });
  it.each([
    "missing-task",
    "missing-membership",
    "duplicate-task",
    "duplicate-membership",
    "cycle",
    "cross-task-project",
    "cross-membership-project",
    "removed",
    "too-long",
  ] as const)("denies malformed task lineage: %s", (kind) => {
    const input = childFixture(kind === "too-long" ? 9 : 1);
    if (kind === "missing-task")
      input.state.tasks = input.state.tasks.filter((entry) => entry.taskId !== taskId);
    if (kind === "missing-membership")
      input.state.foundationRecords = input.state.foundationRecords.filter(
        (entry) => entry.kind !== "task-membership" || entry.taskId !== taskId,
      );
    if (kind === "duplicate-task") input.state.tasks.push(task());
    if (kind === "duplicate-membership") input.state.foundationRecords.push(membership());
    if (kind === "cycle")
      input.state.foundationRecords = input.state.foundationRecords.map((entry) =>
        entry.kind === "task-membership" && entry.taskId === taskId
          ? { ...entry, parentTaskId: input.taskId }
          : entry,
      );
    if (kind === "cross-task-project")
      input.state.tasks = input.state.tasks.map((entry) =>
        entry.taskId === taskId ? { ...entry, projectId: ProjectId.make("other") } : entry,
      );
    if (kind === "cross-membership-project" || kind === "removed")
      input.state.foundationRecords = input.state.foundationRecords.map((entry) =>
        entry.kind === "task-membership" && entry.taskId === taskId
          ? {
              ...entry,
              ...(kind === "cross-membership-project"
                ? { projectId: ProjectId.make("other") }
                : kind === "removed"
                  ? { status: "removed" as const }
                  : {}),
            }
          : entry,
      );
    expect(resolveProjectTeamLimits({ ...input, rootBudget: budget })).toEqual({
      _tag: "Blocked",
      reason: "invalid-task-lineage",
    });
  });
  it("rejects a mismatched root budget", () => {
    expect(
      resolveProjectTeamLimits({
        ...childFixture(1),
        rootBudget: { ...budget, rootTaskId: ProjectWorkTaskId.make("other") },
      }),
    ).toEqual({ _tag: "Blocked", reason: "root-budget-mismatch" });
  });
  it("permits replacement parent links without increasing actual task depth", () => {
    const input = fixture([
      role(),
      limits(),
      membership(),
      binding("root-run"),
      binding("replacement", taskId, "root-run"),
    ]);
    expect(eligible({ ...input, parentRunId: "replacement", rootBudget: budget })).toMatchObject({
      delegationDepth: 0,
      rootDeadlineAtMs: 1100,
    });
  });
  it("permits settled parent identity and resolves child ancestry", () => {
    const input = childFixture(2);
    input.state.foundationRecords.push(
      binding("root-run"),
      binding("child-run", ProjectWorkTaskId.make("child-1"), "root-run"),
    );
    expect(
      eligible({ ...input, parentRunId: "child-run", rootBudget: budget }).delegationDepth,
    ).toBe(2);
  });
  it.each([
    "missing",
    "cycle",
    "cross-project",
    "unrelated-root",
    "duplicate",
    "membership-disagreement",
  ] as const)("denies invalid persisted run chain: %s", (kind) => {
    const input = childFixture(1);
    const parent = binding("parent");
    if (kind !== "missing") input.state.foundationRecords.push(parent);
    if (kind === "cycle") input.state.foundationRecords.push(binding("second", taskId, "parent"));
    if (kind === "cycle") Reflect.set(parent, "parentRunId", "second");
    if (kind === "cross-project") Reflect.set(parent, "projectId", "other");
    if (kind === "unrelated-root") Reflect.set(parent, "taskId", "other");
    if (kind === "duplicate") input.state.foundationRecords.push(binding("parent"));
    if (kind === "membership-disagreement")
      input.state.foundationRecords = input.state.foundationRecords.map((entry) =>
        entry.kind === "task-membership" && entry.taskId === input.taskId
          ? {
              ...entry,
              assignment: {
                authorizationGateId: "grant",
                outputDescriptions: ["result"],
                parentRunId: RunId.make("other"),
              },
            }
          : entry,
      );
    expect(
      resolveProjectTeamLimits({ ...input, parentRunId: "parent", rootBudget: budget }),
    ).toEqual({ _tag: "Blocked", reason: "invalid-run-lineage" });
  });
  it("allows read-only work when writable capacity is disabled", () => {
    const input = fixture([
      role({ role: "investigator" }),
      limits({ projectWritableWorkers: 0 }),
      membership(taskId, { deliverableKind: "research" }),
    ]);
    expect(eligible({ ...input, writable: false }).projectWritableWorkers).toBe(0);
    expect(resolveProjectTeamLimits(input)).toEqual({
      _tag: "Blocked",
      reason: "writable-restricted",
    });
  });
  it("blocks implementation when writable capacity is zero", () => {
    expect(
      resolveProjectTeamLimits(
        fixture([role(), limits({ projectWritableWorkers: 0 }), membership()]),
      ),
    ).toEqual({ _tag: "Blocked", reason: "writable-capacity-exhausted" });
  });
  it.each(["investigator", "planner", "reviewer"] as const)(
    "never infers write authority from role %s",
    (name) => {
      const input = fixture([role({ role: name }), limits(), membership()]);
      expect(resolveProjectTeamLimits(input)).toEqual({
        _tag: "Blocked",
        reason: "writable-restricted",
      });
      expect(eligible({ ...input, writable: false }).writable).toBe(false);
    },
  );
  it("honors explicit configured repair and writable policy above defaults", () => {
    expect(
      eligible(
        fixture([
          role(),
          limits({ repairAllowance: 16, projectWritableWorkers: 64, environmentModelCalls: 1 }),
          membership(),
        ]),
      ),
    ).toMatchObject({ repairAllowance: 16, projectWritableWorkers: 64, environmentModelCalls: 1 });
  });
  it("does not mutate state and freezes output independently of later policy edits", () => {
    const input = fixture();
    const before = structuredClone(input);
    const frozen = eligible(input);
    expect(input).toEqual(before);
    const policy = input.state.foundationRecords.find((entry) => entry.kind === "limits")!;
    Reflect.set(policy, "tokenLimit", 10);
    expect(frozen.maximumTokens).toBe(1000);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(resolveProjectTeamLimits(fixture()))).toBe(true);
  });
  it.each(["", " ", " configured-model"])("denies malformed current model %s", (model) => {
    const currentRole = role();
    const policy = limits();
    Reflect.set(currentRole, "model", model);
    Reflect.set(policy, "model", model);
    expect(resolveProjectTeamLimits(fixture([currentRole, policy, membership()]))._tag).toBe(
      "Blocked",
    );
  });
  it("permits a prior human-created child run without a parent session", () => {
    const input = childFixture(1);
    input.state.foundationRecords.push(binding("prior-child", input.taskId));
    expect(eligible({ ...input, rootBudget: budget })).toMatchObject({
      rootTaskId: taskId,
      delegationDepth: 1,
      maximumTokens: 1000,
      rootDeadlineAtMs: 1100,
    });
  });
  it("permits managed investigation beneath an active human reminder", () => {
    const input = childFixture(1);
    input.state.foundationRecords = input.state.foundationRecords.map((record) =>
      record.kind === "task-membership" && record.taskId === taskId
        ? { ...record, executionKind: "human", deliverableKind: "reminder" }
        : record,
    );
    expect(eligible({ ...input, rootBudget: budget })).toMatchObject({
      rootTaskId: taskId,
      delegationDepth: 1,
    });
    expect(resolveProjectTeamLimits({ ...input, taskId, rootBudget: budget })).toEqual({
      _tag: "Blocked",
      reason: "invalid-task-lineage",
    });
  });
  it("selects one configured model policy while ignoring disabled policy history", () => {
    expect(
      eligible(
        fixture([
          role(),
          limits(),
          limits({ recordId: "disabled-old", status: "disabled" }),
          membership(),
        ]),
      ),
    ).toMatchObject({ limitsRecordId: "limits", limitsRevision: 3 });
  });
  it.each([3, 8])("honors explicitly configured delegation depth %s", (depth) => {
    const input = childFixture(depth);
    input.state.foundationRecords = input.state.foundationRecords.map((record) =>
      record.kind === "limits" || record.kind === "role-revision"
        ? { ...record, delegationDepth: depth }
        : record,
    );
    expect(eligible({ ...input, rootBudget: budget }).delegationDepth).toBe(depth);
  });
  it("denies ninth delegation even with maximum configured caps", () => {
    const input = childFixture(9);
    input.state.foundationRecords = input.state.foundationRecords.map((record) =>
      record.kind === "limits" || record.kind === "role-revision"
        ? { ...record, delegationDepth: 8 }
        : record,
    );
    expect(resolveProjectTeamLimits({ ...input, rootBudget: budget })).toEqual({
      _tag: "Blocked",
      reason: "invalid-task-lineage",
    });
  });
  const replacements = (count: number, idTask = taskId) =>
    Array.from({ length: count }, (_, index) =>
      binding(`replacement-${index}`, idTask, index === 0 ? undefined : `replacement-${index - 1}`),
    );
  it.each([12, 64])("preserves root budget through %s same-task replacement sessions", (count) => {
    const history = replacements(count);
    const input = fixture([
      role(),
      limits(),
      membership(),
      ...(count === 64 ? history.toReversed() : history),
    ]);
    expect(
      eligible({ ...input, parentRunId: `replacement-${count - 1}`, rootBudget: budget }),
    ).toMatchObject({
      rootTaskId: taskId,
      maximumTokens: 1000,
      rootDeadlineAtMs: 1100,
      delegationDepth: 0,
    });
    expect(resolveProjectTeamLimits(input)).toEqual({
      _tag: "Blocked",
      reason: "root-budget-required",
    });
  });
  it("permits a leaf replacement at maximum task delegation depth", () => {
    const input = childFixture(8);
    input.state.foundationRecords = input.state.foundationRecords.map((record) =>
      record.kind === "limits" || record.kind === "role-revision"
        ? { ...record, delegationDepth: 8 }
        : record,
    );
    for (let depth = 0; depth <= 8; depth++)
      input.state.foundationRecords.push(
        binding(
          `depth-run-${depth}`,
          depth === 0 ? taskId : ProjectWorkTaskId.make(`child-${depth}`),
          depth === 0 ? undefined : `depth-run-${depth - 1}`,
        ),
      );
    input.state.foundationRecords.push(binding("leaf-replacement", input.taskId, "depth-run-8"));
    expect(
      eligible({ ...input, parentRunId: "leaf-replacement", rootBudget: budget }),
    ).toMatchObject({
      rootTaskId: taskId,
      maximumTokens: 1000,
      rootDeadlineAtMs: 1100,
      delegationDepth: 8,
    });
  });
  it.each(["cycle", "missing", "duplicate", "cross-project"] as const)(
    "denies %s deep in replacement history",
    (kind) => {
      const history = replacements(16);
      const first = history[0]!;
      if (kind === "cycle") Reflect.set(first, "parentRunId", "replacement-15");
      if (kind === "missing") Reflect.set(first, "parentRunId", "missing-ancestor");
      if (kind === "cross-project") Reflect.set(first, "projectId", "other");
      const input = fixture([
        role(),
        limits(),
        membership(),
        ...history.toReversed(),
        ...(kind === "duplicate" ? [binding("replacement-0")] : []),
      ]);
      expect(resolveProjectTeamLimits({ ...input, rootBudget: budget })).toEqual({
        _tag: "Blocked",
        reason: "invalid-run-lineage",
      });
    },
  );
  it("denies a later run that skips its task parent despite earlier valid ancestry", () => {
    const input = childFixture(2);
    input.state.foundationRecords.push(
      binding("root-run"),
      binding("parent-run", ProjectWorkTaskId.make("child-1"), "root-run"),
      binding("valid-prior", input.taskId, "parent-run"),
      binding("invalid-prior", input.taskId, "root-run"),
    );
    expect(resolveProjectTeamLimits({ ...input, rootBudget: budget })).toEqual({
      _tag: "Blocked",
      reason: "invalid-run-lineage",
    });
  });
  it("denies a sibling run within the same canonical project root", () => {
    const input = childFixture(1);
    const sibling = ProjectWorkTaskId.make("sibling");
    input.state.tasks.push(task(sibling));
    input.state.foundationRecords.push(
      membership(sibling, { parentTaskId: taskId }),
      binding("sibling-run", sibling),
    );
    expect(
      resolveProjectTeamLimits({ ...input, parentRunId: "sibling-run", rootBudget: budget }),
    ).toEqual({ _tag: "Blocked", reason: "invalid-run-lineage" });
  });
});

it("native policy ceilings are optional and require no model broker selection", () => {
  for (const records of [
    [role(), membership()],
    [role({ model: "unconfigured" }), membership()],
  ]) {
    expect(resolveProjectTeamLimits(fixture(records))).toMatchObject({ _tag: "Eligible" });
  }
});
it("replacement configuration cannot renew any frozen root authority", () => {
  const rootBudget = {
    rootTaskId: taskId,
    maximumTokens: 100,
    deadlineAtMs: 1100,
    maximumDelegationDepth: 1,
    repairAllowance: 1,
    environmentModelCalls: 1,
    modelCalls: 1,
    projectWritableWorkers: 1,
  };
  expect(eligible({ ...fixture(), nowMs: 1050, rootBudget })).toMatchObject({
    rootDeadlineAtMs: 1100,
    maximumTokens: 100,
    maximumDelegationDepth: 1,
    repairAllowance: 1,
    environmentModelCalls: 1,
    modelCalls: 1,
    projectWritableWorkers: 1,
  });
});

it("consumes the inert root snapshot even when configuration is later widened", () => {
  const rootConstraints = {
    rootTaskId: taskId,
    maximumDelegationDepth: 1,
    repairAllowance: 1,
    environmentModelCalls: 1,
    modelCalls: 1,
    projectWritableWorkers: 1,
    maximumTokens: 50,
    maximumDurationMs: 20,
  };
  const input = fixture([role(), limits(), membership(taskId, { rootConstraints })]);
  expect(eligible(input)).toMatchObject({
    maximumTokens: 50,
    deadlineAtMs: 1020,
    maximumDelegationDepth: 1,
    repairAllowance: 1,
    environmentModelCalls: 1,
    modelCalls: 1,
    projectWritableWorkers: 1,
  });
});

it("resolves native parent run identities independently of foundation record IDs", () => {
  const childId = ProjectWorkTaskId.make("native-child");
  const input = fixture([
    role(),
    limits(),
    membership(),
    membership(childId, { parentTaskId: taskId }),
  ]);
  input.state.tasks.push(task(childId));
  const parent = { ...binding("parent-row"), runId: RunId.make("parent-native") };
  input.state.foundationRecords.push(parent);
  expect(
    eligible({
      ...input,
      taskId: childId,
      parentRunId: "parent-native",
      rootBudget: { rootTaskId: taskId, maximumTokens: 1000, deadlineAtMs: 1100 },
    }).rootTaskId,
  ).toBe(taskId);
});
