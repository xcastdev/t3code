import type { ProjectScript } from "@t3tools/contracts";

import { primaryProjectScript } from "./projectScripts";

export type ProjectActionSelection =
  | { readonly kind: "add" }
  | { readonly kind: "script"; readonly scriptId: string };

export type ProjectActionMenuIntent =
  | { readonly kind: "open-add-editor" }
  | {
      readonly kind: "select";
      readonly selection: Extract<ProjectActionSelection, { readonly kind: "script" }>;
    };

export function projectActionMenuIntent(
  selection: ProjectActionSelection,
): ProjectActionMenuIntent {
  return selection.kind === "add" ? { kind: "open-add-editor" } : { kind: "select", selection };
}

export function initialProjectActionSelection(
  scripts: ReadonlyArray<ProjectScript>,
  preferredScriptId: string | null,
): ProjectActionSelection {
  if (preferredScriptId && scripts.some((script) => script.id === preferredScriptId)) {
    return { kind: "script", scriptId: preferredScriptId };
  }
  const primaryScript = primaryProjectScript(scripts);
  return primaryScript ? { kind: "script", scriptId: primaryScript.id } : { kind: "add" };
}

export function projectScriptForSelection(
  scripts: ReadonlyArray<ProjectScript>,
  selection: ProjectActionSelection,
): ProjectScript | null {
  if (selection.kind === "add") return null;
  return scripts.find((script) => script.id === selection.scriptId) ?? null;
}
