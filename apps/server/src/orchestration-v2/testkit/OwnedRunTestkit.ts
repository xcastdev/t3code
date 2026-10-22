import {
  CommandId,
  EnvironmentId,
  ProjectWorkAttemptId,
  ProjectWorkTaskId,
  RunId,
  type ModelSelection,
  type ProjectId,
  type ThreadId,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  appendAdmissionFoundationRecords,
  ProjectWorkRepository,
  ProjectWorkRepositoryLive,
  readCurrentState,
} from "../../projectWork/ProjectWorkRepository.ts";
import { projectTeamScopeHash } from "../../projectWork/ProjectTeamPolicy.ts";

/** Seed a prepared Work intent for an existing inert V2 thread. */
export const seedOwnedThreadWork = Effect.fn("OwnedRunTestkit.seedOwnedThreadWork")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
    readonly now: string;
  }) {
    const { projectId, threadId, modelSelection, now } = input;
    const taskId = ProjectWorkTaskId.make(`${threadId}:owned-task`);
    const sql = yield* SqlClient.SqlClient;
    yield* (yield* ProjectWorkRepository).execute({
      type: "project-work.task.create",
      commandId: CommandId.make(`${threadId}:task-create`),
      projectId,
      taskId,
      title: "Research",
      createdAt: now,
    });
    const state = yield* readCurrentState(sql, projectId);
    const common = { projectId, revision: 0, generation: 0, updatedAt: now };
    const records: Array<ProjectTeamRecord> = [
      {
        ...common,
        kind: "task-membership",
        recordId: `${threadId}:membership`,
        taskId,
        status: "active",
        executionKind: "managed",
        deliverableKind: "research",
        assignment: { authorizationGateId: `${threadId}:grant`, outputDescriptions: ["Findings"] },
      },
      {
        ...common,
        kind: "role-revision",
        recordId: `${threadId}:role`,
        roleId: "investigator",
        roleRevision: 0,
        status: "available",
        role: "investigator",
        instructions: "Read the code",
        skills: [],
        tools: ["read"],
        model: modelSelection.model,
        memoryAccess: "none",
        delegationDepth: 2,
      },
      {
        ...common,
        kind: "member",
        recordId: `${threadId}:member`,
        status: "active",
        name: "Investigator",
        coordinator: false,
        roleRevisionId: `${threadId}:role`,
      },
      {
        ...common,
        kind: "limits",
        recordId: `${threadId}:limits`,
        status: "configured",
        model: modelSelection.model,
        tokenLimit: 1000,
        durationLimitMs: 10000,
        delegationDepth: 2,
        repairAllowance: 1,
        environmentModelCalls: 3,
        modelCalls: 3,
        projectWritableWorkers: 1,
      },
    ];
    const hash = projectTeamScopeHash({ ...state, foundationRecords: records }, taskId);
    records.push({
      ...common,
      kind: "gate",
      recordId: `${threadId}:grant`,
      taskId,
      status: "consumed",
      gate: "investigation",
      specRevision: 0,
      planRevision: 0,
      contentHash: hash,
      evidenceIds: [],
      consumedByRunId: RunId.make(`${threadId}:binding`),
      consumedByCommandId: CommandId.make(`${threadId}:prepared`),
      attribution: {
        actor: { kind: "human", id: "human" },
        source: { kind: "web", id: "client" },
        recordedAt: now,
      },
    });
    records.push({
      ...common,
      kind: "run-binding",
      recordId: `${threadId}:binding`,
      taskId,
      status: "reserved",
      attemptId: ProjectWorkAttemptId.make(`${threadId}:attempt`),
      memberId: `${threadId}:member`,
      roleRevisionId: `${threadId}:role`,
      providerInstanceId: modelSelection.instanceId,
      threadId,
      environmentId: EnvironmentId.make("env"),
      model: modelSelection.model,
      configuration: {
        instructionsHash: "hash",
        toolIds: ["read"],
        skillIds: [],
        runtimeVersion: "native",
        maxTokens: 1000,
        maxDurationMs: 10000,
        paidFallback: false,
      },
      worktree: "/tmp/admission",
      branch: "main",
      leaseGeneration: 0,
      specRevision: 0,
      planRevision: 0,
      authorizationGateId: `${threadId}:grant`,
      scopeHash: hash,
    });
    yield* sql.withTransaction(
      appendAdmissionFoundationRecords(sql, projectId, `${threadId}:seed`, records, now),
    );
  },
  Effect.provide(ProjectWorkRepositoryLive),
);
