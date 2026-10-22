import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";

import { useProjects } from "../state/entities";
import { useHandleNewThread } from "./useHandleNewThread";

/**
 * The project Work should open for: the Work page's own project, else the
 * active thread or draft's project, else the default project. A target that
 * no longer exists resolves to null so entry points disable instead of guessing.
 */
export function useProjectWorkTarget() {
  const routeEnvironmentId = useParams({ strict: false, select: (params) => params.environmentId });
  const routeProjectId = useParams({ strict: false, select: (params) => params.projectId });
  const { activeDraftThread, activeThread, defaultProjectRef } = useHandleNewThread();
  const projects = useProjects();
  const ref =
    routeEnvironmentId && routeProjectId
      ? scopeProjectRef(routeEnvironmentId as EnvironmentId, routeProjectId as ProjectId)
      : activeThread
        ? scopeProjectRef(activeThread.environmentId, activeThread.projectId)
        : activeDraftThread
          ? scopeProjectRef(activeDraftThread.environmentId, activeDraftThread.projectId)
          : defaultProjectRef;
  if (ref === null) return null;
  const project = projects.find(
    (entry) => entry.environmentId === ref.environmentId && entry.id === ref.projectId,
  );
  return project
    ? { environmentId: project.environmentId, projectId: project.id, title: project.title }
    : null;
}
