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

export interface SourceControlFileAction {
  readonly kind: "stage" | "unstage" | "unavailable";
  readonly label: "Stage" | "Unstage" | "Unavailable";
  readonly disabled: boolean;
  readonly reason: string;
}

type FileIndexState = { readonly indexStatus?: VcsIndexStatus | undefined };

const STAGE_ACTION = {
  kind: "stage",
  label: "Stage",
  disabled: false,
  reason: "Stage the complete file.",
} as const;
const UNSTAGE_ACTION = {
  kind: "unstage",
  label: "Unstage",
  disabled: false,
  reason: "Remove this file from the index.",
} as const;

export function fileActions(input: FileIndexState): ReadonlyArray<SourceControlFileAction> {
  switch (input.indexStatus) {
    case "staged":
      return [UNSTAGE_ACTION];
    case "unstaged":
    case "untracked":
      return [STAGE_ACTION];
    case "both":
      return [UNSTAGE_ACTION, STAGE_ACTION];
    case "conflicted":
      return [
        {
          kind: "unavailable",
          label: "Unavailable",
          disabled: true,
          reason: "Conflict resolution is not available in Source Control yet.",
        },
      ];
    case undefined:
      return [
        {
          kind: "unavailable",
          label: "Unavailable",
          disabled: true,
          reason: "This server does not report index state. Update T3 Code to enable staging.",
        },
      ];
  }
}

export function sourceControlDiffComparisons(
  input: FileIndexState,
): ReadonlyArray<"index" | "head"> {
  if (input.indexStatus === "both") return ["index", "head"];
  return input.indexStatus === "staged" ? ["index"] : ["head"];
}

export function defaultSourceControlDiffComparison(input: FileIndexState): "index" | "head" {
  return sourceControlDiffComparisons(input)[0] ?? "head";
}

export function isFileStaged(input: FileIndexState): boolean {
  return input.indexStatus === "staged" || input.indexStatus === "both";
}

export type SourceControlDiffState =
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly diff: string; readonly truncated: boolean };

export function sourceControlDiffState(input: {
  readonly capabilityKnown: boolean;
  readonly supported: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly diff: string | null;
  readonly truncated: boolean;
}): SourceControlDiffState {
  if (!input.capabilityKnown) return { kind: "loading" };
  if (!input.supported) return { kind: "unsupported" };
  if (input.pending) return { kind: "loading" };
  if (input.error !== null) return { kind: "error", message: input.error };
  if (input.diff === null) return { kind: "loading" };
  if (input.diff.length === 0 && !input.truncated) return { kind: "empty" };
  return { kind: "ready", diff: input.diff, truncated: input.truncated };
}

export type SourceControlDiffTone = "addition" | "deletion" | "hunk" | "context";

export interface SourceControlDiffRun {
  readonly tone: SourceControlDiffTone;
  readonly text: string;
  readonly lineCount: number;
}

export function sourceControlDiffTone(line: string): SourceControlDiffTone {
  if (line.startsWith("+")) return "addition";
  if (line.startsWith("-")) return "deletion";
  if (line.startsWith("@@")) return "hunk";
  return "context";
}

export function sourceControlDiffRenderModel(diff: string): ReadonlyArray<SourceControlDiffRun> {
  const endsWithNewline = diff.endsWith("\n");
  const lines = (endsWithNewline ? diff.slice(0, -1) : diff).split("\n");
  const runs: Array<SourceControlDiffRun> = [];

  for (const [index, line] of lines.entries()) {
    const tone = sourceControlDiffTone(line);
    const text = `${line}${index < lines.length - 1 || endsWithNewline ? "\n" : ""}`;
    const previous = runs.at(-1);
    if (previous?.tone === tone) {
      runs[runs.length - 1] = {
        ...previous,
        text: previous.text + text,
        lineCount: previous.lineCount + 1,
      };
    } else {
      runs.push({ tone, text, lineCount: 1 });
    }
  }

  return runs;
}

export function canSubmitSourceControlCommit(input: {
  readonly workflowAvailable: boolean;
  readonly stagedCount: number;
  readonly message: string;
  readonly commitPending: boolean;
  readonly diffReviewReady: boolean;
  readonly reviewedStateAvailable: boolean;
}): boolean {
  return (
    input.workflowAvailable &&
    input.stagedCount > 0 &&
    input.message.trim().length > 0 &&
    !input.commitPending &&
    input.diffReviewReady &&
    input.reviewedStateAvailable
  );
}

