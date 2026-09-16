import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null; repositoryRoot?: string }
  | { kind: "unstaged"; repositoryRoot?: string }
  | {
      kind: "turn";
      turnId: TurnId;
      filePath: string | null;
      revealRequestId: number;
      repositoryRoot?: string;
    };

const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };
const DEFAULT_WORKING_TREE_SELECTION: DiffPanelSelection = { kind: "unstaged" };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (
    ref: ScopedThreadRef,
    scope: "branch" | "unstaged",
    repositoryRoot?: string,
  ) => void;
  selectBranchBaseRef: (
    ref: ScopedThreadRef,
    baseRef: string | null,
    repositoryRoot?: string,
  ) => void;
  selectTurn: (
    ref: ScopedThreadRef,
    turnId: TurnId,
    filePath?: string,
    repositoryRoot?: string,
  ) => void;
  reconcileTurnSelection: (ref: ScopedThreadRef, availableTurnIds: ReadonlyArray<TurnId>) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope, repositoryRoot) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          const nextRepositoryRoot = repositoryRoot ?? previous?.repositoryRoot;
          const nextSelection: DiffPanelSelection =
            scope === "branch"
              ? nextRepositoryRoot
                ? { kind: "branch", baseRef: previousBaseRef, repositoryRoot: nextRepositoryRoot }
                : { kind: "branch", baseRef: previousBaseRef }
              : nextRepositoryRoot
                ? { kind: "unstaged", repositoryRoot: nextRepositoryRoot }
                : { kind: "unstaged" };
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: nextSelection,
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectBranchBaseRef: (ref, baseRef, repositoryRoot) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          const previousRoot = state.byThreadKey[threadKey]?.repositoryRoot;
          const nextRoot = repositoryRoot ?? previousRoot;
          const nextSelection: DiffPanelSelection = nextRoot
            ? { kind: "branch", baseRef: normalizedBaseRef, repositoryRoot: nextRoot }
            : { kind: "branch", baseRef: normalizedBaseRef };
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: nextSelection,
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath, repositoryRoot) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          // A checkpoint belongs to the thread workspace, not to the last
          // repository selected for an aggregate Git diff. Do not inherit a
          // nested Source Control repository into a turn selection.
          const nextRepositoryRoot = repositoryRoot;
          const nextSelection: DiffPanelSelection = nextRepositoryRoot
            ? {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
                repositoryRoot: nextRepositoryRoot,
              }
            : {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              };
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: nextSelection,
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.branchBaseRefByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBaseRef, ...branchBaseRefByThreadKey } =
            state.branchBaseRefByThreadKey;
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
  hasWorkingTreeChanges = false,
  repositoryRoot?: string,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  const selection =
    byThreadKey[scopedThreadKey(ref)] ??
    (hasWorkingTreeChanges ? DEFAULT_WORKING_TREE_SELECTION : DEFAULT_SELECTION);
  if (repositoryRoot && selection.repositoryRoot === undefined) {
    return { ...selection, repositoryRoot };
  }
  return selection;
}

/** Stable identity for aggregate diff data and collapsed-file state. */
export function diffPanelScopeKey(selection: DiffPanelSelection): string {
  switch (selection.kind) {
    case "branch":
      return `branch:${selection.repositoryRoot ?? ""}:${selection.baseRef ?? ""}`;
    case "unstaged":
      return `unstaged:${selection.repositoryRoot ?? ""}`;
    case "turn":
      return `turn:${selection.repositoryRoot ?? ""}:${selection.turnId}:${selection.filePath ?? ""}`;
  }
}

/** The aggregate selection owns routing even if a later status read resolves another root. */
export function resolveDiffRepositoryRoot(
  selectedRoot: string | undefined,
  activeRoot: string | undefined,
): string | undefined {
  return selectedRoot ?? activeRoot;
}
