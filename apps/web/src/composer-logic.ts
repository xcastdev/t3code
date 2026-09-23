import type {
  AssistantCitation,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  serializeAssistantCitation,
  withAssistantCitationComment,
} from "@t3tools/shared/assistantCitations";
import {
  splitPromptIntoComposerSegments,
  type ComposerPromptSegment,
} from "./composer-editor-mentions";
import { parseManagedCommandInvocation } from "@t3tools/client-runtime/managedTextResources";

export type ComposerTriggerKind = "path" | "pull-request" | "snippet" | "slash-command" | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";
export type ComposerSubmissionIntent = "foreground" | "background";

/** A promoted draft may have a route ID before the server projects its thread shell. */
export function composerSkillCatalogInput(input: {
  routeKind: "server" | "draft";
  activeThreadId: ThreadId | null;
  activeThreadShellId: ThreadId | null;
  projectId: ProjectId | null;
  providerInstanceId: ProviderInstanceId;
}) {
  const { routeKind, activeThreadId, activeThreadShellId, projectId, providerInstanceId } = input;
  if (routeKind === "server" && activeThreadId && activeThreadShellId === activeThreadId) {
    return { threadId: activeThreadId, providerInstanceId };
  }
  return { ...(projectId ? { projectId } : {}), providerInstanceId };
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function formatAssistantCitationForComposer(citation: AssistantCitation, comment = "") {
  return `${serializeAssistantCitation(withAssistantCitationComment(citation, comment))} `;
}

export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isDraftThread: boolean;
}): ComposerSubmissionIntent | null {
  if (input.isMobileViewport || input.shiftKey) {
    return null;
  }
  return input.modifierKey && input.isDraftThread ? "background" : "foreground";
}

const isInlineTokenSegment = (segment: ComposerPromptSegment): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "citation" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(segment: ComposerPromptSegment): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<ComposerPromptSegment>,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (
      segment.type === "mention" ||
      segment.type === "citation" ||
      segment.type === "context-reference"
    ) {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  const pullRequestMatch = /^#((?:iss:|pr:)?[\p{L}\p{N}_-]*)$/u.exec(token);
  if (pullRequestMatch) {
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (token.startsWith("!")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const snippetMatch = /^:([A-Za-z0-9_-]*)$/.exec(token);
  if (snippetMatch) {
    return {
      kind: "snippet",
      query: snippetMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

/** Keeps managed commands selectable with an argument while leaving native parsing unchanged. */
export function detectManagedCommandTrigger(
  text: string,
  cursorInput: number,
  availableKeys: ReadonlySet<string>,
): ComposerTrigger | null {
  if (availableKeys.size === 0) return null;
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const invocation = parseManagedCommandInvocation(text.slice(lineStart, cursor));
  if (!invocation || !availableKeys.has(invocation.key)) return null;
  return {
    kind: "slash-command",
    query: invocation.key,
    rangeStart: lineStart,
    rangeEnd: cursor,
  };
}

export function detectComposerTriggerWithManagedCommands(
  text: string,
  cursorInput: number,
  availableKeys: ReadonlySet<string>,
): ComposerTrigger | null {
  return (
    detectComposerTrigger(text, cursorInput) ??
    detectManagedCommandTrigger(text, cursorInput, availableKeys)
  );
}

/** Only an exact slash key can contribute text arguments to an inserted command. */
export function managedCommandArgumentForSelection(
  invocationText: string,
  selectedKey: string,
): string {
  const invocation = parseManagedCommandInvocation(invocationText);
  return invocation?.key === selectedKey ? invocation.argument : "";
}

export function managedCommandNeedsExplicitSelection(input: {
  text: string;
  managedKeys: ReadonlySet<string>;
  nativeKeys: ReadonlySet<string>;
}): boolean {
  const invocation = parseManagedCommandInvocation(input.text);
  return (
    invocation !== null &&
    invocation.argument.trim().length > 0 &&
    input.managedKeys.has(invocation.key) &&
    input.nativeKeys.has(invocation.key)
  );
}

export function managedCommandSubmissionBlockReason(input: {
  text: string;
  managedKeys: ReadonlySet<string>;
  nativeKeys: ReadonlySet<string>;
  catalogReady: boolean;
  resolvedNativeText: string | null;
}): "catalog-pending" | "source-ambiguous" | "managed-selection-required" | null {
  const firstLine = input.text.split(/\r?\n/u, 1)[0] ?? "";
  const invocation = parseManagedCommandInvocation(firstLine);
  if (!invocation || input.resolvedNativeText === input.text) return null;
  if (!input.catalogReady) return input.nativeKeys.has(invocation.key) ? "catalog-pending" : null;
  if (!input.managedKeys.has(invocation.key)) return null;
  return input.nativeKeys.has(invocation.key) ? "source-ambiguous" : "managed-selection-required";
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): Exclude<ComposerSlashCommand, "model"> | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  if (command === "plan") return "plan";
  return "default";
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
