import * as NodeCrypto from "node:crypto";
import {
  canonicalProjectWorkPayload,
  EnvironmentId,
  ProjectTeamGate,
  ProjectWorkCommand,
  ProjectWorkPublicationRequest,
  ProjectWorkPublicationOutcome,
  ProjectWorkEvidence,
  ProjectWorkWriteResult,
  PullRequestActionInput,
  ProjectWorkEventType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { projectWorkCommandFingerprint } from "./ProjectWorkPolicy.ts";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
  emptyProjectWorkReducerState,
} from "./ProjectWorkDecider.ts";

const Text = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(4096),
);
const Oid = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Safe = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
export const ManagedMergeConfirmation = Schema.Struct({
  kind: Schema.Literal("merged"),
  host: Text,
  repository: Text,
  number: Safe,
  authorizedHeadSha: Oid,
  baseRef: Text,
  mergeCommitSha: Oid,
  mergedAt: Text,
  mergedBy: Text,
  observedAt: Text,
});
export type ManagedMergeConfirmation = typeof ManagedMergeConfirmation.Type;
const GateApproval = Schema.Struct({
  commandId: Text,
  eventId: Text,
  payloadFingerprint: Text,
  revision: Safe,
});
const Attention = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Text,
  decisionSha256: Text,
  reason: Schema.Literals(["write-unconfirmed", "reconciled"]),
  observedAt: Text,
  state: Schema.optionalKey(Text),
  headSha: Schema.optionalKey(Oid),
  baseRef: Schema.optionalKey(Text),
});
export type ManagedMergeAttention = typeof Attention.Type;
export const ManagedMergeDecision = Schema.Struct({
  version: Schema.Literal(1),
  environmentId: EnvironmentId,
  operationId: Text,
  input: PullRequestActionInput,
  publication: ProjectWorkPublicationRequest,
  publicationOutcome: ProjectWorkPublicationOutcome,
  gate: ProjectTeamGate,
  gateApproval: Schema.optionalKey(GateApproval),
  commands: Schema.Array(ProjectWorkCommand).check(Schema.isMinLength(1), Schema.isMaxLength(2)),
});
export type ManagedMergeDecision = typeof ManagedMergeDecision.Type;
export const ManagedMergeReceipt = Schema.Struct({
  version: Schema.Literal(1),
  operationId: Text,
  decisionSha256: Text,
  claimGeneration: Safe,
  confirmation: ManagedMergeConfirmation,
  evidence: ProjectWorkEvidence,
  command: ProjectWorkCommand,
});
export type ManagedMergeReceipt = typeof ManagedMergeReceipt.Type;
export class ManagedMergeError extends Schema.TaggedError<ManagedMergeError>()(
  "ManagedMergeError",
  {
    reason: Schema.Literals([
      "authorization-denied",
      "history-unavailable",
      "uncertain",
      "persistence",
      "invalid-input",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
export const mergeHash = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalProjectWorkPayload(value)).digest("hex");
const strict = { onExcessProperty: "error" } as const;
const Options = Schema.Struct({ environmentId: EnvironmentId });
const decodeOptions = Schema.decodeUnknownSync(Options, strict);
const decodeDecision = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagedMergeDecision),
  strict,
);
const decodeAttention = Schema.decodeUnknownEffect(Schema.fromJsonString(Attention), strict);
const decodeAttentionValue = Schema.decodeUnknownEffect(Attention, strict);
const decodeEventJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.JsonObject),
  strict,
);
const decodeApproval = Schema.decodeUnknownEffect(GateApproval, strict);
const isEventType = Schema.is(ProjectWorkEventType);
const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ManagedMergeReceipt),
  strict,
);
const decodeWrite = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProjectWorkWriteResult),
  strict,
);
const decodeIds = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Text).check(Schema.isMaxLength(512))),
  strict,
);

