import type {
  ModelSelection,
  ProjectWorkBriefing as ProjectWorkBriefingRecord,
  ProjectWorkBriefingKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectWorkContentGuard from "./ProjectWorkContentGuard.ts";
import { redactProjectWorkContent } from "./ProjectWorkContentGuard.ts";

/** A citation points back to the structured source used by the generator. */
export interface ProjectWorkNarrativeCitation {
  readonly recordKind: "task" | "knowledge";
  readonly recordId: string;
  readonly revision: number;
}

export interface ProjectWorkNarrativeGeneratorInput {
  readonly projectId: string;
  readonly kind: ProjectWorkBriefingKind;
  readonly briefing: ProjectWorkBriefingRecord;
  readonly citations: ReadonlyArray<ProjectWorkNarrativeCitation>;
  readonly model: string;
  /** The exact provider instance/model/options used for this generation. */
  readonly modelSelection?: ModelSelection;
}

export type ProjectWorkNarrativeGenerator = (
  input: ProjectWorkNarrativeGeneratorInput,
) => Effect.Effect<string>;

export interface ProjectWorkNarrativeGenerateInput {
  readonly projectId: string;
  readonly kind: ProjectWorkBriefingKind;
  readonly briefing: ProjectWorkBriefingRecord;
  readonly model?: string;
  /** Resolved provider selection used for cache identity and generation. */
  readonly modelSelection?: ModelSelection;
  readonly generatedAt?: string;
  /** An input generator takes precedence over the configured service default. */
  readonly generator?: ProjectWorkNarrativeGenerator;
}

export interface ProjectWorkNarrativeResult {
  readonly projectId: string;
  readonly kind: ProjectWorkBriefingKind;
  readonly narrative: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly sourceRevision: number;
  readonly citations: ReadonlyArray<ProjectWorkNarrativeCitation>;
}

export type ProjectWorkNarrativeRecord = ProjectWorkNarrativeResult;
export type ProjectWorkNarrativeInput = ProjectWorkNarrativeGenerateInput;

export interface ProjectWorkNarrativeLookupInput {
  readonly projectId: string;
  readonly kind: ProjectWorkBriefingKind;
  readonly model?: string;
  /** Resolved provider selection used for cache identity. */
  readonly modelSelection?: ModelSelection;
  /** A cache entry from a different source revision is never returned. */
  readonly sourceRevision?: number;
}

export type ProjectWorkNarrativeRequestStatus = "scheduled" | "pending" | "cached" | "unavailable";

export interface ProjectWorkNarrativeRequestResult {
  readonly status: ProjectWorkNarrativeRequestStatus;
  readonly narrative?: ProjectWorkNarrativeResult;
}

export interface ProjectWorkNarrativeShape {
  /** Return only a fresh cache entry; this never invokes a text generator. */
  readonly get: (
    input: ProjectWorkNarrativeLookupInput,
  ) => Effect.Effect<ProjectWorkNarrativeResult | undefined>;
  readonly cached: ProjectWorkNarrativeShape["get"];
  /** Generate and cache a narrative, waiting for the generator. */
  readonly generate: (
    input: ProjectWorkNarrativeGenerateInput,
  ) => Effect.Effect<ProjectWorkNarrativeResult | undefined>;
  readonly generateNarrative: ProjectWorkNarrativeShape["generate"];
  readonly getOrGenerate: ProjectWorkNarrativeShape["generate"];
  /** Add derived fields to a structured briefing without changing its source. */
  readonly attachToBriefing: (
    input: ProjectWorkNarrativeGenerateInput,
  ) => Effect.Effect<ProjectWorkBriefingRecord>;
  /** Schedule generation and return immediately with a cached/pending status. */
  readonly request: (
    input: ProjectWorkNarrativeGenerateInput,
  ) => Effect.Effect<ProjectWorkNarrativeRequestResult>;
  readonly invalidate: (projectId: string) => Effect.Effect<void>;
  readonly invalidateProject: ProjectWorkNarrativeShape["invalidate"];
  readonly invalidateForRevision: (
    projectId: string,
    sourceRevision: number,
  ) => Effect.Effect<void>;
  /** Remove derived entries that contain a newly known secret. */
  readonly scrub: (secrets: ReadonlyArray<string>) => Effect.Effect<number>;
  readonly scrubDerivedCaches: ProjectWorkNarrativeShape["scrub"];
  readonly clear: Effect.Effect<void>;
}

export interface ProjectWorkNarrativeOptions {
  readonly generator?: ProjectWorkNarrativeGenerator;
  readonly defaultModel?: string;
  readonly now?: () => string;
  /** Guard generated prose before it is clipped or retained in the cache. */
  readonly contentGuard?: ProjectWorkContentGuard.ProjectWorkContentGuardShape;
}

export const PROJECT_WORK_NARRATIVE_MAX_CHARACTERS = 4_000;
export const PROJECT_WORK_NARRATIVE_DEFAULT_MODEL = "derived";

const clip = (value: string): string => {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  return normalized.length <= PROJECT_WORK_NARRATIVE_MAX_CHARACTERS
    ? normalized
    : `${normalized.slice(0, PROJECT_WORK_NARRATIVE_MAX_CHARACTERS - 1)}…`;
};

const baseCacheKey = (
  input: Pick<ProjectWorkNarrativeGenerateInput, "projectId" | "kind" | "model" | "modelSelection">,
  model: string,
): string =>
  `${input.projectId}\0${input.kind}\0${
    input.modelSelection === undefined
      ? JSON.stringify({ model })
      : JSON.stringify({
          instanceId: String(input.modelSelection.instanceId),
          model: input.modelSelection.model,
          ...(input.modelSelection.options === undefined ||
          input.modelSelection.options.length === 0
            ? {}
            : {
                options: input.modelSelection.options.toSorted((left, right) =>
                  left.id.localeCompare(right.id),
                ),
              }),
        })
  }`;

const cacheKey = (
  input: Pick<ProjectWorkNarrativeGenerateInput, "projectId" | "kind" | "model" | "modelSelection">,
  briefing: ProjectWorkBriefingRecord,
  model: string,
): string =>
  `${baseCacheKey(input, model)}\0${JSON.stringify({
    sourceRevision: briefing.sourceRevision,
    text: briefing.text,
    includedTaskIds: briefing.includedTaskIds.map(String),
    includedKnowledgeIds: briefing.includedKnowledgeIds.map(String),
    omittedReasons: [...briefing.omittedReasons],
  })}`;

const citationsFor = (
  briefing: ProjectWorkBriefingRecord,
): ReadonlyArray<ProjectWorkNarrativeCitation> => [
  ...briefing.includedTaskIds.map((recordId) => ({
    recordKind: "task" as const,
    recordId: String(recordId),
    revision: briefing.sourceRevision,
  })),
  ...briefing.includedKnowledgeIds.map((recordId) => ({
    recordKind: "knowledge" as const,
    recordId: String(recordId),
    revision: briefing.sourceRevision,
  })),
];

const defaultNow = (): string => {
  // @effect-diagnostics-next-line globalDate:off
  return new Date().toISOString();
};

/**
 * Construct the cache service without requiring a text-generation provider.
 * P7 can supply a configured generator while P5 callers and structured reads
 * continue to work with the no-op default.
 */
export const makeProjectWorkNarrative = (
  options: ProjectWorkNarrativeOptions = {},
): ProjectWorkNarrativeShape => {
  const entries = new Map<string, ProjectWorkNarrativeResult>();
  const pending = new Map<string, symbol>();
  const epochs = new Map<string, number>();
  let clearEpoch = 0;
  const now = options.now ?? defaultNow;
  const modelFor = (
    input: Pick<ProjectWorkNarrativeGenerateInput, "model" | "modelSelection">,
  ): string =>
    (
      input.modelSelection?.model ??
      input.model ??
      options.defaultModel ??
      PROJECT_WORK_NARRATIVE_DEFAULT_MODEL
    ).trim() || PROJECT_WORK_NARRATIVE_DEFAULT_MODEL;
  const epochFor = (projectId: string): number => epochs.get(projectId) ?? 0;

  const get: ProjectWorkNarrativeShape["get"] = (input) =>
    Effect.sync(() => {
      const model = modelFor(input);
      const prefix = `${baseCacheKey({ ...input, model }, model)}\0`;
      let found: ProjectWorkNarrativeResult | undefined;
      for (const [key, value] of entries) {
        if (
          key.startsWith(prefix) &&
          (input.sourceRevision === undefined || value.sourceRevision === input.sourceRevision)
        )
          found = value;
      }
      return found;
    });

  const getForBriefing = (
    input: ProjectWorkNarrativeGenerateInput,
    model: string,
  ): Effect.Effect<ProjectWorkNarrativeResult | undefined> =>
    Effect.sync(() => entries.get(cacheKey({ ...input, model }, input.briefing, model)));

  const generate: ProjectWorkNarrativeShape["generate"] = (input) => {
    const model = modelFor(input);
    const key = cacheKey({ ...input, model }, input.briefing, model);
    const projectEpoch = epochFor(input.projectId);
    const generationClearEpoch = clearEpoch;
    const generator = input.generator ?? options.generator;
    // @effect-diagnostics-next-line effectSucceedWithVoid:off -- undefined is part of this read API
    if (generator === undefined) return Effect.succeed(undefined);
    return Effect.suspend(() =>
      generator({
        projectId: input.projectId,
        kind: input.kind,
        briefing: input.briefing,
        citations: citationsFor(input.briefing),
        model,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      }),
    ).pipe(
      // Redaction is deliberately effectful when the shared guard is live:
      // it observes secrets registered by other adapters. Do it before
      // clipping so neither the returned result nor the cache retains an
      // unredacted suffix or a secret-derived length.
      Effect.flatMap((value) =>
        options.contentGuard === undefined
          ? Effect.succeed(redactProjectWorkContent(value).value)
          : options.contentGuard.redact(value).pipe(Effect.map(({ value: redacted }) => redacted)),
      ),
      Effect.map((redactedValue) => {
        const value = String(redactedValue);
        const generated: ProjectWorkNarrativeResult = {
          projectId: input.projectId,
          kind: input.kind,
          narrative: clip(value),
          model,
          generatedAt: input.generatedAt ?? now(),
          sourceRevision: input.briefing.sourceRevision,
          citations: citationsFor(input.briefing),
        };
        // A task mutation can invalidate while a provider call is running.
        // Do not let that old response repopulate the cache after invalidation.
        if (epochFor(input.projectId) === projectEpoch && clearEpoch === generationClearEpoch)
          entries.set(key, generated);
        return generated;
      }),
    );
  };

  const request: ProjectWorkNarrativeShape["request"] = (input) =>
    Effect.gen(function* () {
      const model = modelFor(input);
      const key = cacheKey({ ...input, model }, input.briefing, model);
      const cached = yield* getForBriefing(input, model);
      if (cached !== undefined) return { status: "cached", narrative: cached };
      const generator = input.generator ?? options.generator;
      if (generator === undefined) return { status: "unavailable" };
      if (pending.has(key)) return { status: "pending" };
      const token = Symbol(key);
      pending.set(key, token);
      yield* generate(input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (pending.get(key) === token) pending.delete(key);
          }),
        ),
        Effect.ignoreCause,
        Effect.forkDetach,
      );
      return { status: "scheduled" };
    });

  const getOrGenerate: ProjectWorkNarrativeShape["generate"] = (input) =>
    getForBriefing(input, modelFor(input)).pipe(
      // @effect-diagnostics-next-line flatMapConditionalToFilterOrFail:off -- cached miss selects generation
      Effect.flatMap((cached) => (cached === undefined ? generate(input) : Effect.succeed(cached))),
    );

  const attachToBriefing: ProjectWorkNarrativeShape["attachToBriefing"] = (input) =>
    getOrGenerate(input).pipe(
      Effect.map((narrative) =>
        narrative === undefined
          ? input.briefing
          : {
              ...input.briefing,
              narrative: narrative.narrative,
              narrativeModel: narrative.model,
              narrativeGeneratedAt: narrative.generatedAt,
            },
      ),
    );

  const invalidate: ProjectWorkNarrativeShape["invalidate"] = (projectId) =>
    Effect.sync(() => {
      epochs.set(projectId, epochFor(projectId) + 1);
      for (const key of entries.keys()) if (key.startsWith(`${projectId}\0`)) entries.delete(key);
      for (const key of pending.keys()) if (key.startsWith(`${projectId}\0`)) pending.delete(key);
    });

  const invalidateForRevision: ProjectWorkNarrativeShape["invalidateForRevision"] = (
    projectId,
    sourceRevision,
  ) =>
    Effect.sync(() => {
      for (const [key, value] of entries)
        if (key.startsWith(`${projectId}\0`) && value.sourceRevision < sourceRevision)
          entries.delete(key);
      // There may be no cached entry yet when a provider call is in flight.
      // Always advance the project epoch so that call cannot publish an older
      // source revision after this invalidation.
      epochs.set(projectId, epochFor(projectId) + 1);
      for (const key of pending.keys()) if (key.startsWith(`${projectId}\0`)) pending.delete(key);
    });

  const clear = Effect.sync(() => {
    clearEpoch += 1;
    entries.clear();
    pending.clear();
  });

  const scrub: ProjectWorkNarrativeShape["scrub"] = (secrets) =>
    Effect.sync(() => {
      const candidates = secrets.filter((secret) => secret.length >= 4);
      if (candidates.length === 0) return 0;
      // Prevent a provider call that was already in flight from repopulating a
      // cache entry after a newly known secret has made it unsafe.
      clearEpoch += 1;
      let removed = 0;
      for (const [key, value] of entries) {
        if (candidates.some((secret) => value.narrative.includes(secret))) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    });

  return {
    get,
    cached: get,
    generate,
    generateNarrative: generate,
    getOrGenerate,
    attachToBriefing,
    request,
    invalidate,
    invalidateProject: invalidate,
    invalidateForRevision,
    scrub,
    scrubDerivedCaches: scrub,
    clear,
  } satisfies ProjectWorkNarrativeShape;
};

export class ProjectWorkNarrative extends Context.Service<
  ProjectWorkNarrative,
  ProjectWorkNarrativeShape
>()("t3/projectWork/ProjectWorkNarrative") {}

/** Compatibility alias for code that names the Effect tag as a service. */
export const ProjectWorkNarrativeService = ProjectWorkNarrative;

export const ProjectWorkNarrativeLive = Layer.effect(
  ProjectWorkNarrative,
  Effect.gen(function* () {
    const contentGuard = yield* Effect.serviceOption(
      ProjectWorkContentGuard.ProjectWorkContentGuard,
    );
    const narrative = makeProjectWorkNarrative(
      contentGuard._tag === "Some" ? { contentGuard: contentGuard.value } : {},
    );
    if (contentGuard._tag === "Some") yield* contentGuard.value.registerScrubber(narrative.scrub);
    return narrative;
  }),
);
