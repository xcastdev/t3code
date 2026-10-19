import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  MEMORY_BACKEND_MAX_BYTES,
  MemoryBackendError,
  MemoryBackendOperation,
  MemoryBackendScope,
  MemoryBackendSearch,
  MemoryBackendSource,
  MemoryCleanupResult,
  MemoryHealthResult,
  MemoryIndexManifest,
  MemoryIndexResult,
  MemoryReconcileResult,
  MemorySearchResult,
  type MemoryBackend,
  type MemoryBackendTransport,
} from "./MemoryBackend.ts";

const Request = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  operation: MemoryBackendOperation,
  input: Schema.Unknown,
});
const ResponseError = Schema.Struct({
  code: Schema.Literals(["invalid-request", "unavailable", "fenced", "conflict"]),
  message: Schema.String.check(Schema.isMaxLength(256)),
});
const Response = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    requestId: Request.fields.requestId,
    operation: MemoryBackendOperation,
    result: Schema.Unknown,
  }),
  Schema.Struct({
    protocolVersion: Schema.Literal(1),
    requestId: Request.fields.requestId,
    operation: MemoryBackendOperation,
    error: ResponseError,
  }),
]);
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Request));
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response), {
  onExcessProperty: "error",
});

/** Thin prepared-vector adapter. Its transport must invoke the real companion dispatcher. */
export const makeMem0Backend = (transport: MemoryBackendTransport): MemoryBackend => {
  const exchange = Effect.fn("Mem0Backend.exchange")(function* <A, B>(
    operation: MemoryBackendOperation,
    requestId: string,
    input: A,
    inputSchema: Schema.Codec<A, unknown, never, never>,
    resultSchema: Schema.Codec<B, unknown, never, never>,
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(inputSchema, { onExcessProperty: "error" })(
      input,
    ).pipe(
      Effect.mapError(
        () =>
          new MemoryBackendError({
            code: "invalid-request",
            message: "Invalid memory index input",
          }),
      ),
    );
    const encoded = yield* encodeRequest({
      protocolVersion: 1,
      requestId,
      operation,
      input: decoded,
    }).pipe(
      Effect.mapError(
        () =>
          new MemoryBackendError({
            code: "invalid-request",
            message: "Invalid memory index request",
          }),
      ),
    );
    const bytes = new TextEncoder().encode(encoded);
    if (bytes.byteLength > MEMORY_BACKEND_MAX_BYTES) {
      return yield* new MemoryBackendError({
        code: "invalid-request",
        message: "Memory index request exceeds byte limit",
      });
    }
    const returned = yield* transport(bytes);
    if (returned.byteLength > MEMORY_BACKEND_MAX_BYTES) {
      return yield* new MemoryBackendError({
        code: "invalid-response",
        message: "Memory index response exceeds byte limit",
      });
    }
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(returned),
      catch: () =>
        new MemoryBackendError({
          code: "invalid-response",
          message: "Memory index response is not UTF-8",
        }),
    });
    const response = yield* decodeResponse(text).pipe(
      Effect.mapError(
        () =>
          new MemoryBackendError({
            code: "invalid-response",
            message: "Invalid memory index response",
          }),
      ),
    );
    if (response.requestId !== requestId || response.operation !== operation) {
      return yield* new MemoryBackendError({
        code: "invalid-response",
        message: "Memory index response does not match request",
      });
    }
    if ("error" in response) return yield* new MemoryBackendError(response.error);
    const result = yield* Schema.decodeUnknownEffect(resultSchema, { onExcessProperty: "error" })(
      response.result,
    ).pipe(
      Effect.mapError(
        () =>
          new MemoryBackendError({
            code: "invalid-response",
            message: "Invalid memory index result",
          }),
      ),
    );
    return result;
  });
  return {
    health: (id, input) => exchange("health", id, input, MemoryBackendScope, MemoryHealthResult),
    index: (id, input) => exchange("index", id, input, MemoryIndexManifest, MemoryIndexResult),
    reconcile: (id, input) =>
      exchange("reconcile", id, input, MemoryIndexManifest, MemoryReconcileResult),
    search: Effect.fn("Mem0Backend.search")(function* (id, input) {
      const result = yield* exchange("search", id, input, MemoryBackendSearch, MemorySearchResult);
      if (
        result.candidates.length > input.limit ||
        result.candidates.some(
          (candidate) =>
            candidate.environmentId !== input.environmentId ||
            candidate.projectId !== input.projectId ||
            (input.source !== undefined &&
              (candidate.sourceRecordId !== input.source.sourceRecordId ||
                candidate.sourceRevision !== input.source.sourceRevision ||
                candidate.sourceGeneration !== input.source.sourceGeneration)),
        )
      ) {
        return yield* new MemoryBackendError({
          code: "invalid-response",
          message: "Memory candidates exceed authorized namespace or limit",
        });
      }
      return result;
    }),
    deleteSource: (id, input) =>
      exchange("delete-source", id, input, MemoryBackendSource, MemoryCleanupResult),
    deleteProject: (id, input) =>
      exchange("delete-project", id, input, MemoryBackendScope, MemoryCleanupResult),
  };
};
