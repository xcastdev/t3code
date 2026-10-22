// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture digest is a pure synchronous value.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, RunId, ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { assistantRoutineMigration } from "../persistence/AssistantRoutineMigration.ts";
import { AssistantRepository } from "./AssistantRepository.ts";
import * as Routines from "./AssistantRoutineRepository.ts";
import { input, repository } from "./AssistantTestHelpers.ts";

const storage = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE scheduled_tasks(task_id TEXT PRIMARY KEY,project_id TEXT,thread_id TEXT,enabled INTEGER,last_run_status TEXT)`;
    yield* sql`CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY,workspace_root TEXT,deleted_at TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,project_id TEXT,deleted_at TEXT,archived_at TEXT,payload_json TEXT)`;
    yield* sql`CREATE TABLE orchestration_command_receipts(command_id TEXT PRIMARY KEY,aggregate_kind TEXT,aggregate_id TEXT,status TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY,thread_id TEXT,run_id TEXT,payload_json TEXT NOT NULL DEFAULT '{}')`;
    yield* sql`CREATE TABLE orchestration_v2_projection_runs(run_id TEXT PRIMARY KEY,thread_id TEXT,status TEXT)`;
    yield* sql`CREATE TABLE orchestration_events(stream_id TEXT,metadata_json TEXT,sequence INTEGER,aggregate_kind TEXT,command_id TEXT)`;
    for (const statement of assistantRoutineMigration.statements) yield* sql.unsafe(statement);
  }),
);
const layer = Routines.layer.pipe(Layer.provideMerge(storage.pipe(Layer.provideMerge(repository))));
const taskId = ScheduledTaskId.make("routine");
const setup = Effect.fn("AssistantRoutinesTest.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* AssistantRepository;
  const routines = yield* Routines.AssistantRoutineRepository;
  const record = yield* repo.create(input);
  const scope = record.detail.summary;
  const binding = scope.binding;
  yield* repo.setProvisioning(scope, { state: "ready", binding }, "/assistant-home");
  yield* sql`INSERT INTO projection_projects VALUES(${binding.backingProjectId},'/assistant-home',NULL)`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${binding.canonicalThreadId},${binding.backingProjectId},NULL,NULL,'{}')`;
  yield* sql`INSERT INTO scheduled_tasks VALUES(${taskId},${binding.backingProjectId},${binding.canonicalThreadId},1,'never')`;
  yield* routines.bind({ ...scope, taskId, enabled: true });
  return { sql, repo, routines, scope, binding };
});
const fire = {
  taskId,
  fireKey: "fire-1",
  trigger: "scheduled" as const,
  triggerIdentity: "2026-10-21T10:00:00.000Z",
  commandId: CommandId.make("fire-command"),
  messageId: MessageId.make("fire-message"),
  promptHash: NodeCrypto.createHash("sha256").update("routine prompt").digest("hex"),
  startedAt: "2026-10-21T10:00:00.000Z",
};

