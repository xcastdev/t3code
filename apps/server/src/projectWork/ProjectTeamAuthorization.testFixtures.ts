import { expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  EventId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  type ProjectTeamGuidedIntent,
  ProviderInstanceId,
  ThreadId,
  ProjectTeamRecord,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import {
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "./ProjectWorkRepository.ts";
import { projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
import { ProjectWorkProjection, ProjectWorkProjectionLive } from "./ProjectWorkProjection.ts";

export const at = "2026-01-01T00:00:00.000Z";
export const projectId = ProjectId.make("authorization-project");
export const taskId = ProjectWorkTaskId.make("authorization-task");
export const threadId = ThreadId.make("authorization-thread");
export const providerInstanceId = ProviderInstanceId.make("pi");
export const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
const encodeHistoricalEvent = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
export const attribution = {
  actor: { kind: "system", id: "scheduler" },
  source: { kind: "system", id: "scheduler" },
  recordedAt: at,
} as const;
export const runtime = Layer.mergeAll(
  Authorization.layer,
  ProjectWorkRepositoryLive,
  ProjectWorkQueryLive,
  ProjectWorkProjectionLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));
/** Restore an old event fixture to test read authorization, never a worker drain receipt. */
export const restoreHistoricalBinding = Effect.fn("authorizationTest.restoreHistoricalBinding")(
  function* (record: ProjectTeamRecord) {
    const sql = yield* SqlClient.SqlClient;
    const projection = yield* ProjectWorkProjection;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* readCurrentState(sql, projectId);
        const eventId = EventId.make(`legacy-binding:${record.recordId}:${record.revision}`);
        const event = {
          eventId,
          projectId,
          revision: state.revision + 1,
          occurredAt: at,
          type: "project-work.foundation.recorded",
          record,
        };
        const payload = yield* encodeHistoricalEvent(event);
        yield* sql`INSERT INTO project_work_events (event_id,project_id,event_type,occurred_at,command_id,payload_json)
      VALUES (${eventId},${projectId},${event.type},${at},${eventId},${payload})`;
        yield* projection.rebuild(projectId);
      }),
    );
  },
);

type Binding = Extract<ProjectTeamRecord, { kind: "run-binding" }>;
type Role = Extract<ProjectTeamRecord, { kind: "role-revision" }>;
const humanAttribution = {
  actor: { kind: "human", id: "fixture-human" },
  source: { kind: "web", id: "fixture-browser" },
  recordedAt: at,
} as const;

