import { expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProjectWorkAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkReadIntent,
  ProjectWorkTaskId,
  ProjectTeamRecord,
  ProviderInstanceId,
  ThreadId,
  type ProjectTeamGuidedIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as Authorization from "../../projectWork/ProjectTeamAuthorization.ts";
import { gatewayRuntime, seed } from "../../projectWork/ProjectTeamAuthorization.testFixtures.ts";
import { projectTeamScopeHash } from "../../projectWork/ProjectTeamPolicy.ts";
import { ProjectWorkGateway } from "../../projectWork/ProjectWorkGateway.ts";
import {
  ProjectWorkRepository,
  readCurrentState,
} from "../../projectWork/ProjectWorkRepository.ts";
import {
  executePiProjectWorkBridgeTool,
  piProjectWorkToolCapabilities,
  preparePiProjectWorkTools,
  PiProjectWorkToolValidationError,
} from "./PiProjectWorkTools.ts";

const projectId = ProjectId.make("pi-work-bridge-project");
const parentId = ProjectWorkTaskId.make("pi-work-bridge-parent");
const at = "2026-01-01T00:00:00.000Z";
const human = { actor: { kind: "human", id: "bridge-maintainer" } } as const;
const humanSource = { kind: "web", id: "bridge-fixture" } as const;
const source = { kind: "mcp", id: "owned-pi-worker" } as const;
const attribution = { actor: human.actor, source: humanSource, recordedAt: at };
const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const encodeJSON = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parameters = (intent: unknown) => ({ intentJSON: encodeJSON(intent) });
const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(gatewayRuntime)));

it.effect("advertises and persists a human question through the actual Pi write bridge", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed("investigator");
      const tools = preparePiProjectWorkTools({
        roleTools: f.role.tools,
        bindingTools: f.binding.configuration.toolIds,
      });
      expect(
        tools.find((entry) => entry.tool.function.name === "project_work_write")?.tool.function
          .description,
      ).toContain("project-team.question.request");
      const state = yield* readCurrentState(f.sql, f.binding.projectId);
      const task = state.tasks.find((entry) => entry.taskId === f.binding.taskId)!;
      const gate = state.foundationRecords?.find(
        (entry) => entry.kind === "gate" && entry.recordId === f.binding.planGateId,
      );
      if (gate?.kind !== "gate") return yield* Effect.die("Missing retained bridge gate");
      const request = {
        type: "project-team.question.request",
        commandId: "pi-human-question",
        projectId: f.binding.projectId,
        taskId: f.binding.taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: task.revision,
        specRevision: task.specRevision,
        planRevision: f.binding.planRevision,
        questionId: "pi-question",
        targetGateId: gate.recordId,
        expectedGateRevision: gate.revision,
        body: "Should the original history remain visible?",
        choices: ["Keep history"],
      };
      const receipt = yield* executePiProjectWorkBridgeTool({
        toolName: "project_work_write",
        arguments: parameters(request),
        principal: f.principal,
        source,
      });
      expect(receipt).toMatchObject({ receipt: { status: "accepted", eventCount: 1 } });
      const after = yield* readCurrentState(f.sql, f.binding.projectId);
      expect(
        after.foundationRecords?.find((entry) => entry.recordId === request.questionId),
      ).toMatchObject({
        kind: "question",
        status: "pending",
        senderId: f.binding.memberId,
        body: request.body,
      });
      expect(after.foundationRecords?.find((entry) => entry.recordId === gate.recordId)).toEqual(
        gate,
      );
      expect(
        yield* executePiProjectWorkBridgeTool({
          toolName: "project_work_write",
          arguments: parameters(request),
          principal: f.principal,
          source,
        }),
      ).toEqual(receipt);
    }),
  ),
);

it("denies absent capability in either configuration and never infers it from a role name", () => {
  for (const capability of piProjectWorkToolCapabilities) {
    expect(preparePiProjectWorkTools({ roleTools: [capability], bindingTools: [] })).toEqual([]);
    expect(preparePiProjectWorkTools({ roleTools: [], bindingTools: [capability] })).toEqual([]);
  }
  expect(preparePiProjectWorkTools({ roleTools: ["planner"], bindingTools: ["planner"] })).toEqual(
    [],
  );
  const selected = preparePiProjectWorkTools({
    roleTools: ["project-work.report", "project-work.plan"],
    bindingTools: ["project-work.report", "project-work.plan", "project-work.write"],
  });
  expect(selected.map((entry) => entry.tool.function.name)).toEqual([
    "project_work_report",
    "project_work_plan",
  ]);
});

