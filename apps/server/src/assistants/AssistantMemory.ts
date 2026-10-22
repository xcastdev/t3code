import {
  AssistantId,
  EnvironmentId,
  MessageId,
  RunId,
  RunAttemptId,
  ThreadId,
  ModelSelection,
  IsoDateTime,
  NonNegativeInt,
  ProjectMemorySource,
  ProjectId,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import {
  ProjectMemoryFactPolicy,
  normalizedMemoryFactKey,
} from "../projectWork/memory/ProjectMemoryFactPolicy.ts";
import { readRetainedMemoryFacts } from "../projectWork/memory/ProjectMemoryRetainedFacts.ts";
import { makeAssistantMemoryRecipientMetadata } from "./AssistantMemoryRecipients.ts";
import * as DateTime from "effect/DateTime";
import { MemoryCompanionDestination } from "../projectWork/memory/MemoryBackend.ts";
import { MemoryProcessingDestination } from "../projectWork/memory/MemoryProcessingDestination.ts";
import { ProjectMemoryConfiguration } from "../projectWork/memory/ProjectMemoryConfiguration.ts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantRepository, type AssistantRecord } from "./AssistantRepository.ts";
import { ProjectMemoryService } from "../projectWork/memory/ProjectMemoryService.ts";
import { ProjectMemoryProcessing } from "../projectWork/memory/ProjectMemoryProcessing.ts";
import {
  ProjectMemoryError,
  memoryHash,
  sourceTuple,
  type MemoryScope,
  type MemorySourceTuple,
} from "../projectWork/memory/ProjectMemoryRepository.ts";

export const AssistantMemoryEvidence = Schema.Struct({
  environmentId: EnvironmentId,
  assistantId: AssistantId,
  ownerRevision: NonNegativeInt,
  configurationRevision: NonNegativeInt,
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  runAttemptId: RunAttemptId,
  content: Schema.String.check(Schema.isMaxLength(32_000)),
  settledAt: IsoDateTime,
  modelSelection: ModelSelection,
  cwd: Schema.String,
});
export type AssistantMemoryEvidence = typeof AssistantMemoryEvidence.Type;
export class AssistantMemorySources extends Context.Service<
  AssistantMemorySources,
  {
    readonly verify: (evidence: AssistantMemoryEvidence) => Effect.Effect<void, ProjectMemoryError>;
    readonly discover: (input: {
      readonly after?: string;
      readonly limit: number;
    }) => Effect.Effect<
      {
        readonly items: ReadonlyArray<AssistantMemoryEvidence>;
        readonly nextCursor: string | null;
      },
      ProjectMemoryError
    >;
  }
>()("t3/assistants/AssistantMemory/AssistantMemorySources") {}
const decodeProcessingDestination = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ destination: Schema.optionalKey(MemoryCompanionDestination) }),
  ),
);
const decodeEvidence = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantMemoryEvidence));
const decodeSource = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectMemorySource));
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isMemoryError = Schema.is(ProjectMemoryError);
const decodeNewSource = Schema.decodeUnknownEffect(ProjectMemorySource);
const unavailable = (cause: unknown) =>
  isMemoryError(cause) ? cause : new ProjectMemoryError({ reason: "unavailable", cause });
const scopeFor = (e: AssistantMemoryEvidence): MemoryScope => ({
  environmentId: e.environmentId,
  owner: { kind: "assistant", assistantId: e.assistantId },
  ownerRevision: e.ownerRevision,
});
const assistantMemoryFactKey = normalizedMemoryFactKey;

