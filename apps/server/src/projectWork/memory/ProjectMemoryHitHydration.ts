import { ProjectId, ProjectMemoryObservation, ProjectMemorySource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { selectProjectMemoryHits } from "./ProjectMemoryHitPolicy.ts";

const Id = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256));
const Version = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Input = Schema.Struct({
  projectId: Schema.toType(ProjectId).check(Schema.isTrimmed(), Schema.isMaxLength(256)),
  hitIds: Schema.Array(Id).check(Schema.isMaxLength(128)),
});
const decodeInput = Schema.decodeUnknownOption(Input, { onExcessProperty: "error" });
const decodeHitCount = Schema.decodeUnknownOption(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(128)),
);
const decodeHydrationInput = (input: unknown) => {
  if (!Predicate.isObject(input)) return Option.none<typeof Input.Type>();
  const fields = Object.getOwnPropertyDescriptors(input);
  const project = fields.projectId;
  const hits = fields.hitIds;
  if (
    Reflect.ownKeys(fields).length !== 2 ||
    project === undefined ||
    hits === undefined ||
    !("value" in project) ||
    !("value" in hits)
  )
    return Option.none<typeof Input.Type>();
  const hitIds: unknown = hits.value;
  if (!Array.isArray(hitIds)) return Option.none<typeof Input.Type>();
  const length = decodeHitCount(Object.getOwnPropertyDescriptor(hitIds, "length")?.value);
  if (Option.isNone(length)) return Option.none<typeof Input.Type>();
  const elements = Object.getOwnPropertyDescriptors(hitIds);
  if (Reflect.ownKeys(elements).length !== length.value + 1)
    return Option.none<typeof Input.Type>();
  const values: Array<unknown> = [];
  for (let index = 0; index < length.value; index++) {
    const element = elements[String(index)];
    if (element === undefined || !("value" in element)) return Option.none<typeof Input.Type>();
    values.push(element.value);
  }
  return decodeInput({ projectId: project.value, hitIds: values });
};
const Metadata = Schema.Struct({
  recordId: Id,
  projectId: Input.fields.projectId,
  status: ProjectMemoryObservation.fields.status,
  revision: Version,
  generation: Version,
  updatedAt: ProjectMemoryObservation.fields.updatedAt,
  sourceId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4_000),
    Schema.isTrimmed(),
  ),
  uniqueKey: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8_000))),
  bytes: Version,
});
const decodeMetadata = Schema.decodeUnknownOption(Schema.Array(Metadata));
const decodeOwners = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ projectId: Input.fields.projectId })),
);
const decodeProjects = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      projectId: Input.fields.projectId,
      deleted: Schema.Literals([0, 1]),
      state: Schema.NullOr(Schema.Literals(["active", "archived", "tombstoned"])),
      tombstoned: Schema.Literals([0, 1]),
    }),
  ),
);
const decodeSource = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectMemorySource), {
  onExcessProperty: "error",
});
const decodeObservation = Schema.decodeUnknownOption(
  Schema.fromJsonString(ProjectMemoryObservation),
  { onExcessProperty: "error" },
);
const decodePayloads = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ recordId: Id, payload: Schema.String })),
);
const encodeUniqueKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Version, Version, Schema.String])),
);
const maxPayloadBytes = 1_048_576;
const maxTotalBytes = 16_777_216;

export type ProjectMemoryHydrationDenial =
  | "invalid-input"
  | "incomplete-authority"
  | "current-access-gone"
  | "corruption";
const denied = (reason: ProjectMemoryHydrationDenial) => ({
  status: "denied" as const,
  reason,
  selected: [] as ReadonlyArray<ProjectMemoryObservation>,
});

const readMetadata = Effect.fn("ProjectMemoryHitHydration.readMetadata")(function* (
  sql: SqlClient.SqlClient,
  table: string,
  owners: ReadonlyArray<string>,
) {
  const rows =
    yield* sql`SELECT record_id AS recordId, project_id AS projectId, status, revision, generation,
    updated_at AS updatedAt, source_id AS sourceId, unique_key AS uniqueKey,
    length(CAST(payload_json AS BLOB)) AS bytes FROM ${sql(table)}
    WHERE project_id IN ${sql.in(owners)} ORDER BY record_id LIMIT 257`;
  return rows;
});

