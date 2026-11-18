import type {
  ProjectTeamRecordRead,
  ProjectTeamSupervisionSummary,
  ProjectWorkTaskRead,
} from "@t3tools/contracts";

import { workStateLabel } from "./projectWork.ts";
import { TEAM_ROLES, type TeamRole } from "./projectWorkLogic.ts";
import type { WorkTone } from "./projectWorkPresentation.ts";

export type WorkAvailableSummary = Extract<
  ProjectTeamSupervisionSummary,
  { readonly availability: "available" }
>;
type MemberRecord = Extract<ProjectTeamRecordRead, { readonly kind: "member" }>;
type RoleRecord = Extract<ProjectTeamRecordRead, { readonly kind: "role-revision" }>;

export interface WorkMemberActivity {
  readonly state: string;
  readonly label: string;
  readonly tone: WorkTone;
}

/** What a member is doing now, from its own bindings; never "available" from partial records. */
export function memberActivity(
  configured: string,
  bindings: ReadonlyArray<{ status: string; taskId: string }>,
  questionTaskIds: ReadonlyArray<string>,
  complete: boolean,
): WorkMemberActivity {
  if (bindings.some((b) => b.status === "quarantined"))
    return { state: "recovery", label: "Needs recovery", tone: "error" };
  if (bindings.some((b) => b.status === "stopping"))
    return { state: "stopping", label: "Stopping", tone: "warning" };
  const live = bindings.filter((b) => b.status === "running" || b.status === "reserved");
  if (live.some((b) => questionTaskIds.includes(b.taskId)))
    return { state: "waiting", label: "Waiting for you", tone: "warning" };
  if (live.length > 0)
    return {
      state: "running",
      label: live.some((b) => b.status === "running") ? "Working" : "Starting",
      tone: "info",
    };
  if (configured === "paused" || configured === "retired")
    return { state: configured, label: workStateLabel(configured), tone: "secondary" };
  if (
    !complete ||
    configured !== "active" ||
    bindings.some((b) => !["settled", "revoked"].includes(b.status))
  )
    return { state: "unknown", label: "Status unknown", tone: "secondary" };
  return { state: "available", label: "Available", tone: "secondary" };
}

/** A member with its role profile; a name left as its role reads as the role's label. */
export function memberWithProfile(
  member: MemberRecord,
  records: ReadonlyArray<ProjectTeamRecordRead>,
) {
  const profile = records.find(
    (r): r is RoleRecord => r.kind === "role-revision" && r.recordId === member.roleRevisionId,
  );
  const role = profile?.role ?? "unknown";
  return {
    ...member,
    name: member.name === role ? workStateLabel(role) : member.name,
    role,
    profile,
  };
}

/**
 * Whether member activity can be trusted: the team record sets and the supervision summary are
 * complete and at one revision, and every binding names its member.
 */
export function workRosterComplete(input: {
  readonly summaryReady: boolean;
  readonly sets: ReadonlyArray<{
    readonly complete: boolean;
    readonly status: string;
    readonly revision: number | null;
  }>;
  readonly summary: WorkAvailableSummary | null;
}): boolean {
  const { summary } = input;
  return (
    input.summaryReady &&
    summary !== null &&
    input.sets.every(
      (set) => set.complete && set.status === "ready" && set.revision === summary.revision,
    ) &&
    !summary.bindings.hasMore &&
    summary.bindings.items.every((b) => "memberId" in b)
  );
}

const LIVE_BINDINGS = ["running", "reserved", "stopping", "quarantined"];

/**
 * The team's current members with what each is doing and the task it holds, leads first in role
 * order. Retired members are left out.
 */
