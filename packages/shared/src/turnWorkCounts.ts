import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";

type WorkRun = Pick<OrchestrationV2Run, "id" | "threadId" | "modelSelection" | "status">;
type WorkItem = Pick<
  OrchestrationV2TurnItem,
  "id" | "threadId" | "runId" | "type" | "toolNonExecutionKind"
>;

export interface TurnWorkCounts {
  readonly runId: WorkRun["id"];
  readonly threadId: WorkRun["threadId"];
  readonly modelSelection: WorkRun["modelSelection"] | null;
  readonly status: WorkRun["status"] | null;
  /** Counts describe retained V2 rows, never an inferred lifetime total. */
  readonly retention: "complete" | "partial" | "unknown";
  readonly messageCount: number;
  readonly commandCount: number;
  readonly toolCallCount: number;
  readonly subagentCount: number;
}

const TOOL_ITEMS: ReadonlySet<WorkItem["type"]> = new Set([
  "file_search",
  "web_search",
  "dynamic_tool",
  "file_change",
]);

/** Supply every page being combined; overlapping stable IDs count once. Usage stays in Usage. */
export function deriveTurnWorkCounts(input: {
  readonly runs: ReadonlyArray<WorkRun>;
  readonly turnItems: ReadonlyArray<WorkItem>;
  readonly retention: TurnWorkCounts["retention"];
}): ReadonlyArray<TurnWorkCounts> {
  const rows = new Map<string, TurnWorkCounts>();
  const keyOf = (threadId: string, runId: string) => JSON.stringify([threadId, runId]);
  for (const run of input.runs) {
    rows.set(keyOf(run.threadId, run.id), {
      runId: run.id,
      threadId: run.threadId,
      modelSelection: run.modelSelection,
      status: run.status,
      retention: input.retention,
      messageCount: 0,
      commandCount: 0,
      toolCallCount: 0,
      subagentCount: 0,
    });
  }
  const seen = new Set<string>();
  for (const item of input.turnItems) {
    if (item.runId === null) continue;
    const identity = JSON.stringify([item.threadId, item.id]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const key = keyOf(item.threadId, item.runId);
    const row =
      rows.get(key) ??
      ({
        runId: item.runId,
        threadId: item.threadId,
        modelSelection: null,
        status: null,
        retention: "unknown",
        messageCount: 0,
        commandCount: 0,
        toolCallCount: 0,
        subagentCount: 0,
      } satisfies TurnWorkCounts);
    rows.set(key, {
      ...row,
      messageCount:
        row.messageCount +
        Number(item.type === "user_message" || item.type === "assistant_message"),
      commandCount:
        row.commandCount +
        Number(item.type === "command_execution" && item.toolNonExecutionKind === undefined),
      toolCallCount:
        row.toolCallCount +
        Number(TOOL_ITEMS.has(item.type) && item.toolNonExecutionKind === undefined),
      subagentCount: row.subagentCount + Number(item.type === "subagent"),
    });
  }
  return [...rows.values()];
}
