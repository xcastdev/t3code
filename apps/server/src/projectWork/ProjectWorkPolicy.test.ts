import {
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkBlockerId,
  ProjectWorkCriterionId,
  ProjectWorkTaskId,
  type ProjectIssueIntake,
  type ProjectTeamRecord,
  type ProjectWorkTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProjectWorkTaskPolicy, type ProjectWorkState } from "./ProjectWorkPolicy.ts";

const projectId = ProjectId.make("closure-policy-project");
const taskId = ProjectWorkTaskId.make("linked-task");
const at = "2026-01-01T00:00:00.000Z";
const task = {
  taskId,
  projectId,
  title: "Internal work",
  state: "draft",
  watchers: [],
  revision: 1,
  specRevision: 0,
  createdAt: at,
  updatedAt: at,
} satisfies ProjectWorkTask;
const issue = {
  kind: "issue",
  recordId: "linked-issue",
  projectId,
  revision: 1,
  generation: 0,
  updatedAt: at,
  status: "closed",
  identity: { host: "github.com", repositoryNodeId: "R_repo", issueNodeId: "I_issue", number: 1 },
  repositoryName: "owner/repo",
  title: "External issue",
  body: "External description",
  sourceRevision: "source-1",
  observedAt: at,
  taskId,
} satisfies ProjectIssueIntake;
const stateWith = (
  entry: ProjectWorkTask = task,
  records: ReadonlyArray<ProjectTeamRecord> = [issue],
): ProjectWorkState => ({
  projectId,
  revision: 1,
  foundationRecords: records,
  tasks: [entry],
  attempts: [],
  criteria: [],
  evidence: [],
  relationships: [],
  blockers: [],
  attention: [],
});
const policy = (state: ProjectWorkState) => deriveProjectWorkTaskPolicy(state, taskId);