export const SOURCE_CONTROL_STALE_STATE_MESSAGE =
  "Repository changed; review the staged changes and try again.";

export type SourceControlMutationResult<A, E> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<E> };

export function buildSourceControlCommitInput(input: {
  readonly cwd: string;
  readonly message: string;
  readonly headCommit: string | null | undefined;
  readonly indexTree: string | undefined;
  readonly refName?: string | null;
  readonly confirmDefaultRef: boolean;
}): GitCommitIndexInput {
  return {
    cwd: input.cwd,
    message: input.message,
    ...(input.headCommit !== undefined && input.indexTree !== undefined
      ? {
          precondition: {
            expectedHeadCommit: input.headCommit,
            expectedIndexTree: input.indexTree,
            ...(input.refName === undefined ? {} : { expectedRefName: input.refName }),
          },
        }
      : {}),
    ...(input.confirmDefaultRef ? { confirmDefaultRef: true } : {}),
  };
}

export function getGitMutationRejectionCode<E>(input: {
  readonly cause: Cause.Cause<E>;
}): VcsMutationRejectionCode | undefined {
  const error = Cause.squash(input.cause);
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  switch (code) {
    case "dirty_worktree_confirmation_required":
    case "default_ref_confirmation_required":
    case "stale_git_state":
      return code;
    default:
      return undefined;
  }
}

export function handleSourceControlCommitFailure<E>(
  result: { readonly cause: Cause.Cause<E> },
  callbacks: {
    readonly refreshStatus: () => void;
    readonly refreshDiff: () => void;
    readonly setError: (message: string) => void;
  },
): boolean {
  if (getGitMutationRejectionCode(result) !== "stale_git_state") return false;
  callbacks.refreshStatus();
  callbacks.refreshDiff();
  callbacks.setError(SOURCE_CONTROL_STALE_STATE_MESSAGE);
  return true;
}

export async function submitSourceControlCommit<
  A,
  E,
  R extends SourceControlMutationResult<A, E>,
>(input: {
  readonly commit: (commitInput: GitCommitIndexInput) => Promise<R>;
  readonly commitInput: GitCommitIndexInput;
  readonly confirmDefaultRef: () => Promise<boolean>;
  readonly onStale: (result: { readonly cause: Cause.Cause<E> }) => void;
}): Promise<R | null> {
  let result = await input.commit(input.commitInput);
  if (
    result._tag === "Failure" &&
    getGitMutationRejectionCode(result) === "default_ref_confirmation_required"
  ) {
    if (!(await input.confirmDefaultRef())) return null;
    result = await input.commit({ ...input.commitInput, confirmDefaultRef: true });
  }
  if (result._tag === "Failure" && getGitMutationRejectionCode(result) === "stale_git_state") {
    input.onStale(result);
  }
  return result;
}

export async function runAuthoritativeDirtyBranchMutation<
  A,
  E,
  R extends SourceControlMutationResult<A, E>,
>(input: {
  readonly hasWorkingTreeChanges: boolean | undefined;
  readonly confirm: () => Promise<boolean>;
  readonly mutate: (confirmDirtyWorkingTree: boolean) => Promise<R>;
}): Promise<R | null> {
  if (input.hasWorkingTreeChanges === undefined) return null;

  let userConfirmed = false;
  if (input.hasWorkingTreeChanges) {
    if (!(await input.confirm())) return null;
    userConfirmed = true;
  }

  let result = await input.mutate(false);
  if (
    result._tag !== "Failure" ||
    getGitMutationRejectionCode(result) !== "dirty_worktree_confirmation_required"
  ) {
    return result;
  }

  if (!userConfirmed && !(await input.confirm())) return null;
  result = await input.mutate(true);
  return result;
}

export function pullRequestShortcutTarget(): {
  readonly kind: "source-control";
  readonly view: "pull-requests";
} {
  return { kind: "source-control", view: "pull-requests" };
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
    case undefined:
      return "Index state unavailable";
  }
}
