import * as Context from "effect/Context";
import { ProjectMemoryFactPolicy } from "../projectWork/memory/ProjectMemoryFactPolicy.ts";
import type { AssistantMemoryEvidence } from "./AssistantMemory.ts";
import { AssistantRepository } from "./AssistantRepository.ts";
import * as Schema from "effect/Schema";
import {
  CommandId,
  MemoryExtractionResult,
  AssistantConfigurationRevision,
} from "@t3tools/contracts";
import { environmentId } from "./AssistantTestHelpers.ts";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  RunAttemptId,
  AssistantId,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { sourceTuple, memoryHash } from "../projectWork/memory/ProjectMemoryRepository.ts";
import { fixture, seed } from "./AssistantMemory.test-utils.ts";

const encodeExtractionReceipt = Schema.encodeSync(Schema.fromJsonString(MemoryExtractionResult));

it.effect("captures settled evidence once, supersedes edits, and preserves source provenance", () =>
  Effect.gen(function* () {
    const { memory, evidence, record } = yield* seed();
    const first = yield* memory.capture(evidence);
    yield* memory.capture(evidence);
    const sql = yield* SqlClient.SqlClient;
    assert.equal(
      (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_assistant_memory_receipts`)[0]?.n,
      1,
    );
    yield* memory.process(first.operationKey);
    assert.include((yield* memory.context(record)).text, "dark editor");
    const corrected = yield* memory.capture({
      ...evidence,
      content: "I prefer the light editor theme.",
    });
    assert.equal(corrected.source.sourceRevision, 1);
    assert.equal(corrected.source.supersedes, first.source.recordId);
    assert.equal((yield* memory.context(record)).text, "");
    yield* memory.process(corrected.operationKey);
    assert.include((yield* memory.context(record)).text, "light editor");
    assert.equal(
      (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_sources WHERE status='superseded'`)[0]
        ?.n,
      1,
    );
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "forget suppresses normalized fact lineage and assistant echoes; only a new explicit user confirmation can teach it again",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const before = yield* memory.context(record);
      yield* memory.forget(
        sourceTuple(
          { environmentId: evidence.environmentId, owner: first.source.owner, ownerRevision: 0 },
          first.source,
        ),
      );
      const forgotten = yield* memory.context(record);
      assert.equal(forgotten.text, "");
      assert.isAbove(forgotten.memoryEpoch, before.memoryEpoch);
      assert.equal(
        (yield* Effect.result(memory.capture(evidence, { reteach: true })))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          memory.capture({
            ...evidence,
            messageId: MessageId.make("echo"),
            content: "ASSISTANT: You like a dark editor.",
          }),
        ))._tag,
        "Failure",
      );
      const paraphrase = {
        ...evidence,
        messageId: MessageId.make("message-2"),
        runId: RunId.make("run-2"),
        content: "A dark theme is what I like.",
      };
      const automatic = yield* memory.capture(paraphrase);
      yield* memory.process(automatic.operationKey);
      assert.equal((yield* memory.context(record)).text, "");
      const explicit = yield* memory.capture(
        { ...paraphrase, messageId: MessageId.make("message-3") },
        { reteach: true },
      );
      yield* memory.process(explicit.operationKey);
      assert.include((yield* memory.context(record)).text, "dark theme");
      yield* memory.process(first.operationKey);
      assert.notInclude((yield* memory.context(record)).text, "dark editor");
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "forget during extraction wins over the late native result and keeps its lineage tombstone",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const { memory, evidence, record } = yield* seed();
        const first = yield* memory.capture(evidence);
        const worker = yield* memory.process(first.operationKey).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* memory.forget(
          sourceTuple(
            { environmentId: evidence.environmentId, owner: first.source.owner, ownerRevision: 0 },
            first.source,
          ),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(worker);
        assert.equal((yield* memory.context(record)).text, "");
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_fact_tombstones`)[0]?.n,
          1,
        );
        assert.equal(
          (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_observations`)[0]?.n,
          0,
        );
      }).pipe(
        Effect.provide(
          fixture((input) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({
                facts: [
                  { key: "editor.preference", body: input.sourceText, quote: input.sourceText },
                ],
              }),
            ),
          ),
        ),
      );
    }),
);

