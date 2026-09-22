import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type ManagedSkillKey,
  type OrchestrationEvent,
  type ProviderInstanceId,
  type SkillCatalogRevision,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { SkillApplicationExecutionError } from "../../skills/SkillApplicationExecutor.ts";
import { makeSkillApplicationReceipt } from "./SkillApplicationReactor.ts";

const desired = {
  providerInstanceId: "codex" as ProviderInstanceId,
  threadId: "thread-one" as ThreadId,
  desiredRevision: 2 as SkillCatalogRevision,
  appliedRevision: 1 as SkillCatalogRevision,
  status: "pending_new_session" as const,
  outcomes: [{ key: "deploy" as ManagedSkillKey, status: "pending_new_session" as const }],
};

const event: Extract<OrchestrationEvent, { type: "thread.skill-application.desired" }> = {
  sequence: 1,
  eventId: EventId.make("event-skill-desired"),
  commandId: CommandId.make("command-skill-desired"),
  aggregateKind: "thread",
  aggregateId: "thread-one" as ThreadId,
  occurredAt: "2026-09-20T12:00:00.000Z",
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.skill-application.desired",
  payload: { threadId: "thread-one" as ThreadId, application: desired },
};

describe("SkillApplicationReactor", () => {
  it.effect("advances applied revision only after successful provider execution", () =>
    Effect.gen(function* () {
      const receipt = yield* makeSkillApplicationReceipt({
        event,
        execute: (application) =>
          Effect.succeed({
            ...application,
            appliedRevision: application.desiredRevision,
            status: "applied",
            outcomes: application.outcomes.map((outcome) => ({ ...outcome, status: "applied" })),
            appliedAt: "1970-01-01T00:00:01.000Z",
          }),
      });
      assert.equal(receipt.application.desiredRevision, 2);
      assert.equal(receipt.application.appliedRevision, 2);
      assert.equal(receipt.application.status, "applied");
    }),
  );

  it.effect("keeps desired and last applied revisions after provider failure", () =>
    Effect.gen(function* () {
      const receipt = yield* makeSkillApplicationReceipt({
        event,
        execute: () =>
          Effect.fail(
            new SkillApplicationExecutionError({ code: "boom", detail: "secret detail" }),
          ),
      });
      assert.equal(receipt.application.desiredRevision, 2);
      assert.equal(receipt.application.appliedRevision, 1);
      assert.equal(receipt.application.status, "failed");
      assert.equal(receipt.application.failure?.code, "provider_skill_apply_failed");
      assert.notInclude(receipt.application.failure?.message ?? "", "secret detail");
    }),
  );
});
