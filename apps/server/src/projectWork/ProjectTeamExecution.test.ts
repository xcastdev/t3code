import * as ExecutionHost from "./ProjectTeamExecutionHost.ts";
import { makeProjectTeamRecovery } from "./ProjectTeamRecovery.ts";
import type { ProjectTeamDispatchSnapshot } from "./ProjectTeamDispatch.ts";
import * as Queue from "effect/Queue";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ManagedSkillRepository } from "../skills/ManagedSkillRepository.ts";
import { PiModelCatalogue } from "../provider/pi/PiModelCatalogue.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProviderInstanceId,
  type ProjectTeamConfigurationIntent,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
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
import {
  ProjectTeamDispatchJournalError,
  makeProjectTeamDispatchJournal,
} from "./ProjectTeamDispatchJournal.ts";
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
const fixture = Effect.fn("executionTest.fixture")(function* (research = true) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* ProjectWorkGateway;
  const repository = yield* ProjectWorkRepository;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/workspace','[]',${at},${at})`;
  yield* gateway.write({ ...configuration, projectWritableWorkers: 2 }, human, source, {
    actor: human,
  });
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId: parentId,
    commandId: CommandId.make("create-parent"),
    title: "Investigate a bounded issue",
    createdAt: at,
  });
  let state = yield* readCurrentState(sql, projectId);
  if (research)
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
  const taskId = state.tasks.find((task) => task.taskId !== parentId)?.taskId ?? parentId;
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
  distinctWorkspaces = false,
  writable = false,
  readAnchor = () => facts.rootAnchor,
) {
  const settings = yield* ServerSettingsService;
  yield* settings.updateSettings({ projectTeamExecutionEnabled: true });
  const forTask = (taskId: ProjectWorkTaskId) =>
    distinctWorkspaces
      ? {
          ...facts,
          rootAnchor: readAnchor(),
          git: {
            ...facts.git,
            writable,
            worktreePath: `${facts.git.worktreePath}-${taskId}`,
            branchRef: `${facts.git.branchRef}-${taskId}`,
          },
        }
      : facts;
  const admission: ProjectTeamExecutionAdmission = {
    read: ({ taskId }) => Effect.succeed({ _tag: "Facts", facts: forTask(taskId) }),
    withCurrent: ({ taskId }, run) => run(forTask(taskId), Effect.void),
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
        yield* service.stop;
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

it.effect(
  "execution admits another configured sibling while a host continuation is held and concurrent stops join",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture(false);
        const entered = yield* Queue.unbounded<string>();
        const joining = yield* Deferred.make<void>();
        const joined = yield* Deferred.make<void>();
        type Claim = { snapshot: ProjectTeamDispatchSnapshot };
        const failure = () =>
          new ProjectTeamDispatchJournalError({ reason: "Controlled host SQL failed" });
        const recovery = makeProjectTeamRecovery<Claim, Claim, ProjectTeamDispatchJournalError>({
          readPage: (input) =>
            f.journal.readRecoveryCandidates(input).pipe(
              Effect.map((items) =>
                items.map((item) => ({ ...item, snapshot: Exit.mapError(item.snapshot, failure) })),
              ),
              Effect.mapError(failure),
            ),
          recordDiscoveryFailure: () => Effect.void,
          withClaim: (snapshot, run) => run({ snapshot }),
          assess: (claim) =>
            Effect.gen(function* () {
              claim.snapshot = yield* f.journal
                .claimEffect(claim.snapshot.fence)
                .pipe(Effect.mapError(failure));
              return { _tag: "Resume" as const, claim, snapshot: claim.snapshot };
            }),
          resume: (claim) =>
            Queue.offer(entered, claim.snapshot.fence.dispatchId).pipe(
              Effect.andThen(Effect.never),
            ),
          joinCleanup: (claim) =>
            Deferred.succeed(joining, undefined).pipe(
              Effect.andThen(Deferred.await(joined)),
              Effect.as({ _tag: "Joined" as const, receipt: claim }),
            ),
          // This test controls host joins only; actual SQL settlement is covered with the scheduler.
          settle: () => Effect.void,
          quarantine: () => Effect.die("Controlled host must join"),
        });
        const host = vi
          .spyOn(ExecutionHost, "makeProjectTeamExecutionHost")
          .mockImplementationOnce(() =>
            Effect.succeed({ recover: recovery.sweep, stop: Effect.void }),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => host.mockRestore()));
        let rootAnchor = facts.rootAnchor;
        const service = yield* makeService(Effect.void, true, true, () => rootAnchor);
        const envelope = Effect.gen(function* () {
          const state = yield* readCurrentState(f.sql, projectId);
          return {
            projectId,
            taskId: parentId,
            expectedRevision: state.revision,
            expectedTaskRevision: state.tasks.find((task) => task.taskId === parentId)!.revision,
          };
        });
        const criterionId = ProjectWorkCriterionId.make("sibling-requirement");
        yield* f.gateway.write(
          {
            ...(yield* envelope),
            type: "project-team.specification.propose",
            commandId: CommandId.make("sibling-spec"),
            expectedSpecRevision: 0,
            specification: {
              objective: "Two independent changes",
              scopeIn: "Approved files",
              scopeOut: "Other files",
              criterionIds: [criterionId],
              revision: 1,
              protected: false,
            },
            criterionSnapshots: [
              {
                criterionId,
                taskId: parentId,
                description: "Both changes pass",
                required: true,
                status: "unsatisfied",
                satisfiedByEvidenceIds: [],
                revision: 0,
                updatedAt: at,
              },
            ],
          },
          human,
          source,
          { actor: human },
        );
        const approve = Effect.fn("executionTest.approve")(function* (
          kind: "specification" | "plan",
        ) {
          const state = yield* readCurrentState(f.sql, projectId);
          const gate = state.foundationRecords!.find(
            (r) => r.kind === "gate" && r.gate === kind && r.status === "pending",
          );
          if (gate?.kind !== "gate") return yield* Effect.die("Missing approval");
          yield* f.gateway.write(
            {
              ...(yield* envelope),
              type: "project-team.gate.respond",
              commandId: CommandId.make(`sibling-approve-${kind}`),
              gateId: gate.recordId,
              expectedGateRevision: gate.revision,
              specRevision: gate.specRevision,
              planRevision: gate.planRevision,
              response: "approved",
            },
            human,
            source,
            { actor: human },
          );
        });
        yield* approve("specification");
        yield* f.gateway.write(
          {
            ...(yield* envelope),
            type: "project-team.plan.propose",
            commandId: CommandId.make("sibling-plan"),
            specRevision: 1,
            content: "Implement both independently",
            dependencyTaskIds: [],
          },
          human,
          source,
          { actor: human },
        );
        yield* approve("plan");
        const startChild = Effect.fn("executionTest.startChild")(function* (name: string) {
          const state = yield* readCurrentState(f.sql, projectId);
          const spec = state.foundationRecords!.find(
            (r) => r.kind === "gate" && r.gate === "specification",
          );
          const planGate = state.foundationRecords!.find(
            (r) => r.kind === "gate" && r.gate === "plan",
          );
          const plan = state.foundationRecords!.find((r) => r.kind === "plan-revision");
          if (spec?.kind !== "gate" || planGate?.kind !== "gate" || plan?.kind !== "plan-revision")
            return yield* Effect.die("Missing exact human approvals");
          yield* f.gateway.write(
            {
              ...(yield* envelope),
              type: "project-team.assignment.start",
              assignmentKind: "implementation",
              commandId: CommandId.make(name),
              objective: name,
              outputDescriptions: ["Tested implementation"],
              parentCriterionIds: [criterionId],
              specRevision: 1,
              specificationGateId: spec.recordId,
              expectedSpecificationGateRevision: spec.revision,
              parentPlan: {
                recordId: plan.recordId,
                expectedRecordRevision: plan.revision,
                planRevision: plan.planRevision,
                gateId: planGate.recordId,
                expectedGateRevision: planGate.revision,
              },
            },
            human,
            source,
            { actor: human },
          );
        });
        yield* startChild("first-implementation");
        yield* Effect.addFinalizer(() => Deferred.succeed(joined, undefined));
        yield* service.schedule();
        const initialSweep = yield* service.sweep().pipe(Effect.forkChild);
        const first = yield* Queue.take(entered);
        yield* Effect.yieldNow;
        const handedOff = initialSweep.pollUnsafe() !== undefined;
        if (!handedOff) {
          yield* Deferred.succeed(joined, undefined);
          yield* Fiber.interrupt(initialSweep);
        }
        expect(handedOff).toBe(true);
        const retained = yield* f.journal.readRetained(first);
        rootAnchor = {
          _tag: "RetainedRoot",
          budget: {
            rootTaskId: retained.intent.limits.rootTaskId,
            maximumTokens: retained.intent.limits.maximumTokens,
            deadlineAtMs: retained.intent.limits.rootDeadlineAtMs,
          },
          caps: retained.intent.rootCaps,
        };
        yield* startChild("second-implementation");
        const next = yield* service.sweep();
        expect(
          next.blocked.filter((item) => "phase" in item && item.phase !== "eligibility"),
        ).toEqual([]);
        expect(next.committed).toHaveLength(1);
        yield* service.sweep();
        expect(yield* Queue.take(entered)).not.toBe(first);
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(2);
        const bindings = (yield* readCurrentState(f.sql, projectId)).foundationRecords?.filter(
          (r) => r.kind === "run-binding",
        );
        expect(bindings).toHaveLength(2);
        expect(
          new Set(bindings?.map((r) => (r.kind === "run-binding" ? r.memberId : ""))).size,
        ).toBe(1);
        expect(
          yield* f.sql`SELECT * FROM project_team_reservation WHERE status='held'`,
        ).toHaveLength(2);
        const stops = yield* Effect.all([service.stop, service.stop], { concurrency: 2 }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(joining);
        expect(stops.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(joined, undefined);
        yield* Fiber.join(stops);
      }),
    ),
);
