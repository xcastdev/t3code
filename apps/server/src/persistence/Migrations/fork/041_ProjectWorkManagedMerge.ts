import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_work_managed_merge (
    environment_id TEXT NOT NULL CHECK(length(environment_id) BETWEEN 1 AND 256),
    operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 256),
    project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 256),
    gate_id TEXT NOT NULL CHECK(length(gate_id) BETWEEN 1 AND 256),
    gate_revision INTEGER NOT NULL CHECK(typeof(gate_revision)='integer' AND gate_revision BETWEEN 0 AND 9007199254740991),
    gate_sha256 TEXT NOT NULL CHECK(length(gate_sha256)=64 AND gate_sha256 NOT GLOB '*[^a-f0-9]*'),
    decision_json TEXT NOT NULL CHECK(json_valid(decision_json) AND json_type(decision_json)='object' AND length(CAST(decision_json AS BLOB)) BETWEEN 1 AND 131072),
    decision_sha256 TEXT NOT NULL CHECK(length(decision_sha256)=64 AND decision_sha256 NOT GLOB '*[^a-f0-9]*'),
    status TEXT NOT NULL CHECK(status IN ('pending','claimed','confirmed','uncertain')),
    claim_generation INTEGER NOT NULL CHECK(typeof(claim_generation)='integer' AND claim_generation BETWEEN 0 AND 9007199254740991),
    attention_json TEXT CHECK(attention_json IS NULL OR (json_valid(attention_json) AND length(CAST(attention_json AS BLOB)) BETWEEN 1 AND 16384)),
    receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) BETWEEN 1 AND 32768)),
    receipt_sha256 TEXT CHECK(receipt_sha256 IS NULL OR (length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^a-f0-9]*')),
    PRIMARY KEY(environment_id,operation_id),
    UNIQUE(environment_id,gate_id,gate_revision,gate_sha256),
    CHECK(json_extract(decision_json,'$.environmentId') IS environment_id AND json_extract(decision_json,'$.operationId') IS operation_id AND json_extract(decision_json,'$.publication.target.projectId') IS project_id AND json_extract(decision_json,'$.publication.target.taskId') IS task_id AND json_extract(decision_json,'$.gate.recordId') IS gate_id AND json_extract(decision_json,'$.gate.revision') IS gate_revision),
    CHECK((receipt_json IS NULL AND receipt_sha256 IS NULL AND status != 'confirmed') OR (receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL AND status='confirmed')),
    CHECK((status='pending' AND claim_generation=0) OR (status!='pending' AND claim_generation>0))
  )`;
  yield* sql`CREATE TRIGGER project_work_managed_merge_immutable BEFORE UPDATE ON project_work_managed_merge
    WHEN OLD.environment_id IS NOT NEW.environment_id OR OLD.operation_id IS NOT NEW.operation_id OR OLD.project_id IS NOT NEW.project_id OR OLD.task_id IS NOT NEW.task_id OR OLD.gate_id IS NOT NEW.gate_id OR OLD.gate_revision IS NOT NEW.gate_revision OR OLD.gate_sha256 IS NOT NEW.gate_sha256 OR OLD.decision_json IS NOT NEW.decision_json OR OLD.decision_sha256 IS NOT NEW.decision_sha256 OR OLD.receipt_json IS NOT NULL OR (OLD.attention_json IS NOT NULL AND OLD.attention_json IS NOT NEW.attention_json)
    BEGIN SELECT RAISE(ABORT,'Managed merge decision and confirmed receipt are immutable'); END`;
  yield* sql`CREATE TRIGGER project_work_managed_merge_status BEFORE UPDATE ON project_work_managed_merge
    WHEN NOT ((OLD.status='pending' AND NEW.status='claimed' AND NEW.claim_generation=1 AND NEW.receipt_json IS NULL AND NEW.attention_json IS NULL)
      OR (OLD.status='claimed' AND NEW.status IN ('uncertain','confirmed') AND NEW.claim_generation=OLD.claim_generation)
      OR (OLD.status='uncertain' AND NEW.status='uncertain' AND NEW.claim_generation=OLD.claim_generation AND OLD.attention_json IS NULL AND NEW.attention_json IS NOT NULL))
    BEGIN SELECT RAISE(ABORT,'Managed merge cannot replace a claimed or settled operation'); END`;
  yield* sql`CREATE TRIGGER project_work_managed_merge_retained BEFORE DELETE ON project_work_managed_merge BEGIN SELECT RAISE(ABORT,'Managed merge decision cannot be deleted'); END`;
});
