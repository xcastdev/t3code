import * as WorkStream from "./ProjectWorkStream.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SetupScripts from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerSettingsError } from "@t3tools/contracts";
import { ManagedSkillId, ManagedSkillKey, SkillContentHash } from "@t3tools/contracts";
import {
  ResourceInstructionComposition,
  composeInstructionSnapshot,
} from "../orchestration-v2/ResourceInstructionComposition.ts";
import { assert, it } from "@effect/vitest";
import {
  canonicalProjectWorkPayload,
  AuthSessionId,
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectWorkTaskId,
  ProviderDriverKind,
  type ProjectTeamDispatchIntent,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Runtime from "./ProjectWorkRuntime.ts";
import * as Gateway from "./ProjectWorkGateway.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Admission from "../orchestration-v2/RunAdmission.ts";
import * as WorkAdmission from "./ProjectWorkRunAdmission.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import * as Dispatch from "./ProjectTeamDispatch.ts";
import { planMailboxClaim } from "./ProjectTeamMailboxTurns.ts";
import * as Journal from "./ProjectTeamDispatchJournal.ts";
import { runtimeExternalServices } from "./ProjectWorkWorkflow.testkit.ts";
import { makeHarness, projectId, modelSelection } from "./ProjectTeamDispatch.testkit.ts";

const workDeadline = (expiresAt: string | null) => {
  if (expiresAt === null) throw new Error("A Work owner must retain its deadline.");
  return expiresAt;
};

const at = "2026-01-01T00:00:00.000Z";
const attribution = {
  actor: { kind: "human" as const, id: "maintainer" },
  source: { kind: "web" as const, id: "client" },
  recordedAt: at,
};
const setup = (
  options: Pick<
    Parameters<typeof makeHarness>[0],
    "runSetup" | "closeTerminal" | "closeAndDrain" | "generateBranchName"
  > = {},
) => {
  const harness = makeHarness({
    ...options,
    providers: [
      {
        instanceId: modelSelection.instanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: at,
        models: [
          { slug: modelSelection.model, name: "Test model", isCustom: false, capabilities: null },
        ],
        slashCommands: [],
        skills: [],
      },
    ],
  });
  const base = Layer.mergeAll(
    Repository.ProjectWorkRepositoryLive,
    WorkAdmission.layer,
    Journal.layer,
  ).pipe(Layer.provideMerge(harness.layer));
  const environment = Layer.mock(Environment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(EnvironmentId.make("dispatch-environment")),
  });
  return { ...harness, base: base.pipe(Layer.provideMerge(environment)) };
};
const seed = Effect.fn("DispatchIntegration.seed")(function* (
  workspace: ProjectTeamDispatchIntent["workspace"] = { type: "root" },
) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* Repository.ProjectWorkRepository;
  yield* (yield* Projects.ProjectStoreV2).apply({
    sequence: 1,
    eventId: EventId.make("dispatch-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Dispatch project",
      workspaceRoot: "/repo",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const rootTaskId = ProjectWorkTaskId.make("root");
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    commandId: CommandId.make("root-create"),
    taskId: rootTaskId,
    title: "Investigate dispatch",
    createdAt: at,
  });
  let state = yield* Repository.readCurrentState(sql, projectId);
  yield* repository.execute({
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make("investigate"),
    expectedRevision: state.revision,
    attribution,
    committedAt: at,
    records: [],
    guided: {
      intent: {
        type: "project-team.investigation.start",
        projectId,
        commandId: CommandId.make("investigate"),
        expectedRevision: state.revision,
        taskId: rootTaskId,
        expectedTaskRevision: state.tasks[0]!.revision,
        objective: "Investigate the cause",
        outputDescriptions: ["Evidence and findings"],
      },
    },
  });
  state = yield* Repository.readCurrentState(sql, projectId);
  const task = state.tasks.find((task) => task.taskId !== rootTaskId)!;
  const role = state.foundationRecords!.find((record) => record.kind === "role-revision");
  const grant = state.foundationRecords!.find(
    (record) => record.kind === "gate" && record.taskId === task.taskId,
  );
  if (role?.kind !== "role-revision" || grant?.kind !== "gate")
    return yield* Effect.die("Missing investigation records");
  const member: Extract<ProjectTeamRecord, { kind: "member" }> = {
    kind: "member",
    projectId,
    recordId: "investigator-member",
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "active",
    name: "Investigator",
    coordinator: false,
    roleRevisionId: role.recordId,
  };
  yield* sql.withTransaction(
    Repository.appendAdmissionFoundationRecords(
      sql,
      projectId,
      "configure-member",
      [
        { ...role, revision: role.revision + 1, model: modelSelection.model, delegationDepth: 2 },
        member,
      ],
      at,
    ),
  );
  state = yield* Repository.readCurrentState(sql, projectId);
  return {
    type: "project-team.dispatch",
    projectId,
    commandId: CommandId.make("dispatch-assignment"),
    expectedRevision: state.revision,
    taskId: task.taskId,
    expectedTaskRevision: task.revision,
    memberId: member.recordId,
    expectedMemberRevision: member.revision,
    authorizationGateId: grant.recordId,
    expectedGateRevision: grant.revision,
    modelSelection,
    workspace,
  } satisfies ProjectTeamDispatchIntent;
});
const inspect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* Repository.readCurrentState(sql, projectId);
  const binding = state.foundationRecords!.find((record) => record.kind === "run-binding");
  if (binding?.kind !== "run-binding") return yield* Effect.die("Missing owned binding");
  const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
    binding.threadId,
  );
  return { sql, state, binding, projection };
});

