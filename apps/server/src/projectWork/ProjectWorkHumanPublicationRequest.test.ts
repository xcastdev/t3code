import { assert, it } from "@effect/vitest";
import { ProjectWorkRpcError, EnvironmentId, ProjectWorkTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sources from "./ProjectTeamIntegrationSources.ts";
import * as Authority from "./ProjectWorkPublicationAuthorization.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { emptyProjectWorkReducerState } from "./ProjectWorkDecider.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Publication from "./ProjectWorkHumanPublicationRequest.ts";
import * as Journal from "./ProjectWorkPublicationJournal.ts";
import {
  dependencies,
  input,
  principal,
  outcome,
  decision,
  at,
} from "./ProjectWorkPublication.testkit.ts";
const decodeTask = Schema.decodeUnknownSync(ProjectWorkTask);
const encodeState = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const testLayer = (options: Parameters<typeof dependencies>[0] = {}) =>
  Publication.layer.pipe(
    Layer.provide(dependencies(options)),
    Layer.provideMerge(Journal.layer),
    Layer.provide(Sqlite.layerMemory),
  );
it.effect("reconciles timeout after a successful create and never creates twice", () => {
  let creates = 0;
  return Effect.gen(function* () {
    const service = yield* Publication.ProjectWorkHumanPublicationRequest;
    const first = yield* service.execute(input, principal);
    const repeated = yield* service.execute(input, principal);
    assert.equal(first.stage, "confirmed");
    assert.deepEqual(repeated, first);
    assert.equal(creates, 1);
  }).pipe(
    Effect.provide(
      testLayer({
        host: {
          create: () => {
            creates++;
            return Effect.fail(new Journal.PublicationError({ reason: "uncertain" }));
          },
          reconcilePublication: (operation) => Effect.succeed(outcome(operation)),
        },
      }),
    ),
  );
});
it.effect(
  "retains moved remote head as uncertain and only reconciles on subsequent requests",
  () => {
    let creates = 0;
    const changed = (operation: Journal.DeliveryOperation) => {
      const result = outcome(operation);
      return result.kind === "confirmed"
        ? { ...result, pullRequest: { ...result.pullRequest, headSha: "f".repeat(40) } }
        : result;
    };
    return Effect.gen(function* () {
      const service = yield* Publication.ProjectWorkHumanPublicationRequest;
      assert.equal((yield* service.execute(input, principal)).stage, "uncertain");
      assert.equal((yield* service.execute(input, principal)).stage, "uncertain");
      assert.equal(creates, 1);
    }).pipe(
      Effect.provide(
        testLayer({
          host: {
            create: (operation) => {
              creates++;
              return Effect.succeed(changed(operation));
            },
            reconcilePublication: (operation) => Effect.succeed(changed(operation)),
          },
        }),
      ),
    );
  },
);
it.effect("rechecks the human session before claiming the host write", () => {
  let checks = 0;
  let creates = 0;
  return Effect.gen(function* () {
    const service = yield* Publication.ProjectWorkHumanPublicationRequest;
    const result = yield* service.execute(input, principal).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(creates, 0);
    const journal = yield* Journal.ProjectWorkPublicationJournal;
    assert.equal(Option.getOrThrow(yield* journal.read(input.operationId)).stage, "approved");
  }).pipe(
    Effect.provide(
      testLayer({
        assertHuman: () =>
          ++checks === 1
            ? Effect.void
            : Effect.fail(new ProjectWorkRpcError({ operation: "write", reason: "forbidden" })),
        host: {
          create: (operation) => {
            creates++;
            return Effect.succeed(outcome(operation));
          },
        },
      }),
    ),
  );
});
it.effect("one approved gate cannot be reused under another operation ID", () =>
  Effect.gen(function* () {
    const service = yield* Publication.ProjectWorkHumanPublicationRequest;
    yield* service.execute(input, principal);
    const result = yield* service
      .execute({ ...input, operationId: "another" }, principal)
      .pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }).pipe(
    Effect.provide(
      testLayer({ host: { create: (operation) => Effect.succeed(outcome(operation)) } }),
    ),
  ),
);
it.effect("changed reviewed code cannot claim publication", () => {
  let writes = 0;
  return Effect.gen(function* () {
    const service = yield* Publication.ProjectWorkHumanPublicationRequest;
    const result = yield* service.execute(input, principal).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    assert.equal(writes, 0);
  }).pipe(
    Effect.provide(
      testLayer({
        assertCurrent: () => Effect.fail(new Journal.PublicationError({ reason: "stale" })),
        host: {
          create: (operation) => {
            writes++;
            return Effect.succeed(outcome(operation));
          },
        },
      }),
    ),
  );
});
it.effect("only distinct publication approval can prepare a create request", () => {
  let captures = 0;
  const required = Layer.mergeAll(
    Layer.mock(Sources.ProjectTeamIntegrationSources)({
      qualify: () => Effect.succeed(decision.source),
      assertCurrent: () => Effect.void,
    }),
    Layer.mock(Environment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
    }),
  );
  const authorityLayer = Authority.layer.pipe(
    Layer.provide(
      dependencies({
        host: {
          capture: () => {
            captures++;
            return Effect.succeed({
              cwd: decision.cwd,
              providerId: decision.providerId,
              account: decision.account,
              repository: decision.request.repository,
              headRepositoryNodeId: decision.request.target.headRepositoryNodeId,
              headSelector: decision.request.target.headSelector,
              baseRef: decision.request.target.baseRef,
            });
          },
        },
      }),
    ),
    Layer.provide(required),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const authority = yield* Authority.ProjectWorkPublicationAuthorization;
    const task = decodeTask({
      taskId: "task",
      projectId: "project",
      title: "Task",
      state: "in-review",
      watchers: [],
      revision: 0,
      specRevision: 0,
      createdAt: at,
      updatedAt: at,
      attribution: { ...principal, recordedAt: at },
    });
    for (const gate of ["execution", "merge", "publication"] as const) {
      const state = {
        ...emptyProjectWorkReducerState("project"),
        checkpointVersion: 1,
        tasks: [task],
        foundationRecords: [{ ...decision.gate, gate }],
      };
      const payload = encodeState(state);
      yield* sql`INSERT INTO t3_workflow_v2_work_reducer_checkpoints(project_id,last_sequence,state_json,updated_at) VALUES('project',0,${payload},${at}) ON CONFLICT(project_id) DO UPDATE SET state_json=excluded.state_json`;
      const result = yield* authority.prepare(input).pipe(Effect.result);
      assert.equal(result._tag, gate === "publication" ? "Success" : "Failure");
      if (gate !== "publication" && result._tag === "Failure")
        assert.equal(result.failure.reason, "authorization");
    }
    assert.equal(captures, 1);
  }).pipe(Effect.provide(authorityLayer));
});
