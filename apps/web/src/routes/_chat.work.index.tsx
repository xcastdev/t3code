import { createFileRoute } from "@tanstack/react-router";

import { WorkHomePage } from "../components/work/WorkHomePage";

export const Route = createFileRoute("/_chat/work/")({
  component: WorkHomePage,
});