for (const input of [
  { roleTools: ["project-work.read-project"], bindingTools: ["project-work.read-task"] },
  { roleTools: ["project-work.read-task"], bindingTools: ["project-work.read-project"] },
])
  it("does not combine different read grants into authority", () => {
    expect(preparePiProjectWorkTools(input)).toEqual([]);
  });

it("prefers the project read only when both lists allow it and preserves legacy schemas", () => {
  const tools = preparePiProjectWorkTools({
    roleTools: piProjectWorkToolCapabilities,
    bindingTools: piProjectWorkToolCapabilities,
  });
  expect(tools.map((entry) => entry.capability)).toEqual([
    "project-work.read-project",
    "project-work.write",
    "project-work.report",
    "project-work.plan",
  ]);
  expect(tools[0]!.tool.function.parameters).toEqual(
    Schema.toJsonSchemaDocument(ProjectWorkReadIntent).schema,
  );
  expect(tools[1]!.tool.function.parameters).toEqual(
    Schema.toJsonSchemaDocument(
      Schema.Struct({ intentJSON: Schema.String.check(Schema.isMaxLength(262144)) }),
    ).schema,
  );
  const narrowed = preparePiProjectWorkTools({
    roleTools: piProjectWorkToolCapabilities,
    bindingTools: ["project-work.read-task"],
  });
  expect(narrowed[0]!.capability).toBe("project-work.read-task");
});

it("snapshots caller lists and freezes the full advertised tool tree", () => {
  const roleTools = ["project-work.report"];
  const bindingTools = ["project-work.report"];
  const tools = preparePiProjectWorkTools({ roleTools, bindingTools });
  roleTools.length = 0;
  bindingTools.push("project-work.write");
  expect(tools.map((entry) => entry.capability)).toEqual(["project-work.report"]);
  expect(Object.isFrozen(piProjectWorkToolCapabilities)).toBe(true);
  expect(Object.isFrozen(tools)).toBe(true);
  expect(Object.isFrozen(tools[0])).toBe(true);
  expect(Object.isFrozen(tools[0]!.tool.function.parameters.properties)).toBe(true);
  expect(() => Reflect.set(tools[0]!.tool.function, "name", "project_work_write")).not.toThrow();
  expect(tools[0]!.tool.function.name).toBe("project_work_report");
});

const sparseTools: string[] = [];
sparseTools.length = 1;
for (const malformed of [
  [""],
  [" project-work.report"],
  ["x".repeat(257)],
  sparseTools,
  Array.from({ length: 65 }, (_, index) => `tool-${index}`),
])
  it("rejects malformed or excessive tool snapshots", () => {
    for (const input of [
      { roleTools: malformed, bindingTools: [] },
      { roleTools: [], bindingTools: malformed },
    ])
      expect(() => preparePiProjectWorkTools(input)).toThrow(PiProjectWorkToolValidationError);
  });

const plan = {
  type: "project-team.plan.propose",
  projectId,
  taskId: parentId,
  commandId: "plan",
  expectedRevision: 0,
  expectedTaskRevision: 0,
  specRevision: 1,
  content: "Implement the approved scope",
  dependencyTaskIds: [],
} as const;
const report = {
  type: "project-team.assignment.report",
  projectId,
  taskId: parentId,
  commandId: "report",
  expectedRevision: 0,
  expectedTaskRevision: 0,
  specRevision: 1,
  planRevision: 0,
  assignmentId: "assignment",
  expectedAssignmentRevision: 0,
  summary: "Sourced findings",
  evidenceIds: [],
  outputArtifactIds: [],
  outcome: "findings",
} as const;
const create = {
  type: "project-work.task.create",
  projectId,
  taskId: "new-task",
  commandId: "create",
  title: "A new task",
  createdAt: at,
} as const;
const approve = {
  type: "project-team.gate.respond",
  projectId,
  taskId: parentId,
  commandId: "approve",
  expectedRevision: 0,
  expectedTaskRevision: 0,
  gateId: "gate",
  expectedGateRevision: 0,
  specRevision: 1,
  planRevision: 0,
  response: "approved",
} as const;

