import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Merge from "./ProjectWorkManagedMerge.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import {
  dependencies,
  principal,
  operation,
  outcome,
  confirmation,
} from "./ProjectWorkPublication.testkit.ts";
const layer = (options: Parameters<typeof dependencies>[0]) =>
  Merge.layer.pipe(
    Layer.provide(dependencies(options)),
    Layer.provideMerge(Journal.layer),
    Layer.provideMerge(Sqlite.layerMemory),
  );
const input = { operationId: "merge", publicationOperationId: "publish", gateId: "gate" };
const seed = Effect.gen(function* () {
  const journal = yield* Journal.ProjectWorkPublicationJournal;
  const pub = operation();
  yield* journal.retain(pub);
  yield* journal.claim(pub);
  yield* journal.save({ ...pub, stage: "confirmed", publication: outcome(pub) });
  yield* journal.retain(operation("merge"));
});
it.effect("refuses a host without conditional exact-head merge before any write", () => {
  let writes = 0;
  return Effect.gen(function* () {
    yield* seed;
    const service = yield* Merge.ProjectWorkManagedMerge;
    const result = yield* service.execute(input, principal).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.reason, "unsupported");
    assert.equal(writes, 0);
  }).pipe(
    Effect.provide(
      layer({
        host: {
          mergeExact: () => {
            writes++;
            return Effect.succeed(confirmation);
          },
        },
      }),
    ),
  );
});
it.effect("timeout after successful merge reconciles exact source without another merge", () => {
  let writes = 0;
  return Effect.gen(function* () {
    yield* seed;
    const service = yield* Merge.ProjectWorkManagedMerge;
    const receipt = yield* service.execute(input, principal);
    assert.equal(receipt.stage, "confirmed");
    assert.deepEqual((yield* service.execute(input, principal)).merge, confirmation);
    assert.equal(writes, 1);
  }).pipe(
    Effect.provide(
      layer({
        host: {
          supportsExactMerge: () => Effect.succeed(true),
          mergeExact: () => {
            writes++;
            return Effect.fail(new Journal.PublicationError({ reason: "uncertain" }));
          },
          reconcileMerge: () => Effect.succeed(confirmation),
        },
      }),
    ),
  );
});
it.effect("moved source head cannot become a confirmed merge receipt", () =>
  Effect.gen(function* () {
    yield* seed;
    const service = yield* Merge.ProjectWorkManagedMerge;
    const receipt = yield* service.execute(input, principal);
    assert.equal(receipt.stage, "uncertain");
    assert.equal(receipt.merge, undefined);
  }).pipe(
    Effect.provide(
      layer({
        host: {
          supportsExactMerge: () => Effect.succeed(true),
          mergeExact: () => Effect.succeed({ ...confirmation, authorizedHeadSha: "f".repeat(40) }),
        },
      }),
    ),
  ),
);
