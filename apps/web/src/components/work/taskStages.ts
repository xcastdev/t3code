import type { ProjectTeamRecord } from "@t3tools/contracts";

type GateStatus = Extract<ProjectTeamRecord, { kind: "gate" }>["status"];

export type TaskStageId = "scope" | "plan" | "execution" | "review";
export type TaskStageStatus = "done" | "current" | "upcoming";

export interface TaskStage {
  readonly id: TaskStageId;
  readonly label: string;
  readonly status: TaskStageStatus;
  readonly detail: string;
}

export interface TaskStageInput {
  readonly state: string;
  readonly hasSpecification: boolean;
  readonly specificationGate: GateStatus | undefined;
  readonly hasPlan: boolean;
  readonly planGate: GateStatus | undefined;
  readonly executionGranted: boolean;
  readonly workerActive: boolean;
}

const granted = (status: GateStatus | undefined) => status === "approved" || status === "consumed";

function gateDetail(subject: string, status: GateStatus | undefined): string {
  if (granted(status)) return `${subject} approved`;
  if (status === "rejected") return `${subject} rejected · propose a revision`;
  if (status === "pending" || status === "proposed")
    return `Approve or reject the ${subject.toLowerCase()}`;
  return `${subject} awaiting an approval gate`;
}

/**
 * Summarise recorded task progress as four stages. This is a reading aid derived from the
 * task state and recorded gates; the server still decides whether each action is allowed.
 */
export function taskStages(input: TaskStageInput): {
  readonly stages: ReadonlyArray<TaskStage>;
  readonly next: string;
} {
  const reviewing = input.state === "in-review";
  const completed = input.state === "completed";
  const scopeDone = input.hasSpecification && granted(input.specificationGate);
  const planDone = input.hasPlan && granted(input.planGate);
  const executionDone = input.executionGranted && (reviewing || completed);
  const raw: ReadonlyArray<Omit<TaskStage, "status"> & { readonly done: boolean }> = [
    {
      id: "scope",
      label: "Scope",
      done: scopeDone,
      detail: input.hasSpecification
        ? gateDetail("Specification", input.specificationGate)
        : "Propose a specification",
    },
    {
      id: "plan",
      label: "Plan",
      done: planDone,
      detail: input.hasPlan ? gateDetail("Plan", input.planGate) : "Propose a plan",
    },
    {
      id: "execution",
      label: "Execution",
      done: executionDone,
      detail: executionDone
        ? "Execution recorded"
        : input.executionGranted
          ? input.workerActive
            ? "Workers recorded as running"
            : "Execution authorized"
          : "Start execution after approvals",
    },
    {
      id: "review",
      label: "Review",
      done: completed,
      detail: completed
        ? "Task completed"
        : reviewing
          ? "Review and verify the result"
          : "Verify after execution",
    },
  ];
  // Stages complete in order: a later approval never outranks an unapproved earlier one.
  const found = raw.findIndex((stage) => !stage.done);
  const currentIndex = found === -1 ? raw.length : found;
  const stages = raw.map(({ done: _done, ...stage }, index): TaskStage => ({
    ...stage,
    status: index < currentIndex ? "done" : index === currentIndex ? "current" : "upcoming",
  }));
  const next =
    input.state === "canceled"
      ? "Canceled. Reopen the task in Task controls to continue."
      : input.state === "blocked" || input.state === "failed"
        ? "Blocked. Review the blockers, repair decision and Task controls."
        : completed
          ? "Completed. No further step is recorded."
          : (stages[currentIndex]?.detail ?? "No further step is recorded.");
  return { stages, next };
}
