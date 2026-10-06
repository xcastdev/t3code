import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ManagedSkillRepository } from "../skills/ManagedSkillRepository.ts";
import { PiModelCatalogue } from "../provider/pi/PiModelCatalogue.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  type ProjectTeamConfigurationIntent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { gatewayRuntime, projectId, at } from "./ProjectTeamAuthorization.testFixtures.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { type ProjectTeamConfiguredAdmissionFacts } from "./ProjectTeamConfiguredAdmission.ts";
import { waitForProjectTeamAssignmentChange } from "./ProjectTeamExecutionHost.ts";
import { PiManagedRuntimeError } from "../provider/pi/PiManagedRuntime.ts";

const human = { kind: "human", id: "human" } as const;
const source = { kind: "web", id: "web" } as const;
const model = "inclusionai/ling-3.1-flash:free";
const nowMs = Date.parse(at) + 1;
const parentId = ProjectWorkTaskId.make("parent");
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
  commandId: CommandId.make("configure"),
  projectId,
  expectedRevision: 0,
  expectedConfigurationGeneration: 0,
  enabled: true,
  providerInstanceId: ProviderInstanceId.make("pi-instance"),
  projectPriority: 1,
  taskPriorities: [],
  profiles: roles.map((role) => ({
    role,
    instructions: `Instructions for ${role}`,
    skills: [],
    tools:
      role === "implementer" || role === "integrator"
        ? ["pi.read", "pi.write", "project-work.report"]
        : ["pi.read", "project-work.report"],
    model,
    memoryAccess: "project",
    delegationDepth: 2,
  })),
  modelPolicies: [{ model, tokenLimit: 8192, durationLimitMs: 60000, modelCalls: 2 }],
};
const facts: ProjectTeamConfiguredAdmissionFacts = {
  environmentId: EnvironmentId.make("environment"),
  provider: {
    instanceId: ProviderInstanceId.make("pi-instance"),
    driverKind: "piAgent",
    enabled: true,
    runtimeVersion: "0.99.1",
    maxInputTokens: 1024,
    maxOutputTokens: 512,
    catalogue: {
      source: "https://api.commandcode.ai/provider/v1/models",
      fetchedAt: at,
      selectedEntry: {
        id: model,
        owned_by: "command-code",
        context_length: 262144,
        supported_endpoints: ["/chat/completions"],
      },
    },
  },
  supportedToolIds: ["pi.read", "pi.write", "project-work.report"],
  ownedSkillIds: [],
  git: {
    primaryRoot: "/workspace",
    commonGitDirectory: "/workspace/.git",
    worktreePath: "/assigned-worktree",
    branchRef: "refs/heads/assigned",
    baseRef: "refs/heads/main",
    baseOid: "a".repeat(40),
    policyHash: "b".repeat(64),
    writable: false,
  },
  rootAnchor: { _tag: "NewRoot" },
};
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitVcsDriver)({}),
        Layer.mock(GitWorkflowService)({}),
        Layer.mock(ManagedSkillRepository)({}),
        Layer.mock(PiModelCatalogue)({}),
        Layer.mock(ProviderInstanceRegistry)({}),
        Layer.mock(ProjectTeamPiRuntime)({}),
        Layer.mock(ProviderService)({}),
        Layer.mock(OrchestrationEngineService)({}),
        Layer.mock(ProjectionSnapshotQuery)({}),
      ).pipe(Layer.provideMerge(Layer.fresh(gatewayRuntime))),
    ),
  );

it.effect(
  "the retained assignment deadline interrupts and joins an event wait without provider events",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const joined = yield* Deferred.make<void>();
      const pending = Effect.acquireUseRelease(
        Deferred.succeed(entered, undefined),
        () => Effect.never,
        () => Deferred.succeed(joined, undefined),
      );
      yield* TestClock.setTime(1000);
      const fiber = yield* waitForProjectTeamAssignmentChange(pending, 2000).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(1000);
      expect(fiber.pollUnsafe()).toBeDefined();
      yield* Deferred.await(joined);
      expect(yield* Fiber.join(fiber).pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "Original assignment deadline elapsed" },
      });
    }).pipe(Effect.scoped),
);
const fixture = Effect.fn("executionTest.fixture")(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* ProjectWorkGateway;
  const repository = yield* ProjectWorkRepository;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/workspace','[]',${at},${at})`;
  yield* gateway.write(configuration, human, source, { actor: human });
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId: parentId,
    commandId: CommandId.make("create-parent"),
    title: "Investigate a bounded issue",
    createdAt: at,
  });
  let state = yield* readCurrentState(sql, projectId);
  yield* gateway.write(
    {
      type: "project-team.investigation.start",
      commandId: CommandId.make("investigate"),
      projectId,
      taskId: parentId,
      expectedRevision: state.revision,
      expectedTaskRevision: state.tasks[0]!.revision,
      objective: "Find the cause",
      outputDescriptions: ["Sourced findings"],
    },
    human,
    source,
    { actor: human },
  );
  state = yield* readCurrentState(sql, projectId);
  const taskId = state.tasks.find((task) => task.taskId !== parentId)!.taskId;
  yield* TestClock.setTime(nowMs);
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
  });
  return { sql, gateway, repository, state, taskId, journal };
});

