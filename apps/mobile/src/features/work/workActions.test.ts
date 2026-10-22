import { expect, it } from "vite-plus/test";
import {
  ProjectWorkWriteIntent,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { prepareProjectWorkHumanMutation, projectWorkSelectionIsCurrent } from "./workActions";
import * as Schema from "effect/Schema";
const selected = {
  environmentId: EnvironmentId.make("remote"),
  projectId: ProjectId.make("project"),
  taskId: ProjectWorkTaskId.make("task"),
  checkoutPath: "/checkout",
  revision: 7,
  taskRevision: 2,
};
const base = {
  commandId: CommandId.make("human"),
  projectId: selected.projectId,
  taskId: selected.taskId,
  expectedRevision: 7,
  expectedTaskRevision: 2,
};
it("retains exact gate responses without creating worker intents", () => {
  for (const response of ["approved", "rejected", "invalidated"] as const) {
    const intent = {
      ...base,
      type: "project-team.gate.respond",
      specRevision: 1,
      planRevision: 3,
      gateId: "gate",
      expectedGateRevision: 4,
      response,
    };
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(
      intent,
    );
  }
});
it("rejects selected drafts after environment, checkout, task or revision changes", () => {
  const intent = {
    ...base,
    type: "project-team.task.control",
    control: { action: "pause", reason: "Review scope" },
  };
  for (const change of [
    { environmentId: EnvironmentId.make("other") },
    { checkoutPath: "/other" },
    { projectId: ProjectId.make("other") },
    { taskId: ProjectWorkTaskId.make("other") },
    { revision: 8 },
    { taskRevision: 3 },
  ]) {
    const current = { ...selected, ...change };
    expect(projectWorkSelectionIsCurrent(selected, current)).toBe(false);
    expect(prepareProjectWorkHumanMutation({ selected, current, intent })).toBeNull();
  }
});
it("supports inert pause/resume and explicit waiver/revoke with exact criterion revisions", () => {
  for (const action of ["pause", "resume", "cancel", "reopen"] as const) {
    const intent = {
      ...base,
      type: "project-team.task.control",
      control: { action, reason: "Human steering" },
    };
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(
      intent,
    );
  }
  for (const action of [
    { kind: "waive", reason: "Accepted limit", evidenceIds: [] },
    { kind: "revoke" },
  ]) {
    const intent = {
      ...base,
      type: "project-team.criterion.waiver",
      criterionId: "criterion",
      expectedCriterionRevision: 2,
      expectedSpecRevision: 1,
      expectedSpecificationHash: "a".repeat(64),
      action,
    };
    expect(prepareProjectWorkHumanMutation({ selected, current: selected, intent })).toEqual(
      intent,
    );
  }
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
      source: { kind: "mobile" },
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
