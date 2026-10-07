import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { verificationFixture } from "./ProjectWorkVerification.testFixtures.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import {
  makeProjectTeamReviewResolutionReader,
  ProjectTeamReviewResolutionError,
} from "./ProjectTeamReviewResolution.ts";
const request = {
  findingRecordId: "absent",
  expectedFindingRevision: 0,
  expectedFindingSha256: "a".repeat(64),
};

it.effect(
  "resolution history requires the captured SQL, repository and actual caller transaction",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const repository = yield* ProjectWorkRepository;
        const reader = yield* makeProjectTeamReviewResolutionReader({
          environmentId: "environment",
        });
        const cases = [
          reader.readInTransaction(request),
          f.sql.withTransaction(
            reader
              .readInTransaction(request)
              .pipe(Effect.provideService(SqlClient.SqlClient, { ...f.sql })),
          ),
          f.sql.withTransaction(
            reader
              .readInTransaction(request)
              .pipe(Effect.provideService(ProjectWorkRepository, { ...repository })),
          ),
        ];
        for (const effect of cases) {
          const result = yield* effect.pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure).toBeInstanceOf(ProjectTeamReviewResolutionError);
        }
        expect(yield* f.sql.withTransaction(reader.readInTransaction(request))).toBeUndefined();
      }),
    ),
);

it.effect(
  "resolution history propagates actual unavailable SQL rather than an absent association",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* verificationFixture;
        const reader = yield* makeProjectTeamReviewResolutionReader({
          environmentId: "environment",
        });
        yield* f.sql`ALTER TABLE project_team_review_finding RENAME TO unavailable_resolution_findings`;
        const result = yield* f.sql
          .withTransaction(reader.readInTransaction(request))
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(SqlError.isSqlError(result.failure)).toBe(true);
      }),
    ),
);

it.effect("resolution request and environment capture rejects unknown fields before SQL", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* verificationFixture;
      const reader = yield* makeProjectTeamReviewResolutionReader({ environmentId: "environment" });
      const malformed = { ...request, approved: true };
      const result = yield* f.sql
        .withTransaction(reader.readInTransaction(malformed))
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toBeInstanceOf(ProjectTeamReviewResolutionError);
      expect(
        (yield* makeProjectTeamReviewResolutionReader({ environmentId: " environment" }).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
    }),
  ),
);
