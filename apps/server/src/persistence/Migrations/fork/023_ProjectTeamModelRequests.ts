import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Runtime journals survive projection rebuilds and never contain provider credentials. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_team_model_budget (
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    root_task_id TEXT NOT NULL,
    maximum_tokens INTEGER NOT NULL CHECK(maximum_tokens > 0),
    deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms > 0),
    PRIMARY KEY(environment_id, project_id, root_task_id)
  )`;
  yield* sql`CREATE TABLE project_team_model_request (
    reservation_id TEXT PRIMARY KEY,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    root_task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 0),
    operation_id TEXT NOT NULL,
    request_id INTEGER NOT NULL CHECK(request_id > 0),
    route_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK(provider = 'command-code'),
    model TEXT NOT NULL,
    environment_slot INTEGER NOT NULL CHECK(environment_slot >= 0),
    model_slot INTEGER NOT NULL CHECK(model_slot >= 0),
    maximum_input_tokens INTEGER NOT NULL CHECK(maximum_input_tokens > 0),
    maximum_output_tokens INTEGER NOT NULL CHECK(maximum_output_tokens > 0),
    deadline_at_ms INTEGER NOT NULL CHECK(deadline_at_ms > 0),
    status TEXT NOT NULL CHECK(status IN ('held','reported','failed','unknown')),
    charged_input_tokens INTEGER NOT NULL CHECK(charged_input_tokens >= 0),
    charged_output_tokens INTEGER NOT NULL CHECK(charged_output_tokens >= 0),
    accounting_receipt_id TEXT,
    reservation_json TEXT NOT NULL,
    settlement_json TEXT,
    UNIQUE(worker_id, generation, operation_id, request_id),
    FOREIGN KEY(environment_id, project_id, root_task_id)
      REFERENCES project_team_model_budget(environment_id, project_id, root_task_id)
  )`;
  yield* sql`CREATE UNIQUE INDEX project_team_model_environment_capacity
    ON project_team_model_request(environment_id, environment_slot) WHERE status='held'`;
  yield* sql`CREATE UNIQUE INDEX project_team_model_route_capacity
    ON project_team_model_request(environment_id, model, model_slot) WHERE status='held'`;
  yield* sql`CREATE INDEX project_team_model_budget_usage
    ON project_team_model_request(environment_id, project_id, root_task_id, reservation_id)`;
  yield* sql`CREATE INDEX project_team_model_pending_deadline
    ON project_team_model_request(status, deadline_at_ms, reservation_id)`;
});
