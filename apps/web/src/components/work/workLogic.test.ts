import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectTeamRecordRead,
  ProjectWorkAction,
  ProjectWorkApprovalId,
  ProjectWorkKnowledgeRead,
  ProjectWorkRelationshipRead,
  ProjectWorkTaskContext,
  ProjectWorkTaskId,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionFingerprintPayload,
} from "@t3tools/contracts";
import { prepareProjectWorkHumanMutation } from "@t3tools/client-runtime/project-work";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProtectedRevision,
  buildTeamConfigurationIntent,
  combineWorkPages,
  decisionChanged,
  decisionSnapshot,
  emptyTeamConfiguration,
  existingTaskRefineChanged,
  existingTaskRefineFields,
  existingTaskRefineSnapshot,
  knowledgeLineage,
  recordedTeamConfiguration,
  relationshipFromTask,
  retainCompleteWorkSet,
  syncModelPolicies,
  TEAM_ROLES,
} from "./workLogic";
import type { WorkApprovalStep } from "./workModel";

const at = "2026-10-01T00:00:00.000Z";
const later = "2026-10-02T00:00:00.000Z";
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecordRead);
const decodeContext = Schema.decodeUnknownSync(ProjectWorkTaskContext);
const decodeKnowledge = Schema.decodeUnknownSync(ProjectWorkKnowledgeRead);
const decodeRelationship = Schema.decodeUnknownSync(ProjectWorkRelationshipRead);

const page = (revision: number, values: ReadonlyArray<string>, hasMore: boolean) => ({
  status: "ready" as const,
  failed: false,
  page: { revision, hasMore, nextOffset: null, items: values.map((value) => ({ value })) },
});

describe("combineWorkPages", () => {
  it("is complete only when every page shares a revision and the last one ends", () => {
    const set = combineWorkPages([page(4, ["a"], true), page(4, ["b"], false)], 16);
    expect(set).toMatchObject({ complete: true, truncated: false, revision: 4 });
    expect(set.records).toEqual(["a", "b"]);
  });

  it("never claims completeness across revisions or before the last page loads", () => {
    expect(combineWorkPages([page(4, ["a"], true), page(5, ["b"], false)], 16)).toMatchObject({
      complete: false,
      revision: null,
      status: "stale",
    });
    expect(
      combineWorkPages(
        [page(4, ["a"], true), { status: "loading", failed: false, page: null }],
        16,
      ),
    ).toMatchObject({ complete: false, status: "loading" });
  });

  it("reports a chain cut off by the page bound as truncated, not complete", () => {
    const set = combineWorkPages([page(4, ["a"], true), page(4, ["b"], true)], 2);
    expect(set).toMatchObject({ complete: false, truncated: true });
  });
});

describe("retainCompleteWorkSet", () => {
  const full = (revision: number, count: number) =>
    page(
      revision,
      Array.from({ length: count }, (_, index) => `r${index}`),
      false,
    );

  it("keeps the last complete set but reports a newly needed page that failed, until Retry succeeds", () => {
    // 128 records fit one page; a 129th makes the refreshed first page point at a second one.
    const previous = combineWorkPages([full(4, 128)], 16);
    const refreshedFirst = { ...full(5, 128), page: { ...full(5, 128).page, hasMore: true } };
    const failed = retainCompleteWorkSet(
      previous,
      combineWorkPages([refreshedFirst, { status: "ready", failed: true, page: null }], 16),
    );
    expect(failed).toMatchObject({ complete: true, revision: 4, status: "stale", failed: true });
    expect(failed.records).toHaveLength(128);

    const retried = retainCompleteWorkSet(
      failed,
      combineWorkPages([refreshedFirst, page(5, ["r128"], false)], 16),
    );
    expect(retried).toMatchObject({ complete: true, revision: 5, status: "ready", failed: false });
    expect(retried.records).toHaveLength(129);
  });

  it("never stands in for a truncated chain or for a set that was never complete", () => {
    const truncated = combineWorkPages([page(5, ["a"], true)], 1);
    expect(retainCompleteWorkSet(combineWorkPages([full(4, 1)], 16), truncated)).toBe(truncated);
    const loading = combineWorkPages([{ status: "loading", failed: false, page: null }], 16);
    expect(retainCompleteWorkSet(loading, loading)).toBe(loading);
  });
});

