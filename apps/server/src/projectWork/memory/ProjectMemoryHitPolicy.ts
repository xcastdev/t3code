import {
  canonicalProjectWorkPayload,
  ProjectId,
  ProjectMemoryObservation,
  ProjectMemorySource,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256), Schema.isTrimmed());
const TargetProjectId = Schema.toType(ProjectId).check(Schema.isTrimmed(), Schema.isMaxLength(256));
const Version = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Source = Schema.Struct({
  ...ProjectMemorySource.fields,
  recordId: Id,
  projectId: TargetProjectId,
  revision: Version,
  generation: Version,
  sourceId: Schema.toType(ProjectMemorySource.fields.sourceId).check(Schema.isTrimmed()),
  sourceRevision: Version,
  attribution: Schema.toType(ProjectMemorySource.fields.attribution),
  supersedes: Schema.optionalKey(Id),
  sharedWithProjectIds: Schema.Array(TargetProjectId).check(Schema.isMaxLength(32)),
});
const Observation = Schema.Struct({
  ...ProjectMemoryObservation.fields,
  recordId: Id,
  projectId: TargetProjectId,
  revision: Version,
  generation: Version,
  sourceId: Id,
  sourceRevision: Version,
  sourceGeneration: Version,
  provenance: Schema.toType(ProjectMemoryObservation.fields.provenance),
  supersedes: Schema.optionalKey(Id),
});
const Envelope = Schema.Struct({
  projectId: TargetProjectId,
  authorityComplete: Schema.Boolean,
  sources: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(256)),
  observations: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(256)),
  hitIds: Schema.Array(Id).check(Schema.isMaxLength(128)),
});
const decodeEnvelope = Schema.decodeUnknownOption(Envelope, { onExcessProperty: "error" });
const decodeAuthority = Schema.decodeUnknownOption(
  Schema.Struct({
    ...Envelope.fields,
    sources: Schema.Array(Source),
    observations: Schema.Array(Observation),
  }),
  { onExcessProperty: "error" },
);

const denied = (
  reason:
    | "malformed-input"
    | "incomplete-authority"
    | "conflicting-authority"
    | "invalid-supersession",
) => ({
  status: "denied" as const,
  reason,
  selected: [] as ReadonlyArray<ProjectMemoryObservation>,
});

/** Sources must come from a server-authorized, transactionally current snapshot,
 * including the complete supersession closure and retained tombstones. The
 * completeness marker is a caller obligation, never an engine/client assertion. */
export const selectProjectMemoryHits = (input: unknown) => {
  // Schema array checks can read elements before rejecting length.
  if (
    !Predicate.isObject(input) ||
    !Array.isArray(input.sources) ||
    input.sources.length > 256 ||
    !Array.isArray(input.observations) ||
    input.observations.length > 256 ||
    !Array.isArray(input.hitIds) ||
    input.hitIds.length > 128
  )
    return denied("malformed-input");
  const envelope = decodeEnvelope(input);
  if (Option.isNone(envelope)) return denied("malformed-input");
  const decoded = decodeAuthority(envelope.value);
  if (Option.isNone(decoded)) return denied("malformed-input");
  const { projectId, authorityComplete, sources, observations, hitIds } = decoded.value;
  if (!authorityComplete) return denied("incomplete-authority");

  const records = new Map<string, ProjectMemorySource | ProjectMemoryObservation>();
  for (const record of [...sources, ...observations]) {
    const previous = records.get(record.recordId);
    if (
      previous !== undefined &&
      canonicalProjectWorkPayload(previous) !== canonicalProjectWorkPayload(record)
    )
      return denied("conflicting-authority");
    records.set(record.recordId, record);
  }

  const superseded = new Set<string>();
  for (const record of records.values()) {
    if (record.supersedes === undefined) continue;
    const previous = records.get(record.supersedes);
    if (
      previous === undefined ||
      previous.kind !== record.kind ||
      previous.projectId !== record.projectId
    )
      return denied("invalid-supersession");
    // Retraction of a correction must not revive the old fact.
    superseded.add(previous.recordId);
  }
  const checked = new Set<string>();
  for (const record of records.values()) {
    const path = new Set<string>();
    let cursor: ProjectMemorySource | ProjectMemoryObservation | undefined = record;
    while (cursor !== undefined && !checked.has(cursor.recordId)) {
      if (path.has(cursor.recordId)) return denied("invalid-supersession");
      path.add(cursor.recordId);
      cursor = cursor.supersedes === undefined ? undefined : records.get(cursor.supersedes);
    }
    for (const id of path) checked.add(id);
  }

  const selected: Array<ProjectMemoryObservation> = [];
  const rejectionCounts = {
    duplicateHit: 0,
    unknownObservation: 0,
    unavailableObservation: 0,
    unavailableSource: 0,
    unauthorizedProject: 0,
    staleSource: 0,
  };
  const seen = new Set<string>();
  for (const id of hitIds) {
    if (seen.has(id)) {
      rejectionCounts.duplicateHit++;
      continue;
    }
    seen.add(id);
    const observation = records.get(id);
    if (observation?.kind !== "memory-observation") {
      rejectionCounts.unknownObservation++;
      continue;
    }
    if (
      observation.status !== "current" ||
      observation.tombstonedAt !== undefined ||
      superseded.has(id)
    ) {
      rejectionCounts.unavailableObservation++;
      continue;
    }
    const source = records.get(observation.sourceId);
    if (
      source?.kind !== "memory-source" ||
      source.status !== "current" ||
      source.tombstonedAt !== undefined ||
      superseded.has(source.recordId)
    ) {
      rejectionCounts.unavailableSource++;
      continue;
    }
    if (
      observation.projectId !== source.projectId ||
      (source.projectId !== projectId && !source.sharedWithProjectIds.includes(projectId))
    ) {
      rejectionCounts.unauthorizedProject++;
      continue;
    }
    if (
      observation.sourceRevision !== source.sourceRevision ||
      observation.sourceGeneration !== source.generation
    ) {
      rejectionCounts.staleSource++;
      continue;
    }
    selected.push(observation);
  }
  return { status: "accepted" as const, selected, rejectionCounts };
};
