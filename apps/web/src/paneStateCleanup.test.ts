import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { deleteSelectedThreadEntries } from "./components/Sidebar.logic";
import {
  deleteProjectWithPaneCleanup,
  executeThreadLifecycleMutation,
  removeThreadPaneState,
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
const failure = AsyncResult.failure(Cause.fail(new Error("Delete failed")));

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

  it("clears pane state after a successful normal deletion boundary", async () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "src/index.ts");

    await executeThreadLifecycleMutation("delete", async () => success, refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useSecondaryPaneStore.getState().byThreadKey).toEqual({});
  });

  it("clears pane state after a successful archived-list deletion boundary", async () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "archived.ts");

    await executeThreadLifecycleMutation("delete", async () => success, refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    expect(useSecondaryPaneStore.getState().byThreadKey).toEqual({});
  });

  it("retains pane state when the deletion boundary fails", async () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "failed.ts");

    await executeThreadLifecycleMutation("delete", async () => failure, refA);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(1);
  });

  it("retains pane state for the archive mutation boundary", async () => {
    useRightPanelStore.getState().open(refA, "files");
    useSecondaryPaneStore.getState().openFile(refA, "archived.ts");

    await executeThreadLifecycleMutation("archive", async () => success, refA);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(1);
  });

  it("clears only successful refs in the production bulk deletion boundary", async () => {
    const threadAKey = "environment-a:thread-1";
    const threadBKey = "environment-b:thread-1";
    const mutationSuccess = AsyncResult.success(undefined);
    const mutationFailure = AsyncResult.failure(Cause.fail(new Error("Delete failed")));
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refB, "files");
    useSecondaryPaneStore.getState().openFile(refA, "deleted.ts");
    useSecondaryPaneStore.getState().openFile(refB, "retained.ts");

    const outcome = await deleteSelectedThreadEntries({
      entries: [{ threadKey: threadAKey }, { threadKey: threadBKey }],
      delete: async ({ threadKey }) =>
        executeThreadLifecycleMutation(
          "delete",
          async () => (threadKey === threadAKey ? mutationSuccess : mutationFailure),
          threadKey === threadAKey ? refA : refB,
        ),
    });

    expect(outcome.deletedThreadKeys).toEqual(new Set([threadAKey]));
    expect(outcome.firstFailure).toBe(mutationFailure);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(1);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)[0]).toContain(
      String(environmentB),
    );
  });

  it("waits for an authoritative archived snapshot before project deletion", async () => {
    const archivedRef = scopeThreadRef(environmentA, ThreadId.make("archived-thread"));
    const activeRef = scopeThreadRef(environmentA, ThreadId.make("active-thread"));
    const otherProjectRef = scopeThreadRef(environmentA, ThreadId.make("other-project-thread"));
    const otherProject = scopeProjectRef(environmentA, ProjectId.make("project-other"));
    useRightPanelStore.getState().open(activeRef, "files");
    useRightPanelStore.getState().open(archivedRef, "files");
    useRightPanelStore.getState().open(otherProjectRef, "files");
    useRightPanelStore.getState().open(refB, "files");
    useSecondaryPaneStore.getState().openFile(activeRef, "active.ts");
    useSecondaryPaneStore.getState().openFile(archivedRef, "archived.ts");
    useSecondaryPaneStore.getState().openFile(otherProjectRef, "other-project.ts");
    useSecondaryPaneStore.getState().openFile(refB, "other-environment.ts");

    const sequence: string[] = [];
    type SnapshotSuccess = {
      readonly _tag: "Success";
      readonly value: {
        readonly threads: ReadonlyArray<{ readonly id: ThreadId; readonly projectId: ProjectId }>;
      };
    };
    let resolveSnapshot!: (result: SnapshotSuccess) => void;
    const snapshotResult = new Promise<SnapshotSuccess>((resolve) => {
      resolveSnapshot = resolve;
    });
    let capturedRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }> = [];
    const deletion = deleteProjectWithPaneCleanup({
      projectRefs: [projectA],
      activeThreads: [
        { environmentId: environmentA, id: activeRef.threadId, projectId: projectA.projectId },
        {
          environmentId: environmentA,
          id: otherProjectRef.threadId,
          projectId: otherProject.projectId,
        },
        { environmentId: environmentB, id: refB.threadId, projectId: projectB.projectId },
      ],
      archivedEnvironmentId: environmentA,
      readArchivedSnapshot: async () => {
        sequence.push("snapshot");
        return snapshotResult;
      },
      onCapturedThreadRefs: (refs) => {
        capturedRefs = refs;
      },
      deleteProject: async () => {
        sequence.push("delete");
        return success;
      },
    });
    expect(sequence).toEqual(["snapshot"]);
    resolveSnapshot({
      _tag: "Success",
      value: {
        threads: [{ id: archivedRef.threadId, projectId: projectA.projectId }],
      },
    });
    await deletion;
    expect(sequence).toEqual(["snapshot", "delete"]);
    expect(capturedRefs).toEqual(expect.arrayContaining([activeRef, archivedRef]));
    const expectedSurvivorKeys = new Set([scopedThreadKey(otherProjectRef), scopedThreadKey(refB)]);
    const rightPanelState = useRightPanelStore.getState().byThreadKey;
    const secondaryPaneState = useSecondaryPaneStore.getState().byThreadKey;
    expect(new Set(Object.keys(rightPanelState))).toEqual(expectedSurvivorKeys);
    expect(new Set(Object.keys(secondaryPaneState))).toEqual(expectedSurvivorKeys);
    for (const deletedRef of [activeRef, archivedRef]) {
      expect(rightPanelState).not.toHaveProperty(scopedThreadKey(deletedRef));
      expect(secondaryPaneState).not.toHaveProperty(scopedThreadKey(deletedRef));
    }
  });

  it("retains project pane state and skips mutation when the archived snapshot fails", async () => {
    const archivedRef = scopeThreadRef(environmentA, ThreadId.make("archived-thread"));
    const activeRef = scopeThreadRef(environmentA, ThreadId.make("active-thread"));
    useRightPanelStore.getState().open(activeRef, "files");
    useRightPanelStore.getState().open(archivedRef, "files");
    useSecondaryPaneStore.getState().openFile(activeRef, "active.ts");
    useSecondaryPaneStore.getState().openFile(archivedRef, "archived.ts");
    let deleteCalled = false;
    const snapshotFailure = AsyncResult.failure(Cause.fail(new Error("Archived read failed")));

    const result = await deleteProjectWithPaneCleanup({
      projectRefs: [projectA],
      activeThreads: [
        { environmentId: environmentA, id: activeRef.threadId, projectId: projectA.projectId },
      ],
      archivedEnvironmentId: environmentA,
      readArchivedSnapshot: async () => snapshotFailure,
      deleteProject: async () => {
        deleteCalled = true;
        return success;
      },
    });

    expect(result).toBe(snapshotFailure);
    expect(deleteCalled).toBe(false);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(2);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(2);
  });

  it("retains captured project refs when project mutation fails", async () => {
    const archivedRef = scopeThreadRef(environmentA, ThreadId.make("archived-thread"));
    const activeRef = scopeThreadRef(environmentA, ThreadId.make("active-thread"));
    useRightPanelStore.getState().open(activeRef, "files");
    useRightPanelStore.getState().open(archivedRef, "files");
    useSecondaryPaneStore.getState().openFile(activeRef, "active.ts");
    useSecondaryPaneStore.getState().openFile(archivedRef, "archived.ts");
    const mutationFailure = AsyncResult.failure(Cause.fail(new Error("Project delete failed")));

    const result = await deleteProjectWithPaneCleanup({
      projectRefs: [projectA],
      activeThreads: [
        { environmentId: environmentA, id: activeRef.threadId, projectId: projectA.projectId },
      ],
      archivedEnvironmentId: environmentA,
      readArchivedSnapshot: async () =>
        AsyncResult.success({
          threads: [{ id: archivedRef.threadId, projectId: projectA.projectId }],
        }),
      deleteProject: async () => mutationFailure,
    });

    expect(result).toBe(mutationFailure);
    expect(Object.keys(useRightPanelStore.getState().byThreadKey)).toHaveLength(2);
    expect(Object.keys(useSecondaryPaneStore.getState().byThreadKey)).toHaveLength(2);
  });
});
