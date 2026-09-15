import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";
import { useSecondaryPaneStore } from "./secondaryPaneStore";

/** Remove all persisted pane presentation state for one environment-scoped thread. */
export function removeThreadPaneState(threadRef: ScopedThreadRef): void {
  useRightPanelStore.getState().removeThread(threadRef);
  useSecondaryPaneStore.getState().removeThread(threadRef);
}
