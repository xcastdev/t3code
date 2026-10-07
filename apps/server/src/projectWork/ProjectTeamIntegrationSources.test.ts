import { expect, it } from "@effect/vitest";
import { ProjectId, ProjectWorkTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { scoped } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkRepository } from "./ProjectWorkRepository.ts";
import { makeProjectTeamIntegrationSources } from "./ProjectTeamIntegrationSources.ts";

it.effect(
  "integration source pages deny absent and foreign transaction owners without manufacturing candidates",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient,
          repository = yield* ProjectWorkRepository;
        const sources = yield* makeProjectTeamIntegrationSources({ environmentId: "environment" });
        const request = {
          projectId: ProjectId.make("missing-project"),
          integrationTaskId: ProjectWorkTaskId.make("missing-integration"),
          offset: 0,
          limit: 1,
        };
        expect((yield* sources.candidatesInTransaction(request).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* sql
            .withTransaction(
              sources
                .candidatesInTransaction(request)
                .pipe(Effect.provideService(SqlClient.SqlClient, { ...sql })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql
            .withTransaction(
              sources
                .candidatesInTransaction(request)
                .pipe(Effect.provideService(ProjectWorkRepository, { ...repository })),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql.withTransaction(sources.candidatesInTransaction(request)).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(yield* sql`SELECT count(*) AS count FROM project_team_dispatch`).toEqual([
          { count: 0 },
        ]);
      }),
    ),
);
