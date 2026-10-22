import { readRetainedMemoryFacts } from "./ProjectMemoryRetainedFacts.ts";
import {
  EnvironmentId,
  NonNegativeInt,
  canonicalProjectWorkPayload,
  MemoryExtractionResult,
  MemoryExtractionRoute,
  MemoryOwner,
  ModelSelection,
  memoryOwnerEquals,
} from "@t3tools/contracts";
import { ProjectMemoryFactPolicy } from "./ProjectMemoryFactPolicy.ts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as MemoryBackend from "./MemoryBackend.ts";
import * as Configuration from "./ProjectMemoryConfiguration.ts";
import * as ModelRoutes from "./ProjectMemoryModelRoutes.ts";
import * as Authority from "./ProjectMemoryService.ts";
import { memoryHash, type MemorySourceTuple } from "./ProjectMemoryRepository.ts";

const Tuple = Schema.Struct({
  environmentId: EnvironmentId,
  owner: MemoryOwner,
  ownerRevision: NonNegativeInt,
  sourceId: Schema.String,
  sourceRevision: NonNegativeInt,
  generation: NonNegativeInt,
  contentHash: Schema.String,
});
const Input = Schema.Struct({
  tuple: Tuple,
  cwd: Schema.String,
  modelSelection: ModelSelection,
  extractionRoute: Schema.optionalKey(MemoryExtractionRoute),
  destination: Schema.optionalKey(MemoryBackend.MemoryCompanionDestination),
  configurationRevision: Schema.optionalKey(NonNegativeInt),
});
const decodeInput = Schema.decodeUnknownEffect(Schema.fromJsonString(Input));
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryExtractionResult));
const validateResult = Schema.decodeUnknownEffect(MemoryExtractionResult);
const decodeTuple = Schema.decodeUnknownEffect(Schema.fromJsonString(Tuple));
const decodeDestination = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MemoryBackend.MemoryCompanionDestination),
);
type ExtractionInput = {
  readonly tuple: MemorySourceTuple;
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly extractionRoute?: MemoryExtractionRoute;
  readonly destination?: MemoryBackend.MemoryCompanionDestination;
  readonly configurationRevision?: number;
};
export class MemoryProcessingError extends Schema.TaggedError<MemoryProcessingError>()(
  "MemoryProcessingError",
  {
    reason: Schema.Literals(["storage", "invalid-facts", "stale", "conflict", "unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Optional memory processing ${this.reason}.`;
  }
}
const ownerId = (owner: MemoryOwner) =>
  owner.kind === "project" ? owner.projectId : owner.assistantId;
const keyFor = (tuple: MemorySourceTuple, operation: string) =>
  memoryHash(
    canonicalProjectWorkPayload([
      tuple.environmentId,
      tuple.owner.kind,
      ownerId(tuple.owner),
      tuple.ownerRevision,
      tuple.sourceId,
      tuple.sourceRevision,
      tuple.generation,
      tuple.contentHash,
      operation,
    ]),
  );
interface Row {
  operation_key: string;
  status: string;
  input_json: string;
  result_json: string | null;
  destination_json: string | null;
  index_json: string | null;
}
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(Input));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(MemoryExtractionResult));
const encodeDestination = Schema.encodeEffect(
  Schema.fromJsonString(MemoryBackend.MemoryCompanionDestination),
);
const isProcessingError = Schema.is(MemoryProcessingError);
const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const backendTuple = (tuple: MemorySourceTuple) => ({
  environmentId: tuple.environmentId,
  ownerKind: tuple.owner.kind,
  ownerId: ownerId(tuple.owner),
  ownerRevision: tuple.ownerRevision,
  sourceRecordId: tuple.sourceId,
  sourceRevision: tuple.sourceRevision,
  sourceGeneration: tuple.generation,
  contentHash: tuple.contentHash,
});
const storage = (cause: unknown) => new MemoryProcessingError({ reason: "storage", cause });
export class ProjectMemoryProcessing extends Context.Service<
  ProjectMemoryProcessing,
  {
    readonly enqueueExtraction: (
      input: ExtractionInput,
    ) => Effect.Effect<string, MemoryProcessingError>;
    readonly run: (operationKey: string) => Effect.Effect<void, MemoryProcessingError>;
    readonly index: (
      operationKey: string,
      destination: MemoryBackend.MemoryCompanionDestination,
    ) => Effect.Effect<void, MemoryProcessingError>;
    readonly reconcile: (
      after?: string,
    ) => Effect.Effect<ReadonlyArray<string>, MemoryProcessingError>;
    readonly cleanup: (
      after?: string,
    ) => Effect.Effect<ReadonlyArray<string>, MemoryProcessingError>;
  }