for (const [toolName, intent] of [
  ["project_work_report", plan],
  ["project_work_report", create],
  ["project_work_report", approve],
  ["project_work_plan", report],
  ["project_work_plan", create],
  ["project_work_plan", approve],
] as const)
  it.effect(`${toolName} rejects ${intent.type} before invoking Gateway`, () =>
    scoped(
      Effect.gen(function* () {
        const result = yield* executePiProjectWorkBridgeTool({
          toolName,
          arguments: parameters(intent),
          principal: human,
          source,
        }).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "intent-kind" } });
      }),
    ),
  );

for (const [toolName, arguments_, reason] of [
  ["project_work_unknown", {}, "unknown-tool"],
  ["project_work_report", { ...parameters(report), principal: human }, "invalid-arguments"],
  ["project_work_report", { intentJSON: "{" }, "invalid-intent"],
  ["project_work_report", parameters({ ...report, actor: human.actor }), "invalid-intent"],
  [
    "project_work_report",
    parameters({
      ...report,
      outputs: [
        { criterionId: "criterion", detail: "source", kind: "observation", secret: "extra" },
      ],
    }),
    "invalid-intent",
  ],
  ["project_work_plan", { intentJSON: " ".repeat(262145) }, "invalid-arguments"],
  ["project_work_plan", { intentJSON: "é".repeat(131073) }, "invalid-arguments"],
  ["project_work_plan", { intentJSON: "😀".repeat(65537) }, "invalid-arguments"],
  ["project_work_read", { projectId, operation: "tasks", actor: human.actor }, "invalid-arguments"],
] as const)
  it.effect(`rejects ${toolName} invalid input as ${reason} before invoking Gateway`, () =>
    scoped(
      Effect.gen(function* () {
        const result = yield* executePiProjectWorkBridgeTool({
          toolName,
          arguments: arguments_,
          principal: human,
          source,
        }).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PiProjectWorkToolValidationError", reason },
        });
      }),
    ),
  );

