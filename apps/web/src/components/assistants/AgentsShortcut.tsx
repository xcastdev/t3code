import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { readThreadPanelShortcutContext } from "../../shortcuts/commandPaletteCommands";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";

/** The `agents.open` keybinding; it opens the same page as the palette, sidebar and Settings. */
export function AgentsShortcut({ paletteOpen }: { readonly paletteOpen: boolean }) {
  const routeTarget = useThreadRouteTarget();
  const threadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const navigate = useNavigate();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the agents.open command with the shortcut dispatcher and removes it on change or unmount
  useEffect(() => {
    return registerCommands(
      {
        "agents.open": (event) => {
          event.preventDefault();
          event.stopPropagation();
          void navigate({ to: "/agents" });
        },
      },
      {
        when: () => !paletteOpen,
        context: () => readThreadPanelShortcutContext(threadRef),
      },
    );
  }, [navigate, paletteOpen, threadRef]);
  return null;
}
