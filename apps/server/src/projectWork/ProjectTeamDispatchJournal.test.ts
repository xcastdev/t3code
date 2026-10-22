import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProjectWorkTaskId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Journal from "./ProjectTeamDispatchJournal.ts";
const at = "2026-01-01T00:00:00.000Z";
const fixture = (id: string): Journal.DispatchSnapshot => ({
  dispatchId: id,
  projectId: "project",
  taskId: "task",
  bindingId: `${id}:binding`,
  threadId: `${id}:thread`,
  generation: 0,
  fingerprint: "frozen",
  assignment: "Read the source",
  stage: "reserved",
  createdAt: at,
  updatedAt: at,
  request: {
    type: "project-team.dispatch",
    projectId: ProjectId.make("project"),
    commandId: CommandId.make(id),
    expectedRevision: 1,
    taskId: ProjectWorkTaskId.make("task"),
    expectedTaskRevision: 0,
    memberId: "member",
    expectedMemberRevision: 0,
    authorizationGateId: "grant",
    expectedGateRevision: 0,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    workspace: { type: "root" },
  },
  result: {
    projectId: ProjectId.make("project"),
    revision: 2,
    receipt: {
      commandId: CommandId.make(id),
      projectId: ProjectId.make("project"),
      status: "accepted",
      revision: 2,
      eventCount: 1,
    },
    delta: { projectId: ProjectId.make("project"), revision: 2, eventIds: [], changedFields: [] },
  },
});
const layer = Journal.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
it.effect(
  "retains original request and assignment atomically, and a stale worker cannot reopen a stopping dispatch",
  () =>
    Effect.gen(function* () {
      const journal = yield* Journal.ProjectTeamDispatchJournal;
      const sql = yield* SqlClient.SqlClient;
      const s = fixture("one");
      const outside = yield* journal.retain(s).pipe(Effect.result);
      assert.equal(outside._tag, "Failure");
      assert(Option.isNone(yield* journal.read(s.dispatchId)));
      yield* sql.withTransaction(journal.retain(s));
      const pending = yield* journal.advance(s, "uncertain", at);
      yield* journal.advance(pending, "stopping", at);
      const late = yield* journal.advance(pending, "observed", at).pipe(Effect.result);
      assert.equal(late._tag, "Failure");
      const retained = Option.getOrThrow(yield* journal.read(s.dispatchId));
      assert.equal(retained.stage, "stopping");
      assert.deepEqual(retained.request, s.request);
      assert.equal(retained.assignment, s.assignment);
    }).pipe(Effect.provide(layer)),
);
it.effect(
  "keyset recovery reaches later dispatches while earlier uncertain operations remain retained",
  () =>
    Effect.gen(function* () {
      const journal = yield* Journal.ProjectTeamDispatchJournal;
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.forEach(
          Array.from({ length: 130 }, (_, i) => fixture(String(i).padStart(3, "0"))),
          journal.retain,
          { discard: true },
        ),
      );
      const first = yield* journal.recoverable();
      assert.equal(first.length, 128);
      const second = yield* journal.recoverable(first.at(-1));
      assert.deepEqual(second, ["128", "129"]);
      const repeated = yield* journal.recoverable();
      assert.deepEqual(repeated, first);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "an observed dispatch cannot reenter startup recovery through a backward journal edge",
  () =>
    Effect.gen(function* () {
      const journal = yield* Journal.ProjectTeamDispatchJournal;
      const sql = yield* SqlClient.SqlClient;
      const original = fixture("forward-only");
      yield* sql.withTransaction(journal.retain(original));
      const uncertain = yield* journal.advance(original, "uncertain", at);
      const observed = yield* journal.advance(uncertain, "observed", at);
      const backward = yield* journal.advance(observed, "reserved", at).pipe(Effect.result);
      assert.equal(backward._tag, "Failure");
      assert.deepEqual(yield* journal.recoverable(), []);
      const repeated = yield* journal.advance(observed, "observed", at);
      assert.deepEqual(repeated, observed);
      const stopping = yield* journal.advance(observed, "stopping", at);
      const settled = yield* journal.advance(stopping, "settled", at);
      assert.equal(settled.stage, "settled");
      assert.equal(
        (yield* journal.advance(settled, "uncertain", at).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);
