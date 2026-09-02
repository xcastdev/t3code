import type { EnvironmentId } from "@t3tools/contracts";

import FileBrowserPanel from "./FileBrowserPanel";

interface ProjectExplorerPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath?: string | null;
  selectedPathRevealId?: number;
  onOpenFile: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

export default function ProjectExplorerPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath = null,
  selectedPathRevealId = 0,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
}: ProjectExplorerPanelProps) {
  return (
    <FileBrowserPanel
      key={`${environmentId}:${cwd}`}
      environmentId={environmentId}
      cwd={cwd}
      projectName={projectName}
      selectedPath={selectedPath}
      selectedPathRevealId={selectedPathRevealId}
      onOpenFile={onOpenFile}
      {...(onRefreshSelectedFile ? { onRefreshSelectedFile } : {})}
      workspaceMutationId={workspaceMutationId}
    />
  );
}