describe("existing-task refinement review", () => {
  const task = (revision: number, taskRevision: number) => ({
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project-1"),
    checkoutPath: "/repo",
    taskId: ProjectWorkTaskId.make("task-1"),
    revision,
    taskRevision,
  });
  const send = (
    reviewed: NonNullable<ReturnType<typeof existingTaskRefineSnapshot>>,
    current = reviewed.selected,
  ) =>
    prepareProjectWorkHumanMutation({
      selected: reviewed.selected,
      current,
      intent: {
        type: "project-work.issue.refine",
        commandId: CommandId.make("command-1"),
        projectId: ProjectId.make("project-1"),
        issueRecordId: "issue-1",
        refinedAt: at,
        ...existingTaskRefineFields(reviewed),
      },
    });

  it("sends the re-reviewed project, issue and task revisions together after drift", () => {
    // Refine was opened at r4; the project then moved to r5 and the person reviewed again.
    const opened = existingTaskRefineSnapshot(task(4, 2), { revision: 3, projectRevision: 4 })!;
    const now = existingTaskRefineSnapshot(task(5, 2), { revision: 3, projectRevision: 5 })!;
    expect(existingTaskRefineChanged(opened, now)).toBe(true);
    expect(send(now)).toMatchObject({
      expectedRevision: 5,
      expectedIssueRevision: 3,
      target: { kind: "existing-task", taskId: "task-1", expectedTaskRevision: 2 },
    });
  });

  it("requires a new review when the issue or task changed, and refuses the stale one", () => {
    const reviewed = existingTaskRefineSnapshot(task(5, 2), { revision: 3, projectRevision: 5 })!;
    const editedTask = existingTaskRefineSnapshot(task(6, 3), { revision: 3, projectRevision: 6 })!;
    const editedIssue = existingTaskRefineSnapshot(task(6, 2), {
      revision: 4,
      projectRevision: 6,
    })!;
    expect(existingTaskRefineChanged(reviewed, editedTask)).toBe(true);
    expect(existingTaskRefineChanged(reviewed, editedIssue)).toBe(true);
    expect(send(reviewed, editedTask.selected)).toBeNull();
    expect(send(reviewed, editedIssue.selected)).toBeNull();
  });

  it("takes no snapshot while the issue list and task disagree on the project revision", () => {
    expect(existingTaskRefineSnapshot(task(6, 2), { revision: 3, projectRevision: 5 })).toBeNull();
  });
});

describe("knowledgeLineage", () => {
  const knowledge = (id: string, supersedes?: string, createdAt = at) =>
    decodeKnowledge({
      knowledgeId: id,
      projectId: "project-1",
      title: id,
      body: "",
      sourceKind: "manual",
      sourceId: "web",
      revision: 0,
      createdAt,
      updatedAt: createdAt,
      ...(supersedes ? { supersedesKnowledgeId: supersedes } : {}),
    });

  it("marks a revised entry as replaced and keeps the replacement current", () => {
    const original = knowledge("npm");
    const revised = knowledge("vp", "npm", later);
    const lineage = knowledgeLineage([revised, original]);
    expect(lineage.supersededBy.get(original.knowledgeId)?.knowledgeId).toBe("vp");
    expect(lineage.supersededBy.has(revised.knowledgeId)).toBe(false);
  });
});

describe("relationshipFromTask", () => {
  const relationship = decodeRelationship({
    relationshipId: "rel-1",
    projectId: "project-1",
    fromTaskId: "task-a",
    toTaskId: "task-b",
    kind: "blocks",
    revision: 0,
    createdAt: at,
  });
  it("reads each direction from the task being viewed", () => {
    expect(relationshipFromTask(relationship, ProjectWorkTaskId.make("task-a"))).toEqual({
      label: "Blocks",
      otherTaskId: "task-b",
    });
    expect(relationshipFromTask(relationship, ProjectWorkTaskId.make("task-b"))).toEqual({
      label: "Blocked by",
      otherTaskId: "task-a",
    });
  });
});