describe("closed external issue task policy", () => {
  it.each([
    "draft",
    "specified",
    "ready",
    "in-progress",
    "in-review",
    "blocked",
    "failed",
  ] as const)("raises closure attention for %s work without changing authority", (state) => {
    const open = policy(stateWith({ ...task, state }, [{ ...issue, status: "open" }]));
    const closed = policy(stateWith({ ...task, state }));
    expect(closed.attention[0]).toMatchObject({
      taskId,
      reason: "external-issue-closed",
      detail: "Linked issue 'linked-issue' is closed.",
    });
    expect(closed.readiness).toEqual(open.readiness);
    expect(closed.claimability).toEqual(open.claimability);
    expect(closed.actions).toEqual(open.actions);
  });

  it.each(["completed", "canceled"] as const)("exempts %s tasks", (state) => {
    expect(policy(stateWith({ ...task, state })).attention).not.toContainEqual(
      expect.objectContaining({ reason: "external-issue-closed" }),
    );
  });

  it.each(["open", "detached"] as const)("resolves closure when the issue is %s", (status) => {
    expect(policy(stateWith(task, [{ ...issue, status }])).attention).toEqual([]);
  });

  it("ignores unlinked issues and issues linked to another task", () => {
    const { taskId: _taskId, ...unlinked } = issue;
    expect(policy(stateWith(task, [unlinked])).attention).toEqual([]);
    expect(
      policy(stateWith(task, [{ ...issue, taskId: ProjectWorkTaskId.make("other-task") }]))
        .attention,
    ).toEqual([]);
    expect(policy(stateWith(task, [])).attention).toEqual([]);
    expect(
      policy(stateWith(task, [{ ...issue, projectId: ProjectId.make("other-project") }])).attention,
    ).toEqual([]);
  });

  it("does not revoke a ready task's existing claim permission", () => {
    const criterionId = ProjectWorkCriterionId.make("criterion");
    const state = stateWith({
      ...task,
      state: "ready",
      specification: {
        revision: 1,
        objective: "Deliver",
        scopeIn: "Work",
        scopeOut: "Other work",
        criterionIds: [criterionId],
        protected: false,
      },
    });
    state.criteria.push({
      criterionId,
      taskId,
      description: "Deliver output",
      required: true,
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
      revision: 1,
      updatedAt: at,
    });
    const open = policy({ ...state, foundationRecords: [{ ...issue, status: "open" }] });
    const closed = policy(state);
    expect(open.claimability.claimable).toBe(true);
    expect(closed.claimability).toEqual(open.claimability);
    expect(closed.actions.claim.available).toBe(true);
    expect(closed.attention[0]?.reason).toBe("external-issue-closed");
  });

  it("retains blocker, review, approval, and expired lease reasons behind closure", () => {
    const entry = {
      ...task,
      state: "blocked" as const,
      blockerId: ProjectWorkBlockerId.make("blocker"),
      specification: {
        revision: 1,
        objective: "Do work",
        scopeIn: "Bounded scope",
        scopeOut: "Other work",
        criterionIds: [ProjectWorkCriterionId.make("criterion")],
        protected: true,
      },
    } satisfies ProjectWorkTask;
    const state = stateWith(entry);
    state.attempts.push({
      attemptId: ProjectWorkAttemptId.make("active-attempt"),
      taskId,
      state: "running",
      leaseToken: "retained-lease",
      leasedUntil: at,
      checkpointIds: [],
      revision: 1,
    });
    const before = structuredClone(state);
    expect(policy(state).attention.map((entry) => entry.reason)).toEqual([
      "external-issue-closed",
      "blocked",
      "approval-required",
      "stale",
    ]);
    expect(
      policy({ ...state, tasks: [{ ...entry, state: "in-review" }] }).attention[1]?.reason,
    ).toBe("needs-review");
    expect(state).toEqual(before);
  });

  it("uses a bounded stable representative across source edits and record reordering", () => {
    const first = { ...issue, recordId: "a".repeat(256) };
    const second = {
      ...issue,
      recordId: "z-issue",
      identity: { ...issue.identity, issueNodeId: "I_second", number: 2 },
    };
    const before = policy(stateWith(task, [second, first])).attention;
    const edited = policy(
      stateWith({ ...task, revision: 20 }, [
        {
          ...first,
          title: "t".repeat(4_000),
          body: "b".repeat(32_000),
          repositoryName: "renamed/repo",
          sourceRevision: "new-source",
          revision: 9,
          observedAt: "2026-01-02T00:00:00.000Z",
        },
        second,
      ]),
    ).attention;
    expect(edited[0]?.detail).toBe(before[0]?.detail);
    expect(edited[0]?.detail?.length).toBeLessThan(300);
    expect(policy(stateWith(task, [first, second, second])).attention).toHaveLength(1);
    expect(
      policy(stateWith(task, [{ ...first, status: "open" }, second])).attention[0]?.detail,
    ).toBe("Linked issue 'z-issue' is closed.");
  });

  it("covers required tasks and active memberships of an unfinished linked mission", () => {
    const { taskId: _taskId, ...unlinked } = issue;
    const missionIssue = { ...unlinked, missionId: "mission" };
    const mission = {
      kind: "mission",
      recordId: "mission",
      projectId,
      revision: 1,
      generation: 0,
      updatedAt: at,
      status: "active",
      title: "Mission",
      objective: "Deliver",
      requiredTaskIds: [taskId],
    } satisfies ProjectTeamRecord;
    const membership = {
      kind: "task-membership",
      recordId: "membership",
      projectId,
      revision: 1,
      generation: 0,
      updatedAt: at,
      status: "active",
      taskId,
      missionId: "mission",
      executionKind: "managed",
      deliverableKind: "code",
    } satisfies ProjectTeamRecord;
    expect(policy(stateWith(task, [missionIssue, mission])).attention[0]?.reason).toBe(
      "external-issue-closed",
    );
    for (const status of ["draft", "paused"] as const) {
      expect(
        policy(stateWith(task, [missionIssue, { ...mission, status }])).attention[0]?.reason,
      ).toBe("external-issue-closed");
    }
    const optionalTaskMission = { ...mission, requiredTaskIds: [] };
    expect(
      policy(stateWith(task, [missionIssue, optionalTaskMission, membership])).attention,
    ).toHaveLength(1);
    expect(policy(stateWith(task, [missionIssue, optionalTaskMission])).attention).toEqual([]);
    expect(
      policy(
        stateWith(task, [missionIssue, optionalTaskMission, { ...membership, status: "removed" }]),
      ).attention,
    ).toEqual([]);
    for (const status of ["completed", "canceled"] as const) {
      expect(
        policy(stateWith(task, [missionIssue, { ...mission, status }, membership])).attention,
      ).toEqual([]);
    }
    expect(policy(stateWith(task, [missionIssue, membership])).attention).toEqual([]);
  });
});
