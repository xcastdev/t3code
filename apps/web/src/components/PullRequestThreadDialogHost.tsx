import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { useRightPanelStore } from "~/rightPanelStore";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";

interface PullRequestThreadDialogHostProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadRef: ScopedThreadRef | null;
  projectRoot: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
}

/** Keeps the branch toolbar's checkout dialog on the repository selected in Source Control. */
export function PullRequestThreadDialogHost({
  threadRef,
  projectRoot,
  ...props
}: PullRequestThreadDialogHostProps) {
  const selectedRepositoryRoot = useRightPanelStore((state) =>
    threadRef ? state.getSourceControlRepositoryRoot(threadRef) : null,
  );

  return <PullRequestThreadDialog {...props} cwd={selectedRepositoryRoot ?? projectRoot} />;
}