const awaitPreparation = Effect.gen(function* () {
  const { binding } = yield* inspect;
  const threads = yield* Threads.ThreadManagementService;
  const event = yield* threads
    .streamStoredEventsFrom({
      threadId: binding.threadId,
      afterSequence: 0,
      eventType: "run.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          ["starting", "failed"].includes(stored.event.payload.status),
      ),
      Stream.runHead,
    );
  assert.isTrue(Option.isSome(event));
  return yield* inspect;
});

it.effect(
  "approved assignment launches exactly one owned thread, message and run across exact retries",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const input = yield* seed();
      const dispatch = yield* Dispatch.ProjectTeamDispatch;
      const first = yield* dispatch.dispatch(input, attribution);
      assert.deepEqual(yield* dispatch.dispatch(input, attribution), first);
      yield* dispatch.recover;
      const { sql, state, binding, projection } = yield* awaitPreparation;
      assert.equal(
        (yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
        1,
      );
      assert.equal(state.attempts.length, 1);
      assert.equal(projection.messages.length, 1);
      assert.equal(projection.runs.length, 1);
      assert.equal(binding.taskId, input.taskId);
      assert.equal(binding.worktree, "/repo");
      assert.isNull(projection.thread.worktreePath);
      assert.equal(binding.threadId, projection.thread.id);
      assert.equal(binding.runId, projection.runs[0]!.id);
      if (binding.runId === undefined) return assert.fail("Missing admitted run");
      const rows = yield* sql<{
        thread_id: string;
        run_id: string;
      }>`SELECT thread_id,run_id FROM t3_workflow_v2_run_admissions WHERE run_id IS NOT NULL`;
      assert.deepEqual(rows, [{ thread_id: binding.threadId, run_id: binding.runId }]);
      const receipt = yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(
        CommandId.make(`${binding.recordId.slice(0, -8)}:initial-message`),
      );
      assert.isTrue(Option.isSome(receipt));
      if (Option.isSome(receipt)) assert.equal(receipt.value.status, "accepted");
    }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
  },
);

it.effect("recovery observes canonical acceptance after the launch result is lost", () => {
  const harness = setup();
  const interceptedLaunch = Layer.effect(
    Launch.ThreadLaunchService,
    Effect.gen(function* () {
      const real = yield* Launch.ThreadLaunchService;
      const calls = yield* Ref.make(0);
      return Launch.ThreadLaunchService.of({
        ...real,
        launch: (input) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (n) => n + 1);
            const result = yield* real.launch(input);
            if ((yield* Ref.get(calls)) === 1)
              return yield* new Launch.ThreadLaunchError({
                operation: "read-receipt",
                commandId: input.commandId,
                projectId: input.projectId,
                cause: "accepted result lost",
              });
            return result;
          }),
      });
    }),
  ).pipe(Layer.provide(harness.base));
  return Effect.gen(function* () {
    const input = yield* seed();
    const dispatch = yield* Dispatch.ProjectTeamDispatch;
    const failed = yield* Effect.result(dispatch.dispatch(input, attribution));
    assert.equal(failed._tag, "Failure");
    const before = yield* awaitPreparation;
    const journal = yield* Journal.ProjectTeamDispatchJournal;
    assert.deepEqual(yield* journal.recoverable(), [before.binding.recordId.slice(0, -8)]);
    yield* dispatch.recover;
    yield* dispatch.dispatch(input, attribution);
    const after = yield* inspect;
    assert.deepEqual(after.projection.runs, before.projection.runs);
    assert.deepEqual(after.projection.messages, before.projection.messages);
    assert.equal(after.state.attempts.length, 1);
    assert.deepEqual(yield* journal.recoverable(), []);
    assert.equal((yield* after.sql`SELECT * FROM orchestration_v2_projection_threads`).length, 1);
    assert.equal(
      (yield* after.sql`SELECT * FROM t3_workflow_v2_run_admissions WHERE run_id IS NOT NULL`)
        .length,
      1,
    );
  }).pipe(
    Effect.provide(
      Dispatch.layer.pipe(Layer.provideMerge(Layer.merge(harness.base, interceptedLaunch))),
    ),
  );
});

