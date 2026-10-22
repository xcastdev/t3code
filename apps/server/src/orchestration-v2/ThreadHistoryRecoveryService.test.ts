import { assert, it } from "@effect/vitest";
import { CheckpointId, CheckpointRef, CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Layer from "effect/Layer";
import * as Archive from "./ThreadHistoryArchiveService.ts";
import * as Recovery from "./ThreadHistoryRecoveryService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { setup, testLayer, threadId } from "./ThreadHistoryArchiveService.test-utils.ts";

const layer = Recovery.layer.pipe(
  Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(testLayer),
);
it.live(
  "exact file retries serialize a delayed first request and replay completion without restoring twice",
  () =>
    Effect.gen(function* () {
      const { sql, fs, cwd } = yield* setup();
      const archives = yield* Archive.ThreadHistoryArchiveService;
      const checkpoints = yield* CheckpointStore.CheckpointStore;
      const preparing = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const retryStarted = yield* Deferred.make<void>();
      let paused = false;
      let restores = 0;
      const recovery = yield* Recovery.ThreadHistoryRecoveryService.pipe(
        Effect.provide(
          Layer.fresh(Recovery.layer).pipe(
            Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
          ),
        ),
        Effect.provideService(Archive.ThreadHistoryArchiveService, {
          ...archives,
          prepare: Effect.fn("test.delayFirstFileRequest")(function* (input) {
            if (!paused) {
              paused = true;
              yield* Deferred.succeed(preparing, undefined);
              yield* Deferred.await(resume);
            }
            yield* archives.prepare(input);
          }),
        }),
        Effect.provideService(CheckpointStore.CheckpointStore, {
          ...checkpoints,
          restoreCheckpoint: Effect.fn("test.countExactFileRestores")((input) => {
            restores++;
            return checkpoints.restoreCheckpoint(input);
          }),
        }),
      );
      const input = {
        threadId,
        archiveId: "retry-source",
        checkpointId: CheckpointId.make("checkpoint-stable"),
        commandId: CommandId.make("exact-retry-command"),
      };
      yield* archives.prepare({ ...input, reason: "rollback" });
      yield* fs.writeFileString(`${cwd}/proof.txt`, "current files");
      const first = yield* recovery.restoreFiles(input).pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(preparing), Fiber.join(first));
      const missing = yield* recovery.fileRestoreStatus(input);
      assert.equal(missing.state, "not-started");
      assert.notEqual(missing.archiveId, input.archiveId);
      const operation = {
        threadId,
        archiveId: missing.archiveId,
        reason: "file-restore",
        operation: {
          type: "file-restore" as const,
          sourceArchiveId: input.archiveId,
          checkpointId: input.checkpointId,
        },
      };
      yield* archives.prepareIntent(operation);
      assert.equal((yield* recovery.fileRestoreStatus(input)).state, "preparing");
      yield* archives.prepare(operation);
      assert.equal((yield* recovery.fileRestoreStatus(input)).state, "ready");
      assert.equal(restores, 0);
      const retry = yield* Effect.gen(function* () {
        yield* Deferred.succeed(retryStarted, undefined);
        return yield* recovery.restoreFiles(input);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(retryStarted);
      yield* Deferred.succeed(resume, undefined);
      const completed = yield* Fiber.join(first);
      assert.deepEqual(yield* Fiber.join(retry), completed);
      assert.equal(restores, 1);
      assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "before");
      yield* fs.writeFileString(`${cwd}/proof.txt`, "new edit after completion");
      assert.deepEqual(yield* recovery.restoreFiles(input), completed);
      assert.equal(restores, 1);
      assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "new edit after completion");
      assert.equal(
        (yield* recovery
          .fileRestoreStatus({
            ...input,
            checkpointId: CheckpointId.make("different-checkpoint"),
          })
          .pipe(Effect.flip)).reason,
        "unavailable",
      );
      assert.equal(
        (yield* recovery
          .fileRestoreStatus({
            ...input,
            threadId: ThreadId.make("different-thread"),
          })
          .pipe(Effect.flip)).reason,
        "unavailable",
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-02T00:00:00.000Z',payload_json=json_set(payload_json,'$.deletedAt','2026-10-02T00:00:00.000Z') WHERE thread_id=${threadId}`;
      assert.equal((yield* recovery.fileRestoreStatus(input)).state, "completed");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "repeated explicit file recovery uses retained objects after source cleanup and preserves conversation identity",
  () =>
    Effect.gen(function* () {
      const { sql, fs, cwd, thread, command } = yield* setup();
      const archive = yield* Archive.ThreadHistoryArchiveService;
      const recovery = yield* Recovery.ThreadHistoryRecoveryService;
      const input = {
        threadId,
        archiveId: "file-recovery-source",
        checkpointId: CheckpointId.make("checkpoint-stable"),
      };
      yield* archive.prepare({ ...input, reason: "rollback" });
      assert.deepEqual(yield* recovery.capabilities(input), {
        owner: "ordinary",
        contextRestore: true,
        fork: true,
        restoreFiles: true,
        retainedCheckpointIds: [input.checkpointId],
      });
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='running',payload_json=json_set(payload_json,'$.status','running') WHERE thread_id=${threadId}`;
      assert.deepEqual(yield* recovery.capabilities(input), {
        owner: "ordinary",
        contextRestore: false,
        fork: false,
        restoreFiles: false,
        retainedCheckpointIds: [],
      });
      assert.equal((yield* archive.detail(input)).archive.state, "ready");
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='completed',payload_json=json_set(payload_json,'$.status','completed') WHERE thread_id=${threadId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id=${threadId}`;
      for (const step of ["one", "two"]) {
        yield* fs.writeFileString(`${cwd}/proof.txt`, `changed-${step}`);
        yield* recovery.restoreFiles({
          ...input,
          commandId: CommandId.make(`restore-${step}`),
        });
        assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "before");
        const current = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
        assert.include(current[0]!.payload_json, thread.id);
      }
      assert.equal((yield* archive.detail(input)).archive.state, "ready");
      const refs = yield* sql<{
        retained_ref: string;
      }>`SELECT retained_ref FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId}`;
      yield* command(["update-ref", "-d", refs[0]!.retained_ref]);
      const missing = yield* recovery.capabilities(input);
      assert.isTrue(missing.contextRestore);
      assert.isFalse(missing.restoreFiles);
      assert.isEmpty(missing.retainedCheckpointIds);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-02T00:00:00.000Z',payload_json=json_set(payload_json,'$.deletedAt','2026-10-02T00:00:00.000Z') WHERE thread_id=${threadId}`;
      assert.isFalse((yield* recovery.capabilities(input)).contextRestore);
      assert.equal((yield* archive.detail(input)).archive.state, "ready");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("ordinary recovery refuses assistant canonical homes before file/provider mutation", () =>
  Effect.gen(function* () {
    const { sql, fs, cwd, thread } = yield* setup();
    const archive = yield* Archive.ThreadHistoryArchiveService;
    const recovery = yield* Recovery.ThreadHistoryRecoveryService;
    const input = {
      threadId,
      archiveId: "owned-recovery-source",
      checkpointId: CheckpointId.make("checkpoint-stable"),
      commandId: CommandId.make("restore-owned"),
    };
    yield* archive.prepare({ ...input, reason: "rollback" });
    yield* sql`INSERT INTO t3_workflow_v2_assistants(environment_id,assistant_id,project_id,thread_id,owner_revision,configuration_revision,lifecycle,provisioning_state,create_command_id,payload_json) VALUES('env','assistant',${thread.projectId},${threadId},1,1,'active','ready','create-owned','{}')`;
    yield* fs.writeFileString(`${cwd}/proof.txt`, "owned-current");
    const refusal = yield* recovery.restoreFiles(input).pipe(Effect.flip);
    assert.equal(refusal.reason, "forbidden");
    assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "owned-current");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("refuses explicit file recovery when another current thread shares the checkout", () =>
  Effect.gen(function* () {
    const { sql, fs, cwd } = yield* setup();
    const archive = yield* Archive.ThreadHistoryArchiveService;
    const recovery = yield* Recovery.ThreadHistoryRecoveryService;
    const input = {
      threadId,
      archiveId: "shared-recovery-source",
      checkpointId: CheckpointId.make("checkpoint-stable"),
      commandId: CommandId.make("restore-shared"),
    };
    yield* archive.prepare({ ...input, reason: "rollback" });
    const rows = yield* sql<
      Record<string, string | number | null>
    >`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    const otherPayload = yield* sql<{
      payload_json: string;
    }>`SELECT json_set(payload_json,'$.id','other-thread','$.worktreePath',${cwd}) AS payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    const other = {
      ...rows[0]!,
      thread_id: ThreadId.make("other-thread"),
      payload_json: otherPayload[0]!.payload_json,
    };
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(other)}`;
    yield* fs.writeFileString(`${cwd}/proof.txt`, "shared-current");
    const refusal = yield* recovery.restoreFiles(input).pipe(Effect.flip);
    assert.equal(refusal.reason, "shared-workspace");
    assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "shared-current");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "an interruption after external file mutation retains uncertainty and never replays it automatically",
  () =>
    Effect.gen(function* () {
      const { sql, fs, cwd } = yield* setup();
      const archive = yield* Archive.ThreadHistoryArchiveService;
      const checkpoints = yield* CheckpointStore.CheckpointStore;
      const reached = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      const recovery = yield* Recovery.ThreadHistoryRecoveryService.pipe(
        Effect.provide(
          Layer.fresh(Recovery.layer).pipe(
            Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
          ),
        ),
        Effect.provideService(CheckpointStore.CheckpointStore, {
          ...checkpoints,
          restoreCheckpoint: Effect.fn("test.interruptRestore")(function* (input) {
            const restored = yield* checkpoints.restoreCheckpoint(input);
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(blocked);
            return restored;
          }),
        }),
      );
      const input = {
        threadId,
        archiveId: "uncertain-source",
        checkpointId: CheckpointId.make("checkpoint-stable"),
        commandId: CommandId.make("restore-uncertain"),
      };
      yield* archive.prepare({ ...input, reason: "rollback" });
      yield* fs.writeFileString(`${cwd}/proof.txt`, "before-recovery");
      const fiber = yield* recovery.restoreFiles(input).pipe(Effect.forkChild);
      yield* Effect.raceFirst(
        Deferred.await(reached),
        Fiber.join(fiber).pipe(
          Effect.andThen(Effect.die("File restore did not reach its external mutation milestone.")),
        ),
      );
      assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "before");
      yield* Fiber.interrupt(fiber);
      const operations = yield* sql<{
        state: string;
      }>`SELECT state FROM t3_workflow_v2_history_archives WHERE reason='file-restore'`;
      assert.equal(operations[0]?.state, "executing");
      assert.equal(
        (yield* archive.release(input).pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      yield* fs.writeFileString(`${cwd}/proof.txt`, "after-interrupted-restore");
      const retry = yield* recovery.restoreFiles(input).pipe(Effect.flip);
      assert.equal(retry.reason, "reconciliation-required");
      assert.equal(
        (yield* recovery
          .restoreFiles({
            ...input,
            commandId: CommandId.make("fresh-while-uncertain"),
          })
          .pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      const uncertain = yield* recovery.capabilities(input);
      assert.isFalse(uncertain.restoreFiles);
      assert.isTrue(uncertain.contextRestore);
      assert.isTrue(uncertain.fork);
      assert.deepEqual(uncertain.retainedCheckpointIds, [input.checkpointId]);
      assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "after-interrupted-restore");
      const status = yield* recovery.fileRestoreStatus(input);
      assert.equal(status.state, "executing");
      assert.notEqual(status.archiveId, input.archiveId);
      assert.equal(
        (yield* recovery.reconcileFiles(status).pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      yield* checkpoints.restoreCheckpoint({
        cwd,
        checkpointRef: CheckpointRef.make("refs/t3/test-checkpoint"),
        fallbackToHead: false,
      });
      yield* fs.writeFileString(
        `${cwd}/untracked-proof.txt`,
        "must not ignore current untracked work",
      );
      assert.equal(
        (yield* recovery.reconcileFiles(status).pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      yield* fs.remove(`${cwd}/untracked-proof.txt`);
      assert.equal((yield* recovery.reconcileFiles(status)).state, "completed");
      assert.equal((yield* recovery.fileRestoreStatus(input)).state, "completed");
      assert.isTrue((yield* recovery.capabilities(input)).restoreFiles);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("refuses files when a sibling starts sharing the checkout during archive preparation", () =>
  Effect.gen(function* () {
    const { sql, fs, cwd } = yield* setup();
    const archives = yield* Archive.ThreadHistoryArchiveService;
    const reached = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const recovery = yield* Recovery.ThreadHistoryRecoveryService.pipe(
      Effect.provide(
        Layer.fresh(Recovery.layer).pipe(
          Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        ),
      ),
      Effect.provideService(Archive.ThreadHistoryArchiveService, {
        ...archives,
        prepare: Effect.fn("test.sharingDuringPreparation")(function* (input) {
          yield* Deferred.succeed(reached, undefined);
          yield* Deferred.await(resume);
          return yield* archives.prepare(input);
        }),
      }),
    );
    const input = {
      threadId,
      archiveId: "sharing-race",
      checkpointId: CheckpointId.make("checkpoint-stable"),
      commandId: CommandId.make("sharing-race-command"),
    };
    yield* archives.prepare({ ...input, reason: "rollback" });
    yield* fs.writeFileString(`${cwd}/proof.txt`, "new-sibling-files");
    const restore = yield* recovery.restoreFiles(input).pipe(Effect.forkChild);
    yield* Effect.raceFirst(Deferred.await(reached), Fiber.join(restore));
    const rows = yield* sql<
      Record<string, string | number | null>
    >`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    const payload = yield* sql<{
      payload_json: string;
    }>`SELECT json_set(payload_json,'$.id','late-sibling','$.worktreePath',${cwd}) AS payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ ...rows[0]!, thread_id: "late-sibling", payload_json: payload[0]!.payload_json })}`;
    yield* Deferred.succeed(resume, undefined);
    const refusal = yield* Fiber.join(restore).pipe(Effect.flip);
    assert.equal(refusal.reason, "shared-workspace");
    assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "new-sibling-files");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
