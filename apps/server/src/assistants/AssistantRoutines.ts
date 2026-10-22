// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable routine IDs are pure hashes of retained command identity.
import * as NodeCrypto from "node:crypto";
import {
  ScheduledTaskId,
  canonicalProjectWorkPayload,
  type AssistantGetInput,
  type CommandId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskUpsertSchedule,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { AssistantError, AssistantRepository } from "./AssistantRepository.ts";
import { assistantThreadIsCurrent } from "./AssistantThreadAuthority.ts";
import { AssistantRoutineMutation } from "./AssistantRoutineMutation.ts";
import {
  AssistantRoutineRepository,
  type RoutineBinding,
  type RoutineFire,
} from "./AssistantRoutineRepository.ts";

type Scope = AssistantGetInput;
type Target = Scope & { readonly taskId: ScheduledTaskId };
type Mutation = Target & { readonly expectedRevision: number };
type Page = Scope & { readonly cursor?: string; readonly limit?: number };
type Upsert = Scope & {
  readonly commandId: CommandId;
  readonly taskId?: ScheduledTaskId;
  readonly expectedRevision?: number;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly schedule: ScheduledTaskUpsertSchedule;
};
type Routine = {
  readonly binding: RoutineBinding;
  readonly task: ScheduledTask | null;
  readonly timeZone: string;
};
export class AssistantRoutines extends Context.Service<
  AssistantRoutines,
  {
    readonly list: (input: Page) => Effect.Effect<ReadonlyArray<Routine>, AssistantError>;
    readonly fires: (
      input: Page & { readonly taskId?: ScheduledTaskId },
    ) => Effect.Effect<ReadonlyArray<RoutineFire>, AssistantError>;
    readonly upsert: (input: Upsert) => Effect.Effect<Routine, AssistantError>;
    readonly setEnabled: (
      input: Mutation & { readonly enabled: boolean },
    ) => Effect.Effect<void, AssistantError>;
    readonly delete: (input: Mutation) => Effect.Effect<void, AssistantError>;
    readonly webhook: (input: Target) => Effect.Effect<
      {
        readonly taskId: ScheduledTaskId;
        readonly url: string | null;
        readonly remoteAccessRequired: boolean;
      },
      AssistantError
    >;
    readonly rotateWebhookToken: (input: Mutation) => Effect.Effect<void, AssistantError>;
    readonly runNow: (
      input: Target & { readonly commandId: CommandId },
    ) => Effect.Effect<{ readonly threadId: ThreadId | null }, AssistantError>;
  }
>()("t3/assistants/AssistantRoutines") {}
const isAssistantError = Schema.is(AssistantError);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const assistants = yield* AssistantRepository;
  const routines = yield* AssistantRoutineRepository;
  const scheduler = yield* ScheduledTaskService;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const transaction = Effect.fn("AssistantRoutines.transaction")(
    function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* Option.isSome(yield* Effect.serviceOption(sql.transactionService))
        ? effect
        : sql.withTransaction(effect);
    },
    Effect.mapError((cause) =>
      isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
    ),
  );
  const task = Effect.fn("AssistantRoutines.task")(
    function* (binding: RoutineBinding) {
      const result = yield* scheduler.get({ id: binding.taskId });
      return {
        binding,
        task: result,
        timeZone,
      };
    },
    Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
  );
  const list = Effect.fn("AssistantRoutines.list")(function* (input: Page) {
    const bindings = yield* routines.list(input);
    return yield* Effect.forEach(bindings, task);
  });
  const upsert = Effect.fn("AssistantRoutines.upsert")(function* (input: Upsert) {
    return yield* transaction(
      Effect.gen(function* () {
        const record = yield* assistants.get(input);
        const summary = record.detail.summary;
        if (summary.lifecycle !== "active" || summary.provisioningState !== "ready")
          return yield* new AssistantError({
            reason: summary.provisioningState !== "ready" ? "needs-repair" : "forbidden",
          });
        const id =
          input.taskId ??
          ScheduledTaskId.make(
            `assistant-routine-${NodeCrypto.createHash("sha256")
              .update(
                canonicalProjectWorkPayload([
                  input.environmentId,
                  input.assistantId,
                  input.commandId,
                ]),
              )
              .digest("hex")}`,
          );
        const existing = yield* routines.find(id);
        if (input.taskId || existing) yield* routines.assertOwned(input, id);
        if (existing?.deleted) return yield* new AssistantError({ reason: "not-found" });
        const retainedTask = yield* scheduler
          .get({ id })
          .pipe(Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })));
        if ((existing === null) !== (retainedTask === null))
          return yield* new AssistantError({ reason: "needs-repair" });
        if (
          input.taskId !== undefined &&
          (input.expectedRevision === undefined || existing?.revision !== input.expectedRevision)
        )
          return yield* new AssistantError({ reason: "conflict" });
        if (input.taskId === undefined && existing !== null) return yield* task(existing);
        const config = record.detail.configuration.configuration;
        const data: ScheduledTaskUpsertInput = {
          id,
          commandId: input.commandId,
          ...(input.taskId || existing ? { requireExisting: true } : {}),
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule: input.schedule,
          projectId: summary.binding.backingProjectId,
          threadId: summary.binding.canonicalThreadId,
          workspaceStrategy: { type: "root" },
          modelSelection: config.modelSelection,
          runtimeMode: config.runtimeMode,
          interactionMode: config.interactionMode,
        };
        yield* scheduler.upsert(data).pipe(
          Effect.provideService(AssistantRoutineMutation, { scope: input, taskId: id }),
          Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
        );
        return yield* task(yield* routines.bind({ ...input, taskId: id }));
      }),
    );
  });
  const assertRevision = Effect.fn("AssistantRoutines.assertRevision")(function* (input: Mutation) {
    const binding = yield* routines.assertOwned(input, input.taskId);
    if (binding.revision !== input.expectedRevision)
      return yield* new AssistantError({ reason: "conflict" });
    return binding;
  });
  const setEnabled = Effect.fn("AssistantRoutines.setEnabled")(function* (
    input: Mutation & { readonly enabled: boolean },
  ) {
    yield* transaction(
      Effect.gen(function* () {
        yield* assertRevision(input);
        yield* routines.setEnabled(input, input.taskId, input.enabled);
        yield* scheduler.setEnabled({ id: input.taskId, enabled: input.enabled }).pipe(
          Effect.provideService(AssistantRoutineMutation, { scope: input, taskId: input.taskId }),
          Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
        );
      }),
    );
  });
  const remove = Effect.fn("AssistantRoutines.delete")(function* (input: Mutation) {
    yield* transaction(
      Effect.gen(function* () {
        yield* assertRevision(input);
        yield* scheduler.delete({ id: input.taskId }).pipe(
          Effect.provideService(AssistantRoutineMutation, { scope: input, taskId: input.taskId }),
          Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
        );
        yield* routines.remove(input, input.taskId);
      }),
    );
  });
  const rotateWebhookToken = Effect.fn("AssistantRoutines.rotateWebhookToken")(function* (
    input: Mutation,
  ) {
    yield* transaction(
      Effect.gen(function* () {
        yield* assertRevision(input);
        yield* scheduler.rotateWebhookToken({ id: input.taskId }).pipe(
          Effect.provideService(AssistantRoutineMutation, { scope: input, taskId: input.taskId }),
          Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
        );
        yield* routines.advanceRevision(input, input.taskId);
      }),
    );
  });
  const webhook = Effect.fn("AssistantRoutines.webhook")(function* (input: Target) {
    return yield* transaction(
      Effect.gen(function* () {
        const binding = yield* routines.assertOwned(input, input.taskId);
        const record = yield* assistants.get(input);
        if (binding.deleted) return yield* new AssistantError({ reason: "not-found" });
        const current = record.detail.summary.binding;
        const task = yield* scheduler
          .get({ id: input.taskId })
          .pipe(Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })));
        if (
          task === null ||
          task.projectId !== binding.projectId ||
          task.threadId !== binding.threadId ||
          binding.projectId !== current.backingProjectId ||
          binding.threadId !== current.canonicalThreadId
        )
          return yield* new AssistantError({ reason: "needs-repair" });
        const projects =
          yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${binding.projectId} AND workspace_root=${record.workspaceRoot} AND deleted_at IS NULL`;
        if (
          projects.length !== 1 ||
          !(yield* assistantThreadIsCurrent({ threadId: binding.threadId, ...current }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ))
        )
          return yield* new AssistantError({ reason: "needs-repair" });
        if (task.schedule.type !== "webhook" || task.webhook === undefined)
          return yield* new AssistantError({ reason: "forbidden" });
        const url = task.webhook.url;
        return { taskId: input.taskId, url, remoteAccessRequired: url === null };
      }),
    );
  });
  const runNow = Effect.fn("AssistantRoutines.runNow")(function* (
    input: Target & { readonly commandId: CommandId },
  ) {
    yield* routines.assertOwned(input, input.taskId);
    return yield* scheduler.runNow({ id: input.taskId, commandId: input.commandId }).pipe(
      Effect.provideService(AssistantRoutineMutation, { scope: input, taskId: input.taskId }),
      Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })),
    );
  });
  return AssistantRoutines.of({
    list,
    fires: routines.listFires,
    upsert,
    setEnabled,
    delete: remove,
    rotateWebhookToken,
    webhook,
    runNow,
  });
});
export const layer = Layer.effect(AssistantRoutines, make);
