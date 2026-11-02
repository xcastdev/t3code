import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  CommandId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Sessions from "../persistence/AuthSessions.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectWorkEventBusLive } from "../projectWork/ProjectWorkEventBus.ts";
import * as Repository from "./AssistantRepository.ts";
import * as Service from "./AssistantService.ts";
import * as Runtime from "./AssistantRuntime.ts";
import * as AssistantThreadOwnerRead from "./AssistantThreadOwnerRead.ts";
import { AssistantProvisioning } from "./AssistantProvisioning.ts";
import { AssistantEventBus } from "./AssistantEventBus.ts";
import { configuration, input, environmentId } from "./AssistantTestHelpers.ts";
const environment = Layer.succeed(Environment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused descriptor"),
});
const persistence = Layer.mergeAll(Repository.layer, Sessions.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(environment),
);
const provisioning = Layer.mock(AssistantProvisioning)({});
const threads = Layer.mock(ThreadManagementService)({
  dispatch: () =>
    Effect.fail(new OrchestratorProjectionError({ threadId: ThreadId.make("missing") })),
  getThreadShell: (threadId) => Effect.fail(new OrchestratorProjectionError({ threadId })),
});
const setup = Effect.fn("AssistantRuntimeTest.setup")(function* () {
  const repository = yield* Repository.AssistantRepository;
  let record = yield* repository.create(input);
  record = yield* repository.setProvisioning(
    record.detail.summary,
    { state: "ready", binding: record.detail.summary.binding },
    "/retained-assistant",
  );
  const sessionId = AuthSessionId.make("runtime-human");
  const sessions = yield* Sessions.AuthSessionRepository;
  yield* sessions.create({
    sessionId,
    subject: "maintainer",
    scopes: [AuthOrchestrationOperateScope],
    method: "browser-session-cookie",
    issuedAt: yield* DateTime.now,
    expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00Z"),
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
  });
  return { record, repository, sessionId, sessions };
});
const withRuntime = Effect.fn("AssistantRuntimeTest.withRuntime")(function* (
  threadManagement: Layer.Layer<ThreadManagementService> = threads,
) {
  const hints = yield* Ref.make(0);
  const layer = Runtime.layer.pipe(
    Layer.provide(AssistantThreadOwnerRead.layer),
    Layer.provideMerge(Service.layer.pipe(Layer.provide(provisioning))),
    Layer.provideMerge(persistence),
    Layer.provide(environment),
    Layer.provide(provisioning),
    Layer.provide(threadManagement),
    Layer.provide(ProjectWorkEventBusLive),
    Layer.provide(
      Layer.succeed(AssistantEventBus, {
        publish: () => Ref.update(hints, (count) => count + 1),
        subscribe: Effect.die("unused subscription"),
      }),
    ),
  );
  return { hints, layer };
});

