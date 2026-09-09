import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkLogEntry } from "~/session-logic";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  createWorkingStatusDwell,
  deriveMessagesTimelineRows,
  durationTickSubscriberCount,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  shouldPreserveAssistantLineBreaks,
  stableFallbackPhrase,
  subscribeToDurationTick,
  WORKING_FALLBACK_PHRASES,
  WORKING_STATUS_DWELL_MS,
  workingStatusIsLive,
  workingStatusPhrase,
} from "./MessagesTimeline.logic";

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves Claude insight formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });

  it("copies the rendered representation of Codex directives", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: [
          'Created :codex-file-citation{path="outputs/report.xlsx" purpose="output"}.',
          "",
          '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
        ].join("\n"),
        streaming: false,
      }),
    ).toEqual({
      text: "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)",
      visible: true,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("folds the first assistant message and settled work before the terminal response", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "Synthetic deployment checklist\n1. Confirm the deployment is ready.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          turnId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-first-entry",
      "work-toggle:work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it("folds all assistant messages before the terminal message", () => {
    const timelineEntries = [
      {
        id: "assistant-first-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:01Z",
        message: {
          id: "assistant-first" as never,
          role: "assistant" as const,
          text: "The main result is ready.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:01Z",
          updatedAt: "2026-01-01T00:00:02Z",
          streaming: false,
        },
      },
      {
        id: "assistant-middle-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:03Z",
        message: {
          id: "assistant-middle" as never,
          role: "assistant" as const,
          text: "I am checking one more detail.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:03Z",
          updatedAt: "2026-01-01T00:00:04Z",
          streaming: false,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Verification finished.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
    ];

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "assistant-final-entry"]);
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            turnId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        turnId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestTurn still points at the
    // previous, settled turn — it must stay folded through that window.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "assistant-thought-entry",
      "work-live:work-entry-1",
    ]);
  });

  it("keeps adjacent active tool calls in one replacing row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "completed-edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "completed-edit",
            createdAt: "2026-01-01T00:00:06Z",
            turnId: "turn-1" as never,
            label: "Edited files",
            requestKind: "file-change",
            changedFiles: ["src/one.ts", "src/two.ts"],
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live"]);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      groupedEntries: [
        { id: "completed-command" },
        { id: "completed-edit" },
        { id: "running-command" },
      ],
    });
  });

  it("summarizes a tool run after commentary starts a new run", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Checking another thing.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-toggle", "message", "work-live"]);
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 1,
      summary: "Ran 1 command",
    });
  });

  it("keeps separated in-progress tool runs visible", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "first-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "first-running",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Running first command",
            command: "rg first",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "second-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "second-running",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running second command",
            command: "rg second",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live", "message", "work-live"]);
    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "first-running",
      "second-running",
    ]);
  });

  it("does not revive stale in-progress tools before a fresh send has a turn id", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-running",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Running stale command",
            command: "rg stale",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
  });

  it("does not revive separated historical task progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-progress-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-progress",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Old progress",
            tone: "thinking" as const,
            sourceActivityKind: "task.progress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running command",
            command: "rg current",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "running-command",
    ]);
  });

  it("keeps the latest completed tool call live while the turn is running", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "latest-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "latest-command",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live"]);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "latest-command" },
      groupedEntries: [{ id: "latest-command" }],
    });
  });

  it("does not fold the session's running turn when latestTurn regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            turnId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningTurnId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.turnId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("work-live:running-work-entry");
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
  });

  it.each([
    ["tools", "tool", "Used 3 tools"],
    ["tools and status updates", "info", "Used 2 tools and received 1 update"],
  ] as const)("expands %s through the same activity group", (_, middleTone, summary) => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "Status updated",
          detail: "Editing MessagesTimeline.tsx",
          tone: middleTone,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 3,
      expanded: false,
      summary,
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-toggle:work-entry-1",
      "work-1",
      "work-2",
      "work-3",
    ]);
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
  });

  it.each([
    ["recovered", ["failed", "completed"], false],
    ["ending in failure", ["completed", "failed"], true],
    ["failed", ["failed", "failed"], true],
  ] as const)("uses the final call for %s tool groups", (_, statuses, hasFailure) => {
    const timelineEntries = statuses.map((status, index) => ({
      id: `work-entry-${index}`,
      kind: "work" as const,
      createdAt: `2026-01-01T00:00:0${index}Z`,
      entry: {
        id: `work-${index}`,
        createdAt: `2026-01-01T00:00:0${index}Z`,
        label: "Ran command",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        toolLifecycleStatus: status,
      },
    }));

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 2,
      hasFailure,
    });
  });

  it.each([
    ["the later success is hidden", ["failed", "completed", "info"], false],
    ["the later success is visible", ["failed", "info", "completed"], false],
    ["an error-toned entry recovers", ["error", "info", "completed"], false],
    ["the final failure is hidden", ["completed", "failed", "info"], true],
    ["the final failure is visible", ["failed", "info", "failed"], true],
    ["the only failure is visible", ["completed", "info", "failed"], true],
  ] as const)(
    "uses the final tool call for mixed work groups when %s",
    (_, statuses, hasFailure) => {
      const timelineEntries = statuses.map((status, index) => {
        const id = `work-${index}`;
        const createdAt = `2026-01-01T00:00:0${index}Z`;

        return {
          id: `work-entry-${index}`,
          kind: "work" as const,
          createdAt,
          entry:
            status === "info"
              ? { id, createdAt, label: "Status updated", tone: "info" as const }
              : status === "error"
                ? { id, createdAt, label: "Command failed", tone: "error" as const }
                : {
                    id,
                    createdAt,
                    label: "Ran command",
                    tone: "tool" as const,
                    toolLifecycleStatus: status,
                  },
        };
      });

      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

      expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
        hiddenCount: statuses.some((status) => status === "error") ? 2 : 3,
        summary: statuses.some((status) => status === "error")
          ? "Received 1 update and used 1 tool"
          : "Used 2 tools and received 1 update",
        hasFailure,
      });
      if (statuses.some((status) => status === "error")) {
        expect(rows[0]).toMatchObject({
          kind: "work",
          groupedEntries: [{ tone: "error", label: "Command failed" }],
        });
      }
    },
  );
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });
});