it.effect(
  "manual memory correction removes old context immediately and recovery cannot overwrite it",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const before = yield* memory.context(record);
      const edit = yield* memory.edit({
        previous: sourceTuple(
          { environmentId: evidence.environmentId, owner: first.source.owner, ownerRevision: 0 },
          first.source,
        ),
        content: "I prefer a light theme now.",
      });
      assert.equal((yield* memory.context(record)).text, "");
      assert.isAbove((yield* memory.context(record)).memoryEpoch, before.memoryEpoch);
      yield* memory.process(edit.operationKey);
      assert.include((yield* memory.context(record)).text, "light theme");
      const recovered = yield* memory.capture(evidence);
      assert.equal(recovered.source.content, "I prefer a light theme now.");
      assert.equal(recovered.operationKey, edit.operationKey);
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "unknown forgotten lineage is visible, suppresses automatic facts, and permits explicit new user teaching",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const first = yield* memory.capture(evidence);
      const scope = {
        environmentId: evidence.environmentId,
        owner: first.source.owner,
        ownerRevision: 0,
      };
      yield* memory.forget(sourceTuple(scope, first.source));
      const status = yield* memory.status(scope);
      assert.equal(status.unresolvedForgottenSources, 1);
      assert.isTrue(status.requiresUserConfirmation);
      const next = {
        ...evidence,
        messageId: MessageId.make("new"),
        content: "My preferred shell is zsh.",
      };
      const pending = yield* memory.capture(next);
      yield* memory.process(pending.operationKey);
      assert.equal((yield* memory.context(record)).text, "");
      const taught = yield* memory.capture(
        { ...next, messageId: MessageId.make("confirmed") },
        { reteach: true },
      );
      yield* memory.process(taught.operationKey);
      assert.include((yield* memory.context(record)).text, "zsh");
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "known forgotten keys suppress their paraphrases while unrelated automatic facts continue",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const scope = {
        environmentId: evidence.environmentId,
        owner: first.source.owner,
        ownerRevision: 0,
      };
      yield* memory.forget(sourceTuple(scope, first.source));
      assert.equal((yield* memory.status(scope)).unresolvedForgottenSources, 0);
      const next = yield* memory.capture({
        ...evidence,
        messageId: MessageId.make("shell"),
        content: "My preferred shell is zsh.",
      });
      yield* memory.process(next.operationKey);
      assert.include((yield* memory.context(record)).text, "zsh");
    }).pipe(
      Effect.provide(
        fixture((input) =>
          Effect.succeed({
            facts: [
              {
                key: input.sourceText.includes("shell") ? "shell.preference" : "editor.preference",
                body: input.sourceText,
                quote: input.sourceText,
              },
            ],
          }),
        ),
      ),
    ),
);

it.effect(
  "a retained pre-forget user span cannot become a new authorization by requesting reteach",
  () =>
    Effect.gen(function* () {
      const { memory, evidence } = yield* seed();
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const scope = {
        environmentId: evidence.environmentId,
        owner: first.source.owner,
        ownerRevision: 0,
      };
      yield* memory.forget(sourceTuple(scope, first.source));
      const replay = yield* Effect.result(
        memory.capture(
          {
            ...evidence,
            messageId: MessageId.make("old-unconsumed-span"),
            settledAt: "1969-12-31T23:59:59.000Z",
          },
          { reteach: true },
        ),
      );
      assert.equal(replay._tag, "Failure");
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "explicit assistant owner extraction routes are retained and selected; default receipt has no external route",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      assert.include((yield* memory.context(record)).text, "dark editor");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT json_extract(input_json,'$.extractionRoute.owner.assistantId') AS owner FROM t3_workflow_v2_memory_processing WHERE operation_key=${first.operationKey}`)[0]
          ?.owner,
        evidence.assistantId,
      );
    }).pipe(
      Effect.provide(
        fixture(undefined, {
          extractionRoute: {
            environmentId: environmentId,
            owner: {
              kind: "assistant",
              assistantId: AssistantId.make(
                "assistant-" + memoryHash(canonicalProjectWorkPayload([environmentId, "create"])),
              ),
            },
            enabled: true,
            provider: "liquid",
            endpoint: "https://example.test/extraction",
            model: "explicit",
            secretName: "assistant-owned-route",
          },
        }),
      ),
    ),
);

it.effect(
  "a new native attempt retains a new receipt revision even when message text is unchanged",
  () =>
    Effect.gen(function* () {
      const { memory, evidence } = yield* seed();
      const first = yield* memory.capture(evidence);
      const next = yield* memory.capture({
        ...evidence,
        runAttemptId: RunAttemptId.make("attempt-2"),
      });
      assert.equal(next.source.sourceRevision, 1);
      assert.equal(next.source.supersedes, first.source.recordId);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_assistant_memory_receipts`)[0]?.n,
        2,
      );
    }).pipe(Effect.provide(fixture())),
);

