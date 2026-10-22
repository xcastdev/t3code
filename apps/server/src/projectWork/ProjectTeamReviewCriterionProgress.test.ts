import {
  ProjectWorkCriterionId,
  ProjectWorkEvidenceId,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import { invalidateReviewCriterionProgress } from "./ProjectTeamReviewCriterionProgress.ts";

it("drops execution-produced support without erasing retained human evidence", () => {
  const at = "2026-10-01T00:00:00.000Z";
  const state = emptyProjectWorkReducerState("project");
  state.criteria.push({
    criterionId: ProjectWorkCriterionId.make("criterion"),
    taskId: ProjectWorkTaskId.make("task"),
    description: "Observable requirement",
    required: true,
    status: "satisfied",
    revision: 1,
    updatedAt: at,
    satisfiedByEvidenceIds: [
      ProjectWorkEvidenceId.make("human-evidence"),
      ProjectWorkEvidenceId.make("review-criterion-progress:managed"),
    ],
  });
  const drafts = invalidateReviewCriterionProgress({ state, at });
  expect(drafts[0]?.criterion.satisfiedByEvidenceIds).toEqual(["human-evidence"]);
  expect(drafts[0]?.criterion.status).toBe("satisfied");
  expect(state.criteria[0]?.satisfiedByEvidenceIds).toHaveLength(2);
  const unsupported = {
    ...state,
    criteria: state.criteria.map((criterion) => ({
      ...criterion,
      satisfiedByEvidenceIds: [ProjectWorkEvidenceId.make("review-criterion-progress:managed")],
    })),
  };
  expect(invalidateReviewCriterionProgress({ state: unsupported, at })[0]?.criterion.status).toBe(
    "unsatisfied",
  );
});
