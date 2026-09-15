import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { useRightPanelStore } from "./rightPanelStore";
import { useSecondaryPaneStore } from "./secondaryPaneStore";

/** Remove all persisted pane presentation state for one environment-scoped thread. */
export function removeThreadPaneState(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().removeThread(threadRef);
  useSecondaryPaneStore.getState().removeThread(threadRef);
}

type MutationResult =
  | { readonly _tag: "Success" }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> };

/** Run a thread lifecycle mutation and clear panes only for an actual deletion success. */
export async function executeThreadLifecycleMutation<T extends MutationResult>(
  kind: "delete" | "archive",
  mutate: () => Promise<T>,
  threadRef: ScopedThreadRef,
): Promise<T> {
  const result = await mutate();
  if (kind === "delete" && result._tag === "Success") {
    removeThreadPaneState(threadRef);
  }
  return result;
}

export interface ProjectThreadRefCaptureInput {
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly activeThreads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "id" | "projectId"> & {
      readonly environmentId: EnvironmentId;
    }
  >;
  readonly archivedSnapshots: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: {
      readonly threads: ReadonlyArray<Pick<OrchestrationThreadShell, "id" | "projectId">>;
    };
  }>;
}

/** Capture known active and authoritative archived threads for a project before mutation. */
export function collectProjectThreadRefs(
  input: ProjectThreadRefCaptureInput,
): ReadonlyArray<ScopedThreadRef> {
  const projectIdsByEnvironment = new Map<EnvironmentId, Set<string>>();
  for (const projectRef of input.projectRefs) {
    const projectIds = projectIdsByEnvironment.get(projectRef.environmentId) ?? new Set<string>();
    projectIds.add(projectRef.projectId);
    projectIdsByEnvironment.set(projectRef.environmentId, projectIds);
  }

  const refsByKey = new Map<string, ScopedThreadRef>();
  for (const thread of input.activeThreads) {
    const projectIds = projectIdsByEnvironment.get(thread.environmentId);
    if (!projectIds?.has(thread.projectId)) continue;
    const threadRef = scopeThreadRef(thread.environmentId, thread.id);
    refsByKey.set(scopedThreadKey(threadRef), threadRef);
  }
  for (const entry of input.archivedSnapshots) {
    const projectIds = projectIdsByEnvironment.get(entry.environmentId);
    if (!projectIds) continue;
    for (const thread of entry.snapshot.threads) {
      if (!projectIds.has(String(thread.projectId))) continue;
      const threadRef = scopeThreadRef(entry.environmentId, thread.id);
      refsByKey.set(scopedThreadKey(threadRef), threadRef);
    }
  }
  return [...refsByKey.values()];
}

type ArchivedSnapshotResult =
  | {
      readonly _tag: "Success";
      readonly value: {
        readonly threads: ReadonlyArray<Pick<OrchestrationThreadShell, "id" | "projectId">>;
      };
    }
  | { readonly _tag: "Failure"; readonly cause: unknown };

/** Read archived refs before project deletion, then clear active and archived panes on success. */
export async function deleteProjectWithPaneCleanup<
  TMutation extends MutationResult,
  TArchivedSnapshot extends ArchivedSnapshotResult,
>(input: {
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly activeThreads: ProjectThreadRefCaptureInput["activeThreads"];
  readonly archivedEnvironmentId: EnvironmentId;
  readonly readArchivedSnapshot: () => Promise<TArchivedSnapshot>;
  readonly deleteProject: () => Promise<TMutation>;
  readonly onCapturedThreadRefs?: (threadRefs: ReadonlyArray<ScopedThreadRef>) => void;
}): Promise<TMutation | TArchivedSnapshot> {
  const archivedResult = await input.readArchivedSnapshot();
  if (archivedResult._tag === "Failure") {
    return archivedResult;
  }
  const threadRefs = collectProjectThreadRefs({
    projectRefs: input.projectRefs,
    activeThreads: input.activeThreads,
    archivedSnapshots: [
      {
        environmentId: input.archivedEnvironmentId,
        snapshot: archivedResult.value,
      },
    ],
  });
  input.onCapturedThreadRefs?.(threadRefs);
  const result = await input.deleteProject();
  if (result._tag === "Success") {
    for (const threadRef of threadRefs) {
      removeThreadPaneState(threadRef);
    }
  }
  return result;
}
