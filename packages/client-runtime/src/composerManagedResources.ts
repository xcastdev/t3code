import type {
  ManagedTextResourceSummary,
  SkillCatalogSummary,
  SkillContentDetail,
  SkillManagedCatalogSummary,
} from "@t3tools/contracts";
import { replaceTextRange } from "@t3tools/shared/composerTrigger";

import { managedTextResourceMenuItemId } from "./managedTextResources/managedTextResources.ts";
import { managedResourceScopeKey, type ManagedResourceTarget } from "./state/managedResources.ts";
import { skillEntryId } from "./resourceActions.ts";
import { sessionSkillEntries } from "./skills/skillCatalog.ts";

const MENU_LIMIT = 20;

function matches(query: string, ...values: ReadonlyArray<string | undefined>): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || values.some((value) => value?.toLowerCase().includes(needle));
}

export interface ManagedTextMenuItem {
  readonly id: string;
  readonly entry: ManagedTextResourceSummary & {
    readonly id: NonNullable<ManagedTextResourceSummary["id"]>;
  };
  /** A provider command shares this key; the row must say which one it inserts. */
  readonly collidesWithNative: boolean;
}

/** Commands and snippets this destination can insert right now. */
export function managedTextMenuItems(input: {
  readonly entries: ReadonlyArray<ManagedTextResourceSummary>;
  readonly query: string;
  readonly nativeCommandNames: ReadonlyArray<string>;
}): ReadonlyArray<ManagedTextMenuItem> {
  const items: ManagedTextMenuItem[] = [];
  for (const entry of input.entries) {
    if (items.length >= MENU_LIMIT) break;
    const id = entry.id;
    if (
      id === undefined ||
      !entry.effective ||
      entry.projectState === "disabled" ||
      entry.projectState === "invalid" ||
      entry.projectState === "orphan" ||
      !matches(input.query, entry.key, entry.name)
    )
      continue;
    items.push({
      id: `managed-text:${entry.kind}:${managedTextResourceMenuItemId("managed", entry.key)}`,
      entry: { ...entry, id },
      collidesWithNative: entry.kind === "command" && input.nativeCommandNames.includes(entry.key),
    });
  }
  return items;
}

export interface ManagedSkillMenuItem {
  readonly id: string;
  readonly entry: SkillManagedCatalogSummary;
  readonly collidesWithNative: boolean;
}

/**
 * Managed skills keep their own source-qualified identity next to provider
 * skills with the same name; neither replaces the other in the menu.
 */
export function managedSkillMenuItems(input: {
  readonly entries: ReadonlyArray<SkillCatalogSummary>;
  readonly query: string;
  readonly nativeSkillNames: ReadonlyArray<string>;
}): ReadonlyArray<ManagedSkillMenuItem> {
  return sessionSkillEntries(input.entries)
    .filter((entry) => entry.effective && entry.validity === "valid")
    .filter((entry) => matches(input.query, entry.key, entry.name))
    .slice(0, MENU_LIMIT)
    .map((entry) => ({
      id: `managed-skill:${skillEntryId(entry)}`,
      entry,
      collidesWithNative: input.nativeSkillNames.includes(entry.key),
    }));
}

/**
 * Where the typed trigger token ends. The caret can sit inside it (`/rev|iew`),
 * and the whole token is what a selection replaces.
 */
export function composerTriggerTokenEnd(draft: string, cursor: number): number {
  let end = Math.max(0, Math.min(draft.length, cursor));
  while (end < draft.length && !/\s/u.test(draft[end] ?? "")) end++;
  return end;
}

/**
 * The text a command receives as `$ARGUMENTS`: the rest of its line after the
 * complete command token. The replaced range grows to cover it so it is not
 * duplicated.
 */
export function managedCommandArgumentRange(
  draft: string,
  cursor: number,
): { readonly argument: string; readonly rangeEnd: number } {
  const tokenEnd = composerTriggerTokenEnd(draft, cursor);
  const lineEnd = draft.indexOf("\n", tokenEnd);
  const end = lineEnd === -1 ? draft.length : lineEnd;
  const rest = draft.slice(tokenEnd, end);
  return rest.trim().length === 0
    ? { argument: "", rangeEnd: tokenEnd }
    : { argument: rest.trim(), rangeEnd: end };
}

/**
 * What a pending managed insertion was started against. Content arrives after
 * an await, so it lands only if nothing here moved: the composer that owns the
 * draft, its resource destination, the provider whose catalog authorizes a
 * skill, the text, the caret and both ends of the selection, and the request
 * epoch (bumped by Escape, dismissal, caret or provider moves, a newer
 * selection and unmount). Selecting text without moving the caret changes only
 * the selection end, so the caret alone is not enough.
 */
