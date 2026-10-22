import {
  type ProjectWorkWriteIntent,
  ProjectWorkMemoryObservationsRead,
  ProjectWorkKnowledgeId,
  type ProjectWorkReadIntent,
  type ProjectTeamMemorySelection,
  type ProjectWorkWriteResult,
  ProjectWorkRpcError,
  ProjectMemorySource,
  MemoryGrant,
  type ProjectTeamMemorySourceSelector,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Authorization from "../ProjectTeamAuthorization.ts";
import * as Repository from "../ProjectWorkRepository.ts";
import type { ProjectWorkPrincipal } from "../ProjectWorkGateway.ts";
import { projectWorkCommandFingerprint } from "../ProjectWorkPolicy.ts";
import {
  memoryHash,
  sourceTuple,
  ownerId,
  ProjectMemoryError,
  type MemoryScope,
} from "./ProjectMemoryRepository.ts";
import {
  authorizedWorkSource,
  memoryWorkKey,
  type WorkMemoryReference,
} from "./ProjectMemoryCapture.ts";
import * as Memory from "./ProjectMemoryService.ts";

export class ProjectMemoryQuery extends Context.Service<
  ProjectMemoryQuery,
  {
    readonly read: (
      input: ProjectWorkReadIntent,
      principal?: ProjectWorkPrincipal,
    ) => Effect.Effect<unknown, ProjectWorkRpcError>;
    readonly write: (
      input: ProjectWorkWriteIntent,
      principal: ProjectWorkPrincipal,
    ) => Effect.Effect<ProjectWorkWriteResult, ProjectWorkRpcError>;
  }
>()("t3/projectWork/memory/ProjectMemoryQuery") {}
type MemoryWrite = Extract<
  ProjectWorkWriteIntent,
  {
    type:
      | "project-team.memory.promote"
      | "project-team.memory.process"
      | "project-team.memory.query"
      | "project-team.memory.retract"
      | "project-team.memory.shares.replace";
  }
>;
const isMemoryWrite = (input: ProjectWorkWriteIntent): input is MemoryWrite =>
  [
    "project-team.memory.promote",
    "project-team.memory.process",
    "project-team.memory.query",
    "project-team.memory.retract",
    "project-team.memory.shares.replace",
  ].includes(input.type);
const decodeObservations = Schema.decodeUnknownEffect(ProjectWorkMemoryObservationsRead);
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource));
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(ProjectMemorySource));
const decodeGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryGrant));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* Memory.ProjectMemoryService;
  const repository = yield* Repository.ProjectWorkRepository;
  const authorization = yield* Authorization.ProjectTeamAuthorization;
  const environment = yield* Environment.ServerEnvironment;
  const hydrateSelected = Effect.fn("ProjectMemoryQuery.hydrateSelected")(function* (
    scope: MemoryScope,
    selector: ProjectTeamMemorySourceSelector,
  ) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${scope.environmentId} AND owner_kind=${selector.owner.kind} AND owner_id=${ownerId(selector.owner)} AND owner_revision=${selector.ownerRevision} AND source_revision=${selector.sourceRevision} AND generation=${selector.sourceGeneration} AND content_hash=${selector.contentHash} AND json_extract(payload_json,'$.recordId')=${selector.sourceRecordId} AND json_extract(payload_json,'$.revision')=${selector.expectedSourceRecordRevision} AND status='current' LIMIT 1`;
    if (rows[0] === undefined) return yield* new ProjectMemoryError({ reason: "stale" });
    const source = yield* decodeSource(rows[0].payload_json);
    const hits = yield* memory.hydrateCurrentHits({
      ...scope,
      hits: [
        sourceTuple(
          {
            environmentId: scope.environmentId,
            owner: selector.owner,
            ownerRevision: selector.ownerRevision,
          },
          source,
        ),
      ],
    });
    if (hits.length !== 1) return yield* new ProjectMemoryError({ reason: "forbidden" });
    return hits;
  });
  const observations = Effect.fn("ProjectMemoryQuery.observations")(function* (
    scope: MemoryScope,
    taskId: string,
    cursor: string,
    limit: number,
    exact = false,
  ) {
    const rows = yield* sql<{
      id: string;
      operation_key: string;
      observation_key: string;
      source_id: string;
      source_revision: number;
      generation: number;
      content_hash: string;
      body: string;
      quote: string;
      source_start: number;
      source_end: number;
    }>`
      SELECT json_array(o.operation_key,o.observation_key) AS id,o.* FROM t3_workflow_v2_memory_observations o
      JOIN t3_workflow_v2_memory_sources s ON s.environment_id=o.environment_id AND s.owner_kind=o.owner_kind AND s.owner_id=o.owner_id AND s.owner_revision=o.owner_revision AND s.source_id=o.source_id AND s.source_revision=o.source_revision AND s.generation=o.generation AND s.content_hash=o.content_hash
      WHERE o.environment_id=${scope.environmentId} AND o.owner_kind='project' AND o.owner_id=${ownerId(scope.owner)} AND o.owner_revision=${scope.ownerRevision} AND o.status='current' AND s.status='current' AND s.task_id=${taskId}
      AND (${exact ? 1 : 0}=1 AND json_array(o.operation_key,o.observation_key)=${cursor} OR ${exact ? 1 : 0}=0 AND json_array(o.operation_key,o.observation_key)>${cursor})
      ORDER BY id LIMIT ${limit}`;
    const items: Array<ProjectWorkMemoryObservationsRead["items"][number]> = [];
    for (const row of rows) {
      const hits = yield* memory.hydrateCurrentHits({
        ...scope,
        hits: [
          {
            ...scope,
            sourceId: row.source_id,
            sourceRevision: row.source_revision,
            generation: row.generation,
            contentHash: row.content_hash,
          },
        ],
      });
      if (
        hits.length !== 1 ||
        hits[0]!.content.slice(row.source_start, row.source_end) !== row.quote
      )
        continue;
      items.push({
        observationId: row.id,
        revision: 0,
        sourceId: row.source_id,
        sourceRevision: row.source_revision,
        sourceGeneration: row.generation,
        contentHash: row.content_hash,
        body: row.body,
        quote: row.quote,
      });
    }
    return { items, ...(rows.length === limit ? { nextCursor: rows[rows.length - 1]!.id } : {}) };
  });
  const read = Effect.fn("ProjectMemoryQuery.read")(
    function* (input: ProjectWorkReadIntent, principal?: ProjectWorkPrincipal) {
      const env = yield* environment.getEnvironmentId;
      if (
        (principal?.environmentId !== undefined && principal.environmentId !== env) ||
        (principal?.projectId !== undefined && principal.projectId !== input.projectId)
      )
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      const state = yield* Repository.readCurrentState(sql, input.projectId);
      if (input.taskId === undefined || !state.tasks.some((task) => task.taskId === input.taskId))
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      const scope = {
        environmentId: env,
        owner: { kind: "project" as const, projectId: input.projectId },
        ownerRevision: 0,
      };
      // Assert the live owner even for empty candidate lists.
      yield* memory.listCurrent({ ...scope, limit: 1 });
      if (input.operation === "memory-observations") {
        return yield* decodeObservations({
          environmentId: env,
          projectId: input.projectId,
          taskId: input.taskId,
          revision: state.revision,
          ...(yield* observations(
            scope,
            input.taskId,
            input.cursor ?? "",
            Math.min(32, input.limit ?? 32),
          )),
        });
      }
      if (input.operation === "memory-current" || input.operation === "memory-recall") {
        const page = yield* input.operation === "memory-recall" && input.sharedSource !== undefined
          ? hydrateSelected(scope, input.sharedSource).pipe(
              Effect.map((items) => ({
                items: items.filter(
                  (source) =>
                    (input.cursor === undefined || source.sourceId > input.cursor) &&
                    source.content.toLowerCase().includes((input.query ?? "").toLowerCase()),
                ),
                nextCursor: null,
              })),
            )
          : input.operation === "memory-current"
            ? memory.listCurrentPage({
                ...scope,
                limit: Math.min(32, input.limit ?? 32),
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              })
            : memory.recallTextPage({
                ...scope,
                limit: Math.min(32, input.limit ?? 32),
                query: input.query ?? "",
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
              });
        let bytes = 0;
        let consumed = 0;
        let lastScanned = input.cursor ?? "";
        const items: ProjectMemorySource[] = [];
        for (const source of page.items) {
          const size = new TextEncoder().encode(yield* encodeSource(source)).byteLength;
          if (size > 64000) {
            consumed++;
            lastScanned = source.sourceId;
            continue;
          }
          if (bytes + size > 64000) break;
          items.push(source);
          bytes += size;
          consumed++;
          lastScanned = source.sourceId;
        }
        const nextCursor = consumed < page.items.length ? lastScanned : page.nextCursor;
        return {
          owner: scope.owner,
          projectId: input.projectId,
          taskId: input.taskId,
          revision: state.revision,
          status: "available",
          items,
          ...(nextCursor === null ? {} : { nextCursor }),
        };
      }
      if (input.operation === "memory-shared-sources") {
        const grants = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM t3_workflow_v2_memory_grants WHERE environment_id=${env} AND recipient_kind='project' AND recipient_id=${input.projectId} AND recipient_revision=0 AND revoked_at IS NULL AND id > ${input.cursor ?? ""} ORDER BY id LIMIT ${Math.min(32, input.limit ?? 32)}`;
        const items: {
          owner: ProjectTeamMemorySourceSelector["owner"];
          selection: ProjectTeamMemorySourceSelector;
        }[] = [];
        for (const row of grants) {
          const grant = yield* decodeGrant(row.payload_json);
          const sources = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${env} AND owner_kind=${grant.source.owner.kind} AND owner_id=${grant.source.owner.kind === "project" ? grant.source.owner.projectId : grant.source.owner.assistantId} AND owner_revision=${grant.ownerRevision} AND source_id=${grant.source.sourceId} AND source_revision=${grant.source.sourceRevision} AND status='current' LIMIT 1`;
          if (sources[0] === undefined) continue;
          const source = yield* decodeSource(sources[0].payload_json);
          const hit = sourceTuple(
            { environmentId: env, owner: source.owner, ownerRevision: grant.ownerRevision },
            source,
          );
          if ((yield* memory.hydrateCurrentHits({ ...scope, hits: [hit] })).length === 0) continue;
          items.push({
            owner: source.owner,
            selection: {
              owner: source.owner,
              ownerRevision: source.ownerRevision,
              sourceRecordId: source.recordId,
              expectedSourceRecordRevision: source.revision,
              sourceRevision: source.sourceRevision,
              sourceGeneration: source.generation,
              contentHash: source.contentHash,
            },
          });
        }
        return {
          owner: scope.owner,
          projectId: input.projectId,
          taskId: input.taskId,
          revision: state.revision,
          status: "available",
          items,
          ...(grants.length === Math.min(32, input.limit ?? 32)
            ? {
                nextCursor: (yield* decodeGrant(grants[grants.length - 1]!.payload_json)).id,
              }
            : {}),
        };
      }
      if (input.operation !== "memory-sources")
        return yield* new ProjectMemoryError({ reason: "invalid" });
      const refs: WorkMemoryReference[] = [
        ...(state.comments ?? [])
          .filter((r) => r.taskId === input.taskId)
          .map((r) => ({
            taskId: input.taskId!,
            kind: "comment" as const,
            retainedId: r.commentId,
            retainedRevision: r.revision,
          })),
        ...state.evidence
          .filter((r) => r.taskId === input.taskId)
          .map((r) => ({
            taskId: input.taskId!,
            kind: "evidence" as const,
            retainedId: r.evidenceId,
            retainedRevision: r.revision,
          })),
      ];
      refs.push(
        ...(state.decisions ?? [])
          .filter((record) => record.projectId === input.projectId && record.state === "accepted")
          .map((record) => ({
            taskId: input.taskId!,
            kind: "decision" as const,
            retainedId: record.decisionId,
            retainedRevision: record.revision,
          })),
      );
      refs.sort((a, b) => (memoryWorkKey(a) < memoryWorkKey(b) ? -1 : 1));
      const items: { selection: ProjectTeamMemorySelection; status: "waiting" }[] = [];
      for (const ref of refs
        .filter((r) => memoryWorkKey(r) > (input.cursor ?? ""))
        .slice(0, Math.min(32, input.limit ?? 32))) {
        const source = yield* Effect.try({
          try: () => authorizedWorkSource(state, ref),
          catch: () => new ProjectMemoryError({ reason: "stale" }),
        });
        const id = memoryWorkKey(ref);
        const effect = state.foundationRecords?.find(
          (record) =>
            record.kind === "effect" &&
            record.effectKind === "memory-index" &&
            record.taskId === input.taskId &&
            record.sourceId === id,
        );

        items.push({
          status: "waiting",
          selection: {
            owner: scope.owner,
            ownerRevision: 0,
            kind: ref.kind,
            retainedId: ref.retainedId,
            retainedRevision: ref.retainedRevision,
            sourceRecordId: `memory:${id}`,
            expectedSourceRecordRevision: 0,
            sourceRevision: ref.retainedRevision,
            sourceGeneration:
              effect?.kind === "effect" ? (effect.sourceGeneration ?? 0) : ref.retainedRevision,
            contentHash: memoryHash(source.content),
            effectId: effect?.recordId ?? `memory-source:${id}`,
            expectedEffectRevision: effect?.revision ?? 0,
            expectedClaimGeneration: effect?.kind === "effect" ? effect.claimGeneration : 0,
          },
        });
      }
      return {
        owner: scope.owner,
        projectId: input.projectId,
        taskId: input.taskId,
        revision: state.revision,
        status: "available",
        items,
        ...(items.length === Math.min(32, input.limit ?? 32) && items.length > 0
          ? {
              nextCursor: memoryWorkKey(items[items.length - 1]!.selection),
            }
          : {}),
      };
    },
    Effect.mapError(() => new ProjectWorkRpcError({ operation: "read", reason: "rejected" })),
  );
  const write = Effect.fn("ProjectMemoryQuery.write")(
    function* (input: ProjectWorkWriteIntent, principal: ProjectWorkPrincipal) {
      if (!isMemoryWrite(input)) return yield* new ProjectMemoryError({ reason: "invalid" });
      const env = yield* environment.getEnvironmentId;
      if (
        (principal.environmentId !== undefined && principal.environmentId !== env) ||
        (principal.projectId !== undefined && principal.projectId !== input.projectId)
      )
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      yield* authorization.assertHuman(principal);
      const now = DateTime.formatIso(yield* DateTime.now);
      const attribution = { actor: principal.actor, source: principal.source, recordedAt: now };
      if (input.type === "project-team.memory.promote") {
        const scope = {
          environmentId: env,
          owner: { kind: "project" as const, projectId: input.projectId },
          ownerRevision: 0,
        };
        const envelope = {
          type: "project-work.knowledge.promote" as const,
          projectId: input.projectId,
          commandId: input.commandId,
          attribution,
          knowledge: {
            knowledgeId: ProjectWorkKnowledgeId.make(input.knowledgeId),
            projectId: input.projectId,
            title: input.title,
            body: "pending",
            sourceKind: "manual" as const,
            sourceId: input.observationId,
            revision: 0,
            createdAt: now,
            updatedAt: now,
            attribution,
          },
          promotedAt: now,
        };
        const result = yield* repository.executeAuthorized(
          envelope,
          ({ state }) =>
            Effect.gen(function* () {
              yield* authorization.assertHuman(principal);
              const task = state.tasks.find((t) => t.taskId === input.taskId);
              if (
                state.revision !== input.expectedRevision ||
                task?.revision !== input.expectedTaskRevision ||
                task.specRevision !== input.specRevision ||
                input.planRevision !==
                  Math.max(
                    0,
                    ...(state.foundationRecords ?? [])
                      .filter((r) => r.kind === "plan-revision" && r.taskId === input.taskId)
                      .map((r) => (r.kind === "plan-revision" ? r.planRevision : 0)),
                  )
              )
                return yield* new ProjectMemoryError({ reason: "stale" });
              const page = yield* observations(scope, input.taskId, input.observationId, 1, true);
              const observation = page.items[0];
              if (
                observation === undefined ||
                observation.revision !== input.expectedObservationRevision ||
                observation.sourceRevision !== input.expectedSourceRevision
              )
                return yield* new ProjectMemoryError({ reason: "stale" });
              return { ...envelope, knowledge: { ...envelope.knowledge, body: observation.body } };
            }),
          () => authorization.assertHuman(principal),
          projectWorkCommandFingerprint(input),
        );
        return result.writeResult;
      }
      const command = {
        type: "project-work.foundation.commit" as const,
        commandId: input.commandId,
        projectId: input.projectId,
        expectedRevision: input.expectedRevision,
        attribution,
        records: [],
        committedAt: now,
        ...(input.type === "project-team.memory.query"
          ? {}
          : {
              transition: {
                kind: "memory.invalidate" as const,
                owner:
                  input.type === "project-team.memory.process"
                    ? input.selection.owner
                    : input.owner,
              },
            }),
      };
      const result = yield* repository.executeReserved(
        command,
        () =>
          Effect.gen(function* () {
            // Human session and every source selector are checked inside the receipt transaction.
            yield* authorization.assertHuman(principal);
            const state = yield* Repository.readCurrentState(sql, input.projectId);
            if (input.type === "project-team.memory.process") {
              const task = state.tasks.find((t) => t.taskId === input.taskId);
              const effect = state.foundationRecords?.find(
                (r) => r.kind === "effect" && r.recordId === input.selection.effectId,
              );
              const s = input.selection;
              if (
                task?.revision !== input.expectedTaskRevision ||
                task.specRevision !== input.specRevision ||
                input.planRevision !==
                  Math.max(
                    0,
                    ...(state.foundationRecords ?? [])
                      .filter((r) => r.kind === "plan-revision" && r.taskId === input.taskId)
                      .map((r) => (r.kind === "plan-revision" ? r.planRevision : 0)),
                  ) ||
                (effect?.kind === "effect"
                  ? effect.effectKind !== "memory-index" ||
                    effect.taskId !== input.taskId ||
                    effect.revision !== s.expectedEffectRevision ||
                    effect.claimGeneration !== s.expectedClaimGeneration ||
                    (effect.sourceGeneration ?? 0) !== s.sourceGeneration ||
                    effect.sourceId !== memoryWorkKey(s) ||
                    !["pending", "failed"].includes(effect.status)
                  : s.effectId !== `memory-source:${memoryWorkKey(s)}` ||
                    s.expectedEffectRevision !== 0 ||
                    s.expectedClaimGeneration !== 0 ||
                    s.sourceGeneration !== s.retainedRevision)
              )
                return yield* new ProjectMemoryError({ reason: "stale" });
              yield* memory.capture({
                environmentId: env,
                owner: { kind: "project", projectId: input.projectId },
                ownerRevision: s.ownerRevision,
                reference: {
                  taskId: input.taskId,
                  kind: s.kind,
                  retainedId: s.retainedId,
                  retainedRevision: s.retainedRevision,
                },
                selection: s,
                now,
              });
              return;
            }
            if (input.type === "project-team.memory.query") {
              if (input.owner.kind !== "project" || input.owner.projectId !== input.projectId)
                return yield* new ProjectMemoryError({ reason: "forbidden" });
              if (input.sharedSource !== undefined)
                yield* hydrateSelected(
                  { environmentId: env, owner: input.owner, ownerRevision: input.ownerRevision },
                  input.sharedSource,
                );
              else
                yield* memory.recallText({
                  environmentId: env,
                  owner: input.owner,
                  ownerRevision: input.ownerRevision,
                  limit: 32,
                  query: input.query,
                });
              return;
            }
            if (
              input.type !== "project-team.memory.retract" &&
              input.type !== "project-team.memory.shares.replace"
            )
              return yield* new ProjectMemoryError({ reason: "invalid" });
            if (input.owner.kind !== "project" || input.owner.projectId !== input.projectId)
              return yield* new ProjectMemoryError({ reason: "forbidden" });
            const scope = {
              environmentId: env,
              owner: input.owner,
              ownerRevision: input.ownerRevision,
            };
            const sourceRows = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${env} AND owner_kind='project' AND owner_id=${input.projectId} AND owner_revision=${input.ownerRevision} AND source_revision=${input.sourceRevision} AND generation=${input.sourceGeneration} AND content_hash=${input.contentHash} AND json_extract(payload_json,'$.recordId')=${input.sourceRecordId} AND json_extract(payload_json,'$.revision')=${input.expectedSourceRecordRevision} AND status='current' LIMIT 1`;
            const source =
              sourceRows[0] === undefined
                ? undefined
                : yield* decodeSource(sourceRows[0].payload_json);
            if (source === undefined) return yield* new ProjectMemoryError({ reason: "stale" });
            if (input.type === "project-team.memory.retract") {
              yield* memory.retract(sourceTuple(scope, source));
              return;
            }
            yield* memory.applyCurrent(
              sourceTuple(scope, source),
              () =>
                sql`UPDATE t3_workflow_v2_memory_grants SET revoked_at=${now} WHERE environment_id=${env} AND owner_kind='project' AND owner_id=${input.projectId} AND source_id=${source.sourceId} AND source_revision=${source.sourceRevision} AND revoked_at IS NULL`,
            );
            for (const recipient of input.recipients)
              yield* memory.grant({
                environmentId: env,
                source: {
                  owner: scope.owner,
                  sourceId: source.sourceId,
                  sourceRevision: source.sourceRevision,
                },
                ownerRevision: scope.ownerRevision,
                recipient: recipient.owner,
                recipientRevision: recipient.revision,
              });
            const updated = { ...source, revision: source.revision + 1, updatedAt: now };
            yield* sql`UPDATE t3_workflow_v2_memory_sources SET payload_json=${yield* encodeSource(updated)} WHERE environment_id=${env} AND owner_kind='project' AND owner_id=${input.projectId} AND source_id=${source.sourceId} AND source_revision=${source.sourceRevision} AND generation=${source.generation}`;
          }),
        projectWorkCommandFingerprint(input),
      );
      return result.writeResult;
    },
    Effect.mapError(() => new ProjectWorkRpcError({ operation: "write", reason: "rejected" })),
  );
  return ProjectMemoryQuery.of({ read, write });
});
export const layer = Layer.effect(ProjectMemoryQuery, make);
