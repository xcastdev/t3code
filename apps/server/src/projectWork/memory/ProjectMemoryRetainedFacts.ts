import { MemoryExtractionResult, ProjectMemorySource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { memoryHash, ownerId, type MemorySourceTuple } from "./ProjectMemoryRepository.ts";
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryExtractionResult));
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource));

// Forgotten sources remain readable only for bounded receipt validation, never for recall or inference.
export const readRetainedMemoryFacts = Effect.fn("ProjectMemory.readRetainedFacts")(function* (
  tuple: MemorySourceTuple,
) {
  const sql = yield* SqlClient.SqlClient;
  const row = (yield* sql<{
    result_json: string;
    payload_json: string;
  }>`SELECT p.result_json,s.payload_json FROM t3_workflow_v2_memory_processing p JOIN t3_workflow_v2_memory_sources s ON s.environment_id=p.environment_id AND s.owner_kind=p.owner_kind AND s.owner_id=p.owner_id AND s.owner_revision=p.owner_revision AND s.source_id=p.source_id AND s.source_revision=p.source_revision AND s.generation=p.generation AND s.content_hash=p.content_hash WHERE p.environment_id=${tuple.environmentId} AND p.owner_kind=${tuple.owner.kind} AND p.owner_id=${ownerId(tuple.owner)} AND p.owner_revision=${tuple.ownerRevision} AND p.source_id=${tuple.sourceId} AND p.source_revision=${tuple.sourceRevision} AND p.generation=${tuple.generation} AND p.content_hash=${tuple.contentHash} AND p.operation='extraction' AND p.result_json IS NOT NULL AND length(CAST(p.result_json AS BLOB))<=524288 AND length(CAST(s.payload_json AS BLOB))<=262144 LIMIT 1`)[0];
  if (!row) return undefined;
  const source = yield* decodeSource(row.payload_json).pipe(Effect.option);
  const result = yield* decodeResult(row.result_json).pipe(Effect.option);
  if (
    source._tag === "None" ||
    result._tag === "None" ||
    memoryHash(source.value.content) !== tuple.contentHash ||
    source.value.contentHash !== tuple.contentHash ||
    result.value.facts.some((fact) => !source.value.content.includes(fact.quote))
  )
    return undefined;
  return result.value.facts;
});