import {
  makeProjectTeamExecution,
  ProjectTeamExecutionError,
  type ProjectTeamExecutionAdmission,
} from "./ProjectTeamExecution.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const makeService = Effect.fn("executionTest.makeService")(function* (
  gate: Effect.Effect<void, ProjectTeamExecutionError> = Effect.void,
) {
  const settings = yield* ServerSettingsService;
  yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
  const admission: ProjectTeamExecutionAdmission = {
    read: () => Effect.succeed({ _tag: "Facts", facts }),
    withCurrent: (_input, run) => run(facts, Effect.void),
  };
  return yield* makeProjectTeamExecution({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
    managedWorktreesRoot: "/managed",
    protectedRoots: ["/protected"],
    launchPolicy: { memoryBytes: 536870912, runtimeSeconds: 60 },
    nativeAdmission: gate,
    admissionFacts: admission,
  });
});

it.effect("schedules the approved configured assignment into the real durable journal once", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* makeService();
      const result = yield* service.schedule();
      expect(result.committed).toHaveLength(1);
      const retained = yield* f.journal.readRetained(result.committed[0]!.fence.dispatchId);
      expect(retained.intent.request.assignment).toContain("Find the cause");
      expect(retained.fence.stage).toBe("reserved");
      expect(retained.fence.claimGeneration).toBe(0);
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
      expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toHaveLength(0);
      expect((yield* service.schedule()).committed).toHaveLength(0);
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(1);
      yield* service.stop;
    }),
  ),
);

it.effect(
  "the pending human-verdict gate returns blocked without claims or runtime acquisition",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const service = yield* makeService(
          Effect.fail(new ProjectTeamExecutionError({ reason: "Human verdicts pending" })),
        );
        const result = yield* service.schedule();
        expect(result.committed).toHaveLength(0);
        expect(result.blocked).toContainEqual(
          expect.objectContaining({ reason: "Human verdicts pending" }),
        );
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(0);
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toHaveLength(0);
        expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toHaveLength(0);
        yield* service.stop;
      }),
    ),
);

it.effect("refuses an inherited SQL transaction before either scheduling or recovery", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const service = yield* makeService();
      const schedule = yield* f.sql.withTransaction(service.schedule()).pipe(Effect.result);
      const recover = yield* f.sql.withTransaction(service.sweep()).pipe(Effect.result);
      expect(schedule).toMatchObject({
        _tag: "Failure",
        failure: { reason: "Execution must own its SQL transactions" },
      });
      expect(recover._tag).toBe("Failure");
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(0);
      yield* service.stop;
    }),
  ),
);

it.effect(
  "disabled execution settles an unclaimed retained dispatch without inventing a writer drain",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const service = yield* makeService();
        const scheduled = yield* service.schedule();
        const settings = yield* ServerSettingsService;
        yield* settings.updateSettings({ projectTeamExecutionEnabled: false });
        const recovered = yield* service.sweep();
        expect(recovered.recovered).toHaveLength(1);
        const retained = yield* f.journal.readRetained(scheduled.committed[0]!.fence.dispatchId);
        expect(retained.fence.stage).toBe("settled");
        expect(
          (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
            (r) => r.kind === "run-binding",
          )?.status,
        ).toBe("settled");
        expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toHaveLength(0);
        yield* service.stop;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderService)({}),
            Layer.mock(OrchestrationEngineService)({}),
            Layer.mock(ProjectionSnapshotQuery)({}),
          ),
        ),
      ),
    ),
);

it.effect(
  "a claimed first-effect crash quarantines instead of releasing unproven writer ownership",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const service = yield* makeService();
        const scheduled = yield* service.schedule();
        yield* f.journal.claimEffect(scheduled.committed[0]!.fence);
        yield* (yield* ServerSettingsService).updateSettings({
          projectTeamExecutionEnabled: false,
        });
        yield* service.sweep();
        const retained = yield* f.journal.readRetained(scheduled.committed[0]!.fence.dispatchId);
        expect(retained.fence.stage).toBe("quarantine");
        const state = yield* readCurrentState(f.sql, projectId);
        expect(state.foundationRecords?.find((r) => r.kind === "run-binding")?.status).toBe(
          "quarantined",
        );
        expect(
          state.foundationRecords?.find((r) => r.kind === "effect" && r.effectKind === "dispatch")
            ?.status,
        ).toBe("uncertain");
        expect(state.attempts[0]?.state).toBe("leased");
        let hasMore = true;
        let sweeps = 0;
        while (hasMore && sweeps < 8) {
          hasMore = (yield* service.sweep()).hasMore;
          sweeps++;
        }
        expect(hasMore).toBe(false);
        expect((yield* f.journal.readRetained(retained.fence.dispatchId)).fence.stage).toBe(
          "quarantine",
        );
        yield* service.stop;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderService)({}),
            Layer.mock(OrchestrationEngineService)({}),
            Layer.mock(ProjectionSnapshotQuery)({}),
          ),
        ),
      ),
    ),
);

