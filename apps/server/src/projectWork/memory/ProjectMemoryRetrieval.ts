import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  ProjectId,
  ProjectMemorySource,
  type ProjectMemoryObservation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { hydrateProjectMemoryHits } from "./ProjectMemoryHitHydration.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Bytes = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16_777_216 }));
const decodeIds = Schema.decodeUnknownOption(Schema.Array(Schema.Struct({ recordId: Id })));
const decodeSourceMetadata = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ recordId: Id, bytes: Bytes })),
);
const decodeSource = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectMemorySource), {
  onExcessProperty: "error",
});
const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");

export type ProjectMemoryRetrieval = {
  readonly status: "available" | "disabled" | "degraded";
  readonly records: readonly ProjectMemoryObservation[];
  readonly omitted: readonly string[];
  readonly provenance: {
    readonly snapshotSha256: string;
    readonly querySha256: string;
    readonly queryId?: string;
    readonly configurationSha256?: string;
    readonly admissionEventId?: string;
  };
};
const degraded = (reason: string, query: string): ProjectMemoryRetrieval => ({
  status: "degraded",
  records: [],
  omitted: [reason],
  provenance: { snapshotSha256: digest({ reason }), querySha256: digest(query) },
});

// Enumerate a complete bounded candidate set before hydration; neither lexical
// order nor a newer timestamp may hide a correction or retained tombstone.
export const readProjectMemoryObservations = Effect.fn("ProjectMemoryRetrieval.read")(
  function* (
    sql: SqlClient.SqlClient,
    projectId: ProjectId,
    query: string,
    exactHitIds?: readonly string[],
  ) {
    if (Buffer.byteLength(query, "utf8") > 65_536)
      return degraded("Observation query exceeds the lexical bound", query);
    if (exactHitIds !== undefined && exactHitIds.length > 12)
      return degraded("Dense candidates exceed their bound", query);
    const rows =
      exactHitIds === undefined
        ? yield* sql`SELECT CASE WHEN length(CAST(record_id AS BLOB))<=1024
      THEN record_id END AS recordId FROM project_team_memory_observation
      WHERE project_id=${projectId} ORDER BY record_id LIMIT 129`
        : exactHitIds.map((recordId) => ({ recordId }));
    if (rows.length > 128)
      return degraded("Observation candidates exceed the complete lexical bound", query);
    const ids = decodeIds(rows);
    if (Option.isNone(ids)) return degraded("Observation candidate identity is unavailable", query);
    const hitIds = ids.value.map((row) => row.recordId);
    if (new Set(hitIds).size !== hitIds.length)
      return degraded("Observation candidate identity is ambiguous", query);
    if (hitIds.length > 0) {
      const owners = yield* sql`SELECT CASE WHEN length(CAST(project_id AS BLOB))<=1024
        THEN project_id END AS project_id FROM project_team_memory_observation
        WHERE record_id IN ${sql.in(hitIds)} LIMIT 129`;
      if (owners.length !== hitIds.length || owners.some((row) => row.project_id !== projectId))
        return degraded("Observation candidate ownership is ambiguous", query);
    }
    const hydrated = yield* hydrateProjectMemoryHits(sql, { projectId, hitIds });
    if (hydrated.status === "denied")
      return degraded("Observation authority is unavailable: " + hydrated.reason, query);
    if (hydrated.selected.some((record) => record.projectId !== projectId))
      return degraded("Observation authority is foreign", query);
    const sourceIds = [...new Set(hydrated.selected.map((record) => record.sourceId))].sort();
    const sources: ProjectMemorySource[] = [];
    if (sourceIds.length > 0) {
      const metadataRows = yield* sql`SELECT CASE WHEN length(CAST(record_id AS BLOB))<=1024
        THEN record_id END AS recordId, length(CAST(payload_json AS BLOB)) AS bytes
        FROM project_team_memory_source WHERE project_id=${projectId}
        AND record_id IN ${sql.in(sourceIds)} ORDER BY record_id LIMIT 129`;
      const metadata = decodeSourceMetadata(metadataRows);
      if (
        Option.isNone(metadata) ||
        metadata.value.length !== sourceIds.length ||
        metadata.value.some((row) => row.bytes > 1_048_576) ||
        metadata.value.reduce((total, row) => total + row.bytes, 0) > 16_777_216
      )
        return degraded("Observation source provenance exceeds its bound", query);
      const payloads = yield* sql<{
        recordId: string;
        payload: string | null;
      }>`SELECT record_id AS recordId,
        CASE WHEN length(CAST(payload_json AS BLOB))<=1048576 THEN payload_json END AS payload
        FROM project_team_memory_source WHERE project_id=${projectId}
        AND record_id IN ${sql.in(sourceIds)} ORDER BY record_id LIMIT 129`;
      if (payloads.length !== metadata.value.length)
        return degraded("Observation source provenance is incomplete", query);
      for (const [index, row] of payloads.entries()) {
        const source = decodeSource(row.payload);
        if (
          Option.isNone(source) ||
          source.value.projectId !== projectId ||
          source.value.recordId !== row.recordId ||
          row.recordId !== sourceIds[index] ||
          Buffer.byteLength(row.payload ?? "", "utf8") !== metadata.value[index]?.bytes
        )
          return degraded("Observation source provenance changed", query);
        sources.push(source.value);
      }
    }
    const terms = [
      ...new Set(
        query
          .toLowerCase()
          .split(/[^\p{L}\p{N}_]+/u)
          .filter((term) => term.length >= 2 && Buffer.byteLength(term, "utf8") <= 64),
      ),
    ].slice(0, 32);
    const scored =
      exactHitIds === undefined
        ? hydrated.selected
            .map((record) => {
              const words = new Set(record.body.toLowerCase().split(/[^\p{L}\p{N}_]+/u));
              return {
                record,
                score: terms.reduce((total, term) => total + Number(words.has(term)), 0),
              };
            })
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score || a.record.recordId.localeCompare(b.record.recordId))
        : exactHitIds.flatMap((id) => {
            const record = hydrated.selected.find((entry) => entry.recordId === id);
            return record === undefined ? [] : [{ record, score: 1 }];
          });
    const omitted: string[] = [];
    if (Object.values(hydrated.rejectionCounts).some((count) => count > 0))
      omitted.push("Observation candidates excluded by current source or correction policy");
    if (scored.length > 12) omitted.push("Observation matches exceed the selection bound");
    return {
      status: "available" as const,
      records: scored.slice(0, 12).map((entry) => entry.record),
      omitted,
      provenance: {
        snapshotSha256: digest({
          hitIds,
          sources,
          observations: hydrated.selected,
          rejectionCounts: hydrated.rejectionCounts,
        }),
        querySha256: digest(query),
      },
    } satisfies ProjectMemoryRetrieval;
  },
  Effect.catch(() => Effect.succeed(degraded("Observation fallback is unavailable", ""))),
);