const readSnapshot = Effect.fn("ProjectMemoryHitHydration.readSnapshot")(function* (
  sql: SqlClient.SqlClient,
  input: typeof Input.Type,
) {
  const hitRows =
    input.hitIds.length === 0
      ? []
      : yield* sql`SELECT DISTINCT project_id AS projectId
    FROM project_team_memory_observation WHERE record_id IN ${sql.in(input.hitIds)} LIMIT 129`;
  const hitOwners = decodeOwners(hitRows);
  if (Option.isNone(hitOwners)) return denied("corruption");
  const owners = [
    ...new Set([input.projectId, ...hitOwners.value.map((owner) => owner.projectId)]),
  ];
  if (owners.length > 129) return denied("incomplete-authority");
  const projectRows =
    yield* sql`SELECT p.project_id AS projectId, (p.deleted_at IS NOT NULL) AS deleted,
    l.state, (l.tombstone_json IS NOT NULL) AS tombstoned FROM projection_projects p
    LEFT JOIN project_lifecycle l ON l.project_id = p.project_id WHERE p.project_id IN ${sql.in(owners)}`;
  const projects = decodeProjects(projectRows);
  if (Option.isNone(projects)) return denied("corruption");
  if (
    projects.value.length !== owners.length ||
    projects.value.some(
      (project) =>
        project.deleted === 1 ||
        project.tombstoned === 1 ||
        project.state === "tombstoned" ||
        (project.projectId === input.projectId && project.state === "archived"),
    )
  )
    return denied("current-access-gone");

  const sourceRows = yield* readMetadata(sql, "project_team_memory_source", owners);
  const observationRows = yield* readMetadata(sql, "project_team_memory_observation", owners);
  if (sourceRows.length > 256 || observationRows.length > 256)
    return denied("incomplete-authority");
  const sourcesMetadata = decodeMetadata(sourceRows);
  const observationsMetadata = decodeMetadata(observationRows);
  if (Option.isNone(sourcesMetadata) || Option.isNone(observationsMetadata))
    return denied("corruption");
  const metadata = [...sourcesMetadata.value, ...observationsMetadata.value];
  if (
    metadata.some((row) => row.bytes > maxPayloadBytes) ||
    metadata.reduce((total, row) => total + row.bytes, 0) > maxTotalBytes
  )
    return denied("incomplete-authority");

  const sources: Array<ProjectMemorySource> = [];
  const observations: Array<ProjectMemoryObservation> = [];
  const ids = new Set<string>();
  for (const [table, rows, decode] of [
    ["project_team_memory_source", sourcesMetadata.value, decodeSource],
    ["project_team_memory_observation", observationsMetadata.value, decodeObservation],
  ] as const) {
    const payloadRows = yield* sql`SELECT record_id AS recordId,
      CASE WHEN length(CAST(payload_json AS BLOB)) <= ${maxPayloadBytes} THEN payload_json ELSE NULL END AS payload
      FROM ${sql(table)} WHERE project_id IN ${sql.in(owners)} ORDER BY record_id LIMIT 257`;
    const payloads = decodePayloads(payloadRows);
    if (Option.isNone(payloads) || payloads.value.length !== rows.length)
      return denied("corruption");
    for (const [index, payload] of payloads.value.entries()) {
      const row = rows[index];
      const decoded: Option.Option<ProjectMemorySource | ProjectMemoryObservation> = decode(
        payload.payload,
      );
      if (row === undefined || Option.isNone(decoded)) return denied("corruption");
      const record = decoded.value;
      if (
        ids.has(record.recordId) ||
        payload.recordId !== row.recordId ||
        record.recordId !== row.recordId ||
        record.projectId !== row.projectId ||
        record.status !== row.status ||
        record.revision !== row.revision ||
        record.generation !== row.generation ||
        record.updatedAt !== row.updatedAt ||
        record.sourceId !== row.sourceId ||
        Buffer.byteLength(payload.payload, "utf8") !== row.bytes ||
        row.uniqueKey !==
          (record.kind === "memory-observation"
            ? encodeUniqueKey([
                record.sourceId,
                record.sourceRevision,
                record.sourceGeneration,
                record.observationKey,
              ])
            : null)
      )
        return denied("corruption");
      ids.add(record.recordId);
      // Keep the variants separate without trusting table names as payload discriminants.
      if (record.kind === "memory-source") sources.push(record);
      else observations.push(record);
    }
  }
  const selected = selectProjectMemoryHits({
    ...input,
    sources,
    observations,
    authorityComplete: true,
  });
  return selected.status === "denied"
    ? denied(selected.reason === "incomplete-authority" ? "incomplete-authority" : "corruption")
    : selected;
});

/** The caller authorizes the target project/role/attempt and rechecks access before
 * delivering context. This reader establishes only current durable memory authority. */
export const hydrateProjectMemoryHits = Effect.fn("hydrateProjectMemoryHits")(function* (
  sql: SqlClient.SqlClient,
  input: unknown,
) {
  const decoded = yield* Effect.try({
    try: () => decodeHydrationInput(input),
    catch: () => "invalid-input" as const,
  }).pipe(Effect.orElseSucceed(() => Option.none<typeof Input.Type>()));
  if (Option.isNone(decoded)) return denied("invalid-input");
  const transaction = yield* Effect.serviceOption(sql.transactionService);
  return yield* Option.isSome(transaction)
    ? readSnapshot(sql, decoded.value)
    : sql.withTransaction(readSnapshot(sql, decoded.value));
});
