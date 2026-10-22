import { CommandId, ProjectWorkCommentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Repository from "../ProjectWorkRepository.ts";
import * as Memory from "./ProjectMemoryService.ts";
import {
  layer,
  seed,
  scope,
  captureInput,
  taskId,
  at,
  human,
} from "./ProjectMemoryService.test-utils.ts";
import { memoryHash, sourceTuple } from "./ProjectMemoryRepository.ts";
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
it.effect("corrected retained content hides old hits and stale extraction cannot revive it", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    const source = yield* memory.capture(captureInput());
    const sql = yield* SqlClient.SqlClient;
    const state = yield* Repository.readCurrentState(sql, scope.owner.projectId);
    const changed = "Use event milestones";
    const updated = {
      ...state,
      comments: state.comments?.map((c) => ({ ...c, body: changed, revision: 1 })),
    };
    const payload = yield* encode(updated);
    yield* sql`UPDATE t3_workflow_v2_work_reducer_checkpoints SET state_json=${payload} WHERE project_id=${scope.owner.projectId}`;
    assert.deepStrictEqual(
      yield* memory.hydrateCurrentHits({ ...scope, hits: [sourceTuple(scope, source)] }),
      [],
    );
    const input = captureInput(changed);
    const corrected = yield* memory.correct({
      ...input,
      reference: { ...input.reference, retainedRevision: 1 },
      selection: {
        ...input.selection,
        retainedRevision: 1,
        sourceRevision: 1,
        sourceGeneration: 1,
        contentHash: memoryHash(changed),
      },
      previous: sourceTuple(scope, source),
    });
    assert.deepStrictEqual(
      (yield* memory.recallText({ ...scope, limit: 100, query: "event" })).map((s) => s.content),
      [changed],
    );
    assert.equal(
      (yield* Effect.result(memory.applyCurrent(sourceTuple(scope, source), () => Effect.void)))
        ._tag,
      "Failure",
    );
    assert.equal(corrected.sourceRevision, 1);
    yield* sql`UPDATE t3_workflow_v2_memory_cleanup SET status='completed'`;
    yield* memory.deleteOwner(scope);
    assert.equal(
      (yield* sql`SELECT count(*) AS count FROM t3_workflow_v2_memory_cleanup WHERE id LIKE 'owner:%' AND status='pending'`)[0]
        ?.count,
      2,
    );
    yield* memory.deleteOwner(scope);
  }).pipe(Effect.provide(layer)),
);
it.effect("a stale earlier source does not consume the current-memory page limit", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    const first = yield* memory.capture(captureInput());
    const sql = yield* SqlClient.SqlClient;
    const repository = yield* Repository.ProjectWorkRepository;
    yield* repository.execute({
      type: "project-work.comment.add",
      projectId: scope.owner.projectId,
      commandId: CommandId.make("extra-comment"),
      comment: {
        commentId: ProjectWorkCommentId.make("second-note"),
        projectId: scope.owner.projectId,
        taskId,
        body: "Use focused tests",
        revision: 0,
        createdAt: at,
        attribution: human,
      },
      addedAt: at,
      attribution: human,
    });
    const input = captureInput();
    const second = yield* memory.capture({
      ...input,
      reference: { ...input.reference, retainedId: "second-note" },
      selection: { ...input.selection, retainedId: "second-note", sourceRecordId: "second-source" },
    });
    const state = yield* Repository.readCurrentState(sql, scope.owner.projectId);
    const staleId = first.sourceId < second.sourceId ? input.reference.retainedId : "second-note";
    const changed = {
      ...state,
      comments: state.comments?.map((c) => (c.commentId === staleId ? { ...c, revision: 1 } : c)),
    };
    yield* sql`UPDATE t3_workflow_v2_work_reducer_checkpoints SET state_json=${yield* encode(changed)} WHERE project_id=${scope.owner.projectId}`;
    assert.equal((yield* memory.listCurrent({ ...scope, limit: 1 })).length, 1);
  }).pipe(Effect.provide(layer)),
);
it.effect("a bounded empty page retains its scanned cursor past one hundred stale candidates", () =>
  Effect.gen(function* () {
    yield* seed();
    const memory = yield* Memory.ProjectMemoryService;
    const source = yield* memory.capture(captureInput());
    const sql = yield* SqlClient.SqlClient;
    yield* sql`WITH RECURSIVE candidates(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM candidates WHERE i<99)
 INSERT INTO t3_workflow_v2_memory_sources(environment_id,owner_kind,owner_id,source_id,source_revision,generation,owner_revision,content_hash,status,work_kind,work_id,work_revision,task_id,payload_json)
 SELECT environment_id,owner_kind,owner_id,printf('%03d',i),source_revision,generation,owner_revision,content_hash,status,work_kind,work_id,work_revision+1,task_id,json_set(payload_json,'$.sourceId',printf('%03d',i),'$.recordId',printf('stale-%03d',i)) FROM t3_workflow_v2_memory_sources,candidates WHERE source_id=${source.sourceId}`;
    const first = yield* memory.listCurrentPage({ ...scope, limit: 1 });
    assert.equal(first.items.length, 0);
    assert.equal(first.nextCursor, "099");
    const next = yield* memory.listCurrentPage({ ...scope, limit: 1, cursor: first.nextCursor! });
    assert.equal(next.items[0]?.sourceId, source.sourceId);
    assert.equal(next.nextCursor, null);
  }).pipe(Effect.provide(layer)),
);
