import { CommandId, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../Errors.ts";
import { OrchestrationCommandReceiptRepository } from "../Services/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationCommandReceiptRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationCommandReceiptRepository", (it) => {
  it.effect("round-trips fingerprints, attribution, and structured results", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const receipt = {
        commandId: CommandId.make("command-receipt-p2"),
        aggregateKind: "project" as const,
        aggregateId: ProjectId.make("project-receipt-p2"),
        acceptedAt: "2026-01-01T00:00:00.000Z",
        resultSequence: 42,
        status: "accepted" as const,
        error: null,
        fingerprint: "sha256:command-receipt-p2",
        actorKind: "agent",
        actorId: "agent-p2",
        sourceKind: "mcp",
        sourceId: "session-p2",
        result: { sequence: 42, recordId: "task-p2" },
      };

      yield* repository.upsert(receipt);
      const found = yield* repository.getByCommandId({ commandId: receipt.commandId });
      assert.deepEqual(Option.getOrThrow(found), receipt);
    }),
  );

  it.effect("distinguishes absent, JSON null, and object results", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const sql = yield* SqlClient.SqlClient;
      const receipt = {
        commandId: CommandId.make("command-receipt-p2-result-variants"),
        aggregateKind: "project" as const,
        aggregateId: ProjectId.make("project-receipt-p2-result-variants"),
        acceptedAt: "2026-01-01T00:00:00.000Z",
        resultSequence: 42,
        status: "accepted" as const,
        error: null,
      };

      yield* repository.upsert(receipt);
      const absent = yield* repository.getByCommandId({ commandId: receipt.commandId });
      assert.deepEqual(Option.getOrThrow(absent), receipt);

      yield* sql`
        UPDATE orchestration_command_receipts
        SET result_json = ${"null"}
        WHERE command_id = ${receipt.commandId}
      `;
      const explicitNull = yield* repository.getByCommandId({ commandId: receipt.commandId });
      assert.deepEqual(Option.getOrThrow(explicitNull), { ...receipt, result: null });

      const objectResult = { sequence: 42, recordId: "task-p2-result-variants" };
      yield* sql`
        UPDATE orchestration_command_receipts
        SET result_json = ${'{"sequence":42,"recordId":"task-p2-result-variants"}'}
        WHERE command_id = ${receipt.commandId}
      `;
      const object = yield* repository.getByCommandId({ commandId: receipt.commandId });
      assert.deepEqual(Option.getOrThrow(object), { ...receipt, result: objectResult });
    }),
  );

  it.effect("maps malformed result JSON to a typed persistence SQL error", () =>
    Effect.gen(function* () {
      const repository = yield* OrchestrationCommandReceiptRepository;
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.make("command-receipt-p2-malformed-result");

      yield* repository.upsert({
        commandId,
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-receipt-p2-malformed-result"),
        acceptedAt: "2026-01-01T00:00:00.000Z",
        resultSequence: 42,
        status: "accepted",
        error: null,
      });
      yield* sql`
        UPDATE orchestration_command_receipts
        SET result_json = ${"{"}
        WHERE command_id = ${commandId}
      `;

      const result = yield* Effect.result(repository.getByCommandId({ commandId }));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, PersistenceSqlError);
        assert.equal(
          result.failure.operation,
          "OrchestrationCommandReceiptRepository.getByCommandId:query",
        );
      }
    }),
  );
});
