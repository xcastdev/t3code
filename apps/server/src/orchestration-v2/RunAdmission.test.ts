import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Admission from "./RunAdmission.ts";
it.effect("ordinary compositions explicitly retain ordinary admission behavior", () =>
  Effect.gen(function* () {
    const admission = yield* Admission.RunAdmission;
    const input = { threadId: ThreadId.make("ordinary"), now: "2026-01-01T00:00:00.000Z" };
    assert.deepStrictEqual(yield* admission.check({ ...input, operation: "escape" }), {
      _tag: "ordinary",
    });
    assert.deepStrictEqual(
      yield* admission.commit({ ...input, commandId: "message", operation: "create" }),
      { _tag: "ordinary" },
    );
  }).pipe(Effect.provide(Admission.layerOrdinary)),
);
