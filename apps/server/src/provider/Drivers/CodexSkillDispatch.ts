import { findComposerSkillMentions } from "./ComposerSkillDispatch.ts";
import { findRawNativeSkillMention } from "@t3tools/shared/composerTrigger";

export interface CodexAvailableSkill {
  readonly name: string;
  readonly path: string;
}

export interface CodexComposerSkillDispatch {
  readonly prompt: string;
  readonly skills: ReadonlyArray<CodexAvailableSkill>;
  readonly rawSkillMention?: string;
}

/**
 * Codex parses `$name` from every text input as a native tool or skill mention.
 * T3 uses `!name`, so selected skills travel as structured app-server inputs.
 * Reject known native skill spellings instead of silently changing user text.
 */
export function dispatchCodexComposerSkills(
  prompt: string,
  availableSkills: ReadonlyArray<CodexAvailableSkill>,
): CodexComposerSkillDispatch {
  const byName = new Map(availableSkills.map((skill) => [skill.name, skill]));
  const selected = new Map<string, CodexAvailableSkill>();
  for (const mention of findComposerSkillMentions(prompt)) {
    const skill = byName.get(mention.name);
    if (skill) selected.set(skill.name, skill);
  }

  const rawSkillMention = findRawNativeSkillMention(prompt, new Set(byName.keys()));
  if (rawSkillMention) {
    return { prompt, skills: [...selected.values()], rawSkillMention };
  }

  return { prompt, skills: [...selected.values()] };
}
