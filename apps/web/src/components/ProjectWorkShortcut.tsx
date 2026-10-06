import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useProjectWorkTarget } from "../hooks/useProjectWorkTarget";
import { resolveShortcutCommand } from "../keybindings";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { primaryServerKeybindingsAtom } from "~/state/server";

export function ProjectWorkShortcut({
  paletteOpen,
  terminalOpen,
  previewOpen,
}: {
  paletteOpen: boolean;
  terminalOpen: boolean;
  previewOpen: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const target = useProjectWorkTarget();
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || paletteOpen || !target) return;
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
      void navigate({ to: "/work/$environmentId/$projectId", params: target });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, navigate, paletteOpen, previewOpen, target, terminalOpen]);
  return null;
}
