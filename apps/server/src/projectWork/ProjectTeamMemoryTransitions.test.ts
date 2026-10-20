import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProjectMemoryExtraction,
  ProjectMemoryObservation,
  ProjectMemorySource,
  ProjectTeamEffect,
  ProjectWorkFoundationCommitCommand,
  canonicalProjectWorkPayload,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";

const at = "2026-10-03T00:00:00.000Z";
const projectId = ProjectId.make("reflection-project");
const attribution = {
  actor: { kind: "system", id: "project-memory-indexer" },
  source: { kind: "system", id: "project-memory-indexer" },
  recordedAt: at,
} as const;
const decodeSource = Schema.decodeUnknownSync(ProjectMemorySource);
const decodeExtraction = Schema.decodeUnknownSync(ProjectMemoryExtraction);
const decodeObservation = Schema.decodeUnknownSync(ProjectMemoryObservation);
const decodeEffect = Schema.decodeUnknownSync(ProjectTeamEffect);
const decodeCommand = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const fixture = (
  kind: "index-complete" | "no-facts" | "delete-source-complete" = "index-complete",
) => {
  const fields = { projectId, revision: 1, generation: 2, updatedAt: at };
  const source = decodeSource({
    ...fields,
    kind: "memory-source",
    recordId: "source",
    status: kind === "delete-source-complete" ? "superseded" : "current",
    sourceKind: "finding",
    sourceId: "logical-source",
    sourceRevision: 3,
    content: "retained",
    contentHash: "hash",
    attribution,
    sharedWithProjectIds: [],
  });
  const ids = kind === "index-complete" ? ["observation"] : [];
  const extraction = decodeExtraction({
    ...fields,
    kind: "memory-extraction",
    recordId: "extraction",
    status: kind === "no-facts" ? "no-facts" : "extracted",
    sourceId: source.recordId,
    sourceRevision: source.sourceRevision,
    sourceGeneration: source.generation,
    engine: "mem0",
    engineVersion: "2.2.1",
    extractionModel: "extract-model",
    embeddingModel: "embedding-model",
    embeddingDimensions: 2048,
    expectedObservationIds: ids,
    completedObservationIds: [],
    extractionHash: "hash",
  });
  const effect = decodeEffect({
    ...fields,
    kind: "effect",
    recordId: "effect",
    effectId: "effect",
    status: kind === "delete-source-complete" ? "pending" : "claimed",
    effectKind: kind === "delete-source-complete" ? "memory-delete" : "memory-index",
    targetId: source.recordId,
    payload: {
      recordIds:
        kind === "delete-source-complete"
          ? [source.recordId]
          : [source.recordId, extraction.recordId],
      expectedRevision: source.sourceRevision,
    },
    claimGeneration: kind === "delete-source-complete" ? 0 : 4,
    availableAt: at,
  });
  const observation = decodeObservation({
    ...fields,
    kind: "memory-observation",
    recordId: "observation",
    status: "current",
    sourceId: source.recordId,
    sourceRevision: source.sourceRevision,
    sourceGeneration: source.generation,
    extractionId: extraction.recordId,
    observationKey: "key",
    body: "retained observation",
    provenance: attribution,
  });
  const records: ReadonlyArray<ProjectTeamRecord> =
    kind === "delete-source-complete"
      ? [source, effect]
      : [source, extraction, effect, ...(ids.length === 0 ? [] : [observation])];
  const state = {
    ...emptyProjectWorkReducerState(projectId),
    revision: 10,
    foundationRecords: records,
  };
  const command = decodeCommand({
    type: "project-work.foundation.commit",
    commandId: "reflect-original",
    projectId,
    expectedRevision: state.revision,
    records: [],
    transition: {
      kind: "memory.reflect",
      effectId: effect.recordId,
      claimGeneration: 4,
      outcomeKind: kind,
      sourceId: source.recordId,
      sourceRevision: source.sourceRevision,
      sourceGeneration: source.generation,
      observationIds: ids,
      expectedEffectRevision: effect.revision,
      ...(kind === "delete-source-complete"
        ? {}
        : { expectedExtractionRevision: extraction.revision }),
    },
    attribution,
    committedAt: at,
  });
  return { state, command, source, extraction, observation, effect };
};

