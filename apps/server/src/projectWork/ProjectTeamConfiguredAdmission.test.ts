import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectWorkFoundationCommitCommand,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  type ProjectTeamConfigurationIntent,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  gatewayRuntime,
  projectId,
  at,
  createManagedAssignment,
} from "./ProjectTeamAuthorization.testFixtures.ts";
import { ProjectWorkPolicyError } from "./ProjectWorkPolicy.ts";
import { makeProjectTeamDispatchJournal } from "./ProjectTeamDispatchJournal.ts";
import {
  prepareProjectTeamConfiguredAdmission,
  type ProjectTeamConfiguredAdmissionFacts,
} from "./ProjectTeamConfiguredAdmission.ts";

const decodeFoundationCommand = Schema.decodeEffect(ProjectWorkFoundationCommitCommand);
const human = { kind: "human", id: "human" } as const;
const source = { kind: "web", id: "web" } as const;
const model = "inclusionai/ling-3.1-flash:free";
const subscriptionModel = "gpt-6-luna";
const nowMs = Date.parse(at) + 1;
const parentId = ProjectWorkTaskId.make("parent");
type CommandCatalogue = Extract<
  ProjectTeamConfiguredAdmissionFacts["provider"]["catalogue"],
  { readonly source: "https://api.commandcode.ai/provider/v1/models" }
>;
type CommandConfiguredAdmissionFacts = Omit<ProjectTeamConfiguredAdmissionFacts, "provider"> & {
  readonly provider: Omit<ProjectTeamConfiguredAdmissionFacts["provider"], "catalogue"> & {
    readonly catalogue: CommandCatalogue;
  };
};
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
const facts: CommandConfiguredAdmissionFacts = {
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
const subscriptionFacts = (
  selection: NonNullable<
    ProjectTeamConfiguredAdmissionFacts["provider"]["subscription"]
  >["selection"],
): ProjectTeamConfiguredAdmissionFacts => ({
  environmentId: facts.environmentId,
  provider: {
    instanceId: facts.provider.instanceId,
    driverKind: facts.provider.driverKind,
    enabled: facts.provider.enabled,
    runtimeVersion: facts.provider.runtimeVersion,
    maxInputTokens: 16_384,
    maxOutputTokens: 2_048,
    catalogue: {
      source: "pi-sdk:0.99.1/openai-codex",
      fetchedAt: at,
      selectedEntry: {
        id: subscriptionModel,
        owned_by: "openai-codex",
        context_length: 272_000,
        supported_endpoints: ["/codex/responses"],
      },
    },
    subscription: {
      selection,
      configuration: {
        provider: "openai-codex",
        model: subscriptionModel,
        api: "openai-codex-responses",
        endpoint: "https://chatgpt.com/backend-api/codex/responses",
        contextWindow: 272_000,
        maxInputTokens: 16_384,
        maxOutputTokens: 2_048,
        advertisedMaxOutputTokens: 16_384,
        deadlineMs: 300_000,
        reasoning: true,
        reasoningEffort: "high",
        serviceTier: "default",
        input: ["text"],
        cost: "unknown",
        catalogue: {
          source: "pi-sdk:0.99.1/openai-codex",
          fetchedAt: at,
        },
      },
    },
  },
  supportedToolIds: facts.supportedToolIds,
  ownedSkillIds: facts.ownedSkillIds,
  git: facts.git,
  rootAnchor: facts.rootAnchor,
});
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(gatewayRuntime)));
const fixture = Effect.fn("configuredAdmissionTest.fixture")(function* (
  kind: "research" | "code" = "research",
  selectedModel = model,
) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* ProjectWorkGateway;
  const repository = yield* ProjectWorkRepository;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/workspace','[]',${at},${at})`;
  yield* gateway.write(
    {
      ...configuration,
      profiles: configuration.profiles.map((profile) => ({ ...profile, model: selectedModel })),
      modelPolicies: configuration.modelPolicies.map((policy) => ({
        ...policy,
        model: selectedModel,
        ...(selectedModel === subscriptionModel
          ? { tokenLimit: 64_000, durationLimitMs: 300_000 }
          : {}),
      })),
    },
    human,
    source,
    { actor: human },
  );
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    taskId: parentId,
    commandId: CommandId.make("create-parent"),
    title: "Investigate a bounded issue",
    createdAt: at,
  });
  let state = yield* readCurrentState(sql, projectId);
  if (kind === "research") {
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
      return yield* Effect.die("Missing configured implementation member");
    const result = yield* createManagedAssignment({
      taskId: parentId,
      recordId: "fixture-uncommitted",
      attemptId: "fixture-uncommitted-attempt",
      commandId: "fixture-uncommitted-claim",
      providerInstanceId: facts.provider.instanceId,
      threadId: ThreadId.make("fixture-thread"),
      role,
      memberId: member.recordId,
      status: "reserved",
      configuration: {
        instructionsHash: "fixture",
        toolIds: role.tools,
        skillIds: [],
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
                  "Retain only the fixture's approved assignment",
                ),
              )
            : repository.execute(command),
      }),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
  }
  state = yield* readCurrentState(sql, projectId);
  const taskId =
    kind === "code" ? parentId : state.tasks.find((task) => task.taskId !== parentId)!.taskId;
  yield* TestClock.setTime(nowMs);
  const journal = yield* makeProjectTeamDispatchJournal({
    environmentId: "environment",
    maximumEnvironmentModelCalls: 2,
  });
  const change = Effect.fn("configuredAdmissionTest.change")(function* (record: ProjectTeamRecord) {
    const current = yield* readCurrentState(sql, projectId);
    yield* repository.execute(
      yield* decodeFoundationCommand({
        type: "project-work.foundation.commit",
        projectId,
        commandId: `change-${record.recordId}-${record.revision}`,
        expectedRevision: current.revision,
        attribution: { actor: human, source, recordedAt: at },
        records: [record],
        committedAt: at,
      }),
    );
    return yield* readCurrentState(sql, projectId);
  });
  return { sql, gateway, repository, state, taskId, journal, change };
});

