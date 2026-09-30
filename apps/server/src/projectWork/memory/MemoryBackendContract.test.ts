import { describe, expect, it } from "vite-plus/test";
import * as NodeSqlite from "node:sqlite";
import * as NodePerfHooks from "node:perf_hooks";

import { toProjectWorkFtsQuery } from "../ProjectWorkSearch.ts";
import {
  assembleFixtureMemoryBriefing,
  evaluateMemoryHits,
  fixtureHit,
  history,
  reconcileFixtureMemoryIndex,
} from "./fixtures/evaluateMemoryHits.ts";

const observation = (id: string) => {
  const source = history.observations.find((item) => item.id === id);
  if (!source) throw new Error(`Missing labeled source ${id}`);
  return source;
};
const query = (id: string) => {
  const item = history.queries.find((item) => item.id === id);
  if (!item) throw new Error(`Missing labeled query ${id}`);
  return item;
};

// These tests verify the evaluation oracle, source briefing consumer, and FTS comparator. They do not
// exercise Mem0/Graphiti or certify backend reliability, recovery, or model recall.
describe("MemoryBackendContract evaluation fixtures", () => {
  it("rejects namespace leakage even when two projects use the same source ID", () => {
    const result = evaluateMemoryHits(query("current-storage"), [
      fixtureHit(observation("borealis-storage")),
    ]);
    expect(result.violations).toContain("cross-project:borealis-storage");
    expect(result.recall).toBe(0);
  });

  it("rejects a retracted hit while asynchronous backend deletion is pending", () => {
    const result = evaluateMemoryHits(query("deleted"), [fixtureHit(observation("atlas-deleted"))]);
    expect(result.violations).toContain("deleted:atlas-deleted");
    expect(result.recall).toBeNull();
  });

  it("rejects superseded facts and old source revisions or generations", () => {
    const current = fixtureHit(observation("atlas-storage-current"));
    expect(
      evaluateMemoryHits(query("current-storage"), [fixtureHit(observation("atlas-storage-old"))])
        .violations,
    ).toContain("superseded:atlas-storage-old");
    for (const hit of [
      { ...current, revision: 1 },
      { ...current, generation: 1 },
      { ...current, sourceId: "forged-source" },
    ])
      expect(evaluateMemoryHits(query("current-storage"), [hit]).violations).toContain(
        "stale-source:atlas-storage-current",
      );
  });

  it("requires complete matching provenance on every returned observation", () => {
    const hit = fixtureHit(observation("atlas-transport"));
    for (const provenance of [{}, { ...hit.provenance, evidenceId: "invented-evidence" }])
      expect(
        evaluateMemoryHits(query("transport-literal"), [{ ...hit, provenance }]),
      ).toMatchObject({
        violations: ["provenance:atlas-transport"],
        recall: 0,
      });
    expect(
      evaluateMemoryHits(query("transport-literal"), [{ ...hit, id: "unknown-observation" }])
        .violations,
    ).toContain("unknown:unknown-observation");
  });

  it("labels both conflicting observations independently without inventing an accepted decision", () => {
    const conflict = query("conflict");
    const hits = conflict.relevantIds.map((id) => fixtureHit(observation(id)));
    expect(evaluateMemoryHits(conflict, hits)).toMatchObject({
      recall: 1,
      violations: [],
      missingIds: [],
    });
    expect(evaluateMemoryHits(conflict, hits.slice(0, 1))).toMatchObject({
      recall: 0.5,
      missingIds: ["atlas-cache-reviewer"],
    });
    expect(hits[0]?.provenance.evidenceId).not.toBe(hits[1]?.provenance.evidenceId);
  });

  it("detects duplicated retrieval after repeated requests or restart reconciliation", () => {
    const hit = fixtureHit(observation("atlas-receipts"));
    expect(evaluateMemoryHits(query("completion-literal"), [hit, hit])).toMatchObject({
      recall: 1,
      violations: ["duplicate:atlas-receipts"],
    });
  });

  it("measures the labeled corpus with the existing FTS tokenizer and real SQLite FTS5", () => {
    const database = new NodeSqlite.DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE VIRTUAL TABLE history USING fts5(id UNINDEXED, project_id UNINDEXED, body)",
      );
      const insert = database.prepare("INSERT INTO history VALUES (?, ?, ?)");
      // FTS fallback indexes current authorized sources, including unresolved
      // observations from both sides of a conflict.
      for (const source of history.observations)
        if (source.status === "current" || source.status === "conflicted")
          insert.run(source.id, source.projectId, source.body);
      const search = database.prepare(
        "SELECT id FROM history WHERE history MATCH ? AND project_id = ? ORDER BY rank LIMIT 10",
      );
      const results = history.queries.map((input) => {
        const startedAt = NodePerfHooks.performance.now();
        const rows = search.all(toProjectWorkFtsQuery(input.query), input.projectId);
        const hits = rows.map((row) => fixtureHit(observation(String(row.id))));
        return {
          queryId: input.id,
          latencyMs: NodePerfHooks.performance.now() - startedAt,
          hitIds: hits.map((hit) => hit.id),
          ...evaluateMemoryHits(input, hits),
        };
      });
      expect(results.every((result) => result.violations.length === 0)).toBe(true);
      expect(results.find((result) => result.queryId === "transport-semantic")?.recall).toBe(0);
      expect(results.find((result) => result.queryId === "completion-semantic")?.recall).toBe(0);
      expect(results.find((result) => result.queryId === "conflict")?.recall).toBe(1);
      // Keep the probe measurement in test output without introducing an Effect runtime.
      // @effect-diagnostics-next-line globalConsole:off
      console.info(
        JSON.stringify({
          fixtureId: history.fixtureId,
          comparator: "SQLite FTS5 + toProjectWorkFtsQuery",
          results,
        }),
      );
    } finally {
      database.close();
    }
  });
});

