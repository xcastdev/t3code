/**
 * Thread-scoped state for the editor/file-viewer pane in the workspace.
 *
 * The right sidebar owns project tools such as the Project Explorer. Files
 * opened from those tools live here instead, which keeps editor tabs
 * independent from right-sidebar surface tabs.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { GitRepositoryComparisonDescriptor, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type SecondaryPanePresentation = "expanded" | "minimized" | "maximized";

export type SecondaryPaneFileSurface = {
  id: `file:${string}`;
  kind: "file";
  relativePath: string;
  revealLine: number | null;
  revealRequestId: number;
};

export type SecondaryPaneDiffSurface = {
  id: `diff:${string}`;
  kind: "diff";
  environmentId: string;
  repositoryRoot: string;
  comparison: "working-tree" | "index" | "branch" | "commit" | "pull-request" | "turn";
  oldPath: string | null;
  newPath: string | null;
  baseRef?: string | null;
  headRef?: string | null;
  indexTree?: string;
  commitSha?: string;
  /** Working-tree snapshot token used to refresh live tabs without collisions. */
  snapshotId?: string | null;
  /**
   * The complete comparison identity.  Older persisted tabs may lack this;
   * new tabs are always opened through `openRepositoryComparison` below.
   */
  descriptor?: GitRepositoryComparisonDescriptor;
};

export type SecondaryPaneSurface = SecondaryPaneFileSurface | SecondaryPaneDiffSurface;

export type ThreadSecondaryPaneState = {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: SecondaryPaneSurface[];
  presentation?: SecondaryPanePresentation;
  presentationBeforeMinimize?: "expanded" | "maximized";
};

