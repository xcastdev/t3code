import {
  type OrchestrationV2AppThread,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

/** A project completion belongs to its recipient thread, without inventing a provider run. */
export const projectTerminalNoticeItem = (input: {
  readonly command: Extract<OrchestrationV2InternalCommand, { type: "thread.notice.append" }>;
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "deletedAt">;
  readonly existingItemIds: ReadonlySet<string>;
  readonly ordinal: number;
  readonly now: DateTime.Utc;
}): OrchestrationV2TurnItem | null => {
  const { command, thread, now } = input;
  if (
    thread.id !== command.threadId ||
    thread.projectId !== command.projectId ||
    thread.deletedAt !== null
  ) {
    throw new Error("The completion recipient no longer belongs to the active project.");
  }
  if (input.existingItemIds.has(command.turnItemId)) return null;
  return {
    id: command.turnItemId,
    threadId: command.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.ordinal,
    status: "completed",
    title: "Terminal completed",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "notification",
    ...command.notification,
  };
};
