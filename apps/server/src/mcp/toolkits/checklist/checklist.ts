import { type OrchestrationV2PlanStep, PlanId, type ThreadId } from "@t3tools/contracts";

export const CHECKLIST_STATUSES = ["pending", "in_progress", "done"] as const;
export type ChecklistStatus = (typeof CHECKLIST_STATUSES)[number];

const TO_PLAN_STATUS: Record<ChecklistStatus, OrchestrationV2PlanStep["status"]> = {
  pending: "pending",
  in_progress: "running",
  done: "completed",
};

const FROM_PLAN_STATUS: Record<OrchestrationV2PlanStep["status"], string> = {
  pending: "pending",
  running: "in progress",
  completed: "done",
};

/** One checklist per thread, so update and clear never have to pick between lists. */
export const checklistPlanId = (threadId: ThreadId) => PlanId.make(`t3-checklist:${threadId}`);

/** The first step starts in progress: a fresh checklist means the work has begun. */
export function createChecklistSteps(
  texts: ReadonlyArray<string>,
): ReadonlyArray<OrchestrationV2PlanStep> {
  return texts.map((text, index) => ({
    id: `step-${index + 1}`,
    text: text.trim(),
    status: index === 0 ? "running" : "pending",
  }));
}

/**
 * `step` is the 1-based number the checklist shows. One step is in progress at a time, and
 * finishing a step starts the next pending one, so a model only ever reports what it did.
 */
export function updateChecklistStep(
  steps: ReadonlyArray<OrchestrationV2PlanStep>,
  step: number,
  status: ChecklistStatus,
): ReadonlyArray<OrchestrationV2PlanStep> | string {
  const index = step - 1;
  if (!Number.isInteger(step) || index < 0 || index >= steps.length) {
    return `Step ${step} doesn't exist. The checklist has steps 1 to ${steps.length}.`;
  }
  const target = TO_PLAN_STATUS[status];
  const next = steps.map((current, position) =>
    position === index
      ? { ...current, status: target }
      : target === "running" && current.status === "running"
        ? { ...current, status: "pending" as const }
        : current,
  );
  if (target !== "completed" || next.some((current) => current.status === "running")) return next;
  const following = next.findIndex(
    (current, position) => position > index && current.status === "pending",
  );
  const start =
    following === -1 ? next.findIndex((current) => current.status === "pending") : following;
  return start === -1
    ? next
    : next.map((current, position) =>
        position === start ? { ...current, status: "running" as const } : current,
      );
}

export function formatChecklist(steps: ReadonlyArray<OrchestrationV2PlanStep>): string {
  if (steps.length === 0) return "No checklist.";
  return steps
    .map((step, index) => `${index + 1}. [${FROM_PLAN_STATUS[step.status]}] ${step.text}`)
    .join("\n");
}
