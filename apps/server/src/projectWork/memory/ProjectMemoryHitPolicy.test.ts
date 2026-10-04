import { describe, expect, it } from "vite-plus/test";
import { history } from "./fixtures/evaluateMemoryHits.ts";
import { selectProjectMemoryHits } from "./ProjectMemoryHitPolicy.ts";

const now = "2026-10-01T00:00:00.000Z";
const provenance = {
  actor: { kind: "agent", id: "investigator" },
  source: { kind: "provider", id: "transport-test-1" },
  recordedAt: now,
};
const source = {
  kind: "memory-source",
  recordId: "source-transport",
  projectId: "atlas",
  revision: 7,
  generation: 3,
  updatedAt: now,
  status: "current",
  sourceKind: "finding",
  sourceId: "investigation-transport",
  sourceRevision: 2,
  content: "Remote clients use one origin.",
  contentHash: "source-hash",
  attribution: provenance,
  sharedWithProjectIds: [],
};
const observation = {
  kind: "memory-observation",
  recordId: "atlas-transport",
  projectId: "atlas",
  revision: 5,
  generation: 9,
  updatedAt: now,
  status: "current",
  sourceId: source.recordId,
  sourceRevision: source.sourceRevision,
  sourceGeneration: source.generation,
  extractionId: "extraction-transport",
  observationKey: "single-origin",
  body: "Remote browsers connect to the same origin.",
  provenance,
};
const input = {
  projectId: "atlas",
  authorityComplete: true,
  sources: [source],
  observations: [observation],
  hitIds: [observation.recordId],
};

