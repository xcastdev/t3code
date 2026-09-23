// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type {
  ManagedSkillId,
  ManagedSkillKey,
  SkillCatalogListResult,
  SkillCatalogRevision,
  SkillCatalogSummary,
  SkillCompatibility,
  SkillContentHash,
} from "@t3tools/contracts";

import type {
  ResolvedManagedCandidate,
  ResolvedSkillCatalog,
  ResolvedSkillKey,
} from "./SkillCatalogResolver.ts";

export interface SkillCatalogProjectionOptions {
  readonly compatibilityByKey?: ReadonlyMap<ManagedSkillKey, ReadonlyArray<SkillCompatibility>>;
}

const synthetic = (prefix: string, value: string) =>
  `${prefix}-${NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

const candidateSummary = (
  resolved: ResolvedSkillKey,
  candidate: ResolvedManagedCandidate,
  options: SkillCatalogProjectionOptions,
): SkillCatalogSummary => {
  const isWinner = candidate === resolved.winner;
  const effective = isWinner && resolved.effective;
  const conflict = (() => {
    if (resolved.validity === "invalid") {
      return {
        kind: "conflict" as const,
        keys: [resolved.key as ManagedSkillKey],
        message: resolved.diagnostics.map((item) => item.message).join(" ") || "Invalid skill.",
      };
    }
    if (!isWinner) {
      return {
        kind: "shadowed" as const,
        keys: [resolved.key as ManagedSkillKey],
        message: "A more specific managed definition wins for this key.",
      };
    }
    if (resolved.nativeCollisions.length > 0) {
      return {
        kind: "shadows" as const,
        keys: [resolved.key as ManagedSkillKey],
        message: "The provider has native definitions with the same key.",
      };
    }
    return undefined;
  })();
  return {
    origin: "managed",
    id:
      candidate.skillId ??
      (synthetic(
        "invalid",
        `${candidate.scopeId}:${resolved.key}:${candidate.candidateIndex}`,
      ) as ManagedSkillId),
    key: resolved.key as ManagedSkillKey,
    name: candidate.name ?? resolved.key,
    scope: candidate.scope,
    scopeId: candidate.scopeId,
    projectState: resolved.projectState,
    revision: {
      revision: candidate.revision ?? 0,
      hash:
        candidate.hash ??
        (synthetic(
          "invalid",
          `${candidate.scopeId}:${resolved.key}:${candidate.candidateIndex}`,
        ) as SkillContentHash),
    },
    validity: candidate.validity,
    effective,
    compatibility: [...(options.compatibilityByKey?.get(resolved.key as ManagedSkillKey) ?? [])],
    ...(conflict === undefined ? {} : { conflict }),
  };
};

export const projectSkillCatalog = (
  resolved: ResolvedSkillCatalog,
  options: SkillCatalogProjectionOptions = {},
): SkillCatalogListResult => {
  const entries: Array<SkillCatalogSummary> = [];
  for (const item of resolved.byKey.values()) {
    entries.push(...item.candidates.map((candidate) => candidateSummary(item, candidate, options)));
    for (const observation of item.nativeCollisions) {
      const managedDeliverySupported =
        item.effective &&
        options.compatibilityByKey
          ?.get(item.key as ManagedSkillKey)
          ?.some(
            (compatibility) =>
              compatibility.providerInstanceId === observation.providerInstanceId &&
              compatibility.support !== "unsupported",
          ) === true;
      entries.push({
        origin: "native",
        id: observation.observationId,
        providerInstanceId: observation.providerInstanceId,
        key: observation.key,
        name: observation.displayName,
        scope: "provider",
        scopeId: `${observation.providerInstanceId}:${observation.scopeSummary}`,
        projectState: "inherit",
        revision: {
          revision: 0,
          hash: synthetic("native", observation.observationId) as SkillContentHash,
        },
        validity: "valid",
        effective:
          !managedDeliverySupported &&
          observation.freshness === "fresh" &&
          observation.providerEnabled !== false &&
          observation.modelAvailable !== false,
        compatibility: [],
        ...(managedDeliverySupported
          ? {
              conflict: {
                kind: "shadowed" as const,
                keys: [item.key as ManagedSkillKey],
                message: "A managed skill is selected for this key.",
              },
            }
          : {}),
      });
    }
  }
  return {
    catalogRevision: resolved.catalogRevision as SkillCatalogRevision,
    entries,
    ...(resolved.diagnostics.length === 0
      ? {}
      : {
          diagnostics: [...resolved.diagnostics].map((diagnostic) => ({
            ...diagnostic,
            reasons: [...diagnostic.reasons],
          })),
        }),
  };
};
