import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useProjectWorkTarget } from "../../hooks/useProjectWorkTarget";
import { resolveShortcutCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";

/** The `projectWork.open` keybinding; it opens the same target as the palette and Settings. */
export function ProjectWorkShortcut({
  paletteOpen,
  terminalOpen,
  previewOpen,
}: {
  readonly paletteOpen: boolean;
  readonly terminalOpen: boolean;
  readonly previewOpen: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const target = useProjectWorkTarget();
  const navigate = useNavigate();
  useEffect(() => {
    if (target === null) return;
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
      if (command !== "projectWork.open") return;
      event.preventDefault();
      event.stopPropagation();
      void navigate({
        to: "/work/$environmentId/$projectId",
        params: { environmentId: target.environmentId, projectId: target.projectId },
        search: { section: "overview" },
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigate, paletteOpen, previewOpen, target, terminalOpen]);
  return null;
}
