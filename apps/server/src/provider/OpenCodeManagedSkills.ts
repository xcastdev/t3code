// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export interface OpenCodeManagedSkillPlanPayload {
  readonly kind: "opencode-managed-skills";
  readonly root: string;
  readonly configDir: string;
  readonly skillKeys: ReadonlyArray<string>;
}

export function isOpenCodeManagedSkillPlanPayload(
  value: unknown,
): value is OpenCodeManagedSkillPlanPayload {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === "opencode-managed-skills" &&
    typeof record.root === "string" &&
    typeof record.configDir === "string" &&
    Array.isArray(record.skillKeys) &&
    record.skillKeys.every((key) => typeof key === "string")
  );
}

export function missingOpenCodeManagedSkills(
  skills: ReadonlyArray<{ readonly name: string; readonly location: string }>,
  plan: OpenCodeManagedSkillPlanPayload,
): string[] {
  return plan.skillKeys.filter(
    (key) =>
      !skills.some(
        (skill) =>
          skill.name === key &&
          NodePath.resolve(skill.location) === NodePath.join(plan.root, key, "SKILL.md"),
      ),
  );
}
