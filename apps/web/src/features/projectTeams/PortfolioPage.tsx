import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { useProjects } from "../../state/entities";
import { environmentProjects } from "../../state/projects";
import { environmentPresentations } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { PortfolioSource, type PortfolioSourceProps } from "./PortfolioSource";

type Navigation = Pick<PortfolioSourceProps, "onOpenProject" | "onOpenTask" | "onOpenWorker">;
const PAGE_SIZE = 25;

/** Page the existing project catalogue before subscribing to project supervision. */
export function PortfolioPage(props: Navigation) {
  const projects = useProjects();
  const owners = new Set<string>();
  const unique = projects.filter((project) => {
    const key = JSON.stringify([project.environmentId, project.id]);
    if (owners.has(key)) return false;
    owners.add(key);
    return true;
  });
  return <PortfolioPageRead key={JSON.stringify([...owners])} {...props} projects={unique} />;
}

function PortfolioPageRead({
  projects,
  ...navigation
}: Navigation & { readonly projects: ReturnType<typeof useProjects> }) {
  const registry = useContext(RegistryContext);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const environments = useAtomValue(environmentPresentations.presentationsAtom);
  const [requestedPage, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(projects.length / PAGE_SIZE) - 1);
  const page = Math.min(requestedPage, lastPage);
  const visible = projects.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentProject = (target: Parameters<Navigation["onOpenProject"]>[0]) => {
    if (!mounted.current) return undefined;
    const selected = visible.find(
      (project) =>
        project.environmentId === target.environmentId && project.id === target.projectId,
    );
    if (!selected) return undefined;
    return registry
      .get(environmentProjects.projectsAtom)
      .find(
        (project) =>
          project === selected &&
          project.environmentId === target.environmentId &&
          project.id === target.projectId,
      );
  };
  const currentWork = (target: Parameters<Navigation["onOpenProject"]>[0]) => {
    const project = currentProject(target);
    const config = registry.get(environmentServerConfigsAtom).get(target.environmentId);
    const environment = registry
      .get(environmentPresentations.presentationsAtom)
      .get(target.environmentId);
    return (
      project !== undefined &&
      environment?.connection.phase === "connected" &&
      config?.settings.projectWorkEnabled === true &&
      config.environment?.capabilities?.projectTeamSupervisionReads === true
    );
  };
  const openProject = useEffectEvent((target: Parameters<Navigation["onOpenProject"]>[0]) => {
    if (currentProject(target)) navigation.onOpenProject(target);
  });
  const openTask = useEffectEvent((target: Parameters<Navigation["onOpenTask"]>[0]) => {
    if (currentWork(target)) navigation.onOpenTask(target);
  });
  const openWorker = useEffectEvent((target: Parameters<Navigation["onOpenWorker"]>[0]) => {
    if (currentWork(target)) navigation.onOpenWorker(target);
  });
  return (
    <PortfolioSource
      projects={visible.map((project) => {
        const config = configs.get(project.environmentId);
        return {
          environmentId: project.environmentId,
          projectId: project.id,
          title: project.title,
          connected: environments.get(project.environmentId)?.connection.phase === "connected",
          enabled: config?.settings.projectWorkEnabled === true,
          supported: config?.environment?.capabilities?.projectTeamSupervisionReads === true,
        };
      })}
      hasPrevious={page > 0}
      hasNext={page < lastPage}
      onPrevious={() => setPage(Math.max(0, page - 1))}
      onNext={() => setPage(Math.min(lastPage, page + 1))}
      onRefresh={() => registry.refresh(environmentProjects.projectsAtom)}
      canRefreshProject={currentWork}
      onOpenProject={(target) => openProject(target)}
      onOpenTask={(target) => openTask(target)}
      onOpenWorker={(target) => openWorker(target)}
    />
  );
}
