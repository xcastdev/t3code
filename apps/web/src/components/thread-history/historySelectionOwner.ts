import {
  historySelectionIsCurrent,
  type HistorySelection,
} from "@t3tools/client-runtime/state/thread-history";

/**
 * Owned by the History surface, not the keyed archive view, so it outlives a detail
 * unmount. An action captures the selection it started from; once the user picks another
 * archive, reviews again, or closes History, that captured object is no longer active and
 * late results must not dispatch, close, or navigate.
 */
export function createHistorySelectionOwner() {
  let active: HistorySelection | null = null;
  return {
    activate(selection: HistorySelection | null) {
      active = selection;
    },
    release() {
      active = null;
    },
    /** The live selection for an action begun from `started`, or null once it went stale. */
    currentFor(started: HistorySelection, liveEpoch: string | null): HistorySelection | null {
      if (active !== started || liveEpoch === null) return null;
      const current = { ...active, connectionEpoch: liveEpoch };
      return historySelectionIsCurrent(started, current) ? current : null;
    },
  };
}

export type HistorySelectionOwner = ReturnType<typeof createHistorySelectionOwner>;