for (const kind of ["index-complete", "no-facts", "delete-source-complete"] as const)
  it(`derives only original ${kind} completion records without a new claim`, () => {
    const f = fixture(kind);
    const events = decideProjectWorkCommand(f.state, f.command);
    expect(events).toHaveLength(kind === "index-complete" ? 2 : 1);
    const next = applyProjectWorkEvents(f.state, events);
    const effect = next.foundationRecords!.find((record) => record.recordId === f.effect.recordId);
    expect(effect?.kind).toBe("effect");
    if (effect?.kind !== "effect") throw new Error("expected effect");
    expect(effect.status).toBe("succeeded");
    expect(effect.claimGeneration).toBe(f.effect.claimGeneration);
    expect(effect.outcome).toBe(
      canonicalProjectWorkPayload({
        effectId: f.effect.recordId,
        claimGeneration: 4,
        kind,
        sourceId: f.source.recordId,
        sourceRevision: f.source.sourceRevision,
        sourceGeneration: f.source.generation,
        observationIds: kind === "index-complete" ? [f.observation.recordId] : [],
      }),
    );
    expect(next.foundationRecords!.find((record) => record.recordId === f.source.recordId)).toEqual(
      f.source,
    );
    expect(() =>
      decideProjectWorkCommand(next, { ...f.command, expectedRevision: next.revision }),
    ).toThrow();
  });

it("reconciles an uncertain original claim through the dedicated transition", () => {
  const f = fixture();
  const state = {
    ...f.state,
    foundationRecords: f.state.foundationRecords.map((record) =>
      record.recordId === f.effect.recordId
        ? { ...f.effect, status: "uncertain" as const }
        : record,
    ),
  };
  expect(decideProjectWorkCommand(state, f.command)).toHaveLength(2);
});

for (const mutation of [
  "actor",
  "source-actor",
  "claim",
  "effect-revision",
  "extraction-revision",
  "manifest",
  "generation",
  "project",
] as const)
  it(`rejects ${mutation} authority mismatch`, () => {
    const f = fixture();
    const transition = f.command.transition;
    if (transition?.kind !== "memory.reflect") throw new Error("expected memory transition");
    const changed = {
      ...f.command,
      ...(mutation === "actor"
        ? { attribution: { ...attribution, actor: { kind: "human" as const, id: "human" } } }
        : {}),
      ...(mutation === "source-actor"
        ? { attribution: { ...attribution, source: { kind: "system" as const, id: "other" } } }
        : {}),
      ...(mutation === "project" ? { projectId: ProjectId.make("foreign-project") } : {}),
      transition: {
        ...transition,
        ...(mutation === "claim" ? { claimGeneration: 0 } : {}),
        ...(mutation === "effect-revision" ? { expectedEffectRevision: 0 } : {}),
        ...(mutation === "extraction-revision" ? { expectedExtractionRevision: 0 } : {}),
        ...(mutation === "manifest" ? { observationIds: [] } : {}),
        ...(mutation === "generation" ? { sourceGeneration: 3 } : {}),
      },
    };
    expect(() => decideProjectWorkCommand(f.state, changed)).toThrow();
  });

for (const mutation of ["missing", "provenance", "retracted", "foreign", "duplicate"] as const)
  it(`rejects ${mutation} observation evidence`, () => {
    const f = fixture();
    const changed =
      mutation === "missing"
        ? []
        : [
            {
              ...f.observation,
              ...(mutation === "provenance"
                ? {
                    provenance: {
                      ...attribution,
                      actor: { kind: "system" as const, id: "forged" },
                    },
                  }
                : {}),
              ...(mutation === "retracted"
                ? { status: "retracted" as const, tombstonedAt: at }
                : {}),
              ...(mutation === "foreign" ? { projectId: ProjectId.make("foreign-project") } : {}),
            },
          ];
    const state = {
      ...f.state,
      foundationRecords: [
        f.source,
        f.extraction,
        f.effect,
        ...changed,
        ...(mutation === "duplicate" ? changed : []),
      ],
    };
    expect(() => decideProjectWorkCommand(state, f.command)).toThrow();
  });