// This factory deliberately excludes the memory service, so capture authorization has no dependency cycle.
export const makeAssistantMemorySourceAuthority = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sources = yield* AssistantMemorySources;
  const repository = yield* AssistantRepository;
  const authorizeCapture = Effect.fn("AssistantMemory.authorizeCapture")(function* (
    input: MemoryScope & { source: ProjectMemorySource },
  ) {
    if (
      input.owner.kind !== "assistant" ||
      input.source.sourceKind !== "conversation" ||
      input.source.conversationSpans.length !== 1
    )
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const record = yield* repository.get({
      environmentId: input.environmentId,
      assistantId: input.owner.assistantId,
    });
    const span = input.source.conversationSpans[0]!;
    const rows = yield* sql<{
      evidence_json: string;
      source_json: string;
    }>`SELECT evidence_json,source_json FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${input.environmentId} AND assistant_id=${input.owner.assistantId} AND message_id=${span.messageId} AND revision=${span.contentRevision} AND content_hash=${input.source.contentHash}`;
    const row = rows[0];
    if (
      !row ||
      record.ownerRevision !== input.ownerRevision ||
      record.detail.summary.binding.canonicalThreadId !== span.threadId
    )
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const expected = yield* decodeSource(row.source_json);
    if (canonicalProjectWorkPayload(expected) !== canonicalProjectWorkPayload(input.source))
      return yield* new ProjectMemoryError({ reason: "stale" });
    yield* sources.verify(yield* decodeEvidence(row.evidence_json));
  }, Effect.mapError(unavailable));
  return {
    authorizeCapture,
    authorizeForgottenCapture: Effect.fn("AssistantMemory.authorizeForgottenCapture")(function* (
      input: MemoryScope & { source: ProjectMemorySource },
    ) {
      yield* authorizeCapture(input);
      if (input.owner.kind !== "assistant") return false;
      const span = input.source.conversationSpans[0]!;
      const receipt = (yield* sql<{
        reteach: number;
      }>`SELECT reteach FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${input.environmentId} AND assistant_id=${input.owner.assistantId} AND message_id=${span.messageId} AND revision=${span.contentRevision}`)[0];
      const fence = (yield* sql<{
        forgotten_at: string;
      }>`SELECT forgotten_at FROM t3_workflow_v2_assistant_memory_forget_fences WHERE environment_id=${input.environmentId} AND assistant_id=${input.owner.assistantId}`)[0];
      const evidence = yield* decodeEvidence(
        (yield* sql<{
          evidence_json: string;
        }>`SELECT evidence_json FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${input.environmentId} AND assistant_id=${input.owner.assistantId} AND message_id=${span.messageId} AND revision=${span.contentRevision}`)[0]!
          .evidence_json,
      );
      return (
        receipt?.reteach === 1 &&
        (fence === undefined || Date.parse(evidence.settledAt) > Date.parse(fence.forgotten_at))
      );
    }, Effect.mapError(unavailable)),
    sourceIsCurrent: Effect.fn("AssistantMemory.sourceIsCurrent")(
      (input: MemorySourceTuple & { source: ProjectMemorySource }) =>
        authorizeCapture(input).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        ),
    ),
  };
});

