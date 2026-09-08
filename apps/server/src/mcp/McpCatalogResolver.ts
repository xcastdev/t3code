import {
  McpCatalogNameConflictError,
  McpCatalogProviderLimitExceededError,
  type McpCatalogDefinition,
  type McpCatalogOverride,
  type McpCatalogScope,
  type ProviderInstanceId,
  type ResolvedMcpCatalogEntry,
} from "@t3tools/contracts";

export type ProviderSessionMcpCatalogMode = "live" | "restart-required" | "unsupported";

export interface ResolveProjectCatalogInput {
  readonly globalDefinitions: ReadonlyArray<McpCatalogDefinition>;
  readonly projectDefinitions: ReadonlyArray<McpCatalogDefinition>;
  readonly projectOverrides: ReadonlyArray<McpCatalogOverride>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerCapability: ProviderSessionMcpCatalogMode;
}

export interface ResolveSessionCatalogInput {
  /** Captured global + project effective definitions at session start. */
  readonly baseline: ReadonlyArray<McpCatalogDefinition>;
  readonly sessionDefinitions: ReadonlyArray<McpCatalogDefinition>;
  readonly sessionOverrides: ReadonlyArray<McpCatalogOverride>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerCapability: ProviderSessionMcpCatalogMode;
}

const foldName = (name: string): string => name.toLocaleLowerCase();

const applyOverride = (
  definition: McpCatalogDefinition,
  override: McpCatalogOverride,
): McpCatalogDefinition => ({
  ...definition,
  ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
  ...(override.name === undefined ? {} : { name: override.name }),
  ...(override.providerInstanceIds === undefined
    ? {}
    : { providerInstanceIds: override.providerInstanceIds }),
  ...(override.transport === undefined
    ? {}
    : {
        transport: override.transport,
        definitionId: override.transportDefinitionId!,
      }),
});

const applyOverrides = (
  definitions: ReadonlyArray<McpCatalogDefinition>,
  overrides: ReadonlyArray<McpCatalogOverride>,
): ReadonlyArray<McpCatalogDefinition> => {
  const latest = new Map<string, McpCatalogOverride>();
  for (const override of overrides) latest.set(String(override.targetId), override);
  return definitions.map((definition) => {
    const override = latest.get(String(definition.logicalServerId));
    return override === undefined ? definition : applyOverride(definition, override);
  });
};

const selectForProvider = (
  definitions: ReadonlyArray<McpCatalogDefinition>,
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<McpCatalogDefinition> =>
  definitions.filter(
    (definition) =>
      definition.enabled && definition.providerInstanceIds.includes(providerInstanceId),
  );

const conflictsFor = (
  definitions: ReadonlyArray<McpCatalogDefinition>,
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<McpCatalogDefinition> => {
  const byName = new Map<string, McpCatalogDefinition[]>();
  for (const definition of selectForProvider(definitions, providerInstanceId)) {
    const key = foldName(definition.name);
    const values = byName.get(key) ?? [];
    values.push(definition);
    byName.set(key, values);
  }
  return [...byName.values()].filter((values) => values.length > 1).flat();
};

const toEntries = (
  definitions: ReadonlyArray<McpCatalogDefinition>,
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<ResolvedMcpCatalogEntry> =>
  selectForProvider(definitions, providerInstanceId).map((definition) => ({
    logicalServerId: definition.logicalServerId,
    transportDefinitionId: definition.definitionId,
    name: definition.name,
    transport: definition.transport,
    providerInstanceId,
    scope: definition.scope,
    scopeId: definition.scopeId,
  }));

const resolve = (
  definitions: ReadonlyArray<McpCatalogDefinition>,
  providerInstanceId: ProviderInstanceId,
  providerCapability: ProviderSessionMcpCatalogMode,
): ReadonlyArray<ResolvedMcpCatalogEntry> => {
  if (providerCapability === "unsupported") return [];

  const conflicts = conflictsFor(definitions, providerInstanceId);
  if (conflicts.length > 0) {
    throw new McpCatalogNameConflictError({
      conflicts: conflicts.map((definition) => ({
        logicalServerId: definition.logicalServerId,
        name: definition.name,
        scope: definition.scope,
        scopeId: definition.scopeId,
        providerInstanceIds: definition.providerInstanceIds,
      })),
    });
  }

  const entries = toEntries(definitions, providerInstanceId);
  if (entries.length > 50) {
    throw new McpCatalogProviderLimitExceededError({
      providerInstanceId,
      limit: 50,
    });
  }
  return entries;
};

const scopeDefinitions = (
  definitions: ReadonlyArray<McpCatalogDefinition>,
  scope: McpCatalogScope,
): ReadonlyArray<McpCatalogDefinition> =>
  definitions.filter((definition) => definition.scope === scope);

/** Resolve global defaults, project overrides, and project-local definitions. */
export const resolveProjectCatalog = (
  input: ResolveProjectCatalogInput,
): ReadonlyArray<ResolvedMcpCatalogEntry> => {
  const global = applyOverrides(
    scopeDefinitions(input.globalDefinitions, "global"),
    input.projectOverrides,
  );
  const projectLocal = scopeDefinitions(input.projectDefinitions, "project");
  return resolve([...global, ...projectLocal], input.providerInstanceId, input.providerCapability);
};

/** Resolve a logical session against its immutable baseline snapshot. */
export const resolveSessionCatalog = (
  input: ResolveSessionCatalogInput,
): ReadonlyArray<ResolvedMcpCatalogEntry> => {
  const baseline = applyOverrides(input.baseline, input.sessionOverrides);
  const sessionLocal = scopeDefinitions(input.sessionDefinitions, "session");
  return resolve(
    [...baseline, ...sessionLocal],
    input.providerInstanceId,
    input.providerCapability,
  );
};

export const applyMcpCatalogOverrides = applyOverrides;
