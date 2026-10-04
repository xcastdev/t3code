import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ManagedSkillKey,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type ProjectTeamConfigurationIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as Workflow from "../git/GitWorkflowService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  PiManagedRuntime,
  PiManagedRuntimeError,
  type PiManagedRuntimeInstance,
} from "../provider/pi/PiManagedRuntime.ts";
import { makePiModelCatalogue, PiModelCatalogue } from "../provider/pi/PiModelCatalogue.ts";
import type { PiProductionRuntimeAssets } from "../provider/pi/PiProductionRuntime.ts";
import { makePiDriver } from "../provider/Drivers/PiDriver.ts";
import { ProviderAdapterValidationError } from "../provider/Errors.ts";
import { makeProviderInstanceRegistry } from "../provider/Layers/ProviderInstanceRegistryLive.ts";
import { buildServerProvider } from "../provider/providerSnapshot.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SkillMaterializationService } from "../skills/SkillMaterializationService.ts";
import * as Skills from "../skills/ManagedSkillRepository.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Registry from "../vcs/VcsDriverRegistry.ts";
import { makeProjectTeamAdmissionRuntime } from "./ProjectTeamAdmissionRuntime.ts";
import {
  at,
  createManagedAssignment,
  gatewayRuntime,
  projectId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";

const nativeFs = process.getBuiltinModule("fs");
const instanceId = ProviderInstanceId.make("pi-instance");
const model = "inclusionai/ling-3.1-flash:free";
const nowMs = Date.parse(at) + 1;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const unused = Effect.fail(
  new PiManagedRuntimeError({ code: "denied", detail: "No native Pi operations in facts tests" }),
);
// Published metadata is a controlled seam, never proof of the actual Pi factory/SDK.
const runtime: PiManagedRuntimeInstance = {
  inspect: Effect.succeed(
    buildServerProvider({
      presentation: { displayName: "Fixture Pi" },
      models: [],
      enabled: true,
      checkedAt: at,
      probe: {
        installed: true,
        version: "0.99.1",
        status: "ready",
        auth: { status: "authenticated" },
      },
    }),
  ),
  prepareOperation: () => unused,
  readSession: () => unused,
  readThread: () => unused,
  requestStop: () => unused,
  stopAll: unused,
  authorizeSkills: () => unused,
  discoverNativeSkills: () => unused,
};
const workflowLayer = Workflow.layer.pipe(
  Layer.provide(Layer.mock(Registry.VcsDriverRegistry)({})),
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
  Layer.provideMerge(Git.layer.pipe(Layer.provideMerge(VcsProcess.layer))),
);
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "admission-facts-" });
const withServices = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  body.pipe(
    Effect.provide(
      Layer.mergeAll(workflowLayer, Skills.layer).pipe(
        Layer.provideMerge(configLayer),
        Layer.provideMerge(Layer.fresh(gatewayRuntime)),
      ),
    ),
    Effect.scoped,
  );
