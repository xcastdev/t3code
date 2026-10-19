import { expect, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkComment,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamMemorySharesReplaceIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { makeMem0Backend } from "./Mem0Backend.ts";
import { MemoryBackendError } from "./MemoryBackend.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../ProjectWorkRepository.ts";
import { ProjectWorkContentGuard, layer as guardLayer } from "../ProjectWorkContentGuard.ts";
import {
  ProjectTeamAuthorization,
  layer as authorizationLayer,
} from "../ProjectTeamAuthorization.ts";
import { makeProjectMemoryService } from "./ProjectMemoryService.ts";
import { readProjectMemoryObservations } from "./ProjectMemoryRetrieval.ts";
import {
  projectMemorySourceSelection,
  qualifyProjectMemorySharedSource,
} from "./ProjectMemorySharing.ts";

const at = "2026-10-19T00:00:00.000Z";
const attribution = {
  actor: { kind: "human", id: "sharing-human" },
  source: { kind: "web", id: "sharing-test" },
  recordedAt: at,
} as const;
const ownerId = ProjectId.make("sharing-owner");
const recipientId = ProjectId.make("sharing-recipient");
const decodeBackendEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      protocolVersion: Schema.Literal(1),
      requestId: Schema.String,
      operation: Schema.Literal("search"),
      input: Schema.Unknown,
    }),
  ),
);
const decodeComment = Schema.decodeUnknownEffect(ProjectWorkComment);
const decodeCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const decodeShares = Schema.decodeUnknownEffect(ProjectTeamMemorySharesReplaceIntent);
const layer = Layer.mergeAll(ProjectWorkRepositoryLive, authorizationLayer).pipe(
  Layer.provideMerge(guardLayer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectWorkRepository;
  const contentGuard = yield* ProjectWorkContentGuard;
  const authorization = yield* ProjectTeamAuthorization;
  for (const projectId of [ownerId, recipientId])
    yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},${projectId},${`/fixture/${projectId}`},'[]',${at},${at})`;
  const taskId = ProjectWorkTaskId.make("sharing-task");
  yield* repository.execute({
    type: "project-work.task.create",
    projectId: ownerId,
    taskId,
    commandId: CommandId.make("sharing-task-create"),
    title: "Retained source",
    createdAt: at,
  });
  const comment = yield* decodeComment({
    commentId: "sharing-comment",
    projectId: ownerId,
    taskId,
    body: "The parser keeps exact source provenance.",
    revision: 0,
    createdAt: at,
    attribution,
  });
  yield* repository.execute({
    type: "project-work.comment.add",
    projectId: ownerId,
    commandId: CommandId.make("sharing-comment-add"),
    comment,
    attribution,
    addedAt: at,
  });
  let modelCalls = 0;
  const service = makeProjectMemoryService({
    sql,
    repository,
    contentGuard,
    authorization,
    environmentId: "sharing-environment",
    models: {
      extract: () =>
        Effect.sync(() => {
          modelCalls++;
          return [
            {
              key: "parser",
              body: "The parser keeps provenance.",
              quote: "exact source provenance",
            },
          ];
        }),
      embed: () => Effect.die("No embeddings needed for SQL hydration"),
    },
  });
  const original = yield* service.captureRetained(ownerId, {
    kind: "comment",
    retainedId: comment.commentId,
  });
  const effect = (yield* readCurrentState(sql, ownerId)).foundationRecords?.find(
    (r) => r.kind === "effect" && r.targetId === original.recordId,
  );
  if (effect?.kind !== "effect") return yield* Effect.die("Missing captured effect");
  const claim = yield* service.claim(ownerId, effect.effectId);
  if (claim === undefined) return yield* Effect.die("Missing source claim");
  yield* service.extract(ownerId, effect.effectId, claim);
  const observations = (yield* service.readWork(ownerId, effect.effectId)).observations;
  const share = Effect.fn("sharingFixture.share")(function* (shares: readonly ProjectId[]) {
    return yield* repository.executeAtomic(
      Effect.gen(function* () {
        const state = yield* readCurrentState(sql, ownerId);
        const source = state.foundationRecords?.find(
          (r) => r.kind === "memory-source" && r.recordId === original.recordId,
        );
        if (source?.kind !== "memory-source") return yield* Effect.die("Missing source");
        const request = yield* decodeShares({
          type: "project-team.memory.shares.replace",
          projectId: ownerId,
          commandId: `shares-${source.revision}`,
          expectedRevision: state.revision,
          ...projectMemorySourceSelection(source),
          sharedWithProjectIds: shares,
        });
        const records = yield* service.prepareSharesInTransaction(request, at);
        return [
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            commandId: request.commandId,
            projectId: ownerId,
            expectedRevision: state.revision,
            records,
            attribution,
            committedAt: at,
          }),
        ];
      }),
    );
  });
  yield* share([recipientId]);
  const source = (yield* readCurrentState(sql, ownerId)).foundationRecords?.find(
    (r) => r.kind === "memory-source" && r.recordId === original.recordId,
  );
  if (source?.kind !== "memory-source") return yield* Effect.die("Missing shared source");
  const selection = projectMemorySourceSelection(source);
  const frozen = yield* sql.withTransaction(
    qualifyProjectMemorySharedSource(sql, recipientId, selection),
  );
  const read = () =>
    sql.withTransaction(
      readProjectMemoryObservations(
        sql,
        recipientId,
        "parser",
        observations.map((r) => r.recordId),
        frozen,
      ),
    );
  return {
    sql,
    repository,
    service,
    source,
    selection,
    frozen,
    observations,
    read,
    share,
    modelCalls,
  };
});

it.effect(
  "hydrates a selected shared source from real capture SQL with unchanged owner and provenance",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect(f.modelCalls).toBe(1);
      expect((yield* f.read()).records).toEqual(f.observations);
      expect(f.frozen.ownerProjectId).toBe(ownerId);
      expect(f.observations[0]?.projectId).toBe(ownerId);
      expect(f.observations[0]?.provenance).toEqual(attribution);
      expect(
        yield* f.sql`SELECT * FROM project_team_memory_source WHERE project_id=${recipientId}`,
      ).toEqual([]);
      expect((yield* readProjectMemoryObservations(f.sql, recipientId, "parser")).records).toEqual(
        [],
      );
      yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,changed_at)
      VALUES (${ownerId},'archived','/fixture/owner',${at})`;
      expect((yield* f.read()).records).toEqual(f.observations);
    }).pipe(Effect.provide(layer)),
);

