import type {
  ManagedTextResourceContentGetResult,
  ManagedTextResourceSummary,
  McpCatalogDefinition,
  McpCatalogOverride,
  SkillCatalogSummary,
  SkillContentDetail,
  SkillDeploymentTargetSummary,
} from "@t3tools/contracts";

/** Where an editor acts: environment-wide, one project, or one thread's session overlay. */
export interface ResourceActionContext {
  readonly projectId: string | null;
  readonly threadId: string | null;
}

/** Source-qualified identity; two entries with one key never share a row or a menu item. */
export function skillEntryId(entry: SkillCatalogSummary): string {
  return JSON.stringify([entry.origin, entry.scope, entry.scopeId, entry.id]);
}

/** Keys offered by more than one source, so each row can name where it comes from. */
export function skillKeyCollisions(entries: ReadonlyArray<SkillCatalogSummary>): Set<string> {
  const sources = new Map<string, Set<string>>();
  for (const entry of entries) {
    const source =
      entry.origin === "managed"
        ? `managed:${entry.scope}:${entry.scopeId}`
        : `native:${entry.scopeId}`;
    const set = sources.get(entry.key) ?? new Set<string>();
    set.add(source);
    sources.set(entry.key, set);
  }
  return new Set([...sources].flatMap(([key, set]) => (set.size > 1 ? [key] : [])));
}

export type SkillAction =
  | "edit"
  | "rename"
  | "history"
  | "delete"
  | "install"
  | "override"
  | "edit-override"
  | "rename-override"
  | "disable-project"
  | "reset-project"
  | "session-enable"
  | "session-disable"
  | "session-reset"
  | "view-native"
  | "import-native";

/**
 * Session overlays are keyed by skill key only, so toggling one changes
 * whichever package wins that key for the thread. Only the winning managed
 * package may offer it; a shadowed package with the same key never does.
 */
export function isSessionSkillOwner(
  entry: SkillCatalogSummary,
  entries: ReadonlyArray<SkillCatalogSummary>,
): boolean {
  if (entry.origin !== "managed" || entry.conflict?.kind === "shadowed") return false;
  if (entry.effective) return true;
  // Turned off for the thread, nothing wins the key; a project package outranks the environment one.
  return !entries.some(
    (other) =>
      other !== entry &&
      other.key === entry.key &&
      (other.effective ||
        (entry.scope === "global" && other.origin === "managed" && other.scope === "project")),
  );
}

/**
 * Actions that the catalog accepts for this entry at this destination. A
 * thread destination adds session overlays, only for the package that wins
 * its key there; it never edits shared packages.
 */
export function skillActions(
  entry: SkillCatalogSummary,
  context: ResourceActionContext,
  entries: ReadonlyArray<SkillCatalogSummary> = [entry],
): ReadonlyArray<SkillAction> {
  if (entry.origin === "native") {
    const actions: SkillAction[] = [];
    if (entry.validity === "valid") actions.push("view-native");
    if (context.threadId === null && context.projectId === null) actions.push("import-native");
    return actions;
  }
  if (context.threadId !== null) {
    if (
      entry.projectState === "disabled" ||
      entry.projectState === "orphan" ||
      !isSessionSkillOwner(entry, entries)
    )
      return [];
    return [entry.effective ? "session-disable" : "session-enable", "session-reset"];
  }
  if (context.projectId === null) {
    return entry.scope === "global" ? ["edit", "rename", "history", "install", "delete"] : [];
  }
  switch (entry.projectState) {
    case "inherit":
      return entry.scope === "global" ? ["override", "disable-project", "install"] : [];
    case "override":
      return entry.scope === "project"
        ? ["edit-override", "rename-override", "install", "reset-project", "disable-project"]
        : ["reset-project"];
    case "disabled":
    case "orphan":
      return ["reset-project"];
  }
}

export type TextResourceAction =
  | "edit"
  | "disable"
  | "enable"
  | "delete"
  | "override"
  | "edit-override"
  | "disable-project"
  | "reset-project"
  | "thread-enable"
  | "thread-disable"
  | "thread-reset";