const git = Effect.fn("admissionFactsTest.git")(function* (cwd: string, args: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/usr/bin/git", ["-C", cwd, ...args], {
          env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
          extendEnv: false,
          stdin: "ignore",
          shell: false,
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectUint8StreamText({ stream: child.stdout, maxBytes: 262144 }),
          collectUint8StreamText({ stream: child.stderr, maxBytes: 8192 }),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      expect(Number(code), stderr.text).toBe(0);
      return stdout.text.trim();
    }),
  );
});
const fixture = Effect.fn("admissionFactsTest.fixture")(function* (options?: {
  readonly missingRuntime?: boolean;
  readonly runtimeFacts?: PiProductionRuntimeAssets["runtimeFacts"];
  readonly skills?: readonly string[];
  readonly ownedSkill?: boolean;
  readonly role?: "investigator" | "planner" | "reviewer" | "implementer";
}) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "admission-facts-" });
  const primary = path.join(root, "primary");
  const managedWorktreesRoot = path.join(root, "managed");
  const protectedRoot = path.join(root, "protected");
  for (const dir of [primary, managedWorktreesRoot, protectedRoot]) yield* fs.makeDirectory(dir);
  yield* fs.chmod(managedWorktreesRoot, 0o700);
  yield* git(primary, ["init", "--initial-branch=main"]);
  yield* fs.writeFileString(path.join(primary, "file.txt"), "base\n");
  yield* git(primary, ["add", "file.txt"]);
  yield* git(primary, [
    "-c",
    "user.name=Facts fixture",
    "-c",
    "user.email=facts@test.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const baseOid = yield* git(primary, ["rev-parse", "HEAD"]);
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project',${primary},'[]',${at},${at})`;
  const settings = yield* ServerSettingsService;
  const driverKind = ProviderDriverKind.make("piAgent");
  const providerInstances = { [instanceId]: { driver: driverKind, enabled: true, config: {} } };
  yield* settings.updateSettings({
    providerInstances,
    projectWorkEnabled: true,
    projectTeamExecutionEnabled: true,
  });
  const adapterDenied = Effect.fail(
    new ProviderAdapterValidationError({
      provider: driverKind,
      operation: "fixture",
      issue: "No adapter operations in facts tests",
    }),
  );
  const driver = makePiDriver({
    makeAdapter: () =>
      Effect.succeed({
        provider: driverKind,
        capabilities: {
          sessionModelSwitch: "unsupported",
          supportsConversationRollback: false,
          remoteHttpMcp: "unsupported",
          projectMcpProxy: "unsupported",
          sessionMcpCatalog: "unsupported",
          promptlessTurnContinuation: false,
          activeTurnSteer: false,
        },
        startSession: () => adapterDenied,
        sendTurn: () => adapterDenied,
        interruptTurn: () => adapterDenied,
        respondToRequest: () => adapterDenied,
        respondToUserInput: () => adapterDenied,
        stopSession: () => Effect.void,
        listSessions: () => Effect.succeed([]),
        hasSession: () => Effect.succeed(false),
        readThread: () => adapterDenied,
        rollbackThread: () => adapterDenied,
        stopAll: () => Effect.void,
        streamEvents: Stream.empty,
      }),
  });
  const registered = yield* makeProviderInstanceRegistry({
    drivers: [driver],
    configMap: providerInstances,
  }).pipe(
    Effect.provideService(PiManagedRuntime, { forInstance: () => Effect.succeed(runtime) }),
    Effect.provideService(SkillMaterializationService, {
      materialize: () => Effect.die("No skill staging"),
      dispose: () => Effect.void,
      disposeSession: () => Effect.void,
    }),
  );
  const gateway = yield* ProjectWorkGateway;
  const repository = yield* ProjectWorkRepository;
  const roles = [
    "coordinator",
    "investigator",
    "planner",
    "implementer",
    "reviewer",
    "integrator",
  ] as const;
  const skillRepository = yield* Skills.ManagedSkillRepository;
  const ownedSkill = options?.ownedSkill
    ? yield* skillRepository.createGlobal({
        expectedRevision: 0,
        content: {
          key: ManagedSkillKey.make("inspect"),
          name: "Inspect",
          body: "Read the approved source.",
        },
      })
    : undefined;
  const selectedSkills = ownedSkill ? [ownedSkill.manifest.id] : (options?.skills ?? []);
  const configuration: ProjectTeamConfigurationIntent = {
    type: "project-team.configure",
    commandId: CommandId.make("configure"),
    projectId,
    expectedRevision: 0,
    expectedConfigurationGeneration: 0,
    enabled: true,
    providerInstanceId: instanceId,
    projectPriority: 0,
    taskPriorities: [],
    profiles: roles.map((role) => ({
      role,
      model,
      instructions: `Instructions for ${role}`,
      tools: ["pi.read", "project-work.report"],
      skills: selectedSkills,
      memoryAccess: "project",
      delegationDepth: 2,
    })),
    modelPolicies: [{ model, tokenLimit: 8192, durationLimitMs: 60000, modelCalls: 2 }],
  };
  const human = { kind: "human", id: "human" } as const;
  const source = { kind: "web", id: "web" } as const;
  yield* gateway.write(configuration, human, source, { actor: human });
  const parentId = ProjectWorkTaskId.make("parent");
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId: parentId,
    commandId: CommandId.make("create-parent"),
    title: "Investigate",
    createdAt: at,
  });
  let state = yield* readCurrentState(sql, projectId);
  const assignedRole = options?.role ?? "investigator";
  if (assignedRole === "investigator") {
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
  } else {
    const role = state.foundationRecords?.find(
      (record) => record.kind === "role-revision" && record.role === "implementer",
    );
    const member = state.foundationRecords?.find(
      (record) => record.kind === "member" && record.roleRevisionId === role?.recordId,
    );
    if (role?.kind !== "role-revision" || member?.kind !== "member")
      return yield* Effect.die("Configured implementation member missing");
    const result = yield* createManagedAssignment({
      taskId: parentId,
      recordId: "fixture-uncommitted",
      attemptId: "fixture-uncommitted-attempt",
      commandId: "fixture-uncommitted-claim",
      providerInstanceId: instanceId,
      threadId: ThreadId.make("fixture-thread"),
      role,
      memberId: member.recordId,
      status: "reserved",
      configuration: {
        instructionsHash: "fixture",
        toolIds: role.tools,
        skillIds: selectedSkills,
        runtimeVersion: "0.99.1",
        maxTokens: 8192,
        maxDurationMs: 60000,
        paidFallback: false,
      },
    }).pipe(
      Effect.provideService(ProjectWorkRepository, {
        ...repository,
        execute: (command) =>
          command.type === "project-work.foundation.commit" && command.transition?.kind === "claim"
            ? Effect.fail(
                new ProjectWorkPolicyError(
                  "invalid-state",
                  "Retain only the approved fixture assignment",
                ),
              )
            : repository.execute(command),
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    state = yield* readCurrentState(sql, projectId);
    if (assignedRole === "planner" || assignedRole === "reviewer") {
      const spec = state.foundationRecords?.find(
        (record) =>
          record.kind === "gate" && record.gate === "specification" && record.status === "approved",
      );
      const plan = state.foundationRecords?.find(
        (record) => record.kind === "plan-revision" && record.status === "proposed",
      );
      const gate = state.foundationRecords?.find(
        (record) =>
          record.kind === "gate" && record.gate === "plan" && record.status === "approved",
      );
      if (spec?.kind !== "gate" || plan?.kind !== "plan-revision" || gate?.kind !== "gate")
        return yield* Effect.die("Approved fixture plan missing");
      yield* gateway.write(
        {
          type: "project-team.assignment.start",
          commandId: CommandId.make("assign-readonly"),
          projectId,
          taskId: parentId,
          expectedRevision: state.revision,
          expectedTaskRevision: state.tasks.find((task) => task.taskId === parentId)!.revision,
          assignmentKind: assignedRole === "planner" ? "planning" : "review",
          objective: "Inspect approved scope",
          outputDescriptions: ["Sourced proposal"],
          specRevision: 1,
          specificationGateId: spec.recordId,
          expectedSpecificationGateRevision: spec.revision,
          parentPlan: {
            recordId: plan.recordId,
            expectedRecordRevision: plan.revision,
            planRevision: plan.planRevision,
            gateId: gate.recordId,
            expectedGateRevision: gate.revision,
          },
        },
        human,
        source,
        { actor: human },
      );
    }
  }
  state = yield* readCurrentState(sql, projectId);
  const taskId =
    assignedRole === "implementer"
      ? parentId
      : state.tasks.find((task) => task.taskId !== parentId)!.taskId;
  yield* TestClock.setTime(nowMs);
  const catalogue = {
    source: "https://api.commandcode.ai/provider/v1/models",
    fetchedAt: at,
    selectedEntry: {
      id: model,
      owned_by: "command-code",
      context_length: 262144,
      supported_endpoints: ["/chat/completions"],
    },
  };
  yield* sql`INSERT INTO project_team_pi_catalogue VALUES (${catalogue.source},${at},${encodeJson(catalogue)})`;
  const modelCatalogue = yield* makePiModelCatalogue.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Facts must never refresh/fetch")),
    ),
  );
  const pi = yield* makeProjectTeamPiRuntime();
  const assets: PiProductionRuntimeAssets = {
    ...(options?.missingRuntime
      ? {}
      : {
          runtimeFacts: options?.runtimeFacts ?? {
            runtimeVersion: "0.99.1",
            maxInputTokens: 1024,
            maxOutputTokens: 512,
          },
        }),
    instanceConfiguration: { enabled: true, configuration: {} },
    runtimeFiles: [],
    revalidate: Effect.void,
    borrow: (body) => body,
  };
  yield* pi.publishAssets(instanceId, assets, runtime);
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
  });
  const service = yield* makeProjectTeamAdmissionRuntime({
    environmentId: "environment",
    managedWorktreesRoot,
    protectedRoots: [protectedRoot],
    maximumEnvironmentModelCalls: 2,
  }).pipe(
    Effect.provideService(ProjectTeamPiRuntime, pi),
    Effect.provideService(PiModelCatalogue, modelCatalogue),
    Effect.provideService(ProviderInstanceRegistry, registered.registry),
  );
  return {
    service,
    newService: makeProjectTeamAdmissionRuntime({
      environmentId: "environment",
      maximumEnvironmentModelCalls: 2,
      managedWorktreesRoot,
      protectedRoots: [protectedRoot],
    }).pipe(
      Effect.provideService(ProjectTeamPiRuntime, pi),
      Effect.provideService(PiModelCatalogue, modelCatalogue),
      Effect.provideService(ProviderInstanceRegistry, registered.registry),
    ),
    state,
    taskId,
    sql,
    journal,
    primary,
    root,
    baseOid,
    assets,
    managedWorktreesRoot,
    settings,
    registered,
    providerInstances,
    skillRepository,
    ownedSkill,
    pi,
  };
});

