/**
 * Composer skills use `!name` in every client. Provider adapters translate the
 * token to the prefix their native prompt parser recognizes.
 */
const COMPOSER_SKILL_PATTERN =
  /(^|\s)!(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface ComposerSkillMention {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

export function findComposerSkillMentions(prompt: string): ReadonlyArray<ComposerSkillMention> {
  return [...prompt.matchAll(COMPOSER_SKILL_PATTERN)].map((match) => {
    const name = match[2] ?? "";
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    return { name, start, end: start + name.length + 1 };
  });
}

export function dispatchComposerSlashSkill(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string {
  const selected = findComposerSkillMentions(prompt)
    .filter((mention) => skillNames.has(mention.name))
    .at(-1);
  if (!selected) return prompt;

  const remaining = `${prompt.slice(0, selected.start)}${prompt.slice(selected.end)}`.trim();
  return `/${selected.name}${remaining ? ` ${remaining}` : ""}`;
}
