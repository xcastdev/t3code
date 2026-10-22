// @effect-diagnostics-next-line nodeBuiltinImport:off -- Queued admission compares the retained exact prompt digest without I/O.
import * as NodeCrypto from "node:crypto";
import {
  AssistantConfigurationRevision,
  AssistantId,
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type AssistantGetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantError, AssistantRepository } from "./AssistantRepository.ts";
import { assistantThreadIsCurrent } from "./AssistantThreadAuthority.ts";

export const RoutineBinding = Schema.Struct({
  taskId: ScheduledTaskId,
  environmentId: EnvironmentId,
  assistantId: AssistantId,
  projectId: ProjectId,
  threadId: ThreadId,
  configurationRevision: AssistantConfigurationRevision,
  revision: Schema.Number,
  enabled: Schema.Boolean,
  deleted: Schema.Boolean,
});
export type RoutineBinding = typeof RoutineBinding.Type;
export const RoutineFire = Schema.Struct({
  fireKey: Schema.String,
  taskId: ScheduledTaskId,
  environmentId: EnvironmentId,
  assistantId: AssistantId,
  threadId: ThreadId,
  configurationRevision: AssistantConfigurationRevision,
  trigger: Schema.Literals(["scheduled", "manual", "webhook"]),
  triggerIdentity: Schema.String,
  commandId: CommandId,
  messageId: MessageId,
  promptHash: Schema.String,
  startedAt: Schema.String,
  dispatched: Schema.Boolean,
  runId: Schema.NullOr(RunId),
  admittedConfigurationRevision: Schema.NullOr(AssistantConfigurationRevision),
  status: Schema.Literals([
    "attempted",
    "dispatched",
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "uncertain",
  ]),
});
export type RoutineFire = typeof RoutineFire.Type;
type BeginFire = {
  readonly taskId: ScheduledTaskId;
  readonly fireKey: string;
  readonly trigger: RoutineFire["trigger"];
  readonly triggerIdentity: string;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly promptHash: string;
  readonly startedAt: string;
};
type Page = AssistantGetInput & {
  readonly taskId?: ScheduledTaskId;
  readonly cursor?: string;
  readonly limit?: number;
};

export class AssistantRoutineRepository extends Context.Service<
  AssistantRoutineRepository,
  {
    readonly find: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<RoutineBinding | null, AssistantError>;
    readonly bind: (
      input: AssistantGetInput & { readonly taskId: ScheduledTaskId; readonly enabled: boolean },
    ) => Effect.Effect<RoutineBinding, AssistantError>;
    readonly assertOwned: (
      scope: AssistantGetInput,
      taskId: ScheduledTaskId,
    ) => Effect.Effect<RoutineBinding, AssistantError>;
    readonly assertRunnable: (
      taskId: ScheduledTaskId,
    ) => Effect.Effect<RoutineBinding | null, AssistantError>;
    readonly beginFire: (input: BeginFire) => Effect.Effect<RoutineFire | null, AssistantError>;
    readonly recoverTask: (
      taskId: ScheduledTaskId,
      identity?: { readonly trigger: RoutineFire["trigger"]; readonly triggerIdentity: string },
    ) => Effect.Effect<
      (RoutineFire & { readonly receiptStatus: "accepted" | "rejected" | null }) | null,
      AssistantError
    >;
    readonly assertAdmission: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly messageId: MessageId;
      readonly taskId: ScheduledTaskId;
      readonly promptHash: string;
    }) => Effect.Effect<void, AssistantError>;
    readonly assertQueued: (input: {
      readonly runId: RunId;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
    }) => Effect.Effect<void, AssistantError>;
    readonly markDispatched: (fireKey: string) => Effect.Effect<void, AssistantError>;
    readonly list: (input: Page) => Effect.Effect<ReadonlyArray<RoutineBinding>, AssistantError>;
    readonly listFires: (input: Page) => Effect.Effect<ReadonlyArray<RoutineFire>, AssistantError>;
    readonly setEnabled: (
      scope: AssistantGetInput,
      taskId: ScheduledTaskId,
      enabled: boolean,
    ) => Effect.Effect<void, AssistantError>;
    readonly advanceRevision: (
      scope: AssistantGetInput,
      taskId: ScheduledTaskId,
    ) => Effect.Effect<void, AssistantError>;
    readonly remove: (
      scope: AssistantGetInput,
      taskId: ScheduledTaskId,
    ) => Effect.Effect<void, AssistantError>;
    readonly pause: (taskId: ScheduledTaskId) => Effect.Effect<void, AssistantError>;
    readonly suspend: (scope: AssistantGetInput) => Effect.Effect<void, AssistantError>;
  }
