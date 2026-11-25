import { assert, it } from "@effect/vitest";
import { CheckpointRef, ThreadId, VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as Archive from "./ThreadHistoryArchiveService.ts";
import { setup, testLayer, threadId } from "./ThreadHistoryArchiveService.test-utils.ts";

it.live(
  "retains immutable full payloads and exact Git objects through source deletion; release permits cleanup",
  () =>
    Effect.gen(function* () {
      const { sql, fs, cwd, command } = yield* setup();
      const archives = yield* Archive.ThreadHistoryArchiveService;
      const checkpoints = yield* CheckpointStore.CheckpointStore;
      const input = { threadId, archiveId: "archive-a" };
      yield* archives.prepare({ ...input, reason: "rollback" });
      const claims = yield* sql<{
        retained_ref: string;
        commit_oid: string;
      }>`SELECT retained_ref,commit_oid FROM t3_workflow_v2_history_archive_refs`;
      assert.equal(claims.length, 1);
      yield* fs.writeFileString(`${cwd}/proof.txt`, "after");
      yield* command(["add", "."]);
      yield* command(["commit", "-m", "later"]);
      assert.isTrue(
        yield* checkpoints.restoreCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.make(claims[0]!.retained_ref),
          fallbackToHead: false,
        }),
      );
      assert.equal(yield* fs.readFileString(`${cwd}/proof.txt`), "before");
      yield* checkpoints.deleteCheckpointRefs({
        cwd,
        checkpointRefs: [CheckpointRef.make("refs/t3/test-checkpoint")],
      });
      assert.isTrue(
        yield* checkpoints.hasCheckpointRef({
          cwd,
          checkpointRef: CheckpointRef.make("refs/t3/test-checkpoint"),
        }),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id=${threadId}`;
      let after: number | undefined;
      let retained = "";
      do {
        const page = yield* archives.detail({
          ...input,
          ...(after === undefined ? {} : { after }),
          limit: 1,
        });
        assert.equal(page.continuity, "context-only");
        retained += page.fragments.map((fragment) => fragment.payload).join("");
        after = page.next ?? undefined;
        if (page.next === null) break;
      } while (after !== undefined);
      assert.include(retained, "retained complete message");
      assert.include(retained, "scope-stable");
      assert.isTrue(yield* archives.isAttachmentRetained("retained-blob"));
      const mutation =
        yield* sql`UPDATE t3_workflow_v2_history_archive_rows SET payload='changed'`.pipe(
          Effect.flip,
        );
      assert.isDefined(mutation);
      yield* archives.prepare({ ...input, reason: "rollback" });
      yield* archives.release(input);
      yield* archives.release(input);
      assert.isFalse(
        yield* checkpoints.hasCheckpointRef({
          cwd,
          checkpointRef: CheckpointRef.make(claims[0]!.retained_ref),
        }),
      );
      assert.isFalse(yield* archives.isAttachmentRetained("retained-blob"));
      yield* checkpoints.deleteCheckpointRefs({
        cwd,
        checkpointRefs: [CheckpointRef.make("refs/t3/test-checkpoint")],
      });
      assert.isFalse(
        yield* checkpoints.hasCheckpointRef({
          cwd,
          checkpointRef: CheckpointRef.make("refs/t3/test-checkpoint"),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
it.live(
  "resumes committed preparation after ref creation but refuses uncertain destructive replay",
  () =>
    Effect.gen(function* () {
      const { sql } = yield* setup();
      const archives = yield* Archive.ThreadHistoryArchiveService;
      const input = { threadId, archiveId: "archive-interrupted" };
      yield* archives.prepare({ ...input, reason: "rollback" });
      yield* sql`UPDATE t3_workflow_v2_history_archives SET state='preparing' WHERE archive_id=${input.archiveId}`;
      yield* sql`UPDATE t3_workflow_v2_history_archive_refs SET commit_oid=NULL WHERE archive_id=${input.archiveId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id=${threadId}`;
      yield* archives.prepare({ ...input, reason: "rollback" });
      const other = { ...input, archiveId: "already-prepared-operation" };
      yield* archives.prepare({ ...other, reason: "rollback" });
      yield* archives.beginExternal(input);
      assert.equal(
        (yield* archives.beginExternal(other).pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      assert.equal(
        (yield* archives.beginExternal(input).pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      assert.equal(
        (yield* archives.release(input).pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      assert.equal(
        (yield* archives
          .prepare({ ...input, archiveId: "different-operation-id", reason: "rollback" })
          .pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
      yield* archives.reconcileExternal({ ...input, outcome: "not-applied" });
      yield* archives.beginExternal(input);
      yield* archives.completeExternal(input);
      assert.equal(
        (yield* archives.list({ threadId })).find((row) => row.archive_id === input.archiveId)
          ?.state,
        "completed",
      );
      assert.equal(
        (yield* archives.detail({ ...input, threadId: ThreadId.make("other") }).pipe(Effect.flip))
          .reason,
        "not-found",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live.each(["before", "after"] as const)(
  "restart resumes preparation interrupted %s archive ref creation without recapturing",
  (stage) =>
    Effect.gen(function* () {
      const { sql, cwd } = yield* setup();
      const checkpoints = yield* CheckpointStore.CheckpointStore;
      const archives = yield* Archive.ThreadHistoryArchiveService;
      const reached = yield* Deferred.make<void>();
      const blocked = yield* Deferred.make<void>();
      const input = { threadId, archiveId: `interrupted-${stage}` };
      const interrupted = yield* Archive.ThreadHistoryArchiveService.pipe(
        Effect.provide(
          Layer.fresh(Archive.layer).pipe(
            Layer.provide(
              Layer.mock(ProjectionStoreV2)({
                getThreadAttachmentIds: () => Effect.succeed(["retained-blob"]),
              }),
            ),
          ),
        ),
        Effect.provideService(CheckpointStore.CheckpointStore, {
          ...checkpoints,
          retainCheckpointRef: Effect.fn("test.interruptRetention")(function* (ref) {
            if (stage === "before") {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(blocked);
            }
            const oid = yield* checkpoints.retainCheckpointRef!(ref);
            if (stage === "after") {
              yield* Deferred.succeed(reached, undefined);
              yield* Deferred.await(blocked);
            }
            return oid;
          }),
        }),
      );
      const fiber = yield* interrupted
        .prepare({ ...input, reason: "rollback" })
        .pipe(Effect.forkChild);
      yield* Effect.raceFirst(Deferred.await(reached), Fiber.join(fiber));
      yield* Fiber.interrupt(fiber);
      const prepared = yield* sql<{
        state: string;
      }>`SELECT state FROM t3_workflow_v2_history_archives WHERE archive_id=${input.archiveId}`;
      assert.equal(prepared[0]?.state, "preparing");
      assert.isTrue(yield* archives.isCheckpointRetained("refs/t3/test-checkpoint"));
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id=${threadId}`;
      assert.equal(yield* archives.resumePreparations, 1);
      const refs = yield* sql<{
        retained_ref: string;
        commit_oid: string;
      }>`SELECT retained_ref,commit_oid FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId}`;
      assert.isString(refs[0]?.commit_oid);
      assert.isTrue(
        yield* checkpoints.hasCheckpointRef({
          cwd,
          checkpointRef: CheckpointRef.make(refs[0]!.retained_ref),
        }),
      );
      const fragments = yield* sql<{
        payload: string;
      }>`SELECT payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='messages'`;
      assert.include(fragments[0]!.payload, "retained complete message");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live(
  "SQL intent precedes real removed-worktree recreation and retention confirms after recreation",
  () =>
    Effect.gen(function* () {
      const { cwd, sql, command } = yield* setup();
      const archives = yield* Archive.ThreadHistoryArchiveService;
      const worktree = `${cwd}/managed-worktree`;
      yield* command(["worktree", "add", "-b", "recovery-branch", worktree]);
      yield* sql`UPDATE orchestration_v2_projection_checkpoint_scopes SET payload_json=json_set(payload_json,'$.cwd',${worktree}) WHERE scope_id='scope-stable'`;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.worktreePath',${worktree},'$.branch','recovery-branch') WHERE thread_id=${threadId}`;
      yield* command(["worktree", "remove", worktree]);
      const input = { threadId, archiveId: "removed-checkout" };
      yield* archives.prepareIntent({ ...input, reason: "rollback" });
      assert.equal((yield* archives.detail(input)).archive.state, "preparing");
      assert.equal(
        (yield* sql`SELECT 1 FROM t3_workflow_v2_history_archive_refs WHERE archive_id=${input.archiveId}`)
          .length,
        1,
      );
      yield* command(["worktree", "prune"]);
      yield* command(["worktree", "add", worktree, "recovery-branch"]);
      yield* archives.prepare({ ...input, reason: "rollback" });
      assert.equal((yield* archives.detail(input)).archive.state, "ready");
      yield* command(["worktree", "remove", worktree]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("release serializes with suspended exact Git ref creation and leaves no orphan ref", () =>
  Effect.gen(function* () {
    const { cwd } = yield* setup();
    const archives = yield* Archive.ThreadHistoryArchiveService;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const reached = yield* Deferred.make<void>();
    const continueRetention = yield* Deferred.make<void>();
    const input = { threadId, archiveId: "release-race" };
    const suspended = yield* Archive.ThreadHistoryArchiveService.pipe(
      Effect.provide(Layer.fresh(Archive.layer)),
      Effect.provideService(CheckpointStore.CheckpointStore, {
        ...checkpoints,
        retainCheckpointRef: Effect.fn("test.releaseRace")(function* (ref) {
          yield* Deferred.succeed(reached, undefined);
          yield* Deferred.await(continueRetention);
          return yield* checkpoints.retainCheckpointRef!(ref);
        }),
      }),
    );
    const prepare = yield* suspended
      .prepare({ ...input, reason: "rollback" })
      .pipe(Effect.forkChild);
    yield* Effect.raceFirst(Deferred.await(reached), Fiber.join(prepare));
    const release = yield* archives.release(input).pipe(Effect.forkChild);
    yield* Deferred.succeed(continueRetention, undefined);
    yield* Fiber.join(prepare);
    yield* Fiber.join(release);
    assert.isFalse(
      yield* checkpoints.hasCheckpointRef({
        cwd,
        checkpointRef: CheckpointRef.make("refs/t3/history-archives/release-race/0"),
      }),
    );
    assert.isEmpty(yield* archives.list({ threadId }));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live(
  "fork archives materialize inherited payloads through the fork boundary and retain their blobs",
  () =>
    Effect.gen(function* () {
      const { sql } = yield* setup();
      const archives = yield* Archive.ThreadHistoryArchiveService;
      const child = ThreadId.make("archive-child");
      const rows = yield* sql<
        Record<string, string | number | null>
      >`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
      const payload = yield* sql<{
        payload_json: string;
      }>`SELECT json_set(payload_json,'$.id',${child},'$.forkedFrom',json_object('type','run','threadId',${threadId},'runId','archive-run')) AS payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ ...rows[0]!, thread_id: child, payload_json: payload[0]!.payload_json })}`;
      const runs = yield* sql<
        Record<string, string | number | null>
      >`SELECT * FROM orchestration_v2_projection_runs WHERE thread_id=${threadId}`;
      const futurePayload = yield* sql<{
        payload_json: string;
      }>`SELECT json_set(payload_json,'$.id','future-parent-run','$.ordinal',2) AS payload_json FROM orchestration_v2_projection_runs WHERE run_id='archive-run'`;
      const futureRun = {
        ...runs[0]!,
        run_id: "future-parent-run",
        ordinal: 2,
        payload_json: futurePayload[0]!.payload_json,
      };
      yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert(futureRun)}`;
      const messages = yield* sql<
        Record<string, string | number | null>
      >`SELECT * FROM orchestration_v2_projection_messages WHERE thread_id=${threadId}`;
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({ ...messages[0]!, message_id: "future-parent-message", run_id: "future-parent-run", payload_json: JSON.stringify({ id: "future-parent-message", text: "future parent must not be inherited", role: "assistant" }) })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES('shared-session',${child},'codex','ready','2026-10-01T00:00:00.000Z','{}')`;
      for (const boundThread of [threadId, child])
        yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings(provider_session_id,thread_id) VALUES('shared-session',${boundThread})`;
      const input = { threadId: child, archiveId: "fork-retained" };
      yield* archives.prepare({ ...input, reason: "rollback" });
      yield* sql`DELETE FROM orchestration_v2_projection_provider_session_bindings WHERE provider_session_id='shared-session'`;
      yield* sql`DELETE FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id='shared-session'`;
      const sessions = yield* sql<{
        source_id: string;
      }>`SELECT source_id FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='provider_sessions'`;
      assert.deepEqual(
        sessions.map((row) => row.source_id),
        ["shared-session"],
      );
      const associations = yield* sql<{
        source_id: string;
        payload: string;
      }>`SELECT source_id,payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='provider_session_bindings' ORDER BY source_id`;
      assert.equal(associations.length, 2);
      assert.deepEqual(
        new Set(associations.map((row) => row.source_id)),
        new Set([
          JSON.stringify(["shared-session", threadId]),
          JSON.stringify(["shared-session", child]),
        ]),
      );
      for (const boundThread of [threadId, child])
        assert.isTrue(
          associations.some((row) => row.payload.includes(`"thread_id":"${boundThread}"`)),
        );
      yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id=${threadId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id=${threadId}`;
      const inherited = yield* sql<{
        payload: string;
      }>`SELECT payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${input.archiveId} AND kind='messages' ORDER BY position`;
      assert.include(inherited.map((row) => row.payload).join(""), "retained complete message");
      assert.notInclude(
        inherited.map((row) => row.payload).join(""),
        "future parent must not be inherited",
      );
      assert.isTrue(yield* archives.isAttachmentRetained("retained-blob"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("releasing a thread's archives frees its claims and keeps other threads' archives", () =>
  Effect.gen(function* () {
    const { sql, cwd } = yield* setup();
    const archives = yield* Archive.ThreadHistoryArchiveService;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const fork = ThreadId.make("archive-live-fork");
    const rows = yield* sql<
      Record<string, string | number | null>
    >`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    const payload = yield* sql<{
      payload_json: string;
    }>`SELECT json_set(payload_json,'$.id',${fork},'$.forkedFrom',json_object('type','run','threadId',${threadId},'runId','archive-run')) AS payload_json FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ ...rows[0]!, thread_id: fork, payload_json: payload[0]!.payload_json })}`;
    yield* archives.prepare({ threadId, archiveId: "deleted-first", reason: "rollback" });
    yield* archives.prepare({ threadId, archiveId: "deleted-executing", reason: "rollback" });
    yield* archives.prepare({ threadId: fork, archiveId: "live-fork", reason: "rollback" });
    yield* archives.beginExternal({ threadId, archiveId: "deleted-executing" });
    const ownRefs = yield* sql<{
      retained_ref: string;
    }>`SELECT retained_ref FROM t3_workflow_v2_history_archive_refs r JOIN t3_workflow_v2_history_archives a USING(archive_id) WHERE a.thread_id=${threadId}`;
    assert.lengthOf(ownRefs, 2);

    // An uncertain restore keeps its archive, so the caller retries once it settles.
    assert.equal(
      (yield* archives.releaseThread(threadId).pipe(Effect.flip)).reason,
      "reconciliation-required",
    );
    assert.deepEqual(
      (yield* archives.list({ threadId })).map((archive) => archive.archive_id),
      ["deleted-executing"],
    );
    yield* archives.reconcileExternal({
      threadId,
      archiveId: "deleted-executing",
      outcome: "not-applied",
    });
    yield* archives.releaseThread(threadId);
    yield* archives.releaseThread(threadId);

    assert.isEmpty(yield* archives.list({ threadId }));
    for (const table of [
      "t3_workflow_v2_history_archive_rows",
      "t3_workflow_v2_history_archive_refs",
      "t3_workflow_v2_history_archive_attachments",
    ])
      assert.isEmpty(
        yield* sql`SELECT 1 FROM ${sql(table)} WHERE archive_id IN ('deleted-first','deleted-executing')`,
      );
    for (const { retained_ref } of ownRefs)
      assert.isFalse(
        yield* checkpoints.hasCheckpointRef({
          cwd,
          checkpointRef: CheckpointRef.make(retained_ref),
        }),
      );
    assert.deepEqual(
      (yield* archives.list({ threadId: fork })).map((archive) => archive.archive_id),
      ["live-fork"],
    );
    // The live fork's archive still claims the blob it inherited from the released thread.
    assert.isTrue(yield* archives.isAttachmentRetained("retained-blob"));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("a thread the maintenance sweep purges has its archives released by the reconcile", () =>
  Effect.gen(function* () {
    const { sql, cwd } = yield* setup();
    const archives = yield* Archive.ThreadHistoryArchiveService;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const live = ThreadId.make("archive-live");
    const rows = yield* sql<
      Record<string, string | number | null>
    >`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({ ...rows[0]!, thread_id: live })}`;
    yield* archives.prepare({ threadId, archiveId: "swept", reason: "rollback" });
    yield* archives.prepare({ threadId: live, archiveId: "kept", reason: "rollback" });
    // A rewind whose provider call failed before the thread was deleted; nothing can settle it now.
    yield* archives.prepare({ threadId, archiveId: "swept-executing", reason: "rollback" });
    yield* archives.beginExternal({ threadId, archiveId: "swept-executing" });
    const retained = yield* sql<{
      retained_ref: string;
    }>`SELECT retained_ref FROM t3_workflow_v2_history_archive_refs WHERE archive_id IN ('swept','swept-executing')`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-02T00:00:00.000Z' WHERE thread_id=${threadId}`;

    // Deleted but not yet purged: its content, and so its archives, stay.
    assert.equal(yield* archives.releasePurgedThreads(), 0);
    assert.lengthOf(yield* archives.list({ threadId }), 2);

    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    assert.isAbove((yield* maintenance.pruneEventStore()).purgedRowCount, 0);
    assert.equal(yield* archives.releasePurgedThreads(), 1);
    assert.equal(yield* archives.releasePurgedThreads(), 0);

    assert.isEmpty(yield* archives.list({ threadId }));
    assert.isEmpty(
      yield* sql`SELECT 1 FROM t3_workflow_v2_history_archive_attachments WHERE archive_id IN ('swept','swept-executing')`,
    );
    for (const { retained_ref } of retained)
      assert.isFalse(
        yield* checkpoints.hasCheckpointRef({
          cwd,
          checkpointRef: CheckpointRef.make(retained_ref),
        }),
      );
    assert.deepEqual(
      (yield* archives.list({ threadId: live })).map((archive) => archive.archive_id),
      ["kept"],
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(ProjectionMaintenance.layer.pipe(Layer.provideMerge(testLayer))),
  ),
);

it.live("release deletes refs through the project root once the worktree is gone", () =>
  Effect.gen(function* () {
    const { cwd, sql, command } = yield* setup();
    const archives = yield* Archive.ThreadHistoryArchiveService;
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const worktree = `${cwd}/managed-worktree`;
    yield* command(["worktree", "add", "-b", "removed-branch", worktree]);
    yield* sql`UPDATE orchestration_v2_projection_checkpoint_scopes SET payload_json=json_set(payload_json,'$.cwd',${worktree}) WHERE scope_id='scope-stable'`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.worktreePath',${worktree}) WHERE thread_id=${threadId}`;
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES('archive-project','Archive',${cwd},'[]','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')`;
    yield* archives.prepare({ threadId, archiveId: "gone-worktree", reason: "rollback" });
    yield* archives.prepare({ threadId, archiveId: "gone-repository", reason: "rollback" });
    yield* command(["worktree", "remove", worktree]);
    const retained = (archiveId: string) =>
      checkpoints.hasCheckpointRef({
        cwd,
        checkpointRef: CheckpointRef.make(`refs/t3/history-archives/${archiveId}/0`),
      });
    assert.isTrue(yield* retained("gone-worktree"));

    yield* archives.release({ threadId, archiveId: "gone-worktree" });
    assert.isFalse(yield* retained("gone-worktree"));

    // No folder left to reach the refs from: the release finishes and logs the skip.
    yield* sql`UPDATE projection_projects SET workspace_root=${`${cwd}/missing-project`}`;
    yield* archives.release({ threadId, archiveId: "gone-repository" });
    assert.isEmpty(yield* archives.list({ threadId }));
    assert.isEmpty(
      yield* sql`SELECT 1 FROM t3_workflow_v2_history_archive_refs WHERE archive_id='gone-repository'`,
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.live("the reconcile moves past threads whose release keeps failing", () =>
  Effect.gen(function* () {
    const { sql } = yield* setup();
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const rows = yield* sql<
      Record<string, string | number | null>
    >`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=${threadId}`;
    const purgedThread = (id: string) => ({
      ...rows[0]!,
      thread_id: id,
      title: ProjectionMaintenance.DELETED_THREAD_TITLE,
      deleted_at: "2026-10-02T00:00:00.000Z",
    });
    for (const index of Array.from({ length: 51 }, (_, index) => index)) {
      const id = index < 50 ? `purged-failing-${String(index).padStart(2, "0")}` : "purged-last";
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert(purgedThread(id))}`;
      yield* sql`INSERT INTO t3_workflow_v2_history_archives(archive_id,thread_id,reason,state) VALUES(${id},${id},'rollback','ready')`;
      yield* sql`INSERT INTO t3_workflow_v2_history_archive_refs(archive_id,checkpoint_id,cwd,source_ref,retained_ref) VALUES(${id},'checkpoint','/repository','refs/t3/test-checkpoint',${`refs/t3/history-archives/${id}/0`})`;
    }
    const refuseFailing = (input: unknown) =>
      JSON.stringify(input).includes("purged-failing")
        ? Effect.fail(
            new VcsProcessExitError({
              operation: "test.refuseFailingRefs",
              command: "git update-ref",
              cwd: "/repository",
              exitCode: 1,
              detail: "Ref lock held.",
            }),
          )
        : Effect.succeed(true);
    const archives = yield* Archive.ThreadHistoryArchiveService.pipe(
      Effect.provide(Layer.fresh(Archive.layer)),
      Effect.provideService(CheckpointStore.CheckpointStore, {
        ...checkpoints,
        deleteCheckpointRefs: (input) => refuseFailing(input).pipe(Effect.asVoid),
        deleteRetainedRefs: refuseFailing,
      }),
    );

    // Each pass takes the next page, so 50 lasting failures cannot hide the thread after them.
    assert.equal(yield* archives.releasePurgedThreads(), 0);
    assert.equal(yield* archives.releasePurgedThreads(), 1);
    assert.isEmpty(yield* archives.list({ threadId: ThreadId.make("purged-last") }));
    assert.deepEqual(
      yield* sql`SELECT state FROM t3_workflow_v2_history_archives WHERE archive_id='purged-failing-00'`,
      [{ state: "releasing" }],
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
