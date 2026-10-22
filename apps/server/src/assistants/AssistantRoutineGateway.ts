import { AssistantRoutineAuthorization } from "./AssistantRoutineAuthorization.ts";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ScheduledTaskId,
  ScheduledTaskError,
  type AssistantRoutineReadInput,
  type AssistantRoutineReadResult,
  type AssistantRoutineWriteInput,
  type AssistantRoutineWriteResult,
  type AuthSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { AssistantRepository, AssistantError } from "./AssistantRepository.ts";
import { AssistantRoutines } from "./AssistantRoutines.ts";
import { AssistantEventBus } from "./AssistantEventBus.ts";
import { assistantThreadIsCurrent } from "./AssistantThreadAuthority.ts";
const isAssistantError = Schema.is(AssistantError);
const unavailable = (cause: unknown) =>
  isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessionRepository;
  const assistants = yield* AssistantRepository;
  const routines = yield* AssistantRoutines;
  const bus = yield* AssistantEventBus;
  const authorize = Effect.fn("AssistantRoutineGateway.authorize")(function* (
    sessionId: AuthSessionId,
    write: boolean,
  ) {
    const session = yield* sessions.getById({ sessionId });
    const now = yield* DateTime.now;
    if (
      Option.isNone(session) ||
      session.value.revokedAt !== null ||
      session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
      !session.value.scopes.includes(
        write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
      )
    )
      return yield* new AssistantError({ reason: "forbidden" });
  });
  const read = Effect.fn("AssistantRoutineGateway.read")(function* (
    input: AssistantRoutineReadInput,
  ): Effect.fn.Return<AssistantRoutineReadResult, AssistantError> {
    yield* assistants.get(input);
    if (input.operation === "webhook")
      return { operation: "webhook", ...(yield* routines.webhook(input)) };
    if (input.operation === "fires") {
      const fires = yield* routines.fires({
        environmentId: input.environmentId,
        assistantId: input.assistantId,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      });
      return {
        operation: "fires",
        fires,
        nextCursor: fires.length === input.limit ? fires.at(-1)!.fireKey : null,
      };
    }
    const items = yield* routines.list({
      environmentId: input.environmentId,
      assistantId: input.assistantId,
      limit: input.limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });
    return {
      operation: "list",
      routines: items.map(({ binding, task, timeZone }) => ({
        taskId: binding.taskId,
        revision: binding.revision,
        title: task?.title ?? (binding.deleted ? "Deleted routine" : "Routine needs repair"),
        prompt: task?.prompt ?? "",
        enabled: binding.enabled && (task?.enabled ?? false),
        deleted: binding.deleted,
        schedule: task?.schedule ?? null,
        nextRunAt: task?.nextRunAt ?? null,
        timeZone,
        configurationRevision: binding.configurationRevision,
      })),
      nextCursor: items.length === input.limit ? items.at(-1)!.binding.taskId : null,
    };
  });
  const write = Effect.fn("AssistantRoutineGateway.write")(function* (
    input: AssistantRoutineWriteInput,
  ) {
    yield* assistants.get(input);
    let taskId: ScheduledTaskId;
    let threadId: ThreadId | null = null;
    switch (input.operation) {
      case "upsert": {
        const { taskId: selectedTaskId, expectedRevision, ...values } = input;
        taskId = (yield* routines.upsert({
          ...values,
          ...(selectedTaskId === undefined ? {} : { taskId: selectedTaskId }),
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        })).binding.taskId;
        break;
      }
      case "set-enabled":
        yield* routines.setEnabled(input);
        taskId = input.taskId;
        break;
      case "delete":
        yield* routines.delete(input);
        taskId = input.taskId;
        break;
      case "rotate-webhook-token":
        yield* routines.rotateWebhookToken(input);
        taskId = input.taskId;
        break;
      case "run-now":
        threadId = (yield* routines.runNow(input)).threadId;
        taskId = input.taskId;
        break;
    }
    yield* bus.publish(input);
    return { taskId, threadId } satisfies AssistantRoutineWriteResult;
  });
  const native = Effect.fn("AssistantRoutineGateway.native")(function* (
    input: AssistantRoutineReadInput | AssistantRoutineWriteInput,
    caller: { threadId: ThreadId; providerSessionId: string },
  ) {
    const record = yield* assistants.get(input);
    if (
      input.operation === "upsert" &&
      !record.detail.configuration.configuration.memory.allowRoutineCreation
    )
      return yield* new AssistantError({ reason: "forbidden" });
    if (
      record.detail.summary.binding.canonicalThreadId !== caller.threadId ||
      record.detail.summary.lifecycle !== "active" ||
      record.detail.summary.provisioningState !== "ready" ||
      !(yield* assistantThreadIsCurrent({
        threadId: caller.threadId,
        ...record.detail.summary.binding,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
    )
      return yield* new AssistantError({ reason: "forbidden" });
    const project =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${record.detail.summary.binding.backingProjectId} AND workspace_root=${record.workspaceRoot} AND deleted_at IS NULL`;
    if (project.length !== 1) return yield* new AssistantError({ reason: "forbidden" });
    const rows =
      yield* sql`SELECT r.run_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id AND p.thread_id=r.thread_id JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id JOIN t3_workflow_v2_assistant_admissions a ON a.thread_id=r.thread_id AND a.run_id=r.run_id WHERE r.thread_id=${caller.threadId} AND p.provider_session_id=${caller.providerSessionId} AND a.assistant_id=${input.assistantId} AND r.status IN ('running','waiting') AND s.status NOT IN ('stopped','error') AND json_extract(a.configuration_json,'$.runAttemptId')=json_extract(r.payload_json,'$.activeAttemptId') LIMIT 2`;
    if (rows.length !== 1) return yield* new AssistantError({ reason: "forbidden" });
  });
  return {
    read: Effect.fn("AssistantRoutineGateway.readHuman")(function* (
      input: AssistantRoutineReadInput,
      sessionId: AuthSessionId,
    ) {
      return yield* sql.withTransaction(
        authorize(sessionId, input.operation === "webhook").pipe(Effect.andThen(read(input))),
      );
    }, Effect.mapError(unavailable)),
    write: Effect.fn("AssistantRoutineGateway.writeHuman")(function* (
      input: AssistantRoutineWriteInput,
      sessionId: AuthSessionId,
    ) {
      yield* authorize(sessionId, true);
      return yield* write(input).pipe(
        Effect.provideService(
          AssistantRoutineAuthorization,
          authorize(sessionId, true).pipe(
            Effect.mapError(
              (cause) =>
                new ScheduledTaskError({
                  message: "Routine caller is no longer authorized.",
                  cause,
                }),
            ),
          ),
        ),
      );
    }, Effect.mapError(unavailable)),
    readNative: Effect.fn("AssistantRoutineGateway.readNative")(function* (
      input: AssistantRoutineReadInput,
      caller: { threadId: ThreadId; providerSessionId: string },
    ) {
      if (input.operation === "webhook") return yield* new AssistantError({ reason: "forbidden" });
      return yield* sql.withTransaction(native(input, caller).pipe(Effect.andThen(read(input))));
    }, Effect.mapError(unavailable)),
    writeNative: Effect.fn("AssistantRoutineGateway.writeNative")(function* (
      input: AssistantRoutineWriteInput,
      caller: { threadId: ThreadId; providerSessionId: string },
    ) {
      yield* native(input, caller);
      return yield* write(input).pipe(
        Effect.provideService(
          AssistantRoutineAuthorization,
          native(input, caller).pipe(
            Effect.mapError(
              (cause) =>
                new ScheduledTaskError({
                  message: "Routine native owner is no longer current.",
                  cause,
                }),
            ),
          ),
        ),
      );
    }, Effect.mapError(unavailable)),
  };
});
export class AssistantRoutineGateway extends Context.Service<
  AssistantRoutineGateway,
  {
    readonly read: (
      input: AssistantRoutineReadInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<AssistantRoutineReadResult, AssistantError>;
    readonly write: (
      input: AssistantRoutineWriteInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<AssistantRoutineWriteResult, AssistantError>;
    readonly readNative: (
      input: AssistantRoutineReadInput,
      caller: { threadId: ThreadId; providerSessionId: string },
    ) => Effect.Effect<AssistantRoutineReadResult, AssistantError>;
    readonly writeNative: (
      input: AssistantRoutineWriteInput,
      caller: { threadId: ThreadId; providerSessionId: string },
    ) => Effect.Effect<AssistantRoutineWriteResult, AssistantError>;
  }
>()("t3/assistants/AssistantRoutineGateway") {}
export const layer = Layer.effect(
  AssistantRoutineGateway,
  make.pipe(
    Effect.mapError((cause) =>
      isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
    ),
  ),
);
