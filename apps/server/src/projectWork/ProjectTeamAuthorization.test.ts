import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlConnection from "effect/unstable/sql/SqlConnection";
import * as TestClock from "effect/testing/TestClock";
import * as Context from "effect/Context";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { HttpServer } from "effect/unstable/http";
import {
  ProjectId,
  ProjectWorkTaskId,
  EnvironmentId,
  ThreadId,
  CommandId,
  ProjectWorkEvidenceId,
  ProjectWorkFoundationCommitCommand,
  ProjectTeamGuidedIntent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import {
  executePiProjectWorkBridgeTool,
  preparePiProjectWorkTools,
} from "../provider/pi/PiProjectWorkTools.ts";
import { ProjectWorkToolkit } from "../mcp/toolkits/projectWork/tools.ts";
import { ProjectWorkToolkitHandlersLive } from "../mcp/toolkits/projectWork/handlers.ts";

import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import {
  projectTeamSpecificationHash,
  projectTeamScopeHash,
  projectTeamDerivedRecordId,
} from "./ProjectTeamPolicy.ts";
import {
  seed,
  createManagedAssignment,
  restoreHistoricalBinding,
  scoped,
  decodeRecord,
  projectId,
  taskId,
  threadId,
  providerInstanceId,
  gatewayRuntime,
} from "./ProjectTeamAuthorization.testFixtures.ts";

it.effect(
  "records an authenticated agent human question and retains its exact request after answer",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("investigator");
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(f.sql, projectId);
      const task = before.tasks.find((entry) => entry.taskId === taskId)!;
      const gate = before.foundationRecords?.find(
        (entry) => entry.kind === "gate" && entry.recordId === f.binding.planGateId,
      );
      expect(gate?.kind).toBe("gate");
      if (gate?.kind !== "gate") return yield* Effect.die("Missing original plan gate");
      const request = {
        type: "project-team.question.request" as const,
        commandId: CommandId.make("agent-human-question"),
        projectId,
        taskId,
        expectedRevision: before.revision,
        expectedTaskRevision: task.revision,
        specRevision: task.specRevision,
        planRevision: f.binding.planRevision,
        questionId: "agent-decision-question",
        targetGateId: gate.recordId,
        expectedGateRevision: gate.revision,
        body: "Which implementation should preserve reconnect history?",
        choices: ["Preserve recorded history", "Request a revised plan"],
      };
      const source = { kind: "mcp" as const, id: "question-tool", uri: "mcp://original-question" };
      const principal = {
        ...f.principal,
        actor: { ...f.principal.actor, displayName: "Original worker" },
      };
      const receipt = yield* gateway.write(request, principal.actor, source, principal);
      const pending = yield* readCurrentState(f.sql, projectId);
      expect(
        pending.foundationRecords?.find((entry) => entry.recordId === request.questionId),
      ).toMatchObject({
        kind: "question",
        status: "pending",
        revision: 0,
        senderId: f.binding.memberId,
        generation: f.binding.generation,
        targetGateId: gate.recordId,
        targetRevision: gate.revision,
        body: request.body,
        choices: request.choices,
      });
      expect(pending.foundationRecords?.find((entry) => entry.recordId === gate.recordId)).toEqual(
        gate,
      );
      const answered = yield* gateway.write(
        {
          type: "project-team.question.answer",
          commandId: CommandId.make("human-question-answer"),
          projectId,
          taskId,
          expectedRevision: pending.revision,
          expectedTaskRevision: task.revision,
          specRevision: task.specRevision,
          planRevision: f.binding.planRevision,
          questionId: request.questionId,
          expectedQuestionRevision: 0,
          expectedGateRevision: gate.revision,
          answer: request.choices[0]!,
        },
        { kind: "human", id: "question-human" },
        { kind: "web", id: "second-device" },
      );
      expect(answered.receipt.eventCount).toBe(1);
      const after = yield* readCurrentState(f.sql, projectId);
      expect(
        after.foundationRecords?.find((entry) => entry.recordId === request.questionId),
      ).toMatchObject({
        status: "answered",
        revision: 1,
        answer: request.choices[0],
        answeredBy: {
          actor: { kind: "human", id: "question-human" },
          source: { kind: "web", id: "second-device" },
        },
      });
      expect(after.foundationRecords?.find((entry) => entry.recordId === gate.recordId)).toEqual(
        gate,
      );
      expect(yield* gateway.write(request, f.principal.actor, source, f.principal)).toEqual(
        receipt,
      );
      expect(
        yield* gateway.write(
          request,
          { ...principal.actor, displayName: "Renamed worker" },
          { ...source, uri: "mcp://reconnected-question" },
          { ...principal, actor: { ...principal.actor, displayName: "Renamed worker" } },
        ),
      ).toEqual(receipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(after);
    }).pipe(Effect.provide(gatewayRuntime)),
);

const encodeQuestionFixtureJSON = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeMessageFixtureCommit = Schema.decodeUnknownEffect(ProjectWorkFoundationCommitCommand);
const decodeMessageFixtureGuided = Schema.decodeUnknownEffect(ProjectTeamGuidedIntent);
const messageFixture = Effect.fn("messageTest.fixture")(function* () {
  const f = yield* seed("implementer");
  const gateway = yield* ProjectWorkGateway;
  const recipientTaskId = ProjectWorkTaskId.make("message-recipient-task");
  yield* f.change(
    decodeRecord({
      ...f.member,
      recordId: "message-recipient",
      coordinator: false,
      name: "Recipient",
    }),
  );
  const recipient = yield* createManagedAssignment({
    taskId: recipientTaskId,
    recordId: "message-recipient-binding",
    attemptId: "message-recipient-attempt",
    commandId: "message-recipient-claim",
    providerInstanceId: ProviderInstanceId.make("pi"),
    threadId: ThreadId.make("message-recipient-thread"),
    role: f.role,
    status: "running",
    configuration: f.binding.configuration,
    memberId: "message-recipient",
    sessionId: "message-recipient-session",
  });
  const state = yield* readCurrentState(f.sql, projectId);
  const memberships =
    state.foundationRecords?.filter(
      (r) => r.kind === "task-membership" && (r.taskId === taskId || r.taskId === recipientTaskId),
    ) ?? [];
  expect(memberships).toHaveLength(2);
  yield* f.repo.execute(
    yield* decodeMessageFixtureCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: "message-active-mission",
      expectedRevision: state.revision,
      committedAt: "2026-01-01T00:00:00.000Z",
      attribution: {
        actor: { kind: "human", id: "mission-human" },
        source: { kind: "web", id: "mission-browser" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
      records: [
        {
          kind: "mission",
          projectId,
          recordId: "message-mission",
          revision: 0,
          generation: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
          status: "active",
          title: "Shared approved mission",
          objective: "Exchange bounded informational updates",
          requiredTaskIds: [taskId, recipientTaskId],
        },
        ...memberships.map((r) => ({
          ...r,
          missionId: "message-mission",
          revision: r.revision + 1,
        })),
      ],
    }),
  );
  const before = yield* readCurrentState(f.sql, projectId);
  const task = before.tasks.find((t) => t.taskId === taskId)!;
  const membership = before.foundationRecords?.find(
    (r) => r.kind === "task-membership" && r.taskId === recipientTaskId,
  );
  if (membership?.kind !== "task-membership")
    return yield* Effect.die("Missing original recipient membership");
  return {
    ...f,
    gateway,
    recipient,
    before,
    membership,
    source: { kind: "mcp" as const, id: "message-tool" },
    request: {
      type: "project-team.message.send" as const,
      commandId: CommandId.make("bounded-team-message"),
      projectId,
      taskId,
      expectedRevision: before.revision,
      expectedTaskRevision: task.revision,
      specRevision: task.specRevision,
      planRevision: f.binding.planRevision,
      messageId: "bounded-team-message",
      recipientId: recipient.memberId,
      recipientTaskId,
      expectedRecipientMembershipRevision: membership.revision,
      body: "Keep the original reviewed commit in your comparison.",
      evidenceIds: [],
    },
  };
});