/** Actual guided assignments and current SQL authority; no process is launched. */
const assignment = Effect.fn("piBridgeTest.assignment")(function* (
  kind: "investigation" | "planning",
  capabilities?: readonly string[],
  bindingTools?: readonly string[],
) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ProjectWorkRepository;
  const gateway = yield* ProjectWorkGateway;
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Bridge fixture','/workspace','[]',${at},${at})`;
  yield* gateway.write(
    { ...create, taskId: parentId, commandId: CommandId.make("parent-create") },
    human.actor,
    humanSource,
    human,
  );
  const state = () => readCurrentState(sql, projectId);
  const envelope = Effect.gen(function* () {
    const current = yield* state();
    return {
      projectId,
      taskId: parentId,
      expectedRevision: current.revision,
      expectedTaskRevision: current.tasks.find((task) => task.taskId === parentId)!.revision,
    };
  });
  if (kind === "planning") {
    const criterionId = ProjectWorkCriterionId.make("parent-criterion");
    yield* gateway.write(
      {
        ...(yield* envelope),
        type: "project-team.specification.propose",
        commandId: CommandId.make("parent-specification"),
        expectedSpecRevision: 0,
        specification: {
          objective: "Bounded work",
          scopeIn: "This task",
          scopeOut: "Other tasks",
          criterionIds: [criterionId],
          revision: 1,
          protected: false,
        },
        criterionSnapshots: [
          {
            criterionId,
            taskId: parentId,
            description: "Verified output",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
        ],
      },
      human.actor,
      humanSource,
      human,
    );
    const current = yield* state();
    const gate = current.foundationRecords!.find(
      (record) => record.kind === "gate" && record.gate === "specification",
    )!;
    yield* gateway.write(
      {
        ...approve,
        ...(yield* envelope),
        commandId: CommandId.make("parent-approve"),
        gateId: gate.recordId,
        expectedGateRevision: gate.revision,
      },
      human.actor,
      humanSource,
      human,
    );
    const approved = (yield* state()).foundationRecords!.find(
      (record) => record.recordId === gate.recordId,
    )!;
    yield* gateway.write(
      {
        ...(yield* envelope),
        type: "project-team.assignment.start",
        commandId: CommandId.make("planning-start"),
        assignmentKind: "planning",
        objective: "Propose the bounded plan",
        outputDescriptions: ["Retained proposed plan"],
        specRevision: 1,
        specificationGateId: approved.recordId,
        expectedSpecificationGateRevision: approved.revision,
      },
      human.actor,
      humanSource,
      human,
    );
  } else {
    yield* gateway.write(
      {
        ...(yield* envelope),
        type: "project-team.investigation.start",
        commandId: CommandId.make("investigation-start"),
        objective: "Find the cause without editing code",
        outputDescriptions: ["Sourced findings"],
      },
      human.actor,
      humanSource,
      human,
    );
  }
  let current = yield* state();
  const child = current.tasks.find((task) => task.taskId !== parentId)!;
  const generated = current.foundationRecords!.find((record) => record.kind === "role-revision")!;
  if (generated.kind !== "role-revision") return yield* Effect.die("Missing generated role");
  const role = decodeRecord({
    ...generated,
    recordId: "configured-role",
    model: "fixture-model",
    tools: capabilities ?? [...generated.tools, "project-work.read-task"],
  });
  if (role.kind !== "role-revision") return yield* Effect.die("Invalid configured role");
  yield* repo.execute({
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make("configure"),
    expectedRevision: current.revision,
    committedAt: at,
    attribution,
    records: [
      role,
      {
        kind: "member",
        recordId: "member",
        projectId,
        revision: 0,
        generation: 0,
        updatedAt: at,
        status: "active",
        name: "Fixture worker",
        coordinator: false,
        roleRevisionId: role.recordId,
      },
    ],
  });
  current = yield* state();
  const grant = current.foundationRecords!.find(
    (record) => record.kind === "gate" && record.taskId === child.taskId,
  )!;
  const binding = decodeRecord({
    kind: "run-binding",
    recordId: "binding",
    projectId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "reserved",
    taskId: child.taskId,
    attemptId: "attempt",
    memberId: "member",
    roleRevisionId: role.recordId,
    providerInstanceId: "pi",
    threadId: "bridge-thread",
    environmentId: "environment",
    model: role.model,
    configuration: {
      instructionsHash: "hash",
      toolIds: bindingTools ?? role.tools,
      skillIds: [],
      runtimeVersion: "fixture",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    worktree: "/workspace",
    branch: "fixture",
    leaseGeneration: 0,
    specRevision: 1,
    planRevision: 0,
    authorizationGateId: grant.recordId,
    scopeHash: projectTeamScopeHash(current, child.taskId),
  });
  if (binding.kind !== "run-binding") return yield* Effect.die("Missing binding");
  yield* repo.execute({
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make("claim"),
    expectedRevision: current.revision,
    records: [],
    committedAt: at,
    attribution,
    transition: {
      kind: "claim",
      taskId: child.taskId,
      expectedTaskRevision: child.revision,
      authorizationGateId: grant.recordId,
      expectedGateRevision: grant.revision,
      binding,
      claim: {
        type: "project-work.task.claim",
        projectId,
        taskId: child.taskId,
        commandId: CommandId.make("claim"),
        attemptId: ProjectWorkAttemptId.make("attempt"),
        leaseToken: "fixture-lease",
        leasedUntil: "2030-01-01T00:00:00.000Z",
        claimedAt: at,
      },
    },
  });
  yield* repo.execute({
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make("running"),
    expectedRevision: (yield* state()).revision,
    committedAt: at,
    attribution,
    records: [{ ...binding, status: "running", revision: 1, sessionId: "fixture-native-session" }],
  });
  const auth = yield* Authorization.ProjectTeamAuthorization;
  const issued = yield* auth.issueCredential({
    providerInstanceId: ProviderInstanceId.make("pi"),
    threadId: ThreadId.make("bridge-thread"),
  });
  if (issued === undefined) return yield* Effect.die("Missing issued credential");
  const principal = {
    actor: { kind: "agent" as const, id: Authorization.managedActorId(issued.credential) },
    managed: issued.credential,
  };
  const buildReport = Effect.gen(function* () {
    const current = yield* state();
    const membership = current.foundationRecords!.find(
      (record) => record.kind === "task-membership" && record.taskId === child.taskId,
    )!;
    return {
      ...report,
      commandId: CommandId.make("managed-report"),
      taskId: child.taskId,
      expectedRevision: current.revision,
      expectedTaskRevision: current.tasks.find((task) => task.taskId === child.taskId)!.revision,
      assignmentId: membership.recordId,
      expectedAssignmentRevision: membership.revision,
    } satisfies ProjectTeamGuidedIntent;
  });
  const buildPlan = Effect.gen(function* () {
    return {
      ...plan,
      commandId: CommandId.make("managed-plan"),
      ...(yield* envelope),
    } satisfies ProjectTeamGuidedIntent;
  });
  return { sql, repo, gateway, state, child, principal, buildReport, buildPlan };
});

const duplicateBaseTools = [
  "read",
  "search",
  "project-work",
  "project-work.read-task",
  "project-work.report",
];
for (const [label, roleTools, bindingTools] of [
  ["role-only", [...duplicateBaseTools, "project-work.report"], duplicateBaseTools],
  ["binding-only", duplicateBaseTools, [...duplicateBaseTools, "project-work.report"]],
  [
    "both",
    [...duplicateBaseTools, "project-work.report"],
    [...duplicateBaseTools, "project-work.report"],
  ],
  ["unrelated", [...duplicateBaseTools, "read"], [...duplicateBaseTools, "search"]],
] as const)
  it.effect(`advertises and executes a current report with ${label} duplicate capability IDs`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* assignment("investigation", roleTools, bindingTools);
        const authorization = yield* Authorization.ProjectTeamAuthorization;
        const authority = yield* authorization.resolve(f.principal);
        if (authority === undefined) return yield* Effect.die("Missing current authority");
        expect(authority.role.tools).toEqual(roleTools);
        expect(authority.binding.configuration.toolIds).toEqual(bindingTools);
        yield* authorization.capability(f.principal, "project-work.report");
        const tools = preparePiProjectWorkTools({
          roleTools: authority.role.tools,
          bindingTools: authority.binding.configuration.toolIds,
        });
        expect(tools.map((entry) => [entry.tool.function.name, entry.capability])).toEqual([
          ["project_work_read", "project-work.read-task"],
          ["project_work_report", "project-work.report"],
        ]);
        expect(Object.isFrozen(tools)).toBe(true);
        const intent = yield* f.buildReport;
        yield* executePiProjectWorkBridgeTool({
          toolName: "project_work_report",
          arguments: parameters(intent),
          principal: f.principal,
          source,
        });
        expect(
          (yield* f.state()).evidence.find((entry) => entry.summary === intent.summary),
        ).toMatchObject({
          taskId: f.child.taskId,
          attribution: { actor: f.principal.actor, source },
        });
        expect(
          yield* f.sql`SELECT command_id FROM project_work_command_receipts
        WHERE project_id=${projectId} AND command_id=${intent.commandId}`,
        ).toHaveLength(1);
      }),
    ),
  );

