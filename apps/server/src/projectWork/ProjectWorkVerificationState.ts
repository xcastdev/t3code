import type { ProjectTeamRecord } from "@t3tools/contracts";
import type { ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { verificationError } from "./ProjectWorkVerificationError.ts";
import { projectTeamPlanHash } from "./ProjectTeamPolicy.ts";
export function currentVerificationPlan(
  state: ProjectWorkReducerState,
  taskId: string,
  specRevision: number,
  planRevision: number,
): Extract<ProjectTeamRecord, { kind: "plan-revision" }> {
  const task = state.tasks.find((task) => task.taskId === taskId);
  const records = state.foundationRecords ?? [];
  const plans = records
    .filter(
      (record): record is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
        record.kind === "plan-revision" &&
        record.taskId === taskId &&
        record.specRevision === specRevision &&
        record.status === "proposed",
    )
    .toSorted((left, right) => right.planRevision - left.planRevision);
  const plan = plans[0];
  if (
    task?.specRevision !== specRevision ||
    plan === undefined ||
    plan.planRevision !== planRevision ||
    plan.contentHash !== projectTeamPlanHash(plan) ||
    plans.some(
      (other) => other.recordId !== plan.recordId && other.planRevision === plan.planRevision,
    ) ||
    !records.some(
      (record) =>
        record.kind === "gate" &&
        record.gate === "plan" &&
        record.taskId === taskId &&
        record.specRevision === specRevision &&
        record.planRevision === planRevision &&
        ["approved", "consumed"].includes(record.status) &&
        record.attribution.actor.kind === "human" &&
        record.contentHash === projectTeamPlanHash(plan),
    )
  )
    throw verificationError("authority");
  return plan;
}
