import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ManagedSkillKey,
  ProjectWorkTaskId,
  ProjectId,
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
import { makeProjectTeamAdmissionFacts } from "./ProjectTeamAdmissionFacts.ts";
import {
  at,
  createManagedAssignment,
  gatewayRuntime,
  projectId,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { prepareProjectTeamConfiguredAdmission } from "./ProjectTeamConfiguredAdmission.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import { makeProjectTeamPiRuntime, ProjectTeamPiRuntime } from "./ProjectTeamPiRuntime.ts";
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
  yield* settings.updateSettings({ providerInstances });
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
  const service = yield* makeProjectTeamAdmissionFacts({
    environmentId: "environment",
    managedWorktreesRoot,
    protectedRoots: [protectedRoot],
    maximumEnvironmentModelCalls: 2,
    journal,
  }).pipe(
    Effect.provideService(ProjectTeamPiRuntime, pi),
    Effect.provideService(PiModelCatalogue, modelCatalogue),
    Effect.provideService(ProviderInstanceRegistry, registered.registry),
  );
  return {
    service,
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

it.effect("measures actual SQL/Git facts and reserves the unchanged prepared request", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture({ ownedSkill: true });
      const read = yield* f.service.read({ state: f.state, taskId: f.taskId });
      expect(read._tag).toBe("Facts");
      if (read._tag !== "Facts") return;
      expect(read.facts.git.primaryRoot).toBe(f.primary);
      expect(read.facts.git.baseOid).toBe(f.baseOid);
      expect(read.facts.ownedSkillIds).toEqual([f.ownedSkill!.manifest.id]);
      expect(read.facts.rootAnchor).toEqual({ _tag: "NewRoot" });
      const prepared = prepareProjectTeamConfiguredAdmission({
        state: f.state,
        taskId: f.taskId,
        nowMs,
        facts: read.facts,
      });
      expect(prepared._tag).toBe("Prepared");
      if (prepared._tag !== "Prepared") return;
      const snapshot = yield* f.journal.reserve(prepared.request);
      expect(snapshot.intent.request).toEqual(prepared.request);
      expect(nativeFs.existsSync(f.managedWorktreesRoot + "/" + prepared.request.git.runId)).toBe(
        false,
      );
    }),
  ),
);

it.effect("refuses absent actual runtime metadata", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture({ missingRuntime: true });
      expect((yield* f.service.read({ state: f.state, taskId: f.taskId }))._tag).toBe("Blocked");
    }),
  ),
);

it.effect("refuses missing configured owned skill IDs", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture({ skills: ["missing-owned-skill"] });
      expect((yield* f.service.read({ state: f.state, taskId: f.taskId }))._tag).toBe("Blocked");
    }),
  ),
);

for (const change of [
  "path-alias",
  "path-symlink",
  "foreign-common",
  "disabled-provider",
  "stale-sdk",
  "token-limits",
  "expired-catalogue",
  "legacy-budget",
  "wrong-project",
  "too-many-skills",
  "instance-config-gap",
  "missing-instance-config",
] as const) {
  it.effect(`refuses actual ${change}`, () =>
    withServices(
      Effect.gen(function* () {
        const f = yield* fixture(
          change === "too-many-skills"
            ? { skills: Array.from({ length: 33 }, (_, index) => `skill-${index}`) }
            : undefined,
        );
        if (change === "path-alias")
          yield* f.sql`UPDATE projection_projects SET workspace_root=${f.primary + "/."} WHERE project_id=${projectId}`;
        if (change === "path-symlink") {
          nativeFs.symlinkSync(f.primary, f.root + "/alias");
          yield* f.sql`UPDATE projection_projects SET workspace_root=${f.root + "/alias"} WHERE project_id=${projectId}`;
        }
        if (change === "foreign-common") {
          nativeFs.renameSync(f.primary + "/.git", f.root + "/foreign-git");
          nativeFs.symlinkSync(f.root + "/foreign-git", f.primary + "/.git");
        }
        if (change === "disabled-provider")
          yield* f.settings.updateSettings({
            providerInstances: {
              [instanceId]: { ...f.providerInstances[instanceId]!, enabled: false },
            },
          });
        if (change === "instance-config-gap")
          yield* f.settings.updateSettings({
            providerInstances: {
              [instanceId]: {
                ...f.providerInstances[instanceId]!,
                config: { agentDirectory: f.root + "/new-config" },
              },
            },
          });
        if (change === "missing-instance-config")
          Object.defineProperty(f.assets, "instanceConfiguration", { value: undefined });
        if (change === "stale-sdk")
          Object.defineProperty(f.assets, "runtimeFacts", {
            value: { runtimeVersion: "0.98.1", maxInputTokens: 1024, maxOutputTokens: 512 },
          });
        if (change === "token-limits")
          Object.defineProperty(f.assets, "runtimeFacts", {
            value: { runtimeVersion: "0.99.1", maxInputTokens: 262144, maxOutputTokens: 512 },
          });
        if (change === "expired-catalogue") yield* TestClock.setTime(nowMs + 86_400_000);
        if (change === "legacy-budget")
          yield* f.sql`INSERT INTO project_team_model_budget VALUES ('environment',${projectId},'parent',8192,${nowMs + 60000})`;
        const state =
          change === "wrong-project"
            ? { ...f.state, projectId: ProjectId.make("foreign-project") }
            : f.state;
        const result = yield* f.service.read({ state, taskId: f.taskId });
        expect(result._tag).toBe("Blocked");
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
      }),
    ),
  );
}