const deny = () => new ManagedMergeError({ reason: "history-unavailable" });
export interface MergeRow {
  readonly decision: ManagedMergeDecision;
  readonly status: "pending" | "claimed" | "confirmed" | "uncertain";
  readonly claimGeneration: number;
  readonly receipt?: ManagedMergeReceipt;
  readonly attention?: ManagedMergeAttention;
}

/** Historical audits never borrow a live session or turn a remote observation into approval. */
export const makeProjectWorkManagedMergeJournal = (options: { readonly environmentId: string }) => {
  let captured: typeof Options.Type | undefined;
  try {
    captured = decodeOptions(structuredClone(options));
  } catch {}
  return Effect.gen(function* () {
    if (!captured) return yield* new ManagedMergeError({ reason: "invalid-input" });
    const environmentId = captured.environmentId;
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* ProjectWorkRepository;
    const loan = Effect.gen(function* () {
      const client = yield* Effect.serviceOption(SqlClient.SqlClient);
      const owner = yield* Effect.serviceOption(ProjectWorkRepository);
      if (
        Option.isNone(client) ||
        client.value !== sql ||
        Option.isNone(owner) ||
        owner.value !== repository ||
        Option.isNone(yield* Effect.serviceOption(sql.transactionService))
      )
        return yield* deny();
    });
    const auditCommand = Effect.fn("ManagedMergeJournal.auditCommand")(function* (
      command: ProjectWorkCommand,
    ) {
      if (
        command.type !== "project-work.foundation.commit" &&
        command.type !== "project-work.evidence.add"
      )
        return yield* deny();
      const expectedRevision = command.expectedRevision;
      if (
        expectedRevision === undefined ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      )
        return yield* deny();
      const receiptRows =
        yield* sql`SELECT actor_kind,actor_id,source_kind,source_id,payload_fingerprint,created_at, CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result, CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json END AS ids FROM project_work_command_receipts WHERE project_id=${command.projectId} AND command_id=${command.commandId} LIMIT 2`;
      const row = receiptRows[0];
      if (
        receiptRows.length !== 1 ||
        !row ||
        typeof row.result !== "string" ||
        typeof row.ids !== "string" ||
        row.payload_fingerprint !== projectWorkCommandFingerprint(command) ||
        row.actor_kind !== command.attribution?.actor.kind ||
        row.actor_id !== command.attribution?.actor.id ||
        row.source_kind !== command.attribution?.source.kind ||
        row.source_id !== command.attribution?.source.id
      )
        return yield* deny();
      const result = yield* decodeWrite(row.result);
      const ids = yield* decodeIds(row.ids);
      const events =
        yield* sql`SELECT event_id,event_type,command_id,CASE WHEN length(CAST(payload_json AS BLOB))<=524288 THEN payload_json END AS payload FROM project_work_events WHERE project_id=${command.projectId} AND command_id=${command.commandId} ORDER BY sequence LIMIT 513`;
      if (
        ids.length < 1 ||
        ids.length > 512 ||
        events.length !== ids.length ||
        result.receipt.status !== "accepted" ||
        result.receipt.commandId !== command.commandId ||
        result.receipt.projectId !== command.projectId ||
        result.projectId !== command.projectId ||
        result.receipt.eventCount !== ids.length ||
        result.receipt.revision !== result.revision ||
        result.delta.projectId !== command.projectId ||
        result.delta.revision !== result.revision ||
        canonicalProjectWorkPayload(result.delta.eventIds) !==
          canonicalProjectWorkPayload(ids.slice(0, 64))
      )
        return yield* deny();
      const history = yield* repository.replay(command.projectId);
      const before = applyProjectWorkEvents(
        emptyProjectWorkReducerState(command.projectId),
        history.filter((event) => event.revision <= expectedRevision),
      );
      const expected = yield* Effect.try({
        try: () => decideProjectWorkCommand(before, command),
        catch: (cause) => new ManagedMergeError({ reason: "history-unavailable", cause }),
      });
      if (expected.length !== events.length) return yield* deny();
      for (const [index, event] of expected.entries()) {
        const retained = events[index];
        if (
          !retained ||
          event.eventId !== ids[index] ||
          retained.event_id !== event.eventId ||
          retained.event_type !== event.type ||
          retained.command_id !== command.commandId ||
          typeof retained.payload !== "string" ||
          canonicalProjectWorkPayload(yield* decodeEventJson(retained.payload)) !==
            canonicalProjectWorkPayload(event)
        )
          return yield* deny();
      }
      if (
        expected.at(-1)?.revision !== result.revision ||
        row.created_at !== expected.at(-1)?.occurredAt
      )
        return yield* deny();
    });
    const gateApprovalInTransaction = Effect.fn("ManagedMergeJournal.gateApproval")(function* (
      gate: typeof ProjectTeamGate.Type,
    ) {
      yield* loan;
      const rows =
        yield* sql`SELECT event_id,command_id,json_extract(payload_json,'$.revision') AS revision,CASE WHEN length(CAST(payload_json AS BLOB))<=524288 THEN payload_json END AS payload FROM project_work_events WHERE project_id=${gate.projectId} AND event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.recordId')=${gate.recordId} AND json_extract(payload_json,'$.record.revision')=${gate.revision} ORDER BY sequence LIMIT 2`;
      const row = rows[0];
      if (rows.length !== 1 || !row || typeof row.payload !== "string") return yield* deny();
      const event = yield* decodeEventJson(row.payload);
      if (
        canonicalProjectWorkPayload(event.record) !== canonicalProjectWorkPayload(gate) ||
        event.eventId !== row.event_id ||
        event.revision !== row.revision ||
        event.projectId !== gate.projectId
      )
        return yield* deny();
      const receipts =
        yield* sql`SELECT actor_kind,actor_id,source_kind,source_id,payload_fingerprint,created_at,CASE WHEN length(CAST(result_json AS BLOB))<=262144 THEN result_json END AS result,CASE WHEN length(CAST(event_ids_json AS BLOB))<=1048576 THEN event_ids_json END AS ids FROM project_work_command_receipts WHERE project_id=${gate.projectId} AND command_id=${row.command_id} LIMIT 2`;
      const receipt = receipts[0];
      if (
        receipts.length !== 1 ||
        !receipt ||
        typeof receipt.result !== "string" ||
        typeof receipt.ids !== "string" ||
        typeof receipt.payload_fingerprint !== "string" ||
        !(
          /^[a-f0-9]{8}$/u.test(receipt.payload_fingerprint) ||
          /^project-team-intent:[a-f0-9]{64}$/u.test(receipt.payload_fingerprint)
        ) ||
        receipt.actor_kind !== "human" ||
        receipt.actor_id !== gate.attribution.actor.id ||
        receipt.source_kind !== gate.attribution.source.kind ||
        receipt.source_id !== gate.attribution.source.id
      )
        return yield* deny();
      const result = yield* decodeWrite(receipt.result);
      const ids = yield* decodeIds(receipt.ids);
      const events =
        yield* sql`SELECT event_id,event_type,CASE WHEN length(CAST(payload_json AS BLOB))<=524288 THEN payload_json END AS payload FROM project_work_events WHERE project_id=${gate.projectId} AND command_id=${row.command_id} ORDER BY sequence LIMIT 513`;
      if (
        events.length < 1 ||
        events.length > 512 ||
        events.length !== ids.length ||
        result.projectId !== gate.projectId ||
        result.receipt.projectId !== gate.projectId ||
        result.receipt.commandId !== row.command_id ||
        result.receipt.status !== "accepted" ||
        result.receipt.eventCount !== events.length ||
        result.receipt.revision !== result.revision ||
        result.delta.projectId !== gate.projectId ||
        result.delta.revision !== result.revision ||
        canonicalProjectWorkPayload(result.delta.eventIds) !==
          canonicalProjectWorkPayload(ids.slice(0, 64)) ||
        !ids.includes(String(row.event_id))
      )
        return yield* deny();
      let finalRevision: number | undefined;
      let finalAt: string | undefined;
      for (const [index, stored] of events.entries()) {
        if (typeof stored.payload !== "string") return yield* deny();
        const value = yield* decodeEventJson(stored.payload);
        if (
          value.eventId !== ids[index] ||
          value.eventId !== `${row.command_id}:project-work:${index}` ||
          value.eventId !== stored.event_id ||
          value.type !== stored.event_type ||
          !isEventType(value.type) ||
          value.projectId !== gate.projectId ||
          typeof value.revision !== "number" ||
          !Number.isSafeInteger(value.revision) ||
          typeof value.occurredAt !== "string" ||
          (finalRevision !== undefined && value.revision !== finalRevision + 1)
        )
          return yield* deny();
        finalRevision = value.revision;
        finalAt = value.occurredAt;
      }
      if (finalRevision !== result.revision || finalAt !== receipt.created_at) return yield* deny();
      return yield* decodeApproval({
        commandId: row.command_id,
        eventId: row.event_id,
        payloadFingerprint: receipt.payload_fingerprint,
        revision: row.revision,
      });
    });
    const readInside = Effect.fn("ManagedMergeJournal.readInside")(function* (operationId: string) {
      yield* loan;
      const rows =
        yield* sql`SELECT project_id,task_id,gate_id,gate_revision,gate_sha256,decision_sha256,status,claim_generation,receipt_sha256,CASE WHEN length(CAST(attention_json AS BLOB))<=16384 THEN attention_json END AS attention,CASE WHEN attention_json IS NULL THEN 1 ELSE 0 END AS attention_missing,CASE WHEN receipt_json IS NULL THEN 1 ELSE 0 END AS receipt_missing,CASE WHEN length(CAST(decision_json AS BLOB))<=131072 THEN decision_json END AS decision,CASE WHEN length(CAST(receipt_json AS BLOB))<=32768 THEN receipt_json END AS receipt FROM project_work_managed_merge WHERE environment_id=${environmentId} AND operation_id=${operationId} LIMIT 2`;
      if (!rows.length) return undefined;
      const row = rows[0];
      if (rows.length !== 1 || !row || typeof row.decision !== "string") return yield* deny();
      const decision = yield* decodeDecision(row.decision).pipe(Effect.mapError(() => deny()));
      if (
        canonicalProjectWorkPayload(decision) !== row.decision ||
        mergeHash(decision) !== row.decision_sha256 ||
        decision.environmentId !== environmentId ||
        decision.operationId !== operationId ||
        decision.publication.target.projectId !== row.project_id ||
        decision.publication.target.taskId !== row.task_id ||
        decision.gate.recordId !== row.gate_id ||
        decision.gate.revision !== row.gate_revision ||
        mergeHash(decision.gate) !== row.gate_sha256 ||
        decision.gate.status !== "approved" ||
        decision.gate.gate !== "merge" ||
        decision.gate.attribution.actor.kind !== "human" ||
        !Number.isSafeInteger(row.claim_generation) ||
        typeof row.claim_generation !== "number" ||
        !["pending", "claimed", "confirmed", "uncertain"].includes(String(row.status))
      )
        return yield* deny();
      const publication = decision.publication;
      const published = decision.publicationOutcome;
      const key = mergeHash({
        gateId: decision.gate.recordId,
        gateRevision: decision.gate.revision,
        gateSha256: mergeHash(decision.gate),
      });
      const permission = decision.commands.at(-1);
      if (
        published.kind !== "confirmed" ||
        published.operationId !== publication.operationId ||
        published.requestHash !== mergeHash(publication) ||
        published.marker !== publication.marker ||
        canonicalProjectWorkPayload(published.repository) !==
          canonicalProjectWorkPayload(publication.repository) ||
        published.pullRequest.headSha !== publication.target.headSha ||
        published.pullRequest.baseSha !== publication.target.baseSha ||
        published.pullRequest.headRef !== publication.target.headRef ||
        published.pullRequest.baseRef !== publication.target.baseRef ||
        published.pullRequest.headRepositoryNodeId !== publication.target.headRepositoryNodeId ||
        decision.operationId !== `managed-merge:${key}` ||
        decision.input.action !== "merge" ||
        decision.input.stackNumber !== undefined ||
        decision.input.expectedStackHeads !== undefined ||
        decision.input.projectId !== publication.target.projectId ||
        decision.input.number !== published.pullRequest.number ||
        decision.gate.taskId !== publication.target.taskId ||
        decision.gate.specRevision !== publication.target.specRevision ||
        decision.gate.planRevision !== publication.target.planRevision ||
        decision.gate.repository !==
          `${publication.repository.host}/${publication.repository.nameWithOwner}` ||
        decision.gate.pullRequestNumber !== published.pullRequest.number ||
        decision.gate.headSha !== publication.target.headSha ||
        decision.gate.targetBranch !== publication.target.baseRef ||
        decision.gate.mergeMethod !== (decision.input.mergeMethod ?? "merge") ||
        permission?.type !== "project-work.evidence.add" ||
        permission.commandId !== `managed-merge-permission:${key}` ||
        permission.evidence.evidenceId !== `managed-merge-permission:${key}` ||
        permission.attribution?.actor.kind !== "human" ||
        canonicalProjectWorkPayload(permission.evidence.attribution) !==
          canonicalProjectWorkPayload(permission.attribution) ||
        permission.evidence.detail !==
          canonicalProjectWorkPayload({
            version: 1,
            kind: "project-work.human-merge",
            operationId,
            publicationSha256: mergeHash(publication),
            publicationOutcomeSha256: mergeHash(published),
            gateSha256: mergeHash(decision.gate),
            input: decision.input,
          })
      )
        return yield* deny();
      if (decision.gateApproval !== undefined) {
        const original = yield* gateApprovalInTransaction(decision.gate);
        if (
          canonicalProjectWorkPayload(original) !==
          canonicalProjectWorkPayload(decision.gateApproval)
        )
          return yield* deny();
      } else if (
        !decision.commands.some(
          (command) =>
            command.type === "project-work.foundation.commit" &&
            command.records.some(
              (record) =>
                canonicalProjectWorkPayload(record) === canonicalProjectWorkPayload(decision.gate),
            ),
        )
      )
        return yield* deny();
      let attention: ManagedMergeAttention | undefined;
      if (row.attention_missing !== 1) {
        if (typeof row.attention !== "string") return yield* deny();
        attention = yield* decodeAttention(row.attention);
        if (
          canonicalProjectWorkPayload(attention) !== row.attention ||
          attention.operationId !== operationId ||
          attention.decisionSha256 !== mergeHash(decision)
        )
          return yield* deny();
      }
      for (const command of decision.commands)
        yield* auditCommand(command).pipe(
          Effect.mapError(
            (cause) => new ManagedMergeError({ reason: "history-unavailable", cause }),
          ),
        );
      let receipt: ManagedMergeReceipt | undefined;
      if (row.status === "confirmed") {
        if (typeof row.receipt !== "string") return yield* deny();
        receipt = yield* decodeReceipt(row.receipt).pipe(Effect.mapError(() => deny()));
        if (
          canonicalProjectWorkPayload(receipt) !== row.receipt ||
          mergeHash(receipt) !== row.receipt_sha256 ||
          receipt.operationId !== operationId ||
          receipt.decisionSha256 !== mergeHash(decision) ||
          receipt.claimGeneration !== row.claim_generation ||
          receipt.confirmation.authorizedHeadSha !== decision.publication.target.headSha ||
          receipt.confirmation.baseRef !== decision.publication.target.baseRef ||
          receipt.confirmation.host !== decision.publication.repository.host ||
          receipt.confirmation.repository !== decision.publication.repository.nameWithOwner ||
          decision.publicationOutcome.kind !== "confirmed" ||
          receipt.confirmation.number !== decision.publicationOutcome.pullRequest.number
        )
          return yield* deny();
        yield* auditCommand(receipt.command).pipe(
          Effect.mapError(
            (cause) => new ManagedMergeError({ reason: "history-unavailable", cause }),
          ),
        );
        if (
          receipt.command.type !== "project-work.evidence.add" ||
          canonicalProjectWorkPayload(receipt.command.evidence) !==
            canonicalProjectWorkPayload(receipt.evidence)
        )
          return yield* deny();
      } else if (row.receipt_missing !== 1 || row.receipt_sha256 !== null) return yield* deny();
      if (
        row.status !== "pending" &&
        row.status !== "claimed" &&
        row.status !== "uncertain" &&
        row.status !== "confirmed"
      )
        return yield* deny();
      if (
        (row.status === "pending" && row.claim_generation !== 0) ||
        (row.status !== "pending" && row.claim_generation < 1) ||
        (row.status === "confirmed" && receipt === undefined)
      )
        return yield* deny();
      const result: MergeRow = {
        decision,
        status: row.status,
        claimGeneration: row.claim_generation,
        ...(receipt === undefined ? {} : { receipt }),
        ...(attention === undefined ? {} : { attention }),
      };
      return result;
    });
    const readInTransaction = (operationId: string) => readInside(operationId);
    const insertInTransaction = Effect.fn("ManagedMergeJournal.insert")(function* (
      decision: ManagedMergeDecision,
    ) {
      yield* loan;
      const json = canonicalProjectWorkPayload(decision);
      if (Buffer.byteLength(json) > 131072 || decision.environmentId !== environmentId)
        return yield* deny();
      yield* sql`INSERT INTO project_work_managed_merge(environment_id,operation_id,project_id,task_id,gate_id,gate_revision,gate_sha256,decision_json,decision_sha256,status,claim_generation) VALUES (${environmentId},${decision.operationId},${decision.publication.target.projectId},${decision.publication.target.taskId},${decision.gate.recordId},${decision.gate.revision},${mergeHash(decision.gate)},${json},${mergeHash(decision)},'pending',0)`;
    });
    const claimInTransaction = Effect.fn("ManagedMergeJournal.claim")(function* (
      operationId: string,
    ) {
      const row = yield* readInside(operationId);
      if (!row || row.status !== "pending") return { owned: false, row };
      const changed =
        yield* sql`UPDATE project_work_managed_merge SET status='claimed',claim_generation=1 WHERE environment_id=${environmentId} AND operation_id=${operationId} AND status='pending' AND claim_generation=0 RETURNING operation_id`;
      if (changed.length !== 1) return yield* deny();
      return { owned: true, row: yield* readInside(operationId) };
    });
    const uncertainInTransaction = Effect.fn("ManagedMergeJournal.uncertain")(function* (
      operationId: string,
      generation: number,
    ) {
      yield* loan;
      const changed =
        yield* sql`UPDATE project_work_managed_merge SET status='uncertain' WHERE environment_id=${environmentId} AND operation_id=${operationId} AND status='claimed' AND claim_generation=${generation} RETURNING operation_id`;
      if (changed.length !== 1) return yield* deny();
    });
    const attentionInTransaction = Effect.fn("ManagedMergeJournal.attention")(function* (
      operationId: string,
      generation: number,
      observation: ManagedMergeAttention,
    ) {
      yield* loan;
      observation = yield* decodeAttentionValue(observation).pipe(Effect.mapError(() => deny()));
      const row = yield* readInside(operationId);
      if (
        !row ||
        row.status === "confirmed" ||
        row.claimGeneration !== generation ||
        observation.operationId !== operationId ||
        observation.decisionSha256 !== mergeHash(row.decision)
      )
        return yield* deny();
      if (row.attention !== undefined) return;
      const json = canonicalProjectWorkPayload(observation);
      if (Buffer.byteLength(json) > 16384) return yield* deny();
      const changed =
        yield* sql`UPDATE project_work_managed_merge SET status='uncertain',attention_json=${json} WHERE environment_id=${environmentId} AND operation_id=${operationId} AND status IN ('claimed','uncertain') AND claim_generation=${generation} AND attention_json IS NULL RETURNING operation_id`;
      if (changed.length !== 1) return yield* deny();
    });
    const completeInTransaction = Effect.fn("ManagedMergeJournal.complete")(function* (
      receipt: ManagedMergeReceipt,
    ) {
      yield* loan;
      const json = canonicalProjectWorkPayload(receipt);
      if (Buffer.byteLength(json) > 32768) return yield* deny();
      const changed =
        yield* sql`UPDATE project_work_managed_merge SET status='confirmed',receipt_json=${json},receipt_sha256=${mergeHash(receipt)} WHERE environment_id=${environmentId} AND operation_id=${receipt.operationId} AND status='claimed' AND claim_generation=${receipt.claimGeneration} AND decision_sha256=${receipt.decisionSha256} RETURNING operation_id`;
      if (changed.length !== 1) return yield* deny();
    });
    const pendingInTransaction = Effect.fn("ManagedMergeJournal.pending")(function* (
      afterOperationId?: string,
    ) {
      yield* loan;
      if (afterOperationId !== undefined && !/^managed-merge:[a-f0-9]{64}$/u.test(afterOperationId))
        return yield* deny();
      return yield* sql<{
        operationId: string;
      }>`SELECT operation_id AS operationId FROM project_work_managed_merge WHERE environment_id=${environmentId} AND status IN ('pending','claimed','uncertain') AND ${afterOperationId === undefined ? sql`1=1` : sql`operation_id>${afterOperationId}`} ORDER BY operation_id LIMIT 64`;
    });
    const confirmedUnacceptedInTransaction = Effect.fn("ManagedMergeJournal.confirmedUnaccepted")(
      function* (afterOperationId?: string) {
        yield* loan;
        if (
          afterOperationId !== undefined &&
          !/^managed-merge:[a-f0-9]{64}$/u.test(afterOperationId)
        )
          return yield* deny();
        return yield* sql<{
          operationId: string;
        }>`SELECT m.operation_id AS operationId FROM project_work_managed_merge m
        WHERE m.environment_id=${environmentId} AND m.status='confirmed'
        AND ${afterOperationId === undefined ? sql`1=1` : sql`m.operation_id>${afterOperationId}`}
        AND NOT EXISTS (SELECT 1 FROM project_work_evidence e WHERE e.project_id=m.project_id AND e.task_id=m.task_id
          AND e.evidence_id LIKE 'delivery-acceptance:%' AND json_valid(e.detail)
          AND json_extract(e.detail,'$.proof.operationId')=m.operation_id)
        ORDER BY m.operation_id LIMIT 64`;
      },
    );
    const auditCommandInTransaction = Effect.fn("ManagedMergeJournal.auditRetainedCommand")(
      function* (command: ProjectWorkCommand) {
        yield* loan;
        yield* auditCommand(command);
      },
    );
    return {
      environmentId,
      gateApprovalInTransaction,
      attentionInTransaction,
      readInTransaction,
      insertInTransaction,
      claimInTransaction,
      uncertainInTransaction,
      completeInTransaction,
      pendingInTransaction,
      confirmedUnacceptedInTransaction,
      auditCommandInTransaction,
    };
  });
};