describe("MemoryBackendContract authoritative source briefing", () => {
  it("retains source content and decision status when extracted wording invents facts", () => {
    const current = observation("atlas-storage-current");
    const conflict = observation("atlas-cache-investigator");
    const before = JSON.stringify(history.observations);
    const briefing = assembleFixtureMemoryBriefing("atlas", history.observations, [
      {
        ...fixtureHit(current),
        backendId: "native-storage-id",
        observation: "As of September 30, 2026, SQLite is accepted forever.",
      },
      {
        ...fixtureHit(conflict),
        backendId: "native-cache-id",
        observation: "The accepted cache decision is thirty seconds.",
      },
    ]);
    expect(briefing).toEqual([
      { source: current, backendIds: ["native-storage-id"] },
      { source: conflict, backendIds: ["native-cache-id"] },
    ]);
    expect(JSON.stringify(briefing)).not.toContain("September 30");
    expect(briefing[1]?.source.provenance.recordKind).toBe("investigation");
    expect(briefing[1]?.source.status).toBe("conflicted");
    expect(JSON.stringify(history.observations)).toBe(before);
  });

  it("fences invalid sources before grouping and retains all native handles for audit", () => {
    const current = fixtureHit(observation("atlas-transport"));
    const hit = { ...current, backendId: "first-native-id", observation: "backend wording" };
    const briefing = assembleFixtureMemoryBriefing("atlas", history.observations, [
      hit,
      { ...hit, backendId: "second-native-id" },
      { ...hit, generation: 0, backendId: "stale-native-id" },
      { ...hit, provenance: {}, backendId: "unsourced-native-id" },
      { ...hit, ...fixtureHit(observation("atlas-deleted")), backendId: "deleted-native-id" },
      {
        ...hit,
        ...fixtureHit(observation("atlas-storage-old")),
        backendId: "superseded-native-id",
      },
      { ...hit, ...fixtureHit(observation("borealis-storage")), backendId: "foreign-native-id" },
    ]);
    expect(briefing).toEqual([
      {
        source: observation("atlas-transport"),
        backendIds: ["first-native-id", "second-native-id"],
      },
    ]);
  });
});

describe("MemoryBackendContract complete extraction receipt", () => {
  const source = fixtureHit(observation("borealis-storage"));
  const expected = [
    {
      key: "storage-fact",
      backendId: "native-first",
      source,
      observation: "Borealis uses PostgreSQL.",
    },
    {
      key: "sharing-fact",
      backendId: "native-second",
      source,
      observation: "Borealis has no sharing grant.",
    },
  ];
  const hits = expected.map((item) => ({
    ...source,
    backendId: item.backendId,
    observation: item.observation,
  }));

  it("keeps a partially committed multi-observation source pending until the full set is present", () => {
    expect(reconcileFixtureMemoryIndex(expected, hits.slice(0, 1))).toEqual({
      complete: false,
      missingKeys: ["sharing-fact"],
      invalidKeys: [],
      unexpectedBackendIds: [],
    });
    expect(reconcileFixtureMemoryIndex(expected, [])).toMatchObject({
      complete: false,
      missingKeys: ["storage-fact", "sharing-fact"],
    });
    expect(reconcileFixtureMemoryIndex(expected, hits).complete).toBe(true);
  });

  it("rejects unbound, duplicated, altered, or stale records instead of minting completion", () => {
    const first = hits[0];
    const second = hits[1];
    if (!first || !second) throw new Error("Two expected observations are required");
    for (const damaged of [
      { ...second, observation: "Invented replacement" },
      { ...second, generation: 0 },
      { ...second, provenance: {} },
      { ...second, projectId: "atlas" },
    ])
      expect(reconcileFixtureMemoryIndex(expected, [first, damaged])).toMatchObject({
        complete: false,
        invalidKeys: ["sharing-fact"],
      });
    expect(reconcileFixtureMemoryIndex(expected, [...hits, second]).complete).toBe(false);
    expect(
      reconcileFixtureMemoryIndex(expected, [
        ...hits,
        { ...second, backendId: "duplicate-new-id" },
      ]),
    ).toMatchObject({ complete: false, unexpectedBackendIds: ["duplicate-new-id"] });
    expect(
      reconcileFixtureMemoryIndex(
        expected.map((item) => ({ ...item, backendId: null })),
        hits,
      ).complete,
    ).toBe(false);
    expect(reconcileFixtureMemoryIndex([], []).complete).toBe(false);
  });
});
