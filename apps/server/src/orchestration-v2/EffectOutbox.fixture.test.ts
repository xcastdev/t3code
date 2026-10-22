import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId, ProjectId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Outbox from "./EffectOutbox.ts";

it.effect(
  "excludes copied pending/running effects from claims, ordering blockers and next deadlines",
  () =>
    Effect.gen(function* () {
      const outbox = yield* Outbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("fixture-thread");
      yield* outbox.enqueue(
        ["copied-pending", "copied-running"].map((id) => ({
          id,
          commandId: CommandId.make(id),
          threadId,
          request: { type: "terminal.cleanup" },
        })),
      );
      const control: Outbox.OwnerDeadlineControlPayload = {
        controlId: "fixture-control",
        controlThreadId: ThreadId.make("fixture-control-thread"),
        projectId: ProjectId.make("fixture-project"),
        rootId: "root",
        bindingId: "binding",
        generation: 1,
        fence: 1,
        targetThreadId: threadId,
        targetRunId: RunId.make("fixture-run"),
        expiresAt: "1970-01-01T00:00:00.000Z",
      };
      yield* outbox.enqueue([
        {
          id: "copied-control",
          commandId: CommandId.make("copied-control"),
          threadId: control.controlThreadId,
          request: { type: "owner-deadline.expire", control },
        },
      ]);
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'running', lease_owner = 'copied', lease_expires_at = '2999-01-01T00:00:00.000Z' WHERE effect_id = 'copied-running'`;
      const before = yield* sql`SELECT * FROM orchestration_v2_effect_outbox ORDER BY effect_id`;
      assert.isTrue(Option.isNone(yield* outbox.nextClaimableAt));
      assert.isTrue(Option.isNone(yield* outbox.nextClaimableAtFor("owner-deadline")));
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "fixture", leaseDurationMs: 1000 })),
      );
      yield* outbox.enqueue([
        {
          id: "fresh-fixture",
          commandId: CommandId.make("fresh-fixture"),
          threadId,
          request: { type: "terminal.cleanup" },
        },
      ]);
      yield* outbox.enqueue([
        {
          id: "fresh-control",
          commandId: CommandId.make("fresh-control"),
          threadId: control.controlThreadId,
          request: { type: "owner-deadline.expire", control },
        },
      ]);
      assert.isTrue(Option.isSome(yield* outbox.nextClaimableAtFor("owner-deadline")));
      assert.isTrue(Option.isSome(yield* outbox.nextClaimableAt));
      const claimed = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "fixture", leaseDurationMs: 1000 }),
      );
      assert.equal(claimed.id, "fresh-fixture");
      assert.isTrue(yield* outbox.succeed({ effectId: claimed.id, workerId: "fixture" }));
      assert.isTrue(Option.isNone(yield* outbox.nextClaimableAt));
      const claimedControl = Option.getOrThrow(
        yield* outbox.claimNext({
          workerId: "fixture-control",
          leaseDurationMs: 1000,
          consumer: "owner-deadline",
        }),
      );
      assert.equal(claimedControl.id, "fresh-control");
      assert.isTrue(
        yield* outbox.succeed({ effectId: claimedControl.id, workerId: "fixture-control" }),
      );
      assert.isTrue(Option.isNone(yield* outbox.nextClaimableAtFor("owner-deadline")));
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_effect_outbox WHERE effect_id LIKE 'copied-%' ORDER BY effect_id`,
        before,
      );
    }).pipe(
      Effect.provide(
        Outbox.layerWithOptions({
          testOnlyAfterRowId: 3,
        }).pipe(Layer.provideMerge(Sqlite.layerMemory)),
      ),
    ),
);