it("allows already-suppressed cleanup after source generation advances", () => {
  const f = fixture("delete-source-complete");
  const source = { ...f.source, status: "retracted" as const, generation: 3, tombstonedAt: at };
  expect(
    decideProjectWorkCommand({ ...f.state, foundationRecords: [source, f.effect] }, f.command),
  ).toHaveLength(1);
  expect(() =>
    decideProjectWorkCommand(
      { ...f.state, foundationRecords: [{ ...source, status: "current" }, f.effect] },
      f.command,
    ),
  ).toThrow();
});

for (const kind of ["index-complete", "no-facts"] as const)
  it(`rejects ${kind} batch revision overflow`, () => {
    const f = fixture(kind);
    const revision = Number.MAX_SAFE_INTEGER - (kind === "index-complete" ? 1 : 0);
    expect(() =>
      decideProjectWorkCommand(
        { ...f.state, revision },
        { ...f.command, expectedRevision: revision },
      ),
    ).toThrow();
  });

const captureModel = "inclusionai/ling-3.1-flash:free";
const liquidModel = "liquid/lfm-2.5-2.6b:free";
const extractionAttribution = {
  actor: { kind: "system", id: "project-memory" },
  source: { kind: "system", id: "project-memory" },
  recordedAt: at,
} as const;
const extractionCompletion = (status: "extracted" | "no-facts" = "extracted") => {
  const f = fixture();
  const { extractionHash: _hash, ...unfrozen } = f.extraction;
  const pending = {
    ...unfrozen,
    status: "pending" as const,
    extractionModel: captureModel,
    expectedObservationIds: [],
    completedObservationIds: [],
  };
  const completed = {
    ...pending,
    revision: pending.revision + 1,
    status,
    extractionModel: liquidModel,
    extractionHash: "validated-facts-hash",
    expectedObservationIds: status === "extracted" ? [f.observation.recordId] : [],
  };
  const state = { ...f.state, foundationRecords: [f.source, pending, f.effect] };
  const { transition: _transition, ...originalCommand } = f.command;
  const command = { ...originalCommand, attribution: extractionAttribution, records: [completed] };
  return { ...f, state, command, pending, completed };
};

for (const status of ["extracted", "no-facts"] as const)
  it(`finalizes pending Liquid model provenance with validated ${status} facts`, () => {
    const f = extractionCompletion(status);
    const next = applyProjectWorkEvents(f.state, decideProjectWorkCommand(f.state, f.command));
    expect(next.foundationRecords?.find((r) => r.recordId === f.pending.recordId)).toEqual(
      f.completed,
    );
    expect(next.foundationRecords?.find((r) => r.recordId === f.source.recordId)).toEqual(f.source);
    expect(next.foundationRecords?.find((r) => r.recordId === f.effect.recordId)).toEqual(f.effect);
  });

for (const status of ["extracted", "no-facts", "indexed", "failed", "retracted"] as const)
  it(`does not relabel an already ${status} extraction as Liquid`, () => {
    const f = extractionCompletion();
    const previous = {
      ...f.pending,
      status,
      ...(status === "failed"
        ? { error: "Failed extraction" }
        : { extractionHash: "original-hash" }),
      expectedObservationIds:
        status === "extracted" || status === "indexed" ? [f.observation.recordId] : [],
      completedObservationIds: status === "indexed" ? [f.observation.recordId] : [],
    };
    expect(() =>
      decideProjectWorkCommand(
        { ...f.state, foundationRecords: [f.source, previous, f.effect, f.observation] },
        f.command,
      ),
    ).toThrow();
  });

