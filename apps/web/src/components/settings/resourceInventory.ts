import type { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export {
  skillActions,
  skillReloadBaseline,
  skillEntryId,
  skillKeyCollisions,
  textResourceActions,
} from "@t3tools/client-runtime/resource-actions";

/** The one destination a resources view reads and writes; never broadened on failure. */
export interface ResourceSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  /** The thread's provider, which owns its skill session overlay. */
  readonly providerInstanceId: ProviderInstanceId | null;
}

export function resourceCatalogInput(target: ResourceSettingsTarget) {
  return {
    ...(target.projectId === null ? {} : { projectId: target.projectId }),
    ...(target.threadId === null ? {} : { threadId: target.threadId }),
  };
}

/**
 * The one checkout a project view writes to. A project with several
 * checkouts on this environment has no single answer, so the view asks.
 */
export function resolveResourceCheckout<Member extends { readonly id: ProjectId }>(
  members: ReadonlyArray<Member>,
):
  | { readonly kind: "single"; readonly projectId: ProjectId }
  | { readonly kind: "ambiguous"; readonly members: ReadonlyArray<Member> }
  | { readonly kind: "none" } {
  if (members.length === 0) return { kind: "none" };
  if (members.length === 1) return { kind: "single", projectId: members[0]!.id };
  return { kind: "ambiguous", members };
}

export type InventoryKindFilter = "all" | "mcp" | "skill" | "command" | "snippet";

export function matchesResourceQuery(query: string, ...values: ReadonlyArray<string | undefined>) {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || values.some((value) => value?.toLowerCase().includes(needle));
}
