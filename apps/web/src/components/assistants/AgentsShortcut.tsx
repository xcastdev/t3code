import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";

/** The `agents.open` keybinding; it opens the same page as the palette, sidebar and Settings. */
export function AgentsShortcut({
  paletteOpen,
  terminalOpen,
  previewOpen,
}: {
  readonly paletteOpen: boolean;
  readonly terminalOpen: boolean;
  readonly previewOpen: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || paletteOpen) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
        },
      });
      if (command !== "agents.open") return;
      event.preventDefault();
      event.stopPropagation();
      void navigate({ to: "/agents" });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigate, paletteOpen, previewOpen, terminalOpen]);
  return null;
}
