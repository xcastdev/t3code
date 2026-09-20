import type { ProjectWorkTaskRead } from "@t3tools/contracts";

export const WORK_TABS = ["overview", "tasks", "knowledge"] as const;
export type WorkTab = (typeof WORK_TABS)[number];

export function isWorkTab(value: string | undefined): value is WorkTab {
  return value !== undefined && WORK_TABS.includes(value as WorkTab);
}

export function taskStateLabel(state: string): string {
  return state.replaceAll("-", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function taskStateVariant(
  state: string,
): "default" | "secondary" | "success" | "warning" | "error" | "outline" {
  switch (state) {
    case "completed":
      return "success";
    case "failed":
    case "blocked":
      return "error";
    case "in-progress":
    case "ready":
      return "warning";
    case "canceled":
      return "outline";
    default:
      return "secondary";
  }
}

export function taskNeedsSpecification(task: Pick<ProjectWorkTaskRead, "state">): boolean {
  return task.state === "draft";
}

export function workReadStatus(input: {
  readonly connected: boolean;
  readonly hasValue: boolean;
}): "live" | "stale" | "waiting" {
  if (input.connected) return input.hasValue ? "live" : "waiting";
  return input.hasValue ? "stale" : "waiting";
}
