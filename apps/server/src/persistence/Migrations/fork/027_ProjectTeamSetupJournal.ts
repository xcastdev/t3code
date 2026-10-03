import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Preserve old owners as cleanup knowledge; missing launch input cannot authorize replay. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER project_team_setup_identity_immutable`;
  yield* sql`ALTER TABLE project_team_setup_process RENAME TO project_team_setup_process_legacy`;
  yield* sql`CREATE TABLE project_team_setup_process (
    setup_id TEXT PRIMARY KEY,
    dispatch_id TEXT NOT NULL UNIQUE REFERENCES project_team_dispatch(dispatch_id),
    unit TEXT UNIQUE,
    selection_json TEXT NOT NULL CHECK(json_valid(selection_json)
      AND length(CAST(selection_json AS BLOB)) <= 262144),
    allocation_json TEXT CHECK(allocation_json IS NULL OR
      (json_valid(allocation_json) AND length(CAST(allocation_json AS BLOB)) <= 262144)),
    status TEXT NOT NULL CHECK(status IN ('selected','no-script','allocated','claimed','captured',
      'completed','failed','uncertain')),
    owner_json TEXT CHECK(owner_json IS NULL OR
      (json_valid(owner_json) AND length(CAST(owner_json AS BLOB)) <= 262144)),
    drain_json TEXT CHECK(drain_json IS NULL OR
      (json_valid(drain_json) AND length(CAST(drain_json AS BLOB)) <= 262144)),
    input_json TEXT CHECK(input_json IS NULL OR
      (json_valid(input_json) AND length(CAST(input_json AS BLOB)) <= 262144)),
    activation TEXT NOT NULL CHECK(activation IN ('unlaunched','claimed','owned')),
    started_pid INTEGER CHECK(started_pid IS NULL OR started_pid BETWEEN 1 AND 2147483647),
    receipt_json TEXT CHECK(receipt_json IS NULL OR
      (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 262144)),
    uncertainty_json TEXT CHECK(uncertainty_json IS NULL OR
      (json_valid(uncertainty_json) AND length(CAST(uncertainty_json AS BLOB)) <= 262144)),
    CHECK((unit IS NULL AND allocation_json IS NULL AND status IN ('selected','no-script','uncertain'))
      OR (unit IS NOT NULL AND allocation_json IS NOT NULL AND status <> 'no-script')),
    CHECK(activation <> 'owned' OR owner_json IS NOT NULL),
    CHECK(started_pid IS NULL OR (activation='owned' AND owner_json IS NOT NULL)),
    CHECK(status <> 'completed' OR (owner_json IS NOT NULL AND drain_json IS NOT NULL)),
    CHECK(status <> 'failed' OR receipt_json IS NOT NULL
      OR (owner_json IS NOT NULL AND drain_json IS NOT NULL))
  )`;
  yield* sql`INSERT INTO project_team_setup_process
    (setup_id,dispatch_id,unit,selection_json,allocation_json,status,owner_json,drain_json,
      input_json,activation,started_pid,receipt_json,uncertainty_json)
    SELECT setup_id,dispatch_id,unit,selection_json,allocation_json,status,owner_json,drain_json,
      NULL,CASE WHEN owner_json IS NOT NULL THEN 'owned'
        WHEN status IN ('claimed','captured','completed','failed','uncertain') THEN 'claimed'
        ELSE 'unlaunched' END,NULL,NULL,
      CASE WHEN status='uncertain' THEN '{"reason":"legacy setup requires reconciliation"}' ELSE NULL END
    FROM project_team_setup_process_legacy`;
  yield* sql`DROP TABLE project_team_setup_process_legacy`;
  yield* sql`CREATE TRIGGER project_team_setup_identity_immutable
    BEFORE UPDATE ON project_team_setup_process WHEN
      NEW.setup_id <> OLD.setup_id OR NEW.dispatch_id <> OLD.dispatch_id
      OR NEW.input_json IS NOT OLD.input_json OR NEW.selection_json <> OLD.selection_json
      OR (OLD.allocation_json IS NOT NULL AND
        (NEW.allocation_json IS NOT OLD.allocation_json OR NEW.unit IS NOT OLD.unit))
      OR (OLD.allocation_json IS NULL AND NEW.allocation_json IS NOT NULL AND
        (OLD.status <> 'selected' OR NEW.status <> 'allocated' OR NEW.unit IS NULL))
      OR (OLD.owner_json IS NOT NULL AND NEW.owner_json IS NOT OLD.owner_json)
      OR (OLD.started_pid IS NOT NULL AND NEW.started_pid IS NOT OLD.started_pid)
      OR (OLD.drain_json IS NOT NULL AND NEW.drain_json IS NOT OLD.drain_json)
      OR (OLD.receipt_json IS NOT NULL AND NEW.receipt_json IS NOT OLD.receipt_json)
      OR (OLD.uncertainty_json IS NOT NULL AND NEW.uncertainty_json IS NOT OLD.uncertainty_json)
      OR (OLD.activation='owned' AND NEW.activation <> 'owned')
      OR (OLD.activation='claimed' AND NEW.activation='unlaunched')
      OR (OLD.status IN ('no-script','completed','failed') AND NEW.status <> OLD.status
        AND NEW.status <> 'uncertain')
    BEGIN SELECT RAISE(ABORT,'Setup identity and physical receipts cannot change'); END`;
});
