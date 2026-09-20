import { describe, expect, it } from "vite-plus/test";

import { CommandId, ProjectWorkCriterionId, ProjectWorkTaskId } from "@t3tools/contracts";

import {
  makeProjectWorkTaskClaimCommand,
  makeProjectWorkTaskCompleteCommand,
  makeProjectWorkCriterionUpsertCommand,
  makeProjectWorkTaskCreateCommand,
  makeProjectWorkTaskReadyCommand,
  makeProjectWorkTaskSpecifyCommand,
} from "./workMutations";

const projectId = "project-1" as never;
const taskId = ProjectWorkTaskId.make("task-1");
const now = "2026-09-17T15:00:00.000Z";

describe("project-work mutations", () => {
  it("retains the complete draft-create payload", () => {
    expect(
      makeProjectWorkTaskCreateCommand({
        projectId,
        taskId,
        commandId: CommandId.make("command-create"),
        title: "Capture release checklist",
        createdAt: now,
      }),
    ).toEqual({
      type: "project-work.task.create",
      commandId: "command-create",
      projectId,
      taskId,
      title: "Capture release checklist",
      createdAt: now,
    });
  });

  it("builds the criterion then specification handoff with revisions and stable IDs", () => {
    const criterionId = ProjectWorkCriterionId.make("criterion-1");
    const criterion = makeProjectWorkCriterionUpsertCommand({
      projectId,
      taskId,
      taskRevision: 4,
      criterionId,
      commandId: CommandId.make("command-criterion"),
      description: "The checklist is documented",
      updatedAt: now,
    });
    expect(criterion).toEqual({
      type: "project-work.criterion.upsert",
      commandId: "command-criterion",
      projectId,
      taskId,
      expectedRevision: 4,
      criterion: {
        criterionId,
        taskId,
        description: "The checklist is documented",
        required: true,
        status: "unsatisfied",
        satisfiedByEvidenceIds: [],
        revision: 0,
        updatedAt: now,
      },
      updatedAt: now,
    });

    expect(
      makeProjectWorkTaskSpecifyCommand({
        projectId,
        taskId,
        criterionId,
        criterionRevision: 5,
        specificationRevision: 1,
        commandId: CommandId.make("command-specify"),
        objective: "Document the release checklist",
        scopeIn: "The release process",
        scopeOut: "Automating the release",
        updatedAt: now,
      }),
    ).toEqual({
      type: "project-work.task.specify",
      commandId: "command-specify",
      projectId,
      taskId,
      expectedRevision: 5,
      specification: {
        objective: "Document the release checklist",
        scopeIn: "The release process",
        scopeOut: "Automating the release",
        criterionIds: [criterionId],
        revision: 1,
        protected: false,
      },
      updatedAt: now,
    });
  });

  it("guards a ready transition with the task revision and timestamp", () => {
    expect(
      makeProjectWorkTaskReadyCommand({
        projectId,
        taskId,
        expectedRevision: 7,
        commandId: CommandId.make("command-ready"),
        updatedAt: now,
      }),
    ).toEqual({
      type: "project-work.task.ready",
      commandId: "command-ready",
      projectId,
      taskId,
      expectedRevision: 7,
      updatedAt: now,
    });
  });

  it("uses the aggregate revision and keeps human completion tokenless", () => {
    const claim = makeProjectWorkTaskClaimCommand({
      projectId,
      taskId,
      expectedRevision: 12,
      commandId: CommandId.make("command-claim"),
      attemptId: "attempt-1" as never,
      leaseToken: "secret-lease",
      leasedUntil: now,
      claimedAt: now,
    });
    expect(claim.expectedRevision).toBe(12);
    expect(claim.leaseToken).toBe("secret-lease");

    const complete = makeProjectWorkTaskCompleteCommand({
      projectId,
      taskId,
      expectedRevision: 13,
      commandId: CommandId.make("command-complete"),
      attemptId: "attempt-1" as never,
      satisfiedCriterionIds: [],
      completedAt: now,
    });
    expect(complete).not.toHaveProperty("leaseToken");
    expect(complete.expectedRevision).toBe(13);
  });
});
