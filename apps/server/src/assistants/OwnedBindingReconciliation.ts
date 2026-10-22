import { ProjectTeamRunBinding } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  appendAdmissionFoundationRecords,
  readCurrentState,
} from "../projectWork/ProjectWorkRepository.ts";
import { ProjectWorkEventBus } from "../projectWork/ProjectWorkEventBus.ts";
import { decodeProjectWorkEvent } from "../projectWork/ProjectWorkEventStore.ts";

export const reconcileWorkBindings = Effect.fn("OwnedBindingReconciliation.reconcileWorkBindings")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const bus = yield* ProjectWorkEventBus;
    const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectTeamRunBinding));
    const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
    let afterProject = "";
    let after = "";
    for (;;) {
      const rows = yield* sql<{
        record_id: string;
        project_id: string;
        payload_json: string;
      }>`SELECT record_id,project_id,payload_json FROM t3_workflow_v2_team_records WHERE kind='run-binding' AND (project_id>${afterProject} OR (project_id=${afterProject} AND record_id>${after})) AND json_extract(payload_json,'$.status') IN ('reserved','running','stopping') ORDER BY project_id,record_id LIMIT 128`;
      if (rows.length === 0) break;
      for (const row of rows) {
        const captured = yield* decode(row.payload_json);
        const commandId = `stock-target:${row.record_id}:${captured.revision}`;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* readCurrentState(sql, row.project_id);
            const binding = current.foundationRecords?.find(
              (value) => value.kind === "run-binding" && value.recordId === row.record_id,
            );
            if (
              binding?.kind !== "run-binding" ||
              binding.revision !== captured.revision ||
              binding.status === "quarantined" ||
              binding.status === "settled" ||
              binding.status === "revoked"
            )
              return;
            const project = (yield* sql<{
              workspace_root: string;
            }>`SELECT workspace_root FROM projection_projects WHERE project_id=${binding.projectId} AND deleted_at IS NULL`)[0];
            const thread = (yield* sql<{
              project_id: string;
              worktree_path: string | null;
            }>`SELECT project_id,json_extract(payload_json,'$.worktreePath') AS worktree_path FROM orchestration_v2_projection_threads WHERE thread_id=${binding.threadId} AND deleted_at IS NULL AND archived_at IS NULL`)[0];
            const run =
              binding.runId === undefined
                ? undefined
                : (yield* sql`SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id=${binding.threadId} AND run_id=${binding.runId}`)[0];
            if (
              project !== undefined &&
              thread !== undefined &&
              thread.project_id === binding.projectId &&
              (binding.workspaceState !== "ready" ||
                (thread.worktree_path ?? project.workspace_root) === binding.worktree) &&
              (binding.runId === undefined || run !== undefined)
            )
              return;
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* appendAdmissionFoundationRecords(
              sql,
              row.project_id,
              commandId,
              [
                {
                  ...binding,
                  status: "quarantined",
                  revision: binding.revision + 1,
                  leaseGeneration: binding.leaseGeneration + 1,
                  updatedAt: now,
                },
              ],
              now,
            );
          }),
        );
        const events = yield* sql<{
          sequence: number;
          payload_json: string;
        }>`SELECT sequence,payload_json FROM t3_workflow_v2_work_events WHERE project_id=${row.project_id} AND command_id=${`admission:${commandId}`} ORDER BY sequence`;
        const published = yield* Effect.forEach(events, (event) =>
          Effect.gen(function* () {
            return {
              cursor: event.sequence,
              event: decodeProjectWorkEvent(yield* decodeEvent(event.payload_json)),
            };
          }),
        );
        yield* bus.publish(published);
      }
      after = rows.at(-1)!.record_id;
      afterProject = rows.at(-1)!.project_id;
    }
  },
);
