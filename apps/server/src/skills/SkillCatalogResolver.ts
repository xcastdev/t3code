import type { SkillNativeDiscoveryResult, SkillNativeObservation } from "@t3tools/contracts";
import { ManagedSkillKey } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type {
  SkillCatalogDiagnostic,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
} from "./SkillCatalogIndex.ts";

export interface SkillSessionResolutionOverlay {
  readonly key: ManagedSkillKey;
  readonly enabled: boolean;
}

export interface ResolvedManagedCandidate extends SkillCatalogEntry {
  readonly scope: "global" | "project";
  readonly scopeId: string;
  readonly candidateIndex: number;
}

export interface ResolvedSkillKey {
  readonly key: string;
  readonly candidates: ReadonlyArray<ResolvedManagedCandidate>;
  readonly winner?: ResolvedManagedCandidate;
  readonly projectState: "inherit" | "override" | "disabled" | "orphan";
  readonly validity: "valid" | "invalid";
  readonly effective: boolean;
  readonly sessionEnabled?: boolean;
  readonly diagnostics: ReadonlyArray<SkillCatalogDiagnostic>;
  readonly nativeCollisions: ReadonlyArray<SkillNativeObservation>;
}

export interface ResolvedSkillCatalog {
  readonly catalogRevision: number;
  readonly byKey: ReadonlyMap<string, ResolvedSkillKey>;
  readonly diagnostics: ReadonlyArray<{
    readonly scope: "global" | "project";
    readonly scopeId: string;
    readonly name: string;
    readonly reasons: ReadonlyArray<SkillCatalogDiagnostic>;
  }>;
}

const isPortableKey = Schema.is(ManagedSkillKey);
const hasPortableKey = (entry: SkillCatalogEntry) => isPortableKey(entry.key);

export interface ResolveSkillCatalogInput {
  readonly global: SkillCatalogSnapshot;
  readonly project?: SkillCatalogSnapshot;
  readonly session?: ReadonlyArray<SkillSessionResolutionOverlay>;
  readonly nativeDiscoveries?: ReadonlyArray<SkillNativeDiscoveryResult>;
}

const duplicateDiagnostic = (scope: "global" | "project", key: string) => ({
  code: `duplicate_${scope}_key`,
  message: `Multiple ${scope} skill definitions use the key '${key}'.`,
});

const groupEntries = (
  snapshot: SkillCatalogSnapshot | undefined,
): ReadonlyMap<string, ReadonlyArray<ResolvedManagedCandidate>> => {
  const grouped = new Map<string, Array<ResolvedManagedCandidate>>();
  snapshot?.entries.forEach((entry, candidateIndex) => {
    if (!hasPortableKey(entry)) return;
    const candidates = grouped.get(entry.key) ?? [];
    candidates.push({
      ...entry,
      scope: snapshot.scope,
      scopeId: snapshot.scopeId,
      candidateIndex,
    });
    grouped.set(entry.key, candidates);
  });
  return grouped;
};

const singleValid = (entries: ReadonlyArray<ResolvedManagedCandidate>) =>
  entries.length === 1 && entries[0]?.validity === "valid" ? entries[0] : undefined;

export const resolveSkillCatalog = (input: ResolveSkillCatalogInput): ResolvedSkillCatalog => {
  const globals = groupEntries(input.global);
  const projects = groupEntries(input.project);
  const overlays = new Map(input.session?.map((overlay) => [overlay.key, overlay.enabled]));
  const nativeByKey = new Map<string, Array<SkillNativeObservation>>();
  for (const observation of (input.nativeDiscoveries ?? []).flatMap(
    (discovery) => discovery.observations,
  )) {
    const observations = nativeByKey.get(observation.key) ?? [];
    observations.push(observation);
    nativeByKey.set(observation.key, observations);
  }

  const keys = [...new Set([...globals.keys(), ...projects.keys(), ...nativeByKey.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );
  const byKey = new Map<string, ResolvedSkillKey>();

  for (const key of keys) {
    const globalEntries = globals.get(key) ?? [];
    const projectEntries = projects.get(key) ?? [];
    const globalWinner = singleValid(globalEntries);
    const projectWinner = singleValid(projectEntries);
    const diagnostics: Array<SkillCatalogDiagnostic> = [
      ...globalEntries.flatMap((entry) => entry.diagnostics),
      ...projectEntries.flatMap((entry) => entry.diagnostics),
    ];
    if (globalEntries.length > 1) diagnostics.push(duplicateDiagnostic("global", key));
    if (projectEntries.length > 1) diagnostics.push(duplicateDiagnostic("project", key));

    const projectState = (() => {
      if (projectEntries.length === 0) return "inherit" as const;
      if (projectEntries.length !== 1) return globalWinner === undefined ? "orphan" : "override";
      if (projectWinner?.state === "disabled") {
        return globalWinner === undefined ? ("orphan" as const) : ("disabled" as const);
      }
      return projectWinner?.state === "override"
        ? ("override" as const)
        : globalWinner === undefined
          ? ("orphan" as const)
          : ("override" as const);
    })();

    const projectBlocksInheritance = projectEntries.length > 0;
    const winner =
      projectWinner?.state === "override"
        ? projectWinner
        : projectWinner?.state === "disabled"
          ? globalWinner
          : projectBlocksInheritance
            ? undefined
            : globalWinner;
    const sessionEnabled = overlays.get(key as ManagedSkillKey);
    const baseEnabled = winner !== undefined && projectState !== "disabled";
    const effective =
      winner !== undefined && (sessionEnabled === undefined ? baseEnabled : sessionEnabled);
    const validity =
      (projectBlocksInheritance && projectWinner === undefined) ||
      (!projectBlocksInheritance && globalEntries.length > 0 && globalWinner === undefined)
        ? "invalid"
        : "valid";

    byKey.set(key, {
      key,
      candidates: [...globalEntries, ...projectEntries],
      ...(winner === undefined ? {} : { winner }),
      projectState,
      validity,
      effective,
      ...(sessionEnabled === undefined ? {} : { sessionEnabled }),
      diagnostics,
      nativeCollisions: (nativeByKey.get(key) ?? []).sort((left, right) =>
        left.nativeIdentity.localeCompare(right.nativeIdentity),
      ),
    });
  }

  return {
    catalogRevision: Math.max(input.global.catalogRevision, input.project?.catalogRevision ?? 0),
    byKey,
    diagnostics: [input.global, ...(input.project === undefined ? [] : [input.project])].flatMap(
      (snapshot) =>
        snapshot.entries
          .filter((entry) => !hasPortableKey(entry))
          .map((entry) => ({
            scope: snapshot.scope,
            scopeId: snapshot.scopeId,
            name: entry.key,
            reasons:
              entry.diagnostics.length === 0
                ? [{ code: "invalid_key", message: "This package has no portable skill key." }]
                : entry.diagnostics,
          })),
    ),
  };
};