const teamFields = { projectId: "project-1", updatedAt: at };
function installedTeam(generation: number, status: "configured" | "disabled" = "configured") {
  const roles = TEAM_ROLES.map((role) =>
    decodeRecord({
      ...teamFields,
      recordId: `role:${role}:${generation}`,
      revision: 0,
      generation,
      kind: "role-revision",
      status: "available",
      roleId: role,
      roleRevision: generation,
      role,
      instructions: `Act as ${role}`,
      skills: [],
      tools: [],
      model: "model-a",
      memoryAccess: "project",
      delegationDepth: 1,
    }),
  );
  const limits = decodeRecord({
    ...teamFields,
    recordId: "limits:model-a",
    revision: generation,
    generation,
    kind: "limits",
    status,
    environmentModelCalls: 2,
    projectWritableWorkers: 1,
    modelCalls: 3,
    delegationDepth: 2,
    repairAllowance: 2,
    model: "model-a",
    tokenLimit: 1000,
    durationLimitMs: 60_000,
    providerInstanceId: "codex",
    projectPriority: 0,
    taskPriorities: [],
    profileRecordIds: roles.map((role) => role.recordId),
  });
  return [limits, ...roles];
}

describe("recordedTeamConfiguration", () => {
  it("counts the generation the way the server does and reads its profiles", () => {
    const recorded = recordedTeamConfiguration(installedTeam(3, "disabled"));
    expect(recorded.kind).toBe("configured");
    if (recorded.kind !== "configured") return;
    expect(recorded.generation).toBe(3);
    expect(recorded.values.enabled).toBe(false);
    expect(recorded.values.profiles.map((profile) => profile.role)).toEqual([...TEAM_ROLES]);
    expect(recorded.values.modelPolicies).toEqual([
      { model: "model-a", tokenLimit: 1000, durationLimitMs: 60_000, modelCalls: 3 },
    ]);
  });

  it("stays read-only when a referenced profile is missing", () => {
    const [limits, ...roles] = installedTeam(2);
    expect(recordedTeamConfiguration([limits!, ...roles.slice(1)]).kind).toBe("unreadable");
  });

  it("starts at generation zero with nothing installed", () => {
    expect(recordedTeamConfiguration([])).toEqual({ kind: "none", generation: 0 });
  });
});

describe("buildTeamConfigurationIntent", () => {
  const values = syncModelPolicies({
    ...emptyTeamConfiguration(),
    providerInstanceId: "codex" as never,
    profiles: emptyTeamConfiguration().profiles.map((profile) => ({ ...profile, model: "m1" })),
  });
  const base = {
    commandId: CommandId.make("command-1"),
    projectId: ProjectId.make("project-1"),
    expectedRevision: 7,
    expectedConfigurationGeneration: 3,
  };

  it("binds the reviewed revision and generation and one policy per model", () => {
    const built = buildTeamConfigurationIntent({
      ...base,
      values,
      recorded: null,
      availableModels: new Set(["m1"]),
    });
    expect("intent" in built && built.intent).toMatchObject({
      type: "project-team.configure",
      expectedRevision: 7,
      expectedConfigurationGeneration: 3,
      modelPolicies: [{ model: "m1" }],
    });
  });

  it("refuses a model the provider no longer offers", () => {
    expect(
      buildTeamConfigurationIntent({
        ...base,
        values,
        recorded: null,
        availableModels: new Set(["m2"]),
      }),
    ).toHaveProperty("reason");
  });

  describe("after the recorded provider or model disappears", () => {
    const recorded = {
      ...values,
      enabled: true,
      taskPriorities: [{ taskId: "task-1" as never, priority: 2 }],
    };
    const disable = { ...recorded, enabled: false };

    it.each([
      ["provider is gone", null],
      ["model is gone", new Set(["m2"])],
    ])("still disables the exact recorded team when its %s", (_, availableModels) => {
      const built = buildTeamConfigurationIntent({
        ...base,
        values: disable,
        recorded,
        availableModels,
      });
      expect("intent" in built && built.intent).toEqual({
        ...disable,
        type: "project-team.configure",
        commandId: base.commandId,
        projectId: base.projectId,
        expectedRevision: 7,
        expectedConfigurationGeneration: 3,
      });
    });

    it.each([
      ["enabling it again", { ...recorded, enabled: false }, { ...recorded, enabled: true }],
      [
        "disabling it with an edit",
        recorded,
        { ...disable, profiles: disable.profiles.map((p) => ({ ...p, instructions: "x" })) },
      ],
    ])("checks the live catalog when %s", (_, from, next) => {
      for (const availableModels of [null, new Set(["m2"])])
        expect(
          buildTeamConfigurationIntent({ ...base, values: next, recorded: from, availableModels }),
        ).toHaveProperty("reason");
    });
  });
});

