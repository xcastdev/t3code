import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A task's first retained budget never renews; uncertain children retain capacity. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_task_resource_budget (
    environment_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
    deadline_at_ms INTEGER NOT NULL CHECK(typeof(deadline_at_ms)='integer' AND deadline_at_ms BETWEEN 1 AND 9007199254740991),
    memory_bytes INTEGER NOT NULL CHECK(typeof(memory_bytes)='integer' AND memory_bytes=2147483648),
    PRIMARY KEY(environment_id,project_id,task_id)
  )`;
  yield* sql`CREATE TRIGGER project_task_resource_budget_immutable BEFORE UPDATE ON project_task_resource_budget
    BEGIN SELECT RAISE(ABORT,'Task resource budget cannot renew'); END`;
  yield* sql`CREATE TABLE project_task_resource_child (
    unit TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE,
    environment_id TEXT NOT NULL, project_id TEXT NOT NULL, task_id TEXT NOT NULL,
    authority_kind TEXT NOT NULL CHECK(authority_kind IN ('pi','verification','setup')),
    authority_id TEXT NOT NULL, allocation_json TEXT NOT NULL CHECK(typeof(allocation_json)='text' AND json_valid(allocation_json) AND length(CAST(allocation_json AS BLOB)) BETWEEN 1 AND 262144),
    memory_bytes INTEGER NOT NULL CHECK(typeof(memory_bytes)='integer' AND memory_bytes BETWEEN 16777216 AND 2147483648),
    deadline_at_ms INTEGER NOT NULL CHECK(typeof(deadline_at_ms)='integer' AND deadline_at_ms BETWEEN 1 AND 9007199254740991),
    owner_json TEXT CHECK(owner_json IS NULL OR (typeof(owner_json)='text' AND json_valid(owner_json) AND length(CAST(owner_json AS BLOB)) BETWEEN 1 AND 16384)),
    drain_json TEXT CHECK(drain_json IS NULL OR (typeof(drain_json)='text' AND json_valid(drain_json) AND length(CAST(drain_json AS BLOB)) BETWEEN 1 AND 262144)),
    FOREIGN KEY(environment_id,project_id,task_id) REFERENCES project_task_resource_budget(environment_id,project_id,task_id)
  )`;
  yield* sql`CREATE INDEX project_task_resource_outstanding ON project_task_resource_child(environment_id,project_id,task_id) WHERE drain_json IS NULL`;
  yield* sql`CREATE TRIGGER project_task_resource_capacity BEFORE INSERT ON project_task_resource_child
    WHEN NEW.drain_json IS NOT NULL OR NEW.owner_json IS NOT NULL
      OR NEW.memory_bytes + COALESCE((SELECT SUM(memory_bytes) FROM project_task_resource_child
        WHERE environment_id=NEW.environment_id AND project_id=NEW.project_id AND task_id=NEW.task_id AND drain_json IS NULL),0)>2147483648
      OR NEW.deadline_at_ms>(SELECT deadline_at_ms FROM project_task_resource_budget WHERE environment_id=NEW.environment_id AND project_id=NEW.project_id AND task_id=NEW.task_id)
    BEGIN SELECT RAISE(ABORT,'Task resource capacity unavailable'); END`;
  yield* sql`CREATE TRIGGER project_task_resource_child_immutable BEFORE UPDATE ON project_task_resource_child
    WHEN OLD.unit IS NOT NEW.unit OR OLD.nonce IS NOT NEW.nonce OR OLD.environment_id IS NOT NEW.environment_id
      OR OLD.project_id IS NOT NEW.project_id OR OLD.task_id IS NOT NEW.task_id OR OLD.authority_kind IS NOT NEW.authority_kind
      OR OLD.authority_id IS NOT NEW.authority_id OR OLD.allocation_json IS NOT NEW.allocation_json
      OR OLD.memory_bytes IS NOT NEW.memory_bytes OR OLD.deadline_at_ms IS NOT NEW.deadline_at_ms
      OR (OLD.owner_json IS NOT NULL AND OLD.owner_json IS NOT NEW.owner_json)
      OR (OLD.drain_json IS NOT NULL AND OLD.drain_json IS NOT NEW.drain_json)
    BEGIN SELECT RAISE(ABORT,'Task child ownership cannot change'); END`;
  yield* sql`CREATE TRIGGER project_task_resource_child_no_delete BEFORE DELETE ON project_task_resource_child
    BEGIN SELECT RAISE(ABORT,'Task child ownership must retain its drain'); END`;
  yield* sql`CREATE TRIGGER project_task_resource_budget_no_delete BEFORE DELETE ON project_task_resource_budget
    BEGIN SELECT RAISE(ABORT,'Task resource budget must remain retained'); END`;
});
