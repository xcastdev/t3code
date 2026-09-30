import history from "./projectHistory.json";

export { history };
export type FixtureObservation = (typeof history.observations)[number];
export type FixtureQuery = (typeof history.queries)[number];

/** Probe-only normalization. Backend IDs cannot authorize hydration of a source. */
export interface ProbeHit {
  readonly id: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly revision: number;
  readonly generation: number;
  readonly provenance: Readonly<Record<string, string>>;
}

/** Evaluate unfiltered hits so a namespace or deletion failure cannot disappear
 * behind a correct local hydration filter. Empty-result cases have no recall. */
export const evaluateMemoryHits = (query: FixtureQuery, hits: ReadonlyArray<ProbeHit>) => {
  const violations: Array<string> = [];
  const seen = new Set<string>();
  const valid = new Set<string>();
  for (const hit of hits) {
    const violationCount = violations.length;
    if (seen.has(hit.id)) violations.push(`duplicate:${hit.id}`);
    seen.add(hit.id);
    const source = history.observations.find((observation) => observation.id === hit.id);
    if (!source) {
      violations.push(`unknown:${hit.id}`);
      continue;
    }
    if (hit.projectId !== query.projectId || source.projectId !== query.projectId)
      violations.push(`cross-project:${hit.id}`);
    if (source.status === "deleted") violations.push(`deleted:${hit.id}`);
    if (source.status === "superseded") violations.push(`superseded:${hit.id}`);
    if (
      hit.sourceId !== source.sourceId ||
      hit.revision !== source.revision ||
      hit.generation !== source.generation
    )
      violations.push(`stale-source:${hit.id}`);
    if (Object.entries(source.provenance).some(([key, value]) => hit.provenance[key] !== value))
      violations.push(`provenance:${hit.id}`);
    if (violations.length === violationCount) valid.add(hit.id);
  }
  const relevant = query.relevantIds.filter((id) => valid.has(id));
  return {
    violations,
    relevantIds: relevant,
    missingIds: query.relevantIds.filter((id) => !valid.has(id)),
    recall: query.relevantIds.length === 0 ? null : relevant.length / query.relevantIds.length,
  };
};

export const fixtureHit = (observation: FixtureObservation): ProbeHit => ({
  id: observation.id,
  projectId: observation.projectId,
  sourceId: observation.sourceId,
  revision: observation.revision,
  generation: observation.generation,
  provenance: observation.provenance,
});
