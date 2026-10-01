import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  WsRpcGroup,
  ProjectWorkWriteIntent,
  type ProjectTeamRecord,
  type ProjectTeamWriteIntent,
  type ProjectTeamGuidedIntent,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { gatewayRuntime } from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkToolkit } from "../mcp/toolkits/projectWork/tools.ts";

const projectId = ProjectId.make("guided-gateway-project");
const taskId = ProjectWorkTaskId.make("guided-gateway-task");
const human = { kind: "human", id: "authenticated-user" } as const;
const source = { kind: "web", id: "authenticated-browser" } as const;
const at = "2026-01-01T00:00:00.000Z";
const decodePublicWrite = Schema.decodeUnknownEffect(ProjectWorkWriteIntent);
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

for (const boundary of ["rpc", "mcp"] as const) {
  const decodeBoundary = Schema.decodeUnknownEffect(
    boundary === "rpc"
      ? WsRpcGroup.requests.get("projectWork.write")!.payloadSchema
      : ProjectWorkToolkit.tools.project_work_write.parametersSchema,
  );
  it.effect(`${boundary} decoder rejects caller authority without receipts or SQL mutation`, () =>
    scoped(
      Effect.gen(function* () {
        const { sql, gateway } = yield* setup;
        for (const injected of [
          { actor: { kind: "human", id: "invented" } },
          { bindingId: "invented" },
          { generation: 99 },
          { authorizationGateId: "invented" },
        ]) {
          const decoded = yield* decodeBoundary({
            ...investigation,
            ...injected,
          }).pipe(Effect.result);
          if (decoded._tag === "Success") {
            const intent = yield* decodePublicWrite(decoded.success);
            yield* gateway.write(intent, human, source, { actor: human });
          }
          expect(decoded._tag).toBe("Failure");
        }
        const state = yield* readCurrentState(sql, projectId);
        expect(state.revision).toBe(1);
        expect(state.tasks).toHaveLength(1);
        expect(state.foundationRecords).toHaveLength(0);
        expect(
          yield* sql`SELECT command_id FROM project_work_command_receipts
            WHERE project_id=${projectId} AND command_id=${investigation.commandId}`,
        ).toHaveLength(0);

        const decoded = yield* decodeBoundary(investigation);
        const clean = yield* decodePublicWrite(decoded);
        yield* gateway.write(clean, human, source, { actor: human });
        expect((yield* readCurrentState(sql, projectId)).tasks).toHaveLength(2);
        expect(
          yield* sql`SELECT command_id FROM project_work_command_receipts
            WHERE project_id=${projectId} AND command_id=${investigation.commandId}`,
        ).toHaveLength(1);
      }),
    ),
  );
}

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

it.effect(
  "approves a revised specification despite historical plans and rejects stale approval receipts",
  () =>
    scoped(
      Effect.gen(function* () {
        const { sql, gateway } = yield* setup;
        const envelope = Effect.gen(function* () {
          const state = yield* readCurrentState(sql, projectId);
          return {
            projectId,
            taskId,
            expectedRevision: state.revision,
            expectedTaskRevision: state.tasks.find((task) => task.taskId === taskId)!.revision,
          };
        });
        const propose = Effect.fn("guidedGatewayTest.propose")(function* (revision: number) {
          const criterionId = ProjectWorkCriterionId.make("guided-requirement");
          const intent: ProjectTeamGuidedIntent = {
            ...(yield* envelope),
            type: "project-team.specification.propose",
            commandId: CommandId.make(`guided-spec-${revision}`),
            expectedSpecRevision: revision - 1,
            specification: {
              objective: `Bounded objective ${revision}`,
              scopeIn: "Approved task",
              scopeOut: "Other work",
              criterionIds: [criterionId],
              revision,
              protected: false,
            },
            criterionSnapshots: [
              {
                criterionId,
                taskId,
                description: `Verify requirement ${revision}`,
                required: true,
                status: "unsatisfied",
                satisfiedByEvidenceIds: [],
                revision: revision - 1,
                updatedAt: at,
              },
            ],
          };
          yield* gateway.write(intent, human, source, { actor: human });
        });
        const approve = Effect.fn("guidedGatewayTest.approve")(function* (
          gateKind: "specification" | "plan",
          commandId: CommandId,
        ) {
          const state = yield* readCurrentState(sql, projectId);
          const gate = state.foundationRecords!.find(
            (record): record is Extract<ProjectTeamRecord, { kind: "gate" }> =>
              record.kind === "gate" &&
              record.taskId === taskId &&
              record.gate === gateKind &&
              record.status === "pending",
          )!;
          const intent: ProjectTeamWriteIntent = {
            ...(yield* envelope),
            type: "project-team.gate.respond",
            commandId,
            specRevision: gate.specRevision,
            planRevision: gate.planRevision,
            gateId: gate.recordId,
            expectedGateRevision: gate.revision,
            response: "approved",
          };
          const receipt = yield* gateway.write(intent, human, source, { actor: human });
          expect(yield* gateway.write(intent, human, source, { actor: human })).toEqual(receipt);
          return { intent, receipt };
        });
        yield* propose(1);
        const original = yield* approve("specification", CommandId.make("approve-guided-spec-1"));
        yield* gateway.write(
          {
            ...(yield* envelope),
            type: "project-team.plan.propose",
            commandId: CommandId.make("guided-plan-1"),
            specRevision: 1,
            content: "Implement and verify the bounded task",
            dependencyTaskIds: [],
          },
          human,
          source,
          { actor: human },
        );
        const oldPlan = yield* approve("plan", CommandId.make("approve-guided-plan-1"));
        yield* propose(2);
        const beforeDenial = yield* readCurrentState(sql, projectId);
        for (const stale of [original, oldPlan])
          expect(
            (yield* gateway
              .write(stale.intent, human, source, { actor: human })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect((yield* readCurrentState(sql, projectId)).revision).toBe(beforeDenial.revision);
        const revised = yield* approve("specification", CommandId.make("approve-guided-spec-2"));
        expect(revised.intent).toMatchObject({ specRevision: 2, planRevision: 0 });
        const after = yield* readCurrentState(sql, projectId);
        expect(after.tasks.find((task) => task.taskId === taskId)?.specRevision).toBe(2);
        expect(after.attempts).toHaveLength(0);
        expect(
          after.foundationRecords!.some(
            (record) =>
              record.kind === "gate" &&
              record.recordId === revised.intent.gateId &&
              record.status === "approved",
          ),
        ).toBe(true);
        const receipts = yield* sql`SELECT command_id FROM project_work_command_receipts
          WHERE project_id=${projectId} AND command_id=${revised.intent.commandId}`;
        expect(receipts).toHaveLength(1);
      }),
    ),
);
