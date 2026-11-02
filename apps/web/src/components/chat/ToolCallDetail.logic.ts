// Claude's Read tool prefixes each line with its number and a tab or an arrow.
const NUMBERED_LINE = /^\s*(\d+)(?:\t|→)(.*)$/;

/**
 * Splits a file read's line numbers from its text, so the numbers sit in a gutter and the code
 * highlights cleanly. Output without numbers on every line comes back unchanged, unnumbered.
 */
export function splitNumberedReadOutput(text: string): {
  readonly code: string;
  readonly firstLine: number | null;
} {
  const lines = text.replace(/\n+$/, "").split("\n");
  const numbered = lines.map((line) => NUMBERED_LINE.exec(line));
  const first = numbered[0];
  if (first === null || first === undefined || numbered.some((match) => match === null)) {
    return { code: text, firstLine: null };
  }
  const firstLine = Number(first[1]);
  const consecutive = numbered.every((match, index) => Number(match![1]) === firstLine + index);
  if (!consecutive) return { code: text, firstLine: null };
  return { code: numbered.map((match) => match![2]).join("\n"), firstLine };
}

/** A path's folder and file name, so the name can stand out from where it lives. */
export function splitPathForDisplay(path: string): {
  readonly folder: string;
  readonly name: string;
} {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0
    ? { folder: "", name: path }
    : { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

const FILE_CONTENT_KEYS = new Set(["content", "new_string", "old_string", "new_str", "old_str"]);
const FILE_PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"];

/** The file a tool call writes to, when its arguments carry that file's text to highlight. */
export function toolArgsFilePath(args: ReadonlyArray<readonly [string, string]>): string | null {
  if (!args.some(([key]) => FILE_CONTENT_KEYS.has(key))) return null;
  return args.find(([key]) => FILE_PATH_KEYS.includes(key))?.[1] ?? null;
}

export function isFilePathArg(key: string): boolean {
  return FILE_PATH_KEYS.includes(key);
}

export function isFileContentArg(key: string): boolean {
  return FILE_CONTENT_KEYS.has(key);
}

interface ClaudeStructuredHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: ReadonlyArray<string>;
}

function isStructuredHunk(value: unknown): value is ClaudeStructuredHunk {
  if (typeof value !== "object" || value === null) return false;
  const hunk = value as Record<string, unknown>;
  return (
    typeof hunk.oldStart === "number" &&
    typeof hunk.oldLines === "number" &&
    typeof hunk.newStart === "number" &&
    typeof hunk.newLines === "number" &&
    Array.isArray(hunk.lines) &&
    hunk.lines.every((line) => typeof line === "string")
  );
}

function patchHeader(fileName: string, created = false): string {
  return `--- ${created ? "/dev/null" : fileName}\n+++ ${fileName}\n`;
}

function additionsPatch(fileName: string, content: string): string | null {
  const lines = content.replace(/\n$/, "").split("\n");
  if (content.length === 0) return null;
  return `${patchHeader(fileName, true)}@@ -0,0 +1,${lines.length} @@\n${lines
    .map((line) => `+${line}`)
    .join("\n")}`;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A file change as one unified patch, whichever shape the provider stored: a git patch, bare
 * hunks, a new file's contents, or Claude's structured edit result. Null when what was stored is
 * a message about the change rather than the change itself.
 */
export function fileChangePatch(item: {
  readonly fileName: string;
  readonly diffStr?: string | undefined;
  readonly changes?: ReadonlyArray<{ readonly operation: string }> | undefined;
}): string | null {
  const text = item.diffStr?.trim() ?? "";
  if (text.length === 0) return null;
  if (/^(?:diff --git |--- )/.test(text)) return text;
  if (/^@@ /m.test(text)) return `${patchHeader(item.fileName)}${text}`;
  const structured = parseJsonRecord(text);
  if (structured) {
    const hunks = Array.isArray(structured.structuredPatch)
      ? structured.structuredPatch.filter(isStructuredHunk)
      : [];
    if (hunks.length > 0) {
      return `${patchHeader(item.fileName)}${hunks
        .map(
          (hunk) =>
            `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
        )
        .join("\n")}`;
    }
    return structured.type === "create" && typeof structured.content === "string"
      ? additionsPatch(item.fileName, structured.content)
      : null;
  }
  return item.changes?.[0]?.operation === "add"
    ? additionsPatch(item.fileName, item.diffStr!)
    : null;
}