for (const mutation of [
  "revoked",
  "retracted",
  "deleted",
  "tombstoned",
  "conflicted",
  "superseded",
  "physical-conflict",
] as const)
  it.effect(`rejects delayed shared hits after ${mutation}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* f.read();
      expect(before.status).toBe("available");
      if (mutation === "revoked") yield* f.share([]);
      else if (mutation === "retracted") yield* f.service.retract(ownerId, f.source.recordId);
      else if (mutation === "deleted")
        yield* f.sql`UPDATE projection_projects SET deleted_at=${at} WHERE project_id=${ownerId}`;
      else if (mutation === "tombstoned")
        yield* f.sql`INSERT INTO project_lifecycle(project_id,state,workspace_root,changed_at)
      VALUES (${ownerId},'tombstoned','/fixture/owner',${at})`;
      else if (mutation === "physical-conflict")
        yield* f.sql`UPDATE project_team_memory_source SET project_id=${recipientId} WHERE record_id=${f.source.recordId}`;
      else {
        const state = yield* readCurrentState(f.sql, ownerId);
        yield* f.repository.execute(
          yield* decodeCommit({
            type: "project-work.foundation.commit",
            commandId: `change-${mutation}`,
            projectId: ownerId,
            expectedRevision: state.revision,
            attribution,
            committedAt: at,
            records: [
              {
                ...f.source,
                revision: f.source.revision + 1,
                status: mutation === "conflicted" ? "conflicted" : "superseded",
              },
            ],
          }),
        );
      }
      expect((yield* f.read()).records).toEqual([]);
      expect(
        (yield* f.sql
          .withTransaction(qualifyProjectMemorySharedSource(f.sql, recipientId, f.selection))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );

it.effect(
  "bounds backend search to one owner/source and rejects foreign environment or conflicting tuple responses",
  () =>
    Effect.gen(function* () {
      const input = {
        environmentId: "sharing-environment",
        projectId: ownerId,
        source: { sourceRecordId: "shared-source", sourceRevision: 4, sourceGeneration: 2 },
        vector: Array.from({ length: 2048 }, () => 0.125),
        limit: 12,
      };
      const candidate = {
        ...input.source,
        environmentId: input.environmentId,
        projectId: input.projectId,
        extractionId: "shared-extraction",
        observationId: "shared-observation",
        score: 1,
      };
      for (const change of [
        {},
        { environmentId: "foreign-environment" },
        { projectId: recipientId },
        { sourceRecordId: "another-source" },
        { sourceRevision: 5 },
        { sourceGeneration: 3 },
      ]) {
        const backend = makeMem0Backend((bytes) =>
          Effect.gen(function* () {
            const request = yield* decodeBackendEnvelope(new TextDecoder().decode(bytes));
            expect(request.input).toEqual(input);
            return new TextEncoder().encode(
              canonicalProjectWorkPayload({
                protocolVersion: 1,
                requestId: "shared-search",
                operation: "search",
                result: { candidates: [{ ...candidate, ...change }] },
              }),
            );
          }).pipe(
            Effect.mapError(
              () =>
                new MemoryBackendError({
                  code: "invalid-request",
                  message: "Controlled byte request failed",
                }),
            ),
          ),
        );
        const result = yield* backend.search("shared-search", input).pipe(Effect.result);
        if (Object.keys(change).length === 0)
          expect(result).toMatchObject({ _tag: "Success", success: { candidates: [candidate] } });
        else
          expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid-response" } });
      }
    }),
);

it.effect(
  "rejects stale source selectors and local-source laundering without changing retained facts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const before = yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`;
      for (const selection of [
        {
          ...f.selection,
          expectedSourceRecordRevision: f.selection.expectedSourceRecordRevision + 1,
        },
        { ...f.selection, sourceRevision: f.selection.sourceRevision + 1 },
        { ...f.selection, sourceGeneration: f.selection.sourceGeneration + 1 },
        { ...f.selection, contentHash: "0".repeat(64) },
        { ...f.selection, sourceRecordId: "absent-source" },
      ])
        expect(
          (yield* f.sql
            .withTransaction(qualifyProjectMemorySharedSource(f.sql, recipientId, selection))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect(
        (yield* f.sql
          .withTransaction(qualifyProjectMemorySharedSource(f.sql, ownerId, f.selection))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql`SELECT * FROM project_work_events ORDER BY sequence`).toEqual(before);
      expect((yield* f.read()).records).toEqual(f.observations);
    }).pipe(Effect.provide(layer)),
);
