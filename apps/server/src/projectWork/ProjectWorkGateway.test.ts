import { assert, it } from "@effect/vitest";
import {
  ProjectWorkTaskCompleteCommand,
  ProjectWorkCriterionRevokeWaiverCommand,
  ProjectWorkIssueRefineCommand,
  ProjectWorkDecisionProposeCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { ProjectWorkToolkit } from "../mcp/toolkits/projectWork/tools.ts";

const decodeRead = Schema.decodeUnknownSync(
  ProjectWorkToolkit.tools.t3_project_work_read.parametersSchema,
);
const decodeWrite = Schema.decodeUnknownSync(
  ProjectWorkToolkit.tools.t3_project_work_write.parametersSchema,
);
const decodeRevoke = Schema.decodeUnknownSync(ProjectWorkCriterionRevokeWaiverCommand);
const decodeRefinement = Schema.decodeUnknownSync(ProjectWorkIssueRefineCommand);
const decodeProposal = Schema.decodeUnknownSync(ProjectWorkDecisionProposeCommand);
const execution = Schema.decodeUnknownSync(ProjectWorkTaskCompleteCommand)({
  type: "project-work.task.complete",
  commandId: "complete",
  projectId: "project",
  taskId: "task",
  satisfiedCriterionIds: [],
  completedAt: "2026-01-01T00:00:00.000Z",
});

it("advertises object tool parameters and refuses unsupported execution before gateway dispatch", () => {
  for (const tool of Object.values(ProjectWorkToolkit.tools)) {
    assert.strictEqual(Tool.getJsonSchema(tool).type, "object");
  }
  assert.throws(() => decodeWrite({ intent: execution }));
  assert.equal(
    decodeRead({ projectId: "project", operation: "supervision" }).operation,
    "supervision",
  );
  assert.throws(() => decodeRead({ projectId: "project", operation: "tasks", limit: 129 }));
  assert.strictEqual(
    decodeRead({ projectId: "project", operation: "tasks", limit: 128 }).limit,
    128,
  );
});

it("rejects human-only issue refinement while accepting ordinary agent decision proposals", () => {
  const refinement = decodeRefinement({
    type: "project-work.issue.refine",
    commandId: "refine",
    projectId: "project",
    expectedRevision: 0,
    issueRecordId: "issue",
    expectedIssueRevision: 0,
    target: {
      kind: "new-task",
      taskId: "task",
      title: "Investigate issue",
      deliverableKind: "research",
    },
    refinedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.throws(() => decodeWrite({ intent: refinement }));
  const proposal = decodeProposal({
    type: "project-work.decision.propose",
    commandId: "propose",
    projectId: "project",
    proposedAt: "2026-01-01T00:00:00.000Z",
    decision: {
      decisionId: "decision",
      projectId: "project",
      title: "Proposal",
      body: "Keep the change bounded",
      state: "proposed",
      revision: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.deepStrictEqual(decodeWrite({ intent: proposal }), { intent: proposal });
});

it("foundation filters accept current record kinds and reject unknown kinds without changing briefing kind", () => {
  assert.equal(
    decodeRead({ projectId: "project", operation: "foundation-records", recordKind: "issue" })
      .recordKind,
    "issue",
  );
  assert.throws(() =>
    decodeRead({
      projectId: "project",
      operation: "foundation-records",
      recordKind: "unknown-kind",
    }),
  );
  assert.equal(
    decodeRead({ projectId: "project", operation: "briefing", kind: "compact" }).kind,
    "compact",
  );
});

it("does not advertise human-only ordinary waiver revocation to MCP agents", () => {
  const revoke = decodeRevoke({
    type: "project-work.criterion.revoke-waiver",
    commandId: "revoke",
    projectId: "project",
    taskId: "task",
    criterionId: "criterion",
    expectedRevision: 1,
    expectedTaskRevision: 1,
    expectedCriterionRevision: 1,
    expectedSpecRevision: 1,
    reason: "Restore criterion",
    revokedAt: "2026-01-01T00:00:00.000Z",
    attribution: {
      actor: { kind: "human", id: "forged" },
      source: { kind: "web", id: "forged" },
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
  });
  assert.throws(() => decodeWrite({ intent: revoke }));
});