it.effect("investigator reports persist exact managed attribution and replay one receipt", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* assignment("investigation");
      const intent = yield* f.buildReport;
      const call = {
        toolName: "project_work_report",
        arguments: parameters(intent),
        principal: f.principal,
        source,
      };
      const first = yield* executePiProjectWorkBridgeTool(call);
      expect(yield* executePiProjectWorkBridgeTool(call)).toEqual(first);
      const state = yield* f.state();
      expect(state.evidence.find((entry) => entry.summary === intent.summary)).toMatchObject({
        attribution: { actor: f.principal.actor, source },
        taskId: f.child.taskId,
        kind: "observation",
      });
      expect(
        yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${intent.commandId}`,
      ).toHaveLength(1);
      expect(
        yield* executePiProjectWorkBridgeTool({
          toolName: "project_work_read",
          arguments: { projectId, taskId: f.child.taskId, operation: "task" },
          principal: f.principal,
          source,
        }),
      ).toMatchObject({ taskId: f.child.taskId });
    }),
  ),
);

it.effect("planner proposes the inherited parent plan without broad write authority", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* assignment("planning");
      const intent = yield* f.buildPlan;
      yield* executePiProjectWorkBridgeTool({
        toolName: "project_work_plan",
        arguments: parameters(intent),
        principal: f.principal,
        source,
      });
      const state = yield* f.state();
      expect(
        state.foundationRecords!.find((record) => record.kind === "plan-revision"),
      ).toMatchObject({ taskId: parentId, content: intent.content });
      expect(
        state.evidence.find((entry) => entry.summary === "Retained proposed plan"),
      ).toMatchObject({
        taskId: f.child.taskId,
        attribution: { actor: f.principal.actor, source },
      });
      const before = state.revision;
      const denied = yield* executePiProjectWorkBridgeTool({
        toolName: "project_work_write",
        arguments: parameters(create),
        principal: f.principal,
        source,
      }).pipe(Effect.result);
      expect(denied).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProjectTeamAuthorizationError" },
      });
      expect((yield* f.state()).revision).toBe(before);
    }),
  ),
);

for (const kind of ["investigation", "planning"] as const)
  it.effect(`current Gateway denies ${kind} after removal of the corresponding capability`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* assignment(kind, [
          "read",
          "search",
          "project-work",
          "project-work.read-task",
        ]);
        const before = yield* f.state();
        const denied = yield* executePiProjectWorkBridgeTool({
          toolName: kind === "investigation" ? "project_work_report" : "project_work_plan",
          arguments: parameters(yield* kind === "investigation" ? f.buildReport : f.buildPlan),
          principal: f.principal,
          source,
        }).pipe(Effect.result);
        expect(denied).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ProjectTeamAuthorizationError",
          },
        });
        expect(yield* f.state()).toEqual(before);
      }),
    ),
  );

it.effect(
  "legacy write accepts the exact envelope bound and retains authenticated attribution",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Legacy bridge','/workspace','[]',${at},${at})`;
        const json = encodeJSON(create);
        const intentJSON = json + " ".repeat(262144 - Buffer.byteLength(json));
        yield* executePiProjectWorkBridgeTool({
          toolName: "project_work_write",
          arguments: { intentJSON },
          principal: human,
          source,
        });
        const state = yield* readCurrentState(sql, projectId);
        expect(state.tasks[0]).toMatchObject({
          taskId: create.taskId,
          attribution: { actor: human.actor, source },
        });
      }),
    ),
);