it.effect(
  "persists the exact fire atomically with scheduler state and refuses duplicate identities",
  () =>
    Effect.gen(function* () {
      const { sql, routines, scope } = yield* setup();
      assert.equal((yield* routines.beginFire(fire).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* routines.listFires(scope)).length, 0);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* routines.beginFire(fire);
          yield* sql`UPDATE scheduled_tasks SET last_run_status='running' WHERE task_id=${taskId}`;
        }),
      );
      const stored = (yield* routines.listFires(scope))[0]!;
      assert.equal(stored.commandId, fire.commandId);
      assert.equal(stored.messageId, fire.messageId);
      assert.equal(stored.status, "uncertain");
      assert.equal(
        (yield* sql
          .withTransaction(
            routines.beginFire({
              ...fire,
              fireKey: "replacement",
              commandId: CommandId.make("replacement"),
              messageId: MessageId.make("replacement"),
            }),
          )
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* routines.listFires(scope)).length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "recovers accepted dispatch without callback and follows actual queued, waiting and late failure",
  () =>
    Effect.gen(function* () {
      const { sql, routines, scope, binding } = yield* setup();
      yield* sql.withTransaction(routines.beginFire(fire));
      yield* sql`INSERT INTO orchestration_command_receipts VALUES(${fire.commandId},'thread',${binding.canonicalThreadId},'accepted')`;
      assert.equal((yield* routines.listFires(scope))[0]!.status, "dispatched");
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id) VALUES(${fire.messageId},${binding.canonicalThreadId},'actual-run')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES('actual-run',${binding.canonicalThreadId},'queued')`;
      yield* sql`INSERT INTO t3_workflow_v2_assistant_admissions VALUES(${binding.canonicalThreadId},'actual-run',${scope.assistantId},7,'{}','now')`;
      let stored = (yield* routines.listFires(scope))[0]!;
      assert.equal(stored.runId, "actual-run");
      assert.equal(stored.status, "queued");
      assert.equal(stored.configurationRevision, 0);
      assert.equal(stored.admittedConfigurationRevision, 7);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='waiting'`;
      assert.equal((yield* routines.listFires(scope))[0]!.status, "waiting");
      yield* routines.markDispatched(fire.fireKey);
      yield* sql`UPDATE scheduled_tasks SET last_run_status='succeeded'`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='failed'`;
      stored = (yield* routines.listFires(scope))[0]!;
      assert.equal(stored.status, "failed");
      assert.equal(stored.dispatched, true);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "disable and archive retain history, fence new admissions, and restore leaves routines disabled",
  () =>
    Effect.gen(function* () {
      const { sql, repo, routines, scope } = yield* setup();
      yield* sql.withTransaction(routines.beginFire(fire));
      const disabled = yield* sql.withTransaction(
        Effect.gen(function* () {
          const result = yield* repo.lifecycle({
            ...scope,
            expectedRevision: scope.configurationRevision,
            commandId: CommandId.make("disable"),
            action: "disable",
          });
          yield* routines.suspend(scope);
          return result;
        }),
      );
      assert.equal((yield* routines.assertRunnable(taskId).pipe(Effect.result))._tag, "Failure");
      yield* repo.lifecycle({
        ...scope,
        expectedRevision: disabled.detail.configuration.revision,
        commandId: CommandId.make("restore"),
        action: "enable",
      });
      assert.equal((yield* routines.find(taskId))!.enabled, false);
      assert.equal((yield* routines.listFires(scope)).length, 1);
      yield* routines.setEnabled(scope, taskId, true);
      yield* sql`UPDATE scheduled_tasks SET enabled=1 WHERE task_id=${taskId}`;
      assert.isNotNull(yield* routines.assertRunnable(taskId));
      yield* routines.remove(scope, taskId);
      assert.equal((yield* routines.find(taskId))!.deleted, true);
      assert.equal((yield* routines.listFires(scope)).length, 1);
      assert.equal(
        (yield* routines.bind({ ...scope, taskId, enabled: true }).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("mutated or missing retained task targets pause instead of recreating homes", () =>
  Effect.gen(function* () {
    const { sql, routines, scope } = yield* setup();
    yield* sql`UPDATE scheduled_tasks SET thread_id='other-thread'`;
    const failed = yield* routines.assertRunnable(taskId).pipe(Effect.result);
    assert.equal(failed._tag, "Failure");
    if (failed._tag === "Failure") assert.equal(failed.failure.reason, "needs-repair");
    assert.equal((yield* routines.find(taskId))!.enabled, false);
    assert.equal(
      (yield* sql<{ enabled: number }>`SELECT enabled FROM scheduled_tasks`)[0]!.enabled,
      0,
    );
    assert.equal((yield* routines.listFires(scope)).length, 0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "fire persistence rolls back with markRunning and current queued guards close on individual disable",
  () =>
    Effect.gen(function* () {
      const { sql, routines, scope, binding } = yield* setup();
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* routines.beginFire(fire);
            return yield* Effect.fail("mark-running-failed");
          }),
        )
        .pipe(Effect.result);
      assert.equal(yield* routines.recoverTask(taskId), null);
      yield* sql.withTransaction(routines.beginFire(fire));
      yield* routines.assertAdmission({ ...fire, threadId: binding.canonicalThreadId });
      assert.equal(
        (yield* routines
          .assertAdmission({
            ...fire,
            threadId: binding.canonicalThreadId,
            promptHash: "other-prompt",
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* routines
          .assertAdmission({
            ...fire,
            threadId: binding.canonicalThreadId,
            commandId: CommandId.make("other-command"),
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,run_id) VALUES(${fire.messageId},${binding.canonicalThreadId},'queued-run')`;
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json='{"scheduledTaskId":"routine","text":"routine prompt"}' WHERE message_id=${fire.messageId}`;
      const queued = {
        runId: RunId.make("queued-run"),
        threadId: binding.canonicalThreadId,
        messageId: fire.messageId,
      };
      yield* routines.assertQueued(queued);
      yield* routines.setEnabled(scope, taskId, false);
      assert.equal(
        (yield* routines
          .assertAdmission({ ...fire, threadId: binding.canonicalThreadId })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal((yield* routines.assertQueued(queued).pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* routines.listFires(scope)).length, 1);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "restart recovers the retained receipt identity even when timestamps would generate another attempt",
  () =>
    Effect.gen(function* () {
      const { sql, routines, binding } = yield* setup();
      yield* sql.withTransaction(routines.beginFire(fire));
      let recovered = yield* routines.recoverTask(taskId);
      assert.equal(recovered?.receiptStatus, null);
      assert.equal(recovered?.status, "uncertain");
      yield* sql`INSERT INTO orchestration_command_receipts VALUES(${fire.commandId},'thread',${binding.canonicalThreadId},'accepted')`;
      recovered = yield* routines.recoverTask(taskId);
      assert.equal(recovered?.receiptStatus, "accepted");
      assert.equal(recovered?.commandId, fire.commandId);
      assert.equal(recovered?.messageId, fire.messageId);
      assert.equal(recovered?.fireKey, fire.fireKey);
      assert.equal(recovered?.dispatched, true);
      yield* sql`UPDATE orchestration_command_receipts SET status='rejected'`;
      recovered = yield* routines.recoverTask(taskId);
      assert.equal(recovered?.status, "failed");
    }).pipe(Effect.provide(layer)),
);

it.effect("simultaneous disable and fire share one SQL serialization boundary", () =>
  Effect.gen(function* () {
    const { sql, routines, scope } = yield* setup();
    const outcomes = yield* Effect.all(
      [
        sql.withTransaction(routines.beginFire(fire)).pipe(Effect.result),
        sql.withTransaction(routines.suspend(scope)).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );
    assert.equal(outcomes[1]!._tag, "Success");
    assert.equal((yield* routines.assertRunnable(taskId).pipe(Effect.result))._tag, "Failure");
    const fires = yield* routines.listFires(scope);
    assert.equal(fires.length, outcomes[0]!._tag === "Success" ? 1 : 0);
    assert.equal(
      (yield* sql<{ enabled: number }>`SELECT enabled FROM scheduled_tasks`)[0]!.enabled,
      0,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "exact old manual identity survives newer fires and missing marked fires cannot escape queued admission",
  () =>
    Effect.gen(function* () {
      const { sql, routines, binding } = yield* setup();
      const manual = { ...fire, trigger: "manual" as const, triggerIdentity: "manual-command" };
      yield* sql.withTransaction(routines.beginFire(manual));
      yield* sql.withTransaction(
        routines.beginFire({
          ...fire,
          fireKey: "fire-2",
          triggerIdentity: "later-scheduled",
          commandId: CommandId.make("later-command"),
          messageId: MessageId.make("later-message"),
          startedAt: "2026-10-22T10:00:00.000Z",
        }),
      );
      assert.equal((yield* routines.recoverTask(taskId))!.fireKey, "fire-2");
      assert.equal(
        (yield* routines.recoverTask(taskId, {
          trigger: "manual",
          triggerIdentity: "manual-command",
        }))!.fireKey,
        "fire-1",
      );
      yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES('forged-message',${binding.canonicalThreadId},'forged-run','{"scheduledTaskId":"routine"}')`;
      assert.equal(
        (yield* routines
          .assertQueued({
            runId: RunId.make("forged-run"),
            threadId: binding.canonicalThreadId,
            messageId: MessageId.make("forged-message"),
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "the persisted scheduler disabled gate fences queued fires and explicit re-enable remains available",
  () =>
    Effect.gen(function* () {
      const { sql, routines, scope, binding } = yield* setup();
      yield* sql.withTransaction(routines.beginFire(fire));
      yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES(${fire.messageId},${binding.canonicalThreadId},'queued-disabled','{"scheduledTaskId":"routine","text":"routine prompt"}')`;
      yield* sql`UPDATE scheduled_tasks SET enabled=0 WHERE task_id=${taskId}`;
      assert.equal((yield* routines.assertRunnable(taskId).pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* routines
          .assertQueued({
            runId: RunId.make("queued-disabled"),
            threadId: binding.canonicalThreadId,
            messageId: fire.messageId,
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* routines.setEnabled(scope, taskId, true);
      yield* sql`UPDATE scheduled_tasks SET enabled=1 WHERE task_id=${taskId}`;
      assert.isNotNull(yield* routines.assertRunnable(taskId));
    }).pipe(Effect.provide(layer)),
);