export const makeAssistantMemoryContext = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AssistantRepository;
  const memory = yield* ProjectMemoryService;
  const factPolicy = yield* ProjectMemoryFactPolicy;
  const context = Effect.fn("AssistantMemory.context")(function* (record: AssistantRecord) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* repository.get(record.detail.summary);
        if (current.ownerRevision !== record.ownerRevision)
          return yield* new ProjectMemoryError({ reason: "stale" });
        const scope: MemoryScope = {
          environmentId: current.detail.summary.environmentId,
          owner: { kind: "assistant", assistantId: current.detail.summary.assistantId },
          ownerRevision: current.ownerRevision,
        };
        const rows = yield* sql<{
          environment_id: EnvironmentId;
          owner_kind: "assistant" | "project";
          owner_id: string;
          owner_revision: number;
          source_id: string;
          source_revision: number;
          generation: number;
          content_hash: string;
          body: string;
          observation_key: string;
          quote: string;
        }>`SELECT o.* FROM t3_workflow_v2_memory_observations o WHERE o.environment_id=${scope.environmentId} AND o.status='current' AND ((o.owner_kind='assistant' AND o.owner_id=${current.detail.summary.assistantId}) OR EXISTS(SELECT 1 FROM t3_workflow_v2_memory_grants g WHERE g.environment_id=o.environment_id AND g.owner_kind=o.owner_kind AND g.owner_id=o.owner_id AND g.source_id=o.source_id AND g.source_revision=o.source_revision AND g.recipient_kind='assistant' AND g.recipient_id=${current.detail.summary.assistantId} AND g.recipient_revision=${current.ownerRevision} AND g.revoked_at IS NULL)) ORDER BY o.operation_key,o.observation_key LIMIT 100`;
        const parts: string[] = [];
        let budget = 12000;
        for (const row of rows) {
          const owner =
            row.owner_kind === "assistant"
              ? { kind: "assistant" as const, assistantId: AssistantId.make(row.owner_id) }
              : { kind: "project" as const, projectId: ProjectId.make(row.owner_id) };
          const hits = yield* memory.hydrateCurrentHits({
            ...scope,
            hits: [
              {
                environmentId: row.environment_id,
                owner,
                ownerRevision: row.owner_revision,
                sourceId: row.source_id,
                sourceRevision: row.source_revision,
                generation: row.generation,
                contentHash: row.content_hash,
              },
            ],
          });
          if (hits.length === 0) continue;
          const allowed = yield* factPolicy.filter(
            {
              environmentId: row.environment_id,
              owner,
              ownerRevision: row.owner_revision,
              sourceId: row.source_id,
              sourceRevision: row.source_revision,
              generation: row.generation,
              contentHash: row.content_hash,
            },
            [{ key: row.observation_key, body: row.body, quote: row.quote }],
          );
          if (!allowed.length) continue;
          const text = row.body.slice(0, Math.min(2000, budget));
          if (!text) break;
          parts.push(text);
          budget -= text.length;
        }
        const epoch =
          (yield* sql<{
            epoch: number;
          }>`SELECT epoch FROM t3_workflow_v2_assistant_memory_epochs WHERE environment_id=${scope.environmentId} AND assistant_id=${current.detail.summary.assistantId}`)[0]
            ?.epoch ?? 0;
        return { memoryEpoch: epoch, text: parts.join("\n").slice(0, 12000) };
      }),
    );
  }, Effect.mapError(unavailable));
  return context;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AssistantRepository;
  const sources = yield* AssistantMemorySources;
  const memory = yield* ProjectMemoryService;
  const processing = yield* ProjectMemoryProcessing;
  const configuration = yield* ProjectMemoryConfiguration;
  const destinations = yield* Effect.serviceOption(MemoryProcessingDestination);
  const recipientMetadata = yield* makeAssistantMemoryRecipientMetadata;
  const capture = Effect.fn("AssistantMemory.capture")(function* (
    evidence: AssistantMemoryEvidence,
    options?: { readonly reteach?: true; readonly editedContent?: string },
  ) {
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sources.verify(evidence);
        const record = yield* repository.get(evidence);
        if (
          record.ownerRevision !== evidence.ownerRevision ||
          record.detail.summary.binding.canonicalThreadId !== evidence.threadId ||
          (!options?.reteach &&
            options?.editedContent === undefined &&
            !record.detail.configuration.configuration.memory.automaticCapture) ||
          !evidence.content.trim()
        )
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        const content = options?.editedContent ?? evidence.content;
        const contentHash = memoryHash(content);
        const canonicalHash = memoryHash(evidence.content);
        const prior = (yield* sql<{
          revision: number;
          content_hash: string;
          source_json: string;
          reteach: number;
          evidence_json: string;
        }>`SELECT revision,content_hash,source_json,reteach,evidence_json FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${evidence.environmentId} AND assistant_id=${evidence.assistantId} AND message_id=${evidence.messageId} ORDER BY revision DESC LIMIT 1`)[0];
        const sameEvidence =
          prior !== undefined &&
          canonicalProjectWorkPayload(yield* decodeEvidence(prior.evidence_json)) ===
            canonicalProjectWorkPayload(evidence);
        if (
          prior &&
          sameEvidence &&
          (!options?.reteach || prior.reteach === 1) &&
          (options?.editedContent === undefined || prior.content_hash === contentHash)
        ) {
          const source = yield* decodeSource(prior.source_json);
          if (!(yield* memory.readSource(sourceTuple(scopeFor(evidence), source))))
            return yield* new ProjectMemoryError({ reason: "forgotten" });
          return source;
        }
        const revision = (prior?.revision ?? -1) + 1;
        const source = yield* decodeNewSource({
          kind: "memory-source",
          recordId: `assistant-memory:${memoryHash(`${evidence.messageId}:${revision}`)}`,
          owner: scopeFor(evidence).owner,
          ownerRevision: evidence.ownerRevision,
          revision: 0,
          generation: revision,
          updatedAt: evidence.settledAt,
          status: "current",
          sourceKind: "conversation",
          sourceId: `message:${memoryHash(evidence.messageId)}:${revision}`,
          sourceRevision: revision,
          content,
          contentHash,
          contentRevision: revision,
          conversationSpans: [
            {
              threadId: evidence.threadId,
              messageId: evidence.messageId,
              contentHash: canonicalHash,
              contentRevision: revision,
              start: 0,
              end: evidence.content.length,
            },
          ],
          attribution: {
            actor: { kind: "human" },
            source: { kind: "system", id: evidence.runId },
            recordedAt: evidence.settledAt,
          },
        });
        yield* sql`INSERT INTO t3_workflow_v2_assistant_memory_receipts(environment_id,assistant_id,message_id,revision,content_hash,evidence_json,source_json,reteach) VALUES(${evidence.environmentId},${evidence.assistantId},${evidence.messageId},${revision},${contentHash},${yield* encode(evidence)},${yield* encode(source)},${options?.reteach || (options?.editedContent !== undefined && sameEvidence && prior?.reteach === 1) ? 1 : 0})`;
        if (prior) {
          const previous = yield* decodeSource(prior.source_json);
          const live =
            yield* sql`SELECT 1 FROM t3_workflow_v2_memory_sources WHERE environment_id=${evidence.environmentId} AND owner_kind='assistant' AND owner_id=${evidence.assistantId} AND source_id=${previous.sourceId} AND status='current'`;
          if (!live.length) return yield* new ProjectMemoryError({ reason: "forgotten" });
          const corrected = yield* memory.correct({
            ...scopeFor(evidence),
            source,
            previous: sourceTuple(scopeFor(evidence), previous),
          });
          // The authority receipt describes the final source, including its correction lineage.
          yield* sql`UPDATE t3_workflow_v2_assistant_memory_receipts SET source_json=${yield* encode(corrected)} WHERE environment_id=${evidence.environmentId} AND assistant_id=${evidence.assistantId} AND message_id=${evidence.messageId} AND revision=${revision}`;
          return corrected;
        }
        return yield* memory.captureRetained({ ...scopeFor(evidence), source });
      }),
    );
    const configured = yield* configuration.read(scopeFor(evidence));
    const destination = configured.configuration.destination
      ? Option.isSome(destinations)
        ? yield* destinations.value.prepare(scopeFor(evidence), configured.configuration)
        : yield* new ProjectMemoryError({ reason: "unavailable" })
      : undefined;
    const operationKey = yield* processing.enqueueExtraction({
      tuple: sourceTuple(scopeFor(evidence), result),
      cwd: evidence.cwd,
      modelSelection: evidence.modelSelection,
      configurationRevision: configured.revision,
      ...(configured.configuration.extractionRoute
        ? { extractionRoute: configured.configuration.extractionRoute }
        : {}),
      ...(destination ? { destination } : {}),
    });
    return { source: result, operationKey };
  }, Effect.mapError(unavailable));
  const forget = Effect.fn("AssistantMemory.forget")(function* (tuple: MemorySourceTuple) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (tuple.owner.kind !== "assistant")
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        const source = yield* memory.readSource(tuple);
        if (!source) return yield* new ProjectMemoryError({ reason: "stale" });
        yield* memory.retract(tuple);
      }),
    );
  }, Effect.mapError(unavailable));
  const context = yield* makeAssistantMemoryContext;
  const recover = Effect.fn("AssistantMemory.recover")(function* (after?: string) {
    const page = yield* sources.discover({ ...(after === undefined ? {} : { after }), limit: 32 });
    for (const evidence of page.items.slice(0, 32))
      yield* capture(evidence).pipe(
        Effect.catch((error) =>
          error.reason === "forbidden" || error.reason === "stale" || error.reason === "forgotten"
            ? Effect.void
            : Effect.fail(error),
        ),
      );
    return page.nextCursor;
  });
  const edit = Effect.fn("AssistantMemory.edit")(function* (input: {
    previous: MemorySourceTuple;
    content: string;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (
          input.previous.owner.kind !== "assistant" ||
          !input.content.trim() ||
          input.content.length > 32000
        )
          return yield* new ProjectMemoryError({ reason: "invalid" });
        const source = yield* memory.readSource(input.previous);
        if (!source) return yield* new ProjectMemoryError({ reason: "stale" });
        const span = source.conversationSpans[0]!;
        const row = (yield* sql<{
          evidence_json: string;
        }>`SELECT evidence_json FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${input.previous.environmentId} AND assistant_id=${input.previous.owner.assistantId} AND message_id=${span.messageId} AND revision=${span.contentRevision}`)[0];
        if (!row) return yield* new ProjectMemoryError({ reason: "stale" });
        return yield* capture(yield* decodeEvidence(row.evidence_json), {
          editedContent: input.content,
        });
      }),
    );
  }, Effect.mapError(unavailable));
  const confirm = Effect.fn("AssistantMemory.confirm")(function* (tuple: MemorySourceTuple) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (tuple.owner.kind !== "assistant")
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        const source = yield* memory.readSource(tuple);
        if (source === undefined) return yield* new ProjectMemoryError({ reason: "stale" });
        const span = source.conversationSpans[0]!;
        const receipt = (yield* sql<{
          evidence_json: string;
        }>`SELECT evidence_json FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${tuple.environmentId} AND assistant_id=${tuple.owner.assistantId} AND message_id=${span.messageId} AND revision=${span.contentRevision} AND content_hash=${tuple.contentHash}`)[0];
        const fence = (yield* sql<{
          forgotten_at: string;
        }>`SELECT forgotten_at FROM t3_workflow_v2_assistant_memory_forget_fences WHERE environment_id=${tuple.environmentId} AND assistant_id=${tuple.owner.assistantId}`)[0];
        if (receipt === undefined || fence === undefined)
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        const evidence = yield* decodeEvidence(receipt.evidence_json);
        if (Date.parse(evidence.settledAt) <= Date.parse(fence.forgotten_at))
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        return yield* capture(evidence, { reteach: true, editedContent: source.content });
      }),
    );
  }, Effect.mapError(unavailable));
  const confirmations = Effect.fn("AssistantMemory.confirmations")(function* (
    input: MemoryScope & {
      limit: number;
      cursor?: string;
    },
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        if (input.owner.kind !== "assistant")
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        const record = yield* repository.get({
          environmentId: input.environmentId,
          assistantId: input.owner.assistantId,
        });
        if (record.ownerRevision !== input.ownerRevision)
          return yield* new ProjectMemoryError({ reason: "stale" });
        const limit = Math.max(1, Math.min(32, input.limit));
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT s.payload_json FROM t3_workflow_v2_memory_sources s JOIN t3_workflow_v2_assistant_memory_receipts r ON r.environment_id=s.environment_id AND r.assistant_id=s.owner_id AND json_extract(r.source_json,'$.sourceId')=s.source_id AND r.revision=s.source_revision JOIN t3_workflow_v2_assistant_memory_forget_fences f ON f.environment_id=s.environment_id AND f.assistant_id=s.owner_id WHERE s.environment_id=${input.environmentId} AND s.owner_kind='assistant' AND s.owner_id=${input.owner.assistantId} AND s.owner_revision=${input.ownerRevision} AND s.status='current' AND s.source_id>${input.cursor ?? ""} AND r.reteach=0 AND julianday(json_extract(r.evidence_json,'$.settledAt'))>julianday(f.forgotten_at) AND NOT EXISTS(SELECT 1 FROM t3_workflow_v2_memory_observations o WHERE o.environment_id=s.environment_id AND o.owner_kind=s.owner_kind AND o.owner_id=s.owner_id AND o.source_id=s.source_id AND o.source_revision=s.source_revision AND o.generation=s.generation AND o.status='current') ORDER BY s.source_id LIMIT 33`;
        const items: ProjectMemorySource[] = [];
        let scanned = 0;
        let cursor = input.cursor ?? "";
        for (const row of rows.slice(0, 32)) {
          const source = yield* decodeSource(row.payload_json);
          scanned++;
          cursor = source.sourceId;
          const current = yield* memory.readSource(sourceTuple(input, source));
          if (current !== undefined) items.push(current);
          if (items.length === limit) break;
        }
        return { items, nextCursor: scanned < rows.length ? cursor : null };
      }),
    );
  }, Effect.mapError(unavailable));
  const status = Effect.fn("AssistantMemory.status")(function* (scope: MemoryScope) {
    if (scope.owner.kind !== "assistant")
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const record = yield* repository.get({
      environmentId: scope.environmentId,
      assistantId: scope.owner.assistantId,
    });
    if (record.ownerRevision !== scope.ownerRevision)
      return yield* new ProjectMemoryError({ reason: "stale" });
    const rows = yield* sql<{
      status: string;
      count: number;
    }>`SELECT status,count(*) AS count FROM t3_workflow_v2_memory_processing WHERE environment_id=${scope.environmentId} AND owner_kind='assistant' AND owner_id=${scope.owner.assistantId} GROUP BY status LIMIT 16`;
    const unresolved =
      (yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM t3_workflow_v2_memory_forgotten f WHERE f.environment_id=${scope.environmentId} AND f.owner_kind='assistant' AND f.owner_id=${scope.owner.assistantId} AND NOT EXISTS(SELECT 1 FROM t3_workflow_v2_memory_fact_tombstones t WHERE t.environment_id=f.environment_id AND t.owner_kind=f.owner_kind AND t.owner_id=f.owner_id AND t.source_id=f.source_id)`)[0]
        ?.count ?? 0;
    return {
      jobs: rows,
      unresolvedForgottenSources: unresolved,
      requiresUserConfirmation: unresolved > 0,
    };
  }, Effect.mapError(unavailable));
  const process = Effect.fn("AssistantMemory.process")(function* (operationKey: string) {
    yield* processing.run(operationKey);
    const row = (yield* sql<{
      input_json: string;
      status: string;
    }>`SELECT input_json,status FROM t3_workflow_v2_memory_processing WHERE operation_key=${operationKey} AND length(CAST(input_json AS BLOB))<=65536`)[0];
    if (row && row.status === "completed") {
      const input = yield* decodeProcessingDestination(row.input_json);
      if (input.destination) yield* processing.index(operationKey, input.destination);
    }
  }, Effect.mapError(unavailable));
  return {
    recipientMetadata,
    confirmations,
    confirm,
    list: memory.listCurrentPage,
    edit,
    status,
    capture,
    forget,
    context,
    recover,
    process,
    grant: memory.grant,
    revoke: memory.revoke,
  };
});
export class AssistantMemory extends Context.Service<
  AssistantMemory,
  Effect.Success<typeof make>
