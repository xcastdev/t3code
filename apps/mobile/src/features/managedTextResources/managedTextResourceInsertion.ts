import type {
  ManagedTextResourceContentGetResult,
  ManagedTextResourceSummary,
} from "@t3tools/contracts";
import {
  insertManagedCommand,
  insertManagedSnippet,
} from "@t3tools/client-runtime/managedTextResources";

export type ManagedTextResourceInsertionResult =
  | { readonly status: "inserted"; readonly text: string; readonly cursor: number }
  | { readonly status: "stale-resource" }
  | { readonly status: "draft-changed" };

/** Validates a selected revision and returns ordinary draft text without sending it. */
export function resolveManagedTextResourceInsertion(input: {
  readonly selected: ManagedTextResourceSummary;
  readonly content: ManagedTextResourceContentGetResult;
  readonly currentEntries: ReadonlyArray<ManagedTextResourceSummary>;
  readonly draft: string;
  readonly expectedDraft: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
  readonly argument?: string;
}): ManagedTextResourceInsertionResult {
  if (input.draft !== input.expectedDraft) return { status: "draft-changed" };

  const selectedId = input.selected.id;
  const current = input.currentEntries.find(
    (entry) =>
      entry.kind === input.selected.kind &&
      entry.key === input.selected.key &&
      entry.id === selectedId,
  );
  if (
    !selectedId ||
    !current ||
    !current.effective ||
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
