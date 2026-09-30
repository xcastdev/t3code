import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const MEMORY_BACKEND_MAX_BYTES = 16 * 1024 * 1024;
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const MemoryVector = Schema.Array(
  Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: -3.4028234663852886e38, maximum: 3.4028234663852886e38 }),
  ),
).check(Schema.isMinLength(2048), Schema.isMaxLength(2048));

export const MemoryBackendScope = Schema.Struct({ environmentId: Id, projectId: Id });
const SourceFields = {
  ...MemoryBackendScope.fields,
  sourceRecordId: Id,
  sourceRevision: Counter,
  sourceGeneration: Counter,
};
export const MemoryBackendSource = Schema.Struct(SourceFields);
export const MemoryIndexObservation = Schema.Struct({
  observationId: Id,
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  /** Fingerprint of the frozen T3 observation including its retained provenance. */
  payloadHash: Hash,
  vector: MemoryVector,
});
export const MemoryIndexManifest = Schema.Struct({
  ...SourceFields,
  extractionId: Id,
  observations: Schema.Array(MemoryIndexObservation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.makeFilter(
      (entries) => new Set(entries.map((entry) => entry.observationId)).size === entries.length,
      { message: "Observation IDs must be unique" },
    ),
  ),
});
export const MemoryBackendSearch = Schema.Struct({
  ...MemoryBackendScope.fields,
  vector: MemoryVector,
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});
export const MemoryBackendCandidate = Schema.Struct({
  ...SourceFields,
  extractionId: Id,
  observationId: Id,
  score: Schema.Number.check(Schema.isFinite()),
});
const Ids = Schema.Array(Id).check(Schema.isMaxLength(256));
export const MemoryIndexResult = Schema.Struct({ writtenObservationIds: Ids });
export const MemoryReconcileResult = Schema.Struct({
  complete: Schema.Boolean,
  missingObservationIds: Ids,
  invalidObservationIds: Ids,
  unexpectedBackendIds: Schema.Array(Id).check(Schema.isMaxLength(256)),
});
export const MemorySearchResult = Schema.Struct({
  candidates: Schema.Array(MemoryBackendCandidate).check(Schema.isMaxLength(100)),
});
export const MemoryCleanupResult = Schema.Struct({ cleanupComplete: Schema.Literal(true) });
export const MemoryHealthResult = Schema.Struct({
  engine: Schema.Literal("mem0"),
  engineVersion: Schema.Literal("2.2.1"),
  qdrantVersion: Schema.Literal("1.19.1"),
  embeddingDimensions: Schema.Literal(2048),
});
export const MemoryBackendOperation = Schema.Literals([
  "health",
  "index",
  "reconcile",
  "search",
  "delete-source",
  "delete-project",
]);
export type MemoryBackendOperation = typeof MemoryBackendOperation.Type;
export class MemoryBackendError extends Schema.TaggedError<MemoryBackendError>()(
  "MemoryBackendError",
  {
    code: Schema.Literals([
      "invalid-request",
      "invalid-response",
      "unavailable",
      "fenced",
      "conflict",
    ]),
    message: Schema.String,
  },
) {}

/** Single-envelope bytes, not a presumed HTTP API. The owner supplies lifecycle/auth. */
export type MemoryBackendTransport = (
  request: Uint8Array,
) => Effect.Effect<Uint8Array, MemoryBackendError>;

/** Candidates are untrusted selectors; T3 must revalidate authority before hydration.
 * This prepared-vector boundary never extracts, promotes decisions, or completes an outbox.
 */
export interface MemoryBackend {
  health: (
    requestId: string,
    input: typeof MemoryBackendScope.Type,
  ) => Effect.Effect<typeof MemoryHealthResult.Type, MemoryBackendError>;
  index: (
    requestId: string,
    input: typeof MemoryIndexManifest.Type,
  ) => Effect.Effect<typeof MemoryIndexResult.Type, MemoryBackendError>;
  reconcile: (
    requestId: string,
    input: typeof MemoryIndexManifest.Type,
  ) => Effect.Effect<typeof MemoryReconcileResult.Type, MemoryBackendError>;
  search: (
    requestId: string,
    input: typeof MemoryBackendSearch.Type,
  ) => Effect.Effect<typeof MemorySearchResult.Type, MemoryBackendError>;
  deleteSource: (
    requestId: string,
    input: typeof MemoryBackendSource.Type,
  ) => Effect.Effect<typeof MemoryCleanupResult.Type, MemoryBackendError>;
  deleteProject: (
    requestId: string,
    input: typeof MemoryBackendScope.Type,
  ) => Effect.Effect<typeof MemoryCleanupResult.Type, MemoryBackendError>;
}