it.effect("atomically admits configured investigation without allocating a worker", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture({ ownedSkill: true });
      const result = yield* f.service.sweep();
      expect(result.committed, encodeJson(result.blocked)).toHaveLength(1);
      const original = result.committed[0]!;
      expect(original.fence.stage).toBe("reserved");
      expect(original.fence.claimGeneration).toBe(0);
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(1);
      expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toEqual([]);
      expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      const again = yield* f.service.sweep();
      expect(again.committed).toHaveLength(0);
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(1);
    }),
  ),
);

for (const flag of ["projectWorkEnabled", "projectTeamExecutionEnabled"] as const) {
  it.effect(`disabled ${flag} reserves no assignment`, () =>
    withServices(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.settings.updateSettings({ [flag]: false });
        const result = yield* f.service.sweep();
        expect(result.committed).toHaveLength(0);
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual([]);
      }),
    ),
  );
}

it.effect("concurrent actual schedulers retain one original assignment", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      const other = yield* f.newService;
      const [left, right] = yield* Effect.all([f.service.sweep(), other.sweep()], {
        concurrency: 2,
      });
      const returned = [...left.committed, ...right.committed];
      expect(returned.length, encodeJson([left.blocked, right.blocked])).toBeGreaterThan(0);
      expect(new Set(returned.map((r) => r.fence.dispatchId)).size).toBe(1);
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toHaveLength(1);
      expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toHaveLength(1);
    }),
  ),
);

