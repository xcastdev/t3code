import { CheckpointId, ThreadHistoryRpcError, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  archiveAvailability,
  deriveArchiveDetailView,
  describeHistoryFailure,
  historyActionBlocker,
  historyFileRetryBlocker,
  mergeListPages,
  nextListCursor,
  type HistoryActionGate,
} from "./threadHistoryPresentation.ts";

const threadId = ThreadId.make("thread-1");
const row = (columns: Record<string, unknown>, payload: Record<string, unknown>) =>
  JSON.stringify({ ...columns, payload_json: JSON.stringify(payload) });

const runRow = row(
  { run_id: "run-1", thread_id: threadId },
  {
    id: "run-1",
    threadId,
    ordinal: 1,
    status: "completed",
    modelSelection: {
      instanceId: "codex",
      model: "gpt-historical",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
  },
);
const replyRow = row(
  { turn_item_id: "item-1", thread_id: threadId, run_id: "run-1" },
  {
    id: "item-1",
    threadId,
    runId: "run-1",
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    type: "assistant_message",
    messageId: "message-2",
    text: "Done",
    streaming: false,
  },
);
const messageRow = row(
  { message_id: "message-1", thread_id: threadId },
  {
    id: "message-1",
    role: "user",
    text: "Fix the bug",
    createdAt: "2026-10-01T00:00:00.000Z",
  },
);

function fragments(rows: ReadonlyArray<{ kind: string; json: string }>, size: number) {
  const result = [];
  let position = 0;
  for (const [index, entry] of rows.entries()) {
    for (let offset = 0, fragment = 0; offset < entry.json.length; offset += size, fragment++) {
      result.push({
        position: position++,
        kind: entry.kind,
        source_id: `source-${index}`,
        fragment,
        payload: entry.json.slice(offset, offset + size),
      });
    }
  }
  return result;
}

describe("deriveArchiveDetailView", () => {
  const all = fragments(
    [
      { kind: "messages", json: messageRow },
      { kind: "runs", json: runRow },
      { kind: "turn_items", json: replyRow },
    ],
    64,
  );

  it("rejoins rows split across fragments and counts work with saved model and effort", () => {
    const view = deriveArchiveDetailView({
      threadId,
      fragments: all,
      complete: true,
    });
    expect(view.messages.map((message) => message.text)).toEqual(["Fix the bug"]);
    expect(view.unreadableRows).toBe(0);
    expect(view.work).toEqual([
      expect.objectContaining({
        runId: "run-1",
        status: "completed",
        retention: "complete",
        messageCount: 1,
        modelSelection: expect.objectContaining({ model: "gpt-historical" }),
      }),
    ]);
  });

  it("holds back a row cut by the page boundary and labels counts partial", () => {
    const lastStart = all.findIndex((fragment) => fragment.kind === "turn_items");
    const prefix = all.slice(0, lastStart + 1);
    const view = deriveArchiveDetailView({
      threadId,
      fragments: prefix,
      complete: false,
    });
    expect(view.unreadableRows).toBe(0);
    expect(view.work).toEqual([
      expect.objectContaining({
        runId: "run-1",
        messageCount: 0,
        retention: "partial",
      }),
    ]);
  });

  it("marks counts unknown when a retained row no longer decodes", () => {
    const broken = fragments(
      [
        { kind: "runs", json: runRow },
        { kind: "turn_items", json: "{" },
      ],
      4096,
    );
    const view = deriveArchiveDetailView({
      threadId,
      fragments: broken,
      complete: true,
    });
    expect(view.unreadableRows).toBe(1);
    expect(view.work[0]?.retention).toBe("unknown");
  });
});

describe("historyActionBlocker", () => {
  const ready: HistoryActionGate = {
    connected: true,
    selectionCurrent: true,
    canOperate: true,
    availability: "available",
    pending: false,
    filesUncertain: false,
    recoveryUncertain: false,
    recoveryOperation: null,
    detailLoaded: true,
    hydrated: true,
    capabilities: {
      owner: "ordinary",
      contextRestore: true,
      fork: true,
      restoreFiles: true,
      retainedCheckpointIds: [],
    },
  };

  it("keeps context restore available while an earlier file restore is unconfirmed", () => {
    const gate = { ...ready, filesUncertain: true };
    expect(historyActionBlocker("restore", gate)).toBeNull();
    expect(historyActionBlocker("fork", gate)).toBeNull();
    expect(historyActionBlocker("restore-files", gate)).not.toBeNull();
    expect(historyActionBlocker("release", gate)).not.toBeNull();
  });

  it("refuses every action on an executing archive and after the connection is replaced", () => {
    const executing = archiveAvailability({
      archive_id: "a",
      thread_id: threadId,
      reason: "rollback",
      state: "executing",
      created_at: "2026-10-01T00:00:00.000Z",
      operation_json: null,
    });
    expect(executing).toBe("uncertain");
    for (const action of ["restore", "fork", "restore-files", "release"] as const) {
      expect(historyActionBlocker(action, { ...ready, availability: executing })).not.toBeNull();
      expect(historyActionBlocker(action, { ...ready, selectionCurrent: false })).not.toBeNull();
      expect(historyActionBlocker(action, { ...ready, pending: true })).not.toBeNull();
    }
  });

  it("requires hydration and current owner capabilities plus the particular retained file checkpoint", () => {
    const checkpointId = CheckpointId.make("retained");
    expect(historyActionBlocker("restore", { ...ready, hydrated: false })).not.toBeNull();
    const home = {
      ...ready,
      capabilities: {
        owner: "assistant-home" as const,
        contextRestore: true,
        fork: false,
        restoreFiles: false,
        retainedCheckpointIds: [],
      },
    };
    expect(historyActionBlocker("restore", home)).toBeNull();
    expect(historyActionBlocker("fork", home)).not.toBeNull();
    expect(historyActionBlocker("restore-files", home, checkpointId)).not.toBeNull();
    const retained = {
      ...ready,
      capabilities: {
        ...ready.capabilities!,
        retainedCheckpointIds: [checkpointId],
      },
    };
    const status = {
      threadId,
      archiveId: "operation",
      state: "not-started" as const,
    };
    expect(
      historyActionBlocker("restore-files", { ...retained, filesUncertain: true }, checkpointId),
    ).not.toBeNull();
    expect(
      historyFileRetryBlocker({ ...retained, filesUncertain: true }, status, checkpointId),
    ).toBeNull();
    expect(
      historyFileRetryBlocker(retained, { ...status, state: "executing" }, checkpointId),
    ).not.toBeNull();
    expect(historyActionBlocker("restore-files", retained, checkpointId)).toBeNull();
    expect(
      historyActionBlocker("restore-files", retained, CheckpointId.make("unretained")),
    ).not.toBeNull();
  });
});

describe("history list paging", () => {
  const header = (id: string) => ({
    archive_id: id,
    thread_id: threadId,
    reason: "rollback",
    state: "ready" as const,
    created_at: "2026-10-01T00:00:00.000Z",
    operation_json: null,
  });

  it("offers an older page only after a full page, keyed by its last archive", () => {
    expect(nextListCursor([[header("a"), header("b")]], 2)).toBe("b");
    expect(nextListCursor([[header("a")]], 2)).toBeNull();
    expect(nextListCursor([null], 2)).toBeNull();
  });

  it("drops archives repeated when a new archive shifts the page window", () => {
    expect(
      mergeListPages([
        [header("a"), header("b")],
        [header("b"), header("c")],
      ]).map((entry) => entry.archive_id),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("describeHistoryFailure", () => {
  it("explains a refused file restore in a shared workspace without implying files changed", () => {
    expect(
      describeHistoryFailure(new ThreadHistoryRpcError({ reason: "shared-workspace" })),
    ).toMatch(/not restored/);
  });
});