function protectedContext(criterionInSpec = true) {
  return decodeContext({
    projectId: "project-1",
    revision: 9,
    task: {
      taskId: "task-1",
      projectId: "project-1",
      title: "Ship",
      state: "specified",
      watchers: [],
      revision: 4,
      specRevision: 2,
      specification: {
        objective: "Old",
        scopeIn: "In",
        scopeOut: "Out",
        criterionIds: ["criterion-1"],
        revision: 2,
        protected: true,
      },
      createdAt: at,
      updatedAt: at,
    },
    criteria: criterionInSpec
      ? [
          {
            criterionId: "criterion-1",
            taskId: "task-1",
            description: "Works",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 1,
            updatedAt: at,
          },
        ]
      : [],
    evidence: [],
    relationships: [],
    blockers: [],
    comments: [],
    children: { criteria: [], evidence: [], relationships: [], blockers: [], comments: [] },
    policy: {
      taskId: "task-1",
      readiness: { ready: false, reasons: [] },
      claimability: { claimable: false },
      actions: Object.fromEntries(
        ProjectWorkAction.literals.map((action) => [action, { available: true }]),
      ),
      attention: [],
    },
  });
}

describe("buildProtectedRevision", () => {
  const input = {
    expectedRevision: 9,
    commandId: CommandId.make("command-1"),
    approvalId: ProjectWorkApprovalId.make("approval-1"),
    objective: "New",
    scopeIn: "In",
    scopeOut: "Out",
    revisedAt: later,
    attribution: {
      actor: { kind: "human" as const },
      source: { kind: "web" as const },
      recordedAt: later,
    },
  };

  it("approves the complete payload, criteria included, at the next revision", () => {
    const built = buildProtectedRevision({ ...input, context: protectedContext() });
    if (!("command" in built)) throw new Error(built.reason);
    const { command } = built;
    expect(command.specification).toMatchObject({ revision: 3, protected: true, objective: "New" });
    expect(command.criterionSnapshots.map((criterion) => criterion.criterionId)).toEqual([
      "criterion-1",
    ]);
    expect(command.approval.payloadFingerprint).toBe(
      projectWorkPayloadFingerprint(projectWorkProtectedRevisionFingerprintPayload(command)),
    );
  });

  it("refuses when a specified criterion isn't loaded", () => {
    expect(buildProtectedRevision({ ...input, context: protectedContext(false) })).toHaveProperty(
      "reason",
    );
  });
});

describe("decisionChanged", () => {
  const scope = {
    environmentId: EnvironmentId.make("env-1"),
    projectId: ProjectId.make("project-1"),
    checkoutPath: "/repo",
  };
  const selected = {
    ...scope,
    taskId: ProjectWorkTaskId.make("task-1"),
    revision: 5,
    taskRevision: 2,
  };
  const step = (revision: number, hash: string): WorkApprovalStep => ({
    id: "specification",
    label: "Scope",
    revision,
    state: "pending",
    detail: "",
    gate: null,
    hash,
  });

  it("holds while the reviewed revision and hash are still recorded", () => {
    const snapshot = decisionSnapshot(step(1, "a".repeat(64)), "approved", selected);
    expect(decisionChanged(snapshot, step(1, "a".repeat(64)), selected)).toBe(false);
  });

  it("changes when another client proposes a new revision, even at the same project revision", () => {
    const snapshot = decisionSnapshot(step(1, "a".repeat(64)), "approved", selected);
    expect(decisionChanged(snapshot, step(2, "b".repeat(64)), selected)).toBe(true);
    expect(decisionChanged(snapshot, step(1, "a".repeat(64)), { ...selected, revision: 6 })).toBe(
      true,
    );
  });
});
