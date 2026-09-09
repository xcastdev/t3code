import { CheckpointRef, EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { codexFeedbackMessage } from "@t3tools/client-runtime/state/threads";
import { createRef, type ReactNode, type Ref } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const legendListTestId = "legend-list";

  const LegendList = (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
    contentInsetEndAdjustment?: number;
    className?: string;
    maintainScrollAtEnd?:
      | boolean
      | {
          animated?: boolean;
          on?: {
            dataChange?: boolean;
            itemLayout?: boolean;
            layout?: boolean;
          };
        };
    maintainVisibleContentPosition?:
      | boolean
      | {
          data?: boolean;
          size?: boolean;
          shouldRestorePosition?: (item: { id: string }) => boolean;
        };
    ref?: Ref<LegendListRef>;
  }) => {
    return (
      <div
        data-testid={legendListTestId}
        data-content-inset-end={props.contentInsetEndAdjustment}
        data-class-name={props.className}
        data-maintain-scroll-at-end={props.maintainScrollAtEnd ? "enabled" : undefined}
        data-maintain-scroll-at-end-animated={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.animated
            : undefined
        }
        data-maintain-scroll-at-end-data-change={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.dataChange
            : undefined
        }
        data-maintain-scroll-at-end-item-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.itemLayout
            : undefined
        }
        data-maintain-scroll-at-end-layout={
          typeof props.maintainScrollAtEnd === "object"
            ? props.maintainScrollAtEnd.on?.layout
            : undefined
        }
        data-maintain-visible-content-position={
          typeof props.maintainVisibleContentPosition === "object"
            ? "object"
            : props.maintainVisibleContentPosition
        }
        data-maintain-visible-content-position-data={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.data
            : undefined
        }
        data-maintain-visible-content-position-size={
          typeof props.maintainVisibleContentPosition === "object"
            ? props.maintainVisibleContentPosition.size
            : undefined
        }
        data-maintain-visible-content-position-restore={
          typeof props.maintainVisibleContentPosition === "object"
            ? Boolean(props.maintainVisibleContentPosition.shouldRestorePosition)
            : undefined
        }
      >
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  };

  return { LegendList };
});

function MockFileDiff(props: {
  fileDiff: { name?: string | null; prevName?: string | null };
  renderCustomHeader?: (fileDiff: {
    name?: string | null;
    prevName?: string | null;
  }) => React.ReactNode;
}) {
  return (
    <div data-testid="file-diff">
      {props.renderCustomHeader?.(props.fileDiff)}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );
}

vi.mock("@pierre/diffs/react", () => {
  return { FileDiff: MockFileDiff };
});

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

let MessagesTimeline: typeof import("./MessagesTimeline").MessagesTimeline;

beforeAll(async () => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });

  ({ MessagesTimeline } = await import("./MessagesTimeline"));
}, 30_000);

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const MESSAGE_CREATED_AT = "2026-03-17T19:12:28.000Z";

