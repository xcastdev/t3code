import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import createEventLog from "../persistence/Migrations/001_OrchestrationEvents.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { assistantRoutineMigration } from "../persistence/AssistantRoutineMigration.ts";
import * as Auth from "../persistence/AuthSessions.ts";
import * as Activity from "./AssistantActivity.ts";
import { AssistantError, AssistantRepository } from "./AssistantRepository.ts";
import { configuration, environmentId, input, repository } from "./AssistantTestHelpers.ts";

const storage = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY,subject TEXT,scopes TEXT,method TEXT,client_label TEXT,client_ip_address TEXT,client_user_agent TEXT,client_device_type TEXT,client_os TEXT,client_browser TEXT,issued_at TEXT,expires_at TEXT,last_connected_at TEXT,revoked_at TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY,thread_id TEXT,status TEXT,requested_at TEXT,completed_at TEXT,payload_json TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT)`;
    yield* createEventLog;
    yield* sql`ALTER TABLE orchestration_events ADD COLUMN application_event_version INTEGER NOT NULL DEFAULT 1`;
    for (const statement of assistantRoutineMigration.statements) yield* sql.unsafe(statement);
  }),
);
const base = Layer.merge(Auth.layer, EventStore.layer).pipe(
  Layer.provideMerge(storage.pipe(Layer.provideMerge(repository))),
);
export const layer = Activity.layer.pipe(
  Layer.provideMerge(base),
  Layer.provide(
    Layer.succeed(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);
export const sessionId = AuthSessionId.make("reader");
export const setup = Effect.fn("AssistantActivityTest.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* AssistantRepository;
  const auth = yield* Auth.AuthSessionRepository;
  const scope = (yield* repo.create(input)).detail.summary;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${scope.binding.canonicalThreadId},${scope.binding.backingProjectId})`;
  yield* auth.create({
    sessionId,
    subject: "human",
    scopes: [AuthOrchestrationReadScope],
    method: "browser-session-cookie",
    issuedAt: yield* DateTime.now,
    expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
  });
  const events = yield* EventStore.EventStoreV2;
  return {
    sql,
    repo,
    auth,
    scope,
    activity: yield* Activity.AssistantActivity,
    seed: (...args: Parameters<typeof seedRun>) =>
      seedRun(...args).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(EventStore.EventStoreV2, events),
        Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
      ),
  };
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
export const seedRun = Effect.fn("AssistantActivityTest.seedRun")(function* (
  scope: { assistantId: string; binding: { canonicalThreadId: string } },
  id: string,
  status: string,
  createdAt = "2026-10-21T10:00:00.000Z",
) {
  const sql = yield* SqlClient.SqlClient;
  const threadId = scope.binding.canonicalThreadId;
  yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions VALUES(${threadId},${id},${scope.assistantId},7,'{}',${createdAt})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES(${id},${threadId},${status},${createdAt},NULL,${encodeJson({ userMessageId: `message-${id}`, activeAttemptId: `attempt-${id}` })})`;
  const events = yield* EventStore.EventStoreV2;
  const at = DateTime.makeUnsafe(createdAt);
  yield* events.append({
    commandId: CommandId.make(`command-${id}`),
    events: [
      decodeEvent({
        id: `event-${id}`,
        type: "run.created",
        threadId,
        runId: id,
        occurredAt: at,
        payload: {
          id,
          threadId,
          ordinal: 1,
          providerInstanceId: "codex",
          modelSelection: configuration.modelSelection,
          providerThreadId: null,
          userMessageId: `message-${id}`,
          rootNodeId: null,
          activeAttemptId: `attempt-${id}`,
          status,
          requestedAt: at,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      }),
    ],
  });
});
