import { canonicalProjectWorkPayload } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectWorkRepositoryShape } from "../ProjectWorkRepository.ts";
import { MemoryIndexManifest, type MemoryBackend } from "./MemoryBackend.ts";
import {
  ProjectMemoryServiceError,
  ProjectMemoryJobInput,
  projectMemoryId,
  type ProjectMemoryService,
} from "./ProjectMemoryService.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Counter = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const JobInput = ProjectMemoryJobInput;
const Receipt = Schema.Struct({
  effectId: Id,
  claimGeneration: Counter,
  kind: Schema.Literals(["index-complete", "delete-source-complete", "no-facts"]),
  sourceId: Id,
  sourceRevision: Counter,
  sourceGeneration: Counter,
  observationIds: Schema.Array(Id).check(Schema.isMaxLength(32)),
});
export type ProjectMemoryVerifiedOutcome = typeof Receipt.Type;
export interface ProjectMemoryOutcomePort {
  /** Root reflects this exact journal receipt through its typed authority transition.
   * verifyFinal must run inside the final captured transaction after SQL receipts.
   * Missing source/run authority never blocks already authorized cleanup reflection.
   */
  readonly commitVerifiedOutcome: (
    outcome: ProjectMemoryVerifiedOutcome,
    verifyFinal: Effect.Effect<void, ProjectMemoryServiceError>,
  ) => Effect.Effect<void, ProjectMemoryServiceError>;
}
const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new ProjectMemoryServiceError({ reason: "Invalid durable memory job" })),
  );
