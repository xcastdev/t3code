import { createFileRoute, redirect } from "@tanstack/react-router";

// An obsolete /settings load must not redirect a newer child navigation through
// their shared parent match. The index match is dropped when a child takes over.
export const Route = createFileRoute("/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
});
