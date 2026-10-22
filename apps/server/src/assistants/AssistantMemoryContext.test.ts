import { AssistantRepository } from "./AssistantRepository.ts";
import { input } from "./AssistantTestHelpers.ts";
import { CommandId, MessageId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { sourceTuple } from "../projectWork/memory/ProjectMemoryRepository.ts";
import { fixture, seed } from "./AssistantMemory.test-utils.ts";

it.effect("SQL context is bounded and available independently of model or index availability", () =>
  Effect.gen(function* () {
    const { memory, evidence, record } = yield* seed();
    const source = yield* memory.capture(evidence);
    assert.equal((yield* memory.context(record)).text, "");
    yield* memory.process(source.operationKey);
    const context = yield* memory.context(record);
    assert.include(context.text, "dark editor");
    assert.isAtMost(context.text.length, 12000);
    yield* memory.forget(
      sourceTuple(
        { environmentId: evidence.environmentId, owner: source.source.owner, ownerRevision: 0 },
        source.source,
      ),
    );
    const next = yield* memory.context(record);
    assert.equal(next.text, "");
    assert.isAbove(next.memoryEpoch, context.memoryEpoch);
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_cleanup WHERE status='pending'`)[0]
        ?.n,
      1,
    );
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "sharing hydrates current grants symmetrically and invalidates recipient epochs on revoke",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const repository = yield* AssistantRepository;
      const sibling = yield* repository.create({ ...input, commandId: CommandId.make("sibling") });
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      assert.equal((yield* memory.context(sibling)).text, "");
      const grantInput = {
        environmentId: evidence.environmentId,
        ownerRevision: 0,
        source: {
          owner: first.source.owner,
          sourceId: first.source.sourceId,
          sourceRevision: first.source.sourceRevision,
        },
        recipient: { kind: "assistant" as const, assistantId: sibling.detail.summary.assistantId },
        recipientRevision: 0,
      };
      const grant = yield* memory.grant(grantInput);
      const shared = yield* memory.context(sibling);
      assert.include(shared.text, "dark editor");
      yield* memory.revoke({ ...grantInput, grantId: grant.id });
      const revoked = yield* memory.context(sibling);
      assert.equal(revoked.text, "");
      assert.isAbove(revoked.memoryEpoch, shared.memoryEpoch);
      assert.include((yield* memory.context(record)).text, "dark editor");
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "forget fences another matching source's cached index payload and generic SQL recall",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, authority, processing, record } = yield* seed();
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const second = yield* memory.capture({
        ...evidence,
        messageId: MessageId.make("duplicate-source"),
      });
      yield* memory.process(second.operationKey);
      const scope = {
        environmentId: evidence.environmentId,
        owner: first.source.owner,
        ownerRevision: 0,
      };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE t3_workflow_v2_memory_processing SET status='uncertain',index_json='"old-prepared-vector-payload"' WHERE operation_key=${second.operationKey}`;
      yield* memory.forget(sourceTuple(scope, first.source));
      yield* processing.index(second.operationKey, {
        environmentId: evidence.environmentId,
        owner: first.source.owner,
        enabled: true,
        embeddingEnabled: true,
        command: "must-never-run",
        args: [],
        cwd: "/tmp",
      });
      assert.equal((yield* memory.context(record)).text, "");
      assert.equal(
        (yield* authority.recallText({ ...scope, limit: 100, query: "dark" })).length,
        0,
      );
      assert.equal(
        (yield* authority.hydrateCurrentHits({
          ...scope,
          hits: [sourceTuple(scope, second.source)],
        })).length,
        0,
      );
      assert.equal(
        (yield* sql`SELECT status FROM t3_workflow_v2_memory_processing WHERE operation_key=${second.operationKey}`)[0]
          ?.status,
        "stale",
      );
    }).pipe(Effect.provide(fixture())),
);