const fail = (reason: string) => new ProjectMemoryServiceError({ reason });
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const makeProjectMemoryIndexReactor = (dependencies: {
  readonly sql: SqlClient.SqlClient;
  readonly repository: ProjectWorkRepositoryShape;
  readonly service: ProjectMemoryService;
  readonly backend: MemoryBackend;
  readonly environmentId: string;
  readonly outcomes?: ProjectMemoryOutcomePort;
}) => {
  const { sql, repository, service, backend, environmentId } = dependencies;
  const load = Effect.fn("ProjectMemoryIndexReactor.load")(function* (effectId: string) {
    const rows = yield* sql<{
      effectId: string;
      environmentId: string;
      projectId: string;
      claimGeneration: number;
      status: string;
      inputBytes: number;
      receiptBytes: number | null;
    }>`
      SELECT effect_id AS effectId, environment_id AS environmentId, project_id AS projectId,
      claim_generation AS claimGeneration, status, length(CAST(input_json AS BLOB)) AS inputBytes,
      length(CAST(receipt_json AS BLOB)) AS receiptBytes FROM project_team_memory_job WHERE effect_id=${effectId}`;
    if (rows.length === 0) return undefined;
    const row = rows[0]!;
    if (rows.length !== 1 || row.inputBytes > 262_144 || (row.receiptBytes ?? 0) > 262_144)
      return yield* fail("Memory job storage exceeds budget");
    const payloads = yield* sql<{
      input: string;
      receipt: string | null;
    }>`SELECT input_json AS input, receipt_json AS receipt
      FROM project_team_memory_job WHERE effect_id=${effectId} AND length(CAST(input_json AS BLOB))<=262144
      AND (receipt_json IS NULL OR length(CAST(receipt_json AS BLOB))<=262144)`;
    if (payloads.length !== 1) return yield* fail("Memory job storage changed");
    const payload = payloads[0]!;
    const input = yield* decode(Schema.fromJsonString(JobInput), payload.input);
    const claimGeneration = yield* decode(Counter, row.claimGeneration);
    const status = yield* decode(
      Schema.Literals(["pending", "claimed", "uncertain", "settled"]),
      row.status,
    );
    const receipt =
      payload.receipt === null
        ? undefined
        : yield* decode(Schema.fromJsonString(Receipt), payload.receipt);
    if (
      input.environmentId !== environmentId ||
      input.environmentId !== row.environmentId ||
      input.projectId !== row.projectId ||
      input.effect.effectId !== row.effectId ||
      input.effect.recordId !== row.effectId ||
      input.effect.projectId !== input.projectId ||
      input.source.projectId !== input.projectId ||
      input.effect.targetId !== input.source.recordId ||
      input.effect.payload.expectedRevision !== input.source.sourceRevision ||
      input.effect.generation !== input.source.generation ||
      (input.effect.effectKind !== "memory-index" && input.effect.effectKind !== "memory-delete") ||
      (input.effect.effectKind === "memory-index" &&
        (input.extraction === undefined ||
          input.extraction.recordId !== input.effect.payload.recordIds[1] ||
          input.extraction.projectId !== input.projectId ||
          input.extraction.sourceId !== input.source.recordId ||
          input.extraction.sourceRevision !== input.source.sourceRevision ||
          input.extraction.sourceGeneration !== input.source.generation)) ||
      (receipt !== undefined &&
        (receipt.effectId !== effectId ||
          receipt.claimGeneration !== claimGeneration ||
          receipt.sourceId !== input.source.recordId ||
          receipt.sourceRevision !== input.source.sourceRevision ||
          receipt.sourceGeneration !== input.source.generation)) ||
      (receipt !== undefined &&
        (new Set(receipt.observationIds).size !== receipt.observationIds.length ||
          (input.effect.effectKind === "memory-delete" &&
            (receipt.kind !== "delete-source-complete" || receipt.observationIds.length !== 0)) ||
          (input.effect.effectKind === "memory-index" &&
            (receipt.kind === "delete-source-complete" ||
              (receipt.kind === "no-facts") !== (receipt.observationIds.length === 0))))) ||
      (status === "settled") !== (receipt !== undefined) ||
      Buffer.byteLength(payload.input) !== row.inputBytes ||
      (payload.receipt !== null && Buffer.byteLength(payload.receipt) !== row.receiptBytes)
    )
      return yield* fail("Memory job physical identity is corrupt");
    return { input, claimGeneration, status, receipt };
  });
  const retain = Effect.fn("ProjectMemoryIndexReactor.retain")(function* (
    projectId: string,
    effectId: string,
  ) {
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        const existing = yield* load(effectId);
        if (existing !== undefined) {
          if (existing.input.projectId !== projectId)
            return yield* fail("Memory job project changed");
          return [];
        }
        const work = yield* service.readWork(projectId, effectId);
        if (work.effect.status !== "pending")
          return yield* fail("Missing memory job cannot reconstruct an already launched effect");
        const input = yield* decode(JobInput, {
          environmentId,
          projectId,
          effect: work.effect,
          source: work.source,
          ...(work.extraction === undefined ? {} : { extraction: work.extraction }),
        });
        const payload = canonicalProjectWorkPayload(input);
        if (Buffer.byteLength(payload) > 262_144)
          return yield* fail("Memory job input exceeds budget");
        yield* sql`INSERT INTO project_team_memory_job (effect_id,environment_id,project_id,input_json,claim_generation,status,receipt_json)
        VALUES (${effectId},${environmentId},${projectId},${payload},0,'pending',NULL) ON CONFLICT(effect_id) DO NOTHING`;
        const stored = yield* load(effectId);
        if (stored === undefined || canonicalProjectWorkPayload(stored.input) !== payload)
          return yield* fail("Memory job immutable winner changed");
        return [];
      }),
    );
  });
  const claim = Effect.fn("ProjectMemoryIndexReactor.claim")(function* (
    effectId: string,
    recover?: {
      readonly generation: number;
      readonly confirmDrained: Effect.Effect<void, ProjectMemoryServiceError>;
    },
  ) {
    if (recover !== undefined) yield* recover.confirmDrained;
    let owner: number | undefined;
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        const job = yield* load(effectId);
        if (job === undefined) return yield* fail("Memory job is missing");
        if (job.status === "settled") return [];
        if (recover === undefined && job.status !== "pending") return [];
        if (
          recover !== undefined &&
          (job.status === "pending" || job.claimGeneration !== recover.generation)
        )
          return yield* fail("Memory recovery owner changed");
        if (job.input.effect.effectKind === "memory-index") {
          const work = yield* service.readWork(job.input.projectId, effectId);
          if (
            work.source.status !== "current" ||
            work.source.generation !== job.input.source.generation ||
            work.source.sourceRevision !== job.input.source.sourceRevision
          )
            return yield* fail("Memory source changed before claim");
          // Source/project authority is checked again by currentIndex before each forward stage.
          const at = yield* now;
          owner = job.claimGeneration + 1;
          const commands = yield* service.commit(
            work.state,
            [
              {
                ...work.effect,
                status: "claimed",
                revision: work.effect.revision + 1,
                claimGeneration: owner,
                updatedAt: at,
              },
            ],
            at,
          );
          yield* sql`UPDATE project_team_memory_job SET status='claimed',claim_generation=${owner}
          WHERE effect_id=${effectId} AND claim_generation=${job.claimGeneration} AND status=${job.status} AND receipt_json IS NULL`;
          return commands;
        }
        owner = job.claimGeneration + 1;
        yield* sql`UPDATE project_team_memory_job SET status='claimed',claim_generation=${owner}
        WHERE effect_id=${effectId} AND claim_generation=${job.claimGeneration} AND status=${job.status} AND receipt_json IS NULL`;
        return [];
      }),
    );
    return owner;
  });
  const requireOwner = Effect.fn("ProjectMemoryIndexReactor.requireOwner")(function* (
    effectId: string,
    generation: number,
  ) {
    const job = yield* load(effectId);
    if (job === undefined || job.status !== "claimed" || job.claimGeneration !== generation)
      return yield* fail("Memory job owner is stale");
    return job;
  });
  const reflect = Effect.fn("ProjectMemoryIndexReactor.reflect")(function* (effectId: string) {
    const job = yield* load(effectId);
    if (job?.receipt === undefined) return yield* fail("Memory job has no verified receipt");
    if (dependencies.outcomes === undefined)
      return { status: "pending-reflection" as const, receipt: job.receipt };
    const expected = canonicalProjectWorkPayload(job.receipt);
    const verifyFinal = Effect.gen(function* () {
      const fresh = yield* load(effectId);
      if (fresh?.status !== "settled" || canonicalProjectWorkPayload(fresh.receipt) !== expected)
        return yield* fail("Memory receipt changed before reflection");
      if (job.receipt!.kind !== "delete-source-complete") {
        const work = yield* service.currentIndex(
          job.input.projectId,
          effectId,
          job.claimGeneration,
        );
        if (
          job.receipt!.observationIds.length !== work.extraction!.expectedObservationIds.length ||
          work.extraction!.expectedObservationIds.some(
            (id) => !job.receipt!.observationIds.includes(id),
          )
        )
          return yield* fail("Memory receipt does not cover the exact retained observation set");
        if (
          work.source.recordId !== job.receipt!.sourceId ||
          work.source.sourceRevision !== job.receipt!.sourceRevision ||
          work.source.generation !== job.receipt!.sourceGeneration
        )
          return yield* fail("Memory source changed before reflection");
      }
    });
    yield* dependencies.outcomes.commitVerifiedOutcome(
      job.receipt,
      verifyFinal.pipe(Effect.mapError(() => fail("Memory final receipt validation failed"))),
    );
    return { status: "reflected" as const, receipt: job.receipt };
  });
  const settle = Effect.fn("ProjectMemoryIndexReactor.settle")(function* (
    effectId: string,
    generation: number,
    kind: ProjectMemoryVerifiedOutcome["kind"],
    observationIds: ReadonlyArray<string>,
  ) {
    yield* repository.executeAtomic(
      Effect.gen(function* () {
        const job = yield* requireOwner(effectId, generation);
        if (kind !== "delete-source-complete")
          yield* service.currentIndex(job.input.projectId, effectId, generation);
        const receipt = yield* decode(Receipt, {
          effectId,
          claimGeneration: generation,
          kind,
          sourceId: job.input.source.recordId,
          sourceRevision: job.input.source.sourceRevision,
          sourceGeneration: job.input.source.generation,
          observationIds,
        });
        yield* sql`UPDATE project_team_memory_job SET status='settled',receipt_json=${canonicalProjectWorkPayload(receipt)}
        WHERE effect_id=${effectId} AND claim_generation=${generation} AND status='claimed' AND receipt_json IS NULL`;
        const stored = yield* load(effectId);
        if (
          stored?.status !== "settled" ||
          canonicalProjectWorkPayload(stored.receipt) !== canonicalProjectWorkPayload(receipt)
        )
          return yield* fail("Memory receipt ownership changed");
        return [];
      }),
    );
    return yield* reflect(effectId);
  });
  const uncertain = Effect.fn("ProjectMemoryIndexReactor.uncertain")(function* (
    effectId: string,
    generation: number,
  ) {
    yield* sql.withTransaction(sql`UPDATE project_team_memory_job SET status='uncertain'
      WHERE effect_id=${effectId} AND claim_generation=${generation} AND status='claimed' AND receipt_json IS NULL`);
  });
  const perform = Effect.fn("ProjectMemoryIndexReactor.perform")(function* (
    effectId: string,
    generation: number,
    recovering: boolean,
  ) {
    const job = yield* requireOwner(effectId, generation);
    const source = job.input.source;
    if (job.input.effect.effectKind === "memory-delete") {
      yield* backend.deleteSource(projectMemoryId("memory-cleanup", [effectId]), {
        environmentId,
        projectId: job.input.projectId,
        sourceRecordId: source.recordId,
        sourceRevision: source.sourceRevision,
        sourceGeneration: source.generation,
      });
      return yield* settle(effectId, generation, "delete-source-complete", []);
    }
    const work = yield* service.currentIndex(job.input.projectId, effectId, generation);
    // A crash during extraction cannot prove whether the model consumed its reservation.
    // Root may retain/reconcile that request, but this worker never blindly extracts again.
    if (recovering && work.extraction?.status === "pending")
      return yield* fail("Extraction outcome is uncertain; request reconciliation is required");
    yield* service.extract(job.input.projectId, effectId, generation);
    const manifest = yield* service.prepareManifest(
      job.input.projectId,
      effectId,
      generation,
      recovering,
    );
    if (manifest === undefined) return yield* settle(effectId, generation, "no-facts", []);
    const frozen = yield* decode(MemoryIndexManifest, manifest);
    yield* requireOwner(effectId, generation);
    yield* service.currentIndex(job.input.projectId, effectId, generation);
    const requestId = projectMemoryId("memory-index-request", [effectId]);
    const before = yield* backend.reconcile(
      projectMemoryId("memory-reconcile-before", [effectId, generation]),
      frozen,
    );
    const exactComplete = (result: typeof before) =>
      result.complete &&
      result.missingObservationIds.length === 0 &&
      result.invalidObservationIds.length === 0 &&
      result.unexpectedBackendIds.length === 0;
    if (!exactComplete(before)) {
      if (before.invalidObservationIds.length !== 0 || before.unexpectedBackendIds.length !== 0)
        return yield* fail("Memory index reconciliation found conflicting native data");
      yield* requireOwner(effectId, generation);
      yield* service.currentIndex(job.input.projectId, effectId, generation);
      const result = yield* backend.index(requestId, frozen);
      const expected = frozen.observations.map((entry) => entry.observationId);
      if (
        new Set(result.writtenObservationIds).size !== expected.length ||
        result.writtenObservationIds.length !== expected.length ||
        expected.some((id) => !result.writtenObservationIds.includes(id))
      )
        return yield* fail("Memory backend wrote only a subset of the manifest");
      const after = yield* backend.reconcile(
        projectMemoryId("memory-reconcile-after", [effectId, generation]),
        frozen,
      );
      if (!exactComplete(after))
        return yield* fail("Memory backend did not reconcile the whole manifest");
    }
    return yield* settle(
      effectId,
      generation,
      "index-complete",
      frozen.observations.map((entry) => entry.observationId),
    );
  });
  const consume = Effect.fn("ProjectMemoryIndexReactor.consume")(function* (
    projectId: string,
    effectId: string,
    recovery?: {
      readonly generation: number;
      readonly confirmDrained: Effect.Effect<void, ProjectMemoryServiceError>;
    },
  ) {
    yield* retain(projectId, effectId);
    const existing = yield* load(effectId);
    if (existing?.status === "settled") return yield* reflect(effectId);
    if (
      existing?.status === "pending" &&
      existing.input.effect.effectKind === "memory-index" &&
      !service.modelsEnabled
    )
      return { status: "disabled" as const };
    const generation = yield* claim(effectId, recovery);
    if (generation === undefined) return { status: "owned-elsewhere" as const };
    const result = yield* perform(effectId, generation, recovery !== undefined).pipe(Effect.exit);
    if (Exit.isSuccess(result)) return result.value;
    // Interruptions retain the claimed owner until Root confirms its drain. Do
    // not issue more SQL work from an interrupted owner or repeat unknown calls.
    if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause);
    const recorded = yield* uncertain(effectId, generation).pipe(Effect.exit);
    return yield* Effect.failCause(
      Exit.isFailure(recorded)
        ? Cause.fromReasons([...result.cause.reasons, ...recorded.cause.reasons])
        : result.cause,
    );
  });
  /** One bounded pass over committed jobs; Root owns wake scheduling and lifetime. */
  const drain = Effect.fn("ProjectMemoryIndexReactor.drain")(function* (rawLimit: unknown = 8) {
    const limit = yield* decode(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
      rawLimit,
    );
    const rows = yield* sql<{
      projectId: string;
      effectId: string;
    }>`SELECT project_id AS projectId, effect_id AS effectId
      FROM project_team_memory_job WHERE environment_id=${environmentId} AND status='pending' ORDER BY effect_id LIMIT ${limit}`;
    const outcomes: Array<{ effectId: string; status: string }> = [];
    for (const row of rows) {
      const result = yield* consume(row.projectId, row.effectId).pipe(
        Effect.map((value) => value.status),
        Effect.catch(() => Effect.succeed("pending-error")),
      );
      outcomes.push({ effectId: row.effectId, status: result });
    }
    return outcomes;
  });
  return { consume, retain, load, reflect, drain };
};
