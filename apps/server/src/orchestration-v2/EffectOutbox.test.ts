import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as Outbox from "./EffectOutbox.ts";

const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Outbox.OrchestrationEffectRequestV2));
const database = Sqlite.layerMemory;
const layers = Outbox.layer.pipe(Layer.provideMerge(database));

it.effect(
  "ordinary effects proceed past unknown synthetic lanes and feature return requeues retained controls",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const outbox = yield* Outbox.EffectOutboxV2;
      const control: Outbox.OwnerDeadlineControlPayload = {
        controlId: "control",
        controlThreadId: ThreadId.make("workflow-owner-control:root:binding:1"),
        projectId: ProjectId.make("project"),
        rootId: "root",
        bindingId: "binding",
        generation: 1,
        fence: 1,
        targetThreadId: ThreadId.make("thread"),
        targetRunId: RunId.make("run"),
        expiresAt: "1970-01-01T00:00:10.000Z",
      };
      // Unknown controls model the stock decoder encountering a feature-owned payload.
      for (const [id, status] of [
        ["control-due", "pending"],
        ["control-running", "running"],
        ["control-future", "pending"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_v2_effect_outbox(effect_id,command_id,thread_id,effect_type,payload_json,status,attempt_count,available_at,created_at,updated_at)
      VALUES(${id},'control',${`${control.controlThreadId}:${id}`},'future-feature.control','{"type":"future-feature.control"}',${status},0,${id === "control-future" ? control.expiresAt : "1970-01-01T00:00:00.000Z"},'1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z')`;
      }
      yield* outbox.enqueue([
        {
          id: "ordinary",
          commandId: CommandId.make("ordinary"),
          threadId: control.targetThreadId,
          request: { type: "terminal.cleanup" },
        },
      ]);
      assert.equal(
        (yield* Effect.result(outbox.claimNext({ workerId: "stock", leaseDurationMs: 1000 })))._tag,
        "Failure",
      );
      const ordinary = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "stock", leaseDurationMs: 1000 }),
      );
      assert.equal(ordinary.id, "ordinary");
      yield* outbox.succeed({ effectId: ordinary.id, workerId: "stock" });
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 0, cancelled: 0 });
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "stock", leaseDurationMs: 1000 })),
      );
      const states =
        yield* sql`SELECT effect_id,status FROM orchestration_v2_effect_outbox WHERE command_id='control' ORDER BY effect_id`;
      assert.deepEqual(states, [
        { effect_id: "control-due", status: "running" },
        { effect_id: "control-future", status: "pending" },
        { effect_id: "control-running", status: "running" },
      ]);
      const payload = encodeRequest({ type: "owner-deadline.expire", control });
      yield* sql`UPDATE orchestration_v2_effect_outbox SET effect_type='owner-deadline.expire',payload_json=${payload} WHERE command_id='control'`;
      assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 2, cancelled: 0 });
      const reclaimed = Option.getOrThrow(
        yield* outbox.claimNext({
          workerId: "feature",
          leaseDurationMs: 1000,
          consumer: "owner-deadline",
        }),
      );
      assert.equal(reclaimed.request.type, "owner-deadline.expire");
      if (reclaimed.request.type === "owner-deadline.expire")
        assert.equal(reclaimed.request.control.expiresAt, control.expiresAt);
      assert.equal(
        DateTime.formatIso(Option.getOrThrow(yield* outbox.nextClaimableAtFor("owner-deadline"))),
        "1970-01-01T00:00:00.000Z",
      );
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "normal", leaseDurationMs: 1000 })),
      );
    }).pipe(Effect.provide(layers)),
);