it.effect("the prepared task worktree agrees with its owned binding and V2 thread", () => {
  const harness = setup();
  return Effect.gen(function* () {
    const input = yield* seed({ type: "worktree", baseRef: "main" });
    yield* (yield* Dispatch.ProjectTeamDispatch).dispatch(input, attribution);
    const { binding, projection } = yield* awaitPreparation;
    assert.equal(harness.createWorktree.mock.calls.length, 1);
    assert.equal(binding.worktree, "/repo-worktrees/feature");
    assert.equal(binding.worktree, projection.thread.worktreePath);
    assert.equal(binding.branch, projection.thread.branch);
    assert.equal(binding.taskId, input.taskId);
    assert.equal(binding.runId, projection.runs[0]!.id);
    assert.equal(harness.runSetup.mock.calls[0]?.[0].threadId, binding.threadId);
  }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
});

it.effect.each(["revoked", "expired"] as const)(
  "%s authority blocks admission at delayed native start",
  (reason) => {
    const harness = setup();
    return Effect.gen(function* () {
      const input = yield* seed();
      yield* (yield* Dispatch.ProjectTeamDispatch).dispatch(input, attribution);
      const { sql, binding, projection } = yield* awaitPreparation;
      const admission = yield* Admission.RunAdmission;
      const now = DateTime.formatIso(yield* DateTime.now);
      const check = {
        threadId: binding.threadId,
        runId: projection.runs[0]!.id,
        now,
        operation: "start" as const,
      };
      const admitted = yield* admission.check(check);
      assert.equal(admitted._tag, "admitted");
      if (admitted._tag !== "admitted") return;
      if (reason === "revoked")
        yield* sql.withTransaction(
          Repository.appendAdmissionFoundationRecords(
            sql,
            projectId,
            "revoke-binding",
            [{ ...binding, revision: binding.revision + 1, status: "revoked" }],
            now,
          ),
        );
      const blocked = yield* admission.check({
        ...check,
        now: reason === "expired" ? workDeadline(admitted.owner.expiresAt) : now,
      });
      assert.equal(blocked._tag, reason === "expired" ? "expired" : "denied");
      assert.equal(
        (yield* sql`SELECT * FROM t3_workflow_v2_run_admissions WHERE run_id IS NOT NULL`).length,
        1,
      );
    }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
  },
);

it.effect("production runtime human gateway dispatch reaches canonical V2 admission", () => {
  const harness = setup();
  const runtime = Runtime.executionLayer.pipe(
    Layer.provideMerge(AuthSessions.layer),
    Layer.provideMerge(harness.base),
    Layer.provide(runtimeExternalServices(harness)),
  );
  return Effect.gen(function* () {
    const input = yield* seed();
    yield* (yield* AuthSessions.AuthSessionRepository).create({
      sessionId: AuthSessionId.make("client"),
      subject: "maintainer",
      scopes: [AuthOrchestrationOperateScope],
      method: "browser-session-cookie",
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "unknown",
        os: null,
        browser: null,
      },
      issuedAt: DateTime.makeUnsafe(at),
      expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
    });
    const gateway = yield* Gateway.ProjectWorkGateway;
    yield* gateway.write(input, {
      actor: attribution.actor,
      source: attribution.source,
      projectId,
      environmentId: EnvironmentId.make("dispatch-environment"),
    });
    const { binding, projection } = yield* awaitPreparation;
    assert.equal(binding.taskId, input.taskId);
    assert.equal(binding.runId, projection.runs[0]!.id);
    assert.equal(binding.workspaceState, "ready");
    assert.equal(projection.messages.length, 1);
  }).pipe(Effect.provide(runtime));
});

it.effect(
  "an older uncertain mailbox message blocks a new queued message without creating a V2 turn",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const input = yield* seed();
      const dispatch = yield* Dispatch.ProjectTeamDispatch;
      yield* dispatch.dispatch(input, attribution);
      const { sql, binding, projection } = yield* awaitPreparation;
      const fields = {
        kind: "message" as const,
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        senderId: "coordinator",
        recipientId: binding.memberId,
        taskId: binding.taskId,
        body: "Mailbox follow-up",
        evidenceIds: [],
        deliveryGeneration: binding.generation,
        deliveryCursor: 0,
      };
      yield* sql.withTransaction(
        Repository.appendAdmissionFoundationRecords(
          sql,
          projectId,
          "seed-blocked-mailbox",
          [
            {
              ...fields,
              recordId: "old-uncertain",
              commandId: "old-command",
              status: "uncertain",
              deliveryCursor: 1,
            },
            { ...fields, recordId: "new-queued", commandId: "new-command", status: "queued" },
          ],
          at,
        ),
      );
      yield* dispatch.mailbox;
      const after = yield* inspect;
      assert.deepEqual(
        after.projection.runs.map((run) => run.id),
        projection.runs.map((run) => run.id),
      );
      assert.deepEqual(after.projection.messages, projection.messages);
      assert.equal(
        after.state.foundationRecords!.find((record) => record.recordId === "new-queued")?.status,
        "queued",
      );
      assert.isFalse(
        after.state.foundationRecords!.some(
          (record) => record.kind === "effect" && record.effectKind === "mailbox-wake",
        ),
      );
    }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
  },
);

