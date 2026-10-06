import {
  ProjectWorkFoundationCommitCommand,
  ProjectTeamRecord,
  type ProjectWorkCommand,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { validateProjectTeamRecord } from "./ProjectTeamFoundationRecords.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";

type Command = Extract<ProjectWorkCommand, { type: "project-work.foundation.commit" }>;
type Draft<T = ProjectWorkEvent> = T extends ProjectWorkEvent
  ? Omit<T, "eventId" | "projectId" | "revision">
  : never;
const decode = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand, {
  onExcessProperty: "error",
});
const decodeRecords = Schema.decodeUnknownSync(Schema.Array(ProjectTeamRecord), {
  onExcessProperty: "error",
});
const reject = (message: string): never => {
  throw new ProjectWorkPolicyError("authority-required", message);
};

/** The private SQL producer verifies the retained manifest and host grant, then
 * atomically inserts its execution intent and consumes this exact human approval.
 */
export const decideProjectTeamVerificationClaim = (
  initial: ProjectWorkReducerState,
  raw: Command,
  event: (draft: Draft, index: number) => ProjectWorkEvent,
): ReadonlyArray<ProjectWorkEvent> => {
  const command = decode(raw);
  const t = command.transition;
  if (
    t?.kind !== "verification.claim" ||
    command.guided !== undefined ||
    command.claim !== undefined ||
    command.records.length !== 0 ||
    command.projectId !== initial.projectId ||
    command.expectedRevision !== initial.revision ||
    command.attribution.actor.kind !== "system" ||
    command.attribution.actor.id !== "project-team-verification" ||
    command.attribution.source.kind !== "system" ||
    command.attribution.source.id !== "project-team-verification"
  )
    return reject("Verification consumption requires its unmixed private system transition");
  const records = decodeRecords(initial.foundationRecords ?? []);
  const tasks = initial.tasks.filter((r) => r.taskId === t.taskId);
  const task = tasks[0];
  const matches = records.filter(
    (r) =>
      r.recordId === t.gateId ||
      (r.kind === "gate" &&
        r.gate === "verification" &&
        r.verificationJobId === t.jobId &&
        (r.status === "approved" || r.status === "consumed")),
  );
  const gate = matches[0];
  if (
    tasks.length !== 1 ||
    !task ||
    task.projectId !== initial.projectId ||
    task.revision !== t.expectedTaskRevision ||
    task.state === "completed" ||
    task.state === "canceled" ||
    matches.length !== 1 ||
    gate?.kind !== "gate" ||
    gate.projectId !== initial.projectId ||
    gate.taskId !== t.taskId ||
    gate.gate !== "verification" ||
    gate.status !== "approved" ||
    gate.attribution.actor.kind !== "human" ||
    gate.revision !== t.expectedGateRevision ||
    gate.verificationJobId !== t.jobId ||
    gate.contentHash !== t.manifestHash ||
    gate.specRevision !== task.specRevision ||
    gate.planRevision === undefined ||
    gate.consumedByRunId !== undefined ||
    gate.consumedByCommandId !== undefined
  )
    return reject("Verification consumption does not match its current human approval");
  const plans = records.filter(
    (r) => r.kind === "plan-revision" && r.taskId === t.taskId && r.status === "proposed",
  );
  const matchingPlans = plans.filter(
    (r) =>
      r.kind === "plan-revision" &&
      r.specRevision === task.specRevision &&
      r.planRevision === gate.planRevision,
  );
  if (
    matchingPlans.length !== 1 ||
    plans.some((r) => r.kind === "plan-revision" && r.planRevision > gate.planRevision) ||
    initial.revision >= Number.MAX_SAFE_INTEGER ||
    gate.revision >= Number.MAX_SAFE_INTEGER
  )
    return reject("Verification approval targets a stale plan or exhausted revision");
  const record = validateProjectTeamRecord(
    initial,
    {
      ...gate,
      status: "consumed",
      revision: gate.revision + 1,
      updatedAt: command.committedAt,
      consumedByRunId: t.attemptId,
      consumedByCommandId: command.commandId,
    },
    command.attribution,
    { runId: t.attemptId, commandId: command.commandId },
  );
  return [
    event({ type: "project-work.foundation.recorded", record, occurredAt: command.committedAt }, 0),
  ];
};
