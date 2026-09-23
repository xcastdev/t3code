/** Codex treats a raw `$name` as a native skill reference when `name` is installed. */
export function findRawNativeSkillMention(
  prompt: string,
  skillNames: ReadonlySet<string>,
): string | undefined {
  for (const match of prompt.matchAll(/\$([A-Za-z0-9][A-Za-z0-9:_-]*)/gu)) {
    const name = match[1];
    if (name && skillNames.has(name)) return name;
  }
  return undefined;
}