>()("t3/projectWork/memory/ProjectMemoryProcessing") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const factPolicy = yield* Effect.serviceOption(ProjectMemoryFactPolicy);
  const lock = yield* Semaphore.make(1);
  const authority = yield* Authority.ProjectMemoryService;
  const generation = yield* TextGeneration.TextGeneration;
  const backend = yield* MemoryBackend.MemoryBackend;
  const routes = yield* ModelRoutes.ProjectMemoryModelRoutes;
  const configuration = yield* Configuration.ProjectMemoryConfiguration;
  const readCurrent = Effect.fn("ProjectMemoryProcessing.readCurrent")((tuple: MemorySourceTuple) =>
    authority.readSource(tuple).pipe(
      Effect.catchTags({
        ProjectMemoryError: (error) =>
          error.reason === "stale" || error.reason === "forbidden"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
      }),
    ),
  );
  const invalidateIndex = Effect.fn("ProjectMemoryProcessing.invalidateIndex")(function* (
    tuple: MemorySourceTuple,
    key: string,
  ) {
    yield* sql`UPDATE t3_workflow_v2_memory_processing SET status='stale' WHERE operation_key=${key}`;
    yield* authority.enqueueCleanup(tuple, key);
  });
  const load = Effect.fn("ProjectMemoryProcessing.load")(function* (key: string) {
    return (yield* sql<Row>`SELECT * FROM t3_workflow_v2_memory_processing WHERE operation_key=${key} AND length(CAST(input_json AS BLOB))<=65536 AND (result_json IS NULL OR length(CAST(result_json AS BLOB))<=524288)`)[0];
  }, Effect.mapError(storage));
  const authorizeExternal = Effect.fn("ProjectMemoryProcessing.authorizeExternal")(function* (
    input: ExtractionInput,
    key: string,
    destination?: MemoryBackend.MemoryCompanionDestination,
  ) {
    const current = yield* configuration.read(input.tuple).pipe(
      Effect.catchTags({
        ProjectMemoryError: (error) =>
          error.reason === "stale" || error.reason === "forbidden"
            ? Effect.succeed(undefined)
            : Effect.fail(error),
      }),
    );
    const selected = destination
      ? current?.configuration.destination?.embeddingRoute
      : current?.configuration.extractionRoute;
    const captured = destination ? destination.embeddingRoute : input.extractionRoute;
    if (
      current &&
      selected &&
      captured &&
      (input.configurationRevision === undefined ||
        current.revision === input.configurationRevision) &&
      canonicalProjectWorkPayload(selected) === canonicalProjectWorkPayload(captured)
    )
      return;
    const retained = yield* load(key);
    yield* sql`UPDATE t3_workflow_v2_memory_processing SET status='superseded' WHERE operation_key=${key}`;
    if (retained?.destination_json) yield* authority.enqueueCleanup(input.tuple, key);
    return yield* new MemoryProcessingError({ reason: "conflict" });
  });
  const enqueueExtraction = Effect.fn("ProjectMemoryProcessing.enqueueExtraction")(
    function* (input: ExtractionInput) {
      if (!(yield* readCurrent(input.tuple)))
        return yield* new MemoryProcessingError({ reason: "stale" });
      const key = keyFor(input.tuple, "extraction");
      const t = input.tuple;
      const encoded = yield* encodeInput(input);
      if (new TextEncoder().encode(encoded).byteLength > 65536)
        return yield* new MemoryProcessingError({ reason: "conflict" });
      const prior = yield* load(key);
      if (prior && prior.input_json !== encoded)
        return yield* new MemoryProcessingError({ reason: "conflict" });
      yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_processing
      (operation_key,environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,operation,status,input_json,updated_at)
      VALUES(${key},${t.environmentId},${t.owner.kind},${ownerId(t.owner)},${t.ownerRevision},${t.sourceId},${t.sourceRevision},${t.generation},${t.contentHash},'extraction','pending',${encoded},'')`;
      return key;
    },
    Effect.mapError((cause) => (isProcessingError(cause) ? cause : storage(cause))),
  );
  const run = Effect.fn("ProjectMemoryProcessing.run")(
    function* (key: string) {
      const row = yield* load(key);
      if (
        !row ||
        row.status === "completed" ||
        row.status === "indexed" ||
        row.status === "failed" ||
        row.status === "superseded"
      )
        return;
      const decoded = yield* decodeInput(row.input_json).pipe(Effect.mapError(storage));
      const input = decoded;
      if (keyFor(input.tuple, "extraction") !== key)
        return yield* new MemoryProcessingError({ reason: "conflict" });
      if (row.status === "stale") {
        if (Option.isSome(factPolicy)) {
          const retainedFacts = yield* readRetainedMemoryFacts(input.tuple).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (retainedFacts !== undefined)
            yield* factPolicy.value.filter(input.tuple, retainedFacts);
        }
        return;
      }
      const source = yield* readCurrent(input.tuple).pipe(Effect.mapError(storage));
      if (!source) {
        if (Option.isSome(factPolicy)) {
          const retainedFacts = yield* readRetainedMemoryFacts(input.tuple).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (retainedFacts !== undefined)
            yield* factPolicy.value.filter(input.tuple, retainedFacts);
        }
        yield* sql`UPDATE t3_workflow_v2_memory_processing SET status='stale' WHERE operation_key=${key}`;
        return;
      }
      if (row.result_json === null && input.extractionRoute) yield* authorizeExternal(input, key);
      // The receipt is retained before source-bound publication, so a lost response never requires new inference.
      const result =
        row.result_json === null
          ? yield* (
              input.extractionRoute
                ? routes
                    .extract(input.tuple, input.extractionRoute, source.content)
                    .pipe(
                      Effect.mapError(
                        (cause) => new MemoryProcessingError({ reason: "unavailable", cause }),
                      ),
                    )
                : generation
                    .extractMemoryFacts({
                      cwd: input.cwd,
                      sourceText: source.content,
                      modelSelection: input.modelSelection,
                    })
                    .pipe(
                      Effect.mapError(
                        (cause) => new MemoryProcessingError({ reason: "unavailable", cause }),
                      ),
                    )
            ).pipe(
              Effect.timeout("60 seconds"),
              Effect.mapError(
                (cause) => new MemoryProcessingError({ reason: "unavailable", cause }),
              ),
            )
          : yield* decodeResult(row.result_json).pipe(Effect.mapError(storage));
      const validated = yield* validateResult(result).pipe(
        Effect.mapError((cause) => new MemoryProcessingError({ reason: "invalid-facts", cause })),
      );
      if (validated.facts.some((fact) => !source.content.includes(fact.quote)))
        return yield* new MemoryProcessingError({ reason: "invalid-facts" });
      yield* sql`UPDATE t3_workflow_v2_memory_processing SET result_json=${yield* encodeResult(validated)},status='extracted' WHERE operation_key=${key} AND result_json IS NULL`;
      const receipt = yield* load(key);
      if (!receipt?.result_json) return yield* new MemoryProcessingError({ reason: "conflict" });
      const retainedResult = yield* decodeResult(receipt.result_json).pipe(
        Effect.mapError(storage),
      );
      const allowedFacts = Option.isSome(factPolicy)
        ? yield* factPolicy.value.filter(input.tuple, retainedResult.facts)
        : retainedResult.facts;
      yield* authority
        .applyCurrent(input.tuple, (current) =>
          Effect.gen(function* () {
            const t = input.tuple;
            const publishFacts = Option.isSome(factPolicy)
              ? yield* factPolicy.value.filter(t, allowedFacts)
              : allowedFacts;
            for (const fact of publishFacts) {
              const start = current.content.indexOf(fact.quote);
              if (start < 0) return yield* new MemoryProcessingError({ reason: "invalid-facts" });
              yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_observations
          (operation_key,observation_key,environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,body,quote,source_start,source_end,body_hash)
          VALUES(${key},${fact.key},${t.environmentId},${t.owner.kind},${ownerId(t.owner)},${t.ownerRevision},${t.sourceId},${t.sourceRevision},${t.generation},${t.contentHash},${fact.body},${fact.quote},${start},${start + fact.quote.length},${memoryHash(fact.body)})`;
            }
            yield* sql`UPDATE t3_workflow_v2_memory_processing SET status='completed' WHERE operation_key=${key}`;
          }),
        )
        .pipe(
          Effect.catchTags({
            ProjectMemoryError: (error) =>
              error.reason === "stale" || error.reason === "forbidden"
                ? sql`UPDATE t3_workflow_v2_memory_processing SET status='stale' WHERE operation_key=${key}`.pipe(
                    Effect.asVoid,
                  )
                : Effect.fail(error),
          }),
        );
    },
    Effect.mapError((cause) => (isProcessingError(cause) ? cause : storage(cause))),
    (effect, key) =>
      effect.pipe(
        Effect.tapError((error) =>
          error.reason === "invalid-facts"
            ? sql`UPDATE t3_workflow_v2_memory_processing SET status='failed' WHERE operation_key=${key}`.pipe(
                Effect.asVoid,
                Effect.mapError(storage),
              )
            : Effect.void,
        ),
      ),
  );
  const index = Effect.fn("ProjectMemoryProcessing.index")(
    function* (key: string, destination: MemoryBackend.MemoryCompanionDestination) {
      const row = yield* load(key);
      if (!row || row.status === "indexed") return;
      if (row.status !== "completed" && row.status !== "uncertain")
        return yield* new MemoryProcessingError({ reason: "conflict" });
      const input = yield* decodeInput(row.input_json).pipe(Effect.mapError(storage));
      if (
        destination.environmentId !== input.tuple.environmentId ||
        !memoryOwnerEquals(destination.owner, input.tuple.owner)
      )
        return yield* new MemoryProcessingError({ reason: "conflict" });
      if (!(yield* readCurrent(input.tuple))) {
        yield* invalidateIndex(input.tuple, key);
        return yield* new MemoryProcessingError({ reason: "stale" });
      }
      const encoded = yield* encodeDestination(destination).pipe(Effect.mapError(storage));
      if (row.destination_json !== null && row.destination_json !== encoded)
        return yield* new MemoryProcessingError({ reason: "conflict" });
      if (destination.backend === "mem0") yield* authorizeExternal(input, key, destination);
      const retainedFacts = (yield* decodeResult(row.result_json ?? "null").pipe(
        Effect.mapError(storage),
      )).facts;
      const allowedIndexFacts = Option.isSome(factPolicy)
        ? yield* factPolicy.value.filter(input.tuple, retainedFacts)
        : retainedFacts;
      if (allowedIndexFacts.length !== retainedFacts.length) {
        yield* invalidateIndex(input.tuple, key);
        return;
      }
      let payload: unknown;
      if (row.index_json !== null)
        payload = yield* decodeUnknown(row.index_json).pipe(Effect.mapError(storage));
      else {
        const extractedResult = yield* decodeResult(row.result_json ?? "null").pipe(
          Effect.mapError(storage),
        );
        const published = yield* sql<{
          observation_key: string;
        }>`SELECT observation_key FROM t3_workflow_v2_memory_observations WHERE operation_key=${key} AND status='current'`;
        const publishedKeys = new Set(published.map((row) => row.observation_key));
        const extracted = {
          facts: extractedResult.facts.filter((fact) => publishedKeys.has(fact.key)),
        };
        if (extracted.facts.length === 0) {
          yield* authority.applyCurrent(
            input.tuple,
            () =>
              sql`UPDATE t3_workflow_v2_memory_processing SET status='indexed' WHERE operation_key=${key}`,
          );
          return;
        }
        if (destination.backend === "mem0") {
          if (!destination.embeddingRoute)
            return yield* new MemoryProcessingError({ reason: "conflict" });
          const vectors = yield* routes
            .embed(
              input.tuple,
              destination.embeddingRoute,
              extracted.facts.map((fact) => fact.body),
            )
            .pipe(
              Effect.mapError(
                (cause) => new MemoryProcessingError({ reason: "unavailable", cause }),
              ),
            );
          payload = {
            ...backendTuple(input.tuple),
            extractionId: key,
            observations: extracted.facts.map((fact, index) => ({
              observationId: memoryHash(canonicalProjectWorkPayload([key, fact.key])),
              body: fact.body,
              payloadHash: memoryHash(canonicalProjectWorkPayload([input.tuple, fact])),
              vector: vectors[index],
            })),
          };
        } else payload = { tuple: input.tuple, facts: extracted };
      }
      const prepared = yield* encodeUnknown(payload).pipe(Effect.mapError(storage));
      if (new TextEncoder().encode(prepared).byteLength > 16_777_216)
        return yield* new MemoryProcessingError({ reason: "invalid-facts" });
      const reserved =
        yield* sql`UPDATE t3_workflow_v2_memory_processing SET status='uncertain',destination_json=${encoded},index_json=${prepared} WHERE operation_key=${key} AND status IN ('completed','uncertain') AND (destination_json IS NULL OR destination_json=${encoded}) AND (index_json IS NULL OR index_json=${prepared}) RETURNING operation_key`;
      if (reserved.length !== 1) return yield* new MemoryProcessingError({ reason: "conflict" });
      if (destination.backend === "mem0") yield* authorizeExternal(input, key, destination);
      yield* backend.execute({ destination, operationKey: key, operation: "index", payload }).pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            if (!(yield* readCurrent(input.tuple))) yield* invalidateIndex(input.tuple, key);
          }),
        ),
        Effect.mapError((cause) => new MemoryProcessingError({ reason: "unavailable", cause })),
      );
      yield* authority
        .applyCurrent(
          input.tuple,
          () =>
            sql`UPDATE t3_workflow_v2_memory_processing SET status='indexed' WHERE operation_key=${key}`,
        )
        .pipe(
          Effect.catchTags({
            ProjectMemoryError: (error) =>
              error.reason === "stale" || error.reason === "forbidden"
                ? invalidateIndex(input.tuple, key)
                : Effect.fail(error),
          }),
          Effect.mapError(storage),
        );
    },
    Effect.mapError((cause) => (isProcessingError(cause) ? cause : storage(cause))),
  );
  const reconcile = Effect.fn("ProjectMemoryProcessing.reconcile")(function* (after: string) {
    const rows = yield* sql<{
      operation_key: string;
    }>`SELECT operation_key FROM t3_workflow_v2_memory_processing WHERE operation_key>${after} AND (status IN ('pending','extracted','uncertain') OR (status='completed' AND json_extract(input_json,'$.destination') IS NOT NULL) OR (status='stale' AND owner_kind='assistant' AND result_json IS NOT NULL AND EXISTS(SELECT 1 FROM t3_workflow_v2_memory_forgotten f WHERE f.environment_id=t3_workflow_v2_memory_processing.environment_id AND f.owner_kind='assistant' AND f.owner_id=t3_workflow_v2_memory_processing.owner_id AND f.source_id=t3_workflow_v2_memory_processing.source_id AND NOT EXISTS(SELECT 1 FROM t3_workflow_v2_memory_fact_tombstones t WHERE t.environment_id=f.environment_id AND t.owner_kind=f.owner_kind AND t.owner_id=f.owner_id AND t.source_id=f.source_id)))) ORDER BY operation_key LIMIT 128`;
    for (const row of rows) {
      const job = yield* load(row.operation_key);
      if (job?.status === "uncertain" && job.destination_json) {
        const destination = yield* decodeDestination(job.destination_json).pipe(
          Effect.mapError(storage),
        );
        yield* index(row.operation_key, destination).pipe(Effect.ignore);
      } else {
        yield* run(row.operation_key).pipe(Effect.ignore);
        const completed = yield* load(row.operation_key);
        if (completed?.status === "completed") {
          const input = yield* decodeInput(completed.input_json).pipe(Effect.mapError(storage));
          if (input.destination)
            yield* index(row.operation_key, input.destination).pipe(Effect.ignore);
        }
      }
    }
    return rows.map((row) => row.operation_key);
  }, Effect.mapError(storage));
  const cleanup = Effect.fn("ProjectMemoryProcessing.cleanup")(function* (after: string) {
    const rows = yield* sql<{
      id: string;
      payload_json: string;
    }>`SELECT id,payload_json FROM t3_workflow_v2_memory_cleanup WHERE id>${after} AND status<>'completed' ORDER BY id LIMIT 128`;
    for (const cleanupRow of rows) {
      const tuple = yield* decodeTuple(cleanupRow.payload_json).pipe(Effect.mapError(storage));
      const key = keyFor(tuple, "extraction");
      const row = yield* load(key);
      // Retain the destination captured before the uncertain write, even after the owner is deleted.
      if (row?.destination_json) {
        yield* sql`UPDATE t3_workflow_v2_memory_cleanup SET status='uncertain' WHERE id=${cleanupRow.id}`;
        const outcome = yield* backend
          .execute({
            destination: yield* decodeDestination(row.destination_json).pipe(
              Effect.mapError(storage),
            ),
            operationKey: key,
            operation: "cleanup",
            payload:
              row?.destination_json &&
              (yield* decodeDestination(row.destination_json).pipe(Effect.mapError(storage)))
                .backend === "mem0"
                ? backendTuple(tuple)
                : { tuple, fence: "retracted" },
          })
          .pipe(Effect.result);
        if (outcome._tag === "Failure") continue;
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE t3_workflow_v2_memory_observations SET status='retracted' WHERE operation_key=${key}`;
          yield* sql`UPDATE t3_workflow_v2_memory_processing SET status='stale' WHERE operation_key=${key}`;
          yield* sql`UPDATE t3_workflow_v2_memory_cleanup SET status='completed' WHERE id=${cleanupRow.id}`;
        }),
      );
    }
    return rows.map((row) => row.id);
  }, Effect.mapError(storage));
  return ProjectMemoryProcessing.of({
    enqueueExtraction,
    run: (key) => lock.withPermit(run(key)),
    index: (key, destination) => lock.withPermit(index(key, destination)),
    reconcile: (after) => lock.withPermit(reconcile(after ?? "")),
    cleanup: (after) => lock.withPermit(cleanup(after ?? "")),
  });
});
export const layer = Layer.effect(ProjectMemoryProcessing, make);