for (const mutation of [
  "source",
  "source-revision",
  "source-generation",
  "generation",
  "project",
  "foreign-source",
  "engine",
  "embedding-model",
  "unknown-model",
  "unsuffixed-model",
  "actor",
  "source-actor",
  "missing-hash",
  "pending-output",
  "failed-output",
  "indexed-output",
  "completed-observations",
  "empty-extracted",
  "nonempty-no-facts",
] as const)
  it(`rejects Liquid provenance finalization with ${mutation}`, () => {
    const f = extractionCompletion();
    const completed = {
      ...f.completed,
      ...(mutation === "source" ? { sourceId: "different-source" } : {}),
      ...(mutation === "source-revision" ? { sourceRevision: f.source.sourceRevision + 1 } : {}),
      ...(mutation === "source-generation" ? { sourceGeneration: f.source.generation + 1 } : {}),
      ...(mutation === "generation" ? { generation: f.pending.generation + 1 } : {}),
      ...(mutation === "project" ? { projectId: ProjectId.make("foreign") } : {}),
      ...(mutation === "engine" ? { engineVersion: "changed" } : {}),
      ...(mutation === "embedding-model" ? { embeddingModel: "changed" } : {}),
      ...(mutation === "unknown-model" ? { extractionModel: "arbitrary/model:free" } : {}),
      ...(mutation === "unsuffixed-model" ? { extractionModel: "liquid/lfm-2.5-2.6b" } : {}),
      ...(mutation === "missing-hash" ? { extractionHash: undefined } : {}),
      ...(mutation === "pending-output" ? { status: "pending" } : {}),
      ...(mutation === "failed-output" ? { status: "failed" } : {}),
      ...(mutation === "indexed-output"
        ? { status: "indexed", completedObservationIds: [f.observation.recordId] }
        : {}),
      ...(mutation === "completed-observations"
        ? { completedObservationIds: [f.observation.recordId] }
        : {}),
      ...(mutation === "empty-extracted" ? { expectedObservationIds: [] } : {}),
      ...(mutation === "nonempty-no-facts" ? { status: "no-facts" } : {}),
    };
    const command = {
      ...f.command,
      records: [completed],
      attribution: {
        ...extractionAttribution,
        ...(mutation === "actor" ? { actor: { kind: "human", id: "human" } } : {}),
        ...(mutation === "source-actor" ? { source: { kind: "system", id: "other-system" } } : {}),
      },
    };
    const source = {
      ...f.source,
      ...(mutation === "source" ? { recordId: "different-source" } : {}),
      ...(mutation === "foreign-source" ? { projectId: ProjectId.make("foreign") } : {}),
    };
    expect(() =>
      decideProjectWorkCommand(
        { ...f.state, foundationRecords: [source, f.pending, f.effect] },
        decodeCommand(command),
      ),
    ).toThrow();
  });

for (const mutation of [
  "hash",
  "expected-observations",
  "completed-observations",
  "error",
  "unknown-model",
] as const)
  it(`rejects already populated pending extraction ${mutation} on Liquid finalization`, () => {
    const f = extractionCompletion();
    const pending = {
      ...f.pending,
      ...(mutation === "hash" ? { extractionHash: "old-hash" } : {}),
      ...(mutation === "expected-observations"
        ? { expectedObservationIds: [f.observation.recordId] }
        : {}),
      ...(mutation === "completed-observations"
        ? { completedObservationIds: [f.observation.recordId] }
        : {}),
      ...(mutation === "error" ? { error: "previous error" } : {}),
      ...(mutation === "unknown-model" ? { extractionModel: "unknown/model:free" } : {}),
    };
    expect(() =>
      decideProjectWorkCommand(
        { ...f.state, foundationRecords: [f.source, pending, f.effect] },
        f.command,
      ),
    ).toThrow();
  });

for (const status of ["extracted", "no-facts"] as const)
  it(`keeps finalized Liquid ${status} model and manifest immutable`, () => {
    const f = extractionCompletion(status);
    const finalized = applyProjectWorkEvents(f.state, decideProjectWorkCommand(f.state, f.command));
    for (const change of [
      { extractionModel: captureModel },
      { extractionModel: "liquid/lfm-2.5-2.6b" },
      { extractionHash: "replaced-hash" },
      { expectedObservationIds: ["changed-observation"] },
    ])
      expect(() =>
        decideProjectWorkCommand(finalized, {
          ...f.command,
          expectedRevision: finalized.revision,
          records: [{ ...f.completed, revision: f.completed.revision + 1, ...change }],
        }),
      ).toThrow();
  });
