import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_work_evidence ADD COLUMN scope_hash TEXT`;
  yield* sql`ALTER TABLE project_work_evidence ADD COLUMN output_artifact_ids_json TEXT`;
  // Earlier binaries retained these fields in events but omitted them from evidence rows.
  yield* sql`UPDATE project_work_evidence SET
    scope_hash = (
      SELECT json_extract(event.payload_json, '$.evidence.scopeHash')
      FROM project_work_events event
      WHERE event.project_id = project_work_evidence.project_id
        AND event.event_type = 'project-work.evidence.added'
        AND json_extract(event.payload_json, '$.evidence.evidenceId') = project_work_evidence.evidence_id
      ORDER BY event.sequence DESC LIMIT 1
    ),
    output_artifact_ids_json = (
      SELECT json_extract(event.payload_json, '$.evidence.outputArtifactIds')
      FROM project_work_events event
      WHERE event.project_id = project_work_evidence.project_id
        AND event.event_type = 'project-work.evidence.added'
        AND json_extract(event.payload_json, '$.evidence.evidenceId') = project_work_evidence.evidence_id
      ORDER BY event.sequence DESC LIMIT 1
    )`;
});
