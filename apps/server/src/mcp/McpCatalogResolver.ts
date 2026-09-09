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

export interface CatalogBaselineInput {
  readonly globalDefinitions: ReadonlyArray<McpCatalogDefinition>;
  readonly projectDefinitions: ReadonlyArray<McpCatalogDefinition>;
  readonly projectOverrides: ReadonlyArray<McpCatalogOverride>;
  readonly projectId: string;
}

export interface ResolveSessionCatalogInput {
  /** The fully materialized desired state. Preferred for durable sessions. */
  readonly desired?: ReadonlyArray<McpCatalogDefinition>;
  /** Legacy inputs retained for callers that still compose an old snapshot. */
  readonly baseline?: ReadonlyArray<McpCatalogDefinition>;
  readonly sessionDefinitions?: ReadonlyArray<McpCatalogDefinition>;
  readonly sessionOverrides?: ReadonlyArray<McpCatalogOverride>;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerCapability: ProviderSessionMcpCatalogMode;
}

export type CatalogValidationDefinition = Pick<
  McpCatalogDefinition,
  "logicalServerId" | "scope" | "scopeId" | "name" | "enabled" | "providerInstanceIds"
>;

export type CatalogValidationOverride = Pick<
  McpCatalogOverride,
  "targetId" | "enabled" | "name" | "providerInstanceIds"
>;

export interface ValidateEffectiveCatalogInput {
  readonly definitions: ReadonlyArray<CatalogValidationDefinition>;
  /** Omit to validate every provider assigned to an enabled definition. */
  readonly providerInstanceIds?: ReadonlyArray<ProviderInstanceId>;
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

const applyValidationOverrides = (
  definitions: ReadonlyArray<CatalogValidationDefinition>,
  overrides: ReadonlyArray<CatalogValidationOverride>,
): ReadonlyArray<CatalogValidationDefinition> => {
  const latest = new Map<string, CatalogValidationOverride>();
  for (const override of overrides) latest.set(String(override.targetId), override);
  return definitions.map((definition) => {
    const override = latest.get(String(definition.logicalServerId));
    return override === undefined
      ? definition
      : {
          ...definition,
          ...(override.enabled === undefined ? {} : { enabled: override.enabled }),
          ...(override.name === undefined ? {} : { name: override.name }),
          ...(override.providerInstanceIds === undefined
            ? {}
            : { providerInstanceIds: override.providerInstanceIds }),
        };
  });
};

const selectForProvider = <A extends CatalogValidationDefinition>(
  definitions: ReadonlyArray<A>,
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<A> =>
  definitions.filter(
    (definition) =>
      definition.enabled && definition.providerInstanceIds.includes(providerInstanceId),
  );

const conflictsFor = (
  definitions: ReadonlyArray<CatalogValidationDefinition>,
  providerInstanceId: ProviderInstanceId,
): ReadonlyArray<CatalogValidationDefinition> => {
  const byName = new Map<string, CatalogValidationDefinition[]>();
  for (const definition of selectForProvider(definitions, providerInstanceId)) {
    const key = foldName(definition.name);
    const values = byName.get(key) ?? [];
    values.push(definition);
    byName.set(key, values);
  }
  return [...byName.values()].filter((values) => values.length > 1).flat();
};

/** Validate the provider-facing topology without reading credentials or runtime state. */
export const validateEffectiveCatalog = (input: ValidateEffectiveCatalogInput): void => {
  const providerInstanceIds = input.providerInstanceIds ?? [
    ...new Set(input.definitions.flatMap((definition) => definition.providerInstanceIds)),
  ];
  for (const providerInstanceId of providerInstanceIds) {
    const conflicts = conflictsFor(input.definitions, providerInstanceId);
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
    const enabledCount = selectForProvider(input.definitions, providerInstanceId).length;
    if (enabledCount > 50) {
      throw new McpCatalogProviderLimitExceededError({
        providerInstanceId,
        limit: 50,
      });
    }
  }
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

  validateEffectiveCatalog({ definitions, providerInstanceIds: [providerInstanceId] });

  const entries = toEntries(definitions, providerInstanceId);
  return entries;
};

const scopeDefinitions = (
  definitions: ReadonlyArray<McpCatalogDefinition>,
  scope: McpCatalogScope,
): ReadonlyArray<McpCatalogDefinition> =>
  definitions.filter((definition) => definition.scope === scope);

/** Capture the global/project state that a new catalog session should start with. */
export const catalogBaselineForProject = (input: CatalogBaselineInput) => [
  ...applyOverrides(
    scopeDefinitions(input.globalDefinitions, "global"),
    input.projectOverrides
      .filter((entry) => entry.scopeId === input.projectId)
      .map((entry) => entry),
  ),
  ...input.projectDefinitions.filter(
    (definition) => definition.scope === "project" && definition.scopeId === input.projectId,
  ),
];

export const effectiveCatalogForProject = catalogBaselineForProject;

export const applyMcpCatalogValidationOverrides = applyValidationOverrides;

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

/** Resolve a logical session against its current desired snapshot. */
export const resolveSessionCatalog = (
  input: ResolveSessionCatalogInput,
): ReadonlyArray<ResolvedMcpCatalogEntry> => {
  const desired =
    input.desired ??
    applyOverrides(input.baseline ?? [], input.sessionOverrides ?? []).concat(
      scopeDefinitions(input.sessionDefinitions ?? [], "session"),
    );
  return resolve(desired, input.providerInstanceId, input.providerCapability);
};

export const applyMcpCatalogOverrides = applyOverrides;
