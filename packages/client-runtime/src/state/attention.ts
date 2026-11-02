import type {
  EnvironmentId,
  ProjectId,
  ProjectWorkAttentionItem,
  ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

/** Something waiting on the user: a thread's request or a Work item. */
export type AttentionEntry =
  | {
      readonly type: "chat";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "work";
      readonly key: string;
      readonly environmentId: EnvironmentId;
      readonly item: ProjectWorkAttentionItem;
    };

type AttentionThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "updatedAt"
  | "archivedAt"
  | "deletedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
> & {
  readonly source: { readonly pendingRuntimeRequest: { readonly id: string } | null };
};

interface AttentionProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly archivedAt?: string | null | undefined;
}

const chatReason = (thread: AttentionThread): string | null =>
  thread.hasPendingApprovals
    ? "Approval needed"
    : thread.hasPendingUserInput
      ? "Answer needed"
      : thread.pendingSubagentRequest === "approval"
        ? "Subagent needs approval"
        : thread.pendingSubagentRequest === "user_input"
          ? "Subagent has a question"
          : null;

/**
 * Everything waiting on the user, newest first. Work blockers are left out when their task is
 * already listed, so one blocked task is one entry; archived projects and threads don't count.
 */
export function collectAttention(input: {
  readonly threads: ReadonlyArray<AttentionThread>;
  readonly work: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly items: ReadonlyArray<ProjectWorkAttentionItem>;
  }>;
  readonly projects: ReadonlyArray<AttentionProject>;
}): ReadonlyArray<AttentionEntry> {
  const live = new Set(
    input.projects
      .filter((project) => !project.archivedAt)
      .map((project) => `${project.environmentId}:${project.id}`),
  );
  const entries: AttentionEntry[] = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (!live.has(`${thread.environmentId}:${thread.projectId}`)) continue;
    const reason = chatReason(thread);
    if (reason === null) continue;
    entries.push({
      type: "chat",
      key: `chat:${thread.environmentId}:${thread.id}:${thread.source.pendingRuntimeRequest?.id ?? reason}`,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
      title: thread.title,
      reason,
      at: thread.updatedAt,
    });
  }
  for (const { environmentId, items } of input.work) {
    const listedTasks = new Set(
      items
        .filter((item) => item.kind === "task" && item.taskId !== undefined)
        .map((item) => `${item.projectId}:${item.taskId}`),
    );
    for (const item of items) {
      if (!live.has(`${environmentId}:${item.projectId}`)) continue;
      if (item.kind === "blocker" && listedTasks.has(`${item.projectId}:${item.taskId}`)) continue;
      entries.push({ type: "work", key: `${environmentId}:${item.key}`, environmentId, item });
    }
  }
  const at = (entry: AttentionEntry) => (entry.type === "chat" ? entry.at : entry.item.at);
  return entries.sort((a, b) => at(b).localeCompare(at(a)) || a.key.localeCompare(b.key));
}

/** Which Work surfaces of one project need the user, counting every item, blockers included. */
export function workAttentionFor(
  work: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly items: ReadonlyArray<ProjectWorkAttentionItem>;
  }>,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): { readonly overview: ReadonlyArray<string>; readonly tasks: ReadonlyArray<string> } {
  const items =
    work
      .find((entry) => entry.environmentId === environmentId)
      ?.items.filter((item) => item.projectId === projectId) ?? [];
  return {
    overview: items.filter((item) => item.surface === "overview").map((item) => item.key),
    tasks: items.filter((item) => item.surface === "tasks").map((item) => item.key),
  };
}

/**
 * Tracks which keys the user has already been shown. `arrived` is true when a key appears that
 * was never present before; keys that resolve and leave do not count as arrivals.
 */
export function noteAttentionArrivals(
  seen: ReadonlySet<string>,
  keys: ReadonlyArray<string>,
): { readonly seen: ReadonlySet<string>; readonly arrived: boolean } {
  const fresh = keys.filter((key) => !seen.has(key));
  if (fresh.length === 0) return { seen, arrived: false };
  return { seen: new Set([...seen, ...fresh]), arrived: true };
}