it.effect(
  "prepares actual human-configured investigation without writes, then reserves exactly once",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const prepared = prepareProjectTeamConfiguredAdmission({
          state: f.state,
          taskId: f.taskId,
          nowMs,
          facts,
        });
        expect(prepared._tag).toBe("Prepared");
        if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
        expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(f.state.revision);
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toEqual([]);
        expect(prepared.request.assignment).toContain("Instructions for investigator");
        expect(prepared.request.assignment).toContain("Find the cause");
        expect(prepared.request.claim.transition?.kind).toBe("claim");
        const first = yield* f.journal.reserve(prepared.request);
        expect(yield* f.journal.reserve(prepared.request)).toEqual(first);
        expect((yield* readCurrentState(f.sql, projectId)).attempts).toHaveLength(1);
        expect(yield* f.sql`SELECT * FROM project_team_reservation`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_pi_process`).toEqual([]);
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
      }),
    ),
);

it.effect(
  "retains original committed bytes after a lost response and rejects a refreshed envelope",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const first = prepareProjectTeamConfiguredAdmission({
          state: f.state,
          taskId: f.taskId,
          nowMs,
          facts,
        });
        const refreshed = prepareProjectTeamConfiguredAdmission({
          state: f.state,
          taskId: f.taskId,
          nowMs: nowMs + 5,
          facts: {
            ...facts,
            provider: {
              ...facts.provider,
              catalogue: {
                ...facts.provider.catalogue,
                fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 4)),
              },
            },
          },
        });
        if (first._tag !== "Prepared" || refreshed._tag !== "Prepared")
          return yield* Effect.die("Fixture admission was blocked");
        expect(refreshed.request.dispatchId).toBe(first.request.dispatchId);
        expect(refreshed.request.initializeOperationId).toBe(first.request.initializeOperationId);
        expect(refreshed.request.claim.committedAt).not.toBe(first.request.claim.committedAt);
        yield* f.journal.reserve(first.request).pipe(Effect.asVoid);
        expect((yield* f.journal.reserve(refreshed.request).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const retained = yield* f.journal.readRetained(first.request.dispatchId);
        expect(retained.intent.request).toEqual(first.request);
        expect((yield* f.journal.reserve(retained.intent.request)).intent.request).toEqual(
          first.request,
        );
        const current = yield* readCurrentState(f.sql, projectId);
        expect(
          prepareProjectTeamConfiguredAdmission({
            state: current,
            taskId: f.taskId,
            nowMs: nowMs + 6,
            facts,
          })._tag,
        ).toBe("Blocked");
        expect(current.attempts).toHaveLength(1);
      }),
    ),
);

const factDenials: ReadonlyArray<
  readonly [string, (input: CommandConfiguredAdmissionFacts) => CommandConfiguredAdmissionFacts]
> = [
  [
    "disabled actual instance",
    (input) => ({ ...input, provider: { ...input.provider, enabled: false } }),
  ],
  [
    "wrong actual driver",
    (input) => ({ ...input, provider: { ...input.provider, driverKind: "codex" } }),
  ],
  [
    "wrong actual instance",
    (input) => ({
      ...input,
      provider: { ...input.provider, instanceId: ProviderInstanceId.make("other") },
    }),
  ],
  [
    "wrong runtime version",
    (input) => ({ ...input, provider: { ...input.provider, runtimeVersion: "0.99.2" } }),
  ],
  [
    "stale catalogue",
    (input) => ({
      ...input,
      provider: {
        ...input.provider,
        catalogue: {
          ...input.provider.catalogue,
          fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 86_400_000)),
        },
      },
    }),
  ],
  [
    "future catalogue",
    (input) => ({
      ...input,
      provider: {
        ...input.provider,
        catalogue: {
          ...input.provider.catalogue,
          fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 1)),
        },
      },
    }),
  ],
  [
    "unsupported endpoint",
    (input) => ({
      ...input,
      provider: {
        ...input.provider,
        catalogue: {
          ...input.provider.catalogue,
          selectedEntry: { ...input.provider.catalogue.selectedEntry, supported_endpoints: [] },
        },
      },
    }),
  ],
  [
    "advertised output too small",
    (input) => ({
      ...input,
      provider: {
        ...input.provider,
        catalogue: {
          ...input.provider.catalogue,
          selectedEntry: { ...input.provider.catalogue.selectedEntry, max_output_tokens: 511 },
        },
      },
    }),
  ],
  [
    "actual reservation over context",
    (input) => ({
      ...input,
      provider: {
        ...input.provider,
        catalogue: {
          ...input.provider.catalogue,
          selectedEntry: { ...input.provider.catalogue.selectedEntry, context_length: 1500 },
        },
      },
    }),
  ],
  [
    "actual reservation over policy",
    (input) => ({ ...input, provider: { ...input.provider, maxInputTokens: 8192 } }),
  ],
  [
    "unsafe actual input ceiling",
    (input) => ({
      ...input,
      provider: { ...input.provider, maxInputTokens: Number.MAX_SAFE_INTEGER },
    }),
  ],
  ["unsupported configured tool", (input) => ({ ...input, supportedToolIds: ["pi.read"] })],
  ["different selected owned skill", (input) => ({ ...input, ownedSkillIds: ["extra-skill"] })],
  ["writable investigation", (input) => ({ ...input, git: { ...input.git, writable: true } })],
];
for (const [name, changeFacts] of factDenials)
  it.effect(`denies ${name} from controlled Root facts without a reserve`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(
          prepareProjectTeamConfiguredAdmission({
            state: f.state,
            taskId: f.taskId,
            nowMs,
            facts: changeFacts(facts),
          })._tag,
        ).toBe("Blocked");
        expect((yield* readCurrentState(f.sql, projectId)).revision).toBe(f.state.revision);
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
      }),
    ),
  );

for (const mutation of [
  "role-retired",
  "member-paused",
  "gate-invalidated",
  "configuration-generation",
] as const)
  it.effect(`denies actually persisted ${mutation} before reserving`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const role = f.state.foundationRecords?.find(
          (r) => r.kind === "role-revision" && r.role === "investigator" && r.model === model,
        );
        const member = f.state.foundationRecords?.find(
          (r) => r.kind === "member" && r.roleRevisionId === role?.recordId,
        );
        const membership = f.state.foundationRecords?.find(
          (r) => r.kind === "task-membership" && r.taskId === f.taskId,
        );
        const grant = f.state.foundationRecords?.find(
          (r) =>
            r.kind === "gate" &&
            r.recordId ===
              (membership?.kind === "task-membership"
                ? membership.assignment?.authorizationGateId
                : undefined),
        );
        const policy = f.state.foundationRecords?.find((r) => r.kind === "limits");
        if (
          role?.kind !== "role-revision" ||
          member?.kind !== "member" ||
          grant?.kind !== "gate" ||
          policy?.kind !== "limits"
        )
          return yield* Effect.die("Missing configured fixture records");
        const state = yield* f.change(
          mutation === "role-retired"
            ? { ...role, status: "retired", revision: role.revision + 1 }
            : mutation === "member-paused"
              ? { ...member, status: "paused", revision: member.revision + 1 }
              : mutation === "gate-invalidated"
                ? { ...grant, status: "invalidated", revision: grant.revision + 1 }
                : { ...policy, generation: policy.generation + 1, revision: policy.revision + 1 },
        );
        expect(
          prepareProjectTeamConfiguredAdmission({ state, taskId: f.taskId, nowMs, facts })._tag,
        ).toBe("Blocked");
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
      }),
    ),
  );

it.effect(
  "generated unconfigured roles cannot authorize when the installed profile is missing",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const generated = f.state.foundationRecords?.find(
          (r) => r.kind === "role-revision" && r.model === "unconfigured",
        );
        expect(generated?.kind).toBe("role-revision");
        const configured = f.state.foundationRecords?.find(
          (r) => r.kind === "role-revision" && r.role === "investigator" && r.model === model,
        );
        if (configured?.kind !== "role-revision")
          return yield* Effect.die("Missing configured role");
        const state = yield* f.change({
          ...configured,
          status: "retired",
          revision: configured.revision + 1,
        });
        expect(
          prepareProjectTeamConfiguredAdmission({ state, taskId: f.taskId, nowMs, facts })._tag,
        ).toBe("Blocked");
      }),
    ),
);

it.effect("uses actual approved specification and plan for isolated writable code", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture("code");
      const prepared = prepareProjectTeamConfiguredAdmission({
        state: f.state,
        taskId: f.taskId,
        nowMs,
        facts: { ...facts, git: { ...facts.git, writable: true } },
      });
      if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
      expect(prepared.request.assignment).toContain(
        "Implement the bounded scope and verify the requirement",
      );
      expect(prepared.request.assignment).toContain("Instructions for implementer");
      const admitted = yield* f.journal.reserve(prepared.request);
      expect(admitted.intent.limits.writable).toBe(true);
      expect(yield* f.sql`SELECT status FROM project_team_reservation`).toEqual([
        { status: "held" },
      ]);
      expect(
        prepareProjectTeamConfiguredAdmission({
          state: f.state,
          taskId: f.taskId,
          nowMs,
          facts: {
            ...facts,
            git: { ...facts.git, writable: true, worktreePath: facts.git.primaryRoot },
          },
        })._tag,
      ).toBe("Blocked");
    }),
  ),
);

it.effect("admits Code from the exact private subscription facts with nominal route limits", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture("code", subscriptionModel);
      const selected = subscriptionFacts({
        projectId: String(projectId),
        rootTaskId: parentId,
        model: subscriptionModel,
        maximumTokens: 64_000,
        maximumDurationMs: 300_000,
      });
      expect(selected.provider.catalogue.selectedEntry).toEqual({
        id: subscriptionModel,
        owned_by: "openai-codex",
        context_length: 272_000,
        supported_endpoints: ["/codex/responses"],
      });
      expect(selected.provider.subscription?.configuration).toMatchObject({
        reasoningEffort: "high",
        serviceTier: "default",
        maxInputTokens: 16_384,
        maxOutputTokens: 2_048,
      });
      const prepared = prepareProjectTeamConfiguredAdmission({
        state: f.state,
        taskId: f.taskId,
        nowMs,
        facts: {
          ...selected,
          git: { ...selected.git, writable: true },
        },
      });
      if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
      expect(prepared.request.claim.transition?.kind).toBe("claim");
      if (prepared.request.claim.transition?.kind !== "claim") return;
      expect(prepared.request.claim.transition.binding.model).toBe(subscriptionModel);
      expect(prepared.request.claim.transition.binding.configuration.maxTokens).toBe(64_000);
      expect(prepared.request.claim.transition.binding.configuration.maxDurationMs).toBe(300_000);
      expect("maxOutputTokens" in prepared.request.claim.transition.binding.configuration).toBe(
        false,
      );
    }),
  ),
);

it.effect("refuses subscription Code when its private selection belongs to another root", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture("code", subscriptionModel);
      const selected = subscriptionFacts({
        projectId: String(projectId),
        rootTaskId: ProjectWorkTaskId.make("foreign-root"),
        model: subscriptionModel,
        maximumTokens: 64_000,
        maximumDurationMs: 300_000,
      });
      expect(
        prepareProjectTeamConfiguredAdmission({
          state: f.state,
          taskId: f.taskId,
          nowMs,
          facts: {
            ...selected,
            git: { ...selected.git, writable: true },
          },
        })._tag,
      ).toBe("Blocked");
      expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
    }),
  ),
);

it.effect("an actual scope revision revokes the prepared request at the journal boundary", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture("code");
      const prepared = prepareProjectTeamConfiguredAdmission({
        state: f.state,
        taskId: f.taskId,
        nowMs,
        facts: { ...facts, git: { ...facts.git, writable: true } },
      });
      if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
      const task = f.state.tasks.find((t) => t.taskId === f.taskId)!;
      const criteria = f.state.criteria.filter((criterion) => criterion.taskId === f.taskId);
      yield* f.gateway.write(
        {
          type: "project-team.specification.propose",
          commandId: CommandId.make("revise-scope"),
          projectId,
          taskId: f.taskId,
          expectedRevision: f.state.revision,
          expectedTaskRevision: task.revision,
          expectedSpecRevision: 1,
          specification: {
            ...task.specification!,
            objective: "Different approved target",
            revision: 2,
          },
          criterionSnapshots: criteria,
        },
        human,
        source,
        { actor: human },
      );
      const current = yield* readCurrentState(f.sql, projectId);
      expect((yield* f.journal.reserve(prepared.request).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        prepareProjectTeamConfiguredAdmission({
          state: current,
          taskId: f.taskId,
          nowMs,
          facts: { ...facts, git: { ...facts.git, writable: true } },
        })._tag,
      ).toBe("Blocked");
      expect((yield* readCurrentState(f.sql, projectId)).attempts).toEqual([]);
    }),
  ),
);

it.effect("caps a second actual research child to its original journal root budget and depth", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const prepared = prepareProjectTeamConfiguredAdmission({
        state: f.state,
        taskId: f.taskId,
        nowMs,
        facts,
      });
      if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
      const first = yield* f.journal.reserve(prepared.request);
      const state = yield* readCurrentState(f.sql, projectId);
      const parent = state.tasks.find((task) => task.taskId === parentId)!;
      yield* f.gateway.write(
        {
          type: "project-team.investigation.start",
          commandId: CommandId.make("second-investigation"),
          projectId,
          taskId: parentId,
          expectedRevision: state.revision,
          expectedTaskRevision: parent.revision,
          objective: "Investigate another bounded question",
          outputDescriptions: ["Second sourced finding"],
        },
        human,
        source,
        { actor: human },
      );
      const current = yield* readCurrentState(f.sql, projectId);
      const secondId = current.tasks.find(
        (task) => task.taskId !== parentId && task.taskId !== f.taskId,
      )!.taskId;
      const budget = {
        rootTaskId: first.intent.limits.rootTaskId,
        maximumTokens: first.intent.limits.maximumTokens,
        deadlineAtMs: first.intent.limits.rootDeadlineAtMs,
      };
      const anchored: ProjectTeamConfiguredAdmissionFacts = {
        ...facts,
        git: {
          ...facts.git,
          worktreePath: "/second-assigned-worktree",
          branchRef: "refs/heads/second-assigned",
        },
        rootAnchor: { _tag: "RetainedRoot", budget, caps: first.intent.rootCaps },
      };
      expect(
        prepareProjectTeamConfiguredAdmission({
          state: current,
          taskId: secondId,
          nowMs: nowMs + 10,
          facts,
        })._tag,
      ).toBe("Blocked");
      const second = prepareProjectTeamConfiguredAdmission({
        state: current,
        taskId: secondId,
        nowMs: nowMs + 10,
        facts: anchored,
      });
      if (second._tag !== "Prepared" || second.request.claim.transition?.kind !== "claim")
        return yield* Effect.die("Second rooted assignment was blocked");
      expect(Date.parse(second.request.claim.transition.claim.leasedUntil)).toBe(
        budget.deadlineAtMs,
      );
      expect(second.request.claim.transition.binding.configuration.maxDurationMs).toBe(
        budget.deadlineAtMs - nowMs - 10,
      );
      expect(
        prepareProjectTeamConfiguredAdmission({
          state: current,
          taskId: secondId,
          nowMs: nowMs + 10,
          facts: {
            ...anchored,
            rootAnchor: {
              _tag: "RetainedRoot",
              budget,
              caps: { ...first.intent.rootCaps, maximumDelegationDepth: 0 },
            },
          },
        })._tag,
      ).toBe("Blocked");
      yield* TestClock.setTime(nowMs + 10);
      const admitted = yield* f.journal.reserve(second.request);
      expect(admitted.intent.limits.maximumTokens).toBe(first.intent.limits.maximumTokens);
      expect(admitted.intent.limits.rootDeadlineAtMs).toBe(first.intent.limits.rootDeadlineAtMs);
    }),
  ),
);

it.effect(
  "honors the persisted exact successor and blocks a read-only integrator until journal support",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture("code");
        const integrator = f.state.foundationRecords?.find(
          (r) => r.kind === "role-revision" && r.role === "integrator",
        );
        const member = f.state.foundationRecords?.find(
          (r) => r.kind === "member" && r.roleRevisionId === integrator?.recordId,
        );
        const membership = f.state.foundationRecords?.find(
          (r) => r.kind === "task-membership" && r.taskId === f.taskId,
        );
        if (member?.kind !== "member" || membership?.kind !== "task-membership")
          return yield* Effect.die("Missing integrator successor");
        const state = yield* f.change({
          ...membership,
          requestedSuccessorMemberId: member.recordId,
          revision: membership.revision + 1,
        });
        const prepared = prepareProjectTeamConfiguredAdmission({
          state,
          taskId: f.taskId,
          nowMs,
          facts: { ...facts, git: { ...facts.git, writable: true } },
        });
        if (prepared._tag !== "Prepared" || prepared.request.claim.transition?.kind !== "claim")
          return yield* Effect.die("Integrator writable successor was blocked");
        expect(prepared.request.claim.transition.binding.memberId).toBe(member.recordId);
        expect(prepared.request.claim.transition.binding.roleRevisionId).toBe(integrator?.recordId);
        yield* f.gateway.write(
          {
            ...configuration,
            commandId: CommandId.make("readonly-integrator"),
            expectedRevision: state.revision,
            expectedConfigurationGeneration: 1,
            profiles: configuration.profiles.map((profile) =>
              profile.role === "integrator" ? { ...profile, tools: ["pi.read"] } : profile,
            ),
          },
          human,
          source,
          { actor: human },
        );
        const current = yield* readCurrentState(f.sql, projectId);
        expect(
          prepareProjectTeamConfiguredAdmission({
            state: current,
            taskId: f.taskId,
            nowMs,
            facts: { ...facts, git: { ...facts.git, writable: true } },
          }),
        ).toMatchObject({
          _tag: "Blocked",
          reason: "Integrator requires the journal's configured writable tool capability",
        });
      }),
    ),
);

it.effect(
  "denies an unavailable actually configured model without selecting another provider",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.gateway.write(
          {
            ...configuration,
            commandId: CommandId.make("unavailable-model"),
            expectedRevision: f.state.revision,
            expectedConfigurationGeneration: 1,
            profiles: configuration.profiles.map((profile) =>
              profile.role === "investigator" ? { ...profile, model: "unavailable" } : profile,
            ),
            modelPolicies: [
              ...configuration.modelPolicies,
              { model: "unavailable", tokenLimit: 8192, durationLimitMs: 60000, modelCalls: 2 },
            ],
          },
          human,
          source,
          { actor: human },
        );
        const state = yield* readCurrentState(f.sql, projectId);
        expect(
          prepareProjectTeamConfiguredAdmission({ state, taskId: f.taskId, nowMs, facts }),
        ).toMatchObject({
          _tag: "Blocked",
          reason: "Configured model is unavailable on the actual Pi route",
        });
        expect(yield* f.sql`SELECT * FROM project_team_dispatch`).toEqual([]);
      }),
    ),
);

for (const assignmentKind of ["planning", "review"] as const)
  it.effect(
    `prepares actual inherited ${assignmentKind} with its approved parent context and read-only journal`,
    () =>
      scoped(
        Effect.gen(function* () {
          const f = yield* fixture("code");
          const task = f.state.tasks.find((t) => t.taskId === parentId)!;
          const specGate = f.state.foundationRecords?.find(
            (r) => r.kind === "gate" && r.gate === "specification" && r.taskId === parentId,
          );
          const plan = f.state.foundationRecords?.find(
            (r) => r.kind === "plan-revision" && r.taskId === parentId,
          );
          const planGate = f.state.foundationRecords?.find(
            (r) => r.kind === "gate" && r.gate === "plan" && r.taskId === parentId,
          );
          if (
            specGate?.kind !== "gate" ||
            plan?.kind !== "plan-revision" ||
            planGate?.kind !== "gate"
          )
            return yield* Effect.die("Missing approved parent context");
          yield* f.gateway.write(
            {
              type: "project-team.assignment.start",
              commandId: CommandId.make(`start-${assignmentKind}`),
              projectId,
              taskId: parentId,
              expectedRevision: f.state.revision,
              expectedTaskRevision: task.revision,
              assignmentKind,
              objective: `Produce independent ${assignmentKind}`,
              outputDescriptions: ["One retained result"],
              specRevision: task.specRevision,
              specificationGateId: specGate.recordId,
              expectedSpecificationGateRevision: specGate.revision,
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
          const state = yield* readCurrentState(f.sql, projectId);
          const child = state.tasks.find((t) => t.taskId !== parentId)!;
          const prepared = prepareProjectTeamConfiguredAdmission({
            state,
            taskId: child.taskId,
            nowMs,
            facts,
          });
          if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
          expect(prepared.request.assignment).toContain(
            `Instructions for ${assignmentKind === "planning" ? "planner" : "reviewer"}`,
          );
          expect(prepared.request.assignment).toContain("approvedParent");
          if (assignmentKind === "review")
            expect(prepared.request.assignment).toContain(plan.content);
          expect((yield* f.journal.reserve(prepared.request)).intent.limits.writable).toBe(false);
          expect(yield* f.sql`SELECT * FROM project_team_reservation`).toEqual([]);
        }),
      ),
  );

it.effect("rejects unsafe counters and calendar deadlines on the actual configured snapshot", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const unsafeTime of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
        expect(
          prepareProjectTeamConfiguredAdmission({
            state: f.state,
            taskId: f.taskId,
            nowMs: unsafeTime,
            facts,
          })._tag,
        ).toBe("Blocked");
      expect(
        prepareProjectTeamConfiguredAdmission({
          state: { ...f.state, revision: Number.MAX_SAFE_INTEGER },
          taskId: f.taskId,
          nowMs,
          facts,
        })._tag,
      ).toBe("Blocked");
      const policy = f.state.foundationRecords?.find((r) => r.kind === "limits");
      if (policy?.kind !== "limits") return yield* Effect.die("Missing configured policy");
      const state = yield* f.change({
        ...policy,
        durationLimitMs: Number.MAX_SAFE_INTEGER,
        revision: policy.revision + 1,
      });
      expect(
        prepareProjectTeamConfiguredAdmission({ state, taskId: f.taskId, nowMs, facts })._tag,
      ).toBe("Blocked");
    }),
  ),
);

it.effect(
  "explicit alternate admission freezes the approved model without changing token or deadline limits",
  () =>
    scoped(
      Effect.gen(function* () {
        const alternate = "inclusionai/ling-3.0-flash-sante:free" as const;
        const f = yield* fixture("research", alternate);
        const alternateFacts = {
          ...facts,
          provider: {
            ...facts.provider,
            catalogue: {
              ...facts.provider.catalogue,
              selectedEntry: { ...facts.provider.catalogue.selectedEntry, id: alternate },
            },
          },
        };
        const prepared = prepareProjectTeamConfiguredAdmission({
          state: f.state,
          taskId: f.taskId,
          nowMs,
          facts: alternateFacts,
        });
        expect(prepared._tag).toBe("Prepared");
        if (prepared._tag !== "Prepared") return yield* Effect.die(prepared.reason);
        yield* f.journal.reserve(prepared.request);
        const state = yield* readCurrentState(f.sql, projectId);
        const binding = state.foundationRecords?.find((record) => record.kind === "run-binding");
        expect(binding).toMatchObject({
          kind: "run-binding",
          model: alternate,
          configuration: { maxTokens: 8192, maxDurationMs: 60000 },
        });
        expect(yield* f.sql`SELECT * FROM project_team_model_request`).toEqual([]);
        expect(
          prepareProjectTeamConfiguredAdmission({ state: f.state, taskId: f.taskId, nowMs, facts })
            ._tag,
        ).not.toBe("Prepared");
      }),
    ),
);
