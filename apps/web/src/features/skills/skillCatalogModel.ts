import type { SkillApplicationStatus, SkillCatalogSummary } from "@t3tools/contracts";

export function skillSurfaceSections(entries: ReadonlyArray<SkillCatalogSummary>) {
  return {
    managed: entries.filter((entry) => entry.origin === "managed"),
    native: entries.filter((entry) => entry.origin === "native"),
  };
}

const STATUS_LABELS: Readonly<Record<SkillApplicationStatus, string>> = {
  applied: "Applied",
  pending_new_session: "Available in a new session",
  pending_restart: "Restart required",
  failed: "Delivery failed",
  unsupported: "Discovery only",
};

export const skillStatusLabel = (status: SkillApplicationStatus): string => STATUS_LABELS[status];

export const compatibilityLabel = (entry: SkillCatalogSummary): string => {
  if (entry.compatibility.length === 0) return "Provider compatibility not evaluated";
  if (entry.compatibility.some((value) => value.support === "unsupported")) {
    return "Some providers are discovery only";
  }
  if (entry.compatibility.some((value) => value.support === "supported_with_limitations")) {
    return "Supported with limits";
  }
  return "Supported";
};
