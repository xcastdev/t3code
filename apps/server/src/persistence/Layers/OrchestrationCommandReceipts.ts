import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  GetByCommandIdInput,
  OrchestrationCommandReceipt,
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceiptRepositoryShape,
} from "../Services/OrchestrationCommandReceipts.ts";

const OrchestrationCommandReceiptDbRow = Schema.Struct({
  commandId: OrchestrationCommandReceipt.fields.commandId,
  aggregateKind: OrchestrationCommandReceipt.fields.aggregateKind,
  aggregateId: OrchestrationCommandReceipt.fields.aggregateId,
  acceptedAt: OrchestrationCommandReceipt.fields.acceptedAt,
  resultSequence: OrchestrationCommandReceipt.fields.resultSequence,
  status: OrchestrationCommandReceipt.fields.status,
  error: OrchestrationCommandReceipt.fields.error,
  fingerprint: Schema.NullOr(Schema.String),
  actorKind: Schema.NullOr(Schema.String),
  actorId: Schema.NullOr(Schema.String),
  sourceKind: Schema.NullOr(Schema.String),
  sourceId: Schema.NullOr(Schema.String),
  resultJson: Schema.NullOr(Schema.String),
});
type OrchestrationCommandReceiptDbRow = typeof OrchestrationCommandReceiptDbRow.Type;

const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const toReceiptFields = (row: OrchestrationCommandReceiptDbRow) => ({
  commandId: row.commandId,
  aggregateKind: row.aggregateKind,
  aggregateId: row.aggregateId,
  acceptedAt: row.acceptedAt,
  resultSequence: row.resultSequence,
  status: row.status,
  error: row.error,
  ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
  ...(row.actorKind === null ? {} : { actorKind: row.actorKind }),
  ...(row.actorId === null ? {} : { actorId: row.actorId }),
  ...(row.sourceKind === null ? {} : { sourceKind: row.sourceKind }),
  ...(row.sourceId === null ? {} : { sourceId: row.sourceId }),
});

const toReceipt = (
  row: OrchestrationCommandReceiptDbRow,
): Effect.Effect<OrchestrationCommandReceipt, Schema.SchemaError> =>
  Option.match(Option.fromNullishOr(row.resultJson), {
    onNone: () => Effect.succeed(toReceiptFields(row)),
    onSome: (resultJson) =>
      decodeResult(resultJson).pipe(Effect.map((result) => ({ ...toReceiptFields(row), result }))),
  });

const makeOrchestrationCommandReceiptRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertReceiptRow = SqlSchema.void({
    Request: OrchestrationCommandReceipt,
    execute: (receipt) =>
      sql`
        INSERT INTO orchestration_command_receipts (
          command_id,
          aggregate_kind,
          aggregate_id,
          accepted_at,
          result_sequence,
          status,
          error,
          fingerprint,
          actor_kind,
          actor_id,
          source_kind,
          source_id,
          result_json
        )
        VALUES (
          ${receipt.commandId},
          ${receipt.aggregateKind},
          ${receipt.aggregateId},
          ${receipt.acceptedAt},
          ${receipt.resultSequence},
          ${receipt.status},
          ${receipt.error},
          ${receipt.fingerprint ?? null},
          ${receipt.actorKind ?? null},
          ${receipt.actorId ?? null},
          ${receipt.sourceKind ?? null},
          ${receipt.sourceId ?? null},
          ${receipt.result === undefined ? null : JSON.stringify(receipt.result)}
        )
        ON CONFLICT (command_id)
        DO UPDATE SET
          aggregate_kind = excluded.aggregate_kind,
          aggregate_id = excluded.aggregate_id,
          accepted_at = excluded.accepted_at,
          result_sequence = excluded.result_sequence,
          status = excluded.status,
          error = excluded.error,
          fingerprint = excluded.fingerprint,
          actor_kind = excluded.actor_kind,
          actor_id = excluded.actor_id,
          source_kind = excluded.source_kind,
          source_id = excluded.source_id,
          result_json = excluded.result_json
      `,
  });

  const findReceiptByCommandId = SqlSchema.findOneOption({
    Request: GetByCommandIdInput,
    Result: OrchestrationCommandReceiptDbRow,
    execute: ({ commandId }) =>
      sql`
        SELECT
          command_id AS "commandId",
          aggregate_kind AS "aggregateKind",
          aggregate_id AS "aggregateId",
          accepted_at AS "acceptedAt",
          result_sequence AS "resultSequence",
          status,
          error,
          fingerprint,
          actor_kind AS "actorKind",
          actor_id AS "actorId",
          source_kind AS "sourceKind",
          source_id AS "sourceId",
          result_json AS "resultJson"
        FROM orchestration_command_receipts
        WHERE command_id = ${commandId}
      `,
  });

  const upsert: OrchestrationCommandReceiptRepositoryShape["upsert"] = (receipt) =>
    upsertReceiptRow(receipt).pipe(
      Effect.mapError(toPersistenceSqlError("OrchestrationCommandReceiptRepository.upsert:query")),
    );

  const getByCommandId: OrchestrationCommandReceiptRepositoryShape["getByCommandId"] = (input) =>
    findReceiptByCommandId(input).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toReceipt(row).pipe(Effect.map((receipt) => Option.some(receipt))),
        }),
      ),
      Effect.mapError(
        toPersistenceSqlError("OrchestrationCommandReceiptRepository.getByCommandId:query"),
      ),
    );

  return {
    upsert,
    getByCommandId,
  } satisfies OrchestrationCommandReceiptRepositoryShape;
});

export const OrchestrationCommandReceiptRepositoryLive = Layer.effect(
  OrchestrationCommandReceiptRepository,
  makeOrchestrationCommandReceiptRepository,
);
