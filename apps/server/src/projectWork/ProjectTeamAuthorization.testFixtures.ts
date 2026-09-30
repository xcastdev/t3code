import { expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  ProviderInstanceId,
  ThreadId,
  ProjectTeamRecord,
  ProjectWorkFoundationCommitCommand,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import { ProjectWorkQueryLive } from "./ProjectWorkQuery.ts";
import { ProjectWorkRepository, ProjectWorkRepositoryLive } from "./ProjectWorkRepository.ts";

export const at = "2026-01-01T00:00:00.000Z";
export const projectId = ProjectId.make("authorization-project");
export const taskId = ProjectWorkTaskId.make("authorization-task");
export const threadId = ThreadId.make("authorization-thread");
export const providerInstanceId = ProviderInstanceId.make("pi");
export const decodeRecord = Schema.decodeUnknownSync(ProjectTeamRecord);
const decodeCommit = Schema.decodeUnknownSync(ProjectWorkFoundationCommitCommand);
export const attribution = {
  actor: { kind: "system", id: "scheduler" },
  source: { kind: "system", id: "scheduler" },
  recordedAt: at,
} as const;
export const runtime = Layer.mergeAll(
  Authorization.layer,
  ProjectWorkRepositoryLive,
  ProjectWorkQueryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory), Layer.provideMerge(NodeServices.layer));
export const seed = Effect.fn("authorizationTest.seed")(function* (
  roleName = "investigator",
  status = "running",
  options: {
    readonly roleTools?: ReadonlyArray<string>;
    readonly toolIds?: ReadonlyArray<string>;
    readonly nativeSessionId?: string | null;
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
  const criterionId = ProjectWorkCriterionId.make("criterion");
  yield* repo.execute({
    ...command,
    type: "project-work.criterion.upsert",
    commandId: CommandId.make("criterion"),
    criterion: {
      criterionId,
      taskId,
      description: "Requirement",
      required: false,
      status: "unsatisfied",
      satisfiedByEvidenceIds: [],
      revision: 0,
      updatedAt: at,
    },
    updatedAt: at,
  });
  yield* repo.execute({
    ...command,
    type: "project-work.task.specify",
    commandId: CommandId.make("spec"),
    specification: {
      objective: "Task",
      scopeIn: "Task",
      scopeOut: "Other tasks",
      criterionIds: [criterionId],
      revision: 1,
      protected: false,
    },
    updatedAt: at,
  });
  yield* repo.execute({
    ...command,
    type: "project-work.task.ready",
    commandId: CommandId.make("ready"),
    updatedAt: at,
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
    delegationDepth: 2,
  });
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
      expectedRevision: 4,
      attribution,
      records: [role, member],
      committedAt: at,
    }),
  );
  const binding = decodeRecord({
    ...common,
    kind: "run-binding",
    recordId: "binding",
    status,
    taskId,
    attemptId: "attempt",
    memberId: "member",
    roleRevisionId: "role",
    providerInstanceId,
    threadId,
    ...(options.nativeSessionId === null
      ? {}
      : { sessionId: options.nativeSessionId ?? "native-pi-session" }),
    environmentId: "environment",
    model: "test",
    configuration: {
      instructionsHash: "hash",
      toolIds: options.toolIds ?? tools,
      skillIds: [],
      runtimeVersion: "test",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    worktree: "/workspace",
    branch: "task",
    leaseGeneration: 0,
    specRevision: 1,
    planRevision: 0,
  });
  yield* repo.execute(
    decodeCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "dispatch",
      expectedRevision: 6,
      attribution,
      records: [binding],
      committedAt: at,
      claim: {
        ...command,
        type: "project-work.task.claim",
        commandId: "dispatch",
        attemptId: "attempt",
        leaseToken: "lease",
        leasedUntil: "2030-01-01T00:00:00.000Z",
        claimedAt: at,
      },
    }),
  );
  const auth = yield* Authorization.ProjectTeamAuthorization;
  const issued = yield* auth.issueCredential({ providerInstanceId, threadId });
  expect(issued).toBeDefined();
  const managed = issued!.credential;
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
