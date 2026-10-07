import {
  EnvironmentId,
  GitMutationPrecondition,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DisplayedGitSourceSchema = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: Schema.String.check(Schema.isMinLength(1)),
  precondition: GitMutationPrecondition,
});
export type DisplayedGitSource = typeof DisplayedGitSourceSchema.Type;
const isDisplayedGitSource = Schema.is(DisplayedGitSourceSchema);

type GitSourceOwner = {
  readonly environmentId: string;
  readonly threadId: string;
  readonly cwd: string | null;
};

export function cloneDisplayedGitSource(value: unknown): DisplayedGitSource | null {
  if (
    !isDisplayedGitSource(value) ||
    !value.precondition.expectedIndexTree.trim() ||
    value.precondition.expectedHeadCommit === ""
  )
    return null;
  const precondition = Object.freeze({
    ...value.precondition,
    ...(value.precondition.expectedMergeHeads !== undefined
      ? { expectedMergeHeads: Object.freeze([...value.precondition.expectedMergeHeads]) }
      : {}),
  });
  return Object.freeze({
    environmentId: value.environmentId,
    threadId: value.threadId,
    cwd: value.cwd,
    precondition,
  });
}

export function captureDisplayedGitSource(
  owner: GitSourceOwner,
  status: VcsStatusResult | null,
): DisplayedGitSource | null {
  if (
    !owner.cwd ||
    !status?.isRepo ||
    status.headCommit === undefined ||
    status.indexTree === undefined
  )
    return null;
  return cloneDisplayedGitSource({
    ...owner,
    precondition: {
      expectedHeadCommit: status.headCommit,
      expectedIndexTree: status.indexTree,
      expectedRefName: status.refName,
      ...(status.pendingMergeHeads !== undefined
        ? { expectedMergeHeads: status.pendingMergeHeads }
        : {}),
    },
  });
}

export function matchesDisplayedGitSource(
  source: DisplayedGitSource | null,
  owner: GitSourceOwner,
  status: VcsStatusResult | null,
): boolean {
  if (
    !source ||
    !status?.isRepo ||
    source.environmentId !== owner.environmentId ||
    source.threadId !== owner.threadId ||
    source.cwd !== owner.cwd
  )
    return false;
  const expected = source.precondition;
  return (
    expected.expectedHeadCommit === status.headCommit &&
    expected.expectedIndexTree === status.indexTree &&
    expected.expectedRefName === status.refName &&
    (expected.expectedMergeHeads === undefined
      ? status.pendingMergeHeads === undefined
      : status.pendingMergeHeads !== undefined &&
        expected.expectedMergeHeads.length === status.pendingMergeHeads.length &&
        expected.expectedMergeHeads.every(
          (head, index) => head === status.pendingMergeHeads?.[index],
        ))
  );
}
