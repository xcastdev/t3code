import {
  AssistantRunSummary,
  AuthOrchestrationReadScope,
  type AssistantActivityListInput,
  type AssistantListInput,
  type AssistantListResult,
  type AssistantRunListResult,
  type AuthSessionId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { AssistantError, AssistantRepository } from "./AssistantRepository.ts";

export class AssistantActivity extends Context.Service<
  AssistantActivity,
  {
    readonly list: (
      input: AssistantActivityListInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<AssistantRunListResult, AssistantError>;
    readonly roster: (
      input: AssistantListInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<AssistantListResult, AssistantError>;
  }
>()("t3/assistants/AssistantActivity") {}

const Cursor = Schema.Tuple([Schema.String, Schema.String]);
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));
const decodeRun = Schema.decodeUnknownEffect(AssistantRunSummary);
const isAssistantError = Schema.is(AssistantError);
const unavailable = (cause: unknown) =>
  isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assistants = yield* AssistantRepository;
  const sessions = yield* AuthSessionRepository;
  const environment = yield* ServerEnvironment;
  const authorize = Effect.fn("AssistantActivity.authorize")(function* (
    environmentId: EnvironmentId,
    sessionId: AuthSessionId,
  ) {
    const session = yield* sessions.getById({ sessionId });
    const now = yield* DateTime.now;
    if (
      environmentId !== (yield* environment.getEnvironmentId) ||
      Option.isNone(session) ||
      session.value.revokedAt !== null ||
      session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
      !session.value.scopes.includes(AuthOrchestrationReadScope)
    )
      return yield* new AssistantError({ reason: "forbidden" });
  }, Effect.mapError(unavailable));
  const list = Effect.fn("AssistantActivity.list")(function* (
    input: AssistantActivityListInput,
    sessionId: AuthSessionId,
  ) {
    yield* authorize(input.environmentId, sessionId);
    const owner = yield* assistants.get(input);
    const cursor =
      input.cursor === undefined
        ? null
        : yield* decodeCursor(input.cursor).pipe(
            Effect.mapError(() => new AssistantError({ reason: "conflict" })),
          );
    const limit = Math.min(100, Math.max(1, input.limit));
    const rows = yield* sql<Record<string, unknown> & { createdAt: string; runId: string }>`
      SELECT a.created_at AS createdAt,a.run_id AS runId,a.assistant_id AS assistantId,
        a.configuration_revision AS configurationRevision,
        (SELECT e.command_id FROM orchestration_events e WHERE e.aggregate_kind='thread' AND e.stream_id=a.thread_id AND json_extract(e.metadata_json,'$.runId')=a.run_id AND e.command_id IS NOT NULL ORDER BY e.sequence LIMIT 1) AS commandId,
        json_extract(r.payload_json,'$.userMessageId') AS messageId,
        (SELECT f.task_id FROM t3_workflow_v2_assistant_routine_fires f WHERE f.message_id=json_extract(r.payload_json,'$.userMessageId') AND f.environment_id=${input.environmentId} AND f.assistant_id=a.assistant_id) AS scheduledTaskId,
        json_extract(r.payload_json,'$.activeAttemptId') AS runAttemptId,
        CASE WHEN r.status IN ('preparing','starting') THEN 'queued' WHEN r.status='rolled_back' THEN 'interrupted' ELSE r.status END AS status,
        COALESCE(r.completed_at,r.requested_at,a.created_at) AS updatedAt
      FROM t3_workflow_v2_assistant_admissions a
      JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id AND r.thread_id=a.thread_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id=a.thread_id AND t.project_id=${owner.detail.summary.binding.backingProjectId}
      WHERE a.assistant_id=${input.assistantId}
        AND a.created_at<=${cursor?.[0] ?? "\uffff"}
        AND (a.created_at<${cursor?.[0] ?? "\uffff"} OR a.run_id<${cursor?.[1] ?? "\uffff"})
      ORDER BY a.created_at DESC,a.run_id DESC LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const runs = yield* Effect.forEach(page, (row) => decodeRun({ ...row, phase: "execution" }));
    // Recheck after storage reads so a replaced or revoked session cannot receive a page.
    yield* authorize(input.environmentId, sessionId);
    return {
      runs,
      nextCursor:
        rows.length > limit ? encodeCursor([page.at(-1)!.createdAt, page.at(-1)!.runId]) : null,
    };
  }, Effect.mapError(unavailable));
  const roster = Effect.fn("AssistantActivity.roster")(function* (
    input: AssistantListInput,
    sessionId: AuthSessionId,
  ) {
    yield* authorize(input.environmentId, sessionId);
    const records = yield* assistants.list(input);
    const summaries = yield* Effect.forEach(records, (record) =>
      Effect.gen(function* () {
        const summary = record.detail.summary;
        const counts = (yield* sql<{ queued: number; active: number; waiting: number }>`
        SELECT COALESCE(SUM(r.status IN ('queued','preparing','starting')),0) AS queued,
          COALESCE(SUM(r.status='running'),0) AS active,
          COALESCE(SUM(r.status='waiting'),0) AS waiting
        FROM orchestration_v2_projection_runs r INDEXED BY t3_workflow_v2_assistant_run_attention_idx
        CROSS JOIN t3_workflow_v2_assistant_admissions a ON a.thread_id=r.thread_id AND a.run_id=r.run_id
        JOIN orchestration_v2_projection_threads t ON t.thread_id=r.thread_id
        WHERE r.status IN ('queued','preparing','starting','running','waiting')
          AND a.assistant_id=${summary.assistantId} AND t.project_id=${summary.binding.backingProjectId}`)[0]!;
        return {
          ...summary,
          attention: {
            ...summary.attention,
            queuedRuns: counts.queued,
            activeRuns: counts.active,
            waitingRuns: counts.waiting,
          },
        };
      }),
    );
    yield* authorize(input.environmentId, sessionId);
    return {
      assistants: summaries,
      nextCursor:
        records.length === input.limit ? records.at(-1)!.detail.summary.assistantId : null,
    };
  }, Effect.mapError(unavailable));
  return AssistantActivity.of({ list, roster });
});
export const layer = Layer.effect(AssistantActivity, make);
