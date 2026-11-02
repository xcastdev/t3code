import {
  type ProjectId,
  type ProjectWorkActivitySummary,
  type ProjectWorkActivityTask,
  type ProjectWorkActivityWorker,
  type ProjectWorkAttentionItem,
  type ProjectWorkAttentionSummary,
  type ProjectWorkTaskId,
  ProjectTeamAvatar,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const MAX_ITEMS = 200;

export interface AttentionTaskRow {
  readonly projectId: string;
  readonly taskId: string;
  readonly title: string;
  readonly state: string;
  readonly specRevision: number;
  readonly approvedSpecRevision: number | null;
  readonly failureKind: string | null;
  readonly updatedAt: string;
}
export interface AttentionRow {
  readonly projectId: string;
  readonly taskId: string;
  readonly reason: string;
  readonly detail: string | null;
}
export interface AttentionBlockerRow {
  readonly projectId: string;
  readonly blockerId: string;
  readonly taskId: string;
  readonly reason: string;
  readonly resolver: string;
}
export interface AttentionDecisionRow {
  readonly projectId: string;
  readonly decisionId: string;
  readonly title: string;
  readonly updatedAt: string;
}
export interface AttentionRecordRow {
  readonly projectId: string;
  readonly recordId: string;
  readonly kind: "question" | "message" | "gate";
  readonly status: string;
  readonly taskId: string | null;
  readonly body: string | null;
  readonly gate: string | null;
  readonly updatedAt: string;
}

export interface AttentionSource {
  readonly tasks: ReadonlyArray<AttentionTaskRow>;
  readonly attention: ReadonlyArray<AttentionRow>;
  readonly blockers: ReadonlyArray<AttentionBlockerRow>;
  readonly decisions: ReadonlyArray<AttentionDecisionRow>;
  readonly records: ReadonlyArray<AttentionRecordRow>;
}

const TASK_STATE_REASONS: Record<string, string> = {
  "in-review": "In review",
  blocked: "Blocked",
  failed: "Failed",
};
const ATTENTION_REASONS: Record<string, string> = {
  "approval-required": "Needs approval",
  "needs-review": "Needs review",
  blocked: "Blocked",
  failed: "Failed",
  stale: "Stale",
  "external-issue-closed": "Issue closed",
};
const OPEN_MESSAGE = new Set(["queued", "delivered", "acknowledged", "uncertain"]);
const OPEN_GATE = new Set(["proposed", "pending"]);

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/**
 * What waits on a person, across projects. Task-shaped needs collapse to one item per task so a
 * blocked task awaiting review counts once; blockers also surface on the Overview, where Needs you
 * lists them with their owner.
 */
export function deriveProjectWorkAttention(source: AttentionSource): ProjectWorkAttentionSummary {
  const titles = new Map(source.tasks.map((task) => [`${task.projectId}:${task.taskId}`, task]));
  // A blocked attention row's detail is the blocker id; the blocker itself says who and why.
  const blockedBy = new Map(
    source.blockers.map((blocker) => [
      `${blocker.projectId}:${blocker.taskId}`,
      `Waiting on ${blocker.resolver}: ${blocker.reason}`,
    ]),
  );
  const taskItems = new Map<string, ProjectWorkAttentionItem>();
  const addTask = (
    projectId: string,
    taskId: string,
    reason: string,
    detail: string | null,
    at: string | undefined,
  ) => {
    const key = `${projectId}:${taskId}`;
    const task = titles.get(key);
    // Terminal tasks no longer wait on anyone, whatever an old row says.
    if (task === undefined || task.state === "completed" || task.state === "canceled") return;
    if (taskItems.has(key)) return;
    taskItems.set(key, {
      projectId: projectId as ProjectId,
      key: `task:${key}:${reason}`,
      surface: "tasks",
      kind: "task",
      reason,
      title: clip(task.title, 240),
      ...(detail ? { detail: clip(detail, 240) } : {}),
      taskId: taskId as ProjectWorkTaskId,
      at: at ?? task.updatedAt,
    });
  };
  // Most pressing first: explicit gates and attention rows, then task states.
  for (const record of source.records) {
    if (record.kind !== "gate" || !OPEN_GATE.has(record.status) || record.taskId === null) continue;
    addTask(
      record.projectId,
      record.taskId,
      "Needs approval",
      record.gate === null ? null : `${record.gate} gate`,
      record.updatedAt,
    );
  }
  for (const row of source.attention) {
    addTask(
      row.projectId,
      row.taskId,
      ATTENTION_REASONS[row.reason] ?? "Needs you",
      row.reason === "blocked"
        ? (blockedBy.get(`${row.projectId}:${row.taskId}`) ?? null)
        : row.detail,
      undefined,
    );
  }
  for (const task of source.tasks) {
    const stateReason = TASK_STATE_REASONS[task.state];
    if (stateReason !== undefined) {
      addTask(
        task.projectId,
        task.taskId,
        stateReason,
        task.state === "blocked"
          ? (blockedBy.get(`${task.projectId}:${task.taskId}`) ?? null)
          : task.failureKind,
        undefined,
      );
    } else if (task.state === "specified" && task.approvedSpecRevision !== task.specRevision) {
      addTask(task.projectId, task.taskId, "Needs approval", "Scope", undefined);
    }
  }

  const items: ProjectWorkAttentionItem[] = [...taskItems.values()];
  for (const blocker of source.blockers) {
    const task = titles.get(`${blocker.projectId}:${blocker.taskId}`);
    if (task === undefined || task.state === "completed" || task.state === "canceled") continue;
    items.push({
      projectId: blocker.projectId as ProjectId,
      key: `blocker:${blocker.projectId}:${blocker.blockerId}`,
      surface: "overview",
      kind: "blocker",
      reason: clip(`Waiting on ${blocker.resolver}`, 64),
      title: clip(task.title, 240),
      detail: clip(blocker.reason, 240),
      taskId: blocker.taskId as ProjectWorkTaskId,
      at: task.updatedAt,
    });
  }
  for (const decision of source.decisions) {
    items.push({
      projectId: decision.projectId as ProjectId,
      key: `decision:${decision.projectId}:${decision.decisionId}`,
      surface: "overview",
      kind: "decision",
      reason: "Decision to review",
      title: clip(decision.title, 240),
      at: decision.updatedAt,
    });
  }
  for (const record of source.records) {
    const open =
      (record.kind === "question" && record.status === "pending") ||
      (record.kind === "message" && OPEN_MESSAGE.has(record.status));
    if (!open) continue;
    const body = clip(record.body ?? "", 240);
    items.push({
      projectId: record.projectId as ProjectId,
      key: `${record.kind}:${record.projectId}:${record.recordId}`,
      surface: "overview",
      kind: record.kind === "question" ? "question" : "message",
      reason: record.kind === "question" ? "Answer needed" : "Message",
      title:
        body.length > 0
          ? body
          : record.kind === "question"
            ? "A worker asked a question"
            : "A worker sent a message",
      ...(record.taskId === null ? {} : { taskId: record.taskId as ProjectWorkTaskId }),
      at: record.updatedAt,
    });
  }
  items.sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
  return { items: items.slice(0, MAX_ITEMS), truncated: items.length > MAX_ITEMS };
}

const ACTIVE_LIMIT = 60;
const RECENT_LIMIT = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ActivityCountRow {
  readonly projectId: string;
  readonly open: number;
  readonly running: number;
  readonly inReview: number;
  readonly doneThisWeek: number;
  readonly lastChangedAt: string | null;
}
export interface ActivityTaskRow {
  readonly projectId: string;
  readonly taskId: string;
  readonly title: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
}
export interface ActivityBindingRow {
  readonly taskId: string;
  readonly memberId: string;
}
export interface ActivityMemberRow {
  readonly recordId: string;
  readonly name: string | null;
  readonly avatarJson: string | null;
  readonly roleRevisionId: string | null;
}
export interface ActivityRoleRow {
  readonly recordId: string;
  readonly role: string | null;
}
export interface ActivitySource {
  readonly counts: ReadonlyArray<ActivityCountRow>;
  readonly active: ReadonlyArray<ActivityTaskRow>;
  readonly recent: ReadonlyArray<ActivityTaskRow>;
  readonly bindings: ReadonlyArray<ActivityBindingRow>;
  readonly members: ReadonlyArray<ActivityMemberRow>;
  readonly roles: ReadonlyArray<ActivityRoleRow>;
}

const decodeAvatar = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectTeamAvatar));

