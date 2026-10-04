import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ProjectWorkTaskId,
  ProjectWorkWriteIntent,
  type ProjectTeamConfigurationIntent,
  PROJECT_TEAM_DEFAULT_LIMITS,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  gatewayRuntime,
  seed,
  projectId as activeProjectId,
  restoreHistoricalBinding,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { projectTeamConfigurationGeneration } from "./ProjectTeamConfiguration.ts";
import { ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";

const projectId = ProjectId.make("configured-project");
const at = "2026-01-01T00:00:00.000Z";
const human = { kind: "human", id: "authenticated-user" } as const;
const source = { kind: "web", id: "authenticated-browser" } as const;
const model = "inclusionai/ling-3.1-flash:free";
const decodeIntent = Schema.decodeUnknownEffect(ProjectWorkWriteIntent);
const roles = [
  "coordinator",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "integrator",
] as const;
const configuration: ProjectTeamConfigurationIntent = {
  type: "project-team.configure",
  commandId: CommandId.make("configure-project"),
  projectId,
  expectedRevision: 0,
  expectedConfigurationGeneration: 0,
  enabled: true,
  providerInstanceId: ProviderInstanceId.make("pi-instance"),
  projectPriority: 3,
  taskPriorities: [],
  profiles: roles.map((role) => ({
    role,
    instructions: "Follow the approved assignment",
    skills: [],
    tools: ["read", "search"],
    model,
    memoryAccess: "project",
    delegationDepth: 0,
  })),
  modelPolicies: [{ model, tokenLimit: 8192, durationLimitMs: 60000, modelCalls: 2 }],
};
const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Configured project','/workspace','[]',${at},${at})`;
  return { sql, gateway: yield* ProjectWorkGateway, repo: yield* ProjectWorkRepository };
});
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(gatewayRuntime)));

it.effect("installs human profiles and defaults once without starting any work", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, gateway } = yield* setup;
      const intent = yield* decodeIntent(configuration);
      const first = yield* gateway.write(intent, human, source, { actor: human });
      expect(yield* gateway.write(intent, human, source, { actor: human })).toEqual(first);
      const state = yield* readCurrentState(sql, projectId);
      expect(state.tasks).toEqual([]);
      expect(state.attempts).toEqual([]);
      expect(
        state.foundationRecords?.filter((record) => record.kind === "role-revision"),
      ).toHaveLength(6);
      expect(
        state.foundationRecords?.filter((record) => record.kind === "member" && record.coordinator),
      ).toHaveLength(1);
      expect(state.foundationRecords?.find((record) => record.kind === "limits")).toMatchObject({
        status: "configured",
        environmentModelCalls: 2,
        projectWritableWorkers: 1,
        delegationDepth: 2,
        repairAllowance: 2,
        providerInstanceId: "pi-instance",
        projectPriority: 3,
      });
      expect(projectTeamConfigurationGeneration(state)).toBe(1);
      for (const table of [
        "project_team_dispatch",
        "project_team_pi_process",
        "project_team_model_request",
        "project_team_setup_process",
      ])
        expect(yield* sql`SELECT * FROM ${sql(table)}`).toEqual([]);
    }),
  ),
);

