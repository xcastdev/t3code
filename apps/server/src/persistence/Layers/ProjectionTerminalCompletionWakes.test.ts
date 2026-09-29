import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionTerminalCompletionWakeRepository } from "../Services/ProjectionTerminalCompletionWakes.ts";
import { ProjectionTerminalCompletionWakeRepositoryLive } from "./ProjectionTerminalCompletionWakes.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionTerminalCompletionWakeRepositoryLive.pipe(
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  ),
);

layer("ProjectionTerminalCompletionWakeRepository recovery", (it) => {
  it.effect("cancels prior pending requests and marks claimed sends unknown after restart", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionTerminalCompletionWakeRepository;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-09-01T00:00:00.000Z";
      const request = (dedupeKey: string) =>
        repository.recordRequest({
          dedupeKey,
          threadId: ThreadId.make("wake-recovery-thread"),
          projectId: ProjectId.make("wake-recovery-project"),
          terminalId: `terminal-${dedupeKey}`,
          generation: `generation-${dedupeKey}`,
          serverRunId: "previous-server-run",
          label: "Build terminal",
          status: "exited",
          exitCode: 1,
          exitSignal: null,
          createdAt,
        });

      yield* request("pending-before-restart");
      yield* request("claimed-before-restart");
      const claimed = yield* repository.claim({
        dedupeKey: "claimed-before-restart",
        serverRunId: "previous-server-run",
        updatedAt: createdAt,
      });
      assert.equal(claimed?.deliveryStatus, "claimed");

      yield* repository.cancelOtherServerRuns({
        serverRunId: "current-server-run",
        updatedAt: "2026-09-01T00:01:00.000Z",
      });

      const persisted = yield* sql<{
        readonly dedupeKey: string;
        readonly deliveryStatus: string;
      }>`
        SELECT dedupe_key AS "dedupeKey", delivery_status AS "deliveryStatus"
        FROM terminal_completion_wakes
        ORDER BY dedupe_key
      `;
      assert.deepEqual(persisted, [
        { dedupeKey: "claimed-before-restart", deliveryStatus: "unknown" },
        { dedupeKey: "pending-before-restart", deliveryStatus: "canceled" },
      ]);
      assert.deepEqual(
        (yield* repository.listUnknown({ limit: 100 })).map((wake) => wake.dedupeKey),
        ["claimed-before-restart"],
      );
    }),
  );
});
