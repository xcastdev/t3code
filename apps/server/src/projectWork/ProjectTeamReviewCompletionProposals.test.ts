import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as Schema from "effect/Schema";
import { ProjectTeamGuidedIntent } from "@t3tools/contracts";
import { scoped, attribution, projectId, taskId } from "./ProjectTeamAuthorization.testFixtures.ts";
import { makeProjectTeamReviewCompletionProposals } from "./ProjectTeamReviewCompletionProposals.ts";

const decodeReport = Schema.decodeUnknownSync(ProjectTeamGuidedIntent, {
  onExcessProperty: "error",
});
const report = decodeReport({
  type: "project-team.assignment.report",
  commandId: "completion-proposal",
  projectId,
  taskId,
  expectedRevision: 0,
  expectedTaskRevision: 0,
  specRevision: 0,
  planRevision: 0,
  assignmentId: "review-assignment",
  expectedAssignmentRevision: 0,
  summary: "Independent review report",
  evidenceIds: [],
  outputArtifactIds: [],
  outcome: "complete",
});

it.effect(
  "completion proposals deny a caller without the original SQL transaction before authority resolution",
  () =>
    scoped(
      Effect.gen(function* () {
        let resolutions = 0;
        const proposals = yield* makeProjectTeamReviewCompletionProposals(() =>
          Effect.sync(() => {
            resolutions++;
            return undefined;
          }),
        );
        const sql = yield* SqlClient.SqlClient;
        expect(
          (yield* proposals
            .compile({ actor: attribution.actor }, report, attribution)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* sql
            .withTransaction(
              proposals.validate({ actor: attribution.actor }, report, attribution, {
                duplicate: false,
              }),
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const actions = [
          proposals.compile({ actor: attribution.actor }, report, attribution).pipe(Effect.asVoid),
          proposals.validate({ actor: attribution.actor }, report, attribution, {
            duplicate: false,
          }),
          proposals
            .readRetained({ environmentId: "environment", projectId, commandId: report.commandId })
            .pipe(Effect.asVoid),
        ];
        for (const action of actions) {
          expect(
            (yield* sql
              .withTransaction(action.pipe(Effect.provideService(SqlClient.SqlClient, { ...sql })))
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* sql
              .withTransaction(
                action.pipe(
                  Effect.updateContext((context: Context.Context<never>) =>
                    Context.omit(SqlClient.SqlClient)(context),
                  ),
                ),
              )
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(resolutions).toBe(0);
      }),
    ),
);

it.effect(
  "retained proposal reads preserve an actual SQL failure separately from unavailable proof",
  () =>
    scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const proposals = yield* makeProjectTeamReviewCompletionProposals(() =>
          Effect.succeed(undefined),
        );
        yield* sql`DROP TABLE project_team_review_completion_proposal`;
        const result = yield* sql
          .withTransaction(
            proposals.readRetained({
              environmentId: "environment",
              projectId,
              commandId: report.commandId,
            }),
          )
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(SqlError.isSqlError(result.failure)).toBe(true);
      }),
    ),
);