interface SecondaryPaneStoreState {
  byThreadKey: Record<string, ThreadSecondaryPaneState>;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  openDiff: (
    ref: ScopedThreadRef,
    input: Omit<SecondaryPaneDiffSurface, "id" | "kind" | "environmentId">,
  ) => void;
  resolveDiffDescriptor: (
    ref: ScopedThreadRef,
    surfaceId: string,
    descriptor: GitRepositoryComparisonDescriptor,
  ) => void;
  setPresentation: (ref: ScopedThreadRef, presentation: SecondaryPanePresentation) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  reconcileWorkspace: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const EMPTY_SECONDARY_PANE_STATE: ThreadSecondaryPaneState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const SECONDARY_PANE_STORAGE_KEY = "t3code:secondary-pane-state:v1";
const SECONDARY_PANE_STORAGE_VERSION = 1;

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

function fileSurface(
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): SecondaryPaneSurface {
  return {
    id: `file:${relativePath}`,
    kind: "file",
    relativePath,
    revealLine,
    revealRequestId,
  };
}

function diffSurfaceId(input: Omit<SecondaryPaneDiffSurface, "id" | "kind">): `diff:${string}` {
  // A surface id is a tab key, not the result of resolving its revisions.
  // Keeping immutable object ids out of it prevents the first compare response
  // from unmounting the pane and lets reopening the same comparison activate
  // the existing tab.
  const descriptor = input.descriptor;
  const identity = JSON.stringify([
    input.environmentId,
    input.repositoryRoot,
    input.comparison,
    input.oldPath,
    input.newPath,
    input.baseRef ?? null,
    input.headRef ?? null,
    input.commitSha ?? null,
    input.indexTree ?? null,
    input.snapshotId ?? null,
    descriptor
      ? [
          descriptor.version,
          descriptor.kind,
          descriptor.oldPath,
          descriptor.newPath,
          descriptor.liveSnapshotId,
          descriptor.turnId,
          descriptor.checkpointId,
          descriptor.pullRequestId,
          descriptor.mergeParent,
          // Immutable object identities distinguish two snapshots of the same
          // moving ref. Resolution deliberately keeps the existing surface id
          // so the mounted reader is retained, but a later explicit snapshot
          // must open beside it rather than silently replace it.
          descriptor.baseRevision,
          descriptor.headRevision,
        ]
      : null,
  ]);
  return `diff:${encodeURIComponent(identity)}`;
}

function diffSurface(
  input: Omit<SecondaryPaneDiffSurface, "id" | "kind">,
): SecondaryPaneDiffSurface {
  return { ...input, id: diffSurfaceId(input), kind: "diff" };
}

function isUnresolvedReopen(
  existing: SecondaryPaneSurface,
  candidate: SecondaryPaneDiffSurface,
): boolean {
  if (existing.kind !== "diff") return false;
  const descriptor = candidate.descriptor;
  if (!descriptor || descriptor.baseRevision !== null || descriptor.headRevision !== null) {
    return false;
  }
  // A ref-only reopen is a request to reveal the already-open comparison,
  // not authority to erase the object ids returned by its first request.
  return (
    existing.environmentId === candidate.environmentId &&
    existing.repositoryRoot === candidate.repositoryRoot &&
    existing.comparison === candidate.comparison &&
    existing.oldPath === candidate.oldPath &&
    existing.newPath === candidate.newPath &&
    existing.baseRef === candidate.baseRef &&
    existing.headRef === candidate.headRef &&
    existing.commitSha === candidate.commitSha &&
    existing.descriptor?.kind === descriptor.kind &&
    existing.descriptor?.turnId === descriptor.turnId &&
    existing.descriptor?.checkpointId === descriptor.checkpointId &&
    existing.descriptor?.pullRequestId === descriptor.pullRequestId &&
    existing.descriptor?.mergeParent === descriptor.mergeParent
  );
}

function hasSameResolvedComparisonIdentity(
  existing: SecondaryPaneSurface,
  candidate: SecondaryPaneDiffSurface,
): boolean {
  if (existing.kind !== "diff" || !existing.descriptor || !candidate.descriptor) return false;
  const left = existing.descriptor;
  const right = candidate.descriptor;
  // Render ids intentionally survive descriptor resolution. Compare the
  // immutable authority separately so explicitly reopening that snapshot
  // selects it, while another revision of the same branch remains a new tab.
  return (
    existing.environmentId === candidate.environmentId &&
    existing.repositoryRoot === candidate.repositoryRoot &&
    existing.comparison === candidate.comparison &&
    left.version === right.version &&
    left.kind === right.kind &&
    left.oldPath === right.oldPath &&
    left.newPath === right.newPath &&
    left.baseRevision === right.baseRevision &&
    left.headRevision === right.headRevision &&
    left.liveSnapshotId === right.liveSnapshotId &&
    left.liveBase === right.liveBase &&
    left.turnId === right.turnId &&
    left.checkpointId === right.checkpointId &&
    left.pullRequestId === right.pullRequestId &&
    left.mergeParent === right.mergeParent
  );
}

function updateThread(
  byThreadKey: Record<string, ThreadSecondaryPaneState>,
  threadKey: string,
  updater: (current: ThreadSecondaryPaneState) => ThreadSecondaryPaneState,
): Record<string, ThreadSecondaryPaneState> {
  const current = byThreadKey[threadKey] ?? EMPTY_SECONDARY_PANE_STATE;
  const next = updater(current);
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
}

function sanitizeSurface(surface: unknown): SecondaryPaneSurface | null {
  if (!surface || typeof surface !== "object") return null;
  const value = surface as Partial<SecondaryPaneSurface>;
  if (value.kind === "diff") {
    if (
      typeof value.environmentId !== "string" ||
      typeof value.repositoryRoot !== "string" ||
      typeof value.comparison !== "string" ||
      !["working-tree", "index", "branch", "commit", "pull-request", "turn"].includes(
        value.comparison,
      ) ||
      (value.oldPath !== null && typeof value.oldPath !== "string") ||
      (value.newPath !== null && typeof value.newPath !== "string")
    )
      return null;
    const sanitized = diffSurface({
      environmentId: value.environmentId,
      repositoryRoot: value.repositoryRoot,
      comparison: value.comparison as SecondaryPaneDiffSurface["comparison"],
      oldPath: value.oldPath ?? null,
      newPath: value.newPath ?? null,
      ...(typeof value.baseRef === "string" || value.baseRef === null
        ? { baseRef: value.baseRef }
        : {}),
      ...(typeof value.headRef === "string" || value.headRef === null
        ? { headRef: value.headRef }
        : {}),
      ...(typeof value.indexTree === "string" ? { indexTree: value.indexTree } : {}),
      ...(typeof value.commitSha === "string" ? { commitSha: value.commitSha } : {}),
      ...(typeof value.snapshotId === "string" || value.snapshotId === null
        ? { snapshotId: value.snapshotId }
        : {}),
      ...(value.descriptor && typeof value.descriptor === "object"
        ? { descriptor: value.descriptor as GitRepositoryComparisonDescriptor }
        : {}),
    });
    // A comparison's rendered tab id is deliberately stable after its first
    // response resolves refs to object ids. Retaining the persisted id keeps
    // the saved active tab selected through hydration.
    return typeof value.id === "string" && value.id.startsWith("diff:")
      ? { ...sanitized, id: value.id as `diff:${string}` }
      : sanitized;
  }
  if (value.kind !== "file" || typeof value.relativePath !== "string") return null;
  const relativePath = normalizeRelativePath(value.relativePath);
  if (relativePath.length === 0) return null;
  const revealLine =
    typeof value.revealLine === "number" && Number.isFinite(value.revealLine)
      ? Math.max(1, Math.trunc(value.revealLine))
      : null;
  const revealRequestId =
    typeof value.revealRequestId === "number" &&
    Number.isSafeInteger(value.revealRequestId) &&
    value.revealRequestId >= 0
      ? value.revealRequestId
      : 0;
  return fileSurface(relativePath, revealLine, revealRequestId);
}

export function migratePersistedSecondaryPaneState(persistedState: unknown): {
  byThreadKey: Record<string, ThreadSecondaryPaneState>;
} {
  if (!persistedState || typeof persistedState !== "object") return { byThreadKey: {} };
  const rawByThreadKey = (persistedState as { byThreadKey?: unknown }).byThreadKey;
  if (!rawByThreadKey || typeof rawByThreadKey !== "object" || Array.isArray(rawByThreadKey)) {
    return { byThreadKey: {} };
  }

  const byThreadKey: Record<string, ThreadSecondaryPaneState> = {};
  for (const [threadKey, rawState] of Object.entries(rawByThreadKey)) {
    if (!rawState || typeof rawState !== "object") continue;
    const value = rawState as Partial<ThreadSecondaryPaneState>;
    const surfaces = Array.isArray(value.surfaces)
      ? value.surfaces.flatMap((surface) => {
          const sanitized = sanitizeSurface(surface);
          return sanitized ? [sanitized] : [];
        })
      : [];
    const rawActiveSurfaceId =
      typeof value.activeSurfaceId === "string" ? value.activeSurfaceId : null;
    const activeSurfaceId = surfaces.some((surface) => surface.id === rawActiveSurfaceId)
      ? rawActiveSurfaceId
      : (surfaces[0]?.id ?? null);
    // Pre-presentation tabs were persisted with only `isOpen`. A retained
    // tab now always has a visible default unless it explicitly says it is
    // minimized, so an old `isOpen: false` value cannot strand a tab without
    // a restore affordance.
    const presentation =
      value.presentation === "minimized" ||
      value.presentation === "maximized" ||
      value.presentation === "expanded"
        ? value.presentation
        : "expanded";
    const isOpen = surfaces.length > 0 && presentation !== "minimized";
    if (isOpen || surfaces.length > 0) {
      byThreadKey[threadKey] = {
        isOpen,
        // A minimized pane is hidden, not closed. Keep the selected tab so a
        // restore does not lose the editor/diff identity or its reveal state.
        activeSurfaceId,
        surfaces,
        presentation,
        ...(value.presentationBeforeMinimize === "expanded" ||
        value.presentationBeforeMinimize === "maximized"
          ? { presentationBeforeMinimize: value.presentationBeforeMinimize }
          : {}),
      };
    }
  }
  return { byThreadKey };
}

export const useSecondaryPaneStore = create<SecondaryPaneStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      openFile: (ref, relativePath, line) =>
        set((state) => {
          const normalizedPath = normalizeRelativePath(relativePath);
          if (normalizedPath.length === 0) return state;
          return {
            byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
              const surfaceId = `file:${normalizedPath}` as const;
              const existing = current.surfaces.find((surface) => surface.id === surfaceId);
              const existingFile = existing?.kind === "file" ? existing : undefined;
              const surface = fileSurface(
                normalizedPath,
                normalizeRevealLine(line),
                (existingFile?.revealRequestId ?? 0) + 1,
              );
              const next = {
                ...current,
                isOpen: true,
                activeSurfaceId: surface.id,
                surfaces: existing
                  ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
                  : [...current.surfaces, surface],
              };
              if (current.presentation !== "minimized") return next;
              const { presentationBeforeMinimize: _previous, ...restored } = next;
              return {
                ...restored,
                presentation: current.presentationBeforeMinimize ?? "expanded",
              };
            }),
          };
        }),
      openDiff: (ref, input) =>
        set((state) => {
          const surface = diffSurface({ environmentId: ref.environmentId, ...input });
          return {
            byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
              const existing = current.surfaces.find(
                (entry) =>
                  entry.id === surface.id ||
                  isUnresolvedReopen(entry, surface) ||
                  hasSameResolvedComparisonIdentity(entry, surface),
              );
              const next = {
                ...current,
                isOpen: true,
                activeSurfaceId: existing?.id ?? surface.id,
                surfaces: existing
                  ? current.surfaces.map((entry) => (entry.id === existing.id ? existing : entry))
                  : [...current.surfaces, surface],
              };
              if (current.presentation !== "minimized") return next;
              const { presentationBeforeMinimize: _previous, ...restored } = next;
              return {
                ...restored,
                presentation: current.presentationBeforeMinimize ?? "expanded",
              };
            }),
          };
        }),
      resolveDiffDescriptor: (ref, surfaceId, descriptor) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const currentSurface = current.surfaces.find((surface) => surface.id === surfaceId);
            if (!currentSurface || currentSurface.kind !== "diff") return current;
            if (JSON.stringify(currentSurface.descriptor) === JSON.stringify(descriptor))
              return current;
            // Resolution updates the comparison authority but must retain the
            // tab's stable id. React therefore keeps the mounted scroll/view.
            const resolved: SecondaryPaneDiffSurface = { ...currentSurface, descriptor };
            const surfaces = current.surfaces.map((surface) =>
              surface.id === surfaceId ? resolved : surface,
            );
            return {
              ...current,
              surfaces,
              activeSurfaceId:
                current.activeSurfaceId === surfaceId ? resolved.id : current.activeSurfaceId,
            };
          }),
        })),
      setPresentation: (ref, presentation) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            if (current.surfaces.length === 0) return current;
            if (presentation === "minimized") {
              return {
                ...current,
                isOpen: false,
                presentation: "minimized",
                presentationBeforeMinimize:
                  current.presentation === "maximized" ? "maximized" : "expanded",
              };
            }
            const { presentationBeforeMinimize: _previous, ...withoutPrevious } = current;
            return {
              ...withoutPrevious,
              isOpen: true,
              presentation,
            };
          }),
        })),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? current.presentation === "minimized"
                ? (() => {
                    const { presentationBeforeMinimize: _previous, ...rest } = current;
                    return {
                      ...rest,
                      isOpen: true,
                      activeSurfaceId: surfaceId,
                      presentation: current.presentationBeforeMinimize ?? "expanded",
                    };
                  })()
                : { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        })),
      closeSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0) return current;
            const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
            if (surfaces.length === 0) return EMPTY_SECONDARY_PANE_STATE;
            if (current.activeSurfaceId !== surfaceId) return { ...current, surfaces };
            const fallback = surfaces[index] ?? surfaces[index - 1] ?? null;
            return {
              ...current,
              activeSurfaceId: fallback?.id ?? null,
              surfaces,
            };
          }),
        })),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length <= 1) return current;
            const presentation = current.presentation;
            const presentationBeforeMinimize = current.presentationBeforeMinimize;
            return {
              isOpen: presentation !== "minimized",
              activeSurfaceId: surface.id,
              surfaces: [surface],
              ...(presentation ? { presentation } : {}),
              ...(presentationBeforeMinimize ? { presentationBeforeMinimize } : {}),
            };
          }),
        })),
      closeSurfacesToRight: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
            if (index < 0 || index === current.surfaces.length - 1) return current;
            const surfaces = current.surfaces.slice(0, index + 1);
            return {
              ...current,
              surfaces,
              activeSurfaceId: surfaces.some((surface) => surface.id === current.activeSurfaceId)
                ? current.activeSurfaceId
                : surfaceId,
            };
          }),
        })),
      closeAllSurfaces: (ref) =>
        set((state) => ({
          byThreadKey: updateThread(
            state.byThreadKey,
            scopedThreadKey(ref),
            () => EMPTY_SECONDARY_PANE_STATE,
          ),
        })),
      reconcileWorkspace: (ref, workspaceAvailable) =>
        set((state) => ({
          byThreadKey: workspaceAvailable
            ? state.byThreadKey
            : updateThread(
                state.byThreadKey,
                scopedThreadKey(ref),
                () => EMPTY_SECONDARY_PANE_STATE,
              ),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.byThreadKey;
          return { byThreadKey: rest };
        }),
    }),
    {
      name: SECONDARY_PANE_STORAGE_KEY,
      version: SECONDARY_PANE_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
      migrate: migratePersistedSecondaryPaneState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...migratePersistedSecondaryPaneState(persistedState),
      }),
    },
  ),
);

