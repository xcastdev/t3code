import { findComposerSkillMentions } from "./ComposerSkillDispatch.ts";

export interface OpenCodeSkillContent {
  readonly name: string;
  readonly content: string;
}

/** Return selected native skill bodies for direct session-context injection. */
export function selectedOpenCodeSkillInstructions(
  prompt: string,
  skills: ReadonlyArray<OpenCodeSkillContent>,
): string | undefined {
  const available = new Map(skills.map((skill) => [skill.name, skill.content]));
  const selectedNames = [
    ...new Set(findComposerSkillMentions(prompt).map(({ name }) => name)),
  ].filter((name) => available.has(name));
  if (selectedNames.length === 0) return undefined;

  return selectedNames
    .map((name) => `<selected_skill name="${name}">\n${available.get(name)}\n</selected_skill>`)
    .join("\n\n");
}
