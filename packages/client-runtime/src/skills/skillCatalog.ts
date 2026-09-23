import type {
  SkillCatalogChanged,
  SkillCatalogListInput,
  SkillCatalogListResult,
  SkillCatalogSummary,
} from "@t3tools/contracts";

const EMPTY_SCOPE = "-";

/** Session overlays address keys, while management catalogs retain every definition. */
export function sessionSkillEntries(entries: ReadonlyArray<SkillCatalogSummary>) {
  const byKey = new Map<string, Extract<SkillCatalogSummary, { readonly origin: "managed" }>>();
  for (const entry of entries) {
    if (entry.origin !== "managed") continue;
    if (entry.compatibility.some((value) => value.support === "unsupported")) continue;
    const current = byKey.get(entry.key);
    if (!current || entry.effective || (!current.effective && entry.scope === "project")) {
      byKey.set(entry.key, entry);
    }
  }
  return [...byKey.values()];
}

/** Availability is desired state; delivery describes what the provider received. */
export function sessionSkillDeliveryLabel(entry: SkillCatalogSummary): string {
  const application = entry.application;
  if (application) {
    const revisions = `desired ${application.desiredRevision}, applied ${application.appliedRevision}`;
    switch (application.status) {
      case "failed":
        return `Delivery failed (${revisions})${application.failure ? `: ${application.failure.message}` : ""}`;
      case "pending_new_session":
        return `Pending new session (${revisions})`;
      case "pending_restart":
        return `Restart required (${revisions})`;
      case "unsupported":
        return "Managed delivery is unsupported";
      case "applied":
        return `Applied (${revisions})`;
    }
  }
  if (entry.compatibility.some((value) => value.support === "unsupported"))
    return "Managed delivery is unsupported";
  return "Delivery has not been reported";
}

export function skillCatalogQueryKey(input: SkillCatalogListInput): string {
  return [
    input.projectId ?? EMPTY_SCOPE,
    input.threadId ?? EMPTY_SCOPE,
    input.providerInstanceId ?? EMPTY_SCOPE,
  ].join(":");
}

function matchesChange(input: SkillCatalogListInput, change: SkillCatalogChanged): boolean {
  switch (change.scope) {
    case "global":
      return true;
    case "project":
      return input.projectId === change.scopeId;
    case "session":
      return input.threadId === change.scopeId;
    case "provider":
      return input.providerInstanceId === undefined || input.providerInstanceId === change.scopeId;
  }
}

interface CachedCatalog {
  readonly input: SkillCatalogListInput;
  readonly result: SkillCatalogListResult;
}

/** Small summary-only cache. Skill bodies remain content-on-demand RPC data. */
export class SkillCatalogCache {
  readonly #entries = new Map<string, CachedCatalog>();

  get size(): number {
    return this.#entries.size;
  }

  get(input: SkillCatalogListInput): SkillCatalogListResult | undefined {
    return this.#entries.get(skillCatalogQueryKey(input))?.result;
  }

  set(input: SkillCatalogListInput, result: SkillCatalogListResult): void {
    this.#entries.set(skillCatalogQueryKey(input), { input: { ...input }, result });
  }

  invalidate(change: SkillCatalogChanged): ReadonlyArray<string> {
    const invalidated: string[] = [];
    for (const [cacheKey, cached] of this.#entries) {
      if (!matchesChange(cached.input, change)) continue;
      this.#entries.delete(cacheKey);
      invalidated.push(cacheKey);
    }
    return invalidated;
  }

  clear(): void {
    this.#entries.clear();
  }
}
