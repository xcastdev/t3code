import { ProjectWorkTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { isWorkTab } from "../components/work/workPresentation";

const isTaskId = Schema.is(ProjectWorkTaskId);

/** A task URL selects its bounded detail; malformed search never supplies authority. */
export function validateWorkRouteSearch(search: Record<string, unknown>) {
  if (isTaskId(search.taskId) && search.taskId.trim() === search.taskId) {
    return { tab: "tasks" as const, taskId: search.taskId };
  }
  return {
    tab:
      typeof search.tab === "string" && isWorkTab(search.tab) ? search.tab : ("overview" as const),
  };
}
