import type {
  ProjectId,
  ProjectWorkAttentionItem,
  ProjectWorkAttentionSummary,
  ProjectWorkTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

/** Reads the projection rows behind {@link deriveProjectWorkAttention} for the given projects. */
export const readProjectWorkAttention = Effect.fn("ProjectWorkAttention.read")(function* (
  sql: SqlClient.SqlClient,
  projectIds: ReadonlyArray<string>,
) {
  if (projectIds.length === 0) return { items: [], truncated: false };
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
  return deriveProjectWorkAttention({ tasks, attention, blockers, decisions, records });
});
