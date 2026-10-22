import { MemoryOwner, MemoryEmbeddingRoute } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../../processRunner.ts";

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
export const MemoryCompanionDestination = Schema.Struct({
  owner: MemoryOwner,
  environmentId: Id,
  enabled: Schema.Literal(true),
  embeddingEnabled: Schema.Literal(true),
  command: Id,
  args: Schema.Array(Id).check(Schema.isMaxLength(32)),
  backend: Schema.optionalKey(Schema.Literal("mem0")),
  embeddingRoute: Schema.optionalKey(MemoryEmbeddingRoute),
  cwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
});
export type MemoryCompanionDestination = typeof MemoryCompanionDestination.Type;

export class MemoryBackendError extends Schema.TaggedError<MemoryBackendError>()(
  "MemoryBackendError",
  {
    reason: Schema.Literals(["disabled", "unavailable", "invalid-response"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Optional memory backend ${this.reason}.`;
  }
}
const Mem0Response = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  requestId: Schema.String,
  operation: Schema.String,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
});
const decodeMem0Response = Schema.decodeUnknownEffect(Schema.fromJsonString(Mem0Response));
const Reconciled = Schema.Struct({
  complete: Schema.Literal(true),
  missingObservationIds: Schema.Array(Schema.String).check(Schema.isMaxLength(0)),
  invalidObservationIds: Schema.Array(Schema.String).check(Schema.isMaxLength(0)),
  unexpectedBackendIds: Schema.Array(Schema.String).check(Schema.isMaxLength(0)),
});
const validateReconciled = Schema.decodeUnknownEffect(Reconciled);
const validateCleaned = Schema.decodeUnknownEffect(
  Schema.Struct({ cleanupComplete: Schema.Literal(true) }),
);
const Response = Schema.Struct({
  operationKey: Schema.String,
  operation: Schema.Literals(["index", "cleanup"]),
  complete: Schema.Literal(true),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeDestination = Schema.decodeUnknownEffect(MemoryCompanionDestination);
const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(Response));

/** @public Explicit server configuration supplies the installed Python and bundled asset paths. */
export const mem0Destination = (input: {
  readonly environmentId: string;
  readonly owner: MemoryOwner;
  readonly pythonPath: string;
  readonly scriptPath: string;
  readonly storeRoot: string;
  readonly cwd: string;
  readonly embeddingRoute: MemoryEmbeddingRoute;
}): MemoryCompanionDestination => ({
  environmentId: input.environmentId,
  owner: input.owner,
  enabled: true,
  embeddingEnabled: true,
  backend: "mem0",
  embeddingRoute: input.embeddingRoute,
  command: input.pythonPath,
  args: [
    input.scriptPath,
    "--store-dir",
    input.storeRoot,
    "--dimensions",
    String(input.embeddingRoute.dimensions),
  ],
  cwd: input.cwd,
});
export class MemoryBackend extends Context.Service<
  MemoryBackend,
  {
    readonly execute: (input: {
      readonly destination: MemoryCompanionDestination;
      readonly operationKey: string;
      readonly operation: "index" | "cleanup";
      readonly payload: unknown;
    }) => Effect.Effect<void, MemoryBackendError>;
  }
>()("t3/projectWork/memory/MemoryBackend") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const execute = Effect.fn("MemoryBackend.execute")(function* (
    input: Parameters<MemoryBackend["Service"]["execute"]>[0],
  ) {
    const destination = yield* decodeDestination(input.destination).pipe(
      Effect.mapError((cause) => new MemoryBackendError({ reason: "disabled", cause })),
    );
    if (destination.backend === "mem0") {
      const invoke = Effect.fn("MemoryBackend.mem0")(function* (operation: string) {
        const result = yield* runner
          .run({
            command: destination.command,
            args: destination.args,
            cwd: destination.cwd,
            env: {},
            extendEnv: false,
            timeout: "60 seconds",
            maxOutputBytes: 262144,
            stdin: yield* encodeRequest({
              protocolVersion: 1,
              requestId: input.operationKey,
              operation,
              input: input.payload,
            }).pipe(
              Effect.mapError(
                (cause) => new MemoryBackendError({ reason: "invalid-response", cause }),
              ),
            ),
          })
          .pipe(
            Effect.mapError((cause) => new MemoryBackendError({ reason: "unavailable", cause })),
          );
        if (
          result.code !== 0 ||
          result.timedOut ||
          result.stdoutInvalidUtf8 ||
          result.stdoutTruncated
        )
          return yield* new MemoryBackendError({ reason: "unavailable" });
        const response = yield* decodeMem0Response(result.stdout).pipe(
          Effect.mapError((cause) => new MemoryBackendError({ reason: "invalid-response", cause })),
        );
        if (
          response.requestId !== input.operationKey ||
          response.operation !== operation ||
          response.error !== undefined
        )
          return yield* new MemoryBackendError({ reason: "unavailable" });
        return response.result;
      });
      if (input.operation === "cleanup")
        yield* validateCleaned(yield* invoke("delete-source")).pipe(
          Effect.mapError((cause) => new MemoryBackendError({ reason: "invalid-response", cause })),
        );
      else {
        yield* invoke("index");
        yield* validateReconciled(yield* invoke("reconcile")).pipe(
          Effect.mapError((cause) => new MemoryBackendError({ reason: "invalid-response", cause })),
        );
      }
      return;
    }
    // Each invocation owns a bounded subprocess. No inherited credentials activate or reach a route.
    const result = yield* runner
      .run({
        command: destination.command,
        args: destination.args,
        cwd: destination.cwd,
        env: {},
        extendEnv: false,
        timeout: "60 seconds",
        maxOutputBytes: 262_144,
        stdin: yield* encodeRequest({
          protocolVersion: 1,
          operationKey: input.operationKey,
          operation: input.operation,
          namespace: { environmentId: destination.environmentId, owner: destination.owner },
          payload: input.payload,
        }).pipe(
          Effect.mapError((cause) => new MemoryBackendError({ reason: "invalid-response", cause })),
        ),
      })
      .pipe(Effect.mapError((cause) => new MemoryBackendError({ reason: "unavailable", cause })));
    if (result.code !== 0 || result.timedOut || result.stdoutInvalidUtf8 || result.stdoutTruncated)
      return yield* new MemoryBackendError({ reason: "unavailable" });
    const response = yield* decodeResponse(result.stdout).pipe(
      Effect.mapError((cause) => new MemoryBackendError({ reason: "invalid-response", cause })),
    );
    if (response.operationKey !== input.operationKey || response.operation !== input.operation)
      return yield* new MemoryBackendError({ reason: "invalid-response" });
  });
  return MemoryBackend.of({ execute });
});
export const layer = Layer.effect(MemoryBackend, make);