describe("deriveTurnFolds work summaries", () => {
  const userEntry = (createdAt: string, id = "user-1") =>
    ({
      id: `entry-${id}`,
      kind: "message" as const,
      createdAt,
      message: {
        id: id as never,
        role: "user" as const,
        text: "Do the thing",
        turnId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    }) as never;

  const assistantEntry = (
    id: string,
    turnId: string,
    createdAt: string,
    updatedAt: string,
    text = "Response",
  ) =>
    ({
      id: `entry-${id}`,
      kind: "message" as const,
      createdAt,
      message: {
        id: id as never,
        role: "assistant" as const,
        text,
        turnId: turnId as never,
        createdAt,
        updatedAt,
        streaming: false,
      },
    }) as never;

  const workEntry = (
    id: string,
    turnId: string,
    createdAt: string,
    itemType: string,
    toolCallId: string,
    tone = "tool",
  ) =>
    ({
      id: `entry-${id}`,
      kind: "work" as const,
      createdAt,
      entry: {
        id,
        createdAt,
        turnId: turnId as never,
        label: "Did work",
        tone,
        itemType,
        toolCallId,
      },
    }) as never;

  const foldRowOf = (rows: ReadonlyArray<unknown>, turnId: string) =>
    rows.find(
      (
        row,
      ): row is { kind: "turn-fold"; turnId: string; label: string; subfoldLabels?: string[] } =>
        (row as { kind?: string }).kind === "turn-fold" &&
        (row as { turnId?: string }).turnId === turnId,
    );

  it("renders every count segment after the duration, omitting zero segments", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("2026-01-01T00:00:00Z"),
        workEntry("w1", "turn-1", "2026-01-01T00:00:02Z", "command_execution", "c1"),
        workEntry("w2", "turn-1", "2026-01-01T00:00:03Z", "command_execution", "c2"),
        workEntry("w3", "turn-1", "2026-01-01T00:00:04Z", "file_change", "t1"),
        workEntry("w4", "turn-1", "2026-01-01T00:00:05Z", "collab_agent_tool_call", "s1"),
        assistantEntry("a1", "turn-1", "2026-01-01T00:01:10Z", "2026-01-01T00:01:12Z"),
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:12Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const fold = foldRowOf(rows, "turn-1");
    expect(fold?.label).toBe("Worked for 1m 12s · 2 Commands · 1 Tool Call · 1 Subagent");
  });

  it("uses singular nouns for single items", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("2026-01-01T00:00:00Z"),
        workEntry("w1", "turn-1", "2026-01-01T00:00:02Z", "command_execution", "c1"),
        assistantEntry("a1", "turn-1", "2026-01-01T00:00:10Z", "2026-01-01T00:00:10Z"),
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(foldRowOf(rows, "turn-1")?.label).toBe("Worked for 10s · 1 Command");
  });

  it("prefers stamped counts over client-derived ones for a settled turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("2026-01-01T00:00:00Z"),
        workEntry("w1", "turn-1", "2026-01-01T00:00:02Z", "command_execution", "c1"),
        assistantEntry("a1", "turn-1", "2026-01-01T00:00:10Z", "2026-01-01T00:00:10Z"),
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:10Z",
      },
      turns: [
        {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: "2026-01-01T00:00:00Z",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:10Z",
          assistantMessageId: "a1" as never,
          counts: {
            commandCount: 9,
            toolCallCount: 4,
            subagentCount: 0,
            changedFileCount: 0,
          },
        },
      ] as never,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(foldRowOf(rows, "turn-1")?.label).toBe("Worked for 10s · 9 Commands · 4 Tool Calls");
  });

  it("falls back to the bare duration when an unstamped turn predates retained activity", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("2026-01-01T00:00:00Z"),
        // Retained activity begins well after the turn started: rows aged out.
        workEntry("w1", "turn-1", "2026-01-01T00:05:00Z", "command_execution", "c1"),
        assistantEntry("a1", "turn-1", "2026-01-01T00:05:10Z", "2026-01-01T00:05:10Z"),
        userEntry("2026-01-01T00:06:00Z", "user-2"),
        workEntry("w2", "turn-2", "2026-01-01T00:06:02Z", "command_execution", "c2"),
        assistantEntry("a2", "turn-2", "2026-01-01T00:06:10Z", "2026-01-01T00:06:10Z"),
      ],
      oldestRetainedActivityAt: "2026-01-01T00:05:00Z",
      latestTurn: {
        turnId: "turn-2" as never,
        state: "completed",
        startedAt: "2026-01-01T00:06:00Z",
        completedAt: "2026-01-01T00:06:10Z",
      },
      turns: [
        {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: "2026-01-01T00:00:00Z",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:05:10Z",
          assistantMessageId: "a1" as never,
        },
      ] as never,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    // No stamp and the turn started before the oldest retained row: never a
    // partial count.
    expect(foldRowOf(rows, "turn-1")?.label).toBe("Worked for 5m 10s");
  });

  it("suppresses the diff but keeps the changed-file count when the checkpoint is not ready", () => {
    const timelineEntries = [
      userEntry("2026-01-01T00:00:00Z"),
      workEntry("w1", "turn-1", "2026-01-01T00:00:02Z", "command_execution", "c1"),
      assistantEntry("a1", "turn-1", "2026-01-01T00:00:10Z", "2026-01-01T00:00:10Z"),
    ];
    const latestTurn = {
      turnId: "turn-1" as never,
      state: "completed" as const,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:10Z",
    };
    const checkpoint = (status: string) =>
      new Map([
        [
          "a1" as never,
          {
            turnId: "turn-1" as never,
            checkpointTurnCount: 1,
            checkpointRef: "ref-1" as never,
            status,
            files: [
              { path: "a.ts", kind: "modified", additions: 8, deletions: 0 },
              { path: "b.ts", kind: "modified", additions: 3, deletions: 2 },
            ],
            assistantMessageId: "a1" as never,
            completedAt: "2026-01-01T00:00:10Z",
          },
        ],
      ]) as never;

    const readyRows = deriveMessagesTimelineRows({
      timelineEntries,
      latestTurn,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: checkpoint("ready"),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(foldRowOf(readyRows, "turn-1")?.label).toBe(
      "Worked for 10s · 1 Command · 2 Changed Files +11/−2",
    );

    const pendingRows = deriveMessagesTimelineRows({
      timelineEntries,
      latestTurn,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: checkpoint("missing"),
      revertTurnCountByUserMessageId: new Map(),
    });
    expect(foldRowOf(pendingRows, "turn-1")?.label).toBe(
      "Worked for 10s · 1 Command · 2 Changed Files",
    );
  });

  it("labels a historical interrupted turn as stopped, not worked", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("2026-01-01T00:00:00Z"),
        workEntry("w1", "turn-1", "2026-01-01T00:00:02Z", "command_execution", "c1"),
        assistantEntry("a1", "turn-1", "2026-01-01T00:00:10Z", "2026-01-01T00:00:10Z"),
        userEntry("2026-01-01T00:01:00Z", "user-2"),
        workEntry("w2", "turn-2", "2026-01-01T00:01:02Z", "command_execution", "c2"),
        assistantEntry("a2", "turn-2", "2026-01-01T00:01:10Z", "2026-01-01T00:01:10Z"),
      ],
      // turn-2 is the latest; turn-1 is history and was interrupted.
      latestTurn: {
        turnId: "turn-2" as never,
        state: "completed",
        startedAt: "2026-01-01T00:01:00Z",
        completedAt: "2026-01-01T00:01:10Z",
      },
      turns: [
        {
          turnId: "turn-1" as never,
          state: "interrupted",
          requestedAt: "2026-01-01T00:00:00Z",
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:10Z",
          assistantMessageId: "a1" as never,
          counts: {
            commandCount: 1,
            toolCallCount: 0,
            subagentCount: 0,
            changedFileCount: 0,
          },
        },
      ] as never,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(foldRowOf(rows, "turn-1")?.label).toBe("You stopped after 10s · 1 Command");
  });

  it("splits subfolds at assistant boundaries and reconciles them with the turn total", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("2026-01-01T00:00:00Z"),
        workEntry("w1", "turn-1", "2026-01-01T00:00:02Z", "command_execution", "c1"),
        workEntry("w2", "turn-1", "2026-01-01T00:00:03Z", "command_execution", "c2"),
        workEntry("w3", "turn-1", "2026-01-01T00:00:04Z", "command_execution", "c3"),
        assistantEntry("a1", "turn-1", "2026-01-01T00:00:05Z", "2026-01-01T00:00:05Z", "Mid"),
        workEntry("w4", "turn-1", "2026-01-01T00:00:06Z", "file_change", "t1"),
        workEntry("w5", "turn-1", "2026-01-01T00:00:07Z", "file_change", "t2"),
        workEntry("w6", "turn-1", "2026-01-01T00:00:08Z", "collab_agent_tool_call", "s1"),
        assistantEntry("a2", "turn-1", "2026-01-01T00:00:20Z", "2026-01-01T00:00:20Z", "Final"),
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:20Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const fold = foldRowOf(rows, "turn-1");
    expect(fold?.label).toBe("Worked for 20s · 3 Commands · 2 Tool Calls · 1 Subagent");
    expect(fold?.subfoldLabels).toEqual(["3 Commands", "2 Tool Calls · 1 Subagent"]);
  });

  it("renders a single-item subfold", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry("2026-01-01T00:00:00Z"),
        workEntry("w1", "turn-1", "2026-01-01T00:00:02Z", "command_execution", "c1"),
        assistantEntry("a1", "turn-1", "2026-01-01T00:00:05Z", "2026-01-01T00:00:05Z", "Mid"),
        workEntry("w2", "turn-1", "2026-01-01T00:00:06Z", "file_change", "t1"),
        assistantEntry("a2", "turn-1", "2026-01-01T00:00:20Z", "2026-01-01T00:00:20Z", "Final"),
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:20Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(foldRowOf(rows, "turn-1")?.subfoldLabels).toEqual(["1 Command", "1 Tool Call"]);
  });
});

