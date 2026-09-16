import type { ScopedThreadRef } from "@t3tools/contracts";
import { isWindowsAbsolutePath, normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { openRepositoryComparison } from "./secondaryPaneStore";
import { resolvePathLinkTarget } from "./terminal-links";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly comparison?: "working-tree" | "branch" | "commit" | "pull-request" | "turn";
  readonly oldPath?: string | null;
  readonly newPath?: string | null;
  readonly baseRef?: string | null;
  readonly headRef?: string | null;
  readonly commitSha?: string;
  readonly indexTree?: string;
  readonly snapshotId?: string | null;
  readonly baseRevision?: string | null;
  readonly headRevision?: string | null;
  readonly turnId?: string | null;
  readonly checkpointId?: string | null;
  readonly pullRequestId?: string | null;
  readonly mergeParent?: string | null;
  readonly openInEditor: (targetPath: string) => void;
}

function normalizedRelativePathSegments(filePath: string): ReadonlyArray<string> | null {
  if (filePath.startsWith("/") || isWindowsAbsolutePath(filePath) || /^[a-zA-Z]:/.test(filePath)) {
    return null;
  }

  const segments = filePath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;
  return segments;
}

function repositoryRelativeWorkspaceSegments(
  workspaceRoot: string | undefined,
  repositoryRoot: string | undefined,
): ReadonlyArray<string> | null {
  if (!workspaceRoot || !repositoryRoot) return null;

  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(workspaceRoot);
  const normalizedRepositoryRoot = normalizeProjectPathForComparison(repositoryRoot);
  if (normalizedWorkspaceRoot === normalizedRepositoryRoot) return [];

  const separator = normalizedRepositoryRoot.includes("\\") ? "\\" : "/";
  const repositoryPrefix = normalizedRepositoryRoot.endsWith(separator)
    ? normalizedRepositoryRoot
    : `${normalizedRepositoryRoot}${separator}`;
  if (!normalizedWorkspaceRoot.startsWith(repositoryPrefix)) return null;

  return normalizedWorkspaceRoot
    .slice(repositoryPrefix.length)
    .split(/[\\/]+/)
    .filter(Boolean);
}

export function resolveDiffPathForWorkspace(input: {
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly repositoryRoot: string | undefined;
}): string | null {
  const fileSegments = normalizedRelativePathSegments(input.filePath);
  if (!fileSegments) return null;

  const workspaceSegments = repositoryRelativeWorkspaceSegments(
    input.workspaceRoot,
    input.repositoryRoot,
  );
  if (!workspaceSegments || workspaceSegments.length === 0) {
    return fileSegments.join("/");
  }

  const caseInsensitive = input.repositoryRoot
    ? isWindowsAbsolutePath(input.repositoryRoot)
    : false;
  const belongsToWorkspace = workspaceSegments.every((segment, index) => {
    const candidate = fileSegments[index];
    if (candidate === undefined) return false;
    return caseInsensitive ? candidate.toLowerCase() === segment : candidate === segment;
  });
  if (!belongsToWorkspace) return null;

  const relativeSegments = fileSegments.slice(workspaceSegments.length);
  return relativeSegments.length > 0 ? relativeSegments.join("/") : null;
}

/**
 * Git paths are already relative to the repository that produced the patch.
 * Do not make them relative to the currently-open project: one repository can
 * contain several projects (or a selected file outside the active project).
 */
export function resolveDiffPathForRepository(filePath: string): string | null {
  const segments = normalizedRelativePathSegments(filePath);
  return segments ? segments.join("/") : null;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  repositoryRoot,
  comparison,
  oldPath,
  newPath,
  baseRef,
  headRef,
  commitSha,
  indexTree,
  snapshotId,
  baseRevision,
  headRevision,
  turnId,
  checkpointId,
  pullRequestId,
  mergeParent,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  if (threadRef) {
    const repositoryFilePath = resolveDiffPathForRepository(filePath);
    if (!repositoryFilePath) return;
    openRepositoryComparison(threadRef, {
      repositoryRoot: repositoryRoot ?? activeCwd ?? "",
      comparison: comparison ?? "working-tree",
      // `undefined` means the caller did not know a side, while `null` is
      // meaningful Git metadata for adds/deletes. Preserve that distinction.
      oldPath: oldPath === undefined ? repositoryFilePath : oldPath,
      newPath: newPath === undefined ? repositoryFilePath : newPath,
      ...(baseRef !== undefined ? { baseRef } : {}),
      ...(headRef !== undefined ? { headRef } : {}),
      ...(commitSha !== undefined ? { commitSha } : {}),
      ...(indexTree !== undefined ? { indexTree } : {}),
      ...(snapshotId !== undefined ? { snapshotId } : {}),
      ...(baseRevision !== undefined ? { baseRevision } : {}),
      ...(headRevision !== undefined ? { headRevision } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(checkpointId !== undefined ? { checkpointId } : {}),
      ...(pullRequestId !== undefined ? { pullRequestId } : {}),
      ...(mergeParent !== undefined ? { mergeParent } : {}),
    });
    return;
  }

  const workspaceFilePath = resolveDiffPathForWorkspace({
    filePath,
    workspaceRoot: activeCwd,
    repositoryRoot,
  });
  if (!workspaceFilePath) return;

  openInEditor(activeCwd ? resolvePathLinkTarget(workspaceFilePath, activeCwd) : workspaceFilePath);
}
