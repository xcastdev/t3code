import * as TestClock from "effect/testing/TestClock";
import * as WorkRepository from "./ProjectWorkRepository.ts";
import * as GitHubIssueApi from "@t3tools/source-control-github/server/GitHubIssueApi";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProjectWorkBoundedReadEnvelope,
  ProjectTeamRecord,
  ProviderInstanceId,
  ProjectWorkTaskId,
  ProjectWorkCriterionId,
  type ProjectTeamConfigurationIntent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Gateway from "./ProjectWorkGateway.ts";
import * as Runtime from "./ProjectWorkRuntime.ts";
import { readCurrentState } from "./ProjectWorkRepository.ts";

const decodeTeamRecords = Schema.decodeUnknownEffect(Schema.Array(ProjectTeamRecord));
const decodeEnvelope = Schema.decodeUnknownEffect(ProjectWorkBoundedReadEnvelope);
const projectId = ProjectId.make("runtime-project");
const environmentId = EnvironmentId.make("runtime-environment");
const human: Gateway.ProjectWorkPrincipal = {
  environmentId,
  projectId,
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web", id: "client" },
};
const at = "2026-01-01T00:00:00.000Z";
const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused descriptor"),
});
const testLayer = Runtime.layer.pipe(
  Layer.provide(Layer.mock(GitHubIssueApi.GitHubIssueApi)({})),
  Layer.provide(Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({})),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(AuthSessions.layer),
  Layer.provide(environment),
  Layer.provideMerge(Sqlite.layerMemory),
);
const seed = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("runtime-project-created"),
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
      title: "Runtime",
      workspaceRoot: "/tmp/runtime-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const sessions = yield* AuthSessions.AuthSessionRepository;
  yield* sessions.create({
    sessionId: AuthSessionId.make("client"),
    subject: "maintainer",
    scopes: [AuthOrchestrationOperateScope],
    method: "browser-session-cookie",
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
    issuedAt: DateTime.makeUnsafe(at),
    expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
  });
  return yield* Gateway.ProjectWorkGateway;
});

