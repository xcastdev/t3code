import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { makeProjectTeamCompletedReviewReader } from "./ProjectTeamReviewCompleted.ts";

it.effect("completed review history requires the captured SQL and repository loan", () =>
  scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient,
        repository = yield* ProjectWorkRepository;
      const reader = yield* makeProjectTeamCompletedReviewReader({ environmentId: "environment" });
      const request = { dispatchId: "missing-review", expectedProposalSha256: "a".repeat(64) };
      expect((yield* reader.readInTransaction(request).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* sql
          .withTransaction(
            reader
              .readInTransaction(request)
              .pipe(Effect.provideService(SqlClient.SqlClient, { ...sql })),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* sql
          .withTransaction(
            reader
              .readInTransaction(request)
              .pipe(Effect.provideService(ProjectWorkRepository, { ...repository })),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const missing = yield* sql
        .withTransaction(reader.readInTransaction(request))
        .pipe(Effect.result);
      expect(missing._tag).toBe("Failure");
      expect(yield* sql`SELECT count(*) AS count FROM project_work_command_receipts`).toEqual([
        { count: 0 },
      ]);
    }),
  ),
);
