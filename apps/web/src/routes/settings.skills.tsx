import { createFileRoute } from "@tanstack/react-router";

import { SkillsSettings } from "../features/skills/SkillsSettings";

export const Route = createFileRoute("/settings/skills")({ component: SkillsSettings });
