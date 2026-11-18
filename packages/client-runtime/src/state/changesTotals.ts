import type {
  PullRequestChangeBreakdown,
  ReviewDiffPreviewSource,
  VcsStatusResult,
} from "@t3tools/contracts";
import { summarizeChangedFiles } from "@t3tools/shared/changedFileKind";

export type ChangesLineTotals = {
  readonly insertions: number;
  readonly deletions: number;
  /** Ref the counts compare against; `null` means they are uncommitted changes against HEAD. */
  readonly baseRef: string | null;
  /** `null` when the selected totals carry no per-file stats. */
  readonly breakdown: PullRequestChangeBreakdown;
};

// `branchChanges ?? workingTree` treats `{0,0}` as present, so a zero branch total hid a dirty
// working tree and the Changes row read +0 while Diff still showed the work.
// The Diff panel's branch comparison wins when it has file stats, so a remembered base or
// hidden whitespace reads the same in the row as in the panel.
export function resolveChangesTotals(
  status: VcsStatusResult | null | undefined,
  branchPreview?: ReviewDiffPreviewSource | null,
): ChangesLineTotals | null {
  if (branchPreview?.files) {
    let insertions = 0;
    let deletions = 0;
    for (const file of branchPreview.files) {
      insertions += file.additions;
      deletions += file.deletions;
    }
    return {
      insertions,
      deletions,
      baseRef: branchPreview.baseRef,
      breakdown: summarizeChangedFiles(branchPreview.files),
    };
  }
  if (!status) return null;
  const branch = status.branchChanges;
  const tree = { ...status.workingTree, baseRef: null };
  const selected =
    branch && (branch.insertions > 0 || branch.deletions > 0)
      ? branch
      : tree.insertions > 0 || tree.deletions > 0
        ? tree
        : (branch ?? tree);
  return {
    insertions: selected.insertions,
    deletions: selected.deletions,
    baseRef: selected.baseRef,
    breakdown:
      selected === tree
        ? summarizeChangedFiles(
            tree.files.map((file) => ({
              path: file.path,
              additions: file.insertions,
              deletions: file.deletions,
            })),
          )
        : null,
  };
}
