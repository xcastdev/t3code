import { replaceTextRange } from "@t3tools/shared/composerTrigger";

export type ManagedTextResourceMenuSource = "managed" | "native";

/** Parses one leading managed command and its remaining text argument. */
export function parseManagedCommandInvocation(
  text: string,
): { key: string; argument: string } | null {
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:[ \t]+([^\r\n]*))?$/.exec(text);
  if (!match) return null;
  return { key: match[1] ?? "", argument: match[2] ?? "" };
}

/** Replaces every placeholder or appends a nonempty argument after the template. */
export function expandManagedCommandTemplate(template: string, argument: string): string {
  if (template.includes("$ARGUMENTS")) {
    return template.replaceAll("$ARGUMENTS", () => argument);
  }

  if (argument.trim().length === 0) return template;
  if (template.length === 0) return argument;

  return `${template}${template.endsWith("\n") ? "" : "\n"}${argument}`;
}

/** Expands the selected revision and replaces only the selected command text. */
export function insertManagedCommand(
  draft: string,
  rangeStart: number,
  rangeEnd: number,
  template: string,
  argument: string,
): { text: string; cursor: number } {
  return replaceTextRange(
    draft,
    rangeStart,
    rangeEnd,
    expandManagedCommandTemplate(template, argument),
  );
}

/** Replaces the active snippet trigger range and returns the caret after the inserted text. */
export function insertManagedSnippet(
  draft: string,
  rangeStart: number,
  rangeEnd: number,
  snippet: string,
): { text: string; cursor: number } {
  return replaceTextRange(draft, rangeStart, rangeEnd, snippet);
}

/** Keeps a managed resource separate from a provider-native item with the same key. */
export function managedTextResourceMenuItemId(
  source: ManagedTextResourceMenuSource,
  key: string,
): string {
  return `${source}:${key}`;
}