describe("turn-fold row identity", () => {
  it("treats a fold whose subfolds changed as a new row", () => {
    const foldRow = (subfoldLabels: string[]) =>
      ({
        kind: "turn-fold" as const,
        id: "turn-fold:turn-1",
        createdAt: "2026-01-01T00:00:02Z",
        turnId: "turn-1" as never,
        label: "Worked for 20s · 3 Commands",
        subfoldLabels,
        expanded: false,
      }) as never;

    const initial = computeStableMessagesTimelineRows([foldRow(["1 Command", "2 Commands"])], {
      byId: new Map(),
      result: [],
    });
    // Same label and expansion, different breakdown: the row must not be
    // reused, or the expanded fold keeps rendering stale subfold rows.
    const updated = computeStableMessagesTimelineRows([foldRow(["3 Commands"])], initial);

    expect(updated.result[0]).not.toBe(initial.result[0]);
  });
});

// ---------------------------------------------------------------------------
// AC-12 — tool-aware working status
// ---------------------------------------------------------------------------

describe("workingStatusPhrase", () => {
  const entry = (over: Partial<WorkLogEntry>): WorkLogEntry =>
    ({
      id: "w1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "l",
      tone: "tool",
      ...over,
    }) as WorkLogEntry;

  it("names the running tool for each item type", () => {
    expect(workingStatusPhrase(entry({ itemType: "command_execution" }))).toBe("Running command");
    expect(workingStatusPhrase(entry({ itemType: "file_change" }))).toBe("Editing file");
    expect(workingStatusPhrase(entry({ itemType: "web_search" }))).toBe("Searching the web");
    expect(workingStatusPhrase(entry({ itemType: "image_view" }))).toBe("Viewing image");
    expect(workingStatusPhrase(entry({ itemType: "mcp_tool_call" }))).toBe("Running MCP tool");
    expect(workingStatusPhrase(entry({ itemType: "collab_agent_tool_call" }))).toBe(
      "Delegating to subagent",
    );
  });

  it("reads file work that arrives as a dynamic Read File tool call", () => {
    // There is no `file_read` item type; read work arrives this way.
    expect(
      workingStatusPhrase(entry({ itemType: "dynamic_tool_call", toolTitle: "Read File" })),
    ).toBe("Reading file");
  });

  it("reads file work that arrives as a file-read request kind", () => {
    expect(workingStatusPhrase(entry({ itemType: "file_change", requestKind: "file-read" }))).toBe(
      "Reading file",
    );
  });

  it("returns null when no tool is identifiable", () => {
    expect(workingStatusPhrase(entry({ tone: "thinking" }))).toBeNull();
    expect(workingStatusPhrase(null)).toBeNull();
  });
});

