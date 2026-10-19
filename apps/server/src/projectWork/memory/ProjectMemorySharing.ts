import {
  ProjectId,
  ProjectMemorySource,
  ProjectTeamMemorySourceSelector,
  ProjectTeamMemorySharedSourcesRead,
  ProjectWorkReadIntent,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ProjectTeamAuthority } from "../ProjectTeamAuthorization.ts";
import { readProjectMemorySnapshot } from "./ProjectMemoryHitHydration.ts";
import { ProjectMemoryServiceError, projectMemoryHash } from "./ProjectMemoryService.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeSelection = Schema.decodeUnknownEffect(ProjectTeamMemorySourceSelector, strict);
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource), strict);
const decodeRead = Schema.decodeUnknownEffect(ProjectWorkReadIntent, strict);
const decodePage = Schema.decodeUnknownEffect(ProjectTeamMemorySharedSourcesRead, strict);
const decodeOwner = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ projectId: ProjectId })),
);
const isServiceError = Schema.is(ProjectMemoryServiceError);
const deny = (reason: string) => new ProjectMemoryServiceError({ reason });
export const projectMemorySourceSelection = (source: ProjectMemorySource) => ({
  sourceRecordId: source.recordId,
  expectedSourceRecordRevision: source.revision,
  sourceRevision: source.sourceRevision,
  sourceGeneration: source.generation,
  contentHash: source.contentHash,
});

/** The physical owner is resolved here, never supplied by the agent. The audited
 * event/projection snapshot includes correction closure and lifecycle tombstones. */
export const qualifyProjectMemorySharedSource = Effect.fn("ProjectMemorySharing.qualify")(
  function* (
    sql: SqlClient.SqlClient,
    projectId: ProjectId,
    supplied: ProjectTeamMemorySourceSelector,
  ) {
    if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
      return yield* deny("Shared source qualification requires the owning transaction");
    const selection = yield* decodeSelection(supplied);
    const owners = yield* decodeOwner(
      yield* sql`SELECT project_id AS projectId
      FROM project_team_memory_source WHERE record_id=${selection.sourceRecordId} LIMIT 2`,
    );
    if (owners.length !== 1 || owners[0]?.projectId === projectId)
      return yield* deny("Shared source requires one foreign physical owner");
    const ownerProjectId = owners[0]!.projectId;
    const snapshot = yield* readProjectMemorySnapshot(
      sql,
      { projectId, hitIds: [] },
      ownerProjectId,
    );
    if (snapshot.status === "denied") return yield* deny("Shared source authority is unavailable");
    const source = snapshot.sources.find((record) => record.recordId === selection.sourceRecordId);
    if (
      source === undefined ||
      source.projectId !== ownerProjectId ||
      source.status !== "current" ||
      source.tombstonedAt !== undefined ||
      !source.sharedWithProjectIds.includes(projectId) ||
      canonicalProjectWorkPayload(projectMemorySourceSelection(source)) !==
        canonicalProjectWorkPayload(selection) ||
      projectMemoryHash(source.content) !== source.contentHash ||
      snapshot.sources.some(
        (other) =>
          other.recordId !== source.recordId &&
          other.projectId === ownerProjectId &&
          (other.supersedes === source.recordId ||
            (other.sourceId === source.sourceId &&
              (other.status === "current" ||
                other.status === "conflicted" ||
                other.generation > source.generation ||
                other.sourceRevision > source.sourceRevision))),
      )
    )
      return yield* deny("Shared source grant or exact current tuple changed");
    return { ownerProjectId, selection, sourceSha256: projectMemoryHash(source) };
  },
  Effect.mapError((error) =>
    isServiceError(error) ? error : deny("Shared source qualification failed"),
  ),
);

export const readProjectMemorySharedSources = Effect.fn("ProjectMemorySharing.readSources")(
  function* (
    sql: SqlClient.SqlClient,
    input: ProjectWorkReadIntent,
    authority: ProjectTeamAuthority,
  ) {
    const request = yield* decodeRead(input);
    if (
      request.operation !== "memory-shared-sources" ||
      request.projectId !== authority.binding.projectId ||
      request.taskId !== authority.binding.taskId ||
      authority.role.memoryAccess !== "shared" ||
      Option.isNone(yield* Effect.serviceOption(sql.transactionService))
    )
      return yield* deny("Shared discovery requires its assigned task and shared memory access");
    const limit = request.limit ?? 32;
    // Candidate payloads are byte-bounded before decoding. The keyset is
    // the immutable source record ID; source ownership is independently re-derived.
    const rows = yield* sql<{ id: string; payload: string | null }>`SELECT record_id AS id,
      CASE WHEN length(CAST(payload_json AS BLOB))<=262144 THEN payload_json END AS payload
      FROM project_team_memory_source WHERE project_id<>${request.projectId} AND status='current'
      AND record_id>${request.cursor ?? ""} AND EXISTS (SELECT 1 FROM json_each(
        CASE WHEN length(CAST(payload_json AS BLOB))<=262144 AND json_valid(payload_json)
        THEN json_extract(payload_json,'$.sharedWithProjectIds') ELSE '[]' END
      ) WHERE value=${request.projectId}) ORDER BY record_id LIMIT ${limit + 1}`;
    const items: Array<(typeof ProjectTeamMemorySharedSourcesRead.Type.items)[number]> = [];
    for (const row of rows.slice(0, limit)) {
      const source = yield* decodeSource(row.payload);
      if (source.recordId !== row.id) return yield* deny("Shared source physical identity changed");
      const qualified = yield* qualifyProjectMemorySharedSource(
        sql,
        request.projectId,
        projectMemorySourceSelection(source),
      );
      items.push({ ownerProjectId: qualified.ownerProjectId, selection: qualified.selection });
    }
    return yield* decodePage({
      projectId: request.projectId,
      taskId: request.taskId,
      revision: authority.state.revision,
      status: "available",
      items,
      ...(rows.length > limit ? { nextCursor: rows[limit - 1]!.id } : {}),
    });
  },
  Effect.mapError(() => deny("Shared source discovery is unavailable")),
);
