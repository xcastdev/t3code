import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettings } from "../features/skills/SkillsSettings";
import { parseResourceTarget } from "../features/resources/resourceTarget";

export const Route = createFileRoute("/settings/skills")({ component: SkillsSettingsRoute });

function SkillsSettingsRoute() {
  const { resource } = Route.useSearch();
  const target = parseResourceTarget(resource);
  return <SkillsSettings resourceTarget={target?.kind === "skill" ? target : null} />;
}