/**
 * What is moving across projects: per-project counts, the in-progress and in-review tasks, and
 * other recent changes, each with the member on it. A running member wins over the assignee.
 */
export function deriveProjectWorkActivity(source: ActivitySource): ProjectWorkActivitySummary {
  const roles = new Map(source.roles.map((role) => [role.recordId, role.role]));
  const workers = new Map<string, ProjectWorkActivityWorker>();
  for (const member of source.members) {
    const role = (member.roleRevisionId && roles.get(member.roleRevisionId)) || "member";
    const name = member.name?.trim() || role;
    const avatar = member.avatarJson === null ? Option.none() : decodeAvatar(member.avatarJson);
    workers.set(member.recordId, {
      name: clip(name, 128),
      role: clip(role, 64),
      ...(Option.isSome(avatar) ? { avatar: avatar.value } : {}),
    });
  }
  const running = new Map(source.bindings.map((binding) => [binding.taskId, binding.memberId]));
  const toTask = (row: ActivityTaskRow): ProjectWorkActivityTask => {
    const worker =
      workers.get(running.get(row.taskId) ?? "") ??
      (row.assigneeId === null ? undefined : workers.get(row.assigneeId));
    return {
      projectId: row.projectId as ProjectId,
      taskId: row.taskId as ProjectWorkTaskId,
      title: clip(row.title, 240),
      state: row.state,
      at: row.updatedAt,
      ...(worker ? { worker } : {}),
      ...(worker === undefined && row.assigneeName
        ? { assignee: clip(row.assigneeName, 128) }
        : {}),
    };
  };
  return {
    projects: source.counts.slice(0, 500).map((row) => ({
      projectId: row.projectId as ProjectId,
      open: row.open,
      running: row.running,
      inReview: row.inReview,
      doneThisWeek: row.doneThisWeek,
      ...(row.lastChangedAt === null ? {} : { lastChangedAt: row.lastChangedAt }),
    })),
    active: source.active.slice(0, ACTIVE_LIMIT).map(toTask),
    recent: source.recent.slice(0, RECENT_LIMIT).map(toTask),
  };
}

