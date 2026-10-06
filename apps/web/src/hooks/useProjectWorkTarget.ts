import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { getProjectOrderKey } from "../logicalProject";
import { useProjects, useThreadShell } from "../state/entities";
import { resolveActiveThreadRouteRef, resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";

export function useProjectWorkTarget() {
  const params = useParams({ strict: false });
  const routeTarget = resolveThreadRouteTarget(params);
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft"
      ? store.getDraftSession(routeTarget.draftId)
      : routeTarget?.kind === "server"
        ? store.getDraftThread(routeTarget.threadRef)
        : null,
  );
  const thread = useThreadShell(resolveActiveThreadRouteRef(routeTarget, draft));
  const projects = useProjects();
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  // An explicit route owner must never fall back to an unrelated project.
  if (params.projectId) {
    const project = projects.find(
      (project) =>
        project.environmentId === params.environmentId && project.id === params.projectId,
    );
    return project ? scopeProjectRef(project.environmentId, project.id) : null;
  }
  const owner = thread ?? draft;
  if (routeTarget && !owner) return null;
  const project = owner
    ? projects.find(
        (project) =>
          project.environmentId === owner.environmentId && project.id === owner.projectId,
      )
    : orderedProjects[0];
  return project ? scopeProjectRef(project.environmentId, project.id) : null;
}