type OpenRepositoryComparisonInput = Omit<
  SecondaryPaneDiffSurface,
  "id" | "kind" | "environmentId" | "descriptor"
> & {
  readonly baseRevision?: string | null | undefined;
  readonly headRevision?: string | null | undefined;
  readonly liveSnapshotId?: string | null | undefined;
  readonly liveBase?: "head" | "index" | null | undefined;
  readonly turnId?: string | null | undefined;
  readonly checkpointId?: string | null | undefined;
  readonly pullRequestId?: string | null | undefined;
  readonly mergeParent?: string | null | undefined;
};

const GIT_OBJECT_ID = /^[0-9a-f]{40}$/iu;

function gitObjectIdOrNull(value: string | null | undefined): string | null {
  return value && GIT_OBJECT_ID.test(value) ? value : null;
}

/**
 * The only entry point for a repository file comparison.  Keeping the
 * descriptor beside the tab prevents a later route/repository selection from
 * changing what that tab means.
 */
export function openRepositoryComparison(
  ref: ScopedThreadRef,
  input: OpenRepositoryComparisonInput,
): void {
  const kind = input.comparison;
  useSecondaryPaneStore.getState().openDiff(ref, {
    ...input,
    descriptor: {
      version: 1,
      environmentId: String(ref.environmentId),
      repositoryRoot: input.repositoryRoot,
      kind,
      oldPath: input.oldPath,
      newPath: input.newPath,
      baseRevision: gitObjectIdOrNull(input.baseRevision ?? input.baseRef),
      headRevision: gitObjectIdOrNull(input.headRevision ?? input.headRef ?? input.commitSha),
      liveSnapshotId: input.liveSnapshotId ?? input.snapshotId ?? null,
      ...(input.liveBase !== undefined ? { liveBase: input.liveBase } : {}),
      turnId: input.turnId ?? null,
      checkpointId: input.checkpointId ?? null,
      pullRequestId: input.pullRequestId ?? null,
      mergeParent: gitObjectIdOrNull(input.mergeParent),
    },
  });
}

export function selectThreadSecondaryPaneState(
  byThreadKey: Record<string, ThreadSecondaryPaneState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadSecondaryPaneState {
  if (!ref) return EMPTY_SECONDARY_PANE_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_SECONDARY_PANE_STATE;
}

export function selectActiveSecondaryPaneSurface(
  byThreadKey: Record<string, ThreadSecondaryPaneState>,
  ref: ScopedThreadRef | null | undefined,
): SecondaryPaneSurface | null {
  const state = selectThreadSecondaryPaneState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectSelectedSecondaryPaneSurface(
  byThreadKey: Record<string, ThreadSecondaryPaneState>,
  ref: ScopedThreadRef | null | undefined,
): SecondaryPaneSurface | null {
  const state = selectThreadSecondaryPaneState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