it.effect(
  "publishes committed configuration before synchronization fails and never publishes rejected writes",
  () =>
    Effect.gen(function* () {
      const { hints, layer } = yield* withRuntime();
      yield* Effect.gen(function* () {
        const { record, repository, sessionId, sessions } = yield* setup();
        const runtime = yield* Runtime.AssistantRuntime;
        const change = {
          ...record.detail.summary,
          commandId: CommandId.make("change-prompt"),
          expectedRevision: record.detail.configuration.revision,
          configuration: { ...configuration, prompt: "Committed new prompt" },
        };
        assert.equal(
          (yield* runtime.updateConfiguration(change, sessionId).pipe(Effect.result))._tag,
          "Failure",
        );
        const current = yield* repository.get(record.detail.summary);
        assert.equal(current.detail.configuration.configuration.prompt, "Committed new prompt");
        assert.equal(
          current.detail.configuration.revision,
          record.detail.configuration.revision + 1,
        );
        assert.equal(yield* Ref.get(hints), 1);
        yield* sessions.revoke({ sessionId, revokedAt: yield* DateTime.now });
        assert.equal(
          (yield* runtime
            .updateConfiguration(
              {
                ...change,
                commandId: CommandId.make("revoked-change"),
                expectedRevision: current.detail.configuration.revision,
                configuration,
              },
              sessionId,
            )
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.deepStrictEqual(yield* repository.get(record.detail.summary), current);
        assert.equal(yield* Ref.get(hints), 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("publishes committed restoration before its retained-thread read fails", () =>
  Effect.gen(function* () {
    const { hints, layer } = yield* withRuntime();
    yield* Effect.gen(function* () {
      const { record, repository, sessionId } = yield* setup();
      const archived = yield* repository.lifecycle({
        ...record.detail.summary,
        commandId: CommandId.make("archive"),
        expectedRevision: record.detail.configuration.revision,
        action: "archive",
      });
      assert.equal(
        (yield* (yield* Runtime.AssistantRuntime)
          .lifecycle(
            {
              ...record.detail.summary,
              commandId: CommandId.make("restore"),
              expectedRevision: archived.detail.configuration.revision,
              action: "restore",
            },
            sessionId,
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      const restored = yield* repository.get(record.detail.summary);
      assert.equal(restored.detail.summary.lifecycle, "active");
      assert.equal(
        restored.detail.configuration.revision,
        archived.detail.configuration.revision + 1,
      );
      assert.equal(yield* Ref.get(hints), 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "configuration changes move only threads still on the previous default and rename Home",
  () =>
    Effect.gen(function* () {
      const shells = new Map<ThreadId, OrchestrationV2ThreadShell>();
      const shell = (
        id: string,
        overrides: Partial<OrchestrationV2ThreadShell> = {},
      ): OrchestrationV2ThreadShell =>
        ({
          id: ThreadId.make(id),
          title: id,
          deletedAt: null,
          modelSelection: configuration.modelSelection,
          runtimeMode: configuration.runtimeMode,
          interactionMode: configuration.interactionMode,
          ...overrides,
        }) as OrchestrationV2ThreadShell;
      const dispatched = yield* Ref.make<Array<OrchestrationV2ServerCommand>>([]);
      const { layer } = yield* withRuntime(
        Layer.mock(ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
          dispatch: (command) =>
            Ref.update(dispatched, (all) => [...all, command]).pipe(
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
      );
      yield* Effect.gen(function* () {
        const { record, repository, sessionId } = yield* setup();
        const binding = record.detail.summary.binding;
        const homeId = binding.canonicalThreadId;
        const sql = yield* SqlClient.SqlClient;
        for (const id of ["sync-own-model", "sync-default"])
          yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES(${id},${binding.backingProjectId},${id},'codex','approval-required','default','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','{"lineage":{"relationshipToParent":"chat"}}')`;
        shells.set(homeId, shell(homeId, { title: "Research", runtimeMode: "full-access" }));
        shells.set(
          ThreadId.make("sync-own-model"),
          shell("sync-own-model", {
            modelSelection: { ...configuration.modelSelection, model: "gpt-6-luna" },
          }),
        );
        shells.set(ThreadId.make("sync-default"), shell("sync-default"));
        const current = yield* repository.get(record.detail.summary);
        yield* (yield* Runtime.AssistantRuntime).updateConfiguration(
          {
            ...record.detail.summary,
            commandId: CommandId.make("sync"),
            expectedRevision: current.detail.configuration.revision,
            configuration: {
              ...configuration,
              name: "Scholar",
              modelSelection: { ...configuration.modelSelection, model: "gpt-6-nova" },
              runtimeMode: "auto-accept-edits",
              interactionMode: "plan",
            },
          },
          sessionId,
        );
        const changes = (yield* Ref.get(dispatched)).map((command) =>
          command.type === "thread.metadata.update"
            ? `${command.threadId}:title:${command.title}`
            : command.type === "thread.model-selection.set"
              ? `${command.threadId}:model:${command.modelSelection.model}`
              : command.type === "thread.runtime-mode.set"
                ? `${command.threadId}:runtime:${command.runtimeMode}`
                : command.type === "thread.interaction-mode.set"
                  ? `${command.threadId}:interaction:${command.interactionMode}`
                  : command.type,
        );
        assert.deepStrictEqual(
          changes.toSorted(),
          [
            "sync-default:interaction:plan",
            "sync-default:model:gpt-6-nova",
            "sync-default:runtime:auto-accept-edits",
            "sync-own-model:interaction:plan",
            "sync-own-model:runtime:auto-accept-edits",
            `${homeId}:interaction:plan`,
            `${homeId}:model:gpt-6-nova`,
            `${homeId}:title:Scholar`,
          ].toSorted(),
        );
      }).pipe(Effect.provide(layer));
    }),
);
