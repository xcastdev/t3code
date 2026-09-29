import { createFileRoute } from "@tanstack/react-router";

import { ProjectsSettings } from "../components/settings/ProjectsSettings";
import { parseResourceTarget } from "../features/resources/resourceTarget";

export const Route = createFileRoute("/settings/projects")({ component: ProjectsSettingsRoute });

function ProjectsSettingsRoute() {
  const { resource } = Route.useSearch();
  const target = parseResourceTarget(resource);
  return (
    <ProjectsSettings
      resourceTarget={target?.kind === "mcp" && target.scope === "project" ? target : null}
    />
  );
}
