import { ProjectWorkTaskId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const WORK_SECTIONS = ["overview", "tasks", "knowledge", "intake", "portfolio"] as const;
export type WorkSection = (typeof WORK_SECTIONS)[number];

export interface WorkRouteSearch {
  readonly section: WorkSection;
  readonly taskId?: ProjectWorkTaskId;
}

const isTaskId = Schema.is(ProjectWorkTaskId);
const isSection = (value: unknown): value is WorkSection =>
  WORK_SECTIONS.some((section) => section === value);

/** A task in the URL only selects bounded detail; malformed search never selects anything. */
export function validateWorkRouteSearch(search: Record<string, unknown>): WorkRouteSearch {
  if (isTaskId(search.taskId) && search.taskId.trim() === search.taskId)
    return { section: "tasks", taskId: search.taskId };
  return { section: isSection(search.section) ? search.section : "overview" };
}
