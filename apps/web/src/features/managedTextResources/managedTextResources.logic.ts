import type {
  ManagedTextResourceCatalogRevision,
  ManagedTextResourceSummary,
} from "@t3tools/contracts";

export function pinManagedTextResourceCatalogRevision(
  pinned: ManagedTextResourceCatalogRevision | null,
  current: ManagedTextResourceCatalogRevision | null,
): ManagedTextResourceCatalogRevision | null {
  return pinned ?? current;
}

export function resolveManagedTextResourceState(entry: ManagedTextResourceSummary) {
  const malformed =
    entry.projectState === "invalid" ||
    entry.projectState === "orphan" ||
    (!entry.id && entry.projectState !== "disabled");
  const environmentDisabled =
    entry.environmentState === "disabled" && entry.projectState === "inherit";
  const effective = !malformed && !environmentDisabled && entry.effective;
  return {
    unavailable: malformed,
    effective,
    projectStateLabel: malformed
      ? `Unavailable · ${entry.projectState}`
      : entry.projectState === "disabled"
        ? "Disabled in project"
        : entry.projectState === "override"
          ? "Project override"
          : environmentDisabled
            ? "Disabled in environment"
            : effective
              ? "Inherited · enabled"
              : "Inherited · disabled",
    effectiveLabel: malformed ? "Unavailable" : effective ? "Enabled" : "Disabled",
  } as const;
}

export function resolveManagedTextResourceMutationEffects(
  result: { readonly _tag: "Success" | "Failure" },
  clearEditorOnSuccess: boolean,
) {
  const applied = result._tag === "Success";
  return {
    applied,
    refreshCatalog: applied,
    clearEditor: applied && clearEditorOnSuccess,
  } as const;
}
