import {
  CommandId,
  ProjectId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  type ProjectWorkAttribution,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  emptyProjectWorkReducerState,
  decideProjectWorkCommand,
  applyProjectWorkEvents,
} from "./ProjectWorkDecider.ts";
import { deriveProjectWorkTaskPolicy, projectWorkCommandFingerprint } from "./ProjectWorkPolicy.ts";

it("keeps execution and assignment unavailable while preserving human task actions", () => {
  const projectId = ProjectId.make("project");
  const initial = emptyProjectWorkReducerState(projectId);
  const state = applyProjectWorkEvents(
    initial,
    decideProjectWorkCommand(initial, {
      type: "project-work.task.create",
      commandId: CommandId.make("create"),
      projectId,
      taskId: ProjectWorkTaskId.make("task"),
      title: "Task",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  const policy = deriveProjectWorkTaskPolicy(state, ProjectWorkTaskId.make("task"));
  expect(policy.claimability.claimable).toBe(false);
  for (const action of [
    "claim",
    "complete",
    "fail",
    "resolve-failure",
    "reclaim",
    "takeover",
    "assign",
  ] as const)
    expect(policy.actions[action]).toEqual({ available: false, reason: "execution-not-supported" });
  expect(policy.actions.specify.available).toBe(true);
  expect(policy.actions.block.available).toBe(true);
  expect(policy.actions.watch.available).toBe(true);
});

it("fingerprints retries independently of receipt-time metadata while binding intent and actor identity", () => {
  const attribution: ProjectWorkAttribution = {
    actor: { kind: "agent", id: "agent-1", displayName: "Old name" },
    source: { kind: "mcp", id: "session-1", uri: "old" },
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
  const command = {
    type: "project-work.task.create",
    commandId: "create",
    projectId: "project",
    taskId: "task",
    title: "Task",
    attribution,
    approvalToken: "old-proof",
  };
  const key = projectWorkCommandFingerprint(command);
  expect(
    projectWorkCommandFingerprint({
      ...command,
      approvalToken: "new-proof",
      attribution: {
        ...attribution,
        actor: { ...attribution.actor, displayName: "New name" },
        source: { ...attribution.source, uri: "new" },
        recordedAt: "2026-02-01T00:00:00.000Z",
      },
    }),
  ).toBe(key);
  expect(projectWorkCommandFingerprint({ ...command, title: "Other intent" })).not.toBe(key);
  expect(
    projectWorkCommandFingerprint({
      ...command,
      attribution: { ...attribution, actor: { ...attribution.actor, id: "agent-2" } },
    }),
  ).not.toBe(key);
  expect(
    projectWorkCommandFingerprint({
      ...command,
      attribution: { ...attribution, source: { ...attribution.source, id: "session-2" } },
    }),
  ).not.toBe(key);
});

it("binds waiver revocation receipts to reason and target revisions while ignoring authored receipt time", () => {
  const command = {
    type: "project-work.criterion.revoke-waiver",
    commandId: "revoke",
    projectId: "project",
    taskId: "task",
    criterionId: "criterion",
    expectedRevision: 1,
    expectedTaskRevision: 2,
    expectedCriterionRevision: 3,
    expectedSpecRevision: 4,
    reason: "Exception withdrawn",
    revokedAt: "2026-01-01T00:00:00.000Z",
    attribution: {
      actor: { kind: "human", id: "human" },
      source: { kind: "web", id: "session" },
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  expect(projectWorkCommandFingerprint({ ...command, revokedAt: "2026-02-01T00:00:00.000Z" })).toBe(
    projectWorkCommandFingerprint(command),
  );
  for (const changed of [
    { reason: "Different reason" },
    { expectedRevision: 2 },
    { expectedTaskRevision: 3 },
    { expectedCriterionRevision: 4 },
    { expectedSpecRevision: 5 },
    { criterionId: "other" },
  ])
    expect(projectWorkCommandFingerprint({ ...command, ...changed })).not.toBe(
      projectWorkCommandFingerprint(command),
    );
});

it("offers ordinary revocation only for current unprotected waived scope", () => {
  const projectId = ProjectId.make("project");
  const taskId = ProjectWorkTaskId.make("task");
  const criterionId = ProjectWorkCriterionId.make("criterion");
  const at = "2026-01-01T00:00:00.000Z";
  const attribution: ProjectWorkAttribution = {
    actor: { kind: "human", id: "human" },
    source: { kind: "web", id: "session" },
    recordedAt: at,
  };
  const state = emptyProjectWorkReducerState(projectId);
  state.tasks.push({
    taskId,
    projectId,
    title: "Task",
    watchers: [],
    state: "ready",
    revision: 0,
    specRevision: 1,
    createdAt: at,
    updatedAt: at,
    specification: {
      objective: "Bounded",
      scopeIn: "One change",
      scopeOut: "Other work",
      criterionIds: [criterionId],
      revision: 1,
      protected: false,
    },
  });
  state.criteria.push({
    taskId,
    criterionId,
    description: "Required behavior",
    required: true,
    status: "waived",
    satisfiedByEvidenceIds: [],
    revision: 0,
    updatedAt: at,
    waiver: { reason: "Exception", evidenceIds: [], specRevision: 1, waivedAt: at, attribution },
  });
  expect(
    deriveProjectWorkTaskPolicy(state, taskId).actions["revoke-criterion-waiver"].available,
  ).toBe(true);
  const revoked = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.criterion.revoke-waiver",
      commandId: CommandId.make("revoke"),
      projectId,
      expectedRevision: 0,
      taskId,
      expectedTaskRevision: 0,
      criterionId,
      expectedCriterionRevision: 0,
      expectedSpecRevision: 1,
      reason: "Withdraw exception",
      revokedAt: at,
      attribution,
    }),
  );
  expect(
    deriveProjectWorkTaskPolicy(revoked, taskId).actions["revoke-criterion-waiver"].available,
  ).toBe(false);
  expect(deriveProjectWorkTaskPolicy(revoked, taskId).actions["waive-criterion"].available).toBe(
    true,
  );
  for (const changed of [
    {
      ...state,
      tasks: state.tasks.map((task) => ({
        ...task,
        specification: { ...task.specification!, protected: true },
      })),
    },
    {
      ...state,
      criteria: state.criteria.map((criterion) => ({
        ...criterion,
        waiver: { ...criterion.waiver!, specRevision: 0 },
      })),
    },
  ])
    expect(
      deriveProjectWorkTaskPolicy(changed, taskId).actions["revoke-criterion-waiver"].available,
    ).toBe(false);
});
