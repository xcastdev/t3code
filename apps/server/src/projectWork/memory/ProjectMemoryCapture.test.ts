import { assert, it } from "@effect/vitest";
import { ProjectId, EnvironmentId, AssistantId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Memory from "./ProjectMemoryService.ts";
import { memoryHash, sourceTuple } from "./ProjectMemoryRepository.ts";
import { layer, seed, scope, captureInput } from "./ProjectMemoryService.test-utils.ts";
it.effect(
  "capture derives task provenance and rejects forged content, revision and environment",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const memory = yield* Memory.ProjectMemoryService;
      const input = captureInput();
      for (const invalid of [
        { ...input, environmentId: EnvironmentId.make("other") },
        { ...input, selection: { ...input.selection, contentHash: "0".repeat(64) } },
        { ...input, reference: { ...input.reference, retainedRevision: 1 } },
      ])
        assert.equal((yield* Effect.result(memory.capture(invalid)))._tag, "Failure");
      const source = yield* memory.capture(input);
      assert.equal(source.attribution.actor.id, "person");
      const other = ProjectId.make("other");
      yield* seed(other, "Other memory");
      yield* memory.capture(captureInput("Other memory", other));
      assert.deepStrictEqual(
        (yield* memory.listCurrent({ ...scope, limit: 100 })).map((s) => s.content),
        ["Use focused tests"],
      );
    }).pipe(Effect.provide(layer)),
);
it.effect("unregistered assistants cannot claim memory authority", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    const source = yield* memory.capture(captureInput());
    const owner = {
      kind: "assistant" as const,
      assistantId: AssistantId.make(scope.owner.projectId),
    };
    assert.equal((yield* Effect.result(memory.deleteOwner({ ...scope, owner })))._tag, "Failure");
    assert.equal(
      (yield* Effect.result(
        memory.captureRetained({ ...scope, owner, source: { ...source, owner } }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "registered assistant owners reuse capture correction recall and grants with coincident IDs isolated",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const memory = yield* Memory.ProjectMemoryService;
      const source = yield* memory.capture(captureInput());
      const owner = {
        kind: "assistant" as const,
        assistantId: AssistantId.make(scope.owner.projectId),
      };
      const assistant = { ...scope, owner };
      const retained = {
        ...source,
        owner,
        sourceKind: "artifact" as const,
        content: "Private assistant source",
        contentHash: memoryHash("Private assistant source"),
      };
      yield* memory.captureRetained({ ...assistant, source: retained });
      assert.deepStrictEqual(
        (yield* memory.listCurrent({ ...scope, limit: 100 })).map((s) => s.content),
        [source.content],
      );
      assert.deepStrictEqual(
        (yield* memory.listCurrent({ ...assistant, limit: 100 })).map((s) => s.content),
        [retained.content],
      );
      const changed = {
        ...retained,
        content: "Corrected private source",
        contentHash: memoryHash("Corrected private source"),
        sourceRevision: 1,
        generation: 1,
      };
      yield* memory.correct({
        ...assistant,
        source: changed,
        previous: sourceTuple(assistant, retained),
      });
      assert.deepStrictEqual(
        (yield* memory.recallText({ ...assistant, limit: 100, query: "Corrected" })).map(
          (s) => s.content,
        ),
        [changed.content],
      );
      yield* memory.retract(sourceTuple(assistant, changed));
      assert.equal((yield* memory.listCurrent({ ...scope, limit: 100 })).length, 1);
      assert.equal((yield* memory.listCurrent({ ...assistant, limit: 100 })).length, 0);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(Memory.ProjectMemoryOwnerAuthority, {
        assertCurrent: () => Effect.void,
        sourceIsCurrent: () => Effect.succeed(true),
        authorizeCapture: () => Effect.void,
      }),
    ),
);