it.effect(
  "current role retirement denies a previously advertised report without changing state",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* assignment("investigation");
        const intent = yield* f.buildReport;
        const current = yield* f.state();
        const role = current.foundationRecords!.find(
          (record) => record.recordId === "configured-role",
        )!;
        if (role.kind !== "role-revision") return yield* Effect.die("Missing role");
        const advertised = preparePiProjectWorkTools({
          roleTools: role.tools,
          bindingTools: role.tools,
        });
        expect(advertised.some((entry) => entry.tool.function.name === "project_work_report")).toBe(
          true,
        );
        yield* f.repo.execute({
          type: "project-work.foundation.commit",
          projectId,
          commandId: CommandId.make("retire-role"),
          expectedRevision: current.revision,
          records: [{ ...role, status: "retired", revision: role.revision + 1 }],
          committedAt: at,
          attribution,
        });
        const before = yield* f.state();
        const denied = yield* executePiProjectWorkBridgeTool({
          toolName: "project_work_report",
          arguments: parameters({ ...intent, expectedRevision: before.revision }),
          principal: f.principal,
          source,
        }).pipe(Effect.result);
        expect(denied).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ProjectTeamAuthorizationError",
          },
        });
        expect(yield* f.state()).toEqual(before);
      }),
    ),
);

it.effect(
  "cancels a bridged report waiting for the real SQL permit with no committed receipt",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* assignment("investigation");
        const intent = yield* f.buildReport;
        const before = yield* f.state();
        const locked = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const owner = yield* f.sql
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(locked, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(locked);
        const observer = ProjectWorkGateway.of({
          ...f.gateway,
          write: (command, actor, passedSource, principal) =>
            Effect.gen(function* () {
              expect(actor).toBe(f.principal.actor);
              expect(principal).toBe(f.principal);
              expect(passedSource).toBe(source);
              yield* Deferred.succeed(entered, undefined);
              return yield* f.gateway.write(command, actor, passedSource, principal);
            }),
        });
        const worker = yield* executePiProjectWorkBridgeTool({
          toolName: "project_work_report",
          arguments: parameters(intent),
          principal: f.principal,
          source,
        }).pipe(Effect.provideService(ProjectWorkGateway, observer), Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(worker);
        expect(Exit.isFailure(yield* Fiber.await(worker))).toBe(true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(owner);
        expect(yield* f.state()).toEqual(before);
        expect(
          yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${intent.commandId}`,
        ).toHaveLength(0);
      }),
    ),
);