/** Database fixture only: no process launch or descendant-drain proof. */
export const createManagedAssignment = Effect.fn("authorizationTest.createManagedAssignment")(
  function* (input: {
    readonly taskId: ProjectWorkTaskId;
    readonly recordId: string;
    readonly attemptId: string;
    readonly commandId: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly role: Role;
    readonly status: string;
    readonly configuration: Binding["configuration"];
    readonly sessionId?: string;
    readonly memberId?: string;
    readonly parentRunId?: string;
    readonly leasedUntil?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const repo = yield* ProjectWorkRepository;
    const current = () => readCurrentState(sql, projectId);
    if (!(yield* current()).tasks.some((t) => t.taskId === input.taskId))
      yield* repo.execute({
        type: "project-work.task.create",
        projectId,
        taskId: input.taskId,
        commandId: CommandId.make(`${input.recordId}-create`),
        title: "Bounded task",
        createdAt: at,
      });
    const guided = Effect.fn("authorizationTest.guided")(function* (
      intent: ProjectTeamGuidedIntent,
    ) {
      yield* repo.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: intent.commandId,
          expectedRevision: intent.expectedRevision,
          attribution: humanAttribution,
          records: [],
          committedAt: at,
          guided: { intent },
        }),
      );
    });
    const envelope = Effect.gen(function* () {
      const state = yield* current();
      return {
        projectId,
        taskId: input.taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks.find((t) => t.taskId === input.taskId)!.revision,
      };
    });
    const criterionId = ProjectWorkCriterionId.make(
      input.recordId === "binding" ? "criterion" : `${input.recordId}-criterion`,
    );
    yield* guided({
      ...(yield* envelope),
      type: "project-team.specification.propose",
      commandId: CommandId.make(`${input.recordId}-spec`),
      expectedSpecRevision: 0,
      specification: {
        objective: "Task",
        scopeIn: "Task",
        scopeOut: "Other tasks",
        criterionIds: [criterionId],
        revision: 1,
        protected: false,
      },
      criterionSnapshots: [
        {
          criterionId,
          taskId: input.taskId,
          description: "Requirement",
          required: true,
          status: "unsatisfied",
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: at,
        },
      ],
    });
    const approve = Effect.fn("authorizationTest.approve")(function* (
      kind: "specification" | "plan",
    ) {
      const state = yield* current();
      const gate = state.foundationRecords!.find(
        (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
          r.kind === "gate" &&
          r.taskId === input.taskId &&
          r.gate === kind &&
          r.status === "pending",
      )!;
      yield* repo.execute(
        decodeCommit({
          type: "project-work.foundation.commit",
          projectId,
          commandId: `${input.recordId}-approve-${kind}`,
          expectedRevision: state.revision,
          attribution: humanAttribution,
          records: [
            {
              ...gate,
              status: "approved",
              revision: gate.revision + 1,
              attribution: humanAttribution,
            },
          ],
          committedAt: at,
        }),
      );
    });
    yield* approve("specification");
    yield* guided({
      ...(yield* envelope),
      type: "project-team.plan.propose",
      commandId: CommandId.make(`${input.recordId}-plan`),
      specRevision: 1,
      content: "Implement the bounded scope and verify the requirement",
      dependencyTaskIds: [],
    });
    yield* approve("plan");
    let state = yield* current();
    const specGate = state.foundationRecords!.find(
      (r) => r.kind === "gate" && r.taskId === input.taskId && r.gate === "specification",
    )!;
    const planGate = state.foundationRecords!.find(
      (r) => r.kind === "gate" && r.taskId === input.taskId && r.gate === "plan",
    )!;
    const plan = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "plan-revision" }> =>
        r.kind === "plan-revision" && r.taskId === input.taskId,
    )!;
    yield* guided({
      ...(yield* envelope),
      type: "project-team.execution.start",
      commandId: CommandId.make(`${input.recordId}-execute`),
      specRevision: 1,
      planRevision: 1,
      specGateId: specGate.recordId,
      expectedSpecGateRevision: specGate.revision,
      planId: plan.recordId,
      expectedPlanRecordRevision: plan.revision,
      planGateId: planGate.recordId,
      expectedPlanGateRevision: planGate.revision,
    });
    state = yield* current();
    const grant = state.foundationRecords!.find(
      (r): r is Extract<ProjectTeamRecord, { kind: "gate" }> =>
        r.kind === "gate" && r.taskId === input.taskId && r.gate === "execution",
    )!;
    const binding = decodeRecord({
      kind: "run-binding",
      recordId: input.recordId,
      projectId,
      revision: 0,
      generation: 0,
      updatedAt: at,
      status: "reserved",
      taskId: input.taskId,
      attemptId: input.attemptId,
      memberId: input.memberId ?? "member",
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
      roleRevisionId: input.role.recordId,
      providerInstanceId: input.providerInstanceId,
      threadId: input.threadId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      environmentId: "environment",
      model: input.role.model,
      configuration: input.configuration,
      worktree: "/workspace",
      branch: "task",
      leaseGeneration: 0,
      specRevision: 1,
      planRevision: 1,
      authorizationGateId: grant.recordId,
      specificationGateId: specGate.recordId,
      planGateId: planGate.recordId,
      scopeHash: projectTeamScopeHash(state, input.taskId, plan),
    });
    if (binding.kind !== "run-binding")
      return yield* Effect.die("Fixture decoded an invalid binding");
    yield* repo.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: input.commandId,
        expectedRevision: state.revision,
        attribution,
        records: [],
        committedAt: at,
        transition: {
          kind: "claim",
          taskId: input.taskId,
          expectedTaskRevision: state.tasks.find((t) => t.taskId === input.taskId)!.revision,
          authorizationGateId: grant.recordId,
          expectedGateRevision: grant.revision,
          binding,
          claim: {
            type: "project-work.task.claim",
            projectId,
            taskId: input.taskId,
            commandId: input.commandId,
            attemptId: input.attemptId,
            leaseToken: `${input.recordId}-lease`,
            leasedUntil: input.leasedUntil ?? "2030-01-01T00:00:00.000Z",
            claimedAt: at,
          },
        },
      }),
    );
    if (input.status === "reserved") return binding;
    const running = decodeRecord({ ...binding, status: input.status, revision: 1 });
    yield* repo.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: `${input.recordId}-${input.status}`,
        expectedRevision: (yield* current()).revision,
        attribution,
        records: [running],
        committedAt: at,
      }),
    );
    if (running.kind !== "run-binding")
      return yield* Effect.die("Fixture decoded an invalid running binding");
    return running;
  },
);

