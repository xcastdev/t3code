/* @vitest-environment happy-dom */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadSecondaryPaneState, useSecondaryPaneStore } from "~/secondaryPaneStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (input: { item: { id: string } }) => ReactNode;
  }) => (
    <>
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
    </>
  ),
}));
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", () => ({ FileDiff: () => null }));

import { MessagesTimeline } from "./MessagesTimeline";

const environmentId = EnvironmentId.make("timeline-interaction");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));

describe("sent message context routing", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    useSecondaryPaneStore.setState({ byThreadKey: {} });
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("opens a workspace mention in the secondary pane and keeps file attachments on their callback", async () => {
    const openAttachment = vi.fn();
    await act(async () =>
      root.render(
        <MessagesTimeline
          isWorking={false}
          activeTurnStartedAt={null}
          listRef={createRef<LegendListRef | null>()}
          timelineEntries={[
            {
              id: "message-entry",
              kind: "message",
              createdAt: "2026-09-15T12:00:00.000Z",
              message: {
                id: MessageId.make("message-1"),
                role: "user",
                text: "Inspect [src/one.ts](t3-context://v1/mention/mention-1) and attachment.",
                attachments: [
                  {
                    type: "file",
                    id: "attachment-1",
                    name: "notes.txt",
                    mimeType: "text/plain",
                    sizeBytes: 4,
                  },
                ],
                context: {
                  version: 1,
                  records: [
                    {
                      version: 1,
                      contextId: "mention-1" as never,
                      kind: "mention",
                      label: "src/one.ts",
                      path: "src/one.ts",
                    },
                  ],
                },
                turnId: null,
                createdAt: "2026-09-15T12:00:00.000Z",
                updatedAt: "2026-09-15T12:00:00.000Z",
                streaming: false,
              },
            },
          ]}
          latestTurn={null}
          runningTurnId={null}
          turnDiffSummaries={[]}
          routeThreadKey="timeline-interaction:thread-1"
          onOpenTurnDiff={() => undefined}
          supportsConversationRollback={false}
          onRevertToTurnCount={() => undefined}
          isRevertingCheckpoint={false}
          onImageExpand={() => undefined}
          onFileOpen={openAttachment}
          activeThreadEnvironmentId={environmentId}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot="/repo"
          anchorMessageId={null}
          onAnchorReady={() => undefined}
          contentInsetEndAdjustment={0}
          liveFollowEnabled
          onIsAtEndChange={() => undefined}
          onManualNavigation={() => undefined}
        />,
      ),
    );

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Preview src/one.ts"]')!.click(),
    );
    expect(
      selectThreadSecondaryPaneState(useSecondaryPaneStore.getState().byThreadKey, threadRef)
        .activeSurfaceId,
    ).toBe("file:src/one.ts");
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);

    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Preview notes.txt"]')!.click(),
    );
    expect(openAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: "attachment-1", name: "notes.txt" }),
    );
  });
});
