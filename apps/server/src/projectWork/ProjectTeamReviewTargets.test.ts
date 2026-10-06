import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import {
  makeProjectTeamReviewTargets,
  ProjectTeamReviewTargetError,
} from "./ProjectTeamReviewTargets.ts";

const options = { environmentId: "environment", maximumEnvironmentModelCalls: 4 };
it.effect("review target readers cannot borrow a foreign or absent context transaction", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const targets = yield* makeProjectTeamReviewTargets(options);
      for (const operation of [
        targets.captureInitial(f.snapshot),
        targets.readForDispatch(f.snapshot),
      ]) {
        const absent = yield* operation.pipe(Effect.result);
        expect(absent._tag).toBe("Failure");
        if (absent._tag === "Failure")
          expect(absent.failure).toBeInstanceOf(ProjectTeamReviewTargetError);
        const foreign = yield* f.sql
          .withTransaction(operation.pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })))
          .pipe(Effect.result);
        expect(foreign._tag).toBe("Failure");
        if (foreign._tag === "Failure")
          expect(foreign.failure).toBeInstanceOf(ProjectTeamReviewTargetError);
      }
      expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
    }),
  ),
);
it.effect("an actual settled implementer cannot acquire a reviewer association", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const targets = yield* makeProjectTeamReviewTargets(options);
      const result = yield* f.sql
        .withTransaction(targets.captureInitial(f.snapshot))
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toBeInstanceOf(ProjectTeamReviewTargetError);
      expect(yield* f.sql`SELECT * FROM project_team_review_target`).toEqual([]);
    }),
  ),
);
it.effect("review environment options are captured before the factory effect runs", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const mutable = { ...options };
      const factory = makeProjectTeamReviewTargets(mutable);
      mutable.environmentId = "foreign";
      const targets = yield* factory;
      const result = yield* f.sql
        .withTransaction(targets.readForDispatch(f.snapshot))
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toBeInstanceOf(ProjectTeamReviewTargetError);
    }),
  ),
);
it.effect("malformed private environment options fail before target access", () =>
  scoped(
    Effect.gen(function* () {
      for (const environmentId of ["", " environment", "environment\0"]) {
        const result = yield* makeProjectTeamReviewTargets({ ...options, environmentId }).pipe(
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure).toBeInstanceOf(ProjectTeamReviewTargetError);
      }
    }),
  ),
);

it.effect(
  "historical target reader rejects absent and foreign transactions without storage access",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const targets = yield* makeProjectTeamReviewTargets(options);
        for (const operation of [
          targets.readRetainedForDispatch(f.snapshot),
          f.sql.withTransaction(
            targets
              .readRetainedForDispatch(f.snapshot)
              .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })),
          ),
        ]) {
          const result = yield* operation.pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toBeInstanceOf(ProjectTeamReviewTargetError);
        }
      }),
    ),
);

it.effect("historical target reader preserves actual SQL failure for settlement rollback", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const targets = yield* makeProjectTeamReviewTargets(options);
      yield* f.sql`ALTER TABLE project_team_dispatch RENAME TO project_team_dispatch_storage_unavailable`;
      const result = yield* f.sql
        .withTransaction(targets.readRetainedForDispatch(f.snapshot))
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(SqlError.isSqlError(result.failure)).toBe(true);
    }),
  ),
);
