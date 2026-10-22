import type {
  EnvironmentId,
  ManagedTextResourceCatalogListResult,
  McpCatalogReadResult,
  ProjectId,
  SkillCatalogListResult,
  SkillApplicationSummary,
  ThreadId,
} from "@t3tools/contracts";

export interface ManagedResourceTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly threadId?: ThreadId;
}

export const managedResourceScopeKey = (target: ManagedResourceTarget): string =>
  JSON.stringify([target.environmentId, target.projectId ?? null, target.threadId ?? null]);

export const isCurrentManagedResourceDraft = (
  current: ManagedResourceTarget & { readonly revision: string | number },
  draft: ManagedResourceTarget & { readonly revision: string | number },
): boolean =>
  managedResourceScopeKey(current) === managedResourceScopeKey(draft) &&
  current.revision === draft.revision;

export interface ManagedResourceInventoryRow {
  readonly id: string;
  readonly kind: "skill" | "command" | "snippet" | "mcp";
  readonly source: "managed" | "native";
  readonly key: string;
  readonly name: string;
  readonly scope: string;
  readonly scopeId: string;
  readonly enabled: boolean;
  readonly revision: string | number;
  readonly application?: SkillApplicationSummary;
}

/** Projects the three independent catalogs without copying bodies, transports, or credentials. */
export function composeManagedResourceInventory(input: {
  readonly skills: SkillCatalogListResult;
  readonly text: ManagedTextResourceCatalogListResult;
  readonly mcp: McpCatalogReadResult;
  readonly limit?: number;
}): { readonly rows: ReadonlyArray<ManagedResourceInventoryRow>; readonly truncated: boolean } {
  const limit = Math.min(512, Math.max(0, Math.floor(input.limit ?? 512)));
  const rows: ManagedResourceInventoryRow[] = [];
  let count = 0;
  const add = (row: ManagedResourceInventoryRow) => {
    count++;
    if (rows.length < limit) rows.push(row);
  };
  for (const entry of input.skills.entries) {
    add({
      id: JSON.stringify(["skill", entry.origin, entry.scope, entry.scopeId, entry.id]),
      kind: "skill",
      source: entry.origin,
      key: entry.key,
      name: entry.name,
      scope: entry.scope,
      scopeId: entry.scopeId,
      enabled: entry.effective,
      ...(entry.application ? { application: entry.application } : {}),
      revision: JSON.stringify([entry.revision.revision, entry.revision.hash]),
    });
  }
  for (const entry of input.text.entries) {
    add({
      id: JSON.stringify([entry.kind, entry.scope, entry.scopeId, entry.key]),
      kind: entry.kind,
      source: "managed",
      key: entry.key,
      name: entry.name ?? entry.key,
      scope: entry.scope,
      scopeId: entry.scopeId,
      enabled: entry.effective,
      revision: entry.revision,
    });
  }
  for (const entry of input.mcp.definitions) {
    add({
      id: JSON.stringify(["mcp", entry.definitionId]),
      kind: "mcp",
      source: "managed",
      key: entry.logicalServerId,
      name: entry.name,
      scope: entry.scope,
      scopeId: entry.scopeId,
      enabled: entry.enabled,
      revision: entry.revision,
    });
  }
  return { rows, truncated: count > rows.length };
}
