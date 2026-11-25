import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as ThreadHistoryArchive from "./ThreadHistoryArchiveService.ts";

it.effect("a thread whose archive release fails leaves the other threads' releases running", () =>
  Effect.gen(function* () {
    const attempted = yield* Ref.make<ReadonlyArray<string>>([]);
    const failing = ThreadId.make("thread:release-fails");
    const released = ThreadId.make("thread:release-succeeds");
    const cleanup = yield* ResourceCleanupService.ResourceCleanupService.pipe(
      Effect.provide(
        ResourceCleanupService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(ThreadHistoryArchive.ThreadHistoryArchiveService)({
                releaseThread: (threadId) =>
                  Ref.update(attempted, (current) => [...current, threadId]).pipe(
                    Effect.andThen(
                      threadId === failing
                        ? Effect.fail(
                            new ThreadHistoryArchive.HistoryArchiveError({ reason: "storage" }),
                          )
                        : Effect.void,
                    ),
                  ),
              }),
              Layer.mock(TerminalManager.TerminalManager)({}),
              Layer.mock(PreviewManager.PreviewManager)({}),
              Layer.mock(DeviceService.DeviceService)({}),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-resource-cleanup-test-" }).pipe(
                Layer.provideMerge(NodeServices.layer),
              ),
              Sqlite.layerMemory,
            ),
          ),
        ),
      ),
    );

    // Best effort: the reconcile worker retries, and a failed purge would keep the worktree.
    yield* cleanup.cleanupHistoryArchives([failing, released]);
    assert.deepEqual(yield* Ref.get(attempted), [failing, released]);
  }),
);
