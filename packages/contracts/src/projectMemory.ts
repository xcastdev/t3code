import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  EnvironmentId,
  MessageId,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { MemoryOwner, MemoryOwnerRevision } from "./memoryOwner.ts";
import { ProjectWorkAttribution, ProjectWorkAttributionRead } from "./projectWorkCore.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
const Id = Text.check(Schema.isMaxLength(256));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Revision = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Ids = Schema.Array(Id).check(Schema.isMaxLength(256));
const Fields = {
  recordId: Id,
  owner: MemoryOwner,
  ownerRevision: MemoryOwnerRevision,
  revision: Revision,
  generation: Revision,
  updatedAt: IsoDateTime,
};

// Message revisions survive transcript compaction; event cursors do not identify captured content.
export const ProjectMemoryConversationSpan = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  contentHash: Digest,
  contentRevision: Revision,
  start: NonNegativeInt,
  end: NonNegativeInt,
}).check(Schema.makeFilter((span) => span.end > span.start));
export type ProjectMemoryConversationSpan = typeof ProjectMemoryConversationSpan.Type;

const SourceFields = {
  ...Fields,
  kind: Schema.Literal("memory-source"),
  status: Schema.Literals(["current", "conflicted", "superseded", "retracted"]),
  sourceKind: Schema.Literals(["finding", "result", "decision", "conversation", "artifact"]),
  sourceId: Id,
  sourceRevision: Revision,
  content: Schema.String.check(Schema.isMaxLength(32_000)),
  contentHash: Digest,
  contentRevision: Revision,
  conversationSpans: Schema.Array(ProjectMemoryConversationSpan).check(Schema.isMaxLength(64)),
  attribution: ProjectWorkAttribution,
  supersedes: Schema.optionalKey(Id),
  tombstonedAt: Schema.optionalKey(IsoDateTime),
};
const validSourceSpans = (source: {
  readonly sourceKind: string;
  readonly conversationSpans: ReadonlyArray<unknown>;
}) => source.sourceKind !== "conversation" || source.conversationSpans.length > 0;
export const ProjectMemorySource = Schema.Struct(SourceFields).check(
  Schema.makeFilter(validSourceSpans),
);
export type ProjectMemorySource = typeof ProjectMemorySource.Type;
export const ProjectMemorySourceRead = Schema.Struct({
  ...SourceFields,
  status: Text,
  sourceKind: Text,
  attribution: ProjectWorkAttributionRead,
}).check(Schema.makeFilter(validSourceSpans));
export type ProjectMemorySourceRead = typeof ProjectMemorySourceRead.Type;

export const ProjectMemoryExtraction = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("memory-extraction"),
  status: Schema.Literals(["pending", "extracted", "no-facts", "indexed", "failed", "retracted"]),
  engine: Text,
  engineVersion: Text,
  sourceId: Id,
  sourceRevision: Revision,
  sourceGeneration: Revision,
  contentHash: Digest,
  contentRevision: Revision,
  extractionModel: Text,
  embeddingModel: Text,
  embeddingDimensions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
  expectedObservationIds: Ids,
  completedObservationIds: Ids,
  extractionHash: Schema.optionalKey(Digest),
  error: Schema.optionalKey(Text),
});
export type ProjectMemoryExtraction = typeof ProjectMemoryExtraction.Type;
export const ProjectMemoryExtractionRead = Schema.Struct({
  ...ProjectMemoryExtraction.fields,
  status: Text,
});
export type ProjectMemoryExtractionRead = typeof ProjectMemoryExtractionRead.Type;

export const ProjectMemoryObservation = Schema.Struct({
  ...Fields,
  kind: Schema.Literal("memory-observation"),
  status: Schema.Literals(["current", "conflicted", "superseded", "retracted"]),
  sourceId: Id,
  sourceRevision: Revision,
  sourceGeneration: Revision,
  contentHash: Digest,
  contentRevision: Revision,
  extractionId: Id,
  observationKey: Id,
  body: Schema.String.check(Schema.isMaxLength(8_000)),
  conversationSpans: Schema.Array(ProjectMemoryConversationSpan).check(Schema.isMaxLength(64)),
  provenance: ProjectWorkAttribution,
  supersedes: Schema.optionalKey(Id),
  tombstonedAt: Schema.optionalKey(IsoDateTime),
});
export type ProjectMemoryObservation = typeof ProjectMemoryObservation.Type;
export const ProjectMemoryObservationRead = Schema.Struct({
  ...ProjectMemoryObservation.fields,
  status: Text,
  provenance: ProjectWorkAttributionRead,
});
export type ProjectMemoryObservationRead = typeof ProjectMemoryObservationRead.Type;

export const MemoryExtractionFact = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  quote: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MemoryExtractionFact = typeof MemoryExtractionFact.Type;

export const MemoryExtractionResult = Schema.Struct({
  facts: Schema.Array(MemoryExtractionFact).check(
    Schema.isMaxLength(32),
    Schema.makeFilter((facts) => new Set(facts.map((fact) => fact.key)).size === facts.length),
    Schema.makeFilter(
      (facts) =>
        facts.reduce(
          (bytes, fact) =>
            bytes + new TextEncoder().encode(fact.key + fact.body + fact.quote).byteLength,
          0,
        ) <= 64_000,
    ),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type MemoryExtractionResult = typeof MemoryExtractionResult.Type;

const MemoryEndpoint = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }),
);
const MemoryRouteFields = {
  environmentId: EnvironmentId,
  owner: MemoryOwner,
  enabled: Schema.Literal(true),
  endpoint: MemoryEndpoint,
  model: Id,
  secretName: Id,
};
export const MemoryExtractionRoute = Schema.Struct({
  ...MemoryRouteFields,
  provider: Schema.Literals(["command-code", "liquid"]),
});
export type MemoryExtractionRoute = typeof MemoryExtractionRoute.Type;
export const MemoryEmbeddingRoute = Schema.Struct({
  ...MemoryRouteFields,
  dimensions: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })),
});
export type MemoryEmbeddingRoute = typeof MemoryEmbeddingRoute.Type;
export const MemoryProcessingConfiguration = Schema.Struct({
  extractionRoute: Schema.optionalKey(MemoryExtractionRoute),
  destination: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.Literal(true),
      embeddingEnabled: Schema.Literal(true),
      backend: Schema.Literal("mem0"),
      embeddingRoute: MemoryEmbeddingRoute,
    }),
  ),
});
export type MemoryProcessingConfiguration = typeof MemoryProcessingConfiguration.Type;
