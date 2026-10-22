import type {
  ManagedTextResourceContentGetResult,
  ManagedTextResourceSummary,
} from "@t3tools/contracts";
import { managedResourceScopeKey, type ManagedResourceTarget } from "../state/managedResources.ts";
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

export type ManagedTextResourceInsertionResult =
  | { readonly status: "inserted"; readonly text: string; readonly cursor: number }
  | { readonly status: "stale-resource" }
  | { readonly status: "draft-changed" }
  | { readonly status: "target-changed" }
  | { readonly status: "invalid-range" };

/** Validates a selected revision and returns ordinary draft text without sending it. */
export function resolveManagedTextResourceInsertion(input: {
  readonly selectedTarget: ManagedResourceTarget;
  readonly currentTarget: ManagedResourceTarget;
  readonly selected: ManagedTextResourceSummary;
  readonly content: ManagedTextResourceContentGetResult;
  readonly currentEntries: ReadonlyArray<ManagedTextResourceSummary>;
  readonly draft: string;
  readonly expectedDraft: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly argument?: string;
}): ManagedTextResourceInsertionResult {
  if (
    managedResourceScopeKey(input.selectedTarget) !== managedResourceScopeKey(input.currentTarget)
  )
    return { status: "target-changed" };
  if (
    !Number.isInteger(input.rangeStart) ||
    !Number.isInteger(input.rangeEnd) ||
    input.rangeStart < 0 ||
    input.rangeEnd < input.rangeStart ||
    input.rangeEnd > input.draft.length
  )
    return { status: "invalid-range" };
  if (input.draft !== input.expectedDraft) return { status: "draft-changed" };

  const selectedId = input.selected.id;
  const current = input.currentEntries.find(
    (entry) =>
      entry.kind === input.selected.kind &&
      entry.key === input.selected.key &&
      entry.id === selectedId,
  );
  if (
    (input.selected.scope === "environment" &&
      input.selected.scopeId !== input.selectedTarget.environmentId) ||
    (input.selected.scope === "project" &&
      input.selectedTarget.projectId !== undefined &&
      input.selected.scopeId !== input.selectedTarget.projectId) ||
    !selectedId ||
    !current ||
    !current.effective ||
    current.scope !== input.selected.scope ||
    current.scopeId !== input.selected.scopeId ||
    current.projectState === "disabled" ||
    current.projectState === "invalid" ||
    current.projectState === "orphan" ||
    current.revision !== input.selected.revision ||
    input.content.kind !== input.selected.kind ||
    input.content.id !== selectedId ||
    input.content.key !== input.selected.key ||
    input.content.revision !== input.selected.revision
  ) {
    return { status: "stale-resource" };
  }

  const insertion =
    input.selected.kind === "command"
      ? insertManagedCommand(
          input.draft,
          input.rangeStart,
          input.rangeEnd,
          input.content.body,
          input.argument ?? "",
        )
      : insertManagedSnippet(input.draft, input.rangeStart, input.rangeEnd, input.content.body);
  return { status: "inserted", ...insertion };
}

export const managedResourceInsertionTargetKey = managedResourceScopeKey;

export function findManagedCommandCollision(
  key: string,
  managed: ReadonlyArray<ManagedTextResourceSummary>,
  nativeKeys: ReadonlyArray<string>,
): boolean {
  return (
    nativeKeys.includes(key) &&
    managed.some((entry) => entry.kind === "command" && entry.key === key && entry.effective)
  );
}

export type ManagedCommandSourceChoice = "managed" | "native";

/** A matching native command needs an explicit source before managed content can expand. */
export function resolveManagedCommandSource(input: {
  readonly key: string;
  readonly managed: ReadonlyArray<ManagedTextResourceSummary>;
  readonly nativeKeys: ReadonlyArray<string>;
  readonly choice?: ManagedCommandSourceChoice;
}): ManagedCommandSourceChoice | "choose-source" | "missing" {
  const managed = input.managed.some(
    (entry) => entry.kind === "command" && entry.key === input.key && entry.effective,
  );
  const native = input.nativeKeys.includes(input.key);
  if (input.choice === "managed") return managed ? "managed" : "missing";
  if (input.choice === "native") return native ? "native" : "missing";
  if (managed && native) return "choose-source";
  return managed ? "managed" : native ? "native" : "missing";
}
