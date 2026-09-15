import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { removeThreadPaneState } from "./paneStateCleanup";
import { useRightPanelStore } from "./rightPanelStore";
import { useSecondaryPaneStore } from "./secondaryPaneStore";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const threadId = ThreadId.make("thread-1");
const refA = scopeThreadRef(environmentA, threadId);
const refB = scopeThreadRef(environmentB, threadId);

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    userActionRevisionByThreadKey: {},
    legacyTerminalIdsByThreadKey: {},
  });
  useSecondaryPaneStore.setState({ byThreadKey: {} });
});

describe("removeThreadPaneState", () => {
  it("clears both pane stores and is idempotent", () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");

    removeThreadPaneState(refA);
    removeThreadPaneState(refA);

    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useSecondaryPaneStore.getState().byThreadKey).toEqual({});
  });

  it("does not clear a thread with the same id in another environment", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refB, "files");
    useSecondaryPaneStore.getState().openFile(refA, "src/a.ts");
    useSecondaryPaneStore.getState().openFile(refB, "src/b.ts");

    removeThreadPaneState(refA);

    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)[0]).toContain(
      String(environmentB),
    );
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)[0]).toContain(
      String(environmentB),
    );
  });
});
