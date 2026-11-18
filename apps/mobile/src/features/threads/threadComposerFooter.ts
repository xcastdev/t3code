export interface ThreadWorkspacePresentation {
  readonly kind: "local" | "worktree";
  readonly label: string;
}

function lastPathSegment(path: string): string | null {
  return path.split(/[\\/]/).findLast((part) => part.length > 0) ?? null;
}

function normalizeBranch(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim();
  return trimmed ? trimmed : null;
}

export function resolveThreadWorkspacePresentation(input: {
  readonly worktreePath: string | null;
  readonly threadBranch: string | null;
  /** The checkout's current ref; it wins over the thread's recorded branch, which can lag. */
  readonly liveBranch: string | null;
  readonly isRepo: boolean;
}): ThreadWorkspacePresentation {
  const branch = input.isRepo
    ? (normalizeBranch(input.liveBranch) ?? normalizeBranch(input.threadBranch))
    : null;
  if (input.worktreePath !== null) {
    return {
      kind: "worktree",
      label: branch ?? lastPathSegment(input.worktreePath) ?? "Worktree",
    };
  }
  return { kind: "local", label: branch ? `Local · ${branch}` : "Local" };
}

const COMPACT_PHONE_MAX_HEIGHT = 800;

/** Short windows (SE-class phones, any phone in landscape) need every row above the keyboard. */
export function threadComposerFooterHidesWhileTyping(windowHeight: number): boolean {
  return windowHeight < COMPACT_PHONE_MAX_HEIGHT;
}
