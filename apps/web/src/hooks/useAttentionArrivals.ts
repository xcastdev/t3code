import { noteAttentionArrivals } from "@t3tools/client-runtime/state/attention";
import { useState } from "react";

import { useClientSettings } from "./useSettings";

/** Counts arrivals of never-seen keys; the count changes only when something new appears. */
export function useAttentionArrivals(keys: ReadonlyArray<string>): number {
  const [state, setState] = useState<{ seen: ReadonlySet<string>; count: number }>(() => ({
    seen: new Set(),
    count: 0,
  }));
  const next = noteAttentionArrivals(state.seen, keys);
  // Derived during render: the stored set only grows when the keys bring something new.
  if (next.arrived) setState({ seen: next.seen, count: state.count + 1 });
  return next.arrived ? state.count + 1 : state.count;
}

/** The "Keep attention dots pulsing" setting. */
export function useAttentionPulseContinuous(): boolean {
  return useClientSettings((settings) => settings.attentionPulseContinuous);
}
