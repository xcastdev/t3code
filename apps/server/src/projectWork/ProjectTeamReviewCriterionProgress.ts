import type { ProjectWorkEvent, ProjectWorkReducerState } from "./ProjectWorkDecider.ts";
/** Execution-produced review evidence is not admitted by the human-only lifecycle. */
export function invalidateReviewCriterionProgress(input: {
  readonly state: ProjectWorkReducerState;
  readonly at: string;
}): readonly Omit<
  Extract<ProjectWorkEvent, { type: "project-work.criterion.upserted" }>,
  "eventId" | "projectId" | "revision"
>[] {
  return input.state.criteria.flatMap((criterion) => {
    const kept = criterion.satisfiedByEvidenceIds.filter(
      (id) => !id.startsWith("review-criterion-progress:"),
    );
    if (kept.length === criterion.satisfiedByEvidenceIds.length || criterion.status === "waived")
      return [];
    return [
      {
        type: "project-work.criterion.upserted" as const,
        taskId: criterion.taskId,
        criterion: {
          ...criterion,
          satisfiedByEvidenceIds: kept,
          status: kept.length === 0 ? ("unsatisfied" as const) : criterion.status,
          revision: criterion.revision + 1,
          updatedAt: input.at,
        },
        updatedAt: input.at,
        occurredAt: input.at,
      },
    ];
  });
}