>()("t3/assistants/AssistantRoutineRepository") {}

const isAssistantError = Schema.is(AssistantError);
const unavailable = (cause: unknown) =>
  isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause });
const bindingColumns = `task_id AS taskId,environment_id AS environmentId,assistant_id AS assistantId,project_id AS projectId,thread_id AS threadId,configuration_revision AS configurationRevision,revision,enabled,deleted`;
const decodeBinding = Schema.decodeUnknownEffect(RoutineBinding);
const decodeFire = Schema.decodeUnknownEffect(RoutineFire);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assistants = yield* AssistantRepository;
  const find = Effect.fn("AssistantRoutineRepository.find")(function* (taskId: ScheduledTaskId) {
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT ${bindingColumns} FROM t3_workflow_v2_assistant_routines WHERE task_id=?`,
      [taskId],
    );
    const row = rows[0];
    return row
      ? yield* decodeBinding({ ...row, enabled: row.enabled === 1, deleted: row.deleted === 1 })
      : null;
  }, Effect.mapError(unavailable));
  const assertOwned = Effect.fn("AssistantRoutineRepository.assertOwned")(function* (
    scope: AssistantGetInput,
    taskId: ScheduledTaskId,
  ) {
    yield* assistants.get(scope);
    const binding = yield* find(taskId);
    if (
      !binding ||
      binding.environmentId !== scope.environmentId ||
      binding.assistantId !== scope.assistantId
    )
      return yield* new AssistantError({ reason: "forbidden" });
    return binding;
  });
  const validate = Effect.fn("AssistantRoutineRepository.validate")(function* (
    binding: RoutineBinding,
    options?: { readonly enabling: true },
  ) {
    const record = yield* assistants.get(binding);
    const owner = record.detail.summary;
    if (binding.deleted || !binding.enabled || owner.lifecycle !== "active")
      return yield* new AssistantError({ reason: "forbidden" });
    if (owner.provisioningState !== "ready")
      return yield* new AssistantError({ reason: "needs-repair" });
    const task = (yield* sql<{
      project_id: string;
      thread_id: string | null;
      enabled: number;
    }>`SELECT project_id,thread_id,enabled FROM scheduled_tasks WHERE task_id=${binding.taskId}`)[0];
    const projects =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${binding.projectId} AND workspace_root=${record.workspaceRoot} AND deleted_at IS NULL`;
    if (
      !task ||
      task.project_id !== binding.projectId ||
      task.thread_id !== binding.threadId ||
      binding.projectId !== owner.binding.backingProjectId ||
      binding.threadId !== owner.binding.canonicalThreadId ||
      projects.length !== 1 ||
      !(yield* assistantThreadIsCurrent({ threadId: binding.threadId, ...owner.binding }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      ))
    ) {
      yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id=${binding.taskId}`;
      yield* sql`UPDATE t3_workflow_v2_assistant_routines SET enabled=0,revision=revision+1 WHERE task_id=${binding.taskId} AND enabled!=0`;
      return yield* new AssistantError({ reason: "needs-repair" });
    }
    if (task.enabled !== 1 && !options?.enabling)
      return yield* new AssistantError({ reason: "forbidden" });
    return { ...binding, configurationRevision: owner.configurationRevision };
  }, Effect.mapError(unavailable));
  const assertRunnable = Effect.fn("AssistantRoutineRepository.assertRunnable")(function* (
    taskId: ScheduledTaskId,
  ) {
    const binding = yield* find(taskId);
    return binding ? yield* validate(binding) : null;
  });
  const bind = Effect.fn("AssistantRoutineRepository.bind")(function* (
    input: AssistantGetInput & { taskId: ScheduledTaskId; enabled: boolean },
  ) {
    const record = yield* assistants.get(input);
    const old = yield* find(input.taskId);
    if (
      old &&
      (old.assistantId !== input.assistantId ||
        old.environmentId !== input.environmentId ||
        old.deleted)
    )
      return yield* new AssistantError({ reason: "forbidden" });
    const summary = record.detail.summary;
    if (summary.lifecycle !== "active" || summary.provisioningState !== "ready")
      return yield* new AssistantError({
        reason: summary.provisioningState !== "ready" ? "needs-repair" : "forbidden",
      });
    const task = (yield* sql<{
      project_id: string;
      thread_id: string | null;
    }>`SELECT project_id,thread_id FROM scheduled_tasks WHERE task_id=${input.taskId}`)[0];
    if (
      !task ||
      task.project_id !== summary.binding.backingProjectId ||
      task.thread_id !== summary.binding.canonicalThreadId
    )
      return yield* new AssistantError({ reason: "needs-repair" });
    yield* sql`INSERT INTO t3_workflow_v2_assistant_routines(task_id,environment_id,assistant_id,project_id,thread_id,configuration_revision,enabled,deleted) VALUES(${input.taskId},${input.environmentId},${input.assistantId},${summary.binding.backingProjectId},${summary.binding.canonicalThreadId},${summary.configurationRevision},${Number(input.enabled)},0) ON CONFLICT(task_id) DO UPDATE SET configuration_revision=excluded.configuration_revision,enabled=excluded.enabled,revision=t3_workflow_v2_assistant_routines.revision+1`;
    return (yield* find(input.taskId))!;
  }, Effect.mapError(unavailable));
  const list = Effect.fn("AssistantRoutineRepository.list")(function* (input: Page) {
    yield* assistants.get(input);
    const rows = yield* sql<{
      task_id: ScheduledTaskId;
    }>`SELECT task_id FROM t3_workflow_v2_assistant_routines WHERE environment_id=${input.environmentId} AND assistant_id=${input.assistantId} AND task_id>${input.cursor ?? ""} ORDER BY task_id LIMIT ${Math.min(32, Math.max(1, input.limit ?? 32))}`;
    return yield* Effect.forEach(rows, (row) =>
      find(row.task_id).pipe(Effect.map((binding) => binding!)),
    );
  }, Effect.mapError(unavailable));
  const listFires = Effect.fn("AssistantRoutineRepository.listFires")(function* (input: Page) {
    yield* assistants.get(input);
    if (input.taskId) yield* assertOwned(input, input.taskId);
    const rows = yield* sql<
      Record<string, unknown>
    >`SELECT f.fire_key AS fireKey,f.task_id AS taskId,f.environment_id AS environmentId,f.assistant_id AS assistantId,f.thread_id AS threadId,f.configuration_revision AS configurationRevision,f.trigger_kind AS trigger,f.trigger_identity AS triggerIdentity,f.command_id AS commandId,f.message_id AS messageId,f.prompt_hash AS promptHash,f.started_at AS startedAt,f.dispatched,m.run_id AS runId,a.configuration_revision AS admittedConfigurationRevision,r.status AS runStatus,c.status AS receiptStatus FROM t3_workflow_v2_assistant_routine_fires f LEFT JOIN orchestration_command_receipts c ON c.command_id=f.command_id AND c.aggregate_kind='thread' AND c.aggregate_id=f.thread_id LEFT JOIN orchestration_v2_projection_messages m ON m.message_id=f.message_id AND m.thread_id=f.thread_id LEFT JOIN orchestration_v2_projection_runs r ON r.run_id=m.run_id AND r.thread_id=f.thread_id LEFT JOIN t3_workflow_v2_assistant_admissions a ON a.run_id=r.run_id AND a.thread_id=f.thread_id AND a.assistant_id=f.assistant_id WHERE f.environment_id=${input.environmentId} AND f.assistant_id=${input.assistantId} AND (${input.taskId ?? null} IS NULL OR f.task_id=${input.taskId ?? null}) AND f.fire_key>${input.cursor ?? ""} ORDER BY f.fire_key LIMIT ${Math.min(32, Math.max(1, input.limit ?? 32))}`;
    return yield* Effect.forEach(rows, (row) => {
      const run = row.runStatus;
      const status =
        row.receiptStatus === "rejected"
          ? "failed"
          : row.receiptStatus !== "accepted"
            ? "uncertain"
            : run === "preparing" || run === "queued" || run === "starting"
              ? "queued"
              : run === "rolled_back"
                ? "interrupted"
                : (run ?? "dispatched");
      return decodeFire({
        ...row,
        dispatched: row.dispatched === 1 || row.receiptStatus === "accepted",
        status,
      });
    });
  }, Effect.mapError(unavailable));
  const beginFire = Effect.fn("AssistantRoutineRepository.beginFire")(function* (input: BeginFire) {
    // The scheduler owns the transaction that also marks the task and webhook delivery running.
    if (Option.isNone(yield* Effect.serviceOption(sql.transactionService)))
      return yield* new AssistantError({ reason: "conflict" });
    const binding = yield* assertRunnable(input.taskId);
    if (!binding) return null;
    const prior = (yield* sql<{
      fire_key: string;
    }>`SELECT fire_key FROM t3_workflow_v2_assistant_routine_fires WHERE task_id=${input.taskId} AND trigger_kind=${input.trigger} AND trigger_identity=${input.triggerIdentity}`)[0];
    if (prior) return yield* new AssistantError({ reason: "conflict" });
    yield* sql`INSERT INTO t3_workflow_v2_assistant_routine_fires(fire_key,task_id,environment_id,assistant_id,thread_id,configuration_revision,trigger_kind,trigger_identity,command_id,message_id,prompt_hash,started_at) VALUES(${input.fireKey},${input.taskId},${binding.environmentId},${binding.assistantId},${binding.threadId},${binding.configurationRevision},${input.trigger},${input.triggerIdentity},${input.commandId},${input.messageId},${input.promptHash},${input.startedAt})`;
    return {
      ...input,
      ...binding,
      runId: null,
      admittedConfigurationRevision: null,
      dispatched: false,
      status: "attempted" as const,
    };
  }, Effect.mapError(unavailable));
  const recoverTask = Effect.fn("AssistantRoutineRepository.recoverTask")(function* (
    taskId: ScheduledTaskId,
    identity?: { readonly trigger: RoutineFire["trigger"]; readonly triggerIdentity: string },
  ) {
    const binding = yield* find(taskId);
    if (!binding) return null;
    const latest = (yield* sql<{
      fire_key: string;
      receipt_status: "accepted" | "rejected" | null;
    }>`SELECT f.fire_key,c.status AS receipt_status FROM t3_workflow_v2_assistant_routine_fires f LEFT JOIN orchestration_command_receipts c ON c.command_id=f.command_id AND c.aggregate_kind='thread' AND c.aggregate_id=f.thread_id WHERE f.task_id=${taskId} AND (${identity?.trigger ?? null} IS NULL OR (f.trigger_kind=${identity?.trigger ?? null} AND f.trigger_identity=${identity?.triggerIdentity ?? null})) ORDER BY f.started_at DESC,f.fire_key DESC LIMIT 1`)[0];
    if (!latest) return null;
    // Reuse the same canonical projection join; no scheduler timestamp can replace this fire identity.
    const previous = (yield* sql<{
      fire_key: string;
    }>`SELECT fire_key FROM t3_workflow_v2_assistant_routine_fires WHERE environment_id=${binding.environmentId} AND assistant_id=${binding.assistantId} AND fire_key<${latest.fire_key} ORDER BY fire_key DESC LIMIT 1`)[0];
    const fire = (yield* listFires({
      ...binding,
      taskId,
      ...(previous === undefined ? {} : { cursor: previous.fire_key }),
      limit: 1,
    }))[0];
    if (!fire || fire.fireKey !== latest.fire_key)
      return yield* new AssistantError({ reason: "unavailable" });
    return { ...fire, receiptStatus: latest.receipt_status };
  }, Effect.mapError(unavailable));
  const assertAdmission = Effect.fn("AssistantRoutineRepository.assertAdmission")(
    function* (input: {
      threadId: ThreadId;
      commandId: CommandId;
      messageId: MessageId;
      taskId: ScheduledTaskId;
      promptHash: string;
    }) {
      const binding = yield* assertRunnable(input.taskId);
      if (!binding) return yield* new AssistantError({ reason: "forbidden" });
      const rows =
        yield* sql`SELECT fire_key FROM t3_workflow_v2_assistant_routine_fires WHERE task_id=${input.taskId} AND environment_id=${binding.environmentId} AND assistant_id=${binding.assistantId} AND thread_id=${input.threadId} AND thread_id=${binding.threadId} AND command_id=${input.commandId} AND message_id=${input.messageId} AND prompt_hash=${input.promptHash}`;
      if (rows.length !== 1) return yield* new AssistantError({ reason: "forbidden" });
    },
    Effect.mapError(unavailable),
  );
  const assertQueued = Effect.fn("AssistantRoutineRepository.assertQueued")(function* (input: {
    runId: RunId;
    threadId: ThreadId;
    messageId: MessageId;
  }) {
    const fire = (yield* sql<{
      task_id: ScheduledTaskId;
      thread_id: ThreadId;
      prompt_hash: string;
    }>`SELECT task_id,thread_id,prompt_hash FROM t3_workflow_v2_assistant_routine_fires WHERE message_id=${input.messageId}`)[0];
    if (!fire) {
      const marked =
        yield* sql`SELECT message_id FROM orchestration_v2_projection_messages WHERE message_id=${input.messageId} AND thread_id=${input.threadId} AND json_extract(payload_json,'$.scheduledTaskId') IS NOT NULL`;
      if (marked.length !== 0 && (yield* assistants.findByThread(input.threadId)) !== null)
        return yield* new AssistantError({ reason: "forbidden" });
      return;
    }
    const binding = yield* assertRunnable(fire.task_id);
    if (!binding || binding.threadId !== input.threadId || fire.thread_id !== input.threadId)
      return yield* new AssistantError({ reason: "forbidden" });
    const rows = yield* sql<{
      text: string | null;
    }>`SELECT json_extract(payload_json,'$.text') AS text FROM orchestration_v2_projection_messages WHERE message_id=${input.messageId} AND thread_id=${input.threadId} AND run_id=${input.runId} AND json_extract(payload_json,'$.scheduledTaskId')=${fire.task_id}`;
    const text = rows[0]?.text;
    if (
      rows.length !== 1 ||
      typeof text !== "string" ||
      NodeCrypto.createHash("sha256").update(text).digest("hex") !== fire.prompt_hash
    )
      return yield* new AssistantError({ reason: "forbidden" });
  }, Effect.mapError(unavailable));
  const markDispatched = Effect.fn("AssistantRoutineRepository.markDispatched")(function* (
    fireKey: string,
  ) {
    yield* sql`UPDATE t3_workflow_v2_assistant_routine_fires SET dispatched=1 WHERE fire_key=${fireKey}`;
  }, Effect.mapError(unavailable));
  const setEnabled = Effect.fn("AssistantRoutineRepository.setEnabled")(function* (
    scope: AssistantGetInput,
    taskId: ScheduledTaskId,
    enabled: boolean,
  ) {
    const binding = yield* assertOwned(scope, taskId);
    if (binding.deleted) return yield* new AssistantError({ reason: "not-found" });
    if (enabled) {
      // Validate the retained destination before opening the admission gate again.
      yield* validate({ ...binding, enabled: true }, { enabling: true });
    }
    yield* sql`UPDATE t3_workflow_v2_assistant_routines SET enabled=${Number(enabled)},revision=revision+1 WHERE task_id=${taskId}`;
  }, Effect.mapError(unavailable));
  const advanceRevision = Effect.fn("AssistantRoutineRepository.advanceRevision")(function* (
    scope: AssistantGetInput,
    taskId: ScheduledTaskId,
  ) {
    yield* assertOwned(scope, taskId);
    yield* sql`UPDATE t3_workflow_v2_assistant_routines SET revision=revision+1 WHERE task_id=${taskId}`;
  }, Effect.mapError(unavailable));
  const remove = Effect.fn("AssistantRoutineRepository.remove")(function* (
    scope: AssistantGetInput,
    taskId: ScheduledTaskId,
  ) {
    yield* assertOwned(scope, taskId);
    yield* sql`UPDATE t3_workflow_v2_assistant_routines SET enabled=0,deleted=1,revision=revision+1 WHERE task_id=${taskId} AND deleted=0`;
  }, Effect.mapError(unavailable));
  const pause = Effect.fn("AssistantRoutineRepository.pause")(function* (taskId: ScheduledTaskId) {
    const binding = yield* find(taskId);
    if (!binding) return;
    yield* assistants.get(binding);
    yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id=${taskId}`;
    yield* sql`UPDATE t3_workflow_v2_assistant_routines SET enabled=0,revision=revision+1 WHERE task_id=${taskId} AND enabled!=0`;
  }, Effect.mapError(unavailable));
  const suspend = Effect.fn("AssistantRoutineRepository.suspend")(function* (
    scope: AssistantGetInput,
  ) {
    yield* assistants.get(scope);
    yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id IN (SELECT task_id FROM t3_workflow_v2_assistant_routines WHERE environment_id=${scope.environmentId} AND assistant_id=${scope.assistantId})`;
    yield* sql`UPDATE t3_workflow_v2_assistant_routines SET enabled=0,revision=revision+1 WHERE environment_id=${scope.environmentId} AND assistant_id=${scope.assistantId} AND enabled!=0`;
  }, Effect.mapError(unavailable));
  return AssistantRoutineRepository.of({
    find,
    bind,
    assertOwned,
    assertRunnable,
    beginFire,
    recoverTask,
    assertAdmission,
    assertQueued,
    markDispatched,
    list,
    listFires,
    setEnabled,
    advanceRevision,
    remove,
    pause,
    suspend,
  });
});
export const layer = Layer.effect(AssistantRoutineRepository, make);