it.effect(
  "fresh recovery claims once before a changed gate refuses the first workspace effect",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const gate = Effect.gen(function* () {
          const rows = yield* f.sql<{
            claim_generation: number;
          }>`SELECT claim_generation FROM project_team_dispatch`.pipe(Effect.orDie);
          if (rows.some((row) => row.claim_generation > 0))
            return yield* new ProjectTeamExecutionError({
              reason: "Admission changed after claim",
            });
        });
        const service = yield* makeService(gate);
        const scheduled = yield* service.schedule();
        yield* service.sweep();
        const retained = yield* f.journal.readRetained(scheduled.committed[0]!.fence.dispatchId);
        expect(retained.fence.claimGeneration).toBe(1);
        expect(retained.fence.stage).toBe("quarantine");
        expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toHaveLength(0);
        expect(yield* f.sql`SELECT * FROM project_team_setup_process`).toHaveLength(0);
        yield* service.stop;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(ProviderService)({}),
            Layer.mock(OrchestrationEngineService)({}),
            Layer.mock(ProjectionSnapshotQuery)({}),
          ),
        ),
      ),
    ),
);

it.effect("cleanup cannot route an original missing Pi instance to a replacement provider", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const requested: ProviderInstanceId[] = [];
      let ordinaryStops = 0;
      const registry = yield* ProjectTeamPiRuntime;
      const provider = yield* ProviderService;
      const service = yield* makeService().pipe(
        Effect.provideService(ProjectTeamPiRuntime, {
          ...registry,
          withInstance: (id) =>
            Effect.gen(function* () {
              requested.push(id);
              return yield* new PiManagedRuntimeError({
                code: "unavailable",
                detail: "Original Pi runtime is absent; replacement is unrelated",
              });
            }),
        }),
        Effect.provideService(ProviderService, {
          ...provider,
          stopSession: () =>
            Effect.sync(() => {
              ordinaryStops++;
            }),
        }),
      );
      const scheduled = yield* service.schedule();
      const snapshot = yield* f.journal.claimEffect(scheduled.committed[0]!.fence);
      const transition = snapshot.intent.compiledClaim.transition;
      if (transition?.kind !== "claim")
        return yield* Effect.die("Missing original fixture binding");
      const binding = transition.binding;
      yield* f.sql`INSERT INTO project_team_pi_operation
      (operation_id,environment_id,project_id,binding_id,generation,provider_instance_id,thread_id,worker_id,
       operation_ordinal,operation_kind,request_hash,root_binding_id,root_task_id,maximum_tokens,deadline_at_ms,status,intent_json)
      VALUES (${snapshot.intent.request.initializeOperationId},'environment',${binding.projectId},${binding.recordId},${binding.generation},
        ${binding.providerInstanceId},${binding.threadId},'controlled-original-worker',0,'initialize','controlled',${binding.recordId},${binding.taskId},1,
        ${snapshot.intent.limits.deadlineAtMs},'running','{}')`;
      yield* (yield* ServerSettingsService).updateSettings({ projectTeamExecutionEnabled: false });
      yield* service.sweep();
      expect(requested).toEqual([binding.providerInstanceId]);
      expect(ordinaryStops).toBe(0);
      expect((yield* f.journal.readRetained(snapshot.fence.dispatchId)).fence.stage).toBe(
        "quarantine",
      );
      expect((yield* readCurrentState(f.sql, projectId)).attempts[0]?.state).toBe("leased");
      yield* service.stop;
    }),
  ),
);

it.effect(
  "enabled recovery quarantines a previously claimed first Git writer instead of repeating it",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        let workspaceCalls = 0;
        const workflow = yield* GitWorkflowService;
        const service = yield* makeService().pipe(
          Effect.provideService(GitWorkflowService, {
            ...workflow,
            createWorktree: () =>
              Effect.sync(() => {
                workspaceCalls++;
              }).pipe(
                Effect.andThen(Effect.die("Uncertain first Git writer must not be repeated")),
              ),
          }),
        );
        const scheduled = yield* service.schedule();
        const claimed = yield* f.journal.claimEffect(scheduled.committed[0]!.fence);
        yield* service.sweep();
        const retained = yield* f.journal.readRetained(claimed.fence.dispatchId);
        expect(retained.fence.stage).toBe("quarantine");
        expect(retained.fence.claimGeneration).toBe(claimed.fence.claimGeneration);
        expect(workspaceCalls).toBe(0);
        expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toHaveLength(0);
        expect(yield* f.sql`SELECT * FROM project_team_setup_process`).toHaveLength(0);
        expect((yield* readCurrentState(f.sql, projectId)).attempts[0]?.state).toBe("leased");
        let hasMore = true;
        let sweeps = 0;
        while (hasMore && sweeps < 8) {
          hasMore = (yield* service.sweep()).hasMore;
          sweeps++;
        }
        expect(hasMore).toBe(false);
        yield* service.stop;
      }),
    ),
);
