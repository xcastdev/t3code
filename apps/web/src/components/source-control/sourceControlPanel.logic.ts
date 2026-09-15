import * as Cause from "effect/Cause";
import type {
  GitCommitIndexInput,
  VcsIndexStatus,
  VcsMutationRejectionCode,
} from "@t3tools/contracts";

export type SourceControlPanelView = "changes" | "pull-requests";

export function gitIndexWorkflowAvailability(
  capabilityKnown: boolean,
  supported: boolean,
): "loading" | "unsupported" | "available" {
  if (!capabilityKnown) return "loading";
  return supported ? "available" : "unsupported";
}

export function fileAction(
  indexStatus: VcsIndexStatus | undefined,
): ReadonlyArray<"stage" | "unstage"> | null {
  if (indexStatus === "staged") return ["unstage"];
  if (indexStatus === "both") return ["unstage", "stage"];
  if (indexStatus === "unstaged" || indexStatus === "untracked") return ["stage"];
  // Staging a conflicted path is how Git records a manual resolution. This panel does not
  // implement conflict resolution, so it deliberately offers neither index mutation.
  if (indexStatus === "conflicted") return [];
  return null;
}

export function sourceControlFileStatusLabel(indexStatus: VcsIndexStatus | undefined): string {
  switch (indexStatus) {
    case "staged":
      return "Staged";
    case "both":
      return "Staged + modified";
    case "untracked":
      return "Untracked";
    case "conflicted":
      return "Conflict";
    case "unstaged":
      return "Modified";
    default:
      return "Index state unavailable";
  }
}

export function buildSourceControlCommitInput(input: {
  readonly cwd: string;
  readonly message: string;
  readonly headCommit: string | null | undefined;
  readonly indexTree: string | undefined;
  readonly refName: string | null | undefined;
  readonly pendingMergeHeads: readonly string[] | undefined;
  readonly confirmDefaultRef: boolean;
}): GitCommitIndexInput {
  return {
    cwd: input.cwd,
    message: input.message.trim(),
    ...(input.headCommit !== undefined &&
    input.indexTree !== undefined &&
    input.refName !== undefined
      ? {
          precondition: {
            expectedHeadCommit: input.headCommit,
            expectedIndexTree: input.indexTree,
            expectedRefName: input.refName,
            ...(input.pendingMergeHeads === undefined
              ? {}
              : { expectedMergeHeads: input.pendingMergeHeads }),
          },
        }
      : {}),
    ...(input.confirmDefaultRef ? { confirmDefaultRef: true } : {}),
  };
}

export function gitMutationRejectionCode<E>(
  cause: Cause.Cause<E>,
): VcsMutationRejectionCode | undefined {
  const error = Cause.squash(cause);
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return code === "dirty_worktree_confirmation_required" ||
    code === "default_ref_confirmation_required" ||
    code === "stale_git_state"
    ? code
    : undefined;
}

export const SOURCE_CONTROL_STALE_STATE_MESSAGE =
  "Repository changed; review the staged changes and try again.";

export function canSubmitSourceControlCommit(input: {
  readonly workflowAvailable: boolean;
  readonly stagedCount: number;
  readonly message: string;
  readonly reviewedStateAvailable: boolean;
  readonly hasReviewedBranch: boolean;
}): boolean {
  return (
    input.workflowAvailable &&
    input.stagedCount > 0 &&
    input.message.trim().length > 0 &&
    input.reviewedStateAvailable &&
    input.hasReviewedBranch
  );
}

export async function handleSourceControlCommitFailure<E>(
  result: { readonly cause: Cause.Cause<E> },
  callbacks: {
    readonly refreshStatus: () => void | Promise<void>;
    readonly setError: (message: string) => void;
  },
): Promise<boolean> {
  if (gitMutationRejectionCode(result.cause) !== "stale_git_state") return false;
  await callbacks.refreshStatus();
  callbacks.setError(SOURCE_CONTROL_STALE_STATE_MESSAGE);
  return true;
}
