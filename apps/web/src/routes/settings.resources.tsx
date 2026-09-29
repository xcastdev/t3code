import { createFileRoute } from "@tanstack/react-router";

import { ResourcesSettings } from "../features/resources/ResourcesSettings";

export const Route = createFileRoute("/settings/resources")({ component: ResourcesSettings });
