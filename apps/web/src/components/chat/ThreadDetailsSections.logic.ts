import type { OrchestrationV2PlanArtifact, OrchestrationV2Run, RunId } from "@t3tools/contracts";

export type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

/**
 * The newest run's task list, like the server's bounded projection keeps it. It stays until the
 * agent or the user clears it; an emptied list wins so an older one can't resurface.
 */
export function latestTodoList(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal">>,
): TodoListPlan | null {
  const ordinals = new Map(runs.map((run) => [run.id, run.ordinal]));
  let latest: TodoListPlan | null = null;
  let latestOrdinal = -1;
  for (const plan of plans) {
    if (plan.kind !== "todo_list" || plan.status === "superseded") continue;
    const ordinal = plan.runId === null ? -1 : (ordinals.get(plan.runId) ?? -1);
    if (ordinal >= latestOrdinal) {
      latest = plan;
      latestOrdinal = ordinal;
    }
  }
  return latest;
}

/** Each run's checklist progress, keyed by the run that last wrote the list. */
export function checklistProgressByRun(
  plans: ReadonlyArray<OrchestrationV2PlanArtifact>,
): ReadonlyMap<RunId, { readonly done: number; readonly total: number }> {
  const progress = new Map<RunId, { readonly done: number; readonly total: number }>();
  for (const plan of plans) {
    if (plan.kind !== "todo_list" || plan.status === "superseded" || plan.runId === null) continue;
    if (plan.steps.length === 0) {
      progress.delete(plan.runId);
      continue;
    }
    progress.set(plan.runId, {
      done: plan.steps.filter((step) => step.status === "completed").length,
      total: plan.steps.length,
    });
  }
  return progress;
}
