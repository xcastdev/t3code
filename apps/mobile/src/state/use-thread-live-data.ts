import { useAtomValue } from "@effect/atom-react";
import {
  type ContextWindowSnapshot,
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "@t3tools/client-runtime/state/context-window";
import { latestTodoList, type TodoListPlan } from "@t3tools/client-runtime/state/thread-checklist";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentThreadDetails } from "./threads";
import { useQuietThreadStructure } from "./use-thread-detail";

const EMPTY_VISIBLE_TURN_ITEMS_ATOM = Atom.make<
  ReturnType<typeof environmentThreadDetails.visibleTurnItemsAtom> extends Atom.Atom<infer A>
    ? A
    : never
>(Object.freeze([])).pipe(Atom.withLabel("mobile-thread-live-turn-items:empty"));

/** The thread's current checklist, or null when the agent has not written one. */
export function useThreadChecklist(ref: ScopedThreadRef | null): TodoListPlan | null {
  const structure = useQuietThreadStructure(ref);
  const plans = structure?.projection.plans;
  const runs = structure?.projection.runs;
  return useMemo(
    () => (plans === undefined || runs === undefined ? null : latestTodoList(plans, runs)),
    [plans, runs],
  );
}

/** Context window use for the active provider thread, as the web thread details show it. */
export function useThreadContextWindow(ref: ScopedThreadRef | null): ContextWindowSnapshot | null {
  const structure = useQuietThreadStructure(ref);
  const visibleTurnItems = useAtomValue(
    ref === null
      ? EMPTY_VISIBLE_TURN_ITEMS_ATOM
      : environmentThreadDetails.visibleTurnItemsAtom(ref),
  );
  const projection = structure?.projection;
  return useMemo(() => {
    if (projection === undefined) return null;
    const providerThread = projection.providerThreads.find(
      (thread) => thread.id === projection.thread.activeProviderThreadId,
    );
    const liveUsage = latestProviderTurnTokenUsage(
      projection.providerTurns,
      projection,
      providerThread,
    );
    return deriveLatestContextWindowSnapshot(visibleTurnItems, liveUsage, providerThread);
  }, [projection, visibleTurnItems]);
}
