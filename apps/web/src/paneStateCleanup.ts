import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationThreadShell,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";
import { useSecondaryPaneStore } from "./secondaryPaneStore";

/** Remove all persisted pane presentation state for one environment-scoped thread. */
export function removeThreadPaneState(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().removeThread(threadRef);
  useSecondaryPaneStore.getState().removeThread(threadRef);
}

type DeletionResult = { readonly _tag: "Success" | "Failure" };

/** Clear a thread's panes only after its authoritative deletion command succeeds. */
export function removeThreadPaneStateAfterSuccessfulDeletion(
  result: DeletionResult,
  threadRef: ScopedThreadRef,
): boolean {
  if (result._tag !== "Success") return false;
  removeThreadPaneState(threadRef);
  return true;
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

/** Clear every captured project thread only after the project deletion succeeds. */
export function removeProjectPaneStateAfterSuccessfulDeletion(
  result: DeletionResult,
  threadRefs: ReadonlyArray<ScopedThreadRef>,
): boolean {
  if (result._tag !== "Success") return false;
  for (const threadRef of threadRefs) {
    removeThreadPaneState(threadRef);
  }
  return true;
}
