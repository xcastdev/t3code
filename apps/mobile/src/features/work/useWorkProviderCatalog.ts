import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentServerConfig } from "../../state/entities";
import type { WorkProviderCatalogEntry } from "./workLogic";

/** Every provider the environment reports, enabled or not, so labels still resolve for both. */
export function useWorkProviderCatalog(
  environmentId: EnvironmentId,
): ReadonlyArray<WorkProviderCatalogEntry> {
  return useEnvironmentServerConfig(environmentId)?.providers ?? [];
}
