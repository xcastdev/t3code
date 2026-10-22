import { expect, it } from "vite-plus/test";
import {
  ProjectWorkWriteIntent,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProjectWorkApprovalId,
  ProjectWorkResultId,
  ProjectWorkCommand,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionFingerprintPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  makeProjectWorkTaskSpecifyCommand,
  makeProjectWorkProtectedRevisionCommand,
  makeProjectWorkSimpleTaskCommand,
  prepareProjectWorkHumanMutation,
} from "./workMutations";
const isCommand = Schema.is(ProjectWorkCommand);
const projectId = ProjectId.make("project");
const taskId = ProjectWorkTaskId.make("task");
const now = "2026-10-21T00:00:00.000Z";
const criterionId = ProjectWorkCriterionId.make("criterion");
const selected = {
  environmentId: EnvironmentId.make("remote"),
  projectId,
  taskId,
  checkoutPath: "/checkout",
  revision: 8,
  taskRevision: 3,
};
const base = { projectId, taskId, commandId: CommandId.make("edit"), expectedRevision: 8, now };
it("binds specification edits to the reviewed revision and criterion", () => {
  const intent = makeProjectWorkTaskSpecifyCommand({
    projectId,
    taskId,
    criterionId,
    criterionRevision: 8,
    specificationRevision: 2,
    commandId: base.commandId,
    objective: "Fix issue",
    scopeIn: "Client",
    scopeOut: "Server",
    updatedAt: now,
  });
  expect(isCommand(intent)).toBe(true);
  expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(intent);
  expect(
    prepareProjectWorkHumanMutation({ selected, current: { ...selected, revision: 9 }, intent }),
  ).toBeNull();
  expect(intent.specification.criterionIds).toEqual([criterionId]);
});
it("records approval alone and retains explicit reopen/cancel reverse controls", () => {
  const approval = makeProjectWorkSimpleTaskCommand("project-work.task.approve", {
    ...base,
    approvalId: ProjectWorkApprovalId.make("approval"),
    specRevision: 2,
  });
  expect(
    prepareProjectWorkHumanMutation({ selected, current: selected, intent: approval }),
  ).toEqual({
    type: "project-work.task.approve",
    projectId,
    taskId,
    commandId: base.commandId,
    expectedRevision: 8,
    specRevision: 2,
    approvalId: "approval",
    approvedAt: now,
  });
  for (const type of ["project-work.task.cancel", "project-work.task.reopen"] as const) {
    const intent = makeProjectWorkSimpleTaskCommand(type, base);
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })?.type).toBe(
      type,
    );
  }
});
it("fingerprints all protected revision snapshots and affected results", () => {
  const input = {
    ...base,
    specification: {
      objective: "Fix",
      scopeIn: "Client",
      scopeOut: "Server",
      criterionIds: [criterionId],
      revision: 2,
      protected: true,
    },
    criterionSnapshots: [
      {
        criterionId,
        taskId,
        description: "Works",
        required: true,
        status: "unsatisfied",
        satisfiedByEvidenceIds: [],
        revision: 1,
        updatedAt: now,
      },
    ],
    affectedResultIds: [ProjectWorkResultId.make("result")],
    approvalId: ProjectWorkApprovalId.make("approval"),
    revisedAt: now,
    attribution: {
      actor: { kind: "human" as const },
      source: { kind: "web" as const },
      recordedAt: now,
    },
  };
  const command = makeProjectWorkProtectedRevisionCommand(input);
  expect(isCommand(command)).toBe(true);
  expect(command.approval.payloadFingerprint).toBe(
    projectWorkPayloadFingerprint(projectWorkProtectedRevisionFingerprintPayload(command)),
  );
  expect(
    makeProjectWorkProtectedRevisionCommand({ ...input, affectedResultIds: [] }).approval
      .payloadFingerprint,
  ).not.toBe(command.approval.payloadFingerprint);
  expect(() =>
    makeProjectWorkProtectedRevisionCommand({
      ...input,
      criterionSnapshots: [{ ...input.criterionSnapshots[0]!, status: "future-status" }],
    }),
  ).toThrow();
});

const isHumanWireIntent = Schema.is(ProjectWorkWriteIntent);
it("revokes an ordinary waiver only for the reviewed task and revisions", () => {
  const intent = {
    type: "project-work.criterion.revoke-waiver",
    commandId: CommandId.make("revoke"),
    projectId: selected.projectId,
    taskId: selected.taskId,
    expectedRevision: selected.revision,
    expectedTaskRevision: selected.taskRevision,
    criterionId: "criterion",
    expectedCriterionRevision: 4,
    expectedSpecRevision: 2,
    reason: "Requirement applies again",
    revokedAt: "2026-10-21T00:00:00.000Z",
    attribution: {
      actor: { kind: "human" },
      source: { kind: "web" },
      recordedAt: "2026-10-21T00:00:00.000Z",
    },
  };
  expect(isHumanWireIntent(intent)).toBe(true);
  expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(intent);
  expect(
    prepareProjectWorkHumanMutation({
      selected,
      current: selected,
      intent: { ...intent, taskId: ProjectWorkTaskId.make("other") },
    }),
  ).toBeNull();
  expect(
    prepareProjectWorkHumanMutation({
      selected,
      current: { ...selected, taskRevision: selected.taskRevision + 1 },
      intent,
    }),
  ).toBeNull();
  expect(
    prepareProjectWorkHumanMutation({
      selected,
      current: selected,
      intent: { ...intent, expectedTaskRevision: selected.taskRevision + 1 },
    }),
  ).toBeNull();
  expect(
    prepareProjectWorkHumanMutation({
      selected,
      current: selected,
      intent: { ...intent, expectedRevision: selected.revision + 1 },
    }),
  ).toBeNull();
  const { expectedCriterionRevision: _criterionRevision, ...withoutCriterionRevision } = intent;
  const { expectedSpecRevision: _specRevision, ...withoutSpecRevision } = intent;
  for (const incomplete of [withoutCriterionRevision, withoutSpecRevision]) {
    expect(isHumanWireIntent(incomplete)).toBe(false);
    expect(
      prepareProjectWorkHumanMutation({ selected, current: selected, intent: incomplete }),
    ).toBeNull();
  }
  const { taskId: _taskId, ...projectOnly } = selected;
  expect(
    prepareProjectWorkHumanMutation({ selected: projectOnly, current: projectOnly, intent }),
  ).toBeNull();
});
