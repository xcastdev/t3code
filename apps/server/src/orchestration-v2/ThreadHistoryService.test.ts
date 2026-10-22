import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Archive from "./ThreadHistoryArchiveService.ts";
import * as Recovery from "./ThreadHistoryRecoveryService.ts";
import * as History from "./ThreadHistoryService.ts";
import { setup, testLayer, threadId } from "./ThreadHistoryArchiveService.test-utils.ts";

const layer = History.layer.pipe(
  Layer.provideMerge(testLayer),
  Layer.provide(
    Layer.succeed(Recovery.ThreadHistoryRecoveryService, {
      capabilities: () =>
        Effect.succeed({
          owner: "ordinary",
          contextRestore: true,
          fork: true,
          restoreFiles: false,
          retainedCheckpointIds: [],
        }),
      recover: () => Effect.die("Recovery is outside this archive transport test."),
      fileRestoreStatus: () => Effect.die("Status is outside this archive transport test."),
      reconcileFiles: () => Effect.die("Reconciliation is outside this archive transport test."),
      restoreFiles: () => Effect.die("File restoration is outside this archive transport test."),
    }),
  ),
);

it.live(
  "public history keeps bounded immutable reads isolated and preserves interrupted operation retention",
  () =>
    Effect.gen(function* () {
      yield* setup();
      const archive = yield* Archive.ThreadHistoryArchiveService;
      const history = yield* History.ThreadHistoryService;
      const identity = { threadId, archiveId: "public-archive" };
      yield* archive.prepare({ ...identity, reason: "rollback" });
      assert.equal((yield* history.list({ threadId, limit: 1 })).length, 1);
      assert.equal((yield* history.list({ threadId: ThreadId.make("foreign") })).length, 0);
      const page = yield* history.detail({ ...identity, limit: 1 });
      assert.equal(page.fragments.length, 1);
      assert.equal(page.continuity, "context-only");
      assert.equal(
        (yield* history
          .detail({ ...identity, threadId: ThreadId.make("foreign") })
          .pipe(Effect.flip)).reason,
        "not-found",
      );
      yield* archive.beginExternal(identity);
      assert.equal((yield* history.detail(identity)).archive.state, "executing");
      assert.equal(
        (yield* history.release(identity).pipe(Effect.flip)).reason,
        "reconciliation-required",
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
);