function buildProps() {
  return {
    isWorking: false,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    latestTurn: null,
    runningTurnId: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    openingVideoAttachmentId: null,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

function buildLongUserMessageText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

function buildUserTimelineEntry(text: string) {
  return {
    id: "entry-1",
    kind: "message" as const,
    createdAt: MESSAGE_CREATED_AT,
    message: {
      id: MessageId.make("message-1"),
      role: "user" as const,
      text,
      turnId: null,
      createdAt: MESSAGE_CREATED_AT,
      updatedAt: MESSAGE_CREATED_AT,
      streaming: false,
    },
  };
}

function buildAssistantTimelineEntry(text: string) {
  const entry = buildUserTimelineEntry(text);
  return {
    ...entry,
    message: {
      ...entry.message,
      role: "assistant" as const,
    },
  };
}

describe("MessagesTimeline", () => {
  it("renders a feedback command and its pending response as normal thread messages", () => {
    const submission = {
      id: MessageId.make("feedback-command"),
      command: "/feedback The agent stopped early.",
      createdAt: MESSAGE_CREATED_AT,
      status: "uploading" as const,
    };
    const messages = [
      codexFeedbackMessage(submission),
      codexFeedbackMessage(submission, "assistant"),
    ];
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={messages.map((message) => ({
          id: message.id,
          kind: "message" as const,
          createdAt: message.createdAt,
          message,
        }))}
      />,
    );

    expect(markup).toContain("/feedback The agent stopped early.");
    expect(markup).toContain("Sending feedback to OpenAI...");
  });

  it("renders the returned Codex thread ID in the feedback response", () => {
    const submission = {
      id: MessageId.make("feedback-command"),
      command: "/feedback The agent stopped early.",
      createdAt: MESSAGE_CREATED_AT,
      status: "sent" as const,
      feedbackId: "codex-thread-1",
    };
    const messages = [
      codexFeedbackMessage(submission),
      codexFeedbackMessage(submission, "assistant"),
    ];
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={messages.map((message) => ({
          id: message.id,
          kind: "message" as const,
          createdAt: message.createdAt,
          message,
        }))}
      />,
    );

    expect(markup).toContain("Feedback sent to OpenAI.");
    expect(markup).toContain("codex-thread-1");
  });

  it("renders the worked-for row at assistant response text size", () => {
    const turnId = TurnId.make("turn-with-fold");
    const assistantEntry = buildAssistantTimelineEntry("Done.");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        latestTurn={{
          turnId,
          state: "completed",
          startedAt: "2026-03-17T19:12:20.000Z",
          completedAt: "2026-03-17T19:12:28.000Z",
        }}
        timelineEntries={[
          {
            id: "work-entry-with-fold",
            kind: "work",
            createdAt: "2026-03-17T19:12:22.000Z",
            entry: {
              id: "work-with-fold",
              createdAt: "2026-03-17T19:12:22.000Z",
              turnId,
              label: "Ran command",
              tone: "tool",
              toolLifecycleStatus: "completed",
            },
          },
          {
            ...assistantEntry,
            message: { ...assistantEntry.message, turnId },
          },
        ]}
      />,
    );

    expect(markup).toContain("Worked for 8.0s");
    expect(markup).toContain("px-1 text-sm leading-relaxed text-muted-foreground");
  });

  it("uses the larger leading inset only when the top fade is enabled", () => {
    const timelineEntries = [buildUserTimelineEntry("Hello")];

    const compactMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />,
    );
    const fadedMarkup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} topFadeEnabled />,
    );

    expect(compactMarkup).toContain('class="h-3 sm:h-4"');
    expect(compactMarkup).not.toContain("topbar-scroll-fade");
    expect(fadedMarkup).toContain('class="h-[var(--workspace-titlebar-scroll-fade-height)]"');
    expect(fadedMarkup).toContain("topbar-scroll-fade");
  });

  it("keeps assistant changed-files headers sticky below the thread header", () => {
    const assistantMessageId = MessageId.make("message-assistant-with-files");
    const turnId = TurnId.make("turn-with-files");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        latestTurn={{
          turnId,
          state: "completed",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: MESSAGE_CREATED_AT,
        }}
        timelineEntries={[
          {
            id: "entry-assistant-with-files",
            kind: "message",
            createdAt: MESSAGE_CREATED_AT,
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Updated the fixture.",
              turnId,
              createdAt: MESSAGE_CREATED_AT,
              updatedAt: MESSAGE_CREATED_AT,
              streaming: false,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                checkpointTurnCount: 1,
                checkpointRef: CheckpointRef.make("checkpoint-with-files"),
                status: "ready",
                files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
                assistantMessageId,
                completedAt: MESSAGE_CREATED_AT,
              },
            ],
          ])
        }
      />,
    );

    expect(markup).toContain("sticky top-2 z-10");
    expect(markup).not.toContain("self-start");
    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("!size-[22px]");
    expect(markup).toContain("size-3");
    expect(markup).toContain('aria-label="Collapse all folders"');
    expect(markup).toContain('aria-label="Open diff"');
    expect(markup).toContain("1 changed file");
  });

  it("treats only the strict list end as the live edge", async () => {
    const {
      resolveTimelineIsAtEnd,
      resolveTimelineMinimapHasPersistentGutter,
      resolveTimelineMinimapHeightStyle,
      resolveTimelineMinimapHitStripWidth,
      resolveTimelineMinimapIndexFromPointer,
      resolveTimelineMinimapInteractiveWidth,
      resolveTimelineMinimapTopPercent,
    } = await import("./MessagesTimeline.logic");

    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
    // Within the pixel band above the content bottom counts as the end...
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 1170,
        scrollLength: 800,
      }),
    ).toBe(true);
    // ...but half a viewport up (LegendList's isNearEnd territory) does not.
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength: 2000,
        scroll: 900,
        scrollLength: 800,
      }),
    ).toBe(false);
    // The composer inset is part of contentLength and must not count as
    // distance-to-end.
    expect(
      resolveTimelineIsAtEnd(
        { isAtEnd: false, contentLength: 2100, scroll: 1170, scrollLength: 800 },
        100,
      ),
    ).toBe(true);
    // Geometry missing (older state shape): fall back to the strict flag.
    expect(resolveTimelineIsAtEnd({ isAtEnd: false })).toBe(false);

    expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
    expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 350,
      }),
    ).toBe(50);
    expect(
      resolveTimelineMinimapIndexFromPointer({
        itemCount: 101,
        railTop: 100,
        railHeight: 500,
        pointerY: 999,
      }),
    ).toBe(100);
    expect(resolveTimelineMinimapHasPersistentGutter(832)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(863)).toBe(false);
    expect(resolveTimelineMinimapHasPersistentGutter(864)).toBe(true);

    // No usable gutter (zoomed in / narrow pane): the strip must go inert
    // instead of overlaying the centered content column.
    expect(resolveTimelineMinimapHitStripWidth(768)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(792)).toBe(0);
    // Partial gutter: strip shrinks to what fits between the viewport edge
    // and the content column.
    expect(resolveTimelineMinimapHitStripWidth(820)).toBe(14);
    // Full gutter: unchanged 40px-wide strip.
    expect(resolveTimelineMinimapHitStripWidth(872)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(1400)).toBe(40);
    expect(resolveTimelineMinimapHitStripWidth(0)).toBe(0);
    expect(resolveTimelineMinimapHitStripWidth(Number.NaN)).toBe(0);

    // The collapsed target stays narrow, but an open preview keeps its full
    // 20rem width plus the 2rem offset from the minimap rail interactive.
    expect(resolveTimelineMinimapInteractiveWidth(0, false)).toBe(0);
    expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14);
    expect(resolveTimelineMinimapInteractiveWidth(40, false)).toBe(40);
    expect(resolveTimelineMinimapInteractiveWidth(0, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe("22rem");
    expect(resolveTimelineMinimapInteractiveWidth(40, true)).toBe("22rem");
  });

  it("renders generic attachments as download links instead of image previews", () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-report-pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            previewUrl: "https://environment.test/api/assets/report.pdf",
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain(
      '<a href="https://environment.test/api/assets/report.pdf" download="report.pdf" class="flex min-w-0 items-center gap-2 rounded-md py-1 text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70">',
    );
    expect(markup).not.toContain('alt="report.pdf"');
  });

  it("renders video attachments as play buttons", () => {
    const entry = {
      ...buildUserTimelineEntry("Watch the demo."),
      message: {
        ...buildUserTimelineEntry("Watch the demo.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-demo-mp4",
            name: "demo.mp4",
            mimeType: "video/mp4",
            sizeBytes: 42,
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );
    const busyMarkup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[entry]}
        openingVideoAttachmentId="attachment-demo-mp4"
      />,
    );

    expect(markup).toContain('aria-label="Play demo.mp4"');
    expect(markup).toContain("min-h-[72px]");
    expect(markup).toContain(">demo.mp4</span>");
    expect(markup).not.toContain('aria-label="Download demo.mp4"');
    expect(busyMarkup).toContain('aria-busy="true"');
    expect(busyMarkup).toContain('aria-disabled="true"');
    expect(busyMarkup).not.toContain('disabled=""');
    expect(busyMarkup).toContain(">Loading…</span>");
  });
  it("renders a file download button without creating its URL in advance", () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "attachment-report-pdf",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain(
      '<button type="button" aria-label="Download report.pdf" class="flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70">',
    );
    expect(markup).not.toContain("href=");
  });

  it("does not download an optimistic file before the server supplies its attachment ID", () => {
    const entry = {
      ...buildUserTimelineEntry("Read the report."),
      message: {
        ...buildUserTimelineEntry("Read the report.").message,
        attachments: [
          {
            type: "file" as const,
            id: "composer-local-report",
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 42,
            downloadable: false,
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain("report.pdf");
    expect(markup).not.toContain('aria-label="Download report.pdf"');
  });

  it("renders unknown attachment types as inert rows instead of crashing", () => {
    const entry = {
      ...buildUserTimelineEntry("Play the recording."),
      message: {
        ...buildUserTimelineEntry("Play the recording.").message,
        attachments: [
          {
            // A newer server can introduce attachment types this build does
            // not know. They ride the open contract member.
            type: "recording",
            id: "attachment-voice-memo",
            name: "voice-memo.ogg",
            mimeType: "audio/ogg",
            sizeBytes: 42,
          },
        ],
      },
    };

    const markup = renderToStaticMarkup(
      <MessagesTimeline {...buildProps()} timelineEntries={[entry]} />,
    );

    expect(markup).toContain("voice-memo.ogg");
    expect(markup).not.toContain('aria-label="Download voice-memo.ogg"');
    expect(markup).not.toContain('alt="voice-memo.ogg"');
    expect(markup).not.toContain("href=");
  });

  it("lets live follow alone decide whether the list pins to the end", () => {
    const firstEntry = buildUserTimelineEntry("First prompt.");
    const secondEntry = {
      ...buildUserTimelineEntry("Newest prompt."),
      id: "entry-2",
      message: {
        ...buildUserTimelineEntry("Newest prompt.").message,
        id: MessageId.make("message-2"),
      },
    };
    const timelineEntries = [firstEntry, secondEntry];

    // Sending follows the newest line straight away: nothing holds end space
    // open any more, so LegendList owns end-following from the first token.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline {...buildProps()} timelineEntries={timelineEntries} />,
      ),
    ).toContain('data-maintain-scroll-at-end="enabled"');

    // Reading history still wins.
    expect(
      renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          liveFollowEnabled={false}
          timelineEntries={timelineEntries}
        />,
      ),
    ).not.toContain('data-maintain-scroll-at-end="enabled"');
  });

  it("renders collapse controls for long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain("Show full message");
    expect(markup).toContain('data-maintain-scroll-at-end="enabled"');
    expect(markup).toContain('data-maintain-scroll-at-end-animated="false"');
    expect(markup).toContain('data-maintain-scroll-at-end-data-change="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-item-layout="true"');
    expect(markup).toContain('data-maintain-scroll-at-end-layout="true"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-fade="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("does not render collapse controls for short user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry("Short prompt.")]}
      />,
    );

    expect(markup).not.toContain("Show full message");
    expect(markup).toContain('data-user-message-collapsible="false"');
    expect(markup).toContain("rounded-2xl bg-message p-3");
  });

  it("preserves arbitrary XML-like tags and comparisons in rendered user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Without reading a file, do you have <global-agent-instructions scope="workspace">',
              'Before <nested data-value="a&b">inside</nested> after',
              "</global-agent-instructions> in your context?",
              "Comparison: 2 < 3 and 5 > 4.",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;global-agent-instructions scope=&quot;workspace&quot;&gt;");
    expect(markup).toContain(
      "Before &lt;nested data-value=&quot;a&amp;b&quot;&gt;inside&lt;/nested&gt; after",
    );
    expect(markup).toContain("&lt;/global-agent-instructions&gt; in your context?");
    expect(markup).toContain("Comparison: 2 &lt; 3 and 5 &gt; 4.");
  });

  it("preserves XML-like source inside user code spans and fences", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              'Inline `<tag attr="x">`',
              "",
              "```xml",
              '<root><child enabled="true" /></root>',
              "```",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain('<code data-inline-code="">&lt;tag attr=&quot;x&quot;&gt;</code>');
    expect(markup).toContain("&lt;root&gt;&lt;child enabled=&quot;true&quot; /&gt;&lt;/root&gt;");
  });

  it("does not render markdown title attributes in user messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip")',
          ),
        ]}
      />,
    );

    expect(markup).toContain('href="https://example.com"');
    expect(markup).toContain('src="https://example.com/image.png"');
    expect(markup).not.toContain('title="link tip"');
    expect(markup).not.toContain('title="image tip"');
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">',
          ),
        ]}
      />,
    );

    expect(markup).toContain("&lt;script&gt;globalThis.__t3Xss = 1&lt;/script&gt;");
    expect(markup).toContain(
      "&lt;img src=&quot;x&quot; onerror=&quot;globalThis.__t3Xss = 2&quot;&gt;",
    );
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toMatch(/<img(?:\s|>)/i);
  });

  it("continues to render sanitized raw HTML in assistant messages", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry("<details><summary>More</summary>Details</details>"),
        ]}
      />,
    );

    expect(markup).toContain('data-markdown-details=""');
    expect(markup).toContain("More");
    expect(markup).not.toContain("&lt;details&gt;");
  });

  it("sanitizes executable HTML while preserving supported assistant markup", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildAssistantTimelineEntry(
            [
              '<details open onclick="globalThis.__t3Xss = 1">',
              "<summary>Safe details</summary>",
              "<script>globalThis.__t3Xss = 2</script>",
              '<img src="x" onerror="globalThis.__t3Xss = 3">',
              '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
              "</details>",
            ].join(""),
          ),
        ]}
      />,
    );

    expect(markup).toContain('data-markdown-details=""');
    expect(markup).toContain("Safe details");
    expect(markup).not.toMatch(/<script(?:\s|>)/i);
    expect(markup).not.toContain("onclick=");
    expect(markup).not.toContain("onerror=");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("globalThis.__t3Xss");
  });

  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              buildLongUserMessageText("yoo what's @terminal-1:1-5 mean"),
              "",
              "<terminal_context>",
              "- Terminal 1 lines 1-5:",
              "  1 | julius@mac effect-http-ws-cli % bun i",
              "  2 | bun install v1.3.9 (cf6cdbbb)",
              "</terminal_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s</p>");
    expect(markup).toContain('<span aria-hidden="true"> </span>');
    expect(markup).toContain("Show full message");
  }, 20_000);

  it("renders chips for standalone element-pick context messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          buildUserTimelineEntry(
            [
              "<element_context>",
              "- <SubmitButton> (Button.tsx:12):",
              "  url: https://example.com/dashboard",
              "  selector: button.submit",
              "  source: /repo/src/Button.tsx:12:5",
              "  html:",
              '  <button class="submit">Save</button>',
              "</element_context>",
            ].join("\n"),
          ),
        ]}
      />,
    );

    expect(markup).toContain("SubmitButton");
    expect(markup).not.toContain("&lt;element_context");
    expect(markup).not.toContain("<element_context");
  });

  it("keeps the copy button for collapsed long user messages", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[buildUserTimelineEntry(buildLongUserMessageText())]}
      />,
    );

    expect(markup).toContain('aria-label="Copy link"');
    expect(markup).toContain('data-user-message-collapsed="true"');
    expect(markup).toContain('data-user-message-footer="true"');
  });

  it("renders context compaction entries in the normal work log", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
  });

  it("summarizes changed files in one line", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("Changed 1 file");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("keeps mixed-success tool groups neutral", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands");
    expect(markup).not.toContain('aria-label="Tool call failed"');
  });

  it("keeps the collapsed summary icon neutral when the group ends in a failure", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
            },
          },
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands");
    expect(markup).toContain("lucide-terminal");
    expect(markup).not.toContain("lucide-x");
    expect(markup).not.toContain("text-destructive");
    // The failure stays discoverable for screen readers.
    expect(markup).toContain("tool call failed");
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Run search",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "failed",
            },
          },
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:29.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:29.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-completed",
            kind: "work",
            createdAt: "2026-03-17T19:12:30.000Z",
            entry: {
              id: "work-completed",
              createdAt: "2026-03-17T19:12:30.000Z",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              toolLifecycleStatus: "completed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Ran 2 commands and received 1 update");
    expect(markup).not.toContain('aria-label="Hidden work includes a failure"');
  });

  it("shows the animated one-line label for a live tool group", () => {
    const turnId = TurnId.make("turn-live");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: "entry-live",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-live",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-live",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Working for");
    expect(markup).toContain("Running pnpm");
    expect(markup).toContain("live-activity-focus");
  });

  it("scopes a live row failure to the tool named by the row", () => {
    const turnId = TurnId.make("turn-live");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-failed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-failed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "failed",
            },
          },
          {
            id: "entry-running",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-running",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-running",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Running pnpm");
    expect(markup).not.toContain("tool call failed");
  });

  it("keeps terminal command copy live while the parent turn is active", () => {
    const turnId = TurnId.make("turn-live");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={{
          turnId,
          state: "running",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: null,
        }}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: "entry-failed",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-failed",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-failed",
              label: "Run lint",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm lint",
              toolLifecycleStatus: "failed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Running pnpm");
    expect(markup).toContain("tool call failed");
  });

  it("renders review comment contexts as structured cards instead of raw tags", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
                "Wadduo",
                "```diff",
                "@@ -0,0 +47,2 @@",
                '+  it("keeps valid zero-usage snapshots", () => {',
                "+    expect(snapshot).not.toBeNull();",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("contextWindow.test.ts");
    expect(markup).toContain("Wadduo");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain(">Review comment<");
    expect(markup).not.toContain("&lt;review_comment");
    expect(markup).not.toContain("&lt;/review_comment&gt;");
  });

  it("renders file review comments as source code instead of diffs", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-source-comment"),
              role: "user",
              text: [
                '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
                "Clarify this.",
                "```md",
                "# Plan",
                "- Step one",
                "```",
                "</review_comment>",
              ].join("\n"),
              turnId: null,
              createdAt: "2026-03-17T19:12:28.000Z",
              updatedAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("plan.md");
    expect(markup).toContain("Clarify this.");
    expect(markup).toContain("# Plan");
    expect(markup).not.toContain('data-testid="file-diff"');
  });

  it("keeps failed lifecycle entries discoverable in mixed activity summaries", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "failed",
              detail: "No files found",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Received 1 update and used 1 tool, tool call failed"');
    // Ordinary tool failures render muted, not red.
    expect(markup).not.toContain("text-destructive");
  });

  it("keeps the red treatment for severe orchestration failures", () => {
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-info",
            kind: "work",
            createdAt: "2026-03-17T19:12:27.000Z",
            entry: {
              id: "work-info",
              createdAt: "2026-03-17T19:12:27.000Z",
              label: "Status updated",
              tone: "info",
            },
          },
          {
            id: "entry-turn-failed",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-turn-failed",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Provider turn start failed",
              tone: "error",
              sourceActivityKind: "provider.turn.start.failed",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("lucide-circle-alert");
    expect(markup).toContain("text-destructive");
  });

  // -------------------------------------------------------------------------
  // Stamped turn records reaching the derivation (AC-05 / AC-07 / AC-09)
  // -------------------------------------------------------------------------

  describe("stamped turn records", () => {
    const STAMPED_TURN_ID = TurnId.make("turn-stamped");

    /**
     * A turn whose activity rows have aged out of the retained window. Only a
     * server stamp can describe its work; anything derived from the two
     * surviving entries would undercount.
     */
    function buildAgedOutTurnEntries() {
      const assistantEntry = buildAssistantTimelineEntry("All done.");
      return [
        {
          id: "aged-work-entry",
          kind: "work" as const,
          createdAt: "2026-03-17T19:12:22.000Z",
          entry: {
            id: "aged-work",
            createdAt: "2026-03-17T19:12:22.000Z",
            turnId: STAMPED_TURN_ID,
            label: "Ran command",
            tone: "tool" as const,
            // Countable on purpose: without it the aged-out assertion below
            // would pass whether or not the retention gate is wired.
            itemType: "command_execution" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          ...assistantEntry,
          message: { ...assistantEntry.message, turnId: STAMPED_TURN_ID },
        },
      ];
    }

    it("renders server-stamped counts for a turn whose activities aged out", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={{
            turnId: STAMPED_TURN_ID,
            state: "completed",
            startedAt: "2026-03-17T19:12:20.000Z",
            completedAt: "2026-03-17T19:12:28.000Z",
          }}
          turns={[
            {
              turnId: STAMPED_TURN_ID,
              state: "completed",
              startedAt: "2026-03-17T19:12:20.000Z",
              completedAt: "2026-03-17T19:12:28.000Z",
              counts: {
                commandCount: 7,
                toolCallCount: 4,
                subagentCount: 2,
                changedFileCount: 3,
              },
            },
          ]}
          oldestRetainedActivityAt="2026-03-17T19:12:21.000Z"
          timelineEntries={buildAgedOutTurnEntries()}
        />,
      );

      // Stamped totals, not the single surviving activity row.
      expect(markup).toContain("7 Commands");
      expect(markup).toContain("4 Tool Calls");
      expect(markup).toContain("2 Subagents");
    });

    it("omits counts for an aged-out turn that carries no stamp", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={{
            turnId: STAMPED_TURN_ID,
            state: "completed",
            startedAt: "2026-03-17T19:12:20.000Z",
            completedAt: "2026-03-17T19:12:28.000Z",
          }}
          // A record without counts: the turn settled before per-turn
          // provenance existed, so nothing was ever stamped for it.
          turns={[
            {
              turnId: STAMPED_TURN_ID,
              state: "completed",
              startedAt: "2026-03-17T19:12:20.000Z",
              completedAt: "2026-03-17T19:12:28.000Z",
            },
          ]}
          // The turn began before the oldest row the thread still retains.
          oldestRetainedActivityAt="2026-03-17T19:12:21.000Z"
          timelineEntries={buildAgedOutTurnEntries()}
        />,
      );

      // Undercounting is worse than silence.
      expect(markup).toContain("Worked for 8.0s");
      expect(markup).not.toContain("Command");
    });

    it("styles a turn as interrupted from its own record, not the latest turn", () => {
      const olderTurnId = TurnId.make("turn-older-interrupted");
      const assistantEntry = buildAssistantTimelineEntry("Stopped there.");
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={{
            turnId: TurnId.make("turn-newer"),
            state: "completed",
            startedAt: "2026-03-17T19:13:20.000Z",
            completedAt: "2026-03-17T19:13:28.000Z",
          }}
          turns={[
            {
              turnId: olderTurnId,
              state: "interrupted",
              startedAt: "2026-03-17T19:12:20.000Z",
              completedAt: "2026-03-17T19:12:28.000Z",
            },
          ]}
          timelineEntries={[
            {
              id: "older-work-entry",
              kind: "work",
              createdAt: "2026-03-17T19:12:22.000Z",
              entry: {
                id: "older-work",
                createdAt: "2026-03-17T19:12:22.000Z",
                turnId: olderTurnId,
                label: "Ran command",
                tone: "tool",
                toolLifecycleStatus: "completed",
              },
            },
            {
              ...assistantEntry,
              message: {
                ...assistantEntry.message,
                turnId: olderTurnId,
                updatedAt: "2026-03-17T19:12:28.000Z",
              },
            },
          ]}
        />,
      );

      expect(markup).toContain("You stopped after");
    });
  });

  // -------------------------------------------------------------------------
  // AC-07 — subfold labels inside an expanded turn fold
  // -------------------------------------------------------------------------

  describe("turn fold subfolds", () => {
    it("renders subfold labels once the turn fold is expanded", async () => {
      const { deriveMessagesTimelineRows } = await import("./MessagesTimeline.logic");
      const turnId = TurnId.make("turn-subfolds");
      const assistantEntry = buildAssistantTimelineEntry("Finished.");

      const timelineEntries = [
        {
          id: "sub-work-1",
          kind: "work" as const,
          createdAt: "2026-03-17T19:12:21.000Z",
          entry: {
            id: "sub-work-entry-1",
            createdAt: "2026-03-17T19:12:21.000Z",
            turnId,
            label: "Ran command",
            tone: "tool" as const,
            itemType: "command_execution" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "sub-assistant-mid",
          kind: "message" as const,
          createdAt: "2026-03-17T19:12:22.000Z",
          message: {
            ...assistantEntry.message,
            id: MessageId.make("message-mid"),
            turnId,
            text: "Thinking out loud.",
          },
        },
        {
          id: "sub-work-2",
          kind: "work" as const,
          createdAt: "2026-03-17T19:12:23.000Z",
          entry: {
            id: "sub-work-entry-2",
            createdAt: "2026-03-17T19:12:23.000Z",
            turnId,
            label: "Read file",
            tone: "tool" as const,
            itemType: "file_change" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          ...assistantEntry,
          message: {
            ...assistantEntry.message,
            turnId,
            updatedAt: "2026-03-17T19:12:28.000Z",
          },
        },
      ];

      const rows = deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn: {
          turnId,
          state: "completed",
          startedAt: "2026-03-17T19:12:20.000Z",
          completedAt: "2026-03-17T19:12:28.000Z",
        },
        expandedTurnIds: new Set([turnId]),
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

      const fold = rows.find((row) => row.kind === "turn-fold");
      // Guard the fixture: without subfold labels the render assertion below
      // would pass vacuously.
      expect(fold?.kind === "turn-fold" && fold.subfoldLabels.length).toBeGreaterThan(0);
      const expectedLabels =
        fold?.kind === "turn-fold" ? fold.subfoldLabels : ([] as ReadonlyArray<string>);

      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={{
            turnId,
            state: "completed",
            startedAt: "2026-03-17T19:12:20.000Z",
            completedAt: "2026-03-17T19:12:28.000Z",
          }}
          initialExpandedTurnIds={new Set([turnId])}
          timelineEntries={timelineEntries}
        />,
      );

      for (const label of expectedLabels) {
        expect(markup).toContain(label);
      }
      expect(markup).toContain("data-timeline-subfold");
    });

    it("hides subfold labels while the turn fold is collapsed", () => {
      const turnId = TurnId.make("turn-subfolds-collapsed");
      const assistantEntry = buildAssistantTimelineEntry("Finished.");
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={{
            turnId,
            state: "completed",
            startedAt: "2026-03-17T19:12:20.000Z",
            completedAt: "2026-03-17T19:12:28.000Z",
          }}
          timelineEntries={[
            {
              id: "collapsed-work-1",
              kind: "work",
              createdAt: "2026-03-17T19:12:21.000Z",
              entry: {
                id: "collapsed-work-entry-1",
                createdAt: "2026-03-17T19:12:21.000Z",
                turnId,
                label: "Ran command",
                tone: "tool",
                itemType: "command_execution",
                toolLifecycleStatus: "completed",
              },
            },
            {
              ...assistantEntry,
              message: {
                ...assistantEntry.message,
                turnId,
                updatedAt: "2026-03-17T19:12:28.000Z",
              },
            },
          ]}
        />,
      );

      expect(markup).not.toContain("data-timeline-subfold");
    });
  });

  // -------------------------------------------------------------------------
  // AC-10 — three-column tool rows
  // -------------------------------------------------------------------------

  describe("tool row columns", () => {
    it("renders the tool name and its description as separate columns", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          initialExpandedWorkGroupIds={new Set(["work-group:entry-shell"])}
          timelineEntries={[
            {
              id: "entry-shell",
              kind: "work",
              createdAt: "2026-03-17T19:12:28.000Z",
              entry: {
                id: "work-shell",
                createdAt: "2026-03-17T19:12:28.000Z",
                startedAt: "2026-03-17T19:12:27.900Z",
                label: "Shell command",
                toolTitle: "Shell command",
                tone: "tool",
                itemType: "command_execution",
                toolLifecycleStatus: "completed",
                command: "git status --short && git log -5",
              },
            },
          ]}
        />,
      );

      // The heading must survive alongside the description rather than being
      // replaced by it.
      expect(markup).toContain("Shell command");
      expect(markup).toContain("git status --short &amp;&amp; git log -5");
      expect(markup).toContain("data-tool-row-name");
      expect(markup).toContain("data-tool-row-description");
    });

    it("right-aligns a settled tool duration in its own column", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          initialExpandedWorkGroupIds={new Set(["work-group:entry-timed"])}
          timelineEntries={[
            {
              id: "entry-timed",
              kind: "work",
              createdAt: "2026-03-17T19:12:30.000Z",
              entry: {
                id: "work-timed",
                createdAt: "2026-03-17T19:12:30.000Z",
                startedAt: "2026-03-17T19:12:28.000Z",
                label: "Read file",
                toolTitle: "Read file",
                tone: "tool",
                itemType: "file_change",
                toolLifecycleStatus: "completed",
                detail: "/tmp/opencode/pkg/package.json",
              },
            },
          ]}
        />,
      );

      const durationMatch = markup.match(
        /<span class="([^"]*)" data-tool-row-duration="[^"]*">([^<]*)</,
      );
      expect(durationMatch).not.toBeNull();
      // Its own column: never shrinks, so the description truncates first.
      expect(durationMatch?.[1]).toContain("shrink-0");
      expect(durationMatch?.[2]).toBe("2.0s");
    });

    it("keeps an empty duration column for a tool row without a duration", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          initialExpandedWorkGroupIds={new Set(["work-group:entry-untimed"])}
          timelineEntries={[
            {
              id: "entry-untimed",
              kind: "work",
              createdAt: "2026-03-17T19:12:30.000Z",
              entry: {
                id: "work-untimed",
                createdAt: "2026-03-17T19:12:30.000Z",
                label: "Read file",
                toolTitle: "Read file",
                tone: "tool",
                itemType: "file_change",
                toolLifecycleStatus: "completed",
                detail: "/tmp/opencode/pkg/package.json",
              },
            },
          ]}
        />,
      );

      // The column stays so the right edge remains a column.
      const durationMatch = markup.match(
        /<span class="([^"]*)" data-tool-row-duration="[^"]*">([^<]*)</,
      );
      expect(markup).toContain("data-tool-row-duration");
      expect(durationMatch?.[1]).toContain("shrink-0");
      expect(durationMatch?.[2] ?? "").toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // AC-08 — terminal assistant turn footer
  // -------------------------------------------------------------------------

  describe("assistant turn footer", () => {
    const FOOTER_TURN_ID = TurnId.make("turn-footer");

    function buildTerminalAssistantEntries() {
      const assistantEntry = buildAssistantTimelineEntry("Here is the answer.");
      return [
        {
          ...assistantEntry,
          message: {
            ...assistantEntry.message,
            turnId: FOOTER_TURN_ID,
            updatedAt: "2026-03-17T19:13:40.000Z",
          },
        },
      ];
    }

    const settledLatestTurn = {
      turnId: FOOTER_TURN_ID,
      state: "completed" as const,
      startedAt: "2026-03-17T19:12:28.000Z",
      completedAt: "2026-03-17T19:13:40.000Z",
    };

    it("renders model, effort, duration and timestamp for a stamped turn", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={settledLatestTurn}
          turns={[
            {
              ...settledLatestTurn,
              assistantMessageId: MessageId.make("message-1"),
              model: "Claude Opus 4.5",
              effort: "high",
            },
          ]}
          timelineEntries={buildTerminalAssistantEntries()}
        />,
      );

      expect(markup).toContain("Claude Opus 4.5");
      expect(markup).toContain("high");
      expect(markup).toContain("1m 12s");
    });

    it("omits effort entirely when the turn records none", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={settledLatestTurn}
          turns={[
            {
              ...settledLatestTurn,
              assistantMessageId: MessageId.make("message-1"),
              model: "GPT-5 Codex",
            },
          ]}
          timelineEntries={buildTerminalAssistantEntries()}
        />,
      );

      expect(markup).toContain("GPT-5 Codex");
      expect(markup).not.toContain("data-turn-footer-effort");
    });

    it("never renders the literal effort sentinel 'default'", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={settledLatestTurn}
          turns={[
            {
              ...settledLatestTurn,
              assistantMessageId: MessageId.make("message-1"),
              model: "GPT-5 Codex",
              effort: "default",
            },
          ]}
          timelineEntries={buildTerminalAssistantEntries()}
        />,
      );

      const footerMatch = markup.match(/data-turn-footer-effort[^>]*>([^<]*)</);
      expect(footerMatch).toBeNull();
      expect(markup).not.toContain(">default<");
    });

    it("falls back to the plain timestamp footer for a pre-stamp turn", () => {
      const markup = renderToStaticMarkup(
        <MessagesTimeline
          {...buildProps()}
          latestTurn={settledLatestTurn}
          turns={[]}
          timelineEntries={buildTerminalAssistantEntries()}
        />,
      );

      expect(markup).not.toContain("data-turn-footer-model");
      expect(markup).not.toContain("data-turn-footer-duration");
      // Today's footer still renders its timestamp.
      expect(markup).toContain("group-hover/assistant:opacity-100");
    });
  });
});