export const seed = Effect.fn("authorizationTest.seed")(function* (
  roleName = "investigator",
  status = "running",
  options: {
    readonly roleTools?: ReadonlyArray<string>;
    readonly toolIds?: ReadonlyArray<string>;
    readonly nativeSessionId?: string | null;
    readonly delegationDepth?: number;
    readonly issueCredential?: boolean;
  } = {},
) {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* ProjectWorkRepository;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/workspace','[]',${at},${at})`;
  const command = { projectId, taskId };
  yield* repo.execute({
    ...command,
    type: "project-work.task.create",
    commandId: CommandId.make("create"),
    title: "Task",
    createdAt: at,
  });
  const common = { projectId, revision: 0, generation: 0, updatedAt: at };
  const tools = [
    "project-work.write",
    "project-work.read-project",
    "project-work.delegate",
    "terminal",
    "pull-requests",
  ];
  const role = decodeRecord({
    ...common,
    kind: "role-revision",
    recordId: "role",
    status: "available",
    roleId: roleName,
    roleRevision: 1,
    role: roleName,
    instructions: "Task",
    skills: [],
    tools: options.roleTools ?? tools,
    model: "test",
    memoryAccess: "none",
    delegationDepth: options.delegationDepth ?? 2,
  });
  if (role.kind !== "role-revision")
    return yield* Effect.die("Fixture decoded an invalid frozen role");
  const member = decodeRecord({
    ...common,
    kind: "member",
    recordId: "member",
    status: "active",
    name: "Member",
    coordinator: roleName === "coordinator",
    roleRevisionId: "role",
  });
  yield* repo.execute(
    decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "setup",
      expectedRevision: (yield* readCurrentState(sql, projectId)).revision,
      attribution,
      records: [role, member],
      committedAt: at,
    }),
  );
  const binding = yield* createManagedAssignment({
    taskId,
    recordId: "binding",
    attemptId: "attempt",
    commandId: "dispatch",
    providerInstanceId,
    threadId,
    status,
    role,
    configuration: {
      instructionsHash: "hash",
      toolIds: options.toolIds ?? options.roleTools ?? tools,
      skillIds: [],
      runtimeVersion: "test",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    ...(options.nativeSessionId === null
      ? {}
      : { sessionId: options.nativeSessionId ?? "native-pi-session" }),
  });
  const auth = yield* Authorization.ProjectTeamAuthorization;
  const issued =
    options.issueCredential === false
      ? undefined
      : yield* auth.issueCredential({ providerInstanceId, threadId });
  if (options.issueCredential !== false) expect(issued).toBeDefined();
  const managed =
    options.issueCredential === false
      ? {
          projectId,
          bindingId: binding.recordId,
          generation: binding.generation,
          providerInstanceId,
          threadId,
        }
      : issued!.credential;
  const principal = {
    actor: { kind: "agent" as const, id: Authorization.managedActorId(managed) },
    managed,
  };
  const change = Effect.fn("authorizationTest.change")(function* (record: ProjectTeamRecord) {
    const state = yield* repo.replay(projectId);
    yield* repo.execute(
      decodeCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "update-" + record.recordId + "-" + record.revision,
        expectedRevision: state.at(-1)!.revision,
        attribution,
        records: [record],
        committedAt: at,
      }),
    );
  });
  return { auth, repo, sql, principal, binding, role, member, change };
});
export const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.fresh(runtime)));

import { ProjectWorkGatewayLive } from "./ProjectWorkGateway.ts";
import { ProjectWorkSearchLive } from "./ProjectWorkSearch.ts";
import { ProjectWorkBriefingLive } from "./ProjectWorkBriefing.ts";
import { ProjectWorkNarrativeLive } from "./ProjectWorkNarrative.ts";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
const gatewayServices = Layer.mergeAll(
  Authorization.layer,
  ProjectWorkRepositoryLive,
  ProjectWorkQueryLive,
  ProjectWorkSearchLive,
  ProjectWorkNarrativeLive,
  ProjectWorkBriefingLive.pipe(Layer.provide(ProjectWorkQueryLive)),
);
export const gatewayRuntime = ProjectWorkGatewayLive.pipe(
  Layer.provideMerge(gatewayServices),
  Layer.provide(Layer.mock(EnvironmentAuth)({})),
  Layer.provideMerge(ServerSettings.layerTest({ projectWorkEnabled: true })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