it.effect(
  "stop reconciliation drains a reserved binding while launch acceptance remains unresolved",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const blockedLaunch = Layer.effect(
        Launch.ThreadLaunchService,
        Effect.gen(function* () {
          const real = yield* Launch.ThreadLaunchService;
          return Launch.ThreadLaunchService.of({
            ...real,
            launch: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          });
        }),
      ).pipe(Layer.provide(harness.base));
      yield* Effect.gen(function* () {
        const input = yield* seed();
        const dispatch = yield* Dispatch.ProjectTeamDispatch;
        const launching = yield* dispatch.dispatch(input, attribution).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const sql = yield* SqlClient.SqlClient;
        const state = yield* Repository.readCurrentState(sql, projectId);
        const task = state.tasks.find((task) => task.taskId === input.taskId)!;
        yield* (yield* Repository.ProjectWorkRepository).execute({
          type: "project-work.foundation.commit",
          projectId,
          commandId: CommandId.make("pause-unresolved-launch"),
          expectedRevision: state.revision,
          attribution,
          committedAt: at,
          records: [],
          guided: {
            intent: {
              type: "project-team.task.control",
              projectId,
              taskId: input.taskId,
              commandId: CommandId.make("pause-unresolved-launch"),
              expectedRevision: state.revision,
              expectedTaskRevision: task.revision,
              control: { action: "pause", reason: "Stop unresolved launch" },
            },
          },
        });
        yield* dispatch.reconcile;
        const stopped = yield* Repository.readCurrentState(sql, projectId);
        assert.equal(
          stopped.foundationRecords!.find((record) => record.kind === "run-binding")?.status,
          "settled",
        );
        assert.equal((yield* sql`SELECT * FROM orchestration_v2_projection_threads`).length, 0);
        yield* Fiber.interrupt(launching);
      }).pipe(
        Effect.provide(
          Dispatch.layer.pipe(Layer.provideMerge(Layer.merge(harness.base, blockedLaunch))),
        ),
      );
    }).pipe(Effect.scoped);
  },
);

