import type { ServerProvider, ServerProviderCatalogPayload } from "@t3tools/contracts";

/** Overlay cwd-scoped provider capabilities onto the cached provider snapshot. */
export function mergeServerProviderCatalogs(
  providers: ReadonlyArray<ServerProvider>,
  catalog: ServerProviderCatalogPayload,
): ReadonlyArray<ServerProvider> {
  if (catalog.providers.length === 0) {
    return providers;
  }

  const byInstanceId = new Map(catalog.providers.map((entry) => [entry.instanceId, entry]));
  let changed = false;
  const merged = providers.map((provider) => {
    const entry = byInstanceId.get(provider.instanceId);
    if (entry === undefined) {
      return provider;
    }
    changed = true;
    return {
      ...provider,
      slashCommands: entry.slashCommands,
      skills: entry.skills,
    };
  });

  return changed ? merged : providers;
}
