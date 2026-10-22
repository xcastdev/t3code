import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectWorkTaskId,
  type ProjectTeamDispatchIntent,
  type ProjectTeamRecord,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import { RepositoryIdentityResolver } from "../project/RepositoryIdentityResolver.ts";
import * as HostRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Runner from "../processRunner.ts";
import * as Config from "../config.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import type { makeHarness } from "./ProjectTeamDispatch.testkit.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Repository from "./ProjectWorkRepository.ts";
import { projectId, modelSelection } from "./ProjectTeamDispatch.testkit.ts";
import {
  projectTeamPlanHash,
  projectTeamScopeHash,
  projectTeamSpecificationHash,
} from "./ProjectTeamPolicy.ts";
export { projectId, modelSelection } from "./ProjectTeamDispatch.testkit.ts";
export const at = "2026-01-01T00:00:00.000Z";
export const attribution = {
  actor: { kind: "human" as const, id: "maintainer" },
  source: { kind: "web" as const, id: "client" },
  recordedAt: at,
};
export const seed = Effect.fn("DispatchIntegration.seed")(function* (
  workspace: ProjectTeamDispatchIntent["workspace"] = { type: "root" },
) {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* Repository.ProjectWorkRepository;
  yield* (yield* Projects.ProjectStoreV2).apply({
    sequence: 1,
    eventId: EventId.make("dispatch-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Dispatch project",
      workspaceRoot: "/repo",
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const rootTaskId = ProjectWorkTaskId.make("root");
  yield* repository.execute({
    type: "project-work.task.create",
    projectId,
    commandId: CommandId.make("root-create"),
    taskId: rootTaskId,
    title: "Investigate dispatch",
    createdAt: at,
  });
  let state = yield* Repository.readCurrentState(sql, projectId);
  yield* repository.execute({
    type: "project-work.foundation.commit",
    projectId,
    commandId: CommandId.make("investigate"),
    expectedRevision: state.revision,
    attribution,
    committedAt: at,
    records: [],
    guided: {
      intent: {
        type: "project-team.investigation.start",
        projectId,
        commandId: CommandId.make("investigate"),
        expectedRevision: state.revision,
        taskId: rootTaskId,
        expectedTaskRevision: state.tasks[0]!.revision,
        objective: "Investigate the cause",
        outputDescriptions: ["Evidence and findings"],
      },
    },
  });
  state = yield* Repository.readCurrentState(sql, projectId);
  const task = state.tasks.find((task) => task.taskId !== rootTaskId)!;
  const role = state.foundationRecords!.find((record) => record.kind === "role-revision");
  const grant = state.foundationRecords!.find(
    (record) => record.kind === "gate" && record.taskId === task.taskId,
  );
  if (role?.kind !== "role-revision" || grant?.kind !== "gate")
    return yield* Effect.die("Missing investigation records");
  const member: Extract<ProjectTeamRecord, { kind: "member" }> = {
    kind: "member",
    projectId,
    recordId: "investigator-member",
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "active",
    name: "Investigator",
    coordinator: false,
    roleRevisionId: role.recordId,
  };
  const plan = {
    kind: "plan-revision" as const,
    recordId: "fixture-plan",
    projectId,
    taskId: task.taskId,
    revision: 0,
    generation: 0,
    updatedAt: at,
    status: "proposed" as const,
    specRevision: task.specRevision,
    planRevision: 0,
    content: "Verify the investigation output",
    dependencyTaskIds: [],
    contentHash: projectTeamPlanHash({
      content: "Verify the investigation output",
      dependencyTaskIds: [],
    }),
  };
  yield* sql.withTransaction(
    Repository.appendAdmissionFoundationRecords(
      sql,
      projectId,
      "configure-workflow",
      [
        { ...role, revision: role.revision + 1, model: modelSelection.model, delegationDepth: 2 },
        member,
        plan,
        {
          ...grant,
          gate: "execution",
          revision: grant.revision + 1,
          contentHash: projectTeamScopeHash(state, task.taskId, plan),
        },
        {
          ...grant,
          recordId: "fixture-specification-gate",
          revision: 0,
          gate: "specification",
          contentHash: projectTeamSpecificationHash(state, task.taskId),
        },
        {
          ...grant,
          recordId: "fixture-plan-gate",
          revision: 0,
          gate: "plan",
          contentHash: plan.contentHash,
        },
      ],
      at,
    ),
  );
  state = yield* Repository.readCurrentState(sql, projectId);
  return {
    type: "project-team.dispatch",
    projectId,
    commandId: CommandId.make("dispatch-assignment"),
    expectedRevision: state.revision,
    taskId: task.taskId,
    expectedTaskRevision: task.revision,
    memberId: member.recordId,
    expectedMemberRevision: member.revision,
    authorizationGateId: grant.recordId,
    expectedGateRevision: grant.revision + 1,
    modelSelection,
    workspace,
  } satisfies ProjectTeamDispatchIntent;
});
export const inspect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const state = yield* Repository.readCurrentState(sql, projectId);
  const binding = state.foundationRecords!.find((record) => record.kind === "run-binding");
  if (binding?.kind !== "run-binding") return yield* Effect.die("Missing owned binding");
  const projection = yield* (yield* Threads.ThreadManagementService).getThreadProjection(
    binding.threadId,
  );
  return { sql, state, binding, projection };
});

export const awaitPreparation = Effect.gen(function* () {
  const { binding } = yield* inspect;
  const threads = yield* Threads.ThreadManagementService;
  const event = yield* threads
    .streamStoredEventsFrom({
      threadId: binding.threadId,
      afterSequence: 0,
      eventType: "run.updated",
    })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          ["starting", "failed"].includes(stored.event.payload.status),
      ),
      Stream.runHead,
    );
  assert.isTrue(Option.isSome(event));
  return yield* inspect;
});

export const runtimeExternalServices = (
  harness: ReturnType<typeof makeHarness>,
  runner: Layer.Layer<Runner.ProcessRunner> = Runner.layer.pipe(Layer.provide(NodeServices.layer)),
) =>
  Layer.mergeAll(
    harness.layerOrchestrator,
    Events.layer.pipe(Layer.provide(harness.layer)),
    NodeCrypto.layer,
    NodeServices.layer,
    Config.layerTest("/repo", { prefix: "t3-work-runtime-fixture-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    runner,
    Layer.mock(GitHubIssueApi.GitHubIssueApi)({}),
    Layer.mock(RepositoryIdentityResolver)({}),
    Layer.mock(HostRegistry.SourceControlProviderRegistry)({
      resolveLink: () => Effect.die("Host access is disabled in workflow fixtures"),
    }),
    Layer.mock(PullRequests.PullRequestService)({}),
    Layer.mock(Secrets.ServerSecretStore)({}),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Network access is disabled in workflow fixtures")),
    ),
  );
