// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type {
  ProviderInstanceId,
  ServerProviderSkill,
  SkillNativeDiscoveryResult,
  SkillNativeObservationId,
  SkillNativeObservationWithPath,
  SkillReasonSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface NativeSkillCandidate {
  readonly nativeIdentity: string;
  readonly nativePath: string;
  readonly contentAccess?: "local" | "external";
  readonly key: string;
  readonly displayName: string;
  readonly source: string;
  readonly scopeSummary: string;
  readonly providerEnabled?: boolean;
  readonly modelAvailable?: boolean;
  readonly userInvocable?: boolean;
}

export interface NativeSkillDiscoveryFailure {
  readonly _tag: string;
}

export function serverProviderSkillsToNativeCandidates(
  source: string,
  skills: ReadonlyArray<ServerProviderSkill>,
): ReadonlyArray<NativeSkillCandidate> {
  return skills.map((skill) => {
    const scopeSummary = skill.scope ?? "provider";
    const pathIdentity = NodeCrypto.createHash("sha256")
      .update(skill.path)
      .digest("hex")
      .slice(0, 24);
    return {
      nativeIdentity: `${source}:${scopeSummary}:${skill.name}:${pathIdentity}`,
      nativePath: skill.path,
      key: skill.name,
      displayName: skill.displayName ?? skill.name,
      source,
      scopeSummary,
      providerEnabled: skill.enabled,
      modelAvailable: skill.userInvocationOnly !== true,
      userInvocable: skill.userInvocable !== false,
    };
  });
}

export interface NativeSkillObservationServiceShape {
  readonly discover: (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly scopeId: string;
    readonly discovery: Effect.Effect<
      ReadonlyArray<NativeSkillCandidate>,
      NativeSkillDiscoveryFailure
    >;
  }) => Effect.Effect<SkillNativeDiscoveryResult>;
  readonly markUnavailable: (
    providerInstanceId: ProviderInstanceId,
    scopeId: string,
  ) => Effect.Effect<SkillNativeDiscoveryResult>;
  readonly getObservation: (
    observationId: SkillNativeObservationId,
  ) => Effect.Effect<SkillNativeObservationWithPath | undefined>;
}

export class NativeSkillObservationService extends Context.Service<
  NativeSkillObservationService,
  NativeSkillObservationServiceShape
>()("t3/skills/NativeSkillObservationService") {}

interface StoredNativeDiscovery {
  readonly result: SkillNativeDiscoveryResult;
  readonly observations: ReadonlyArray<SkillNativeObservationWithPath>;
}

const discoveryFailed = {
  code: "discovery_failed",
  message: "Native skill discovery failed; the last successful observation is retained.",
} as const satisfies SkillReasonSummary;

const providerUnavailable = {
  code: "provider_unavailable",
  message: "The provider is unavailable; the last successful observation is retained.",
} as const satisfies SkillReasonSummary;

const observationId = (
  providerInstanceId: ProviderInstanceId,
  nativeIdentity: string,
): SkillNativeObservationId =>
  `native-skill-${NodeCrypto.createHash("sha256")
    .update(providerInstanceId)
    .update("\0")
    .update(nativeIdentity)
    .digest("hex")}` as SkillNativeObservationId;

const withoutPath = ({ nativePath: _nativePath, ...observation }: SkillNativeObservationWithPath) =>
  observation;

const withFailure = (
  observation: SkillNativeObservationWithPath,
  freshness: "stale" | "unavailable",
  attemptedAt: string,
  discoveryError: SkillReasonSummary,
): SkillNativeObservationWithPath => ({
  ...observation,
  freshness,
  attemptedAt,
  discoveryError,
});

export const layer = Layer.effect(
  NativeSkillObservationService,
  Effect.gen(function* () {
    const discoveries = yield* Ref.make<ReadonlyMap<string, StoredNativeDiscovery>>(new Map());
    const cacheKey = (providerInstanceId: ProviderInstanceId, scopeId: string) =>
      `${providerInstanceId}\0${scopeId}`;

    const storeFailure = Effect.fn("NativeSkillObservationService.storeFailure")(function* (
      providerInstanceId: ProviderInstanceId,
      scopeId: string,
      freshness: "stale" | "unavailable",
      discoveryError: SkillReasonSummary,
    ) {
      const attemptedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* Ref.modify(discoveries, (current) => {
        const key = cacheKey(providerInstanceId, scopeId);
        const previous = current.get(key);
        const observations = (previous?.observations ?? []).map((observation) =>
          withFailure(observation, freshness, attemptedAt, discoveryError),
        );
        const result: SkillNativeDiscoveryResult = {
          providerInstanceId,
          freshness,
          attemptedAt,
          observations: observations.map(withoutPath),
          discoveryError,
        };
        const next = new Map(current);
        next.set(key, { result, observations });
        return [result, next] as const;
      });
    });

    const discover: NativeSkillObservationServiceShape["discover"] = (input) =>
      Effect.gen(function* () {
        const attemptedAt = DateTime.formatIso(yield* DateTime.now);
        const discovered = yield* Effect.exit(input.discovery);
        if (Exit.isFailure(discovered)) {
          const previous = yield* Ref.get(discoveries);
          return yield* storeFailure(
            input.providerInstanceId,
            input.scopeId,
            previous.has(cacheKey(input.providerInstanceId, input.scopeId))
              ? "stale"
              : "unavailable",
            discoveryFailed,
          );
        }

        const observations = discovered.value
          .map((candidate): SkillNativeObservationWithPath => ({
            observationId: observationId(input.providerInstanceId, candidate.nativeIdentity),
            providerInstanceId: input.providerInstanceId,
            nativeIdentity: candidate.nativeIdentity,
            nativePath: candidate.nativePath,
            ...(candidate.contentAccess === undefined
              ? {}
              : { contentAccess: candidate.contentAccess }),
            key: candidate.key,
            displayName: candidate.displayName,
            source: candidate.source,
            scopeSummary: candidate.scopeSummary,
            ...(candidate.providerEnabled === undefined
              ? {}
              : { providerEnabled: candidate.providerEnabled }),
            ...(candidate.modelAvailable === undefined
              ? {}
              : { modelAvailable: candidate.modelAvailable }),
            ...(candidate.userInvocable === undefined
              ? {}
              : { userInvocable: candidate.userInvocable }),
            freshness: "fresh",
            observedAt: attemptedAt,
            attemptedAt,
          }))
          .sort((left, right) => left.nativeIdentity.localeCompare(right.nativeIdentity));
        const result: SkillNativeDiscoveryResult = {
          providerInstanceId: input.providerInstanceId,
          freshness: "fresh",
          attemptedAt,
          observations: observations.map(withoutPath),
        };
        yield* Ref.update(discoveries, (current) => {
          const next = new Map(current);
          next.set(cacheKey(input.providerInstanceId, input.scopeId), { result, observations });
          return next;
        });
        return result;
      });

    const markUnavailable: NativeSkillObservationServiceShape["markUnavailable"] = (
      providerInstanceId,
      scopeId,
    ) => storeFailure(providerInstanceId, scopeId, "unavailable", providerUnavailable);

    const getObservation: NativeSkillObservationServiceShape["getObservation"] = (id) =>
      Ref.get(discoveries).pipe(
        Effect.map((current) => {
          for (const discovery of current.values()) {
            const found = discovery.observations.find(
              (observation) => observation.observationId === id,
            );
            if (found !== undefined) return found;
          }
          return undefined;
        }),
      );

    return NativeSkillObservationService.of({ discover, markUnavailable, getObservation });
  }),
);
