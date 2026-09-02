/**
 * Thread-scoped state for the editor/file-viewer pane in the workspace.
 *
 * The right sidebar owns project tools such as the Project Explorer. Files
 * opened from those tools live here instead, which keeps editor tabs
 * independent from right-sidebar surface tabs.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type SecondaryPaneSurface = {
  id: `file:${string}`;
  kind: "file";
  relativePath: string;
  revealLine: number | null;
  revealRequestId: number;
};

export type ThreadSecondaryPaneState = {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: SecondaryPaneSurface[];
};

interface SecondaryPaneStoreState {
  byThreadKey: Record<string, ThreadSecondaryPaneState>;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
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
  if (!rawByThreadKey || typeof rawByThreadKey !== "object") return { byThreadKey: {} };

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
    const isOpen = surfaces.length > 0 && value.isOpen !== false;
    if (isOpen || surfaces.length > 0) {
      byThreadKey[threadKey] = {
        isOpen,
        activeSurfaceId: isOpen ? activeSurfaceId : null,
        surfaces,
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
              const surface = fileSurface(
                normalizedPath,
                normalizeRevealLine(line),
                (existing?.revealRequestId ?? 0) + 1,
              );
              return {
                isOpen: true,
                activeSurfaceId: surface.id,
                surfaces: existing
                  ? current.surfaces.map((entry) => (entry.id === surface.id ? surface : entry))
                  : [...current.surfaces, surface],
              };
            }),
          };
        }),
      activateSurface: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
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
            return { ...current, activeSurfaceId: fallback?.id ?? null, surfaces };
          }),
        })),
      closeOtherSurfaces: (ref, surfaceId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find((entry) => entry.id === surfaceId);
            if (!surface || current.surfaces.length <= 1) return current;
            return { isOpen: true, activeSurfaceId: surface.id, surfaces: [surface] };
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
    },
  ),
);

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
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectSelectedSecondaryPaneSurface(
  byThreadKey: Record<string, ThreadSecondaryPaneState>,
  ref: ScopedThreadRef | null | undefined,
): SecondaryPaneSurface | null {
  const state = selectThreadSecondaryPaneState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}
