import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  collectProjectThreadRefs,
  removeProjectPaneStateAfterSuccessfulDeletion,
  removeThreadPaneState,
  removeThreadPaneStateAfterSuccessfulDeletion,
} from "./paneStateCleanup";
import { useRightPanelStore } from "./rightPanelStore";
import { useSecondaryPaneStore } from "./secondaryPaneStore";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const threadId = ThreadId.make("thread-1");
const refA = scopeThreadRef(environmentA, threadId);
const refB = scopeThreadRef(environmentB, threadId);
const projectA = scopeProjectRef(environmentA, ProjectId.make("project-1"));
const projectB = scopeProjectRef(environmentB, ProjectId.make("project-1"));

const success = { _tag: "Success" } as const;
const failure = { _tag: "Failure" } as const;

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

  it("clears pane state after a successful normal deletion", () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");

    expect(removeThreadPaneStateAfterSuccessfulDeletion(success, refA)).toBe(true);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useSecondaryPaneStore.getState().byThreadKey).toEqual({});
  });

  it("clears pane state after a successful archived-list deletion", () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "archived.ts");

    expect(removeThreadPaneStateAfterSuccessfulDeletion(success, refA)).toBe(true);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useSecondaryPaneStore.getState().byThreadKey).toEqual({});
  });

  it("retains pane state when deletion fails", () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "failed.ts");

    expect(removeThreadPaneStateAfterSuccessfulDeletion(failure, refA)).toBe(false);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(1);
  });

  it("retains pane state for ordinary archive operations", () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "archived.ts");

    // Archive does not cross the deletion cleanup boundary.
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(1);
  });

  it("clears only successfully deleted refs in a bulk deletion", () => {
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refB, "files");
    useSecondaryPaneStore.getState().openFile(refA, "deleted.ts");
    useSecondaryPaneStore.getState().openFile(refB, "retained.ts");

    for (const ref of [refA]) {
      removeThreadPaneStateAfterSuccessfulDeletion(success, ref);
    }

    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)[0]).toContain(
      String(environmentB),
    );
  });

  it("captures active and archived project refs and clears them only after success", () => {
    const archivedRef = scopeThreadRef(environmentA, ThreadId.make("archived-thread"));
    const activeRef = scopeThreadRef(environmentA, ThreadId.make("active-thread"));
    useRightPanelStore.getState().open(activeRef, "files");
    useRightPanelStore.getState().open(archivedRef, "files");
    useRightPanelStore.getState().open(refB, "files");
    useSecondaryPaneStore.getState().openFile(activeRef, "active.ts");
    useSecondaryPaneStore.getState().openFile(archivedRef, "archived.ts");
    useSecondaryPaneStore.getState().openFile(refB, "other-environment.ts");

    const projectThreadRefs = collectProjectThreadRefs({
      projectRefs: [projectA],
      activeThreads: [
        { environmentId: environmentA, id: activeRef.threadId, projectId: projectA.projectId },
        { environmentId: environmentB, id: refB.threadId, projectId: projectB.projectId },
      ],
      archivedSnapshots: [
        {
          environmentId: environmentA,
          snapshot: {
            threads: [
              {
                id: archivedRef.threadId,
                projectId: projectA.projectId,
              },
            ],
          },
        },
      ],
    });
    expect(projectThreadRefs).toEqual(expect.arrayContaining([activeRef, archivedRef]));
    expect(projectThreadRefs).not.toEqual(expect.arrayContaining([refB]));

    expect(removeProjectPaneStateAfterSuccessfulDeletion(failure, projectThreadRefs)).toBe(false);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(3);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(3);

    expect(removeProjectPaneStateAfterSuccessfulDeletion(success, projectThreadRefs)).toBe(true);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toEqual([
      expect.stringContaining(String(environmentB)),
    ]);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toEqual([
      expect.stringContaining(String(environmentB)),
    ]);
  });
});
