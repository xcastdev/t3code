import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectWorkAttribution, ProjectWorkAttributionRead } from "./projectWorkCore.ts";
const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
const Ids = Schema.Array(Text.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(256));
const Fields = {
  recordId: Text.check(Schema.isMaxLength(256)),
  projectId: ProjectId,
  revision: NonNegativeInt,
  generation: NonNegativeInt,
  updatedAt: IsoDateTime,
};
export const ProjectMemorySource = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("memory-source"),
  status: Schema.Literals(["current", "conflicted", "superseded", "retracted"]),
  sourceKind: Schema.Literals(["finding", "result", "decision", "conversation", "artifact"]),
  sourceId: Text,
  sourceRevision: NonNegativeInt,
  content: Schema.String.check(Schema.isMaxLength(32_000)),
  contentHash: Text,
  attribution: ProjectWorkAttribution,
  supersedes: Schema.optionalKey(Text),
  sharedWithProjectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(32)),
  tombstonedAt: Schema.optionalKey(IsoDateTime),
});
export type ProjectMemorySource = typeof ProjectMemorySource.Type;
export const ProjectMemorySourceRead = Schema.Struct({
  ...ProjectMemorySource.fields,
  status: Text,
  sourceKind: Text,
  attribution: ProjectWorkAttributionRead,
});
export const ProjectMemoryExtraction = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("memory-extraction"),
  status: Schema.Literals(["pending", "extracted", "no-facts", "indexed", "failed", "retracted"]),
  engine: Schema.Literal("mem0"),
  engineVersion: Schema.Literal("2.2.1"),
  sourceId: Text,
  sourceRevision: NonNegativeInt,
  sourceGeneration: NonNegativeInt,
  extractionModel: Text,
  embeddingModel: Text,
  embeddingDimensions: Schema.Literal(2048),
  expectedObservationIds: Ids,
  completedObservationIds: Ids,
  extractionHash: Schema.optionalKey(Text),
  error: Schema.optionalKey(Text),
});
export type ProjectMemoryExtraction = typeof ProjectMemoryExtraction.Type;
export const ProjectMemoryExtractionRead = Schema.Struct({
  ...ProjectMemoryExtraction.fields,
  status: Text,
  engine: Text,
  engineVersion: Text,
});
export const ProjectMemoryObservation = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("memory-observation"),
  status: Schema.Literals(["current", "conflicted", "superseded", "retracted"]),
  sourceId: Text,
  sourceRevision: NonNegativeInt,
  sourceGeneration: NonNegativeInt,
  extractionId: Text,
  observationKey: Text,
  body: Schema.String.check(Schema.isMaxLength(8_000)),
  provenance: ProjectWorkAttribution,
  supersedes: Schema.optionalKey(Text),
  tombstonedAt: Schema.optionalKey(IsoDateTime),
});
export type ProjectMemoryObservation = typeof ProjectMemoryObservation.Type;
export const ProjectMemoryObservationRead = Schema.Struct({
  ...ProjectMemoryObservation.fields,
  status: Text,
  provenance: ProjectWorkAttributionRead,
});