/** Bounded reads behind {@link deriveProjectWorkActivity}; counts aggregate in SQL. */
const readProjectWorkActivity = Effect.fn("ProjectWorkAttention.readActivity")(function* (
  sql: SqlClient.SqlClient,
  projectIds: ReadonlyArray<string>,
) {
  const weekAgo = DateTime.formatIso(
    DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - WEEK_MS),
  );
  const counts = yield* sql<ActivityCountRow>`
    SELECT project_id AS projectId,
      SUM(state IN ('draft','specified','ready','blocked','failed')) AS open,
      SUM(state = 'in-progress') AS running,
      SUM(state = 'in-review') AS inReview,
      SUM(state = 'completed' AND completed_at >= ${weekAgo}) AS doneThisWeek,
      MAX(updated_at) AS lastChangedAt
    FROM t3_workflow_v2_work_tasks
    WHERE ${sql.in("project_id", projectIds)}
    GROUP BY project_id
  `;
  const active = yield* sql<ActivityTaskRow>`
    SELECT project_id AS projectId, task_id AS taskId, title, state, updated_at AS updatedAt,
      json_extract(assignee_json, '$.id') AS assigneeId,
      json_extract(assignee_json, '$.displayName') AS assigneeName
    FROM t3_workflow_v2_work_tasks
    WHERE ${sql.in("project_id", projectIds)} AND state IN ('in-progress','in-review')
    ORDER BY updated_at DESC, task_id
    LIMIT ${ACTIVE_LIMIT}
  `;
  const recent = yield* sql<ActivityTaskRow>`
    SELECT project_id AS projectId, task_id AS taskId, title, state, updated_at AS updatedAt,
      json_extract(assignee_json, '$.id') AS assigneeId,
      json_extract(assignee_json, '$.displayName') AS assigneeName
    FROM t3_workflow_v2_work_tasks
    WHERE ${sql.in("project_id", projectIds)}
      AND state NOT IN ('in-progress','in-review') AND updated_at >= ${weekAgo}
    ORDER BY updated_at DESC, task_id
    LIMIT ${RECENT_LIMIT}
  `;
  const bindings = yield* sql<ActivityBindingRow>`
    SELECT task_id AS taskId, json_extract(payload_json, '$.memberId') AS memberId
    FROM t3_workflow_v2_team_records
    WHERE ${sql.in("project_id", projectIds)} AND kind = 'run-binding' AND task_id IS NOT NULL
      AND json_extract(payload_json, '$.status') IN ('reserved','running','stopping')
  `;
  const members = yield* sql<ActivityMemberRow>`
    SELECT record_id AS recordId, json_extract(payload_json, '$.name') AS name,
      json_extract(payload_json, '$.avatar') AS avatarJson,
      json_extract(payload_json, '$.roleRevisionId') AS roleRevisionId
    FROM t3_workflow_v2_team_records
    WHERE ${sql.in("project_id", projectIds)} AND kind = 'member'
  `;
  const roles = yield* sql<ActivityRoleRow>`
    SELECT record_id AS recordId, json_extract(payload_json, '$.role') AS role
    FROM t3_workflow_v2_team_records
    WHERE ${sql.in("project_id", projectIds)} AND kind = 'role-revision'
  `;
  return deriveProjectWorkActivity({ counts, active, recent, bindings, members, roles });
});

