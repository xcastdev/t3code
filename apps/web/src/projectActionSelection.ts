import type { ProjectScript } from "@t3tools/contracts";
import { primaryProjectScript } from "./projectScripts";

export type ProjectActionSelection =
  | { readonly kind: "add" }
  | { readonly kind: "script"; readonly scriptId: string };
export function initialProjectActionSelection(
  scripts: readonly ProjectScript[],
  preferredScriptId: string | null,
): ProjectActionSelection {
  if (preferredScriptId && scripts.some((script) => script.id === preferredScriptId))
    return { kind: "script", scriptId: preferredScriptId };
  const primary = primaryProjectScript(scripts);
  return primary ? { kind: "script", scriptId: primary.id } : { kind: "add" };
}
export function projectScriptForSelection(
  scripts: readonly ProjectScript[],
  selection: ProjectActionSelection,
): ProjectScript | null {
  return selection.kind === "script"
    ? (scripts.find((script) => script.id === selection.scriptId) ?? null)
    : null;
}
export function resolveProjectActionSelection(
  scripts: readonly ProjectScript[],
  preferredScriptId: string | null,
  selection: ProjectActionSelection | null,
): ProjectActionSelection {
  return selection && projectScriptForSelection(scripts, selection)
    ? selection
    : initialProjectActionSelection(scripts, preferredScriptId);
}
