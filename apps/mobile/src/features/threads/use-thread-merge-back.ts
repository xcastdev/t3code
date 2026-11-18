import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { useRef } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Merges a fork's latest turn back into its source, then hands the source to `onMerged`.
 * Undefined while there is nothing to merge.
 */
export function useThreadMergeBack(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly targetThreadId: ThreadId | null;
  readonly runId: RunId | null;
  readonly onMerged: (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
}): (() => void) | undefined {
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const busy = useRef(false);
  const { environmentId, threadId, targetThreadId, runId } = input;
  if (environmentId === null || threadId === null || targetThreadId === null || runId === null) {
    return undefined;
  }
  return () => {
    if (busy.current) return;
    busy.current = true;
    void mergeBack({
      environmentId,
      input: {
        sourceThreadId: threadId,
        targetThreadId,
        runId,
        creationSource: "mobile",
      },
    }).then((result) => {
      busy.current = false;
      if (result._tag === "Success") input.onMerged({ environmentId, threadId: targetThreadId });
    });
  };
}