/** Reads the projection rows behind {@link deriveProjectWorkAttention} for the given projects. */
export const readProjectWorkAttention = Effect.fn("ProjectWorkAttention.read")(function* (
  sql: SqlClient.SqlClient,
  projectIds: ReadonlyArray<string>,
) {
  if (projectIds.length === 0)
    return { items: [], truncated: false, activity: { projects: [], active: [], recent: [] } };
  const tasks = yield* sql<AttentionTaskRow>`
    SELECT project_id AS projectId, task_id AS taskId, title, state,
      spec_revision AS specRevision,
      json_extract(approval_json, '$.specRevision') AS approvedSpecRevision,
      failure_kind AS failureKind, updated_at AS updatedAt
    FROM t3_workflow_v2_work_tasks
    WHERE ${sql.in("project_id", projectIds)}
      AND state IN ('in-review','blocked','failed','specified','draft','ready','in-progress')
  `;
  const attention = yield* sql<AttentionRow>`
    SELECT project_id AS projectId, task_id AS taskId, reason, detail
    FROM t3_workflow_v2_work_attention
    WHERE ${sql.in("project_id", projectIds)} AND resolved_at IS NULL
  `;
  const blockers = yield* sql<AttentionBlockerRow>`
    SELECT project_id AS projectId, blocker_id AS blockerId, task_id AS taskId, reason, resolver
    FROM t3_workflow_v2_work_blockers
    WHERE ${sql.in("project_id", projectIds)} AND resolved_at IS NULL
  `;
  const decisions = yield* sql<AttentionDecisionRow>`
    SELECT project_id AS projectId, decision_id AS decisionId, title, updated_at AS updatedAt
    FROM t3_workflow_v2_work_decisions
    WHERE ${sql.in("project_id", projectIds)} AND state = 'proposed'
  `;
  const records = yield* sql<AttentionRecordRow>`
    SELECT project_id AS projectId, record_id AS recordId, kind,
      json_extract(payload_json, '$.status') AS status,
      json_extract(payload_json, '$.taskId') AS taskId,
      json_extract(payload_json, '$.body') AS body,
      json_extract(payload_json, '$.gate') AS gate,
      json_extract(payload_json, '$.updatedAt') AS updatedAt
    FROM t3_workflow_v2_team_records
    WHERE ${sql.in("project_id", projectIds)}
      AND kind IN ('question','message','gate')
      AND json_extract(payload_json, '$.status') IN
        ('pending','proposed','queued','delivered','acknowledged','uncertain')
  `;
  const summary = deriveProjectWorkAttention({ tasks, attention, blockers, decisions, records });
  return { ...summary, activity: yield* readProjectWorkActivity(sql, projectIds) };
});
