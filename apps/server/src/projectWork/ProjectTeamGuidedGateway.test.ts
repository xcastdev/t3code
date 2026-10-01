import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  type ProjectTeamGuidedIntent,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { gatewayRuntime } from "./ProjectTeamAuthorization.testFixtures.ts";

const projectId = ProjectId.make("guided-gateway-project");
const taskId = ProjectWorkTaskId.make("guided-gateway-task");
const human = { kind: "human", id: "authenticated-user" } as const;
const source = { kind: "web", id: "authenticated-browser" } as const;
const at = "2026-01-01T00:00:00.000Z";
const investigation: ProjectTeamGuidedIntent = {
  type: "project-team.investigation.start",
  commandId: CommandId.make("guided-investigation"),
  projectId,
  taskId,
  expectedRevision: 1,
  expectedTaskRevision: 0,
  objective: "Find the cause without changing the project",
  outputDescriptions: ["A retained explanation of the cause"],
};
const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Guided project','/workspace','[]',${at},${at})`;
  const repo = yield* ProjectWorkRepository;
  yield* repo.execute({
    type: "project-work.task.create",
    commandId: CommandId.make("guided-create"),
    projectId,
    taskId,
    title: "Investigate this issue",
    createdAt: at,
  });
  return { sql, gateway: yield* ProjectWorkGateway };
});
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(gatewayRuntime)));

it.effect(
  "starts one bounded investigation through the authenticated gateway and replays one receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const { sql, gateway } = yield* setup;
        const first = yield* gateway.write(investigation, human, source, { actor: human });
        const duplicate = yield* gateway.write(investigation, human, source, { actor: human });
        expect(duplicate).toEqual(first);
        const state = yield* readCurrentState(sql, projectId);
        const parent = state.tasks.find((task) => task.taskId === taskId);
        expect(parent).toMatchObject({ state: "draft", specRevision: 0 });
        expect(parent?.activeAttemptId).toBeUndefined();
        const research = state.foundationRecords?.filter(
          (record) => record.kind === "task-membership" && record.parentTaskId === taskId,
        );
        expect(research).toHaveLength(1);
        expect(research?.[0]).toMatchObject({
          executionKind: "managed",
          deliverableKind: "research",
        });
        expect(state.attempts).toHaveLength(0);
        expect(
          state.foundationRecords?.filter(
            (record) => record.kind === "effect" && record.effectKind === "dispatch",
          ),
        ).toHaveLength(0);
        const receipts = yield* sql`SELECT command_id FROM project_work_command_receipts
        WHERE project_id=${projectId} AND command_id=${investigation.commandId}`;
        expect(receipts).toHaveLength(1);
      }),
    ),
);

it.effect(
  "denies forged human attribution, ordinary agents and raw runtime transitions before mutation",
  () =>
    scoped(
      Effect.gen(function* () {
        const { sql, gateway } = yield* setup;
        const agent = { kind: "agent", id: "ordinary-agent" } as const;
        expect(
          (yield* gateway.write(investigation, human, source, { actor: agent }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* gateway.write(investigation, agent, source, { actor: agent }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(
          (yield* gateway
            .write(
              {
                type: "project-work.foundation.commit",
                commandId: CommandId.make("raw-runtime"),
                projectId,
                expectedRevision: 1,
                records: [],
                transition: {
                  kind: "failure",
                  bindingId: "invented-run",
                  generation: 0,
                  expectedBindingRevision: 0,
                  failureFingerprint: "invented-failure",
                  relevantRevision: "invented-revision",
                  failureKind: "semantic",
                  summary: "Invented runtime authority",
                },
                attribution: { actor: human, source, recordedAt: at },
                committedAt: at,
              },
              human,
              source,
              { actor: human },
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const state = yield* readCurrentState(sql, projectId);
        expect(state.revision).toBe(1);
        expect(state.tasks).toHaveLength(1);
        expect(state.foundationRecords).toHaveLength(0);
        const receipts = yield* sql`SELECT command_id FROM project_work_command_receipts
        WHERE project_id=${projectId} AND command_id!=${"guided-create"}`;
        expect(receipts).toHaveLength(0);
      }),
    ),
);
