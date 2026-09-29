import type {
  EnvironmentId,
  ManagedTextResourceCatalogListResult,
  McpCatalogGlobalState,
  McpCatalogProjectState,
  ProjectId,
  SkillCatalogListResult,
} from "@t3tools/contracts";

import { makeSkillItemTarget, makeTextItemTarget, type ResourceTarget } from "./resourceTarget";

export type InventoryKind = "mcp" | "skill" | "command" | "snippet";
export type InventoryOwnerScope = "environment" | "project" | "provider";

export interface ResourceInventoryRow {
  readonly key: string;
  readonly kind: InventoryKind;
  readonly name: string;
  readonly identity: string;
  readonly ownerScope: InventoryOwnerScope;
  readonly status: string;
  readonly statusDetail?: string;
  readonly target: ResourceTarget;
  readonly diagnostic?: "skill" | "orphan-mcp";
}

export interface ResourceInventoryInput {
  readonly environmentId: EnvironmentId;
  readonly skills?: SkillCatalogListResult | undefined;
  readonly textResources?: ManagedTextResourceCatalogListResult | undefined;
  readonly globalMcp?: McpCatalogGlobalState | undefined;
  readonly projectMcp?: McpCatalogProjectState | undefined;
  readonly projectId?: ProjectId | undefined;
}

function rowKey(kind: InventoryKind, scope: InventoryOwnerScope, identity: string): string {
  return `${kind}:${scope}:${identity}`;
}

function skillRows(
  catalog: SkillCatalogListResult | undefined,
  environmentId: EnvironmentId,
): ResourceInventoryRow[] {
  if (!catalog) return [];
  const entries = catalog.entries.flatMap((entry): ResourceInventoryRow[] => {
    if (entry.origin !== "managed") return [];
    const scope = entry.scope === "project" ? "project" : "environment";
    return [
      {
        key: rowKey("skill", scope, entry.id),
        kind: "skill",
        name: entry.name,
        identity: entry.key,
        ownerScope: scope,
        status: entry.validity === "invalid" ? "invalid" : entry.projectState,
        statusDetail: entry.effective ? "effective" : "not effective",
        target: makeSkillItemTarget(
          scope,
          scope === "environment" ? environmentId : entry.scopeId,
          "skill",
          entry.id,
        ),
      },
    ];
  });
  const diagnostics = (catalog.diagnostics ?? []).map((diagnostic): ResourceInventoryRow => {
    const scope = diagnostic.scope === "project" ? "project" : "environment";
    const locator = `${diagnostic.scope}:${diagnostic.scopeId}:${diagnostic.name}`;
    return {
      key: rowKey("skill", scope, `diagnostic:${locator}`),
      kind: "skill",
      name: diagnostic.name,
      identity: diagnostic.name,
      ownerScope: scope,
      status: "invalid definition",
      statusDetail: diagnostic.reasons.map((reason) => reason.message).join("; "),
      target: makeSkillItemTarget(
        scope,
        scope === "environment" ? environmentId : diagnostic.scopeId,
        "diagnostic",
        locator,
      ),
      diagnostic: "skill",
    };
  });
  return [...entries, ...diagnostics];
}

function textRows(
  catalog: ManagedTextResourceCatalogListResult | undefined,
): ResourceInventoryRow[] {
  return (catalog?.entries ?? []).map((entry): ResourceInventoryRow => ({
    key: rowKey(entry.kind, entry.scope, `${entry.key}:${entry.scopeId}`),
    kind: entry.kind,
    name: entry.name ?? entry.key,
    identity: entry.key,
    ownerScope: entry.scope,
    status:
      entry.projectState === "inherit"
        ? (entry.environmentState ?? (entry.effective ? "active" : "disabled"))
        : entry.projectState,
    statusDetail: entry.effective ? "effective" : "not effective",
    target: makeTextItemTarget(entry),
  }));
}

function mcpStatus(enabled: boolean, providers: readonly unknown[], prefix = ""): string {
  const assigned =
    providers.length > 0 ? `assigned to ${providers.length} providers` : "no providers assigned";
  return `${prefix}${enabled ? "enabled" : "disabled"} · ${assigned}`;
}

function mcpRows(input: ResourceInventoryInput): ResourceInventoryRow[] {
  if (input.projectMcp) {
    const state = input.projectMcp;
    const overridesByTarget = new Map(
      state.projectOverrides.map((override) => [override.targetId, override]),
    );
    const inheritedIds = new Set(
      state.globalDefinitions.map((definition) => definition.logicalServerId),
    );
    const definitions = [...state.globalDefinitions, ...state.projectDefinitions];
    const rows = definitions.map((definition): ResourceInventoryRow => {
      const inherited = definition.scope === "global";
      const override = inherited ? overridesByTarget.get(definition.logicalServerId) : undefined;
      const enabled = override?.enabled ?? definition.enabled;
      const identity = override
        ? { identity: "override" as const, id: override.id }
        : { identity: "definition" as const, id: definition.definitionId };
      return {
        key: rowKey("mcp", "project", definition.definitionId),
        kind: "mcp",
        name: override?.name ?? definition.name,
        identity: definition.logicalServerId,
        ownerScope: override ? "project" : inherited ? "environment" : "project",
        status: mcpStatus(
          enabled,
          override?.providerInstanceIds ?? definition.providerInstanceIds,
          override ? "overridden · " : inherited ? "inherited · " : "",
        ),
        target: {
          namespace: "t3-resource",
          version: 1,
          kind: "mcp",
          scope: "project",
          scopeId:
            input.projectId ??
            state.projectDefinitions[0]?.scopeId ??
            state.projectOverrides[0]?.scopeId ??
            "",
          intent: "item",
          ...identity,
        },
      };
    });
    const orphans = state.projectOverrides
      .filter((override) => !inheritedIds.has(override.targetId))
      .map((override): ResourceInventoryRow => ({
        key: rowKey("mcp", "project", `orphan:${override.id}`),
        kind: "mcp",
        name: override.name ?? override.targetId,
        identity: override.targetId,
        ownerScope: "project",
        status: "orphaned override",
        statusDetail:
          "The inherited server definition is unavailable. Remove this override to recover.",
        target: {
          namespace: "t3-resource",
          version: 1,
          kind: "mcp",
          scope: "project",
          scopeId: override.scopeId,
          intent: "item",
          identity: "orphan-override",
          id: override.id,
        },
        diagnostic: "orphan-mcp",
      }));
    return [...rows, ...orphans];
  }
  return (input.globalMcp?.definitions ?? []).map((definition): ResourceInventoryRow => ({
    key: rowKey("mcp", "environment", definition.definitionId),
    kind: "mcp",
    name: definition.name,
    identity: definition.logicalServerId,
    ownerScope: "environment",
    status: mcpStatus(definition.enabled, definition.providerInstanceIds),
    target: {
      namespace: "t3-resource",
      version: 1,
      kind: "mcp",
      scope: "environment",
      scopeId: definition.scopeId,
      intent: "item",
      identity: "definition",
      id: definition.definitionId,
    },
  }));
}

/** Project safe catalog summaries without carrying content or credential fields into the view. */
export function projectResourceInventory(input: ResourceInventoryInput): ResourceInventoryRow[] {
  return [
    ...skillRows(input.skills, input.environmentId),
    ...textRows(input.textResources),
    ...mcpRows(input),
  ];
}