>()("t3/assistants/AssistantMemory") {}
export const layer = Layer.effect(AssistantMemory, make);

export const layerFactPolicy = Layer.effect(
  ProjectMemoryFactPolicy,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const policy = ProjectMemoryFactPolicy.of({
      forget: Effect.fn("AssistantMemory.forgetFacts")(function* (tuple) {
        if (tuple.owner.kind !== "assistant") return;
        const id = tuple.owner.assistantId;
        const facts = yield* sql<{
          observation_key: string;
          body: string;
        }>`SELECT observation_key,body FROM t3_workflow_v2_memory_observations WHERE environment_id=${tuple.environmentId} AND owner_kind='assistant' AND owner_id=${id} AND source_id=${tuple.sourceId} AND source_revision=${tuple.sourceRevision} AND generation=${tuple.generation}`;
        for (const fact of facts)
          yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_fact_tombstones VALUES(${tuple.environmentId},'assistant',${id},${assistantMemoryFactKey(fact.observation_key)},${memoryHash(assistantMemoryFactKey(fact.body))},${tuple.sourceId})`;
        const retainedFacts = yield* readRetainedMemoryFacts(tuple).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        if (retainedFacts !== undefined) {
          for (const fact of retainedFacts)
            yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_fact_tombstones VALUES(${tuple.environmentId},'assistant',${id},${assistantMemoryFactKey(fact.key)},${memoryHash(assistantMemoryFactKey(fact.body))},${tuple.sourceId})`;
          if (retainedFacts.length === 0)
            yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_fact_tombstones VALUES(${tuple.environmentId},'assistant',${id},'__no_facts__','',${tuple.sourceId})`;
        }
        yield* sql`INSERT INTO t3_workflow_v2_assistant_memory_forget_fences VALUES(${tuple.environmentId},${id},${DateTime.formatIso(yield* DateTime.now)}) ON CONFLICT(environment_id,assistant_id) DO UPDATE SET forgotten_at=excluded.forgotten_at`;
      }, Effect.mapError(unavailable)),
      filter: Effect.fn("AssistantMemory.filterFacts")(function* (tuple, facts) {
        if (tuple.owner.kind !== "assistant") return facts;
        const id = tuple.owner.assistantId;
        const forgotten =
          yield* sql`SELECT 1 FROM t3_workflow_v2_memory_forgotten WHERE environment_id=${tuple.environmentId} AND owner_kind='assistant' AND owner_id=${id} AND source_id=${tuple.sourceId} LIMIT 1`;
        if (forgotten.length) {
          if (facts.length === 0)
            yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_fact_tombstones VALUES(${tuple.environmentId},'assistant',${id},'__no_facts__','',${tuple.sourceId})`;
          for (const fact of facts)
            yield* sql`INSERT OR IGNORE INTO t3_workflow_v2_memory_fact_tombstones VALUES(${tuple.environmentId},'assistant',${id},${assistantMemoryFactKey(fact.key)},${memoryHash(assistantMemoryFactKey(fact.body))},${tuple.sourceId})`;
          return [];
        }
        const receipt = yield* sql<{
          evidence_json: string;
        }>`SELECT evidence_json FROM t3_workflow_v2_assistant_memory_receipts WHERE environment_id=${tuple.environmentId} AND assistant_id=${id} AND json_extract(source_json,'$.sourceId')=${tuple.sourceId} AND revision=${tuple.sourceRevision} AND reteach=1 LIMIT 1`;
        const fence = (yield* sql<{
          forgotten_at: string;
        }>`SELECT forgotten_at FROM t3_workflow_v2_assistant_memory_forget_fences WHERE environment_id=${tuple.environmentId} AND assistant_id=${id}`)[0];
        if (
          receipt[0] &&
          (fence === undefined ||
            Date.parse((yield* decodeEvidence(receipt[0].evidence_json)).settledAt) >
              Date.parse(fence.forgotten_at))
        )
          return facts;
        // A forgotten span with no extracted lineage cannot be matched safely without another semantic engine.
        // Keep automatic capture conservative until the user explicitly teaches a new source.
        const unresolved =
          yield* sql`SELECT 1 FROM t3_workflow_v2_memory_forgotten f WHERE f.environment_id=${tuple.environmentId} AND f.owner_kind='assistant' AND f.owner_id=${id} AND NOT EXISTS(SELECT 1 FROM t3_workflow_v2_memory_fact_tombstones t WHERE t.environment_id=f.environment_id AND t.owner_kind=f.owner_kind AND t.owner_id=f.owner_id AND t.source_id=f.source_id) LIMIT 1`;
        if (unresolved.length) return [];
        const accepted: (typeof facts)[number][] = [];
        for (const fact of facts) {
          const blocked =
            yield* sql`SELECT 1 FROM t3_workflow_v2_memory_fact_tombstones WHERE environment_id=${tuple.environmentId} AND owner_kind='assistant' AND owner_id=${id} AND (fact_key=${assistantMemoryFactKey(fact.key)} OR fingerprint=${memoryHash(assistantMemoryFactKey(fact.body))}) LIMIT 1`;
          if (!blocked.length) accepted.push(fact);
        }
        return accepted;
      }, Effect.mapError(unavailable)),
    });
    return ProjectMemoryFactPolicy.of({
      ...policy,
      allowRecall: Effect.fn("AssistantMemory.allowRecall")(function* (tuple) {
        if (tuple.owner.kind !== "assistant") return true;
        const rows = yield* sql<{
          observation_key: string;
          body: string;
          quote: string;
        }>`SELECT observation_key,body,quote FROM t3_workflow_v2_memory_observations WHERE environment_id=${tuple.environmentId} AND owner_kind='assistant' AND owner_id=${tuple.owner.assistantId} AND source_id=${tuple.sourceId} AND source_revision=${tuple.sourceRevision} AND generation=${tuple.generation} AND status='current' LIMIT 33`;
        if (!rows.length || rows.length > 32) return false;
        const facts = rows.map((row) => ({
          key: row.observation_key,
          body: row.body,
          quote: row.quote,
        }));
        return (yield* policy.filter(tuple, facts)).length === facts.length;
      }, Effect.mapError(unavailable)),
    });
  }),
);
