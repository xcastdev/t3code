import type { ServerProviderSlashCommand } from "./server.ts";

interface ShellToken {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function parseShellTokens(input: string): ReadonlyArray<ShellToken> {
  const tokens: Array<ShellToken> = [];
  let value = "";
  let tokenStart = -1;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  const append = (character: string, index: number) => {
    if (tokenStart === -1) tokenStart = index;
    value += character;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === undefined) continue;
    if (escaped) {
      append(character, index - 1);
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (tokenStart === -1) tokenStart = index;
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else {
        append(character, index);
      }
      continue;
    }
    if (character === '"' || character === "'") {
      if (tokenStart === -1) tokenStart = index;
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStart !== -1) {
        tokens.push({ value, start: tokenStart, end: index });
        value = "";
        tokenStart = -1;
      }
      continue;
    }
    append(character, index);
  }

  if (escaped) append("\\", input.length - 1);
  if (tokenStart !== -1) {
    tokens.push({ value, start: tokenStart, end: input.length });
  }
  return tokens;
}

function replacePositionalArguments(template: string, tokens: ReadonlyArray<ShellToken>): string {
  const references = [...template.matchAll(/\$(\d+)/g)];
  const lastPosition = Math.max(...references.map(([, numberText]) => Number(numberText)));
  let referenceIndex = 0;
  return template.replace(/\$(\d+)/g, (placeholder, numberText) => {
    const number = Number(numberText);
    const reference = references[referenceIndex];
    referenceIndex += 1;
    if (!reference || !Number.isSafeInteger(number) || number < 1) {
      return placeholder;
    }
    const tokenIndex = number - 1;
    return number === lastPosition
      ? tokens
          .slice(tokenIndex)
          .map((token) => token.value)
          .join(" ")
      : (tokens[tokenIndex]?.value ?? "");
  });
}

/** Expand one leading provider slash command into its displayed prompt text. */
export function expandOpenCodeCommandTemplate(
  input: string,
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): string {
  const match = /^\/([^\s]+)([\s\S]*)$/.exec(input);
  if (!match) return input;

  const command = commands.find(
    (candidate) => candidate.name.toLowerCase() === match[1]?.toLowerCase(),
  );
  const template = command?.template?.trim();
  if (!template) return input;

  const argumentText = match[2]?.trim() ?? "";
  const hasArgumentsPlaceholder = template.includes("$ARGUMENTS");
  const hasPositionalPlaceholder = /\$\d+/.test(template);
  if (!hasArgumentsPlaceholder && !hasPositionalPlaceholder) {
    return argumentText.length > 0 ? `${template}\n\n${argumentText}` : template;
  }

  const tokens = parseShellTokens(argumentText);
  return replacePositionalArguments(template.replace(/\$ARGUMENTS/g, argumentText), tokens);
}