it.effect(
  "mailbox recovery reuses the exact accepted V2 operation after its reflection was lost",
  () => {
    const harness = setup();
    return Effect.gen(function* () {
      const input = yield* seed();
      const dispatch = yield* Dispatch.ProjectTeamDispatch;
      yield* dispatch.dispatch(input, attribution);
      const { sql, binding } = yield* awaitPreparation;
      const message: Extract<ProjectTeamRecord, { kind: "message" }> = {
        kind: "message",
        projectId,
        recordId: "recover-mailbox-message",
        commandId: "send-mailbox",
        revision: 0,
        generation: 0,
        updatedAt: at,
        senderId: "coordinator",
        recipientId: binding.memberId,
        taskId: binding.taskId,
        body: "Retained follow-up",
        evidenceIds: [],
        deliveryGeneration: binding.generation,
        deliveryCursor: 0,
        status: "queued",
      };
      yield* sql.withTransaction(
        Repository.appendAdmissionFoundationRecords(
          sql,
          projectId,
          "seed-mailbox-recovery",
          [message],
          at,
        ),
      );
      const state = yield* Repository.readCurrentState(sql, projectId);
      const operationId = "accepted-mailbox-operation";
      const claim = planMailboxClaim(state, {
        bindingId: binding.recordId,
        generation: binding.generation,
        operationId,
        at,
      });
      yield* sql.withTransaction(
        Repository.appendAdmissionFoundationRecords(sql, projectId, operationId, claim, at),
      );
      const threads = yield* Threads.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(operationId),
        threadId: binding.threadId,
        messageId: MessageId.make(`${operationId}:message`),
        text: canonicalProjectWorkPayload({
          kind: "project-work.mailbox",
          messageId: message.recordId,
          senderId: message.senderId,
          body: message.body,
          evidenceIds: message.evidenceIds,
        }),
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "mcp",
      });
      const accepted = yield* inspect;
      yield* dispatch.mailbox;
      yield* dispatch.mailbox;
      const recovered = yield* inspect;
      assert.deepEqual(recovered.projection.messages, accepted.projection.messages);
      assert.deepEqual(
        recovered.projection.runs.map((run) => run.id),
        accepted.projection.runs.map((run) => run.id),
      );
      assert.equal(
        recovered.state.foundationRecords!.find((record) => record.recordId === message.recordId)
          ?.status,
        "delivered",
      );
      assert.equal(
        recovered.state.foundationRecords!.find((record) => record.recordId === operationId)
          ?.status,
        "succeeded",
      );
    }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
  },
);

