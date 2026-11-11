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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the projectWork.open command with the shortcut dispatcher and removes it on change or unmount
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
