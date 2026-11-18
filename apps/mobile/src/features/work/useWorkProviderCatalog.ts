import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentServerConfig } from "../../state/entities";
import type { WorkProviderCatalogEntry } from "@t3tools/client-runtime/project-work-logic";

/** Every provider the environment reports, enabled or not, so labels still resolve for both. */
export function useWorkProviderCatalog(
  environmentId: EnvironmentId,
): ReadonlyArray<WorkProviderCatalogEntry> {
  return useEnvironmentServerConfig(environmentId)?.providers ?? [];
}