it.effect(
  "revalidates actual resources inside the captured SQL transaction without refreshing",
  () =>
    withServices(
      Effect.gen(function* () {
        const f = yield* fixture({ ownedSkill: true });
        yield* f.service.withCurrent({ state: f.state, taskId: f.taskId }, (_, revalidate) =>
          f.sql.withTransaction(revalidate),
        );
      }),
    ),
);

it.effect("rejects a changed Git policy before admission writes", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.withCurrent({ state: f.state, taskId: f.taskId }, (_, revalidate) =>
        Effect.gen(function* () {
          yield* git(f.primary, ["config", "core.autocrlf", "true"]);
          expect((yield* f.sql.withTransaction(revalidate).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        }),
      );
    }),
  ),
);

it.effect("rejects changed owned skill content during the loan", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture({ ownedSkill: true });
      yield* f.service.withCurrent({ state: f.state, taskId: f.taskId }, (_, revalidate) =>
        Effect.gen(function* () {
          yield* f.skillRepository.updateGlobal({
            skillId: f.ownedSkill!.manifest.id,
            expectedHash: f.ownedSkill!.manifest.revision.hash,
            content: { name: "Inspect", body: "Changed content" },
          });
          expect((yield* f.sql.withTransaction(revalidate).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        }),
      );
    }),
  ),
);

it.effect("rejects another callback's current revalidation handle and an escaped handle", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = { state: f.state, taskId: f.taskId };
      const escaped = yield* f.service.withCurrent(input, (_, outer) =>
        Effect.gen(function* () {
          yield* f.service.withCurrent(input, () =>
            Effect.gen(function* () {
              expect((yield* outer.pipe(Effect.result))._tag).toBe("Failure");
            }),
          );
          yield* outer;
          return { handle: outer };
        }),
      );
      expect((yield* escaped.handle.pipe(Effect.result))._tag).toBe("Failure");
    }),
  ),
);

it.effect("preserves original root budget and caps and refuses a changed durable budget", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.service.read({ state: f.state, taskId: f.taskId });
      expect(first._tag).toBe("Facts");
      if (first._tag !== "Facts") return;
      const prepared = prepareProjectTeamConfiguredAdmission({
        state: f.state,
        taskId: f.taskId,
        nowMs,
        facts: first.facts,
      });
      expect(prepared._tag).toBe("Prepared");
      if (prepared._tag !== "Prepared") return;
      const original = yield* f.journal.reserve(prepared.request);
      const state = yield* readCurrentState(f.sql, projectId);
      const retained = yield* f.service.read({ state, taskId: f.taskId });
      expect(retained._tag).toBe("Facts");
      if (retained._tag !== "Facts") return;
      expect(retained.facts.rootAnchor).toEqual({
        _tag: "RetainedRoot",
        budget: {
          rootTaskId: original.intent.limits.rootTaskId,
          maximumTokens: original.intent.limits.maximumTokens,
          deadlineAtMs: original.intent.limits.rootDeadlineAtMs,
        },
        caps: original.intent.rootCaps,
      });
      yield* f.sql`UPDATE project_team_model_budget SET maximum_tokens=maximum_tokens+1`;
      expect((yield* f.service.read({ state, taskId: f.taskId }))._tag).toBe("Blocked");
    }),
  ),
);

