import type { ProjectTeamRecord } from "@t3tools/contracts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { canonicalProjectWorkPayload } from "@t3tools/contracts";
/** The assignment freezes domain context; V2 owns workspace preparation and effective instruction/resource snapshots. */
export const projectTaskAssignment = (
  state: ProjectWorkReducerState,
  binding: Extract<ProjectTeamRecord, { kind: "run-binding" }>,
) => {
  const task = state.tasks.find((task) => task.taskId === binding.taskId);
  const records = state.foundationRecords ?? [];
  const membership = records.find(
    (record) => record.kind === "task-membership" && record.taskId === binding.taskId,
  );
  const plan = records.find(
    (record) =>
      record.kind === "plan-revision" &&
      record.taskId === binding.taskId &&
      record.status === "proposed",
  );
  return canonicalProjectWorkPayload({
    task,
    plan,
    assignment: membership?.kind === "task-membership" ? membership.assignment : undefined,
    criteria: state.criteria.filter((record) => record.taskId === binding.taskId),
    decisions: (state.decisions ?? []).slice(-32),
    questions: records
      .filter((record) => record.kind === "question" && record.taskId === binding.taskId)
      .slice(-32),
    control: {
      bindingId: binding.recordId,
      generation: binding.generation,
      threadId: binding.threadId,
    },
  });
};