for (const change of ["physical-root", "disabled", "expired"] as const) {
  it.effect(`rolls back all admission writes after final ${change} change`, () =>
    withServices(
      Effect.gen(function* () {
        const f = yield* fixture();
        let changed = false;
        Object.defineProperty(f.assets, "revalidate", {
          value: Effect.gen(function* () {
            const rows = yield* f.sql`SELECT dispatch_id FROM project_team_dispatch`;
            if (rows.length !== 0 && !changed) {
              changed = true;
              if (change === "physical-root") nativeFs.chmodSync(f.managedWorktreesRoot, 0o755);
              else if (change === "disabled")
                yield* f.settings.updateSettings({ projectTeamExecutionEnabled: false });
              else yield* TestClock.setTime(nowMs + 60001);
            }
          }),
        });
        const result = yield* f.service.sweep().pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (change === "physical-root") nativeFs.chmodSync(f.managedWorktreesRoot, 0o700);
            }),
          ),
        );
        expect(changed).toBe(true);
        expect(result.committed).toHaveLength(0);
        expect(result.blocked.some((b) => b.phase === "reserve")).toBe(true);
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_pi_operation`).toEqual([]);
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.state);
      }),
    ),
  );
}

it.effect("foreign SQL cannot admit work through the captured scheduler", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      const foreign = yield* SqlClient.SqlClient.pipe(Effect.provide(SqlitePersistenceMemory));
      const result = yield* f.service
        .sweep()
        .pipe(Effect.provideService(SqlClient.SqlClient, foreign));
      expect(result.committed).toHaveLength(0);
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
      expect(yield* f.sql`SELECT * FROM project_team_model_budget`).toEqual([]);
    }),
  ),
);
