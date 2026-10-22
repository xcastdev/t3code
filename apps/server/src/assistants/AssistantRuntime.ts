import { AssistantThreadOwnerRead } from "./AssistantThreadOwnerRead.ts";
import { AssistantEventBus } from "./AssistantEventBus.ts";
import { AssistantRoutineRepository } from "./AssistantRoutineRepository.ts";
import { reconcileWorkBindings } from "./OwnedBindingReconciliation.ts";
import { ProjectWorkEventBus } from "../projectWork/ProjectWorkEventBus.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  type AuthSessionId,
  type AssistantLifecycleInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AssistantError, AssistantRepository } from "./AssistantRepository.ts";
import { AssistantService } from "./AssistantService.ts";
import { AssistantProvisioning } from "./AssistantProvisioning.ts";
import { AssistantLifecycleMutation } from "./AssistantAdmission.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";

const isAssistantError = Schema.is(AssistantError);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventBus = yield* Effect.serviceOption(AssistantEventBus);
  const service = yield* AssistantService;
  const repository = yield* AssistantRepository;
  const ownerRead = yield* AssistantThreadOwnerRead;
  const routines = yield* Effect.serviceOption(AssistantRoutineRepository);
  const provisioning = yield* AssistantProvisioning;
  const threads = yield* ThreadManagementService;
  const sessions = yield* AuthSessionRepository;
  const environment = yield* ServerEnvironment;
  const workBus = yield* ProjectWorkEventBus;
  const authorize = Effect.fn("AssistantRuntime.authorize")(
    function* (sessionId: AuthSessionId, write: boolean) {
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
    },
    Effect.mapError((cause) =>
      isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
    ),
  );
  const synchronize = Effect.fn("AssistantRuntime.synchronize")(
    function* (detail: import("@t3tools/contracts").AssistantDetail, commandId: CommandId) {
      if (detail.summary.provisioningState !== "ready") return;
      const threadId = detail.summary.binding.canonicalThreadId;
      const configuration = detail.configuration.configuration;
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${commandId}:model`),
        threadId,
        modelSelection: configuration.modelSelection,
      });
      yield* threads.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(`${commandId}:runtime`),
        threadId,
        runtimeMode: configuration.runtimeMode,
      });
      yield* threads.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(`${commandId}:interaction`),
        threadId,
        interactionMode: configuration.interactionMode,
      });
    },
    Effect.mapError((cause) =>
      isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
    ),
  );
  const updateConfiguration = Effect.fn("AssistantRuntime.updateConfiguration")(function* (
    input: import("@t3tools/contracts").AssistantUpdateConfigurationInput,
    sessionId: AuthSessionId,
  ) {
    const detail = yield* sql.withTransaction(
      authorize(sessionId, true).pipe(Effect.andThen(service.updateConfiguration(input))),
    );
    if (Option.isSome(eventBus)) yield* eventBus.value.publish(input);
    yield* synchronize(detail, input.commandId);
    return detail;
  });
  const lifecycle = Effect.fn("AssistantRuntime.lifecycle")(
    function* (input: AssistantLifecycleInput, sessionId: AuthSessionId) {
      yield* authorize(sessionId, true);
      let detail = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* authorize(sessionId, true);
          const result =
            input.action === "retry-provisioning"
              ? (yield* repository.lifecycle(input)).detail
              : yield* service.lifecycle(input);
          if (
            (input.action === "disable" ||
              input.action === "archive" ||
              input.action === "restore" ||
              input.action === "retry-provisioning") &&
            Option.isSome(routines)
          )
            yield* routines.value.suspend(input);
          return result;
        }),
      );
      if (Option.isSome(eventBus)) yield* eventBus.value.publish(input);
      if (input.action === "restore" || input.action === "retry-provisioning") {
        if (input.action === "retry-provisioning")
          yield* provisioning.ensure(yield* repository.get(input)).pipe(Effect.ignore);
        const record = yield* repository.get(input);
        const shell = yield* threads.getThreadShell(
          record.detail.summary.binding.canonicalThreadId,
        );
        if (shell !== null && shell.deletedAt === null && shell.archivedAt !== null) {
          yield* threads
            .dispatch({
              type: "thread.unarchive",
              threadId: shell.id,
              commandId: CommandId.make(`${input.commandId}:restore-home`),
            })
            .pipe(
              Effect.provideService(AssistantLifecycleMutation, record.detail.summary.assistantId),
            );
        }
        yield* provisioning.reconcile(yield* repository.get(input), { repair: true });
        detail = (yield* repository.get(input)).detail;
        if (Option.isSome(eventBus)) yield* eventBus.value.publish(input);
      }
      return detail;
    },
    Effect.mapError((cause) =>
      isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
    ),
  );
  const recover = Effect.fn("AssistantRuntime.recover")(function* () {
    yield* reconcileWorkBindings().pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ProjectWorkEventBus, workBus),
      Effect.catch((cause) =>
        Effect.logWarning("Work binding reconciliation remains unavailable.", { cause }),
      ),
    );
    const environmentId = yield* environment.getEnvironmentId;
    let cursor: string | undefined;
    for (;;) {
      const page = yield* repository.list({
        environmentId,
        includeArchived: true,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const record of page)
        yield* provisioning.reconcile(record).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Assistant binding reconciliation remains unavailable.", {
              assistantId: record.detail.summary.assistantId,
              cause,
            }),
          ),
        );
      if (page.length < 100) break;
      cursor = page.at(-1)!.detail.summary.assistantId;
    }
  });
  return {
    create: Effect.fn("AssistantRuntime.create")(function* (
      input: import("@t3tools/contracts").AssistantCreateInput,
      sessionId: AuthSessionId,
    ) {
      yield* authorize(sessionId, true);
      const detail = yield* service.create(input);
      if (Option.isSome(eventBus)) yield* eventBus.value.publish(detail.summary);
      return detail;
    }),
    resolveThread: Effect.fn("AssistantRuntime.resolveThread")(
      (input: import("@t3tools/contracts").AssistantResolveThreadInput, sessionId: AuthSessionId) =>
        sql.withTransaction(
          authorize(sessionId, false).pipe(Effect.andThen(ownerRead.resolve(input))),
        ),
    ),
    get: Effect.fn("AssistantRuntime.get")(function* (
      input: import("@t3tools/contracts").AssistantGetInput,
      sessionId: AuthSessionId,
    ) {
      yield* authorize(sessionId, false);
      return yield* service.get(input);
    }),
    list: Effect.fn("AssistantRuntime.list")(function* (
      input: import("@t3tools/contracts").AssistantListInput,
      sessionId: AuthSessionId,
    ) {
      yield* authorize(sessionId, false);
      return yield* service.list(input);
    }),
    updateConfiguration,
    lifecycle,
    recover,
  };
});
export class AssistantRuntime extends Context.Service<
  AssistantRuntime,
  Effect.Success<typeof make>
>()("t3/assistants/AssistantRuntime") {}
export const layer = Layer.effect(AssistantRuntime, make);
export { layerOwnerAuthority as layerMemoryAuthority } from "./AssistantMemoryLayers.ts";