const configuration: ProjectTeamConfigurationIntent = {
  type: "project-team.configure",
  commandId: CommandId.make("configure"),
  projectId,
  expectedRevision: 0,
  expectedConfigurationGeneration: 0,
  enabled: true,
  providerInstanceId: ProviderInstanceId.make("codex"),
  projectPriority: 3,
  taskPriorities: [],
  profiles: (
    ["coordinator", "investigator", "planner", "implementer", "reviewer", "integrator"] as const
  ).map((role) => ({
    role,
    instructions: "Follow approved scope",
    skills: [],
    tools: ["read"],
    model: "model",
    memoryAccess: "project",
    delegationDepth: 0,
  })),
  modelPolicies: [{ model: "model", tokenLimit: 8192, durationLimitMs: 60000, modelCalls: 2 }],
};
it.effect("configuration and reverse controls persist once and never assign or start work", () =>
  Effect.gen(function* () {
    const gateway = yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const enabled = yield* gateway.write(configuration, human);
    assert.deepStrictEqual(yield* gateway.write(configuration, human), enabled);
    const installed = yield* readCurrentState(sql, projectId);
    assert.equal(
      (installed.foundationRecords ?? []).filter((record) => record.kind === "member").length,
      6,
    );
    assert.deepStrictEqual(installed.tasks, []);
    assert.deepStrictEqual(installed.attempts, []);
    const records = yield* gateway.read({ projectId, operation: "foundation-records", limit: 128 });
    assert.equal((records as unknown[]).length, (installed.foundationRecords ?? []).length);
    const disabled = yield* gateway.write(
      {
        ...configuration,
        commandId: CommandId.make("disable"),
        expectedRevision: enabled.revision,
        expectedConfigurationGeneration: 1,
        enabled: false,
      },
      human,
    );
    assert.isAbove(disabled.revision, enabled.revision);
    const state = yield* readCurrentState(sql, projectId);
    assert.isTrue(
      (state.foundationRecords ?? [])
        .filter((record) => record.kind === "limits")
        .every((record) => record.status === "disabled"),
    );
    assert.deepStrictEqual(state.tasks, []);
    assert.deepStrictEqual(state.attempts, []);
    assert.equal((yield* Effect.result(gateway.write(configuration, human)))._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("team writes require the current stored human session, including retries", () =>
  Effect.gen(function* () {
    const gateway = yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* AuthSessions.AuthSessionRepository;
    assert.equal(
      (yield* Effect.result(
        gateway.write(configuration, { ...human, actor: { kind: "agent", id: "maintainer" } }),
      ))._tag,
      "Failure",
    );
    assert.equal(
      (yield* Effect.result(
        gateway.write(configuration, { ...human, actor: { kind: "human", id: "forged" } }),
      ))._tag,
      "Failure",
    );
    yield* sql`UPDATE auth_sessions SET scopes = ${JSON.stringify([])} WHERE session_id = ${"client"}`;
    assert.equal((yield* Effect.result(gateway.write(configuration, human)))._tag, "Failure");
    yield* sql`UPDATE auth_sessions SET scopes = ${JSON.stringify([AuthOrchestrationOperateScope])}, expires_at = ${"1970-01-01T00:00:00.000Z"} WHERE session_id = ${"client"}`;
    assert.equal((yield* Effect.result(gateway.write(configuration, human)))._tag, "Failure");
    yield* sql`UPDATE auth_sessions SET expires_at = ${"2100-01-01T00:00:00.000Z"} WHERE session_id = ${"client"}`;
    yield* gateway.write(configuration, human);
    yield* sessions.revoke({
      sessionId: AuthSessionId.make("client"),
      revokedAt: DateTime.makeUnsafe(at),
    });
    assert.equal((yield* Effect.result(gateway.write(configuration, human)))._tag, "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "guided approvals bind current revisions and can be explicitly invalidated without dispatch",
  () =>
    Effect.gen(function* () {
      const gateway = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const taskId = ProjectWorkTaskId.make("guided");
      yield* gateway.write(
        {
          type: "project-work.task.create",
          commandId: CommandId.make("capture-guided"),
          projectId,
          taskId,
          title: "Bounded work",
          createdAt: at,
        },
        human,
      );
      let state = yield* readCurrentState(sql, projectId);
      const criterionId = ProjectWorkCriterionId.make("guided-criterion");
      const propose = {
        type: "project-team.specification.propose" as const,
        commandId: CommandId.make("propose-guided"),
        projectId,
        taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        expectedSpecRevision: 0,
        specification: {
          objective: "Bounded objective",
          scopeIn: "One behavior",
          scopeOut: "Other behavior",
          criterionIds: [criterionId],
          revision: 1,
          protected: false,
        },
        criterionSnapshots: [
          {
            criterionId,
            taskId,
            description: "Behavior verified",
            required: true,
            status: "unsatisfied" as const,
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
        ],
      };
      assert.equal(
        (yield* Effect.result(
          gateway.write(propose, { ...human, actor: { kind: "agent", id: "agent" } }),
        ))._tag,
        "Failure",
      );
      yield* gateway.write(propose, human);
      state = yield* readCurrentState(sql, projectId);
      const gate = state.foundationRecords?.find(
        (record) => record.kind === "gate" && record.gate === "specification",
      );
      assert.isDefined(gate);
      if (gate?.kind !== "gate") throw new Error("Missing specification gate");
      const approve = {
        type: "project-team.gate.respond" as const,
        commandId: CommandId.make("approve-guided"),
        projectId,
        taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: state.tasks[0]!.revision,
        specRevision: 1,
        planRevision: 0,
        gateId: gate.recordId,
        expectedGateRevision: gate.revision,
        response: "approved" as const,
      };
      const approved = yield* gateway.write(approve, human);
      assert.deepStrictEqual(yield* gateway.write(approve, human), approved);
      const revoked = yield* gateway.write(
        {
          ...approve,
          commandId: CommandId.make("invalidate-guided"),
          expectedRevision: approved.revision,
          expectedGateRevision: gate.revision + 1,
          response: "invalidated",
        },
        human,
      );
      assert.isAbove(revoked.revision, approved.revision);
      assert.equal((yield* gateway.write(approve, human).pipe(Effect.flip)).reason, "rejected");
      state = yield* readCurrentState(sql, projectId);
      assert.deepStrictEqual(state.attempts, []);
      assert.isFalse(
        (state.foundationRecords ?? []).some((record) =>
          ["run-binding", "reservation", "effect", "dispatch"].includes(record.kind),
        ),
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "the issue identity RPC uses current human authority and returns sanitized discovery metadata",
  () => {
    let calls = 0;
    const identityLayer = Runtime.layer.pipe(
      Layer.provide(
        Layer.mock(GitHubIssueApi.GitHubIssueApi)({
          getAccount: () =>
            Effect.sync(() => {
              calls++;
              return {
                host: "github.com",
                accountId: "private-account-id",
                viewer: "maintainer",
                credentialFingerprint: "private-pin",
              };
            }),
          lookupRepository: () =>
            Effect.succeed({
              status: "changed",
              etag: null,
              data: {
                host: "github.com",
                nodeId: "repo-1",
                nameWithOwner: "owner/repo",
                url: "https://github.com/owner/repo",
                updatedAt: at,
              },
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () =>
            Effect.succeed({
              provider: "github",
              canonicalKey: "github.com/owner/repo",
              displayName: "owner/repo",
              locator: {
                source: "git-remote",
                remoteName: "origin",
                remoteUrl: "https://github.com/owner/repo.git",
              },
            }),
        }),
      ),
      Layer.provideMerge(ProjectStore.layer),
      Layer.provideMerge(AuthSessions.layer),
      Layer.provide(environment),
      Layer.provideMerge(Sqlite.layerMemory),
    );
    return Effect.gen(function* () {
      const gateway = yield* seed;
      const request = { operation: "identity" as const, input: { projectId } };
      const denied = yield* Effect.result(
        gateway.issue(request, { ...human, actor: { kind: "agent", id: "agent" } }),
      );
      assert.equal(denied._tag, "Failure");
      if (denied._tag === "Failure") assert.equal(denied.failure.reason, "forbidden");
      assert.equal(calls, 0);
      assert.deepStrictEqual(yield* gateway.issue(request, human), {
        host: "github.com",
        repositoryNodeId: "repo-1",
        repositoryName: "owner/repo",
        accountLogin: "maintainer",
      });
    }).pipe(Effect.provide(identityLayer));
  },
);

it.effect("foundation kind pages retain a complete filtered snapshot and bounded sentinel", () =>
  Effect.gen(function* () {
    const gateway = yield* seed;
    const configured = yield* gateway.write(configuration, human);
    const pages = yield* Effect.forEach([0, 2, 4], (offset) =>
      gateway
        .read(
          {
            projectId,
            operation: "foundation-records",
            recordKind: "member",
            limit: 2,
            offset,
            envelope: true,
          },
          human,
        )
        .pipe(Effect.flatMap(decodeEnvelope)),
    );
    assert.deepStrictEqual(
      pages.map((page) => page.revision),
      [configured.revision, configured.revision, configured.revision],
    );
    assert.deepStrictEqual(
      pages.map((page) => page.hasMore),
      [true, true, false],
    );
    assert.deepStrictEqual(
      pages.map((page) => page.items.length),
      [2, 2, 2],
    );
    const records = yield* decodeTeamRecords(pages.flatMap((page) => page.items));
    assert.equal(new Set(records.map((record) => record.recordId)).size, 6);
    assert.isTrue(records.every((record) => record.kind === "member"));
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "ordinary waiver revocation requires current human authority and authors durable provenance",
  () =>
    Effect.gen(function* () {
      const gateway = yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const taskId = ProjectWorkTaskId.make("ordinary-waiver-task");
      const criterionId = ProjectWorkCriterionId.make("ordinary-waiver-criterion");
      yield* gateway.write(
        {
          type: "project-work.task.create",
          commandId: CommandId.make("ordinary-create"),
          projectId,
          taskId,
          title: "Ordinary work",
          createdAt: at,
        },
        human,
      );
      yield* gateway.write(
        {
          type: "project-work.criterion.upsert",
          commandId: CommandId.make("ordinary-criterion"),
          projectId,
          taskId,
          criterion: {
            criterionId,
            taskId,
            description: "Observable result",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
          updatedAt: at,
        },
        human,
      );
      yield* gateway.write(
        {
          type: "project-work.task.specify",
          commandId: CommandId.make("ordinary-specify"),
          projectId,
          taskId,
          specification: {
            objective: "Bounded work",
            scopeIn: "One behavior",
            scopeOut: "Other behavior",
            criterionIds: [criterionId],
            revision: 1,
            protected: false,
          },
          updatedAt: at,
        },
        human,
      );
      yield* gateway.write(
        {
          type: "project-work.criterion.waive",
          commandId: CommandId.make("ordinary-waive"),
          projectId,
          taskId,
          criterionId,
          waiver: {
            reason: "Original waiver",
            evidenceIds: [],
            specRevision: 1,
            waivedAt: at,
            attribution: { actor: human.actor, source: human.source, recordedAt: at },
          },
          waivedAt: at,
        },
        human,
      );
      const state = yield* readCurrentState(sql, projectId);
      const task = state.tasks.find((task) => task.taskId === taskId)!;
      const criterion = state.criteria.find((criterion) => criterion.criterionId === criterionId)!;
      const command = {
        type: "project-work.criterion.revoke-waiver" as const,
        commandId: CommandId.make("ordinary-revoke"),
        projectId,
        taskId,
        criterionId,
        expectedRevision: state.revision,
        expectedTaskRevision: task.revision,
        expectedCriterionRevision: criterion.revision,
        expectedSpecRevision: task.specRevision,
        reason: "Restore the required check",
        revokedAt: at,
        attribution: {
          actor: { kind: "human" as const, id: "forged" },
          source: { kind: "web" as const, id: "forged" },
          recordedAt: at,
        },
      };
      const agent = {
        ...human,
        actor: { kind: "agent" as const, id: "agent" },
        source: { kind: "mcp" as const, id: "agent-session" },
      };
      assert.equal((yield* gateway.write(command, agent).pipe(Effect.flip)).reason, "forbidden");
      assert.equal(
        (yield* gateway
          .write(command, { ...human, actor: { kind: "human", id: "forged" } })
          .pipe(Effect.flip)).reason,
        "forbidden",
      );
      assert.equal(
        (yield* gateway
          .write({ ...command, expectedCriterionRevision: criterion.revision + 1 }, human)
          .pipe(Effect.flip)).reason,
        "rejected",
      );
      const revoked = yield* gateway.write(command, human);
      yield* TestClock.adjust(1000);
      assert.deepStrictEqual(yield* gateway.write(command, human), revoked);
      const current = yield* readCurrentState(sql, projectId);
      assert.equal(current.criteria[0]?.waiver, undefined);
      assert.equal(current.criteria[0]?.status, "unsatisfied");
      assert.equal(current.criteria[0]?.revision, criterion.revision + 1);
      assert.equal(current.tasks[0]?.revision, task.revision + 1);
      const repository = yield* WorkRepository.ProjectWorkRepository;
      const event = (yield* repository.replay(projectId)).find(
        (event) => event.type === "project-work.criterion.waiver-revoked",
      );
      if (event?.type !== "project-work.criterion.waiver-revoked")
        throw new Error("Missing revocation event");
      assert.deepStrictEqual(event.attribution.actor, human.actor);
      assert.deepStrictEqual(event.attribution.source, human.source);
      assert.equal(event.revokedAt, event.attribution.recordedAt);
      assert.notEqual(event.revokedAt, at);
      assert.equal(event.previousWaiver.reason, "Original waiver");
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.revoke({
        sessionId: AuthSessionId.make("client"),
        revokedAt: DateTime.makeUnsafe(at),
      });
      assert.equal((yield* gateway.write(command, human).pipe(Effect.flip)).reason, "forbidden");
    }).pipe(Effect.provide(testLayer)),
);