describe("selectProjectMemoryHits", () => {
  it("hydrates only the authoritative observation with its retained provenance", () => {
    expect(selectProjectMemoryHits(input)).toMatchObject({
      status: "accepted",
      selected: [observation],
    });
  });

  it("accepts a complete empty snapshot and never hydrates a source ID as an observation", () => {
    expect(
      selectProjectMemoryHits({ ...input, sources: [], observations: [], hitIds: [] }),
    ).toMatchObject({ status: "accepted", selected: [] });
    expect(selectProjectMemoryHits({ ...input, hitIds: [source.recordId] })).toMatchObject({
      selected: [],
      rejectionCounts: { unknownObservation: 1 },
    });
  });

  it("deduplicates hits in their first-seen order regardless of record order", () => {
    const second = { ...observation, recordId: "second", observationKey: "receipts" };
    const result = selectProjectMemoryHits({
      ...input,
      sources: [source, { ...source }],
      observations: [second, observation, { ...observation }],
      hitIds: [observation.recordId, "missing", second.recordId, observation.recordId, "missing"],
    });
    expect(result).toMatchObject({
      status: "accepted",
      selected: [observation, second],
      rejectionCounts: { duplicateHit: 2, unknownObservation: 1 },
    });
    expect(
      selectProjectMemoryHits({
        ...input,
        observations: [observation, second],
        hitIds: [second.recordId, observation.recordId],
      }).selected,
    ).toEqual([second, observation]);
  });

  it("rejects foreign project hits despite the same underlying source identity", () => {
    const foreignSource = { ...source, recordId: "foreign-source", projectId: "borealis" };
    const foreignObservation = {
      ...observation,
      recordId: "foreign-observation",
      projectId: "borealis",
      sourceId: foreignSource.recordId,
    };
    expect(
      selectProjectMemoryHits({
        ...input,
        sources: [source, foreignSource],
        observations: [observation, foreignObservation],
        hitIds: [foreignObservation.recordId, observation.recordId],
      }),
    ).toMatchObject({ selected: [observation], rejectionCounts: { unauthorizedProject: 1 } });
  });

  it("permits only an explicit current source share, revoked on the next snapshot", () => {
    const shared = { ...source, projectId: "borealis", sharedWithProjectIds: ["atlas"] };
    const sharedObservation = { ...observation, projectId: "borealis" };
    const sharedInput = { ...input, sources: [shared], observations: [sharedObservation] };
    expect(selectProjectMemoryHits(sharedInput).selected).toEqual([sharedObservation]);
    expect(
      selectProjectMemoryHits({
        ...sharedInput,
        sources: [{ ...shared, sharedWithProjectIds: [] }],
      }),
    ).toMatchObject({ selected: [], rejectionCounts: { unauthorizedProject: 1 } });
    expect(selectProjectMemoryHits({ ...sharedInput, sources: [] })).toMatchObject({
      selected: [],
      rejectionCounts: { unavailableSource: 1 },
    });
  });

  it("rejects a forged observation project even with a legitimate source share", () => {
    expect(
      selectProjectMemoryHits({
        ...input,
        sources: [{ ...source, projectId: "borealis", sharedWithProjectIds: ["atlas"] }],
      }),
    ).toMatchObject({ selected: [], rejectionCounts: { unauthorizedProject: 1 } });
  });

  it.each(["conflicted", "superseded", "retracted"])("suppresses %s sources", (status) => {
    expect(selectProjectMemoryHits({ ...input, sources: [{ ...source, status }] })).toMatchObject({
      selected: [],
      rejectionCounts: { unavailableSource: 1 },
    });
  });

  it.each(["conflicted", "superseded", "retracted"])("suppresses %s observations", (status) => {
    expect(
      selectProjectMemoryHits({ ...input, observations: [{ ...observation, status }] }),
    ).toMatchObject({ selected: [], rejectionCounts: { unavailableObservation: 1 } });
  });

  it("suppresses tombstones even while the engine and status still report current", () => {
    expect(
      selectProjectMemoryHits({ ...input, sources: [{ ...source, tombstonedAt: now }] }).selected,
    ).toEqual([]);
    expect(
      selectProjectMemoryHits({
        ...input,
        observations: [{ ...observation, tombstonedAt: now }],
      }).selected,
    ).toEqual([]);
  });

  it.each([{ sourceRevision: 7 }, { sourceGeneration: 9 }])(
    "requires the exact source tuple: %j",
    (change) => {
      expect(
        selectProjectMemoryHits({ ...input, observations: [{ ...observation, ...change }] }),
      ).toMatchObject({ selected: [], rejectionCounts: { staleSource: 1 } });
    },
  );

  it("suppresses an old current source through a supplied correction without requiring an engine hit", () => {
    const correction = { ...source, recordId: "correction", supersedes: source.recordId };
    const corrected = { ...observation, recordId: "corrected", sourceId: correction.recordId };
    expect(
      selectProjectMemoryHits({
        ...input,
        sources: [correction, source],
        observations: [corrected, observation],
        hitIds: [observation.recordId, corrected.recordId],
      }),
    ).toMatchObject({ selected: [corrected], rejectionCounts: { unavailableSource: 1 } });
  });

  it("suppresses old observations through the complete correction chain", () => {
    const middle = { ...observation, recordId: "middle", supersedes: observation.recordId };
    const corrected = { ...middle, recordId: "corrected", supersedes: middle.recordId };
    expect(
      selectProjectMemoryHits({
        ...input,
        observations: [middle, corrected, observation],
        hitIds: [middle.recordId, corrected.recordId, observation.recordId],
      }),
    ).toMatchObject({ selected: [corrected], rejectionCounts: { unavailableObservation: 2 } });
  });

  it("does not revive old facts when their correction has been retracted", () => {
    const correction = {
      ...observation,
      recordId: "correction",
      supersedes: observation.recordId,
      status: "retracted",
      tombstonedAt: now,
    };
    expect(
      selectProjectMemoryHits({ ...input, observations: [observation, correction] }).selected,
    ).toEqual([]);
  });

  it.each(["sources", "observations"] as const)("denies %s supersession cycles", (field) => {
    const records = input[field];
    const first = records[0]!;
    expect(
      selectProjectMemoryHits({
        ...input,
        [field]: [
          { ...first, supersedes: "cycle" },
          { ...first, recordId: "cycle", supersedes: first.recordId },
        ],
      }),
    ).toMatchObject({ status: "denied", reason: "invalid-supersession", selected: [] });
  });

  it("denies self correction and correction edges crossing project or record kind", () => {
    for (const sources of [
      [{ ...source, supersedes: source.recordId }],
      [
        source,
        { ...source, recordId: "other", projectId: "borealis", supersedes: source.recordId },
      ],
      [{ ...source, supersedes: observation.recordId }],
    ]) {
      expect(selectProjectMemoryHits({ ...input, sources })).toMatchObject({
        status: "denied",
        reason: "invalid-supersession",
        selected: [],
      });
    }
  });

  it("denies a claimed complete closure missing a superseded record", () => {
    expect(
      selectProjectMemoryHits({
        ...input,
        observations: [{ ...observation, supersedes: "not-loaded" }],
      }),
    ).toMatchObject({ status: "denied", reason: "invalid-supersession", selected: [] });
  });

  it.each(["sources", "observations"] as const)(
    "denies conflicting duplicate %s independent of array order",
    (field) => {
      const first = input[field][0]!;
      const changed = { ...first, generation: first.generation + 1 };
      for (const records of [
        [first, changed],
        [changed, first],
      ]) {
        expect(selectProjectMemoryHits({ ...input, [field]: records })).toMatchObject({
          status: "denied",
          reason: "conflicting-authority",
          selected: [],
        });
      }
    },
  );

  it("denies record ID collisions across projects or kinds", () => {
    expect(
      selectProjectMemoryHits({
        ...input,
        sources: [source, { ...source, projectId: "borealis" }],
      }).status,
    ).toBe("denied");
    expect(
      selectProjectMemoryHits({
        ...input,
        observations: [{ ...observation, recordId: source.recordId }],
      }).status,
    ).toBe("denied");
  });

  it("fails closed when the authoritative closure is incomplete", () => {
    expect(selectProjectMemoryHits({ ...input, authorityComplete: false })).toMatchObject({
      status: "denied",
      reason: "incomplete-authority",
      selected: [],
    });
  });

  it.each([
    null,
    {},
    { ...input, authorityComplete: undefined },
    { ...input, authorityComplete: "true" },
    { ...input, namespace: "atlas" },
    { ...input, projectId: " atlas " },
    { ...input, sources: [{ ...source, recordId: " source-transport " }] },
    {
      ...input,
      hitIds: [{ id: observation.recordId, namespace: "atlas", body: "engine fiction" }],
    },
    { ...input, hitIds: [""] },
    { ...input, hitIds: ["x".repeat(257)] },
    { ...input, hitIds: [" atlas-transport "] },
    { ...input, observations: [{ ...observation, status: "deleted" }] },
    { ...input, observations: [{ ...observation, body: "x".repeat(8_001) }] },
    { ...input, observations: [{ ...observation, provenance: {} }] },
    { ...input, observations: [{ ...observation, provenance: { ...provenance, decision: true } }] },
    { ...input, observations: [{ ...observation, acceptedDecision: true }] },
    { ...input, sources: [{ ...source, generation: Infinity }] },
    { ...input, sources: [{ ...source, sourceRevision: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...input, sources: [{ ...source, generation: NaN }] },
    { ...input, sources: [{ ...source, sourceRevision: -1 }] },
    { ...input, sources: [{ ...source, generation: 1.5 }] },
    { ...input, hitIds: Array.from({ length: 129 }, () => observation.recordId) },
    { ...input, sources: Array.from({ length: 257 }, () => source) },
    { ...input, observations: Array.from({ length: 257 }, () => observation) },
  ])("denies malformed or oversized input %#", (value) => {
    expect(selectProjectMemoryHits(value)).toMatchObject({
      status: "denied",
      reason: "malformed-input",
      selected: [],
    });
  });

  it.each([
    { field: "sources", limit: 256, value: source },
    { field: "observations", limit: 256, value: observation },
    { field: "hitIds", limit: 128, value: observation.recordId },
  ])("rejects oversized $field before reading elements", ({ field, limit, value }) => {
    const oversized = Array.from({ length: limit + 1 }, () => value);
    let reads = 0;
    Object.defineProperty(oversized, 0, {
      get: () => {
        reads++;
        return value;
      },
    });
    expect(selectProjectMemoryHits({ ...input, [field]: oversized })).toMatchObject({
      status: "denied",
      reason: "malformed-input",
      selected: [],
    });
    expect(reads).toBe(0);
  });

  it("rejects oversized hits before touching either authoritative list", () => {
    let reads = 0;
    const sources = [source];
    const observations = [observation];
    for (const list of [sources, observations])
      Object.defineProperty(list, 0, {
        get: () => {
          reads++;
          return undefined;
        },
      });
    const hitIds = [observation.recordId];
    hitIds.length = 1_000_000_000;
    Object.defineProperty(hitIds, 0, {
      get: () => {
        reads++;
        return observation.recordId;
      },
    });
    expect(selectProjectMemoryHits({ ...input, sources, observations, hitIds })).toMatchObject({
      status: "denied",
      reason: "malformed-input",
      selected: [],
    });
    expect(reads).toBe(0);
  });

  it("decodes legitimate elements at each admission boundary", () => {
    const sources = Array.from({ length: 256 }, () => source);
    const observations = Array.from({ length: 256 }, () => observation);
    const hitIds = Array.from({ length: 128 }, () => observation.recordId);
    const reads = { sources: 0, observations: 0, hitIds: 0 };
    for (const [field, list, value] of [
      ["sources", sources, source],
      ["observations", observations, observation],
      ["hitIds", hitIds, observation.recordId],
    ] as const)
      Object.defineProperty(list, 0, {
        get: () => {
          reads[field]++;
          return value;
        },
      });
    expect(selectProjectMemoryHits({ ...input, sources, observations, hitIds })).toMatchObject({
      status: "accepted",
      selected: [observation],
      rejectionCounts: { duplicateHit: 127 },
    });
    expect(Object.values(reads).every((count) => count > 0)).toBe(true);
  });

  it("accepts boundary sizes without output exceeding the hit bound", () => {
    const sources = Array.from({ length: 256 }, (_, index) => ({
      ...source,
      recordId: `source-${index}`,
    }));
    const observations = sources.map((item, index) => ({
      ...observation,
      recordId: `observation-${index}`,
      sourceId: item.recordId,
    }));
    const result = selectProjectMemoryHits({
      ...input,
      sources,
      observations,
      hitIds: observations.slice(0, 128).map((item) => item.recordId),
    });
    expect(result.status).toBe("accepted");
    expect(result.selected).toEqual(observations.slice(0, 128));
  });

  it("keeps inferred wording as an observation without promoting an accepted decision", () => {
    const inferred = { ...observation, body: "The accepted cache decision is thirty seconds." };
    const result = selectProjectMemoryHits({ ...input, observations: [inferred] });
    expect(result.selected).toEqual([inferred]);
    expect(result.selected[0]?.kind).toBe("memory-observation");
    expect(result.selected[0]?.provenance.actor.kind).toBe("agent");
    expect(result.selected[0]).not.toHaveProperty("acceptedDecision");
  });

  it("does not mutate or alias the caller's records and nested provenance", () => {
    const frozen = structuredClone(input);
    Object.freeze(frozen.sources[0]);
    Object.freeze(frozen.observations[0]?.provenance.actor);
    Object.freeze(frozen.observations[0]?.provenance.source);
    Object.freeze(frozen.observations[0]?.provenance);
    Object.freeze(frozen.observations[0]);
    Object.freeze(frozen.sources);
    Object.freeze(frozen.observations);
    Object.freeze(frozen.hitIds);
    Object.freeze(frozen);
    const result = selectProjectMemoryHits(frozen);
    expect(result.selected).toEqual([observation]);
    expect(result.selected[0]).not.toBe(frozen.observations[0]);
    expect(result.selected[0]?.provenance).not.toBe(frozen.observations[0]?.provenance);
    expect(result.selected[0]?.provenance.actor).not.toBe(frozen.observations[0]?.provenance.actor);
    expect(frozen).toEqual(input);
  });

  it("filters the P1 history through current contracts while retaining source provenance", () => {
    const sources = history.observations.map((item) => ({
      ...source,
      recordId: `${item.projectId}:${item.sourceId}`,
      projectId: item.projectId,
      generation: item.generation,
      sourceRevision: item.revision,
      status: item.status === "deleted" ? "retracted" : item.status,
      ...(item.status === "deleted" ? { tombstonedAt: now } : {}),
      content: item.body,
    }));
    const observations = history.observations.map((item) => ({
      ...observation,
      recordId: item.id,
      projectId: item.projectId,
      sourceId: `${item.projectId}:${item.sourceId}`,
      sourceRevision: item.revision,
      sourceGeneration: item.generation,
      status: item.status === "deleted" ? "retracted" : item.status,
      ...(item.status === "deleted" ? { tombstonedAt: now } : {}),
      body: item.body,
      provenance: { ...provenance, source: { kind: "provider", id: item.provenance.evidenceId } },
    }));
    const result = selectProjectMemoryHits({
      ...input,
      sources,
      observations,
      hitIds: observations.map((item) => item.recordId),
    });
    expect(result.selected.map((item) => item.recordId)).toEqual([
      "atlas-transport",
      "atlas-receipts",
      "atlas-storage-current",
    ]);
    expect(result.selected.map((item) => item.provenance.source.id)).toEqual([
      "transport-test-1",
      "receipt-test-1",
      "migration-test-2",
    ]);
  });
});
