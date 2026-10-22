import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectTeamRecord,
  ProjectTeamSupervisionSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import {
  emptyProjectWorkReducerState,
  applyProjectWorkEvents,
  decideProjectWorkCommand,
} from "./ProjectWorkDecider.ts";
import { projectTeamSupervisionSummary } from "./ProjectTeamSupervisionGateway.ts";
const decodeSummary = Schema.decodeUnknownSync(ProjectTeamSupervisionSummary);
const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("supervision");
const taskId = ProjectWorkTaskId.make("task");
it("bounds metadata and leaves pending question source and attention unchanged", () => {
  const state = emptyProjectWorkReducerState(projectId);
  const decode = Schema.decodeUnknownSync(ProjectTeamRecord);
  state.foundationRecords = Array.from({ length: 9 }, (_, index) =>
    decode({
      projectId,
      recordId: `question-${index}`,
      revision: 0,
      generation: 0,
      updatedAt: at,
      kind: "question",
      status: "pending",
      taskId,
      senderId: "member",
      targetGateId: "gate",
      targetRevision: 3,
      body: "PRIVATE-BODY",
      choices: [],
    }),
  );
  const original = structuredClone(state);
  const summary = decodeSummary(projectTeamSupervisionSummary(state));
  if (summary.availability !== "available") throw new Error("Expected available summary");
  expect(summary.questions.items).toHaveLength(5);
  expect(summary.questions.hasMore).toBe(true);
  expect(JSON.stringify(summary)).not.toContain("PRIVATE-BODY");
  expect(state).toEqual(original);
});
it("attention acknowledgement does not answer the question or resolve attention", () => {
  const empty = emptyProjectWorkReducerState(projectId);
  let state = applyProjectWorkEvents(
    empty,
    decideProjectWorkCommand(empty, {
      type: "project-work.task.create",
      commandId: CommandId.make("create"),
      projectId,
      taskId,
      title: "Question",
      createdAt: at,
    }),
  );
  state.tasks = state.tasks.map((t) => ({ ...t, state: "in-review" }));
  state.attention = [{ taskId, reason: "needs-review", revision: 1 }];
  state = applyProjectWorkEvents(
    state,
    decideProjectWorkCommand(state, {
      type: "project-work.attention.seen",
      commandId: CommandId.make("seen"),
      projectId,
      expectedRevision: state.revision,
      taskId,
      seenAt: at,
    }),
  );
  expect(state.attention[0]).toMatchObject({ seenAt: at });
  expect(state.attention[0]?.resolvedAt).toBeUndefined();
});