export interface ComposerInsertionSnapshot {
  readonly epoch: number;
  readonly ownerKey: string;
  readonly target: ManagedResourceTarget;
  readonly providerInstanceId: string | null;
  readonly draft: string;
  readonly cursor: number;
  readonly selection: { readonly start: number; readonly end: number };
}

export function isComposerInsertionCurrent(
  selected: ComposerInsertionSnapshot,
  current: ComposerInsertionSnapshot,
): boolean {
  return (
    selected.epoch === current.epoch &&
    selected.ownerKey === current.ownerKey &&
    managedResourceScopeKey(selected.target) === managedResourceScopeKey(current.target) &&
    selected.providerInstanceId === current.providerInstanceId &&
    selected.draft === current.draft &&
    selected.cursor === current.cursor &&
    selected.selection.start === current.selection.start &&
    selected.selection.end === current.selection.end
  );
}

/**
 * The pending-insertion guard both composers share. `begin` invalidates any
 * older pending insertion and captures `read()` now; its `isCurrent` calls
 * `read()` again after the await, so it compares live editor state rather
 * than values from the render that started it. `read` returns null when no
 * insertion is possible.
 */
export function createComposerInsertionGuard() {
  let epoch = 0;
  type Read = () => Omit<ComposerInsertionSnapshot, "epoch"> | null;
  const snapshot = (read: Read): ComposerInsertionSnapshot | null => {
    const current = read();
    return current === null ? null : { ...current, epoch };
  };
  return {
    /** Abandons whatever insertion is pending. */
    cancel: () => {
      epoch++;
    },
    begin: (read: Read) => {
      epoch++;
      const selected = snapshot(read);
      if (selected === null) return null;
      return {
        selected,
        isCurrent: () => {
          const current = snapshot(read);
          return current !== null && isComposerInsertionCurrent(selected, current);
        },
      };
    },
  };
}

const attribute = (value: string | number) =>
  `"${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`;

/**
 * A managed skill as ordinary draft text. Providers cannot look managed skills
 * up by key, so the verified body travels with the message, labeled with the
 * exact package it came from.
 */
export function managedSkillInstructionBlock(detail: SkillContentDetail): string {
  const { metadata, content } = detail;
  const assets = content.assetPaths ?? [];
  return [
    `<managed-skill key=${attribute(metadata.key)} name=${attribute(metadata.name)} source=${attribute(
      metadata.scope,
    )} scope-id=${attribute(metadata.scopeId)} id=${attribute(metadata.id)} revision=${attribute(
      metadata.revision.revision,
    )} hash=${attribute(metadata.revision.hash)}>`,
    content.body.trimEnd(),
    ...(assets.length === 0
      ? []
      : [`(Bundled files not included in this message: ${assets.join(", ")})`]),
    "</managed-skill>",
  ].join("\n");
}

export type ManagedSkillInsertionResult =
  | { readonly status: "inserted"; readonly text: string; readonly cursor: number }
  | { readonly status: "stale-resource" }
  | { readonly status: "invalid-range" };

/**
 * Inserts the selected managed skill only if the fetched package and the
 * reread catalog both still name the exact revision the user picked.
 */
export function resolveManagedSkillInsertion(input: {
  readonly selected: SkillManagedCatalogSummary;
  readonly content: SkillContentDetail;
  readonly currentEntries: ReadonlyArray<SkillCatalogSummary>;
  readonly draft: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}): ManagedSkillInsertionResult {
  const { selected, content } = input;
  if (
    !Number.isInteger(input.rangeStart) ||
    !Number.isInteger(input.rangeEnd) ||
    input.rangeStart < 0 ||
    input.rangeEnd < input.rangeStart ||
    input.rangeEnd > input.draft.length
  )
    return { status: "invalid-range" };
  const current = input.currentEntries.find(
    (entry) => entry.origin === "managed" && entry.id === selected.id,
  );
  const sameRevision = (revision: SkillManagedCatalogSummary["revision"]) =>
    revision.revision === selected.revision.revision && revision.hash === selected.revision.hash;
  if (
    current === undefined ||
    !current.effective ||
    current.validity !== "valid" ||
    current.key !== selected.key ||
    current.scope !== selected.scope ||
    current.scopeId !== selected.scopeId ||
    !sameRevision(current.revision) ||
    content.metadata.id !== selected.id ||
    content.metadata.key !== selected.key ||
    content.metadata.scope !== selected.scope ||
    content.metadata.scopeId !== selected.scopeId ||
    !sameRevision(content.metadata.revision)
  )
    return { status: "stale-resource" };
  return {
    status: "inserted",
    ...replaceTextRange(
      input.draft,
      input.rangeStart,
      input.rangeEnd,
      `${managedSkillInstructionBlock(content)}\n`,
    ),
  };
}