export function textResourceActions(
  entry: ManagedTextResourceSummary,
  context: ResourceActionContext,
  threadOverlay: boolean,
): ReadonlyArray<TextResourceAction> {
  if (context.threadId !== null) {
    // An unusable source can't be switched, but the thread's own overlay can always be removed.
    if (entry.projectState === "invalid" || entry.projectState === "orphan")
      return threadOverlay ? ["thread-reset"] : [];
    const toggle: TextResourceAction = entry.effective ? "thread-disable" : "thread-enable";
    return threadOverlay ? [toggle, "thread-reset"] : [toggle];
  }
  if (context.projectId === null) {
    if (entry.scope !== "environment" || entry.id === undefined) return [];
    return ["edit", entry.environmentState === "disabled" ? "enable" : "disable", "delete"];
  }
  switch (entry.projectState) {
    case "inherit":
      return entry.scope === "environment" ? ["override", "disable-project"] : [];
    case "override":
      return entry.scope === "project"
        ? ["edit-override", "disable-project", "reset-project"]
        : ["reset-project"];
    case "disabled":
    case "invalid":
    case "orphan":
      return ["reset-project"];
  }
}

/**
 * Thread overlays whose source is no longer listed (deleted, reset, or never
 * valid here). They still decide the key's state if it comes back, so they
 * stay visible and resettable on their own.
 */
export function orphanedThreadTextOverlays<
  O extends { readonly kind: ManagedTextResourceSummary["kind"]; readonly key: string },
>(
  entries: ReadonlyArray<ManagedTextResourceSummary>,
  overlays: ReadonlyArray<O>,
): ReadonlyArray<O> {
  const listed = new Set(entries.map((entry) => `${entry.kind}:${entry.key}`));
  return overlays.filter((overlay) => !listed.has(`${overlay.kind}:${overlay.key}`));
}

export function managedTextResourceScopeLabel(entry: ManagedTextResourceSummary): string {
  if (entry.scope === "project") {
    if (entry.projectState === "override") return "Project override";
    return "Project";
  }
  if (entry.projectState === "disabled") return "Environment · off in this project";
  if (entry.environmentState === "disabled") return "Environment · off";
  return "Environment";
}

function tagOf(error: unknown): string | null {
  return error !== null &&
    typeof error === "object" &&
    "_tag" in error &&
    typeof error._tag === "string"
    ? error._tag
    : null;
}

