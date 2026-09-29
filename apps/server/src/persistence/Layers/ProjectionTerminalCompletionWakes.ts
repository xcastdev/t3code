import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionTerminalCompletionWake,
  ProjectionTerminalCompletionWakeRepository,
  type ProjectionTerminalCompletionWakeRepositoryShape,
} from "../Services/ProjectionTerminalCompletionWakes.ts";

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordRequest = SqlSchema.void({
    Request: Schema.Struct({
      dedupeKey: ProjectionTerminalCompletionWake.fields.dedupeKey,
      threadId: ProjectionTerminalCompletionWake.fields.threadId,
      projectId: ProjectionTerminalCompletionWake.fields.projectId,
      terminalId: ProjectionTerminalCompletionWake.fields.terminalId,
      generation: ProjectionTerminalCompletionWake.fields.generation,
      serverRunId: ProjectionTerminalCompletionWake.fields.serverRunId,
      label: ProjectionTerminalCompletionWake.fields.label,
      status: ProjectionTerminalCompletionWake.fields.status,
      exitCode: ProjectionTerminalCompletionWake.fields.exitCode,
      exitSignal: ProjectionTerminalCompletionWake.fields.exitSignal,
      createdAt: ProjectionTerminalCompletionWake.fields.createdAt,
    }),
    execute: (wake) => sql`
      INSERT INTO terminal_completion_wakes (
        dedupe_key, thread_id, project_id, terminal_id, generation, server_run_id,
        label, exit_status, exit_code, exit_signal, delivery_status, created_at, updated_at
      ) VALUES (
        ${wake.dedupeKey}, ${wake.threadId}, ${wake.projectId}, ${wake.terminalId},
        ${wake.generation}, ${wake.serverRunId}, ${wake.label}, ${wake.status},
        ${wake.exitCode}, ${wake.exitSignal}, 'pending', ${wake.createdAt}, ${wake.createdAt}
      ) ON CONFLICT (dedupe_key) DO NOTHING
    `,
  });

  const listPendingByThread = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: ProjectionTerminalCompletionWake.fields.threadId,
      serverRunId: Schema.String,
    }),
    Result: ProjectionTerminalCompletionWake,
    execute: ({ threadId, serverRunId }) => sql`
      SELECT
        dedupe_key AS "dedupeKey",
        thread_id AS "threadId",
        project_id AS "projectId",
        terminal_id AS "terminalId",
        generation,
        server_run_id AS "serverRunId",
        label,
        exit_status AS "status",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        delivery_status AS "deliveryStatus",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM terminal_completion_wakes
      WHERE thread_id = ${threadId}
        AND server_run_id = ${serverRunId}
        AND delivery_status = 'pending'
      ORDER BY created_at, dedupe_key
      LIMIT 8
    `,
  });

  const listPendingByServerRun = SqlSchema.findAll({
    Request: Schema.Struct({ serverRunId: Schema.String }),
    Result: ProjectionTerminalCompletionWake,
    execute: ({ serverRunId }) => sql`
      SELECT
        dedupe_key AS "dedupeKey",
        thread_id AS "threadId",
        project_id AS "projectId",
        terminal_id AS "terminalId",
        generation,
        server_run_id AS "serverRunId",
        label,
        exit_status AS "status",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        delivery_status AS "deliveryStatus",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM terminal_completion_wakes
      WHERE server_run_id = ${serverRunId}
        AND delivery_status = 'pending'
      ORDER BY created_at, dedupe_key
      LIMIT 512
    `,
  });

  const listUnknown = SqlSchema.findAll({
    Request: Schema.Struct({
      limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
    }),
    Result: ProjectionTerminalCompletionWake,
    execute: ({ limit }) => sql`
      SELECT
        dedupe_key AS "dedupeKey",
        thread_id AS "threadId",
        project_id AS "projectId",
        terminal_id AS "terminalId",
        generation,
        server_run_id AS "serverRunId",
        label,
        exit_status AS "status",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        delivery_status AS "deliveryStatus",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM terminal_completion_wakes
      WHERE delivery_status = 'unknown'
      ORDER BY updated_at DESC, dedupe_key
      LIMIT ${limit}
    `,
  });

  const claim = SqlSchema.findOneOption({
    Request: Schema.Struct({
      dedupeKey: Schema.String,
      serverRunId: Schema.String,
      updatedAt: ProjectionTerminalCompletionWake.fields.updatedAt,
    }),
    Result: ProjectionTerminalCompletionWake,
    execute: ({ dedupeKey, serverRunId, updatedAt }) => sql`
      UPDATE terminal_completion_wakes
      SET delivery_status = 'claimed', updated_at = ${updatedAt}
      WHERE dedupe_key = ${dedupeKey}
        AND server_run_id = ${serverRunId}
        AND delivery_status = 'pending'
      RETURNING
        dedupe_key AS "dedupeKey",
        thread_id AS "threadId",
        project_id AS "projectId",
        terminal_id AS "terminalId",
        generation,
        server_run_id AS "serverRunId",
        label,
        exit_status AS "status",
        exit_code AS "exitCode",
        exit_signal AS "exitSignal",
        delivery_status AS "deliveryStatus",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  });

  const setStatus = SqlSchema.void({
    Request: Schema.Struct({
      dedupeKey: Schema.String,
      status: ProjectionTerminalCompletionWake.fields.deliveryStatus,
      updatedAt: ProjectionTerminalCompletionWake.fields.updatedAt,
    }),
    execute: ({ dedupeKey, status, updatedAt }) => sql`
      UPDATE terminal_completion_wakes
      SET delivery_status = ${status}, updated_at = ${updatedAt}
      WHERE dedupe_key = ${dedupeKey}
        AND delivery_status IN ('pending', 'claimed')
    `,
  });

  const cancelOtherServerRuns = SqlSchema.void({
    Request: Schema.Struct({
      serverRunId: Schema.String,
      updatedAt: ProjectionTerminalCompletionWake.fields.updatedAt,
    }),
    execute: ({ serverRunId, updatedAt }) => sql`
      UPDATE terminal_completion_wakes
      SET delivery_status = CASE
        WHEN delivery_status = 'claimed' THEN 'unknown'
        ELSE 'canceled'
      END, updated_at = ${updatedAt}
      WHERE server_run_id <> ${serverRunId}
        AND delivery_status IN ('pending', 'claimed')
    `,
  });

  const cancelThread = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ProjectionTerminalCompletionWake.fields.threadId,
      updatedAt: ProjectionTerminalCompletionWake.fields.updatedAt,
    }),
    execute: ({ threadId, updatedAt }) => sql`
      UPDATE terminal_completion_wakes
      SET delivery_status = 'canceled', updated_at = ${updatedAt}
      WHERE thread_id = ${threadId}
        AND delivery_status = 'pending'
    `,
  });

  const mapError = (operation: string) =>
    Effect.mapError(
      toPersistenceSqlError(`ProjectionTerminalCompletionWakeRepository.${operation}`),
    );

  return {
    recordRequest: (wake) => recordRequest(wake).pipe(mapError("recordRequest")),
    listPendingByThread: (input) =>
      listPendingByThread(input).pipe(mapError("listPendingByThread")),
    listPendingByServerRun: (input) =>
      listPendingByServerRun(input).pipe(mapError("listPendingByServerRun")),
    listUnknown: (input) => listUnknown(input).pipe(mapError("listUnknown")),
    claim: (input) =>
      claim(input).pipe(
        mapError("claim"),
        Effect.map((row) => (row._tag === "Some" ? row.value : null)),
      ),
    setStatus: (input) => setStatus(input).pipe(mapError("setStatus")),
    cancelOtherServerRuns: (input) =>
      cancelOtherServerRuns(input).pipe(mapError("cancelOtherServerRuns")),
    cancelThread: (input) => cancelThread(input).pipe(mapError("cancelThread")),
  } satisfies ProjectionTerminalCompletionWakeRepositoryShape;
});

export const ProjectionTerminalCompletionWakeRepositoryLive = Layer.effect(
  ProjectionTerminalCompletionWakeRepository,
  makeRepository,
);
