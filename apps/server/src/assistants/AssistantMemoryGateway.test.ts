import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  MessageId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { AssistantMemoryGateway, layer } from "./AssistantMemoryGateway.ts";
import * as Activity from "./AssistantMemoryActivity.ts";
import { AssistantSettledMemorySource } from "./AssistantMemorySources.ts";
import { fixture, seed } from "./AssistantMemory.test-utils.ts";
import { sourceTuple } from "../projectWork/memory/ProjectMemoryRepository.ts";

const gatewayFixture = layer.pipe(
  Layer.provideMerge(fixture()),
  Layer.provide(Activity.layer),
  Layer.provide(
    Layer.succeed(AssistantSettledMemorySource, { forRun: () => Effect.succeed(null) }),
  ),
  Layer.provide(
    Layer.mock(AuthSessionRepository)({
      getById: ({ sessionId }) =>
        Effect.succeed(
          Option.some({
            sessionId,
            subject: "human",
            scopes:
              sessionId === "operator"
                ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
                : [AuthOrchestrationReadScope],
            method: "browser-session-cookie",
            client: {
              label: null,
              ipAddress: null,
              userAgent: null,
              deviceType: "unknown",
              os: null,
              browser: null,
            },
            issuedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
            expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
            lastConnectedAt: null,
            revokedAt: null,
          }),
        ),
    }),
  ),
);

it.effect(
  "human read metadata works without facts; exact pending confirmation requires operate permission and is denied to native sessions",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const gateway = yield* AssistantMemoryGateway;
      const scope = { environmentId: evidence.environmentId, assistantId: evidence.assistantId };
      const reader = AuthSessionId.make("reader");
      const operator = AuthSessionId.make("operator");
      const metadata = yield* gateway.read(
        {
          ...scope,
          operation: "recipient",
          recipient: { kind: "assistant", assistantId: evidence.assistantId },
        },
        reader,
      );
      assert.equal(metadata.operation, "recipient");
      if (metadata.operation === "recipient") assert.equal(metadata.ownerRevision, 0);
      const original = yield* memory.capture(evidence);
      yield* memory.forget(
        sourceTuple(
          { environmentId: evidence.environmentId, owner: original.source.owner, ownerRevision: 0 },
          original.source,
        ),
      );
      const pending = yield* memory.capture({
        ...evidence,
        messageId: MessageId.make("reviewed-pending"),
        settledAt: "2099-01-01T00:00:00.000Z",
        content: "My preferred shell is zsh.",
      });
      yield* memory.process(pending.operationKey);
      const page = yield* gateway.read({ ...scope, operation: "confirmations" }, reader);
      assert.equal(page.operation, "confirmations");
      if (page.operation === "confirmations")
        assert.equal(page.items[0]?.sourceId, pending.source.sourceId);
      const source = {
        sourceId: pending.source.sourceId,
        sourceRevision: pending.source.sourceRevision,
        generation: pending.source.generation,
        contentHash: pending.source.contentHash,
      };
      const intent = { ...scope, operation: "confirm" as const, source };
      assert.equal((yield* Effect.result(gateway.write(intent, reader)))._tag, "Failure");
      const caller = {
        threadId: record.detail.summary.binding.canonicalThreadId,
        providerSessionId: "native",
      };
      assert.equal(
        (yield* Effect.result(gateway.readNative({ ...scope, operation: "confirmations" }, caller)))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          gateway.readNative(
            {
              ...scope,
              operation: "recipient",
              recipient: { kind: "assistant", assistantId: evidence.assistantId },
            },
            caller,
          ),
        ))._tag,
        "Failure",
      );
      assert.equal((yield* Effect.result(gateway.writeNative(intent, caller)))._tag, "Failure");
      const result = yield* gateway.write(intent, operator);
      assert.equal(result.operation, "confirm");
      assert.equal(result.source?.sourceRevision, pending.source.sourceRevision + 1);
    }).pipe(Effect.provide(gatewayFixture)),
);