it.effect("preserves the callback's original failure without granting authority", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      const failure = new Error("Root admission callback failure");
      const result = yield* f.service
        .withCurrent({ state: f.state, taskId: f.taskId }, () => Effect.fail(failure))
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure).toBe(failure);
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
    }),
  ),
);

for (const role of ["investigator", "planner", "reviewer", "implementer"] as const) {
  it.effect(`prepares an unallocated isolated ${role} candidate`, () =>
    withServices(
      Effect.gen(function* () {
        const f = yield* fixture({ role });
        const result = yield* f.service.read({ state: f.state, taskId: f.taskId });
        expect(result._tag).toBe("Facts");
        if (result._tag !== "Facts") return;
        expect(result.facts.git.worktreePath.startsWith(f.managedWorktreesRoot + "/")).toBe(true);
        expect(result.facts.git.worktreePath).not.toBe(f.primary);
        expect(result.facts.git.branchRef.startsWith("refs/heads/t3-managed/")).toBe(true);
        expect(result.facts.git.writable).toBe(role === "implementer");
        expect(nativeFs.existsSync(result.facts.git.worktreePath)).toBe(false);
        expect(
          prepareProjectTeamConfiguredAdmission({
            state: f.state,
            taskId: f.taskId,
            nowMs,
            facts: result.facts,
          })._tag,
        ).toBe("Prepared");
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
      }),
    ),
  );
}

for (const alias of [false, true]) {
  it.effect(`refuses an occupied candidate${alias ? " alias" : ""}`, () =>
    withServices(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.service.read({ state: f.state, taskId: f.taskId });
        if (result._tag !== "Facts") return yield* Effect.die("Healthy fixture blocked");
        nativeFs.mkdirSync(
          process.getBuiltinModule("path").dirname(result.facts.git.worktreePath),
          { recursive: true },
        );
        if (alias) nativeFs.symlinkSync(f.primary, result.facts.git.worktreePath);
        else nativeFs.mkdirSync(result.facts.git.worktreePath);
        expect((yield* f.service.read({ state: f.state, taskId: f.taskId }))._tag).toBe("Blocked");
      }),
    ),
  );
}

it.effect("rereads actual catalogue SQL in the transaction and rejects changed metadata", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.service.withCurrent({ state: f.state, taskId: f.taskId }, (_, revalidate) =>
        f.sql.withTransaction(
          Effect.gen(function* () {
            yield* f.sql`UPDATE project_team_pi_catalogue SET payload_json=json_set(payload_json,'$.selectedEntry.context_length',262143)`;
            expect((yield* revalidate.pipe(Effect.result))._tag).toBe("Failure");
            expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
          }),
        ),
      );
    }),
  ),
);

it.effect("refuses a retained root cap tuple that disagrees with its verified original proof", () =>
  withServices(
    Effect.gen(function* () {
      const f = yield* fixture();
      const read = yield* f.service.read({ state: f.state, taskId: f.taskId });
      if (read._tag !== "Facts") return yield* Effect.die("Healthy fixture blocked");
      const prepared = prepareProjectTeamConfiguredAdmission({
        state: f.state,
        taskId: f.taskId,
        nowMs,
        facts: read.facts,
      });
      if (prepared._tag !== "Prepared") return yield* Effect.die("Healthy request blocked");
      const original = yield* f.journal.reserve(prepared.request);
      expect(original.intent.limits.maximumDelegationDepth).toBeGreaterThan(0);
      expect(
        (yield* f.sql`UPDATE project_team_dispatch SET intent_json=json_set(intent_json,'$.rootCaps.maximumDelegationDepth',0)`.pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      // Simulate damaged legacy storage only in this disposable migrated fixture.
      yield* f.sql`DROP TRIGGER project_team_dispatch_immutable`;
      yield* f.sql`UPDATE project_team_dispatch SET intent_json=json_set(intent_json,'$.rootCaps.maximumDelegationDepth',0)`;
      const state = yield* readCurrentState(f.sql, projectId);
      expect((yield* f.service.read({ state, taskId: f.taskId }))._tag).toBe("Blocked");
    }),
  ),
);
