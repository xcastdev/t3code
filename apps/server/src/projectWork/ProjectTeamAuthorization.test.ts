import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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
} from "@t3tools/contracts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Environment from "../environment/ServerEnvironment.ts";

import { ProjectWorkQuery } from "./ProjectWorkQuery.ts";
import { ProjectWorkGateway } from "./ProjectWorkGateway.ts";
import { ProjectWorkRepository, readCurrentState } from "./ProjectWorkRepository.ts";
import { projectTeamSpecificationHash, projectTeamScopeHash } from "./ProjectTeamPolicy.ts";
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
