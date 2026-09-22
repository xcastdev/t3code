import type { SkillCatalogSummary } from "@t3tools/contracts";

export function mobileSkillSubtitle(entry: SkillCatalogSummary): string {
  const owner = entry.origin === "managed" ? "T3 managed" : "Provider owned";
  return `${owner} · ${entry.projectState === "inherit" ? "inherited" : entry.projectState} · ${entry.effective ? "enabled" : "disabled"}`;
}

export const sessionSkillNextEnabled = (entry: SkillCatalogSummary): boolean => !entry.effective;