it.effect("explicit correction remains available when automatic capture is disabled", () =>
  Effect.gen(function* () {
    const { memory, evidence, record } = yield* seed();
    const first = yield* memory.capture(evidence);
    yield* memory.process(first.operationKey);
    const repository = yield* AssistantRepository;
    const configured = yield* repository.updateConfiguration({
      ...record.detail.summary,
      commandId: CommandId.make("disable-capture"),
      expectedRevision: AssistantConfigurationRevision.make(0),
      configuration: {
        ...record.detail.configuration.configuration,
        memory: { ...record.detail.configuration.configuration.memory, automaticCapture: false },
      },
    });
    const corrected = yield* memory.edit({
      previous: sourceTuple(
        { environmentId: evidence.environmentId, owner: first.source.owner, ownerRevision: 0 },
        first.source,
      ),
      content: "I prefer the light theme now.",
    });
    assert.equal((yield* memory.context(configured)).text, "");
    yield* memory.process(corrected.operationKey);
    assert.include((yield* memory.context(configured)).text, "light theme");
    assert.equal(
      (yield* Effect.result(
        memory.capture({ ...evidence, messageId: MessageId.make("automatic-off") }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "correction preserves valid post-forget teaching authorization without upgrading old evidence",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      const scope = {
        environmentId: evidence.environmentId,
        owner: { kind: "assistant" as const, assistantId: evidence.assistantId },
        ownerRevision: 0,
      };
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      yield* memory.forget(sourceTuple(scope, first.source));
      const taught = yield* memory.capture(
        {
          ...evidence,
          messageId: MessageId.make("post-forget-teaching"),
          settledAt: "2099-01-01T00:00:00.000Z",
        },
        { reteach: true },
      );
      yield* memory.process(taught.operationKey);
      const corrected = yield* memory.edit({
        previous: sourceTuple(scope, taught.source),
        content: "I prefer a light theme now.",
      });
      yield* memory.process(corrected.operationKey);
      assert.include((yield* memory.context(record)).text, "light theme");
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT reteach FROM t3_workflow_v2_assistant_memory_receipts WHERE source_json LIKE ${"%" + corrected.source.sourceId + "%"}`)[0]
          ?.reteach,
        1,
      );
      assert.equal(
        (yield* Effect.result(
          memory.edit({
            previous: sourceTuple(scope, first.source),
            content: "old source must stay forgotten",
          }),
        ))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(fixture())),
);

it.effect(
  "forget consumes retained validated facts before publication and restart leaves unrelated automatic facts available",
  () =>
    Effect.gen(function* () {
      const { memory, evidence, record, processing } = yield* seed();
      const scope = {
        environmentId: evidence.environmentId,
        owner: { kind: "assistant" as const, assistantId: evidence.assistantId },
        ownerRevision: 0,
      };
      const first = yield* memory.capture(evidence);
      const sql = yield* SqlClient.SqlClient;
      const receipt = encodeExtractionReceipt({
        facts: [{ key: "editor.preference", body: evidence.content, quote: evidence.content }],
      });
      yield* sql`UPDATE t3_workflow_v2_memory_processing SET result_json=${receipt},status='extracted' WHERE operation_key=${first.operationKey}`;
      yield* memory.forget(sourceTuple(scope, first.source));
      yield* memory.process(first.operationKey);
      assert.equal((yield* memory.status(scope)).unresolvedForgottenSources, 0);
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_observations`)[0]?.n,
        0,
      );
      // Simulate a restart from the earlier stale-job checkpoint without published lineage.
      yield* sql`DELETE FROM t3_workflow_v2_memory_fact_tombstones WHERE source_id=${first.source.sourceId}`;
      assert.equal((yield* memory.status(scope)).unresolvedForgottenSources, 1);
      yield* processing.reconcile();
      assert.equal((yield* memory.status(scope)).unresolvedForgottenSources, 0);
      const unrelated = yield* memory.capture({
        ...evidence,
        messageId: MessageId.make("shell-after-known-receipt"),
        content: "My preferred shell is zsh.",
      });
      yield* memory.process(unrelated.operationKey);
      assert.include((yield* memory.context(record)).text, "zsh");
      const old = yield* memory.capture({
        ...evidence,
        messageId: MessageId.make("echo-of-known-receipt"),
        content: "A dark editor is my preference.",
      });
      yield* memory.process(old.operationKey);
      assert.notInclude((yield* memory.context(record)).text, "dark editor");
    }).pipe(
      Effect.provide(
        fixture((input) =>
          Effect.succeed({
            facts: [
              {
                key: input.sourceText.includes("shell") ? "shell.preference" : "editor.preference",
                body: input.sourceText,
                quote: input.sourceText,
              },
            ],
          }),
        ),
      ),
    ),
);

it.effect(
  "recovery propagates an actual SQL enqueue outage and retries the retained capture without advancing its cursor",
  () => {
    let discovered: ReadonlyArray<AssistantMemoryEvidence> = [];
    return Effect.gen(function* () {
      const { memory, evidence, record } = yield* seed();
      discovered = [evidence];
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe(
        "CREATE TRIGGER p14_test_enqueue_outage BEFORE INSERT ON t3_workflow_v2_memory_processing BEGIN SELECT RAISE(ABORT,'simulated storage outage'); END",
      );
      const failed = yield* Effect.result(memory.recover());
      assert.equal(failed._tag, "Failure");
      if (failed._tag === "Failure") assert.equal(failed.failure.reason, "unavailable");
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_assistant_memory_receipts`)[0]?.n,
        1,
      );
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_processing`)[0]?.n,
        0,
      );
      yield* sql.unsafe("DROP TRIGGER p14_test_enqueue_outage");
      assert.equal(yield* memory.recover(), "after-batch");
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_assistant_memory_receipts`)[0]?.n,
        1,
      );
      const operation = (yield* sql<{
        operation_key: string;
      }>`SELECT operation_key FROM t3_workflow_v2_memory_processing`)[0]!;
      yield* memory.process(operation.operation_key);
      assert.include((yield* memory.context(record)).text, "dark editor");
    }).pipe(
      Effect.provide(
        fixture(undefined, {}, () =>
          Effect.succeed({ items: discovered, nextCursor: "after-batch" }),
        ),
      ),
    );
  },
);

it.effect("malformed or unquoted retained facts cannot resolve an unknown forgotten source", () =>
  Effect.gen(function* () {
    const { memory, evidence, processing } = yield* seed();
    const first = yield* memory.capture(evidence);
    const sql = yield* SqlClient.SqlClient;
    const invalid = encodeExtractionReceipt({
      facts: [
        {
          key: "foreign.preference",
          body: "A forged fact",
          quote: "words absent from the captured source",
        },
      ],
    });
    yield* sql`UPDATE t3_workflow_v2_memory_processing SET result_json=${invalid},status='extracted' WHERE operation_key=${first.operationKey}`;
    const scope = {
      environmentId: evidence.environmentId,
      owner: first.source.owner,
      ownerRevision: 0,
    };
    yield* memory.forget(sourceTuple(scope, first.source));
    yield* processing.reconcile();
    assert.equal((yield* memory.status(scope)).unresolvedForgottenSources, 1);
    assert.equal(
      (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_fact_tombstones`)[0]?.n,
      0,
    );
    assert.equal(
      (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_observations`)[0]?.n,
      0,
    );
  }).pipe(Effect.provide(fixture())),
);

it.effect(
  "the constructed fact policy retains its SQL service when called without an ambient SQL context",
  () =>
    Effect.gen(function* () {
      const { memory, evidence } = yield* seed();
      const first = yield* memory.capture(evidence);
      yield* memory.process(first.operationKey);
      const policy = yield* ProjectMemoryFactPolicy;
      if (policy.forget === undefined)
        return yield* Effect.die("Assistant policy must supply forget");
      const tuple = sourceTuple(
        { environmentId: evidence.environmentId, owner: first.source.owner, ownerRevision: 0 },
        first.source,
      );
      yield* policy.forget(tuple).pipe(Effect.provide(Context.empty()));
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_fact_tombstones WHERE source_id=${first.source.sourceId}`)[0]
          ?.n,
        1,
      );
    }).pipe(Effect.provide(fixture())),
);
