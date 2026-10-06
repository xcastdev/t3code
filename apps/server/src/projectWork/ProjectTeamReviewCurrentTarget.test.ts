import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ManagedGit from "../git/ManagedGitExecution.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { makeProjectTeamReviewCurrentTarget } from "./ProjectTeamReviewCurrentTarget.ts";

const joined = { receiptId: "current-target-joined", stage: "settled" as const, evidence: {} };

it.effect("current review target factory captures dependencies without native IO", () =>
  scoped(
    Effect.gen(function* () {
      const make = vi
        .spyOn(ManagedGit, "make")
        .mockImplementation(() => Effect.die("Unexpected native construction"));
      try {
        yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
        expect(make).not.toHaveBeenCalled();
        const injected = { environmentId: "environment", extra: true };
        const invalid = makeProjectTeamReviewCurrentTarget(injected);
        expect(
          (yield* Effect.gen(function* () {
            return yield* invalid;
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      } finally {
        make.mockRestore();
      }
    }),
  ),
);

it.effect("current review target bypasses native loans only for an actually settled dispatch", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const snapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
      const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
      const make = vi
        .spyOn(ManagedGit, "make")
        .mockImplementation(() => Effect.die("Unexpected native construction"));
      try {
        let settlements = 0;
        expect(
          yield* target.withOriginalTarget(
            snapshot,
            joined,
            Effect.sync(() => ++settlements),
          ),
        ).toBe(1);
        expect(make).not.toHaveBeenCalled();
      } finally {
        make.mockRestore();
      }
    }),
  ),
);

it.effect(
  "current review target rejects inherited or foreign transaction ownership before settlement",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const snapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectWorkRepository;
        const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
        let settlements = 0;
        const settle = Effect.sync(() => {
          settlements++;
        });
        expect(
          (yield* sql
            .withTransaction(target.withOriginalTarget(snapshot, joined, settle))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* target
            .withOriginalTarget(snapshot, joined, settle)
            .pipe(Effect.provide(SqlitePersistenceMemory), Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* target
            .withOriginalTarget(snapshot, joined, settle)
            .pipe(Effect.provideService(ProjectWorkRepository, { ...repository }), Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(settlements).toBe(0);
      }),
    ),
);

it.effect("current review target assertions require the actual factory-owned live loan", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const snapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
      const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
      const input = { snapshot, jobId: f.prepared.manifest.jobId, manifestHash: f.prepared.sha256 };
      expect((yield* target.assertInTransaction(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* f.sql.withTransaction(target.assertInTransaction(input)).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.sql
          .withTransaction(target.assertOriginalInTransaction(snapshot, joined))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

it.effect(
  "current review target captures settlement inputs synchronously and rejects excess fields",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const originalSnapshot = yield* f.journal.readRetained(f.snapshot.fence.dispatchId);
        const target = yield* makeProjectTeamReviewCurrentTarget({ environmentId: "environment" });
        const snapshot = structuredClone(originalSnapshot);
        const receipt = structuredClone(joined);
        const effect = target.withOriginalTarget(snapshot, receipt, Effect.succeed("original"));
        Reflect.set(snapshot.fence, "dispatchId", "foreign");
        Reflect.set(receipt, "stage", "quarantine");
        expect(yield* effect).toBe("original");
        const injectedSnapshot = { ...originalSnapshot, extra: true };
        const injectedReceipt = { ...joined, extra: true };
        expect(
          (yield* target
            .withOriginalTarget(injectedSnapshot, joined, Effect.void)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* target
            .withOriginalTarget(originalSnapshot, injectedReceipt, Effect.void)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);