describe("stableFallbackPhrase", () => {
  it("is deterministic for the same message key", () => {
    const first = stableFallbackPhrase("msg-abc");
    for (let i = 0; i < 50; i += 1) {
      expect(stableFallbackPhrase("msg-abc")).toBe(first);
    }
  });

  it("spreads different keys across more than one phrase", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => stableFallbackPhrase(`msg-${i}`)));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("only ever returns a phrase from the fallback set", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(WORKING_FALLBACK_PHRASES).toContain(stableFallbackPhrase(`k-${i}`));
    }
  });
});

describe("createWorkingStatusDwell", () => {
  it("holds the first label for the dwell window before showing the next", () => {
    const dwell = createWorkingStatusDwell("Thinking", 0);
    expect(dwell.label).toBe("Thinking");

    dwell.push("Running command", 100);
    // Still inside the dwell window: the first label must stay readable.
    expect(dwell.label).toBe("Thinking");

    dwell.push("Running command", WORKING_STATUS_DWELL_MS + 1);
    expect(dwell.label).toBe("Running command");
  });

  it("holds the current label through rapid generic churn", () => {
    const dwell = createWorkingStatusDwell("Running command", 0);
    // Distinct generic phrases arriving far faster than the dwell window.
    dwell.push("Thinking", 50);
    dwell.push("Working", 100);
    dwell.push("Considering the options", 150);
    expect(dwell.label).toBe("Running command");
    // Each generic transition was dropped rather than queued behind the others.
    expect(dwell.droppedCount).toBe(3);

    // Only the newest generic phrase survives; the intermediate ones never show.
    dwell.push("Considering the options", WORKING_STATUS_DWELL_MS + 1);
    expect(dwell.label).toBe("Considering the options");
  });

  it("never lets generic churn displace a queued real tool change", () => {
    const dwell = createWorkingStatusDwell("Running command", 0);
    dwell.push("Reading file", 50);
    // Generic churn arrives after a real tool change is already pending.
    dwell.push("Thinking", 100);
    dwell.push("Working", 150);
    expect(dwell.label).toBe("Running command");

    // The real tool change wins the slot; the generic phrases are dropped.
    dwell.push("Working", WORKING_STATUS_DWELL_MS + 1);
    expect(dwell.label).toBe("Reading file");
  });

  it("drops queued labels when the status reverts to what is already shown", () => {
    const dwell = createWorkingStatusDwell("Reading file", 0);
    // A tool starts and finishes inside the dwell window, so the status falls
    // back to the label already on screen.
    dwell.push("Editing file", 100);
    dwell.push("Reading file", 200);
    expect(dwell.label).toBe("Reading file");

    // "Editing file" is long finished. A later transition must show the tool
    // that is actually running, not resurrect the dead one.
    dwell.push("Running command", WORKING_STATUS_DWELL_MS + 1);
    expect(dwell.label).toBe("Running command");
  });

  it("shows genuine tool changes in order once the dwell elapses", () => {
    const dwell = createWorkingStatusDwell("Running command", 0);
    dwell.push("Reading file", 100);
    dwell.push("Editing file", 200);
    expect(dwell.label).toBe("Running command");

    dwell.push("Editing file", WORKING_STATUS_DWELL_MS + 1);
    expect(dwell.label).toBe("Reading file");

    dwell.push("Editing file", WORKING_STATUS_DWELL_MS * 2 + 2);
    expect(dwell.label).toBe("Editing file");
  });

  it("does not re-arm the dwell window for an unchanged label", () => {
    const dwell = createWorkingStatusDwell("Running command", 0);
    dwell.push("Running command", 100);
    dwell.push("Reading file", 200);
    dwell.push("Reading file", WORKING_STATUS_DWELL_MS + 1);
    expect(dwell.label).toBe("Reading file");
  });
});