it.effect(
  "preserves the coordinator identity, freezes old roles and refuses stale configuration replay",
  () =>
    scoped(
      Effect.gen(function* () {
        const { sql, gateway } = yield* setup;
        yield* gateway.write(configuration, human, source, { actor: human });
        const first = yield* readCurrentState(sql, projectId);
        const coordinator = first.foundationRecords?.find(
          (record) => record.kind === "member" && record.coordinator,
        );
        yield* gateway.write(
          {
            ...configuration,
            commandId: CommandId.make("reconfigure-project"),
            expectedRevision: first.revision,
            expectedConfigurationGeneration: 1,
            enabled: false,
            profiles: configuration.profiles.map((profile) => ({
              ...profile,
              instructions: "Updated profile",
            })),
          },
          human,
          source,
          { actor: human },
        );
        const second = yield* readCurrentState(sql, projectId);
        expect(projectTeamConfigurationGeneration(second)).toBe(2);
        expect(
          second.foundationRecords?.filter(
            (record) => record.kind === "member" && record.coordinator,
          ),
        ).toHaveLength(1);
        expect(
          second.foundationRecords?.find(
            (record) => record.kind === "member" && record.coordinator,
          ),
        ).toMatchObject({ recordId: coordinator?.recordId, status: "paused" });
        expect(
          second.foundationRecords?.filter(
            (record) => record.kind === "role-revision" && record.status === "retired",
          ),
        ).toHaveLength(6);
        expect(second.foundationRecords?.find((record) => record.kind === "limits")).toMatchObject({
          status: "disabled",
        });
        expect(
          (yield* gateway.write(configuration, human, source, { actor: human }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect((yield* readCurrentState(sql, projectId)).revision).toBe(second.revision);
      }),
    ),
);

it.effect(
  "refuses agent configuration, unavailable task priorities and policy mismatches without receipts",
  () =>
    scoped(
      Effect.gen(function* () {
        const { sql, gateway } = yield* setup;
        const agent = { kind: "agent", id: "ordinary-agent" } as const;
        expect(
          (yield* gateway.write(configuration, agent, source, { actor: agent }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        for (const input of [
          { ...configuration, expectedConfigurationGeneration: 1 },
          {
            ...configuration,
            taskPriorities: [{ taskId: ProjectWorkTaskId.make("foreign-task"), priority: 1 }],
          },
          {
            ...configuration,
            modelPolicies: [
              { model: "different-model", tokenLimit: 8192, durationLimitMs: 60000, modelCalls: 2 },
            ],
          },
          {
            ...configuration,
            profiles: configuration.profiles.map((profile) => ({
              ...profile,
              tools: ["read", "read"],
            })),
          },
        ])
          expect(
            (yield* gateway.write(input, human, source, { actor: human }).pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect((yield* readCurrentState(sql, projectId)).foundationRecords).toEqual([]);
        expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual([]);
      }),
    ),
);

for (const status of ["running", "stopping", "quarantined"] as const) {
  it.effect(`refuses configuration while a ${status} assignment still owns work`, () =>
    scoped(
      Effect.gen(function* () {
        const { sql } = yield* seed("implementer", status, { issueCredential: false });
        const gateway = yield* ProjectWorkGateway;
        const before = yield* readCurrentState(sql, activeProjectId);
        const receipts = yield* sql`SELECT * FROM project_work_command_receipts`;
        expect(
          (yield* gateway
            .write(
              { ...configuration, projectId: activeProjectId, expectedRevision: before.revision },
              human,
              source,
              { actor: human },
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readCurrentState(sql, activeProjectId)).toEqual(before);
        expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual(receipts);
      }),
    ),
  );
}

it.effect("refuses reconfiguration while a settled fixture still holds a durable reservation", () =>
  scoped(
    Effect.gen(function* () {
      const { sql, binding, repo } = yield* seed("implementer", "running", {
        issueCredential: false,
      });
      const current = yield* readCurrentState(sql, activeProjectId);
      const fields = { projectId: activeProjectId, revision: 0, generation: 0, updatedAt: at };
      yield* repo.execute({
        type: "project-work.foundation.commit",
        projectId: activeProjectId,
        commandId: CommandId.make("reserve-config-capacity"),
        expectedRevision: current.revision,
        attribution: { actor: human, source, recordedAt: at },
        committedAt: at,
        records: [
          {
            ...fields,
            ...PROJECT_TEAM_DEFAULT_LIMITS,
            kind: "limits",
            recordId: "limits",
            status: "configured",
            model: binding.model,
            tokenLimit: 1000,
            durationLimitMs: 1000,
            modelCalls: 2,
          },
          {
            ...fields,
            kind: "reservation",
            recordId: "reservation",
            status: "held",
            environmentId: binding.environmentId,
            scope: "project",
            resourceKey: activeProjectId,
            slot: 0,
            runId: binding.recordId,
            taskId: binding.taskId,
            attemptId: binding.attemptId,
            maximumTokens: 1000,
            consumedTokens: 0,
          },
        ],
      });
      yield* restoreHistoricalBinding({
        ...binding,
        status: "settled",
        revision: binding.revision + 1,
      }).pipe(Effect.provide(ProjectWorkProjectionLive));
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(sql, activeProjectId);
      expect(
        before.foundationRecords?.some((r) => r.kind === "reservation" && r.status === "held"),
      ).toBe(true);
      const receipts = yield* sql`SELECT * FROM project_work_command_receipts`;
      expect(
        (yield* gateway
          .write(
            { ...configuration, projectId: activeProjectId, expectedRevision: before.revision },
            human,
            source,
            { actor: human },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(sql, activeProjectId)).toEqual(before);
      expect(yield* sql`SELECT * FROM project_work_command_receipts`).toEqual(receipts);
    }),
  ),
);
