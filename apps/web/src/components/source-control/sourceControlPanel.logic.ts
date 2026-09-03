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
  readonly label: "Stage" | "Unstage" | "Unavailable";
  readonly disabled: boolean;
  readonly reason: string;
}

type FileIndexState = { readonly indexStatus?: VcsIndexStatus | undefined };

export function fileAction(input: FileIndexState): SourceControlFileAction {
  switch (input.indexStatus) {
    case "staged":
      return { label: "Unstage", disabled: false, reason: "Remove this file from the index." };
    case "unstaged":
    case "both":
    case "untracked":
      return { label: "Stage", disabled: false, reason: "Stage the complete file." };
    case "conflicted":
      return {
        label: "Unavailable",
        disabled: true,
        reason: "Conflict resolution is not available in Source Control yet.",
      };
    case undefined:
      return {
        label: "Unavailable",
        disabled: true,
        reason: "This server does not report index state. Update T3 Code to enable staging.",
      };
  }
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
