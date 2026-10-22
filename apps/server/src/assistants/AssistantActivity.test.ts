import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, EnvironmentId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { environmentId } from "./AssistantTestHelpers.ts";
import { layer, seedRun, sessionId, setup } from "./AssistantActivity.test-utils.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "reads current EventStore executions and keyset pages without confusing dispatch with completion",
  () =>
    Effect.gen(function* () {
      const { activity, scope, sql } = yield* setup();
      for (const [id, status] of [
        ["a", "completed"],
        ["b", "waiting"],
        ["c", "failed"],
      ])
        yield* seedRun(scope, id!, status!);
      yield* sql`INSERT INTO t3_workflow_v2_assistant_routine_fires(fire_key,task_id,environment_id,assistant_id,thread_id,configuration_revision,trigger_kind,trigger_identity,command_id,message_id,started_at,dispatched,prompt_hash) VALUES('fire','task',${environmentId},${scope.assistantId},${scope.binding.canonicalThreadId},0,'manual','trigger','dispatch-only','dispatch-message','2026-10-22T00:00:00.000Z',1,'hash')`;
      const first = yield* activity.list({ ...scope, limit: 2 }, sessionId);
      assert.deepEqual(
        first.runs.map((run) => [run.runId, run.status]),
        [
          ["c", "failed"],
          ["b", "waiting"],
        ],
      );
      assert.equal(first.runs[0]!.configurationRevision, 7);
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE name='orchestration_v2_events'`).length,
        0,
      );
      assert.equal(
        (yield* sql`SELECT command_id FROM orchestration_events WHERE command_id='command-c'`)
          .length,
        1,
      );
      assert.equal(first.runs[0]!.commandId, "command-c");
      assert.equal(first.runs[0]!.runAttemptId, "attempt-c");
      assert.isNotNull(first.nextCursor);
      const next = yield* activity.list(
        { ...scope, limit: 2, cursor: first.nextCursor! },
        sessionId,
      );
      assert.deepEqual(
        next.runs.map((run) => run.runId),
        [RunId.make("a")],
      );
      assert.isNull(next.nextCursor);
    }).pipe(Effect.provide(layer)),
);

it.effect("counts queued running and waiting executions on the bounded roster", () =>
  Effect.gen(function* () {
    const { activity, scope } = yield* setup();
    for (const status of [
      "preparing",
      "starting",
      "queued",
      "running",
      "waiting",
      "completed",
      "failed",
    ])
      yield* seedRun(scope, status, status);
    const page = yield* activity.roster(
      { environmentId, limit: 1, includeArchived: true },
      sessionId,
    );
    assert.equal(page.assistants.length, 1);
    assert.equal(page.assistants[0]!.attention.queuedRuns, 3);
    assert.equal(page.assistants[0]!.attention.activeRuns, 1);
    assert.equal(page.assistants[0]!.attention.waitingRuns, 1);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects revoked expired and scopeless sessions and another environment", () =>
  Effect.gen(function* () {
    const { activity, scope, sql, auth } = yield* setup();
    const read = () => activity.list({ ...scope, limit: 1 }, sessionId).pipe(Effect.result);
    assert.equal(
      (yield* activity
        .list({ ...scope, environmentId: EnvironmentId.make("other"), limit: 1 }, sessionId)
        .pipe(Effect.result))._tag,
      "Failure",
    );
    yield* sql`UPDATE auth_sessions SET scopes='[]'`;
    assert.equal((yield* read())._tag, "Failure");
    yield* sql`UPDATE auth_sessions SET scopes=${encodeJson([AuthOrchestrationReadScope])},expires_at='1960-01-01T00:00:00.000Z'`;
    assert.equal((yield* read())._tag, "Failure");
    yield* sql`UPDATE auth_sessions SET expires_at='2100-01-01T00:00:00.000Z'`;
    yield* auth.revoke({ sessionId, revokedAt: yield* DateTime.now });
    assert.equal((yield* read())._tag, "Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("scopes coincident IDs to their exact project and uses the owner paging index", () =>
  Effect.gen(function* () {
    const { activity, scope, sql } = yield* setup();
    yield* seedRun(scope, "owned", "running");
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES('other-thread','other-project')`;
    yield* sql`INSERT INTO t3_workflow_v2_assistants SELECT 'other-environment',assistant_id,'other-project','other-thread',owner_revision,configuration_revision,lifecycle,provisioning_state,workspace_root,create_command_id,payload_json FROM t3_workflow_v2_assistants WHERE environment_id=${environmentId}`;
    yield* seedRun(
      { ...scope, binding: { canonicalThreadId: "other-thread" } },
      "foreign",
      "waiting",
    );
    assert.deepEqual(
      (yield* activity.list({ ...scope, limit: 100 }, sessionId)).runs.map((run) => run.runId),
      [RunId.make("owned")],
    );
    const plan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT run_id FROM t3_workflow_v2_assistant_admissions WHERE assistant_id=${scope.assistantId} AND created_at<='2026-10-21T10:00:00.000Z' ORDER BY created_at DESC,run_id DESC LIMIT 2`;
    assert.isTrue(plan.some((row) => row.detail.includes("assistant_admission_owner_idx")));
    const commandPlan = yield* sql<{
      detail: string;
    }>`EXPLAIN QUERY PLAN SELECT command_id FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${scope.binding.canonicalThreadId} AND json_extract(metadata_json,'$.runId')='owned' AND command_id IS NOT NULL ORDER BY sequence LIMIT 1`;
    assert.isTrue(commandPlan.some((row) => row.detail.includes("assistant_run_command_idx")));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "normalizes admission preparation and rollback while preserving terminal execution outcomes",
  () =>
    Effect.gen(function* () {
      const { activity, scope } = yield* setup();
      for (const status of ["preparing", "starting", "cancelled", "interrupted", "rolled_back"])
        yield* seedRun(scope, status, status);
      const page = yield* activity.list({ ...scope, limit: 100 }, sessionId);
      assert.deepEqual(
        page.runs.map((run) => [run.runId, run.phase, run.status]),
        [
          ["starting", "execution", "queued"],
          ["rolled_back", "execution", "interrupted"],
          ["preparing", "execution", "queued"],
          ["interrupted", "execution", "interrupted"],
          ["cancelled", "execution", "cancelled"],
        ],
      );
    }).pipe(Effect.provide(layer)),
);
