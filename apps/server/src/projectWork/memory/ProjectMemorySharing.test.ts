import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Memory from "./ProjectMemoryService.ts";
import { layer, seed, scope, captureInput, env } from "./ProjectMemoryService.test-utils.ts";
import { sourceTuple } from "./ProjectMemoryRepository.ts";
it.effect(
  "sharing requires exact live owners and source revision; revocation immediately hides hydrated hits",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const other = ProjectId.make("recipient");
      yield* seed(other);
      const memory = yield* Memory.ProjectMemoryService;
      const source = yield* memory.capture(captureInput());
      const recipient = {
        environmentId: env,
        owner: { kind: "project" as const, projectId: other },
        ownerRevision: 0,
      };
      const hit = sourceTuple(scope, source);
      assert.deepStrictEqual(yield* memory.hydrateCurrentHits({ ...recipient, hits: [hit] }), []);
      const grant = yield* memory.grant({
        environmentId: env,
        source: {
          owner: scope.owner,
          sourceId: source.sourceId,
          sourceRevision: source.sourceRevision,
        },
        ownerRevision: 0,
        recipient: recipient.owner,
        recipientRevision: 0,
      });
      assert.equal((yield* memory.hydrateCurrentHits({ ...recipient, hits: [hit] })).length, 1);
      assert.equal(
        (yield* Effect.result(memory.grant({ ...grant, recipientRevision: 1 })))._tag,
        "Failure",
      );
      yield* memory.revoke({ ...grant, grantId: grant.id });
      assert.deepStrictEqual(yield* memory.hydrateCurrentHits({ ...recipient, hits: [hit] }), []);
      const grantAfter = yield* memory.grant(grant);
      yield* memory.deleteOwner(recipient);
      assert.equal(
        (yield* Effect.result(memory.hydrateCurrentHits({ ...recipient, hits: [hit] })))._tag,
        "Failure",
      );
      yield* memory.revoke({ ...grantAfter, grantId: grantAfter.id });
      assert.deepStrictEqual(yield* memory.listGrants({ ...scope, limit: 100 }), []);
    }).pipe(Effect.provide(layer)),
);