export function deriveWorkRoster<Extra extends object>(input: {
  readonly records: ReadonlyArray<ProjectTeamRecordRead>;
  readonly summary: WorkAvailableSummary | null;
  readonly complete: boolean;
  /** Per-client presentation, such as an avatar identity, from the member as recorded. */
  readonly decorate?: (
    member: ReturnType<typeof memberWithProfile>,
    recorded: MemberRecord,
  ) => Extra;
}) {
  const questionTaskIds = (input.summary?.questions.items ?? []).flatMap((q) =>
    "taskId" in q ? [q.taskId] : [],
  );
  const roster = input.records
    .filter((r): r is MemberRecord => r.kind === "member" && r.status !== "retired")
    .map((member) => {
      const bindings = (input.summary?.bindings.items ?? [])
        .filter((b) => "memberId" in b && b.memberId === member.recordId)
        .flatMap((b) => ("taskId" in b ? [{ status: b.status, taskId: b.taskId }] : []));
      const identity = memberWithProfile(member, input.records);
      return {
        ...identity,
        ...(input.decorate?.(identity, member) as Extra),
        activity: memberActivity(member.status, bindings, questionTaskIds, input.complete),
        taskId: bindings.find((b) => LIVE_BINDINGS.includes(b.status))?.taskId,
      };
    });
  const rank = (role: string) => {
    const index = TEAM_ROLES.indexOf(role as TeamRole);
    return index < 0 ? TEAM_ROLES.length : index;
  };
  return roster.sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name));
}

/** The team member on a task: the one working it, else the member it is assigned to. */
export function taskMember<
  Member extends { readonly recordId: string; readonly taskId?: string | undefined },
>(
  roster: ReadonlyArray<Member>,
  task: Pick<ProjectWorkTaskRead, "taskId" | "assignee">,
): Member | undefined {
  const assigneeId = task.assignee?.id;
  return (
    roster.find((member) => member.taskId === task.taskId) ??
    (assigneeId === undefined ? undefined : roster.find((member) => member.recordId === assigneeId))
  );
}

// ── Task list ──────────────────────────────────────────────────────────────

export const WORK_TASK_FILTERS = [
  "all",
  "in-progress",
  "in-review",
  "blocked",
  "failed",
  "ready",
  "specified",
  "draft",
  "completed",
  "canceled",
] as const;
export type WorkTaskFilter = (typeof WORK_TASK_FILTERS)[number];
export type WorkTaskCounts = Partial<Record<WorkTaskFilter | "total", number>>;

/** Grouped by what the task needs from you; a state from a newer server waits in Up next. */
const WORK_TASK_GROUPS = [
  { id: "needs-you", label: "Needs you", states: ["in-review", "blocked", "failed"] },
  { id: "running", label: "Running", states: ["in-progress"] },
  { id: "up-next", label: "Up next", states: ["ready", "specified", "draft"] },
  { id: "done", label: "Done", states: ["completed", "canceled"] },
] as const;
export type WorkTaskGroup = (typeof WORK_TASK_GROUPS)[number];
export type WorkTaskGroupId = WorkTaskGroup["id"];

const workTaskGroupOf = (state: string): WorkTaskGroup =>
  WORK_TASK_GROUPS.find((group) => (group.states as ReadonlyArray<string>).includes(state)) ??
  WORK_TASK_GROUPS[2];

/**
 * Tasks split into the list's groups. A group's count is the project-wide total when the
 * unfiltered list has counts, else the tasks on this page.
 */
export function groupWorkTasks<Task extends { readonly state: string }>(
  tasks: ReadonlyArray<Task>,
  counts: WorkTaskCounts | null,
  filter: WorkTaskFilter,
) {
  return WORK_TASK_GROUPS.map((group) => {
    const shown = tasks.filter((task) => workTaskGroupOf(task.state).id === group.id);
    const total =
      counts === null || filter !== "all"
        ? undefined
        : group.states.reduce((sum, state) => sum + (counts[state] ?? 0), 0);
    return {
      ...group,
      tasks: shown,
      count: total ?? shown.length,
      empty: shown.length === 0 && (total ?? 0) === 0,
    };
  });
}

/** Filter choices worth offering: all, the current one, and states that have tasks. */
export function workTaskFilterOptions(counts: WorkTaskCounts | null, current: WorkTaskFilter) {
  return WORK_TASK_FILTERS.flatMap((state) => {
    const count = counts?.[state === "all" ? "total" : state];
    if (count === 0 && state !== "all" && state !== current) return [];
    return [{ state, label: state === "all" ? "All tasks" : workStateLabel(state), count }];
  });
}

/** The approval line a task card shows: approved at its current scope, or waiting on one. */
export function taskApprovalBadge(
  task: Pick<ProjectWorkTaskRead, "approval" | "specRevision" | "state">,
): "approved" | "needs-approval" | null {
  if (task.approval !== undefined && task.approval.specRevision === task.specRevision)
    return "approved";
  return task.state === "specified" ? "needs-approval" : null;
}
