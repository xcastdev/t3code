import type { VcsIndexStatus } from "@t3tools/contracts";

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

export function needsDirtyBranchConfirmation(hasWorkingTreeChanges: boolean): boolean {
  return hasWorkingTreeChanges;
}

export function canAttemptDirtyBranchSwitch(hasWorkingTreeChanges: boolean | undefined): boolean {
  return hasWorkingTreeChanges !== undefined;
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