it.effect(
  "sends an authenticated informational message to an explicit active mission teammate",
  () =>
    Effect.gen(function* () {
      const f = yield* messageFixture();
      const addresses = yield* f.sql.withTransaction(
        f.auth.readMessageRecipientsInTransaction(f.principal),
      );
      expect(addresses).toEqual({
        recipients: [
          {
            memberId: f.recipient.memberId,
            taskId: f.recipient.taskId,
            taskTitle: "Bounded task",
            expectedRecipientMembershipRevision: f.membership.revision,
            relation: "active-mission",
          },
        ],
        omitted: 0,
        degraded: false,
      });
      const receipt = yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
      const after = yield* readCurrentState(f.sql, projectId);
      expect(
        after.foundationRecords?.find((r) => r.recordId === f.request.messageId),
      ).toMatchObject({
        kind: "message",
        status: "queued",
        senderId: f.binding.memberId,
        recipientId: f.recipient.memberId,
        taskId: f.recipient.taskId,
        missionId: "message-mission",
        generation: f.binding.generation,
        deliveryCursor: 0,
        deliveryGeneration: 0,
        body: f.request.body,
      });
      expect(after.foundationRecords?.filter((r) => r.kind === "gate")).toEqual(
        f.before.foundationRecords?.filter((r) => r.kind === "gate"),
      );
      expect(yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal)).toEqual(
        receipt,
      );
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(after);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);
it.effect("denies stale mission message targets without recording a message", () =>
  Effect.gen(function* () {
    const f = yield* messageFixture();
    for (const changed of [
      { recipientTaskId: taskId },
      { recipientId: f.binding.memberId, recipientTaskId: taskId },
      { expectedRecipientMembershipRevision: f.membership.revision + 1 },
      { specRevision: f.request.specRevision + 1 },
      { body: "   " },
    ]) {
      expect(
        yield* f.gateway
          .write({ ...f.request, ...changed }, f.principal.actor, f.source, f.principal)
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProjectTeamAuthorizationError" } });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.before);
    }
    const mission = f.before.foundationRecords?.find((r) => r.recordId === "message-mission");
    if (mission?.kind !== "mission") return yield* Effect.die("Missing authentic mission");
    yield* f.change(decodeRecord({ ...mission, status: "paused", revision: mission.revision + 1 }));
    const paused = yield* readCurrentState(f.sql, projectId);
    const addresses = yield* f.sql.withTransaction(
      f.auth.readMessageRecipientsInTransaction(f.principal),
    );
    expect(addresses).toEqual({ recipients: [], omitted: 1, degraded: true });
    expect(
      yield* f.gateway
        .write(
          { ...f.request, expectedRevision: paused.revision },
          f.principal.actor,
          f.source,
          f.principal,
        )
        .pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProjectTeamAuthorizationError" } });
    expect(yield* readCurrentState(f.sql, projectId)).toEqual(paused);
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

for (const taskState of ["blocked", "completed", "canceled"] as const)
  it.effect(`denies ${taskState} recipient tasks even with retained running bindings`, () =>
    Effect.gen(function* () {
      const f = yield* messageFixture();
      const targetIndex = f.before.tasks.findIndex((t) => t.taskId === f.recipient.taskId);
      expect(targetIndex).toBeGreaterThanOrEqual(0);
      // Corrupt only the current projection/checkpoint to isolate task eligibility from binding revocation.
      yield* f.sql`UPDATE project_work_tasks SET state=${taskState} WHERE project_id=${projectId} AND task_id=${f.recipient.taskId}`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${`$.tasks[${targetIndex}].state`},${taskState}) WHERE project_id=${projectId}`;
      const changed = yield* readCurrentState(f.sql, projectId);
      expect(changed.tasks.find((t) => t.taskId === f.recipient.taskId)?.state).toBe(taskState);
      expect(changed.foundationRecords?.find((r) => r.recordId === f.recipient.recordId)).toEqual(
        f.recipient,
      );
      expect(
        yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal)),
      ).toEqual({ recipients: [], omitted: 1, degraded: true });
      expect(
        yield* f.gateway
          .write(f.request, f.principal.actor, f.source, f.principal)
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProjectTeamAuthorizationError" } });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(changed);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
  );

it.effect(
  "requires the original SQL transaction and repository context for message compilation",
  () =>
    Effect.gen(function* () {
      const f = yield* messageFixture();
      const compile = f.auth.intent(
        f.principal,
        f.request,
        { actor: f.principal.actor, source: f.source, recordedAt: "2026-01-01T00:00:00.000Z" },
        false,
      );
      expect((yield* compile.pipe(Effect.result))._tag).toBe("Failure");
      yield* Effect.gen(function* () {
        const foreign = yield* SqlClient.SqlClient;
        expect(
          (yield* f.sql
            .withTransaction(compile.pipe(Effect.provideService(SqlClient.SqlClient, foreign)))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory({})));
      expect(
        (yield* f.sql
          .withTransaction(
            compile.pipe(
              Effect.updateContext((context: Context.Context<never>) =>
                Context.omit(ProjectWorkRepository)(context),
              ),
            ),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql.withTransaction(compile)).toMatchObject({
        type: "project-work.foundation.commit",
        records: [{ kind: "message", taskId: f.recipient.taskId }],
      });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.before);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "messages retain current sender evidence and deny foreign or stale scope references",
  () =>
    Effect.gen(function* () {
      const f = yield* messageFixture();
      const evidenceAt = "2026-01-01T00:00:00.000Z";
      for (const [id, owner, scopeHash] of [
        ["message-current-evidence", taskId, f.binding.scopeHash],
        ["message-foreign-evidence", f.recipient.taskId, f.recipient.scopeHash],
        ["message-stale-evidence", taskId, "obsolete-scope"],
      ] as const) {
        yield* f.repo.execute({
          type: "project-work.evidence.add",
          projectId,
          commandId: CommandId.make(id),
          addedAt: evidenceAt,
          evidence: {
            evidenceId: ProjectWorkEvidenceId.make(id),
            taskId: owner,
            kind: "observation",
            summary: "Retained informational reference",
            uri: "https://example.invalid/reference",
            ...(scopeHash === undefined ? {} : { scopeHash }),
            recordedAt: evidenceAt,
            revision: 0,
            attribution: {
              actor: { kind: "human", id: "reference-human" },
              source: { kind: "web", id: "reference-browser" },
              recordedAt: evidenceAt,
            },
          },
        });
      }
      const before = yield* readCurrentState(f.sql, projectId);
      for (const id of [
        "message-foreign-evidence",
        "message-stale-evidence",
        "message-missing-evidence",
      ]) {
        expect(
          yield* f.gateway
            .write(
              { ...f.request, expectedRevision: before.revision, evidenceIds: [id] },
              f.principal.actor,
              f.source,
              f.principal,
            )
            .pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ProjectTeamAuthorizationError",
            reason: "Message evidence is not applicable to its sender",
          },
        });
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
      }
      yield* f.gateway.write(
        {
          ...f.request,
          expectedRevision: before.revision,
          evidenceIds: ["message-current-evidence"],
        },
        f.principal.actor,
        f.source,
        f.principal,
      );
      expect(
        (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (r) => r.recordId === f.request.messageId,
        ),
      ).toMatchObject({
        kind: "message",
        evidenceIds: ["message-current-evidence"],
        taskId: f.recipient.taskId,
      });
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

const investigationRecipient = Effect.fn("messageTest.investigationRecipient")(function* (
  f: Effect.Success<ReturnType<typeof seed>>,
  parentTaskId: ProjectWorkTaskId,
  commandId: string,
  options: {
    readonly repository?: boolean;
    readonly issueRecordId?: string;
    readonly planning?: boolean;
  } = {},
) {
  const gateway = yield* ProjectWorkGateway;
  const before = yield* readCurrentState(f.sql, projectId);
  const parent = before.tasks.find((t) => t.taskId === parentTaskId);
  if (!parent) return yield* Effect.die("Missing actual investigation parent");
  const fields = {
    commandId: CommandId.make(commandId),
    projectId,
    taskId: parentTaskId,
    expectedRevision: before.revision,
    expectedTaskRevision: parent.revision,
    objective: "Inspect the original approved task",
    outputDescriptions: ["Retained findings"],
  };
  let intent: ProjectTeamGuidedIntent;
  if (options.planning) {
    const specificationGate = before.foundationRecords?.find(
      (r) => r.kind === "gate" && r.recordId === f.binding.specificationGateId,
    );
    const plan = before.foundationRecords?.find(
      (r) => r.kind === "plan-revision" && r.taskId === parentTaskId && r.status === "proposed",
    );
    const planGate = before.foundationRecords?.find(
      (r) => r.kind === "gate" && r.recordId === f.binding.planGateId,
    );
    if (
      specificationGate?.kind !== "gate" ||
      plan?.kind !== "plan-revision" ||
      planGate?.kind !== "gate"
    )
      return yield* Effect.die("Missing genuine parent specification and plan approvals");
    intent = yield* decodeMessageFixtureGuided({
      ...fields,
      type: "project-team.assignment.start",
      assignmentKind: "planning",
      specRevision: parent.specRevision,
      specificationGateId: specificationGate.recordId,
      expectedSpecificationGateRevision: specificationGate.revision,
      parentPlan: {
        recordId: plan.recordId,
        expectedRecordRevision: plan.revision,
        planRevision: plan.planRevision,
        gateId: planGate.recordId,
        expectedGateRevision: planGate.revision,
      },
    });
  } else {
    const issue = before.foundationRecords?.find(
      (r) => r.kind === "issue" && r.recordId === options.issueRecordId,
    );
    if (options.issueRecordId !== undefined && issue?.kind !== "issue")
      return yield* Effect.die("Missing actual retained issue target");
    intent = yield* decodeMessageFixtureGuided({
      ...fields,
      type: "project-team.investigation.start",
      ...(issue?.kind === "issue"
        ? { issueRecordId: issue.recordId, expectedIssueRevision: issue.revision }
        : {}),
    });
  }
  const human = {
    actor: { kind: "human" as const, id: "tree-human" },
    source: { kind: "web" as const, id: "tree-browser" },
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
  if (options.repository)
    yield* f.repo.execute(
      yield* decodeMessageFixtureCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId,
        expectedRevision: before.revision,
        attribution: human,
        committedAt: human.recordedAt,
        records: [],
        guided: { intent },
      }),
    );
  else yield* gateway.write(intent, human.actor, human.source);
  const issued = yield* readCurrentState(f.sql, projectId);
  const grant = issued.foundationRecords?.find(
    (r) =>
      r.kind === "gate" &&
      r.recordId ===
        projectTeamDerivedRecordId(commandId, options.planning ? "assignment" : "investigation"),
  );
  const role = issued.foundationRecords?.find(
    (r) =>
      r.kind === "role-revision" &&
      r.recordId === projectTeamDerivedRecordId(commandId, "investigator-role"),
  );
  if (grant?.kind !== "gate" || role?.kind !== "role-revision")
    return yield* Effect.die("Missing real investigation issuance");
  const child = issued.tasks.find((t) => t.taskId === grant.taskId);
  if (!child) return yield* Effect.die("Missing issued investigation child");
  const configuredRole = decodeRecord({
    ...role,
    recordId: `${commandId}:configured-role`,
    revision: 0,
    roleRevision: role.roleRevision + 1,
    model: "test",
  });
  if (configuredRole.kind !== "role-revision")
    return yield* Effect.die("Invalid configured readonly role");
  yield* f.change(configuredRole);
  const memberId = `${commandId}:member`;
  yield* f.change(
    decodeRecord({
      ...f.member,
      recordId: memberId,
      roleRevisionId: configuredRole.recordId,
      coordinator: false,
    }),
  );
  const current = yield* readCurrentState(f.sql, projectId);
  const reserved = decodeRecord({
    kind: "run-binding",
    projectId,
    recordId: `${commandId}:binding`,
    revision: 0,
    generation: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "reserved",
    taskId: child.taskId,
    attemptId: `${commandId}:attempt`,
    memberId,
    roleRevisionId: configuredRole.recordId,
    providerInstanceId,
    threadId: `${commandId}:thread`,
    sessionId: `${commandId}:session`,
    environmentId: "environment",
    model: configuredRole.model,
    configuration: {
      instructionsHash: "hash",
      toolIds: ["read"],
      skillIds: [],
      runtimeVersion: "test",
      maxTokens: 1000,
      maxDurationMs: 1000,
      paidFallback: false,
    },
    worktree: "/workspace",
    branch: "task",
    leaseGeneration: 0,
    specRevision: child.specRevision,
    planRevision: 0,
    authorizationGateId: grant.recordId,
    scopeHash: projectTeamScopeHash(current, child.taskId),
  });
  if (reserved.kind !== "run-binding")
    return yield* Effect.die("Invalid original readonly binding");
  yield* f.repo.execute(
    yield* decodeMessageFixtureCommit({
      type: "project-work.foundation.commit",
      projectId,
      commandId: `${commandId}:claim`,
      expectedRevision: current.revision,
      attribution: {
        actor: { kind: "system", id: "tree-scheduler" },
        source: { kind: "system", id: "tree-scheduler" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
      committedAt: "2026-01-01T00:00:00.000Z",
      records: [],
      transition: {
        kind: "claim",
        taskId: child.taskId,
        expectedTaskRevision: child.revision,
        authorizationGateId: grant.recordId,
        expectedGateRevision: grant.revision,
        binding: reserved,
        claim: {
          type: "project-work.task.claim",
          projectId,
          taskId: child.taskId,
          commandId: `${commandId}:claim`,
          attemptId: reserved.attemptId,
          leaseToken: `${commandId}:lease`,
          leasedUntil: "2030-01-01T00:00:00.000Z",
          claimedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    }),
  );
  const running = decodeRecord({ ...reserved, revision: 1, status: "running" });
  yield* f.change(running);
  if (running.kind !== "run-binding")
    return yield* Effect.die("Invalid running readonly recipient");
  return running;
});

it.effect(
  "messages a genuinely human-issued investigation child without granting readonly work tools",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer");
      const child = yield* investigationRecipient(f, taskId, "message-tree-child");
      const state = yield* readCurrentState(f.sql, projectId);
      const own = state.tasks.find((t) => t.taskId === taskId)!;
      const membership = state.foundationRecords?.find(
        (r) => r.kind === "task-membership" && r.taskId === child.taskId,
      );
      if (membership?.kind !== "task-membership")
        return yield* Effect.die("Missing authentic child membership");
      const addresses = yield* f.sql.withTransaction(
        f.auth.readMessageRecipientsInTransaction(f.principal),
      );
      expect(addresses.recipients).toEqual([
        {
          memberId: child.memberId,
          taskId: child.taskId,
          taskTitle: "Investigate: Task",
          expectedRecipientMembershipRevision: membership.revision,
          relation: "approved-tree",
        },
      ]);
      expect(child.configuration.toolIds).toEqual(["read"]);
      const gateway = yield* ProjectWorkGateway;
      yield* gateway.write(
        {
          type: "project-team.message.send",
          commandId: CommandId.make("message-tree-send"),
          projectId,
          taskId,
          expectedRevision: state.revision,
          expectedTaskRevision: own.revision,
          specRevision: own.specRevision,
          planRevision: f.binding.planRevision,
          messageId: "message-tree-send",
          recipientId: child.memberId,
          recipientTaskId: child.taskId,
          expectedRecipientMembershipRevision: membership.revision,
          body: "Return only sourced findings",
          evidenceIds: [],
        },
        f.principal.actor,
        { kind: "mcp", id: "tree-tool" },
        f.principal,
      );
      expect(
        (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (r) => r.recordId === "message-tree-send",
        ),
      ).toMatchObject({ status: "queued", taskId: child.taskId, recipientId: child.memberId });
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

for (const mode of [
  "Gateway issue-targeted investigation",
  "Repository issue-targeted investigation",
  "approved planning assignment",
] as const)
  it.effect(`messages an original ${mode} recipient without changing its readonly grants`, () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer");
      const id = mode.startsWith("Gateway")
        ? "gateway-issue-child"
        : mode.startsWith("Repository")
          ? "repository-issue-child"
          : "planning-child";
      if (mode !== "approved planning assignment")
        yield* f.change(
          decodeRecord({
            kind: "issue",
            projectId,
            recordId: `${id}:issue`,
            revision: 0,
            generation: 0,
            updatedAt: "2026-01-01T00:00:00.000Z",
            status: "open",
            identity: {
              host: "github.com",
              repositoryNodeId: "controlled-repository",
              issueNodeId: `${id}:node`,
              number: 1,
            },
            repositoryName: "controlled/repository",
            title: "Recorded issue",
            body: "Investigate this retained issue without remote access",
            sourceRevision: "original-issue",
            observedAt: "2026-01-01T00:00:00.000Z",
            taskId,
          }),
        );
      const child = yield* investigationRecipient(f, taskId, id, {
        ...(mode !== "approved planning assignment"
          ? { issueRecordId: `${id}:issue` }
          : { planning: true }),
        repository: mode.startsWith("Repository"),
      });
      const state = yield* readCurrentState(f.sql, projectId);
      const own = state.tasks.find((t) => t.taskId === taskId)!;
      const membership = state.foundationRecords?.find(
        (r) => r.kind === "task-membership" && r.taskId === child.taskId,
      );
      if (membership?.kind !== "task-membership")
        return yield* Effect.die("Missing original compatible recipient membership");
      expect(
        (yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal)))
          .recipients,
      ).toEqual([
        {
          memberId: child.memberId,
          taskId: child.taskId,
          taskTitle: mode === "approved planning assignment" ? "Plan: Task" : "Investigate: Task",
          expectedRecipientMembershipRevision: membership.revision,
          relation: "approved-tree",
        },
      ]);
      const gateway = yield* ProjectWorkGateway;
      yield* gateway.write(
        {
          type: "project-team.message.send",
          commandId: CommandId.make(`${id}:send`),
          projectId,
          taskId,
          expectedRevision: state.revision,
          expectedTaskRevision: own.revision,
          specRevision: own.specRevision,
          planRevision: f.binding.planRevision,
          messageId: `${id}:send`,
          recipientId: child.memberId,
          recipientTaskId: child.taskId,
          expectedRecipientMembershipRevision: membership.revision,
          body: "Share only information within the original approved task tree",
          evidenceIds: [],
        },
        f.principal.actor,
        { kind: "mcp", id: "compatible-tree-tool" },
        f.principal,
      );
      expect(
        (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (r) => r.recordId === `${id}:send`,
        ),
      ).toMatchObject({ status: "queued", taskId: child.taskId });
      expect(child.configuration.toolIds).toEqual(["read"]);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
  );

it.effect("approved tree messages remain eligible when a shared mission is paused", () =>
  Effect.gen(function* () {
    const f = yield* seed("implementer");
    const child = yield* investigationRecipient(f, taskId, "message-paused-tree");
    const gateway = yield* ProjectWorkGateway;
    const before = yield* readCurrentState(f.sql, projectId);
    const memberships =
      before.foundationRecords?.filter(
        (r) => r.kind === "task-membership" && (r.taskId === taskId || r.taskId === child.taskId),
      ) ?? [];
    expect(memberships).toHaveLength(2);
    yield* f.repo.execute(
      yield* decodeMessageFixtureCommit({
        type: "project-work.foundation.commit",
        projectId,
        commandId: "message-paused-tree-mission",
        expectedRevision: before.revision,
        committedAt: "2026-01-01T00:00:00.000Z",
        attribution: {
          actor: { kind: "human", id: "tree-human" },
          source: { kind: "web", id: "tree-browser" },
          recordedAt: "2026-01-01T00:00:00.000Z",
        },
        records: [
          {
            kind: "mission",
            projectId,
            recordId: "paused-tree-mission",
            revision: 0,
            generation: 0,
            updatedAt: "2026-01-01T00:00:00.000Z",
            status: "paused",
            title: "Paused shared mission",
            objective: "Retain the independently approved task tree",
            requiredTaskIds: [taskId, child.taskId],
          },
          ...memberships.map((r) => ({
            ...r,
            missionId: "paused-tree-mission",
            revision: r.revision + 1,
          })),
        ],
      }),
    );
    const state = yield* readCurrentState(f.sql, projectId);
    const own = state.tasks.find((t) => t.taskId === taskId)!;
    const membership = state.foundationRecords?.find(
      (r) => r.kind === "task-membership" && r.taskId === child.taskId,
    );
    if (membership?.kind !== "task-membership")
      return yield* Effect.die("Missing genuine paused-mission child membership");
    expect(
      (yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal)))
        .recipients,
    ).toEqual([
      {
        memberId: child.memberId,
        taskId: child.taskId,
        taskTitle: "Investigate: Task",
        expectedRecipientMembershipRevision: membership.revision,
        relation: "approved-tree",
      },
    ]);
    yield* gateway.write(
      {
        type: "project-team.message.send",
        commandId: CommandId.make("paused-mission-tree-send"),
        projectId,
        taskId,
        expectedRevision: state.revision,
        expectedTaskRevision: own.revision,
        specRevision: own.specRevision,
        planRevision: f.binding.planRevision,
        messageId: "paused-mission-tree-send",
        recipientId: child.memberId,
        recipientTaskId: child.taskId,
        expectedRecipientMembershipRevision: membership.revision,
        body: "Continue informational coordination within the approved task tree",
        evidenceIds: [],
      },
      f.principal.actor,
      { kind: "mcp", id: "tree-tool" },
      f.principal,
    );
    expect(
      (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
        (r) => r.recordId === "paused-mission-tree-send",
      ),
    ).toMatchObject({ status: "queued", taskId: child.taskId });
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect("does not turn human-approved readonly sibling investigations into send authority", () =>
  Effect.gen(function* () {
    const f = yield* seed("implementer");
    const parentTaskId = ProjectWorkTaskId.make("message-unapproved-parent");
    yield* f.repo.execute({
      type: "project-work.task.create",
      projectId,
      taskId: parentTaskId,
      commandId: CommandId.make("message-unapproved-parent"),
      title: "Unspecified investigation",
      createdAt: "2026-01-01T00:00:00.000Z",
      attribution: {
        actor: { kind: "human", id: "tree-human" },
        source: { kind: "web", id: "tree-browser" },
        recordedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const sender = yield* investigationRecipient(f, parentTaskId, "message-sibling-sender");
    const recipient = yield* investigationRecipient(f, parentTaskId, "message-sibling-recipient");
    const issued = yield* f.auth.issueCredential({
      providerInstanceId: sender.providerInstanceId,
      threadId: sender.threadId,
      bindingId: sender.recordId,
    });
    if (!issued) return yield* Effect.die("Missing original sibling credential");
    const principal = {
      actor: { kind: "agent" as const, id: Authorization.managedActorId(issued.credential) },
      managed: issued.credential,
    };
    const state = yield* readCurrentState(f.sql, projectId);
    const task = state.tasks.find((t) => t.taskId === sender.taskId)!;
    const membership = state.foundationRecords?.find(
      (r) => r.kind === "task-membership" && r.taskId === recipient.taskId,
    );
    if (membership?.kind !== "task-membership")
      return yield* Effect.die("Missing original sibling membership");
    expect(state.tasks.find((t) => t.taskId === parentTaskId)?.specification).toBeUndefined();
    expect(
      state.foundationRecords?.some(
        (r) => r.kind === "gate" && r.taskId === parentTaskId && r.status === "approved",
      ),
    ).toBe(false);
    expect(
      yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(principal)),
    ).toEqual({ recipients: [], omitted: 0, degraded: false });
    const gateway = yield* ProjectWorkGateway;
    expect(
      (yield* gateway
        .write(
          {
            type: "project-team.message.send",
            commandId: CommandId.make("sibling-message-send"),
            projectId,
            taskId: sender.taskId,
            expectedRevision: state.revision,
            expectedTaskRevision: task.revision,
            specRevision: task.specRevision,
            planRevision: sender.planRevision,
            messageId: "sibling-message-send",
            recipientId: recipient.memberId,
            recipientTaskId: recipient.taskId,
            expectedRecipientMembershipRevision: membership.revision,
            body: "Compare the independently approved investigation findings",
            evidenceIds: [],
          },
          principal.actor,
          { kind: "mcp", id: "sibling-tool" },
          principal,
        )
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(yield* readCurrentState(f.sql, projectId)).toEqual(state);
    expect(sender.configuration.toolIds).toEqual(["read"]);
    expect(recipient.configuration.toolIds).toEqual(["read"]);
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

for (const corruption of ["reparented", "cyclic"] as const)
  it.effect(`denies ${corruption} task lineage after a genuine child was discoverable`, () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer");
      const child = yield* investigationRecipient(f, taskId, `message-${corruption}-child`);
      expect(
        (yield* f.sql.withTransaction(
          f.auth.readMessageRecipientsInTransaction(f.principal),
        )).recipients.map((r) => r.taskId),
      ).toEqual([child.taskId]);
      const state = yield* readCurrentState(f.sql, projectId);
      const membership = state.foundationRecords?.find(
        (r) => r.kind === "task-membership" && r.taskId === child.taskId,
      );
      if (membership?.kind !== "task-membership")
        return yield* Effect.die("Missing current issued child");
      const parentTaskId = corruption === "cyclic" ? child.taskId : "unrelated-parent";
      const index =
        state.foundationRecords?.findIndex((r) => r.recordId === membership.recordId) ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
      // Ordinary foundation writes forbid reparenting. Alter only the disposable derived rows.
      yield* f.sql`UPDATE project_team_task_membership SET payload_json=json_set(payload_json,'$.parentTaskId',${parentTaskId}) WHERE project_id=${projectId} AND record_id=${membership.recordId}`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${`$.foundationRecords[${index}].parentTaskId`},${parentTaskId}) WHERE project_id=${projectId}`;
      const changed = yield* readCurrentState(f.sql, projectId);
      const altered = changed.foundationRecords?.find((r) => r.recordId === membership.recordId);
      expect(altered).toMatchObject({
        parentTaskId: corruption === "cyclic" ? child.taskId : "unrelated-parent",
      });
      expect(
        (yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal)))
          .recipients,
      ).toEqual([]);
      const own = changed.tasks.find((t) => t.taskId === taskId)!;
      const gateway = yield* ProjectWorkGateway;
      expect(
        (yield* gateway
          .write(
            {
              type: "project-team.message.send",
              commandId: CommandId.make(`message-${corruption}-send`),
              projectId,
              taskId,
              expectedRevision: changed.revision,
              expectedTaskRevision: own.revision,
              specRevision: own.specRevision,
              planRevision: f.binding.planRevision,
              messageId: `message-${corruption}-send`,
              recipientId: child.memberId,
              recipientTaskId: child.taskId,
              expectedRecipientMembershipRevision: membership.revision,
              body: "This altered lineage must not confer an address",
              evidenceIds: [],
            },
            f.principal.actor,
            { kind: "mcp", id: "tree-tool" },
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(changed);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
  );

it.effect(
  "denies original birth-parent substitution with an unchanged authenticated issuance receipt",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer");
      const originalParent = ProjectWorkTaskId.make("unrelated-original-parent");
      yield* f.repo.execute({
        type: "project-work.task.create",
        projectId,
        taskId: originalParent,
        commandId: CommandId.make("unrelated-original-parent"),
        title: "Unrelated original task",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const birthCommandId = "original-unrelated-child";
      const child = yield* investigationRecipient(f, originalParent, birthCommandId);
      expect(
        (yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal)))
          .recipients,
      ).toEqual([]);
      const before = yield* readCurrentState(f.sql, projectId);
      const index =
        before.foundationRecords?.findIndex(
          (r) => r.kind === "task-membership" && r.taskId === child.taskId,
        ) ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
      const membership = before.foundationRecords?.[index];
      if (membership?.kind !== "task-membership")
        return yield* Effect.die("Missing genuine unrelated child lineage");
      expect(membership.parentTaskId).toBe(originalParent);
      const receipt =
        yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${birthCommandId}`;
      expect(receipt).toHaveLength(1);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.parentTaskId',${taskId}) WHERE project_id=${projectId} AND command_id=${birthCommandId} AND json_extract(payload_json,'$.record.recordId')=${membership.recordId}`;
      yield* f.sql`UPDATE project_team_task_membership SET payload_json=json_set(payload_json,'$.parentTaskId',${taskId}) WHERE project_id=${projectId} AND record_id=${membership.recordId}`;
      yield* f.sql`UPDATE project_work_reducer_checkpoints SET state_json=json_set(state_json,${`$.foundationRecords[${index}].parentTaskId`},${taskId}) WHERE project_id=${projectId}`;
      const changed = yield* readCurrentState(f.sql, projectId);
      expect(changed.foundationRecords?.[index]).toMatchObject({ parentTaskId: taskId });
      expect(
        yield* f.sql`SELECT json_extract(payload_json,'$.record.parentTaskId') AS parent FROM project_work_events WHERE project_id=${projectId} AND command_id=${birthCommandId} AND json_extract(payload_json,'$.record.recordId')=${membership.recordId}`,
      ).toEqual([{ parent: taskId }]);
      expect(
        yield* f.sql`SELECT * FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${birthCommandId}`,
      ).toEqual(receipt);
      expect(
        (yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal)))
          .recipients,
      ).toEqual([]);
      const gateway = yield* ProjectWorkGateway;
      const own = changed.tasks.find((t) => t.taskId === taskId)!;
      expect(
        (yield* gateway
          .write(
            {
              type: "project-team.message.send",
              commandId: CommandId.make("forged-original-tree-send"),
              projectId,
              taskId,
              expectedRevision: changed.revision,
              expectedTaskRevision: own.revision,
              specRevision: own.specRevision,
              planRevision: f.binding.planRevision,
              messageId: "forged-original-tree-send",
              recipientId: child.memberId,
              recipientTaskId: child.taskId,
              expectedRecipientMembershipRevision: membership.revision,
              body: "A substituted birth must never grant an audience",
              evidenceIds: [],
            },
            f.principal.actor,
            { kind: "mcp", id: "tree-tool" },
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(changed);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

for (const status of ["delivered", "uncertain", "canceled"] as const)
  it.effect(`historical message retries preserve ${status} delivery after sender revocation`, () =>
    Effect.gen(function* () {
      const f = yield* messageFixture();
      const receipt = yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
      const state = yield* readCurrentState(f.sql, projectId);
      const message = state.foundationRecords?.find((r) => r.recordId === f.request.messageId);
      if (message?.kind !== "message") return yield* Effect.die("Missing original message");
      yield* f.change(
        decodeRecord({ ...message, status, revision: message.revision + 1, deliveryCursor: 1 }),
      );
      yield* f.change(
        decodeRecord({ ...f.binding, status: "revoked", revision: f.binding.revision + 1 }),
      );
      const changed = yield* readCurrentState(f.sql, projectId);
      expect(yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal)).toEqual(
        receipt,
      );
      const rebuilt = yield* Authorization.ProjectTeamAuthorization.pipe(
        Effect.provide(Layer.fresh(Authorization.layer)),
      );
      expect(
        yield* f.sql.withTransaction(
          rebuilt.intent(
            f.principal,
            f.request,
            { actor: f.principal.actor, source: f.source, recordedAt: "2026-01-03T00:00:00.000Z" },
            true,
          ),
        ),
      ).toMatchObject({
        type: "project-work.foundation.commit",
        records: [{ status: "queued", deliveryCursor: 0 }],
      });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(changed);
      for (const variation of [
        {
          input: { ...f.request, body: "Changed retained body" },
          principal: f.principal,
          source: f.source,
        },
        {
          input: f.request,
          principal: f.principal,
          source: { ...f.source, id: "foreign-message-tool" },
        },
        {
          input: f.request,
          source: f.source,
          principal: {
            ...f.principal,
            managed: { ...f.principal.managed, threadId: ThreadId.make("foreign-message-thread") },
          },
        },
      ])
        expect(
          (yield* f.gateway
            .write(
              variation.input,
              variation.principal.actor,
              variation.source,
              variation.principal,
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(changed);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
  );

it.effect("replies to the original incoming sender using an explicit current recipient task", () =>
  Effect.gen(function* () {
    const f = yield* messageFixture();
    yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
    const issued = yield* f.auth.issueCredential({
      providerInstanceId: f.recipient.providerInstanceId,
      threadId: f.recipient.threadId,
    });
    if (!issued) return yield* Effect.die("Missing actual reply authority");
    const principal = {
      actor: { kind: "agent" as const, id: Authorization.managedActorId(issued.credential) },
      managed: issued.credential,
    };
    const state = yield* readCurrentState(f.sql, projectId);
    const task = state.tasks.find((t) => t.taskId === f.recipient.taskId)!;
    const originalSenderMembership = state.foundationRecords?.find(
      (r) => r.kind === "task-membership" && r.taskId === taskId,
    );
    if (originalSenderMembership?.kind !== "task-membership")
      return yield* Effect.die("Missing original sender's current address");
    const request = {
      ...f.request,
      commandId: CommandId.make("message-explicit-reply"),
      messageId: "message-explicit-reply",
      taskId: f.recipient.taskId,
      expectedRevision: state.revision,
      expectedTaskRevision: task.revision,
      specRevision: task.specRevision,
      planRevision: f.recipient.planRevision,
      recipientId: f.binding.memberId,
      recipientTaskId: taskId,
      expectedRecipientMembershipRevision: originalSenderMembership.revision,
      replyTo: f.request.messageId,
      body: "I will compare the original committed tree",
    };
    for (const changed of [
      { replyTo: "missing-incoming" },
      { recipientTaskId: f.recipient.taskId },
      { recipientId: f.recipient.memberId },
    ]) {
      expect(
        (yield* f.gateway
          .write({ ...request, ...changed }, principal.actor, f.source, principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(state);
    }
    yield* f.gateway.write(request, principal.actor, f.source, principal);
    expect(
      (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
        (r) => r.recordId === request.messageId,
      ),
    ).toMatchObject({
      senderId: f.recipient.memberId,
      recipientId: f.binding.memberId,
      taskId,
      replyTo: f.request.messageId,
      status: "queued",
    });
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect("actual Pi and MCP write tools persist messages at the discovered recipient task", () =>
  Effect.gen(function* () {
    const f = yield* messageFixture();
    expect(
      preparePiProjectWorkTools({
        roleTools: f.role.tools,
        bindingTools: f.binding.configuration.toolIds,
      }).find((t) => t.tool.function.name === "project_work_write")?.tool.function.description,
    ).toContain("project-team.message.send");
    const pi = yield* executePiProjectWorkBridgeTool({
      toolName: "project_work_write",
      arguments: { intentJSON: yield* encodeQuestionFixtureJSON(f.request) },
      principal: f.principal,
      source: f.source,
    });
    expect(pi).toMatchObject({ receipt: { status: "accepted", eventCount: 1 } });
    const toolkit = yield* ProjectWorkToolkit.pipe(
      Effect.provide(
        ProjectWorkToolkitHandlersLive.pipe(
          Layer.provide(Layer.succeed(ProjectWorkGateway, f.gateway)),
        ),
      ),
    );
    const state = yield* readCurrentState(f.sql, projectId);
    const request = {
      ...f.request,
      commandId: CommandId.make("mcp-team-message"),
      messageId: "mcp-team-message",
      expectedRevision: state.revision,
      body: "Retain the comparison result",
    };
    yield* toolkit.handle("project_work_write", request).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provideService(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        providerInstanceId,
        threadId,
        providerSessionId: "message-tool-session",
        managed: f.principal.managed,
        capabilities: new Set(["project" as const]),
        issuedAt: 0,
      }),
    );
    const after = yield* readCurrentState(f.sql, projectId);
    for (const id of [f.request.messageId, request.messageId])
      expect(after.foundationRecords?.find((r) => r.recordId === id)).toMatchObject({
        kind: "message",
        senderId: f.binding.memberId,
        recipientId: f.recipient.memberId,
        taskId: f.recipient.taskId,
        status: "queued",
      });
    expect(after.foundationRecords?.filter((r) => r.kind === "gate")).toEqual(
      f.before.foundationRecords?.filter((r) => r.kind === "gate"),
    );
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

for (const missing of ["role", "binding"] as const)
  it.effect(`message sending requires the ${missing} frozen write grant`, () =>
    Effect.gen(function* () {
      const f = yield* messageFixture();
      const record = missing === "role" ? f.role : f.binding;
      const tools = (missing === "role" ? f.role.tools : f.binding.configuration.toolIds).filter(
        (tool) => tool !== "project-work.write",
      );
      const path = missing === "role" ? "$.record.tools" : "$.record.configuration.toolIds";
      const encoded = yield* encodeQuestionFixtureJSON(tools);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,${path},json(${encoded})) WHERE project_id=${projectId} AND json_extract(payload_json,'$.record.recordId')=${record.recordId}`;
      if (missing === "role")
        yield* f.sql`UPDATE project_team_role_revision SET payload_json=json_set(payload_json,'$.tools',json(${encoded})) WHERE project_id=${projectId} AND record_id=${record.recordId}`;
      else
        yield* f.sql`UPDATE project_team_run_binding SET payload_json=json_set(payload_json,'$.configuration.toolIds',json(${encoded})) WHERE project_id=${projectId} AND record_id=${record.recordId}`;
      yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
      const withdrawn = yield* readCurrentState(f.sql, projectId);
      expect(
        withdrawn.foundationRecords?.find((r) => r.recordId === record.recordId),
      ).toMatchObject(missing === "role" ? { tools } : { configuration: { toolIds: tools } });
      if (missing === "role")
        expect(
          yield* f.sql
            .withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal))
            .pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProjectTeamAuthorizationError" } });
      else
        expect(
          yield* f.sql.withTransaction(f.auth.readMessageRecipientsInTransaction(f.principal)),
        ).toEqual({ recipients: [], omitted: 0, degraded: false });
      expect(
        yield* f.gateway
          .write(f.request, f.principal.actor, f.source, f.principal)
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure", failure: { _tag: "ProjectTeamAuthorizationError" } });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(withdrawn);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
  );

for (const history of ["prefix", "command"] as const)
  it.effect(
    `message replay preflights oversized ${history} history before transferring event bodies`,
    () =>
      Effect.gen(function* () {
        const f = yield* messageFixture();
        yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
        const state = yield* readCurrentState(f.sql, projectId);
        if (history === "prefix") {
          yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.replayPadding',${"x".repeat(800000)}) WHERE project_id=${projectId} AND sequence < (SELECT MIN(sequence) FROM project_work_events WHERE project_id=${projectId} AND command_id=${f.request.commandId})`;
          const sizes = yield* f.sql<{
            bytes: number;
            maximum: number;
          }>`SELECT SUM(length(CAST(payload_json AS BLOB))) AS bytes,MAX(length(CAST(payload_json AS BLOB))) AS maximum FROM project_work_events WHERE project_id=${projectId} AND sequence < (SELECT MIN(sequence) FROM project_work_events WHERE project_id=${projectId} AND command_id=${f.request.commandId})`;
          expect(sizes[0]?.bytes).toBeGreaterThan(16777216);
          expect(sizes[0]?.maximum).toBeLessThan(1048576);
        } else {
          yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.replayPadding',${"x".repeat(1048577)}) WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
          const sizes = yield* f.sql<{
            maximum: number;
          }>`SELECT MAX(length(CAST(payload_json AS BLOB))) AS maximum FROM project_work_events WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
          expect(sizes[0]?.maximum).toBeGreaterThan(1048576);
        }
        let eventBodyReads = 0;
        let eventBodyBytes = 0;
        const result = yield* f.sql.withTransaction(
          Effect.gen(function* () {
            const transaction = yield* Effect.serviceOption(f.sql.transactionService);
            if (transaction._tag === "None")
              return yield* Effect.die("Missing original replay transaction");
            const [connection, depth] = transaction.value;
            const observed: SqlConnection.Connection = {
              ...connection,
              execute: (query, parameters, transform) =>
                connection.execute(query, parameters, transform).pipe(
                  Effect.tap((rows: ReadonlyArray<{ readonly payload?: unknown }>) => {
                    if (
                      query.includes("project_work_events") &&
                      query.includes("CASE WHEN length(CAST(payload_json AS BLOB)) <= 1048576") &&
                      query.includes(" AS payload") &&
                      parameters.some((parameter) => parameter === f.request.commandId)
                    ) {
                      eventBodyReads += 1;
                      for (const row of rows)
                        if (typeof row.payload === "string")
                          eventBodyBytes += Buffer.byteLength(row.payload, "utf8");
                    }
                    return Effect.void;
                  }),
                ),
            };
            return yield* f.gateway
              .write(f.request, f.principal.actor, f.source, f.principal)
              .pipe(
                Effect.provideService(f.sql.transactionService, [observed, depth]),
                Effect.result,
              );
          }),
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ProjectTeamAuthorizationError" },
        });
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(state);
        expect(eventBodyReads).toBe(0);
        expect(eventBodyBytes).toBe(0);
      }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
  );

it.effect("message replay denies corrupt or oversized original receipts and event bodies", () =>
  Effect.gen(function* () {
    const f = yield* messageFixture();
    const receipt = yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
    const state = yield* readCurrentState(f.sql, projectId);
    const original = yield* f.sql<{
      result: string;
      actor: string;
      at: string;
      events: string;
    }>`SELECT result_json AS result,actor_id AS actor,created_at AS at,event_ids_json AS events FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
    expect(original).toHaveLength(1);
    const row = original[0]!;
    for (const mutation of [
      f.sql`UPDATE project_work_command_receipts SET actor_id='foreign-worker' WHERE project_id=${projectId} AND command_id=${f.request.commandId}`,
      f.sql`UPDATE project_work_command_receipts SET created_at='2026-01-02T00:00:00.000Z' WHERE project_id=${projectId} AND command_id=${f.request.commandId}`,
      f.sql`UPDATE project_work_command_receipts SET event_ids_json='[]' WHERE project_id=${projectId} AND command_id=${f.request.commandId}`,
      f.sql`UPDATE project_work_command_receipts SET result_json=${"x".repeat(262145)} WHERE project_id=${projectId} AND command_id=${f.request.commandId}`,
    ]) {
      yield* mutation;
      expect(
        (yield* f.gateway
          .write(f.request, f.principal.actor, f.source, f.principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.sql`UPDATE project_work_command_receipts SET actor_id=${row.actor},created_at=${row.at},event_ids_json=${row.events},result_json=${row.result} WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
      expect(yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal)).toEqual(
        receipt,
      );
    }
    const events = yield* f.sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM project_work_events WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
    expect(events).toHaveLength(1);
    yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.body','Substituted original message') WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
    expect(
      (yield* f.gateway
        .write(f.request, f.principal.actor, f.source, f.principal)
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    yield* f.sql`UPDATE project_work_events SET payload_json=${events[0]!.payload} WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
    expect(yield* readCurrentState(f.sql, projectId)).toEqual(state);
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "failed owning message COMMIT remains private and its exact request succeeds after rollback",
  () =>
    Effect.gen(function* () {
      const f = yield* messageFixture();
      yield* f.sql`CREATE TEMP TABLE message_commit_parent (id INTEGER PRIMARY KEY)`;
      yield* f.sql`CREATE TEMP TABLE message_commit_child (id INTEGER REFERENCES message_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      const result = yield* f.repo
        .executeAtomic(
          Effect.gen(function* () {
            yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
            yield* f.sql`INSERT INTO message_commit_child (id) VALUES (1)`;
            return [];
          }),
        )
        .pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(
        (yield* f.gateway
          .read({ projectId, taskId: f.recipient.taskId, operation: "task-context" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.sql`ROLLBACK`;
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.before);
      expect(
        yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${f.request.commandId}`,
      ).toEqual([]);
      yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
      expect(
        (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (r) => r.recordId === f.request.messageId,
        ),
      ).toMatchObject({ status: "queued", deliveryCursor: 0 });
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

const questionFixture = Effect.fn("questionTest.fixture")(function* (
  options: {
    readonly roleTools?: readonly string[];
    readonly toolIds?: readonly string[];
  } = {},
) {
  const f = yield* seed("investigator", "running", options);
  const gateway = yield* ProjectWorkGateway;
  const before = yield* readCurrentState(f.sql, projectId);
  const task = before.tasks.find((entry) => entry.taskId === taskId)!;
  const gate = before.foundationRecords?.find(
    (entry) => entry.kind === "gate" && entry.recordId === f.binding.planGateId,
  );
  if (gate?.kind !== "gate") return yield* Effect.die("Missing original question gate");
  return {
    ...f,
    gateway,
    before,
    gate,
    request: {
      type: "project-team.question.request" as const,
      commandId: CommandId.make("bounded-question-request"),
      projectId,
      taskId,
      expectedRevision: before.revision,
      expectedTaskRevision: task.revision,
      specRevision: task.specRevision,
      planRevision: f.binding.planRevision,
      questionId: "bounded-question",
      targetGateId: gate.recordId,
      expectedGateRevision: gate.revision,
      body: "Which retained option should be used?",
      choices: ["Keep original", "Replace original"],
    },
    source: { kind: "mcp" as const, id: "question-test-tool" },
  };
});

it.effect("denies foreign or stale human-question requests without recording authority", () =>
  Effect.gen(function* () {
    const f = yield* questionFixture();
    for (const changed of [
      { taskId: ProjectWorkTaskId.make("foreign-task") },
      { targetGateId: "foreign-gate" },
      { expectedGateRevision: f.gate.revision + 1 },
      { expectedTaskRevision: f.request.expectedTaskRevision + 1 },
      { expectedRevision: f.before.revision + 1 },
      { specRevision: f.request.specRevision + 1 },
      { planRevision: f.request.planRevision + 1 },
      { body: "   " },
      { questionId: f.gate.recordId },
    ]) {
      expect(
        (yield* f.gateway
          .write({ ...f.request, ...changed }, f.principal.actor, f.source, f.principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.before);
    }
    for (const principal of [
      { actor: { kind: "human" as const, id: "human" } },
      { actor: f.principal.actor },
      { ...f.principal, actor: { kind: "agent" as const, id: "forged-agent" } },
      { ...f.principal, managed: { ...f.principal.managed, generation: f.binding.generation + 1 } },
    ]) {
      expect(
        (yield* f.gateway
          .write(f.request, principal.actor, f.source, principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }
    expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.before);
  }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

for (const missing of ["role", "binding"] as const)
  it.effect(`denies human-question request without frozen ${missing} write grant`, () =>
    Effect.gen(function* () {
      const f = yield* questionFixture();
      const record = missing === "role" ? f.role : f.binding;
      const path = missing === "role" ? "$.tools" : "$.configuration.toolIds";
      const tools = (missing === "role" ? f.role.tools : f.binding.configuration.toolIds).filter(
        (tool) => tool !== "project-work.write",
      );
      const encodedTools = yield* encodeQuestionFixtureJSON(tools);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,${"$.record" + path.slice(1)},json(${encodedTools}))
        WHERE project_id=${projectId} AND json_extract(payload_json,'$.record.recordId')=${record.recordId}
          AND json_extract(payload_json,'$.record.revision')=${record.revision}`;
      if (missing === "role")
        yield* f.sql`UPDATE project_team_role_revision SET payload_json=json_set(payload_json,${path},json(${encodedTools})) WHERE project_id=${projectId} AND record_id=${record.recordId}`;
      else
        yield* f.sql`UPDATE project_team_run_binding SET payload_json=json_set(payload_json,${path},json(${encodedTools})) WHERE project_id=${projectId} AND record_id=${record.recordId}`;
      yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
      const withdrawn = yield* readCurrentState(f.sql, projectId);
      const retained = withdrawn.foundationRecords?.find(
        (entry) => entry.recordId === record.recordId,
      );
      expect(retained).toMatchObject(
        missing === "role" ? { tools } : { configuration: { toolIds: tools } },
      );
      const outcome = yield* f.gateway
        .write(f.request, f.principal.actor, f.source, f.principal)
        .pipe(Effect.result);
      expect(outcome).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProjectTeamAuthorizationError" },
      });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(withdrawn);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
  );

it.effect(
  "audits original human-question events and receipt after scope drift without recreating pending",
  () =>
    Effect.gen(function* () {
      const f = yield* questionFixture();
      const original = yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
      yield* f.change(
        decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "revoked" }),
      );
      const changed = yield* readCurrentState(f.sql, projectId);
      expect(yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal)).toEqual(
        original,
      );
      const rebuilt = yield* Authorization.ProjectTeamAuthorization.pipe(
        Effect.provide(Layer.fresh(Authorization.layer)),
      );
      expect(
        yield* f.sql.withTransaction(
          rebuilt.intent(
            f.principal,
            f.request,
            {
              actor: f.principal.actor,
              source: f.source,
              recordedAt: "2026-01-03T00:00:00.000Z",
            },
            true,
          ),
        ),
      ).toMatchObject({
        type: "project-work.foundation.commit",
        records: [{ kind: "question", status: "pending" }],
      });
      expect(
        (yield* f.gateway
          .write(
            {
              ...f.request,
              commandId: CommandId.make("new-question-after-revoke"),
              questionId: "new-question",
            },
            f.principal.actor,
            f.source,
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      for (const principal of [
        {
          ...f.principal,
          managed: { ...f.principal.managed, generation: f.binding.generation + 1 },
        },
        {
          ...f.principal,
          managed: { ...f.principal.managed, threadId: ThreadId.make("foreign-thread") },
        },
      ])
        expect(
          (yield* f.gateway
            .write(f.request, principal.actor, f.source, principal)
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      const events = yield* f.sql<{
        payload: string;
      }>`SELECT payload_json AS payload FROM project_work_events WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
      expect(events).toHaveLength(1);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.body','Corrupt retained request') WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
      expect(
        (yield* f.gateway
          .write(f.request, f.principal.actor, f.source, f.principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.sql`UPDATE project_work_events SET payload_json=${events[0]!.payload} WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
      yield* f.sql`UPDATE project_work_command_receipts SET created_at='2026-01-02T00:00:00.000Z' WHERE project_id=${projectId} AND command_id=${f.request.commandId}`;
      expect(
        (yield* f.gateway
          .write(f.request, f.principal.actor, f.source, f.principal)
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(changed);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "retains one human question and one answer across competing devices without approving its gate",
  () =>
    Effect.gen(function* () {
      const f = yield* questionFixture();
      yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
      const pending = yield* readCurrentState(f.sql, projectId);
      expect(
        (yield* f.gateway
          .write(
            {
              ...f.request,
              commandId: CommandId.make("duplicate-question-identity"),
              expectedRevision: pending.revision,
            },
            f.principal.actor,
            f.source,
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const question = pending.foundationRecords?.find((r) => r.recordId === f.request.questionId);
      if (question?.kind !== "question")
        return yield* Effect.die("Missing original pending question");
      expect(
        (yield* f.gateway
          .write(
            {
              type: "project-work.foundation.commit",
              projectId,
              commandId: CommandId.make("raw-question-forgery"),
              expectedRevision: pending.revision,
              committedAt: "2026-01-01T00:00:00.000Z",
              attribution: {
                actor: f.principal.actor,
                source: f.source,
                recordedAt: "2026-01-01T00:00:00.000Z",
              },
              records: [decodeRecord({ ...question, recordId: "raw-question" })],
            },
            f.principal.actor,
            f.source,
            f.principal,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      const answer = {
        type: "project-team.question.answer" as const,
        commandId: CommandId.make("answer-device-one"),
        projectId,
        taskId,
        expectedRevision: pending.revision,
        expectedTaskRevision: f.request.expectedTaskRevision,
        specRevision: f.request.specRevision,
        planRevision: f.request.planRevision,
        questionId: question.recordId,
        expectedQuestionRevision: question.revision,
        expectedGateRevision: f.gate.revision,
        answer: "Keep original",
      };
      const first = yield* f.gateway.write(
        answer,
        { kind: "human", id: "answer-human" },
        { kind: "web", id: "device-one" },
      );
      const answered = yield* readCurrentState(f.sql, projectId);
      expect(
        yield* f.gateway
          .write(
            {
              ...answer,
              commandId: CommandId.make("answer-device-two"),
              expectedRevision: answered.revision,
              answer: "Replace original",
            },
            { kind: "human", id: "other-human" },
            { kind: "mobile", id: "device-two" },
          )
          .pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ProjectTeamAuthorizationError", reason: "Question target changed" },
      });
      expect(
        yield* f.gateway.write(
          answer,
          { kind: "human", id: "answer-human" },
          { kind: "web", id: "device-one" },
        ),
      ).toEqual(first);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(answered);
      expect(answered.foundationRecords?.find((r) => r.recordId === f.gate.recordId)).toEqual(
        f.gate,
      );
      expect(answered.tasks).toEqual(f.before.tasks);
      expect(
        answered.foundationRecords?.find((r) => r.recordId === question.recordId),
      ).toMatchObject({
        status: "answered",
        answer: "Keep original",
        answeredBy: { actor: { id: "answer-human" }, source: { id: "device-one" } },
      });
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "requires original SQL transaction and repository context for human-question compilation",
  () =>
    Effect.gen(function* () {
      const f = yield* questionFixture();
      const attribution = {
        actor: f.principal.actor,
        source: f.source,
        recordedAt: "2026-01-01T00:00:00.000Z",
      };
      const compile = f.auth.intent(f.principal, f.request, attribution, false);
      expect((yield* compile.pipe(Effect.result))._tag).toBe("Failure");
      yield* Effect.gen(function* () {
        const foreign = yield* SqlClient.SqlClient;
        expect(
          (yield* f.sql
            .withTransaction(compile.pipe(Effect.provideService(SqlClient.SqlClient, foreign)))
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory({})));
      expect(
        (yield* f.sql
          .withTransaction(
            compile.pipe(
              Effect.updateContext((context: Context.Context<never>) =>
                Context.omit(ProjectWorkRepository)(context),
              ),
            ),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* f.sql.withTransaction(compile)).toMatchObject({
        type: "project-work.foundation.commit",
        records: [{ kind: "question", senderId: f.binding.memberId }],
      });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.before);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "keeps a failed human-question COMMIT private and accepts its exact retry after rollback",
  () =>
    Effect.gen(function* () {
      const f = yield* questionFixture();
      yield* f.sql`CREATE TEMP TABLE question_commit_parent (id INTEGER PRIMARY KEY)`;
      yield* f.sql`CREATE TEMP TABLE question_commit_child (id INTEGER REFERENCES question_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      const outcome = yield* f.repo
        .executeAtomic(
          Effect.gen(function* () {
            yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
            yield* f.sql`INSERT INTO question_commit_child (id) VALUES (1)`;
            return [];
          }),
        )
        .pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(
        (yield* f.gateway
          .read({ projectId, taskId, operation: "task-context" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* f.sql`ROLLBACK`;
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(f.before);
      expect(
        yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${f.request.commandId}`,
      ).toEqual([]);
      yield* f.gateway.write(f.request, f.principal.actor, f.source, f.principal);
      expect(
        (yield* readCurrentState(f.sql, projectId)).foundationRecords?.find(
          (r) => r.recordId === f.request.questionId,
        ),
      ).toMatchObject({ kind: "question", status: "pending", revision: 0 });
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "records an authenticated guided human criterion waiver and invalidates the old scope",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer", "running", { issueCredential: false });
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(f.sql, projectId);
      const criterion = before.criteria[0]!;
      const task = before.tasks.find((entry) => entry.taskId === taskId)!;
      const input = {
        type: "project-team.criterion.waiver" as const,
        commandId: CommandId.make("human-guided-waiver"),
        projectId,
        taskId,
        expectedRevision: before.revision,
        expectedTaskRevision: task.revision,
        criterionId: criterion.criterionId,
        expectedCriterionRevision: criterion.revision,
        expectedSpecRevision: task.specRevision,
        expectedSpecificationHash: projectTeamSpecificationHash(before, taskId),
        action: { kind: "waive" as const, reason: "Human accepts this exception", evidenceIds: [] },
      };
      const actor = { kind: "human" as const, id: "waiver-human" };
      const source = { kind: "web" as const, id: "waiver-browser" };
      const agent = yield* gateway
        .write(input, f.principal.actor, source, f.principal)
        .pipe(Effect.result);
      expect(agent._tag).toBe("Failure");
      if (agent._tag === "Failure")
        expect(agent.failure).toMatchObject({
          _tag: "ProjectTeamAuthorizationError",
          reason: "Criterion waiver requires authenticated human authority",
        });
      const spoofed = yield* gateway
        .write(input, actor, source, { actor: { kind: "human", id: "another-human" } })
        .pipe(Effect.result);
      expect(spoofed._tag).toBe("Failure");
      if (spoofed._tag === "Failure")
        expect(spoofed.failure).toMatchObject({ reason: "spoofed-attribution" });
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
      const receipt = yield* gateway.write(input, actor, source);
      const after = yield* readCurrentState(f.sql, projectId);
      expect(
        after.criteria.find((entry) => entry.criterionId === criterion.criterionId),
      ).toMatchObject({
        status: "waived",
        revision: criterion.revision + 1,
        waiver: {
          reason: input.action.reason,
          specRevision: task.specRevision,
          attribution: { actor, source },
        },
      });
      expect(
        after.foundationRecords?.find((entry) => entry.recordId === f.binding.recordId),
      ).toMatchObject({ status: "stopping" });
      expect(
        after.foundationRecords?.filter(
          (entry) => entry.kind === "gate" && entry.status === "approved",
        ),
      ).toEqual([]);
      expect(
        after.foundationRecords?.filter(
          (entry) =>
            entry.kind === "gate" && entry.gate === "specification" && entry.status === "pending",
        ),
      ).toHaveLength(1);
      const pending = after.foundationRecords?.find(
        (entry) =>
          entry.kind === "gate" && entry.gate === "specification" && entry.status === "pending",
      );
      expect(pending).toMatchObject({ contentHash: projectTeamSpecificationHash(after, taskId) });
      for (const old of before.foundationRecords ?? []) {
        if (old.kind === "gate" && old.status === "approved")
          expect(
            after.foundationRecords?.find((entry) => entry.recordId === old.recordId),
          ).toMatchObject({ status: "invalidated", contentHash: old.contentHash });
      }
      expect(yield* gateway.write(input, actor, source)).toEqual(receipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(after);
      const revoke = {
        ...input,
        commandId: CommandId.make("human-revoke-waiver"),
        expectedRevision: after.revision,
        expectedCriterionRevision: criterion.revision + 1,
        expectedSpecificationHash: projectTeamSpecificationHash(after, taskId),
        action: { kind: "revoke" as const },
      };
      const revokedReceipt = yield* gateway.write(revoke, actor, source);
      const reversed = yield* readCurrentState(f.sql, projectId);
      expect(
        reversed.criteria.find((entry) => entry.criterionId === criterion.criterionId),
      ).toMatchObject({ status: "unsatisfied", revision: criterion.revision + 2 });
      expect(
        reversed.criteria.find((entry) => entry.criterionId === criterion.criterionId)?.waiver,
      ).toBeUndefined();
      expect(yield* gateway.write(input, actor, source)).toEqual(receipt);
      expect(yield* gateway.write(revoke, actor, source)).toEqual(revokedReceipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(reversed);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.contentHash',${"f".repeat(64)}) WHERE project_id=${projectId} AND command_id=${input.commandId} AND event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.recordId')=${pending!.recordId}`;
      const alteredGate = yield* gateway.write(input, actor, source).pipe(Effect.result);
      expect(alteredGate._tag).toBe("Failure");
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.record.contentHash',${projectTeamSpecificationHash(after, taskId)}) WHERE project_id=${projectId} AND command_id=${input.commandId} AND event_type='project-work.foundation.recorded' AND json_extract(payload_json,'$.record.recordId')=${pending!.recordId}`;
      const retainedRows = yield* f.sql<{
        eventId: string;
        payload: string;
        type: string;
        recordId: string | null;
      }>`
      SELECT event_id AS eventId, payload_json AS payload, event_type AS type,
        json_extract(payload_json,'$.record.recordId') AS recordId FROM project_work_events
      WHERE project_id=${projectId} AND command_id=${input.commandId} ORDER BY sequence ASC`;
      const originalGate = before.foundationRecords?.find(
        (entry) => entry.kind === "gate" && entry.status === "approved",
      );
      expect(originalGate).toBeDefined();
      for (const alteration of [
        {
          recordId: pending!.recordId,
          path: "$.record.attribution.actor.id",
          value: "different-human",
        },
        {
          recordId: originalGate!.recordId,
          path: "$.record.attribution.actor.id",
          value: "different-human",
        },
        {
          recordId: originalGate!.recordId,
          path: "$.record.recordId",
          value: "different-invalidated-gate",
        },
        { recordId: null, path: "$.waiver.attribution.actor.id", value: "different-human" },
        { recordId: null, path: "$.occurredAt", value: "2026-01-02T00:00:00.000Z" },
      ]) {
        const row = retainedRows.find((entry) =>
          alteration.recordId === null
            ? entry.type === "project-work.criterion.waived"
            : entry.recordId === alteration.recordId,
        );
        expect(row).toBeDefined();
        yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,${alteration.path},${alteration.value}) WHERE event_id=${row!.eventId}`;
        const altered = yield* gateway.write(input, actor, source).pipe(Effect.result);
        expect(altered._tag).toBe("Failure");
        if (altered._tag === "Failure")
          expect(altered.failure).toMatchObject({ reason: "Guided receipt target changed" });
        yield* f.sql`UPDATE project_work_events SET payload_json=${row!.payload} WHERE event_id=${row!.eventId}`;
      }
      expect(yield* gateway.write(input, actor, source)).toEqual(receipt);
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(reversed);
      yield* f.sql`UPDATE project_work_events SET payload_json=json_set(payload_json,'$.waiver.reason','corrupted reason') WHERE project_id=${projectId} AND command_id=${input.commandId} AND event_type='project-work.criterion.waived'`;
      const corrupt = yield* gateway.write(input, actor, source).pipe(Effect.result);
      expect(corrupt._tag).toBe("Failure");
      if (corrupt._tag === "Failure")
        expect(corrupt.failure).toMatchObject({ reason: "Guided receipt target changed" });
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "accepts retained summary-only waiver evidence and rejects stale or foreign guided targets",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer", "running", { issueCredential: false });
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(f.sql, projectId);
      const criterion = before.criteria[0]!;
      const task = before.tasks.find((entry) => entry.taskId === taskId)!;
      const evidenceId = ProjectWorkEvidenceId.make("waiver-reference");
      yield* f.repo.execute({
        type: "project-work.evidence.add",
        projectId,
        commandId: CommandId.make("waiver-reference"),
        addedAt: "2026-01-01T00:00:00.000Z",
        evidence: {
          evidenceId,
          taskId,
          criterionId: criterion.criterionId,
          kind: "observation",
          summary: "Retained explanation",
          uri: "https://example.invalid/exception",
          scopeHash: projectTeamScopeHash(
            before,
            taskId,
            before.foundationRecords?.find((entry) => entry.kind === "plan-revision"),
          ),
          recordedAt: "2026-01-01T00:00:00.000Z",
          revision: 0,
          attribution: {
            actor: { kind: "human", id: "waiver-human" },
            source: { kind: "web", id: "waiver-browser" },
            recordedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      });
      const current = yield* readCurrentState(f.sql, projectId);
      const input = {
        type: "project-team.criterion.waiver" as const,
        commandId: CommandId.make("reference-waiver"),
        projectId,
        taskId,
        expectedRevision: current.revision,
        expectedTaskRevision: task.revision,
        criterionId: criterion.criterionId,
        expectedCriterionRevision: criterion.revision,
        expectedSpecRevision: task.specRevision,
        expectedSpecificationHash: projectTeamSpecificationHash(current, taskId),
        action: { kind: "waive" as const, reason: "Recorded exception", evidenceIds: [evidenceId] },
      };
      const actor = { kind: "human" as const, id: "waiver-human" };
      const source = { kind: "web" as const, id: "waiver-browser" };
      for (const changed of [
        { expectedCriterionRevision: criterion.revision + 1 },
        { expectedSpecRevision: task.specRevision + 1 },
        { expectedSpecificationHash: "b".repeat(64) },
        { taskId: ProjectWorkTaskId.make("another-task") },
        {
          action: {
            ...input.action,
            evidenceIds: [ProjectWorkEvidenceId.make("missing-evidence")],
          },
        },
      ]) {
        expect(
          (yield* gateway.write({ ...input, ...changed }, actor, source).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* readCurrentState(f.sql, projectId)).toEqual(current);
      }
      yield* gateway.write(input, actor, source);
      const waived = yield* readCurrentState(f.sql, projectId);
      expect(waived.criteria[0]?.waiver?.evidenceIds).toEqual([evidenceId]);
      expect(waived.evidence).toEqual(current.evidence);
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "rolls back a guided waiver when its owning SQL commit fails before accepting retry",
  () =>
    Effect.gen(function* () {
      const f = yield* seed("implementer", "running", { issueCredential: false });
      const gateway = yield* ProjectWorkGateway;
      const before = yield* readCurrentState(f.sql, projectId);
      const criterion = before.criteria[0]!;
      const task = before.tasks.find((entry) => entry.taskId === taskId)!;
      const input = {
        type: "project-team.criterion.waiver" as const,
        commandId: CommandId.make("commit-waiver"),
        projectId,
        taskId,
        expectedRevision: before.revision,
        expectedTaskRevision: task.revision,
        criterionId: criterion.criterionId,
        expectedCriterionRevision: criterion.revision,
        expectedSpecRevision: task.specRevision,
        expectedSpecificationHash: projectTeamSpecificationHash(before, taskId),
        action: { kind: "waive" as const, reason: "Commit-bound exception", evidenceIds: [] },
      };
      const actor = { kind: "human" as const, id: "waiver-human" };
      const source = { kind: "web" as const, id: "waiver-browser" };
      yield* f.sql`CREATE TEMP TABLE waiver_commit_parent (id INTEGER PRIMARY KEY)`;
      yield* f.sql`CREATE TEMP TABLE waiver_commit_child (id INTEGER REFERENCES waiver_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)`;
      const outcome = yield* f.repo
        .executeAtomic(
          Effect.gen(function* () {
            yield* gateway.write(input, actor, source);
            yield* f.sql`INSERT INTO waiver_commit_child (id) VALUES (1)`;
            return [];
          }),
        )
        .pipe(Effect.exit);
      expect(outcome._tag).toBe("Failure");
      expect(
        (yield* gateway.read({ projectId, taskId, operation: "task-context" }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      yield* f.sql`ROLLBACK`;
      expect(yield* readCurrentState(f.sql, projectId)).toEqual(before);
      expect(
        yield* f.sql`SELECT command_id FROM project_work_command_receipts WHERE project_id=${projectId} AND command_id=${input.commandId}`,
      ).toEqual([]);
      yield* gateway.write(input, actor, source);
      expect((yield* readCurrentState(f.sql, projectId)).criteria[0]?.status).toBe("waived");
    }).pipe(Effect.provide(Layer.fresh(gatewayRuntime))),
);

it.effect(
  "checks actual durable authority beyond public page bounds and rejects frozen-role operational grants",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* seed();
        expect(yield* f.auth.resolve(f.principal)).toBeDefined();
        expect((yield* f.auth.capability(f.principal, "terminal").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* f.auth.capability(f.principal, "pull-requests").pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* f.auth.read(f.principal, { projectId, taskId, operation: "task-context" });
        for (const input of [
          { projectId: ProjectId.make("other"), taskId, operation: "task" as const },
          { projectId, taskId: ProjectWorkTaskId.make("other-task"), operation: "task" as const },
          { projectId, operation: "foundation-records" as const },
        ])
          expect((yield* f.auth.read(f.principal, input).pipe(Effect.result))._tag).toBe("Failure");
        const newer = decodeRecord({ ...f.role, recordId: "new-role", roleRevision: 2 });
        yield* f.change(newer);
        yield* f.change(decodeRecord({ ...f.member, revision: 1, roleRevisionId: "new-role" }));
        expect(yield* f.auth.resolve(f.principal)).toMatchObject({
          role: { recordId: "role", roleRevision: 1 },
        });
        yield* f.change(
          decodeRecord({ ...f.member, revision: 2, roleRevisionId: "new-role", status: "paused" }),
        );
        expect((yield* f.auth.resolve(f.principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);

for (const status of [
  "retired",
  "revoked",
  "stopping",
  "settled",
  "quarantined",
  "expired",
  "deleted",
  "generation",
] as const)
  it.effect(`rejects managed credential after ${status}`, () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* seed("implementer");
        if (status === "retired")
          yield* f.change(decodeRecord({ ...f.role, revision: 1, status: "retired" }));
        else if (status === "expired")
          yield* TestClock.setTime(Date.parse("2031-01-01T00:00:00.000Z"));
        else if (status === "deleted") {
          yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        } else if (status === "generation")
          expect(
            (yield* f.auth
              .resolve({ ...f.principal, managed: { ...f.principal.managed, generation: 1 } })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        else if (status === "settled") {
          const historical = decodeRecord({
            ...f.binding,
            revision: f.binding.revision + 1,
            status,
          });
          expect((yield* f.change(historical).pipe(Effect.result))._tag).toBe("Failure");
          yield* restoreHistoricalBinding(historical);
        } else
          yield* f.change(decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status }));
        if (status !== "generation")
          expect((yield* f.auth.resolve(f.principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
  );

it.effect(
  "mints reserved credentials without tool authority, preserves native identity and does not upgrade legacy tokens",
  () =>
    scoped(
      Effect.gen(function* () {
        const auth = yield* Authorization.ProjectTeamAuthorization;
        const makeRegistry = Registry.__testing.make({ now: () => 1000 }).pipe(
          Effect.provideService(
            HttpServer.HttpServer,
            HttpServer.HttpServer.of({
              address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
              serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
            }),
          ),
          Effect.provideService(
            Environment.ServerEnvironment,
            Environment.ServerEnvironment.of({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
              getDescriptor: Effect.die("unused"),
            }),
          ),
        );
        const registry = yield* makeRegistry;
        // Tables exist before managed history discovery; no managed run is present.
        yield* runMigrations();
        const legacy = yield* registry.issue({
          providerInstanceId,
          threadId,
          capabilities: new Set(["terminal", "pull-requests"]),
        });
        const legacyToken = legacy.config.authorizationHeader.replace("Bearer ", "");
        const untouchedLegacy = yield* registry.issue({ providerInstanceId, threadId });
        const untouchedToken = untouchedLegacy.config.authorizationHeader.replace("Bearer ", "");
        const heldLegacyScope = yield* registry.resolve(legacyToken);
        expect(heldLegacyScope).toBeDefined();
        const f = yield* seed("implementer", "reserved");
        expect(yield* registry.resolve(legacyToken)).toBeUndefined();
        const issued = yield* registry.issue({
          providerInstanceId,
          threadId,
          capabilities: new Set(["terminal", "pull-requests"]),
        });
        const token = issued.config.authorizationHeader.replace("Bearer ", "");
        expect(issued.config.providerSessionId).not.toBe("native-pi-session");
        expect(yield* registry.resolve(token)).toBeUndefined();
        yield* f.change(
          decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "running" }),
        );
        const scope = yield* registry.resolve(token);
        expect(scope?.managed).toEqual(f.principal.managed);
        expect(yield* registry.resolve(untouchedToken)).toBeUndefined();
        expect(
          (yield* Invocation.requireMcpCapability("terminal").pipe(
            Effect.provideService(Invocation.McpInvocationContext, heldLegacyScope!),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(yield* auth.resolve(f.principal)).toBeDefined();
        yield* f.change(
          decodeRecord({ ...f.binding, revision: f.binding.revision + 2, status: "revoked" }),
        );
        yield* registry.touch(threadId);
        expect(yield* registry.resolve(token)).toBeUndefined();
        yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        const restartedRegistry = yield* makeRegistry;
        expect(yield* restartedRegistry.resolve(token)).toBeUndefined();
        expect(yield* registry.resolve(untouchedToken)).toBeUndefined();
        expect(
          (yield* Invocation.requireMcpCapability("terminal").pipe(
            Effect.provideService(Invocation.McpInvocationContext, heldLegacyScope!),
            Effect.result,
          ))._tag,
        ).toBe("Failure");
        expect(
          (yield* registry.issue({ providerInstanceId, threadId }).pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    ),
);

it.effect("permits bounded coordinator discovery while rejecting memory/config collections", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed("coordinator");
      yield* f.auth.read(f.principal, { projectId, operation: "tasks", limit: 10 });
      yield* f.auth.read(f.principal, {
        projectId,
        operation: "foundation-records",
        recordKinds: ["member", "message"],
        limit: 10,
      });
      for (const kinds of [["memory-source"], ["role-revision"], ["effect"]])
        expect(
          (yield* f.auth
            .read(f.principal, {
              projectId,
              operation: "foundation-records",
              recordKinds: kinds,
              limit: 10,
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
    }),
  ),
);

it.effect("uses complete indexed binding authority beyond the 128-record public page", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed();
      for (let i = 0; i < 130; i++)
        yield* f.change(
          decodeRecord({
            ...f.role,
            recordId: "aaa-role-" + i.toString().padStart(3, "0"),
            roleId: "unrelated-role-" + i,
          }),
        );
      const query = yield* ProjectWorkQuery;
      const page = yield* query.listFoundationRecords({
        projectId,
        kinds: ["role-revision", "run-binding"],
        limit: 128,
      });
      expect(page.items).toHaveLength(128);
      expect(page.items.some((record) => record.recordId === "binding")).toBe(false);
      expect(yield* f.auth.resolve(f.principal)).toMatchObject({
        binding: { recordId: "binding" },
      });
      const plan =
        yield* f.sql`EXPLAIN QUERY PLAN SELECT project_id FROM project_team_run_binding WHERE provider_instance_id=${providerInstanceId} AND thread_id=${threadId}`;
      expect(plan.some((row) => String(row.detail).includes("project_team_binding_session"))).toBe(
        true,
      );
    }),
  ),
);

it.effect(
  "reserved issuance may omit native session but running invocation fails closed without it",
  () =>
    scoped(
      Effect.gen(function* () {
        const f = yield* seed("implementer", "reserved", { nativeSessionId: null });
        expect(
          (yield* f.auth.issueCredential({ providerInstanceId, threadId }))?.credential,
        ).toEqual(f.principal.managed);
        yield* f.change(
          decodeRecord({ ...f.binding, revision: f.binding.revision + 1, status: "running" }),
        );
        expect((yield* f.auth.resolve(f.principal).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ),
);
it.effect("denies ambiguous reserved issuance and never refreshes a supplied stale marker", () =>
  scoped(
    Effect.gen(function* () {
      const f = yield* seed("implementer", "reserved");
      const otherTask = ProjectWorkTaskId.make("other-task");
      yield* createManagedAssignment({
        taskId: otherTask,
        recordId: "other-binding",
        attemptId: "other-attempt",
        commandId: "other-claim",
        providerInstanceId,
        threadId,
        role: f.role,
        status: "reserved",
        configuration: f.binding.configuration,
      });
      expect(
        (yield* f.auth.issueCredential({ providerInstanceId, threadId }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* f.auth.issueCredential({ providerInstanceId, threadId, bindingId: "binding" }))
          ?.credential,
      ).toEqual(f.principal.managed);
      expect(
        (yield* f.auth
          .resolve({
            ...f.principal,
            managed: { ...f.principal.managed, bindingId: "other-binding", generation: 1 },
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }),
  ),
);

import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectTerminalService } from "../terminal/ProjectTerminalService.ts";
import { TerminalToolkit } from "../mcp/toolkits/terminal/tools.ts";
import { TerminalToolkitHandlersLive } from "../mcp/toolkits/terminal/handlers.ts";

const decodeInvocationCapability = Schema.decodeUnknownSync(
  Schema.Literals(["terminal", "pull-requests", "preview", "device", "project"]),
);
const fenceRegistry = Registry.__testing.make({ now: () => 1000 }).pipe(
  Effect.provideService(
    HttpServer.HttpServer,
    HttpServer.HttpServer.of({
      address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
      serve: () => Effect.void,
    }),
  ),
  Effect.provideService(
    Environment.ServerEnvironment,
    Environment.ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      getDescriptor: Effect.die("unused"),
    }),
  ),
);

for (const timing of ["before", "stale-empty", "stale-fence"] as const)
  it.effect(`durable identity fence rejects ${timing} MCP creation across purge`, () =>
    scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const sql = yield* SqlClient.SqlClient;
        const preseed =
          timing === "before"
            ? yield* seed("implementer", "running", { issueCredential: false })
            : undefined;
        const observed = yield* Deferred.make<number>();
        const release = yield* Deferred.make<void>();
        let intercepted = false;
        const racingSql = new Proxy(sql, {
          apply(target, _receiver, args) {
            const statement = target(args[0], ...args.slice(1));
            if (
              !intercepted &&
              Array.isArray(args[0]) &&
              "raw" in args[0] &&
              statement
                .compile()[0]
                .includes(
                  timing === "stale-fence"
                    ? "SELECT thread_id FROM project_team_identity_fences"
                    : "SELECT DISTINCT project_id AS projectId FROM project_team_run_binding",
                )
            ) {
              intercepted = true;
              return statement.pipe(
                Effect.tap((rows) =>
                  Deferred.succeed(observed, rows.length).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                ),
              );
            }
            return statement;
          },
        });
        const authority = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
          Effect.provideService(SqlClient.SqlClient, racingSql),
        );
        const registry = yield* fenceRegistry.pipe(
          Effect.provideService(Authorization.ProjectTeamAuthorization, authority),
        );
        const pending = yield* registry
          .issue({ providerInstanceId, threadId })
          .pipe(Effect.exit, Effect.forkScoped);
        expect(yield* Deferred.await(observed)).toBe(timing === "before" ? 1 : 0);
        const f = preseed ?? (yield* seed("implementer", "running", { issueCredential: false }));
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(pending);
        expect(result._tag).toBe(timing === "before" ? "Success" : "Failure");
        if (result._tag === "Success")
          expect([...result.value.config.capabilities]).toEqual(["project"]);
        yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        if (result._tag === "Success")
          expect(
            yield* registry.resolve(result.value.config.authorizationHeader.replace("Bearer ", "")),
          ).toBeUndefined();
        const fresh = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
        );
        expect(
          (yield* fresh.issueCredential({ providerInstanceId, threadId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* fresh.discover({ providerInstanceId, threadId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* fresh.hasManagedThread(threadId)).toBe(true);
        yield* registry.revokeAll;
      }),
    ),
  );

it.effect(
  "durable identity fence rejects untouched ordinary MCP and held toolkit scopes after purge",
  () =>
    scoped(
      Effect.gen(function* () {
        yield* runMigrations();
        const registry = yield* fenceRegistry;
        const issued = yield* registry.issue({ providerInstanceId, threadId });
        const token = issued.config.authorizationHeader.replace("Bearer ", "");
        const held = yield* registry.resolve(token);
        expect(held).toBeDefined();
        const f = yield* seed("implementer", "running", { issueCredential: false });
        yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
        yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
        const fresh = yield* Authorization.ProjectTeamAuthorization.pipe(
          Effect.provide(Layer.fresh(Authorization.layer)),
        );
        let entered = 0;
        const terminal = Layer.mock(ProjectTerminalService)({
          spawn: () => {
            entered++;
            return Effect.die("synthetic terminal sink; no process");
          },
        });
        const toolkit = yield* TerminalToolkit.pipe(
          Effect.provide(TerminalToolkitHandlersLive.pipe(Layer.provide(terminal))),
        );
        const result = yield* toolkit
          .handle("terminal_spawn", { command: "synthetic-no-execution" })
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(Invocation.McpInvocationContext, held!),
            Effect.provideService(Authorization.ProjectTeamAuthorization, fresh),
            Effect.provide(terminal),
            Effect.exit,
          );
        expect(result._tag).toBe("Failure");
        expect(entered).toBe(0);
        yield* registry.touch(threadId);
        expect(yield* registry.resolve(token)).toBeUndefined();
        expect((yield* fresh.resolve({ actor: held!.identity! }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        const ordinary = yield* registry.issue({
          providerInstanceId,
          threadId: ThreadId.make("never-managed"),
        });
        expect(
          (yield* registry.resolve(
            ordinary.config.authorizationHeader.replace("Bearer ", ""),
          ))?.capabilities.has("terminal"),
        ).toBe(true);
        yield* registry.revokeAll;
      }),
    ),
);

for (const outcome of ["late-publish", "interruption"] as const)
  it.effect(
    `durable identity fence handles final empty publication observation and ${outcome}`,
    () =>
      scoped(
        Effect.gen(function* () {
          yield* runMigrations();
          const sql = yield* SqlClient.SqlClient;
          const observed = yield* Deferred.make<number>();
          const release = yield* Deferred.make<void>();
          let intercepted = false;
          const racingSql = new Proxy(sql, {
            apply(target, _receiver, args) {
              const statement = target(args[0], ...args.slice(1));
              if (
                !intercepted &&
                Array.isArray(args[0]) &&
                "raw" in args[0] &&
                statement.compile()[0].includes("SELECT DISTINCT provider_instance_id AS provider")
              ) {
                intercepted = true;
                return statement.pipe(
                  Effect.tap((rows) =>
                    Deferred.succeed(observed, rows.length).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                );
              }
              return statement;
            },
          });
          const authority = yield* Authorization.ProjectTeamAuthorization.pipe(
            Effect.provide(Layer.fresh(Authorization.layer)),
            Effect.provideService(SqlClient.SqlClient, racingSql),
          );
          const registry = yield* fenceRegistry.pipe(
            Effect.provideService(Authorization.ProjectTeamAuthorization, authority),
          );
          const pending = yield* registry
            .issue({ providerInstanceId, threadId })
            .pipe(Effect.exit, Effect.forkScoped);
          expect(yield* Deferred.await(observed)).toBe(0);
          const f = yield* seed("implementer", "running", { issueCredential: false });
          yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
          yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
          if (outcome === "interruption") {
            yield* Fiber.interrupt(pending);
            expect((yield* Fiber.await(pending))._tag).toBe("Failure");
            expect(yield* Deferred.isDone(release)).toBe(false);
          } else {
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(pending);
            expect(result._tag).toBe("Success");
            if (result._tag !== "Success") return;
            const config = result.value.config;
            // This scope represents the returned config held unused across transition and purge.
            const held: Invocation.McpInvocationScope = {
              environmentId: config.environmentId,
              threadId,
              providerInstanceId,
              providerSessionId: config.providerSessionId,
              capabilities: new Set(
                [...config.capabilities].map((value) => decodeInvocationCapability(value)),
              ),
              issuedAt: 1000,
              identity: {
                kind: "agent",
                id: Authorization.managedActorId({ providerInstanceId, threadId }),
              },
            };
            const fresh = yield* Authorization.ProjectTeamAuthorization.pipe(
              Effect.provide(Layer.fresh(Authorization.layer)),
            );
            let entered = 0;
            const terminal = Layer.mock(ProjectTerminalService)({
              spawn: () => {
                entered++;
                return Effect.die("synthetic terminal sink; no process");
              },
            });
            const toolkit = yield* TerminalToolkit.pipe(
              Effect.provide(TerminalToolkitHandlersLive.pipe(Layer.provide(terminal))),
            );
            expect(
              (yield* toolkit
                .handle("terminal_spawn", { command: "synthetic-no-execution" })
                .pipe(
                  Stream.unwrap,
                  Stream.runCollect,
                  Effect.provideService(Invocation.McpInvocationContext, held),
                  Effect.provideService(Authorization.ProjectTeamAuthorization, fresh),
                  Effect.provide(terminal),
                  Effect.exit,
                ))._tag,
            ).toBe("Failure");
            expect(entered).toBe(0);
            expect(
              yield* registry.resolve(config.authorizationHeader.replace("Bearer ", "")),
            ).toBeUndefined();
          }
          yield* registry.revokeAll;
          expect((yield* sql`SELECT * FROM project_team_identity_fences`).length).toBe(1);
          // Cancellation releases the real SQL permit and leaves never-managed issuance available.
          expect(
            (yield* registry.issue({
              providerInstanceId,
              threadId: ThreadId.make("ordinary-after-cancellation"),
            })).config.capabilities.has("terminal"),
          ).toBe(true);
          yield* registry.revokeAll;
        }),
      ),
  );

import * as ProxyRegistry from "../mcp/ProjectMcpProxyRegistry.ts";
it.effect("durable identity fence cleans up an untouched ordinary MCP credential on touch", () =>
  scoped(
    Effect.gen(function* () {
      yield* runMigrations();
      let cleaned = 0;
      const registry = yield* fenceRegistry.pipe(
        Effect.provide(
          Layer.mock(ProxyRegistry.ProjectMcpProxyRegistry)({
            revokeProviderSession: () =>
              Effect.sync(() => {
                cleaned++;
              }),
          }),
        ),
      );
      const issued = yield* registry.issue({ providerInstanceId, threadId });
      const f = yield* seed("implementer", "running", { issueCredential: false });
      yield* f.sql`DELETE FROM project_team_run_binding WHERE project_id=${projectId}`;
      yield* f.sql`DELETE FROM project_work_events WHERE project_id=${projectId}`;
      yield* f.sql`DELETE FROM project_work_reducer_checkpoints WHERE project_id=${projectId}`;
      yield* registry.touch(threadId);
      expect(cleaned).toBe(1);
      expect(
        yield* registry.resolve(issued.config.authorizationHeader.replace("Bearer ", "")),
      ).toBeUndefined();
      expect(cleaned).toBe(1);
      yield* registry.revokeAll;
    }),
  ),
);
