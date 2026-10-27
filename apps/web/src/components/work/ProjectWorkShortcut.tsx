import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useProjectWorkTarget } from "../../hooks/useProjectWorkTarget";
import { readThreadPanelShortcutContext } from "../../shortcuts/commandPaletteCommands";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";

/** The `projectWork.open` keybinding; it opens the same target as the palette and Settings. */
export function ProjectWorkShortcut({ paletteOpen }: { readonly paletteOpen: boolean }) {
  const routeTarget = useThreadRouteTarget();
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const target = useProjectWorkTarget();
  const navigate = useNavigate();
  // oxlint-disable-next-line t3code/react-effect-budget -- Register the route command while mounted and remove it when the route target changes or unmounts.
  useEffect(() => {
    if (target === null) return;
    return registerCommands(
      {
        "projectWork.open": (event) => {
          event.preventDefault();
          event.stopPropagation();
          void navigate({
            to: "/work/$environmentId/$projectId",
            params: { environmentId: target.environmentId, projectId: target.projectId },
            search: { section: "overview" },
          });
        },
      },
      {
        when: () => !paletteOpen,
        context: () => readThreadPanelShortcutContext(threadRef),
      },
    );
  }, [navigate, paletteOpen, threadRef, target]);
  return null;
}
