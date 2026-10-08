import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_memory_query (
    query_id TEXT NOT NULL PRIMARY KEY CHECK(length(CAST(query_id AS BLOB)) BETWEEN 1 AND 1024),
    environment_id TEXT NOT NULL CHECK(length(CAST(environment_id AS BLOB)) BETWEEN 1 AND 1024),
    project_id TEXT NOT NULL CHECK(length(CAST(project_id AS BLOB)) BETWEEN 1 AND 1024),
    task_id TEXT NOT NULL CHECK(length(CAST(task_id AS BLOB)) BETWEEN 1 AND 1024),
    binding_id TEXT NOT NULL CHECK(length(CAST(binding_id AS BLOB)) BETWEEN 1 AND 1024),
    generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991),
    operation_id TEXT NOT NULL CHECK(length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 1024),
    command_id TEXT NOT NULL CHECK(length(CAST(command_id AS BLOB)) BETWEEN 1 AND 1024),
    owner_json TEXT NOT NULL CHECK(json_valid(owner_json) AND json_extract(owner_json,'$.version')=2
      AND length(CAST(owner_json AS BLOB))<=262144),
    status TEXT NOT NULL CHECK(status IN ('pending','embedding','searching','completed','failed','uncertain')),
    embedding_json TEXT CHECK(embedding_json IS NULL OR (json_valid(embedding_json) AND length(CAST(embedding_json AS BLOB))<=131072)),
    embedding_result_json TEXT CHECK(embedding_result_json IS NULL OR (json_valid(embedding_result_json) AND length(CAST(embedding_result_json AS BLOB))<=131072)),
    search_json TEXT CHECK(search_json IS NULL OR (json_valid(search_json) AND length(CAST(search_json AS BLOB))<=131072)),
    search_result_json TEXT CHECK(search_result_json IS NULL OR (json_valid(search_result_json) AND length(CAST(search_result_json AS BLOB))<=131072)),
    search_drain_json TEXT CHECK(search_drain_json IS NULL OR (json_valid(search_drain_json) AND length(CAST(search_drain_json AS BLOB))<=4096)),
    result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=131072)),
    UNIQUE(project_id,command_id)
  )`;
  yield* sql`CREATE INDEX project_team_memory_query_task ON project_team_memory_query(
    environment_id,project_id,task_id,query_id)`;
  yield* sql`CREATE INDEX project_team_memory_query_operation ON project_team_memory_query(
    environment_id,project_id,binding_id,generation,operation_id,query_id)`;
  yield* sql`CREATE TRIGGER project_team_memory_query_owner_immutable BEFORE UPDATE ON project_team_memory_query
    WHEN NEW.query_id IS NOT OLD.query_id OR NEW.environment_id IS NOT OLD.environment_id
      OR NEW.project_id IS NOT OLD.project_id OR NEW.task_id IS NOT OLD.task_id
      OR NEW.binding_id IS NOT OLD.binding_id OR NEW.generation IS NOT OLD.generation
      OR NEW.operation_id IS NOT OLD.operation_id OR NEW.command_id IS NOT OLD.command_id
      OR NEW.owner_json IS NOT OLD.owner_json
    BEGIN SELECT RAISE(ABORT,'Original memory query owner cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_memory_query_stages_immutable BEFORE UPDATE ON project_team_memory_query
    WHEN (OLD.embedding_json IS NOT NULL AND NEW.embedding_json IS NOT OLD.embedding_json)
      OR (OLD.embedding_result_json IS NOT NULL AND NEW.embedding_result_json IS NOT OLD.embedding_result_json)
      OR (OLD.search_json IS NOT NULL AND NEW.search_json IS NOT OLD.search_json)
      OR (OLD.search_result_json IS NOT NULL AND NEW.search_result_json IS NOT OLD.search_result_json)
      OR (OLD.search_drain_json IS NOT NULL AND NEW.search_drain_json IS NOT OLD.search_drain_json)
      OR (OLD.result_json IS NOT NULL AND NEW.result_json IS NOT OLD.result_json)
    BEGIN SELECT RAISE(ABORT,'Original memory query stage cannot change'); END`;
  yield* sql`CREATE TRIGGER project_team_memory_query_retained BEFORE DELETE ON project_team_memory_query
    BEGIN SELECT RAISE(ABORT,'Original memory query cannot be deleted'); END`;
});