describe("workingStatusIsLive", () => {
  it("is live while the turn phase is running", () => {
    expect(workingStatusIsLive({ isWorking: true, toolLifecycleStatus: "inProgress" })).toBe(true);
  });

  it("is not live for a settled part even when a timestamp is absent", () => {
    // Live-ness must come from phase, never from a missing completedAt.
    expect(workingStatusIsLive({ isWorking: false, toolLifecycleStatus: undefined })).toBe(false);
    expect(workingStatusIsLive({ isWorking: true, toolLifecycleStatus: "completed" })).toBe(false);
    expect(workingStatusIsLive({ isWorking: true, toolLifecycleStatus: "failed" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-11 — one shared duration ticker
// ---------------------------------------------------------------------------

describe("subscribeToDurationTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs exactly one interval for N subscribers", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    const ticks = [0, 0, 0, 0, 0];
    const unsubscribes = ticks.map((_, index) =>
      subscribeToDurationTick(() => {
        ticks[index] = (ticks[index] ?? 0) + 1;
      }),
    );

    // Five live rows, one interval.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(durationTickSubscriberCount()).toBe(5);

    vi.advanceTimersByTime(1000);
    expect(ticks).toEqual([1, 1, 1, 1, 1]);

    vi.advanceTimersByTime(2000);
    expect(ticks).toEqual([3, 3, 3, 3, 3]);
    // Still one interval after ticking.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    for (const unsubscribe of unsubscribes.slice(0, 4)) unsubscribe();
    expect(durationTickSubscriberCount()).toBe(1);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    unsubscribes[4]!();
    expect(durationTickSubscriberCount()).toBe(0);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    // No interval may run with zero subscribers.
    vi.advanceTimersByTime(5000);
    expect(ticks).toEqual([3, 3, 3, 3, 3]);
  });

  it("restarts a single interval when a subscriber returns after the last one left", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const unsubscribe = subscribeToDurationTick(() => {});
    unsubscribe();
    expect(durationTickSubscriberCount()).toBe(0);

    const second = subscribeToDurationTick(() => {});
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(durationTickSubscriberCount()).toBe(1);
    second();
    expect(durationTickSubscriberCount()).toBe(0);
  });

  it("is idempotent when the same unsubscribe runs twice", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const a = subscribeToDurationTick(() => {});
    const b = subscribeToDurationTick(() => {});
    a();
    a();
    expect(durationTickSubscriberCount()).toBe(1);
    expect(clearIntervalSpy).not.toHaveBeenCalled();
    b();
    expect(durationTickSubscriberCount()).toBe(0);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps ticking the remaining subscribers when one throws", () => {
    const ticked: string[] = [];
    const unsubA = subscribeToDurationTick(() => {
      throw new Error("boom");
    });
    const unsubB = subscribeToDurationTick(() => {
      ticked.push("b");
    });
    vi.advanceTimersByTime(1000);
    expect(ticked).toEqual(["b"]);
    unsubA();
    unsubB();
  });
});

describe("working row status label", () => {
  const workingRowFor = (
    entry: Partial<WorkLogEntry> | null,
    turnId = "turn-status",
  ): Extract<ReturnType<typeof deriveMessagesTimelineRows>[number], { kind: "working" }> => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "go",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        ...(entry
          ? [
              {
                id: "work-entry",
                kind: "work" as const,
                createdAt: "2026-01-01T00:00:01Z",
                entry: {
                  id: "w-1",
                  createdAt: "2026-01-01T00:00:01Z",
                  turnId: turnId as never,
                  toolCallId: "call-1",
                  label: "work",
                  tone: "tool",
                  toolLifecycleStatus: "inProgress",
                  ...entry,
                } as WorkLogEntry,
              },
            ]
          : []),
      ],
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      runningTurnId: turnId as never,
      latestTurn: {
        turnId: turnId as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });
    const workingRow = rows.find((row) => row.kind === "working");
    if (!workingRow || workingRow.kind !== "working") throw new Error("no working row");
    return workingRow;
  };

  it("names the running command instead of a generic label", () => {
    expect(workingRowFor({ itemType: "command_execution" }).statusLabel).toBe("Running command");
  });

  it("names subagent delegation", () => {
    expect(workingRowFor({ itemType: "collab_agent_tool_call" }).statusLabel).toBe(
      "Delegating to subagent",
    );
  });

  it("falls back to a stable per-turn phrase when no tool is running", () => {
    const label = workingRowFor(null, "turn-abc").statusLabel;
    expect(WORKING_FALLBACK_PHRASES).toContain(label);
    // Deterministic across independent derivations of the same turn.
    expect(workingRowFor(null, "turn-abc").statusLabel).toBe(label);
  });

  it("keeps the fallback phrase stable while the turn is unchanged but differs by turn", () => {
    const labels = new Set(
      Array.from({ length: 60 }, (_, i) => workingRowFor(null, `turn-${i}`).statusLabel),
    );
    expect(labels.size).toBeGreaterThan(1);
  });

  it("treats a changed status label as a new row so the label never goes stale", () => {
    const rowWith = (statusLabel: string) =>
      ({
        kind: "working" as const,
        id: "working-indicator-row",
        createdAt: "2026-01-01T00:00:00Z",
        showThinking: true,
        statusLabel,
      }) as never;

    const initial = computeStableMessagesTimelineRows([rowWith("Thinking")], {
      byId: new Map(),
      result: [],
    });
    const updated = computeStableMessagesTimelineRows([rowWith("Running command")], initial);
    expect(updated.result[0]).not.toBe(initial.result[0]);
  });
});

describe("shared ticker mid-tick unsubscribe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("survives a subscriber that unsubscribes during its own tick", () => {
    const ticked: string[] = [];
    let unsubA = () => {};
    unsubA = subscribeToDurationTick(() => {
      ticked.push("a");
      // A row unmounting on the same tick it fires must not corrupt iteration.
      unsubA();
    });
    const unsubB = subscribeToDurationTick(() => {
      ticked.push("b");
    });

    vi.advanceTimersByTime(1000);
    expect(ticked).toEqual(["a", "b"]);
    expect(durationTickSubscriberCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(ticked).toEqual(["a", "b", "b"]);

    unsubB();
    expect(durationTickSubscriberCount()).toBe(0);
  });
});