it.effect(
  "stop joins canonical setup interruption and exact terminal cleanup before settling Work",
  () =>
    Effect.gen(function* () {
      const setupEntered = yield* Deferred.make<void>();
      const setupInterrupted = yield* Deferred.make<void>();
      const closeEntered = yield* Deferred.make<void>();
      const allowClose = yield* Deferred.make<void>();
      const harness = setup({
        closeAndDrain: () =>
          Deferred.succeed(closeEntered, undefined).pipe(
            Effect.andThen(Deferred.await(allowClose)),
          ),
        runSetup: (input) =>
          Effect.gen(function* () {
            if (input.onTerminalAllocated === undefined)
              return yield* Effect.die("Missing canonical capture callback");
            yield* input.onTerminalAllocated("held-setup-terminal", {
              threadId: input.threadId,
              terminalId: "held-setup-terminal",
            });
            return {
              status: "started",
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "held setup",
              terminalId: "held-setup-terminal",
              cwd: "/repo-worktrees/feature",
              async: false,
              completion: Deferred.succeed(setupEntered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.onInterrupt(() => Deferred.succeed(setupInterrupted, undefined)),
              ),
            };
          }),
      });
      yield* Effect.gen(function* () {
        const input = yield* seed({ type: "worktree", baseRef: "main" });
        const dispatch = yield* Dispatch.ProjectTeamDispatch;
        yield* dispatch.dispatch(input, attribution);
        yield* Deferred.await(setupEntered);
        const { sql, binding } = yield* inspect;
        const state = yield* Repository.readCurrentState(sql, projectId);
        const task = state.tasks.find((task) => task.taskId === input.taskId)!;
        yield* (yield* Repository.ProjectWorkRepository).execute({
          type: "project-work.foundation.commit",
          projectId,
          commandId: CommandId.make("pause-held-setup"),
          expectedRevision: state.revision,
          attribution,
          committedAt: at,
          records: [],
          guided: {
            intent: {
              type: "project-team.task.control",
              projectId,
              taskId: input.taskId,
              commandId: CommandId.make("pause-held-setup"),
              expectedRevision: state.revision,
              expectedTaskRevision: task.revision,
              control: { action: "pause", reason: "Cancel setup" },
            },
          },
        });
        yield* dispatch.reconcile;
        yield* Deferred.await(closeEntered);
        const closing = yield* Repository.readCurrentState(sql, projectId);
        assert.notEqual(
          closing.foundationRecords!.find((record) => record.recordId === binding.recordId)?.status,
          "settled",
        );
        const launches = yield* Launch.ThreadLaunchService;
        const preparationChanged = yield* Stream.toPull(
          launches.preparationChanges.pipe(
            Stream.filter((threadId) => threadId === binding.threadId),
          ),
        );
        const preparationFinished = yield* preparationChanged.pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* Deferred.succeed(allowClose, undefined);
        yield* Fiber.join(preparationFinished);
        yield* dispatch.reconcile;
        assert.isTrue(yield* Deferred.isDone(setupInterrupted));
        assert.deepEqual(
          harness.closeAndDrain.mock.calls.map(([input]) => input),
          [
            {
              threadId: binding.threadId,
              terminalId: "held-setup-terminal",
              capture: { threadId: binding.threadId, terminalId: "held-setup-terminal" },
              deleteHistory: true,
            },
          ],
        );
        assert.equal(harness.closeTerminal.mock.calls.length, 0);
        const stopped = yield* Repository.readCurrentState(sql, projectId);
        assert.equal(
          stopped.foundationRecords!.find((record) => record.recordId === binding.recordId)?.status,
          "settled",
        );
      }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
    }).pipe(Effect.scoped),
);

it.effect(
  "selected skills are prepared at the canonical worktree before a managed run is released",
  () => {
    const harness = setup();
    const roots: Array<string> = [];
    const composition = ResourceInstructionComposition.of({
      compose: (input) =>
        Effect.sync(() => {
          roots.push(input.resourceRoot);
          return {
            catalogRevision: 0,
            snapshot: composeInstructionSnapshot(input, [
              {
                id: ManagedSkillId.make("review"),
                key: ManagedSkillKey.make("review"),
                hash: SkillContentHash.make("a".repeat(64)),
                revision: 1,
                body: "Prepared skill body",
                packagePath: "/managed/review",
              },
            ]),
          };
        }),
    });
    return Effect.gen(function* () {
      const initial = yield* seed({ type: "worktree", baseRef: "main" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO t3_workflow_v2_skill_catalog_revision(id,revision) VALUES (1,0)`;
      const before = yield* Repository.readCurrentState(sql, projectId);
      const member = before.foundationRecords?.find(
        (record) => record.kind === "member" && record.recordId === initial.memberId,
      );
      const role = before.foundationRecords?.find(
        (record) =>
          record.kind === "role-revision" &&
          record.recordId === (member?.kind === "member" ? member.roleRevisionId : undefined),
      );
      if (role?.kind !== "role-revision") return yield* Effect.die("Missing role fixture");
      yield* sql.withTransaction(
        Repository.appendAdmissionFoundationRecords(
          sql,
          projectId,
          "select-managed-skill",
          [{ ...role, revision: role.revision + 1, skills: ["review"] }],
          at,
        ),
      );
      const state = yield* Repository.readCurrentState(sql, projectId);
      const dispatch = yield* Dispatch.ProjectTeamDispatch;
      yield* dispatch.dispatch({ ...initial, expectedRevision: state.revision }, attribution);
      const prepared = yield* awaitPreparation;
      assert.equal(prepared.projection.runs[0]?.status, "starting");
      assert.equal(prepared.binding.workspaceState, "ready");
      assert.deepEqual(roots, ["/repo-worktrees/feature"]);
      const admitted = yield* (yield* Admission.RunAdmission).check({
        threadId: prepared.binding.threadId,
        runId: prepared.projection.runs[0]!.id,
        now: DateTime.formatIso(yield* DateTime.now),
        operation: "start",
      });
      assert.equal(admitted._tag, "admitted");
      if (admitted._tag === "admitted")
        assert.include(
          admitted.owner.configuration.instructionSnapshot?.roleInstructions ?? "",
          "Prepared skill body",
        );
    }).pipe(
      Effect.provide(
        Dispatch.layer.pipe(
          Layer.provideMerge(harness.base),
          Layer.provide(Layer.succeed(ResourceInstructionComposition, composition)),
        ),
      ),
    );
  },
);

it.effect("stopped branch naming is joined before drain and cannot mutate settled Work", () =>
  Effect.gen(function* () {
    const namingEntered = yield* Deferred.make<void>();
    const allowNaming = yield* Deferred.make<void>();
    const cancellationEntered = yield* Deferred.make<void>();
    const allowCancellation = yield* Deferred.make<void>();
    const harness = setup({
      generateBranchName: () =>
        Deferred.succeed(namingEntered, undefined).pipe(
          Effect.andThen(Deferred.await(allowNaming)),
          Effect.as({ branch: "late-assignment-branch" }),
          Effect.onInterrupt(() =>
            Deferred.succeed(cancellationEntered, undefined).pipe(
              Effect.andThen(Deferred.await(allowCancellation)),
            ),
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const input = yield* seed({ type: "worktree", baseRef: "main" });
      const dispatch = yield* Dispatch.ProjectTeamDispatch;
      yield* dispatch.dispatch(input, attribution);
      yield* Deferred.await(namingEntered);
      const prepared = yield* awaitPreparation;
      const runId = prepared.projection.runs[0]!.id;
      const launches = yield* Launch.ThreadLaunchService;
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const drainedId = CommandId.make(
        `v2-preparation-drained:${prepared.binding.threadId}:${runId}`,
      );
      const changed = yield* Stream.toPull(
        launches.preparationChanges.pipe(
          Stream.filter((threadId) => threadId === prepared.binding.threadId),
          Stream.filterEffect(() =>
            receipts.getByCommandId(drainedId).pipe(Effect.map(Option.isSome)),
          ),
        ),
      );
      const finished = yield* changed.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* (yield* Admission.RunAdmission).settle({
        threadId: prepared.binding.threadId,
        runId,
        now: DateTime.formatIso(yield* DateTime.now),
      });
      yield* dispatch.reconcile;
      yield* Deferred.await(cancellationEntered);
      assert.notEqual((yield* inspect).binding.status, "settled");
      assert.isTrue(Option.isNone(yield* receipts.getByCommandId(drainedId)));
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      yield* Deferred.succeed(allowCancellation, undefined);
      yield* Fiber.join(finished);
      yield* dispatch.reconcile;
      const stopped = yield* inspect;
      assert.equal(stopped.binding.status, "settled");
      assert.isTrue(Option.isSome(yield* receipts.getByCommandId(drainedId)));
      assert.equal(stopped.projection.thread.branch, prepared.projection.thread.branch);
      yield* Deferred.succeed(allowNaming, undefined);
      const afterLateResult = yield* inspect;
      assert.equal(harness.renameBranch.mock.calls.length, 0);
      assert.equal(afterLateResult.projection.thread.branch, stopped.projection.thread.branch);
      assert.isFalse(yield* launches.preparationActive(stopped.binding.threadId));
    }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
  }).pipe(Effect.scoped),
);

it.effect(
  "successful managed background setup retains its captured process until Work drains",
  () =>
    Effect.gen(function* () {
      const drainEntered = yield* Deferred.make<void>();
      const allowDrain = yield* Deferred.make<void>();
      const harness = setup({
        closeAndDrain: () =>
          Deferred.succeed(drainEntered, undefined).pipe(
            Effect.andThen(Deferred.await(allowDrain)),
          ),
        runSetup: (input) =>
          Effect.gen(function* () {
            if (input.onTerminalAllocated === undefined)
              return yield* Effect.die("Missing canonical capture callback");
            yield* input.onTerminalAllocated("background-setup-terminal", {
              threadId: input.threadId,
              terminalId: "background-setup-terminal",
            });
            return {
              status: "started",
              scriptId: "background",
              scriptName: "Background",
              scriptCommand: "start service",
              terminalId: "background-setup-terminal",
              cwd: "/repo-worktrees/feature",
              async: true,
              completion: Effect.succeed({ exitCode: 0, durationMs: 0 }),
            };
          }),
      });
      yield* Effect.gen(function* () {
        const input = yield* seed({ type: "worktree", baseRef: "main" });
        const dispatch = yield* Dispatch.ProjectTeamDispatch;
        yield* dispatch.dispatch(input, attribution);
        const prepared = yield* awaitPreparation;
        yield* (yield* WorktreeSetupTracker.WorktreeSetupTracker)
          .stream(prepared.binding.threadId)
          .pipe(
            Stream.filter((snapshot) => snapshot?.phase === "done"),
            Stream.runHead,
          );
        assert.equal(harness.closeAndDrain.mock.calls.length, 0);
        assert.equal(harness.closeTerminal.mock.calls.length, 0);
        const receipts = yield* Receipts.CommandReceiptStoreV2;
        const runId = prepared.projection.runs[0]!.id;
        const drainedId = CommandId.make(
          `v2-preparation-drained:${prepared.binding.threadId}:${runId}`,
        );
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(drainedId)));
        const launches = yield* Launch.ThreadLaunchService;
        const changed = yield* Stream.toPull(
          launches.preparationChanges.pipe(
            Stream.filter((threadId) => threadId === prepared.binding.threadId),
            Stream.filterEffect(() =>
              receipts.getByCommandId(drainedId).pipe(Effect.map(Option.isSome)),
            ),
          ),
        );
        const finished = yield* changed.pipe(Effect.forkScoped({ startImmediately: true }));
        yield* (yield* Admission.RunAdmission).settle({
          threadId: prepared.binding.threadId,
          runId,
          now: DateTime.formatIso(yield* DateTime.now),
        });
        yield* dispatch.reconcile;
        yield* Deferred.await(drainEntered);
        assert.notEqual((yield* inspect).binding.status, "settled");
        assert.isTrue(Option.isNone(yield* receipts.getByCommandId(drainedId)));
        yield* Deferred.succeed(allowDrain, undefined);
        yield* Fiber.join(finished);
        yield* dispatch.reconcile;
        assert.equal((yield* inspect).binding.status, "settled");
        assert.isTrue(Option.isSome(yield* receipts.getByCommandId(drainedId)));
        assert.deepEqual(
          harness.closeAndDrain.mock.calls.map(([input]) => input),
          [
            {
              threadId: prepared.binding.threadId,
              terminalId: "background-setup-terminal",
              capture: {
                threadId: prepared.binding.threadId,
                terminalId: "background-setup-terminal",
              },
              deleteHistory: false,
            },
          ],
        );
      }).pipe(Effect.provide(Dispatch.layer.pipe(Layer.provideMerge(harness.base))));
    }).pipe(Effect.scoped),
);

it.effect(
  "a known Runner settings failure releases Work without allocating a setup terminal",
  () => {
    let allocations = 0;
    const runnerServices = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.fail(
          new ServerSettingsError({ settingsPath: "<test>", operation: "read-file" }),
        ),
      }),
      Layer.mock(TerminalManager.TerminalManager)({
        openCaptured: () =>
          Effect.sync(() => {
            allocations += 1;
          }).pipe(Effect.andThen(Effect.die("Unexpected terminal allocation"))),
      }),
    );
    const harness = setup({
      runSetup: (input) =>
        SetupScripts.make.pipe(
          Effect.flatMap((runner) =>
            runner.runForThread({
              ...input,
              project: {
                id: projectId,
                workspaceRoot: "/repo",
                scripts: [
                  {
                    id: "install",
                    name: "Install",
                    command: "install",
                    icon: "configure",
                    runOnWorktreeCreate: true,
                  },
                ],
              },
            }),
          ),
          Effect.provide(runnerServices),
        ),
    });
    const runtime = Runtime.executionLayer.pipe(
      Layer.provideMerge(AuthSessions.layer),
      Layer.provideMerge(harness.base),
      Layer.provide(runtimeExternalServices(harness)),
    );
    return Effect.gen(function* () {
      const input = yield* seed({ type: "worktree", baseRef: "main" });
      yield* (yield* AuthSessions.AuthSessionRepository).create({
        sessionId: AuthSessionId.make("client"),
        subject: "maintainer",
        scopes: [AuthOrchestrationOperateScope],
        method: "browser-session-cookie",
        client: {
          label: null,
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
        },
        issuedAt: DateTime.makeUnsafe(at),
        expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
      });
      const launches = yield* Launch.ThreadLaunchService;
      const preparationFinished = yield* launches.preparationChanges.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* (yield* Gateway.ProjectWorkGateway).write(input, {
        actor: attribution.actor,
        source: attribution.source,
        projectId,
        environmentId: EnvironmentId.make("dispatch-environment"),
      });
      const failed = yield* awaitPreparation;
      assert.equal(failed.projection.runs[0]?.status, "failed");
      yield* Fiber.join(preparationFinished);
      const receipt = yield* (yield* Receipts.CommandReceiptStoreV2).getByCommandId(
        CommandId.make(`v2-preparation-drained:${failed.binding.threadId}:${failed.binding.runId}`),
      );
      assert.isTrue(Option.isSome(receipt));
      assert.equal(allocations, 0);
      assert.equal(harness.closeAndDrain.mock.calls.length, 0);
      const changes = yield* (yield* WorkStream.ProjectWorkStream).stream({
        projectId,
        afterCursor: 0,
      });
      yield* changes.pipe(
        Stream.filterEffect((item) =>
          item.kind === "delta"
            ? inspect.pipe(Effect.map(({ binding }) => binding.status === "settled"))
            : Effect.succeed(false),
        ),
        Stream.runHead,
      );
      const after = yield* inspect;
      assert.equal(after.binding.status, "settled");
      assert.equal(after.projection.runs[0]?.status, "failed");
      assert.equal(after.projection.runs.length, 1);
    }).pipe(Effect.provide(runtime));
  },
);