describe("working status legibility", () => {
  const runningTurn = (turnId: TurnId) => ({
    turnId,
    state: "running" as const,
    startedAt: MESSAGE_CREATED_AT,
    completedAt: null,
  });

  it("names the running tool rather than a generic Thinking label", () => {
    const turnId = TurnId.make("turn-status");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnStartedAt={MESSAGE_CREATED_AT}
        latestTurn={runningTurn(turnId)}
        runningTurnId={turnId}
        timelineEntries={[
          {
            id: "entry-mcp",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-mcp",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-mcp",
              label: "Query",
              tone: "info",
              itemType: "mcp_tool_call",
              toolLifecycleStatus: "inProgress",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Running MCP tool");
    expect(markup).not.toContain(">Thinking<");
  });

  it("renders no live indicator once the turn has settled", () => {
    const turnId = TurnId.make("turn-settled");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        isWorking={false}
        activeTurnStartedAt={null}
        latestTurn={{
          turnId,
          state: "completed",
          startedAt: MESSAGE_CREATED_AT,
          completedAt: MESSAGE_CREATED_AT,
        }}
        runningTurnId={null}
        timelineEntries={[
          {
            id: "entry-settled",
            kind: "work",
            createdAt: MESSAGE_CREATED_AT,
            entry: {
              id: "work-settled",
              createdAt: MESSAGE_CREATED_AT,
              turnId,
              toolCallId: "call-settled",
              label: "Run tests",
              tone: "tool",
              itemType: "command_execution",
              command: "pnpm test",
              // A settled part carrying no lifecycle status and no completion
              // timestamp: live-ness must come from the turn phase, not from the
              // absent timestamp.
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain("live-activity-focus");
    expect(markup).not.toContain("Working for");
  });
});
