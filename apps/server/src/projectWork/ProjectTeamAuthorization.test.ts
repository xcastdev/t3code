import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  RunAttemptId,
  ProviderThreadId,
  ProviderSessionId,
  ProjectWorkTaskId,
  ProjectTeamRecord,
  type ProjectTeamWriteIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Admission from "../orchestration-v2/RunAdmission.ts";
import * as Authorization from "./ProjectTeamAuthorization.ts";
import { emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("managed-project");
const taskId = ProjectWorkTaskId.make("task");
const decode = Schema.decodeUnknownSync(ProjectTeamRecord);
const seed = Effect.fn("AuthorizationTest.seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions(provider_session_id,thread_id,provider,status,updated_at,payload_json) VALUES ('session','thread','codex','running',${at},'{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,provider_session_id,status,updated_at,payload_json) VALUES ('native-thread','thread','codex','session','active',${at},'{}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs(run_id,thread_id,ordinal,provider,provider_thread_id,status,requested_at,payload_json) VALUES ('run','thread',0,'codex','native-thread','running',${at},'{"activeAttemptId":"attempt"}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts(attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_thread_id,status,payload_json) VALUES ('attempt','thread','run',0,'node','codex','native-thread','running','{}')`;
  yield* sql`INSERT INTO t3_workflow_v2_run_admissions(admission_id,project_id,binding_id,root_id,root_task_id,thread_id,run_id,run_attempt_id,generation,fence,command_id,phase,depth,writable,root_deadline,expires_at,snapshot_json,limits_json) VALUES ('admission',${projectId},'binding','root','task','thread','run','attempt',0,0,'start','admitted',0,0,${at},${at},'{}','{}')`;
  const state = emptyProjectWorkReducerState(projectId);
  const fields = { projectId, revision: 0, generation: 0, updatedAt: at };
  state.foundationRecords = [
    decode({
      ...fields,
      recordId: "member",
      kind: "member",
      status: "active",
      name: "Member",
      coordinator: false,
      roleRevisionId: "role",
    }),
    decode({
      ...fields,
      recordId: "binding",
      kind: "run-binding",
      status: "running",
      taskId,
      attemptId: "work-attempt",
      memberId: "member",
      roleRevisionId: "role",
      providerInstanceId: "codex",
      threadId: "thread",
      runId: "run",
      environmentId: "env",
      model: "model",
      configuration: {
        instructionsHash: "hash",
        toolIds: [],
        skillIds: [],
        runtimeVersion: "v2",
        maxTokens: 1000,
        maxDurationMs: 1000,
        paidFallback: false,
      },
      worktree: "/tmp/work",
      branch: "work",
      leaseGeneration: 0,
      specRevision: 0,
      planRevision: 0,
    }),
  ];
  return state;
});
const input: Extract<ProjectTeamWriteIntent, { type: "project-team.question.request" }> = {
  type: "project-team.question.request",
  projectId,
  taskId,
  commandId: CommandId.make("ask"),
  expectedRevision: 0,
  expectedTaskRevision: 0,
  specRevision: 0,
  planRevision: 0,
  questionId: "question",
  targetGateId: "gate",
  expectedGateRevision: 0,
  body: "Question",
  choices: [],
};
const principal = {
  projectId,
  actor: { kind: "agent" as const, id: "thread" },
  source: { kind: "mcp" as const, id: "session" },
};
const admitted = Layer.mock(Admission.RunAdmission)({
  check: () =>
    Effect.succeed({
      _tag: "admitted",
      owner: {
        projectId,
        bindingId: "binding",
        rootId: "root",
        generation: 0,
        fence: 0,
        threadId: ThreadId.make("thread"),
        expiresAt: at,
        configuration: {
          providerInstanceId: "codex",
          model: "model",
          instructionsHash: "hash",
          toolIds: [],
          skillIds: [],
          runtimeVersion: "v2",
          maxTokens: 1000,
          maxDurationMs: 1000,
          paidFallback: false,
        },
      },
    }),
});
const layer = Authorization.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
it.effect(
  "requires the active native session and current admitted binding rather than caller IDs",
  () =>
    Effect.gen(function* () {
      const state = yield* seed();
      const authorization = yield* Authorization.ProjectTeamAuthorization;
      const admission = yield* Admission.RunAdmission;
      const authorized = yield* authorization.assertManaged(state, input, principal).pipe(
        Effect.provideService(Admission.RunAdmission, {
          ...admission,
          check: (request) => {
            assert.strictEqual(request.operation, "completion");
            assert.deepStrictEqual(request.nativeTarget, {
              runAttemptId: RunAttemptId.make("attempt"),
              providerThreadId: ProviderThreadId.make("native-thread"),
              providerSessionId: ProviderSessionId.make("session"),
            });
            return admission.check(request);
          },
        }),
      );
      assert.deepStrictEqual(authorized, {
        bindingId: "binding",
        generation: 0,
        memberId: "member",
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_provider_threads SET provider_session_id='replacement'`;
      assert.strictEqual(
        (yield* Effect.result(authorization.assertManaged(state, input, principal)))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(Layer.merge(layer, admitted))),
);
it.effect("denies unrelated MCP client sessions, gate approval and replaced Work generations", () =>
  Effect.gen(function* () {
    const state = yield* seed();
    const authorization = yield* Authorization.ProjectTeamAuthorization;
    assert.strictEqual(
      (yield* Effect.result(
        authorization.assertManaged(state, input, {
          ...principal,
          source: { kind: "mcp", id: "client-session" },
        }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.result(
        authorization.assertManaged(
          state,
          {
            ...input,
            type: "project-team.gate.respond",
            gateId: "gate",
            expectedGateRevision: 0,
            response: "approved",
          },
          principal,
        ),
      ))._tag,
      "Failure",
    );
    const binding = state.foundationRecords!.find((r) => r.kind === "run-binding")!;
    state.foundationRecords = state.foundationRecords!.map((r) =>
      r === binding ? { ...r, generation: 1 } : r,
    );
    assert.strictEqual(
      (yield* Effect.result(authorization.assertManaged(state, input, principal)))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(Layer.merge(layer, admitted))),
);

it.effect(
  "freezes authenticated managed identity in reports and preserves actual principal attribution",
  () =>
    Effect.gen(function* () {
      const state = yield* seed();
      const authorization = yield* Authorization.ProjectTeamAuthorization;
      const managed = yield* authorization.assertManaged(state, input, principal);
      const attribution = { actor: principal.actor, source: principal.source, recordedAt: at };
      const report = yield* authorization.compile(
        state,
        {
          type: "project-team.assignment.report",
          projectId,
          taskId,
          commandId: CommandId.make("report"),
          expectedRevision: 0,
          expectedTaskRevision: 0,
          specRevision: 0,
          planRevision: 0,
          assignmentId: "membership",
          expectedAssignmentRevision: 0,
          summary: "Findings",
          evidenceIds: [],
          outputArtifactIds: [],
          outcome: "findings",
        },
        attribution,
        managed,
      );
      assert.strictEqual(report.type, "project-work.foundation.commit");
      if (report.type !== "project-work.foundation.commit") return;
      assert.strictEqual(report.guided?.bindingId, "binding");
      assert.strictEqual(report.guided?.generation, 0);
      assert.deepStrictEqual(report.attribution, attribution);
    }).pipe(Effect.provide(Layer.merge(layer, admitted))),
);

it.effect(
  "native restart generation keeps the original assignment fence for result reporting",
  () =>
    Effect.gen(function* () {
      const state = yield* seed();
      const authorization = yield* Authorization.ProjectTeamAuthorization;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET generation=1`;
      const admission = yield* Admission.RunAdmission;
      const resumed = {
        ...admission,
        check: (request: Admission.CheckInput) =>
          admission
            .check(request)
            .pipe(
              Effect.map((result) =>
                result._tag === "admitted"
                  ? { ...result, owner: { ...result.owner, generation: 1 } }
                  : result,
              ),
            ),
      };
      assert.deepStrictEqual(
        yield* authorization
          .assertManaged(state, input, principal)
          .pipe(Effect.provideService(Admission.RunAdmission, resumed)),
        { bindingId: "binding", generation: 0, memberId: "member" },
      );
      yield* sql`UPDATE t3_workflow_v2_run_admissions SET fence=1`;
      assert.strictEqual(
        (yield* Effect.result(authorization.assertManaged(state, input, principal)))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(Layer.merge(layer, admitted))),
);