function field(error: unknown, key: string): string | null {
  if (error === null || typeof error !== "object" || !(key in error)) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Actionable wording for skill, command/snippet and MCP catalog failures. */
export function describeResourceFailure(error: unknown): string {
  switch (tagOf(error)) {
    case "EnvironmentAuthorizationError":
      return "This connection isn't allowed to change these resources on this environment.";
    case "ManagedTextResourceRpcError":
    case "SkillRpcError": {
      const code = field(error, "code");
      if (code === "revision-conflict" || code === "revision_conflict")
        return "This changed somewhere else. Review the current version and try again.";
      if (code === "destination_collision" || code === "already-exists")
        return "Something with this name already exists there. Choose another name.";
      return field(error, "message") ?? "The environment rejected this change.";
    }
    case "McpCatalogStaleRevisionError":
      return "This catalog changed somewhere else. Review the current servers and try again.";
    case "McpCatalogStaleSessionError":
      return "This thread started a new session. Reopen its servers and try again.";
    case "McpCatalogNameConflictError":
      return "Another server with this name reaches the same provider. Rename one of them.";
    case "McpCatalogProviderLimitExceededError":
      return "That provider already has the most MCP servers it can expose.";
    case "McpCatalogUnsupportedProviderError":
      return "That provider can't receive MCP servers from T3 Code.";
    case "McpCatalogOperationError":
      return field(error, "message") ?? "The environment rejected this change.";
    default:
      return "The environment couldn't complete this. Check the connection and try again.";
  }
}

/**
 * What an open editor was loaded from. Saves use these tokens only; a newer
 * catalog never replaces them while the draft is kept.
 */
export interface ResourceEditorBaseline {
  /** The catalog revision a create or project write is checked against, if it uses one. */
  readonly catalogRevision: number | null;
  /** The edited entry's revision or content hash, or null for a new entry. */
  readonly entryRevision: string | number | null;
}

export type ResourceEditorConflict = "removed" | "changed" | null;

/**
 * Compares an editor's baseline with the live catalog. `liveEntryRevision` is
 * undefined when the edited entry is gone. A conflict keeps the draft and
 * needs an explicit reload; saving would be rejected anyway.
 */
export function resourceEditorConflict(
  baseline: ResourceEditorBaseline,
  live: {
    readonly catalogRevision: number;
    readonly entryRevision: string | number | undefined;
  },
): ResourceEditorConflict {
  if (baseline.entryRevision !== null) {
    if (live.entryRevision === undefined) return "removed";
    if (live.entryRevision !== baseline.entryRevision) return "changed";
  }
  if (baseline.catalogRevision !== null && baseline.catalogRevision !== live.catalogRevision)
    return "changed";
  return null;
}

/**
 * The catalog revision a reloaded skill editor may save against: only when the
 * catalog read after the content still names that exact package revision.
 * Otherwise nothing is adopted and the draft stays.
 */
export function skillReloadBaseline<R>(
  source: { readonly id: string; readonly scope: string },
  detail: SkillContentDetail,
  catalog: { readonly entries: ReadonlyArray<SkillCatalogSummary>; readonly catalogRevision: R },
): R | null {
  if (detail.metadata.id !== source.id) return null;
  const entry = catalog.entries.find(
    (candidate) =>
      candidate.origin === "managed" &&
      candidate.id === source.id &&
      candidate.scope === source.scope,
  );
  return entry !== undefined && entry.revision.hash === detail.metadata.revision.hash
    ? catalog.catalogRevision
    : null;
}

/**
 * The entry a text editor should reload: the current catalog's entry with the
 * same kind and key, whatever revision it is at now. A reload must ask for that
 * revision, not the one the editor was opened from.
 */
export function textReloadEntry(
  opened: { readonly kind: ManagedTextResourceSummary["kind"]; readonly key: string },
  entries: ReadonlyArray<ManagedTextResourceSummary>,
): ManagedTextResourceSummary | null {
  return entries.find((entry) => entry.kind === opened.kind && entry.key === opened.key) ?? null;
}

/** Whether loaded text content is exactly the entry a reload asked for. */
export function isTextReloadCurrent(
  entry: ManagedTextResourceSummary,
  content: Pick<ManagedTextResourceContentGetResult, "id" | "kind" | "revision">,
): boolean {
  return (
    entry.id !== undefined &&
    content.id === entry.id &&
    content.kind === entry.kind &&
    content.revision === entry.revision
  );
}

export type SkillDeploymentAction = "install" | "update" | "uninstall";

/**
 * What one install folder allows. For a skill (`skillKey`), an empty folder
 * can receive it and its own T3 Code copy can be updated or removed. Without a
 * skill, any T3 Code copy can be removed, including one whose skill was
 * renamed or deleted. A copy edited outside T3 Code is never touched.
 */
export function skillDeploymentActions(
  item: Pick<SkillDeploymentTargetSummary, "status" | "key">,
  skillKey: string | null,
): ReadonlyArray<SkillDeploymentAction> {
  if (skillKey === null)
    return item.status === "owned" && item.key !== undefined ? ["uninstall"] : [];
  if (item.status === "absent") return ["install"];
  if (item.status === "owned" && (item.key === undefined || item.key === skillKey))
    return ["update", "uninstall"];
  return [];
}

/**
 * The MCP definitions a destination effectively has: inherited ones with its
 * overrides applied, then its own. For read-only views; editors keep the raw
 * definitions and overrides apart.
 */
export function effectiveMcpCatalogDefinitions(input: {
  readonly inherited: ReadonlyArray<McpCatalogDefinition>;
  readonly own: ReadonlyArray<McpCatalogDefinition>;
  readonly overrides: ReadonlyArray<McpCatalogOverride>;
}): ReadonlyArray<McpCatalogDefinition> {
  return [
    ...input.inherited.map((definition) => {
      const override = input.overrides.find(
        (candidate) => candidate.targetId === definition.logicalServerId,
      );
      return override === undefined
        ? definition
        : {
            ...definition,
            name: override.name ?? definition.name,
            enabled: override.enabled ?? definition.enabled,
            providerInstanceIds: override.providerInstanceIds ?? definition.providerInstanceIds,
            transport: override.transport ?? definition.transport,
          };
    }),
    ...input.own,
  ];
}
