import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { at, projectId, scoped, seed } from "./ProjectTeamAuthorization.testFixtures.ts";
import { readProjectTeamBindingAccountingInTransaction } from "./ProjectTeamUsageRead.ts";

it.effect(
  "distinguishes a budget-only orphan from an unadmitted assignment and rejects a foreign host",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at) + 1);
        const f = yield* seed("implementer", "reserved", { issueCredential: false });
        const read = (environmentId: string) =>
          f.sql
            .withTransaction(
              readProjectTeamBindingAccountingInTransaction(f.sql, projectId, [f.binding]),
            )
            .pipe(
              Effect.provideService(ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make(environmentId)),
              }),
            );
        expect(yield* f.sql`SELECT 1 FROM project_team_dispatch`).toEqual([]);
        expect(yield* f.sql`SELECT 1 FROM project_team_pi_operation`).toEqual([]);
        const binding = yield* f.sql`SELECT * FROM project_team_run_binding`;
        expect(yield* read("environment")).toMatchObject([
          {
            availability: "not-admitted",
            bindingId: f.binding.recordId,
          },
        ]);
        expect(yield* read("foreign-environment")).toMatchObject([
          {
            availability: "unavailable",
            reason: "owner-invalid",
          },
        ]);
        yield* f.sql`INSERT INTO project_team_model_budget
      VALUES ('environment',${projectId},${f.binding.taskId},1000,${Date.parse(at) + 10000})`;
        const budget = yield* f.sql`SELECT * FROM project_team_model_budget`;
        expect(yield* read("environment")).toMatchObject([
          {
            availability: "unavailable",
            reason: "budget-invalid",
            bindingId: f.binding.recordId,
          },
        ]);
        expect(yield* f.sql`SELECT * FROM project_team_run_binding`).toEqual(binding);
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual(budget);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      }),
    ),
);
