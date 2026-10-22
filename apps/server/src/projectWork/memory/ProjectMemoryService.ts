import { ProjectMemoryFactPolicy } from "./ProjectMemoryFactPolicy.ts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import {
  ProjectMemorySource,
  MemoryGrant,
  type MemoryGrantInput,
  type MemoryGrantRevokeInput,
  type MemoryGrantListInput,
  type ProjectTeamMemorySelection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import { readCurrentState } from "../ProjectWorkRepository.ts";
import {
  authorizedWorkSource,
  captureWorkSource,
  type WorkMemoryReference,
} from "./ProjectMemoryCapture.ts";
import {
  ProjectMemoryError,
  ownerId,
  memoryHash,
  sourceTuple,
  type MemoryScope,
  type MemorySourceTuple,
  type MemorySourceRow,
} from "./ProjectMemoryRepository.ts";

export class ProjectMemoryOwnerAuthority extends Context.Service<
  ProjectMemoryOwnerAuthority,
  {
    readonly assertCurrent: (scope: MemoryScope) => Effect.Effect<void, ProjectMemoryError>;
    readonly authorizeForgottenCapture?: (
      input: MemoryScope & { readonly source: ProjectMemorySource },
    ) => Effect.Effect<boolean, ProjectMemoryError>;
    readonly sourceIsCurrent: (
      input: MemorySourceTuple & { readonly source: ProjectMemorySource },
    ) => Effect.Effect<boolean, ProjectMemoryError>;
    readonly authorizeCapture: (
      input: MemoryScope & { readonly source: ProjectMemorySource },
    ) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/projectWork/memory/ProjectMemoryService/ProjectMemoryOwnerAuthority") {}

export interface CaptureInput extends MemoryScope {
  readonly reference: WorkMemoryReference;
  readonly selection: ProjectTeamMemorySelection;
  readonly now: string;
}
export interface MemoryListInput extends MemoryScope {
  readonly limit: number;
  readonly cursor?: string;
}
export interface MemoryPage {
  readonly items: ReadonlyArray<ProjectMemorySource>;
  readonly nextCursor: string | null;
}
export class ProjectMemoryService extends Context.Service<
  ProjectMemoryService,
  {
    readonly captureRetained: (
      input: MemoryScope & { readonly source: ProjectMemorySource },
    ) => Effect.Effect<ProjectMemorySource, ProjectMemoryError>;
    readonly capture: (
      input: CaptureInput,
    ) => Effect.Effect<ProjectMemorySource, ProjectMemoryError>;
    readonly correct: (
      input: (CaptureInput | (MemoryScope & { readonly source: ProjectMemorySource })) & {
        readonly previous: MemorySourceTuple;
      },
    ) => Effect.Effect<ProjectMemorySource, ProjectMemoryError>;
    readonly retract: (tuple: MemorySourceTuple) => Effect.Effect<void, ProjectMemoryError>;
    readonly readSource: (
      tuple: MemorySourceTuple,
    ) => Effect.Effect<ProjectMemorySource | undefined, ProjectMemoryError>;
    readonly applyCurrent: <A, E, R>(
      tuple: MemorySourceTuple,
      apply: (source: ProjectMemorySource) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ProjectMemoryError, R>;
    readonly listCurrentPage: (
      input: MemoryListInput,
    ) => Effect.Effect<MemoryPage, ProjectMemoryError>;
    readonly recallTextPage: (
      input: MemoryListInput & { readonly query: string },
    ) => Effect.Effect<MemoryPage, ProjectMemoryError>;
    readonly listCurrent: (
      input: MemoryListInput,
    ) => Effect.Effect<ReadonlyArray<ProjectMemorySource>, ProjectMemoryError>;
    readonly recallText: (
      input: MemoryListInput & { readonly query: string },
    ) => Effect.Effect<ReadonlyArray<ProjectMemorySource>, ProjectMemoryError>;
    readonly hydrateCurrentHits: (
      input: MemoryScope & { readonly hits: ReadonlyArray<MemorySourceTuple> },
    ) => Effect.Effect<ReadonlyArray<ProjectMemorySource>, ProjectMemoryError>;
    readonly grant: (input: MemoryGrantInput) => Effect.Effect<MemoryGrant, ProjectMemoryError>;
    readonly revoke: (input: MemoryGrantRevokeInput) => Effect.Effect<void, ProjectMemoryError>;
    readonly listGrants: (
      input: MemoryGrantListInput & { readonly ownerRevision: number },
    ) => Effect.Effect<ReadonlyArray<MemoryGrant>, ProjectMemoryError>;
    readonly enqueueCleanup: (
      tuple: MemorySourceTuple,
      operationKey: string,
    ) => Effect.Effect<void, ProjectMemoryError>;
    readonly deleteOwner: (scope: MemoryScope) => Effect.Effect<void, ProjectMemoryError>;
  }
>()("t3/projectWork/memory/ProjectMemoryService") {}
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource));
const decodeRetainedSource = Schema.decodeUnknownEffect(ProjectMemorySource);
const decodeNewGrant = Schema.decodeUnknownEffect(MemoryGrant);
const decodeGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(MemoryGrant));
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isMemoryError = Schema.is(ProjectMemoryError);
const unavailable = (cause: unknown) =>
  isMemoryError(cause) ? cause : new ProjectMemoryError({ reason: "unavailable", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const factPolicy = yield* Effect.serviceOption(ProjectMemoryFactPolicy);
  const projects = yield* ProjectStore.ProjectStoreV2;
  const ownerAuthority = yield* Effect.serviceOption(ProjectMemoryOwnerAuthority);
  const crypto = yield* Crypto.Crypto;
  const environment = yield* Environment.ServerEnvironment;
  const assertOwner = Effect.fn("ProjectMemory.assertOwner")(function* (scope: MemoryScope) {
    if (scope.environmentId !== (yield* environment.getEnvironmentId))
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    if (scope.owner.kind === "assistant") {
      if (Option.isNone(ownerAuthority))
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      yield* ownerAuthority.value.assertCurrent(scope);
    }
    const rows = yield* sql<{
      revision: number;
      deleted: number;
    }>`SELECT revision,deleted FROM t3_workflow_v2_memory_owners WHERE environment_id=${scope.environmentId} AND owner_kind=${scope.owner.kind} AND owner_id=${ownerId(scope.owner)}`;
    if (
      (scope.owner.kind === "project" &&
        Option.isNone(yield* projects.get(scope.owner.projectId))) ||
      (rows[0]?.deleted ?? 0) !== 0 ||
      (scope.owner.kind === "project" && scope.ownerRevision !== (rows[0]?.revision ?? 0))
    )
      return yield* new ProjectMemoryError({ reason: "stale" });
  });
  const rowsFor = (tuple: MemorySourceTuple) =>
    sql<MemorySourceRow>`SELECT payload_json,work_kind,work_id,work_revision,task_id FROM t3_workflow_v2_memory_sources WHERE environment_id=${tuple.environmentId} AND owner_kind=${tuple.owner.kind} AND owner_id=${ownerId(tuple.owner)} AND owner_revision=${tuple.ownerRevision} AND source_id=${tuple.sourceId} AND source_revision=${tuple.sourceRevision} AND generation=${tuple.generation} AND content_hash=${tuple.contentHash} AND status='current'`;
  const current = Effect.fn("ProjectMemory.current")(function* (tuple: MemorySourceTuple) {
    yield* assertOwner(tuple);
    const row = (yield* rowsFor(tuple))[0];
    if (row === undefined) return undefined;
    const source = yield* decodeSource(row.payload_json);
    if (tuple.owner.kind === "assistant") {
      if (Option.isNone(ownerAuthority)) return undefined;
      return (yield* ownerAuthority.value.sourceIsCurrent({ ...tuple, source }))
        ? source
        : undefined;
    }
    const state = yield* readCurrentState(sql, tuple.owner.projectId);
    const original = yield* Effect.try({
      try: () =>
        authorizedWorkSource(state, {
          kind: row.work_kind,
          retainedId: row.work_id,
          retainedRevision: row.work_revision,
          taskId: row.task_id,
        }),
      catch: unavailable,
    });
    return memoryHash(original.content) === tuple.contentHash ? source : undefined;
  });
  const applyCurrent = <A, E, R>(
    tuple: MemorySourceTuple,
    apply: (source: ProjectMemorySource) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProjectMemoryError, R> => {
    const callbackErrors = new Set<unknown>();
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const source = yield* current(tuple).pipe(Effect.mapError(unavailable));
          if (source === undefined) return yield* new ProjectMemoryError({ reason: "stale" });
          return yield* apply(source).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                callbackErrors.add(error);
              }),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => (callbackErrors.has(error) ? (error as E) : unavailable(error))),
      );
  };
  const enqueueCleanup = Effect.fn("ProjectMemory.enqueueCleanup")(function* (
    tuple: MemorySourceTuple,
    operationKey: string,
  ) {
    const payload = yield* encode(tuple);
    yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_cleanup(id,environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,status,payload_json) VALUES (${operationKey},${tuple.environmentId},${tuple.owner.kind},${ownerId(tuple.owner)},${tuple.ownerRevision},${tuple.sourceId},${tuple.sourceRevision},${tuple.generation},${tuple.contentHash},'pending',${payload}) ON CONFLICT(id) DO UPDATE SET status='pending',payload_json=excluded.payload_json`;
  }, Effect.mapError(unavailable));
  const invalidate = Effect.fn("ProjectMemory.invalidate")(function* (
    tuple: MemorySourceTuple,
    status: "superseded" | "retracted",
  ) {
    yield* assertOwner(tuple);
    const row = (yield* rowsFor(tuple))[0];
    const source = row === undefined ? undefined : yield* decodeSource(row.payload_json);
    if (source === undefined) return yield* new ProjectMemoryError({ reason: "stale" });
    if (status === "retracted" && Option.isSome(factPolicy) && factPolicy.value.forget)
      yield* factPolicy.value.forget(tuple);
    const now = DateTime.formatIso(yield* DateTime.now);
    const payload = yield* encode({
      ...source,
      status,
      revision: source.revision + 1,
      tombstonedAt: now,
      updatedAt: now,
    });
    yield* sql`UPDATE t3_workflow_v2_memory_sources SET status=${status},payload_json=${payload} WHERE environment_id=${tuple.environmentId} AND owner_kind=${tuple.owner.kind} AND owner_id=${ownerId(tuple.owner)} AND source_id=${tuple.sourceId} AND source_revision=${tuple.sourceRevision} AND generation=${tuple.generation}`;
    yield* enqueueCleanup(tuple, `source:${memoryHash(yield* encode(tuple))}`);
    if (status === "retracted")
      yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_forgotten(environment_id,owner_kind,owner_id,source_id,content_hash,payload_json) VALUES (${tuple.environmentId},${tuple.owner.kind},${ownerId(tuple.owner)},${tuple.sourceId},${tuple.contentHash},${yield* encode({ source, tuple })})`;
  });
  const capture = Effect.fn("ProjectMemory.capture")(function* (input: CaptureInput) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertOwner(input);
        if (input.owner.kind !== "project")
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        const state = yield* readCurrentState(sql, input.owner.projectId);
        const source = yield* Effect.try({
          try: () => captureWorkSource(state, input.reference, input.selection, input.now),
          catch: unavailable,
        });
        if (
          source.ownerRevision !== input.ownerRevision ||
          ownerId(source.owner) !== ownerId(input.owner)
        )
          return yield* new ProjectMemoryError({ reason: "stale" });
        const forgotten =
          yield* sql`SELECT 1 FROM t3_workflow_v2_memory_forgotten WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)} AND (source_id=${source.sourceId} OR content_hash=${source.contentHash}) LIMIT 1`;
        if (forgotten.length) return yield* new ProjectMemoryError({ reason: "forgotten" });
        const existing = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)} AND source_id=${source.sourceId} AND status='current'`;
        if (existing.length) {
          const prior = yield* decodeSource(existing[0]!.payload_json);
          if (
            prior.contentHash === source.contentHash &&
            prior.sourceRevision === source.sourceRevision &&
            prior.generation === source.generation
          )
            return prior;
          return yield* new ProjectMemoryError({ reason: "stale" });
        }
        yield* sql`INSERT INTO t3_workflow_v2_memory_sources(environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,status,work_kind,work_id,work_revision,task_id,payload_json) VALUES (${input.environmentId},${input.owner.kind},${ownerId(input.owner)},${input.ownerRevision},${source.sourceId},${source.sourceRevision},${source.generation},${source.contentHash},'current',${input.reference.kind},${input.reference.retainedId},${input.reference.retainedRevision},${input.reference.taskId},${yield* encode(source)})`;
        return source;
      }),
    );
  }, Effect.mapError(unavailable));
  const list = Effect.fn("ProjectMemory.list")(function* (input: MemoryListInput, query = "") {
    yield* assertOwner(input);
    const limit = Math.max(1, Math.min(100, input.limit));
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)} AND owner_revision=${input.ownerRevision} AND status='current' AND source_id > ${input.cursor ?? ""} AND instr(lower(json_extract(payload_json,'$.content')),lower(${query.slice(0, 8192)})) > 0 ORDER BY source_id LIMIT 101`;
    const result: ProjectMemorySource[] = [];
    let scanned = 0;
    let lastScanned = input.cursor ?? "";
    for (const row of rows.slice(0, 100)) {
      const source = yield* decodeSource(row.payload_json);
      scanned++;
      lastScanned = source.sourceId;
      const checked = yield* current(sourceTuple(input, source)).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (
        checked !== undefined &&
        (Option.isNone(factPolicy) ||
          !factPolicy.value.allowRecall ||
          (yield* factPolicy.value.allowRecall(sourceTuple(input, checked))))
      )
        result.push(checked);
      if (result.length === limit) break;
    }
    return {
      items: result,
      nextCursor: scanned < rows.length ? lastScanned : null,
    } satisfies MemoryPage;
  }, Effect.mapError(unavailable));
  const grant = Effect.fn("ProjectMemory.grant")(function* (input: MemoryGrantInput) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const scope = {
          environmentId: input.environmentId,
          owner: input.source.owner,
          ownerRevision: input.ownerRevision,
        };
        yield* assertOwner(scope);
        yield* assertOwner({
          environmentId: input.environmentId,
          owner: input.recipient,
          ownerRevision: input.recipientRevision,
        });
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${input.environmentId} AND owner_kind=${input.source.owner.kind} AND owner_id=${ownerId(input.source.owner)} AND source_id=${input.source.sourceId} AND source_revision=${input.source.sourceRevision} AND status='current'`;
        if (rows.length !== 1) return yield* new ProjectMemoryError({ reason: "stale" });
        const source = yield* decodeSource(rows[0]!.payload_json);
        if ((yield* current(sourceTuple(scope, source))) === undefined)
          return yield* new ProjectMemoryError({ reason: "stale" });
        if (
          input.source.owner.kind === input.recipient.kind &&
          ownerId(input.source.owner) === ownerId(input.recipient)
        )
          return yield* new ProjectMemoryError({ reason: "invalid" });
        const value = yield* decodeNewGrant({
          ...input,
          id: yield* crypto.randomUUIDv4(),
          createdAt: DateTime.formatIso(yield* DateTime.now),
          revokedAt: null,
        });
        yield* sql`INSERT INTO t3_workflow_v2_memory_grants(id,environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,recipient_kind,recipient_id,recipient_revision,revoked_at,payload_json) VALUES (${value.id},${input.environmentId},${input.source.owner.kind},${ownerId(input.source.owner)},${input.ownerRevision},${input.source.sourceId},${input.source.sourceRevision},${input.recipient.kind},${ownerId(input.recipient)},${input.recipientRevision},NULL,${yield* encode(value)})`;
        return value;
      }),
    );
  }, Effect.mapError(unavailable));
  const revoke = Effect.fn("ProjectMemory.revoke")(function* (input: MemoryGrantRevokeInput) {
    yield* assertOwner({
      environmentId: input.environmentId,
      owner: input.source.owner,
      ownerRevision: input.ownerRevision,
    });
    // Revocation must also retire grants whose recipient was deleted or changed revision.
    yield* sql`UPDATE t3_workflow_v2_memory_grants SET revoked_at=${DateTime.formatIso(yield* DateTime.now)} WHERE id=${input.grantId} AND environment_id=${input.environmentId} AND owner_kind=${input.source.owner.kind} AND owner_id=${ownerId(input.source.owner)} AND owner_revision=${input.ownerRevision} AND source_id=${input.source.sourceId} AND source_revision=${input.source.sourceRevision} AND recipient_kind=${input.recipient.kind} AND recipient_id=${ownerId(input.recipient)} AND recipient_revision=${input.recipientRevision}`;
  }, Effect.mapError(unavailable));
  const listGrants = Effect.fn("ProjectMemory.listGrants")(function* (
    input: MemoryGrantListInput & { ownerRevision: number },
  ) {
    yield* assertOwner(input);
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM t3_workflow_v2_memory_grants WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)} AND owner_revision=${input.ownerRevision} AND revoked_at IS NULL AND id > ${input.cursor ?? ""} ORDER BY id LIMIT ${Math.min(100, input.limit)}`;
    return yield* Effect.forEach(rows, (row) => decodeGrant(row.payload_json));
  }, Effect.mapError(unavailable));
  const hydrateCurrentHits = Effect.fn("ProjectMemory.hydrateCurrentHits")(function* (
    input: MemoryScope & { hits: ReadonlyArray<MemorySourceTuple> },
  ) {
    yield* assertOwner(input);
    const result: ProjectMemorySource[] = [];
    for (const hit of input.hits.slice(0, 100)) {
      if (hit.environmentId !== input.environmentId) continue;
      if (hit.owner.kind !== input.owner.kind || ownerId(hit.owner) !== ownerId(input.owner)) {
        const grants =
          yield* sql`SELECT 1 FROM t3_workflow_v2_memory_grants WHERE environment_id=${input.environmentId} AND owner_kind=${hit.owner.kind} AND owner_id=${ownerId(hit.owner)} AND owner_revision=${hit.ownerRevision} AND source_id=${hit.sourceId} AND source_revision=${hit.sourceRevision} AND recipient_kind=${input.owner.kind} AND recipient_id=${ownerId(input.owner)} AND recipient_revision=${input.ownerRevision} AND revoked_at IS NULL LIMIT 1`;
        if (!grants.length) continue;
      }
      const source = yield* current(hit).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (
        source !== undefined &&
        (Option.isNone(factPolicy) ||
          !factPolicy.value.allowRecall ||
          (yield* factPolicy.value.allowRecall(hit)))
      )
        result.push(source);
    }
    return result;
  }, Effect.mapError(unavailable));
  const captureRetained = Effect.fn("ProjectMemory.captureRetained")(function* (
    input: MemoryScope & { source: ProjectMemorySource },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertOwner(input);
        if (input.owner.kind !== "assistant" || Option.isNone(ownerAuthority))
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        const source = yield* decodeRetainedSource(input.source);
        if (
          source.owner.kind !== input.owner.kind ||
          ownerId(source.owner) !== ownerId(input.owner) ||
          source.ownerRevision !== input.ownerRevision ||
          source.status !== "current" ||
          memoryHash(source.content) !== source.contentHash
        )
          return yield* new ProjectMemoryError({ reason: "invalid" });
        yield* ownerAuthority.value.authorizeCapture({ ...input, source });
        const forgotten =
          yield* sql`SELECT 1 FROM t3_workflow_v2_memory_forgotten WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)} AND (source_id=${source.sourceId} OR content_hash=${source.contentHash}) LIMIT 1`;
        if (
          forgotten.length &&
          !(yield* (
            ownerAuthority.value.authorizeForgottenCapture?.({ ...input, source }) ??
              Effect.succeed(false)
          ))
        )
          return yield* new ProjectMemoryError({ reason: "forgotten" });
        const existing = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM t3_workflow_v2_memory_sources WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)} AND source_id=${source.sourceId} AND status='current'`;
        if (existing.length) {
          const prior = yield* decodeSource(existing[0]!.payload_json);
          if (
            prior.sourceRevision === source.sourceRevision &&
            prior.generation === source.generation &&
            prior.contentHash === source.contentHash
          )
            return prior;
          return yield* new ProjectMemoryError({ reason: "stale" });
        }
        yield* sql`INSERT INTO t3_workflow_v2_memory_sources(environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,status,work_kind,work_id,work_revision,task_id,payload_json) VALUES (${input.environmentId},${input.owner.kind},${ownerId(input.owner)},${input.ownerRevision},${source.sourceId},${source.sourceRevision},${source.generation},${source.contentHash},'current','conversation',${source.sourceId},${source.contentRevision},'',${yield* encode(source)})`;
        return source;
      }),
    );
  }, Effect.mapError(unavailable));
  return ProjectMemoryService.of({
    capture,
    captureRetained,
    correct: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (
              input.previous.environmentId !== input.environmentId ||
              input.previous.owner.kind !== input.owner.kind ||
              ownerId(input.previous.owner) !== ownerId(input.owner) ||
              input.previous.ownerRevision !== input.ownerRevision ||
              ("source" in input ? input.source.sourceRevision : input.selection.sourceRevision) <=
                input.previous.sourceRevision ||
              ("source" in input ? input.source.generation : input.selection.sourceGeneration) <=
                input.previous.generation
            )
              return yield* new ProjectMemoryError({ reason: "stale" });
            const priorRow = (yield* rowsFor(input.previous))[0];
            if (priorRow === undefined) return yield* new ProjectMemoryError({ reason: "stale" });
            const prior = yield* decodeSource(priorRow.payload_json);
            yield* invalidate(input.previous, "superseded");
            const corrected = yield* "source" in input ? captureRetained(input) : capture(input);
            const linked = { ...corrected, supersedes: prior.recordId };
            yield* sql`UPDATE t3_workflow_v2_memory_sources SET payload_json=${yield* encode(linked)} WHERE environment_id=${input.environmentId} AND owner_kind=${input.owner.kind} AND owner_id=${ownerId(input.owner)} AND source_id=${linked.sourceId} AND source_revision=${linked.sourceRevision} AND generation=${linked.generation}`;
            return linked;
          }),
        )
        .pipe(Effect.mapError(unavailable)),
    retract: (tuple) =>
      sql.withTransaction(invalidate(tuple, "retracted")).pipe(Effect.mapError(unavailable)),
    readSource: (tuple) => current(tuple).pipe(Effect.mapError(unavailable)),
    applyCurrent,
    listCurrentPage: (input) => list(input),
    recallTextPage: (input) => list(input, input.query),
    listCurrent: (input) => list(input).pipe(Effect.map((page) => page.items)),
    recallText: (input) => list(input, input.query).pipe(Effect.map((page) => page.items)),
    hydrateCurrentHits: (input) =>
      sql.withTransaction(hydrateCurrentHits(input)).pipe(Effect.mapError(unavailable)),
    grant,
    revoke,
    listGrants,
    enqueueCleanup,
    deleteOwner: (scope) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (scope.environmentId !== (yield* environment.getEnvironmentId))
              return yield* new ProjectMemoryError({ reason: "forbidden" });
            const ownerRows = yield* sql<{
              revision: number;
              deleted: number;
            }>`SELECT revision,deleted FROM t3_workflow_v2_memory_owners WHERE environment_id=${scope.environmentId} AND owner_kind=${scope.owner.kind} AND owner_id=${ownerId(scope.owner)}`;
            if (ownerRows[0]?.deleted === 1) return;
            if (scope.owner.kind === "project") {
              if (scope.ownerRevision !== (ownerRows[0]?.revision ?? 0))
                return yield* new ProjectMemoryError({ reason: "stale" });
            } else {
              if (Option.isNone(ownerAuthority))
                return yield* new ProjectMemoryError({ reason: "forbidden" });
              yield* ownerAuthority.value.assertCurrent(scope);
              if (ownerRows[0] !== undefined && ownerRows[0].revision !== scope.ownerRevision)
                return yield* new ProjectMemoryError({ reason: "stale" });
            }
            // One SQL operation retains every historical derived tuple before the owner tombstone.
            yield* sql`INSERT INTO t3_workflow_v2_memory_cleanup(id,environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,status,payload_json)
              SELECT 'owner:' || json_array(environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash),environment_id,owner_kind,owner_id,owner_revision,source_id,source_revision,generation,content_hash,'pending',
                json_object('environmentId',environment_id,'owner',json_object('kind',owner_kind,CASE owner_kind WHEN 'project' THEN 'projectId' ELSE 'assistantId' END,owner_id),'ownerRevision',owner_revision,'sourceId',source_id,'sourceRevision',source_revision,'generation',generation,'contentHash',content_hash)
              FROM t3_workflow_v2_memory_sources WHERE environment_id=${scope.environmentId} AND owner_kind=${scope.owner.kind} AND owner_id=${ownerId(scope.owner)} AND owner_revision=${scope.ownerRevision}
              ON CONFLICT(id) DO UPDATE SET status='pending',payload_json=excluded.payload_json`;
            yield* sql`UPDATE t3_workflow_v2_memory_sources SET status='retracted' WHERE environment_id=${scope.environmentId} AND owner_kind=${scope.owner.kind} AND owner_id=${ownerId(scope.owner)}`;
            yield* sql`INSERT INTO t3_workflow_v2_memory_owners(environment_id,owner_kind,owner_id,revision,deleted) VALUES (${scope.environmentId},${scope.owner.kind},${ownerId(scope.owner)},${scope.ownerRevision + 1},1) ON CONFLICT(environment_id,owner_kind,owner_id) DO UPDATE SET revision=MAX(revision,excluded.revision),deleted=1`;
          }),
        )
        .pipe(Effect.mapError(unavailable)),
  });
});
export const layer = Layer.effect(ProjectMemoryService, make);
