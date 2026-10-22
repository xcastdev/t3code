import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const assistantThreadIsCurrent = Effect.fn("AssistantThreadAuthority.isCurrent")(
  function* (input: {
    threadId: ThreadId;
    canonicalThreadId: ThreadId;
    backingProjectId: ProjectId;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const seen = new Set<string>();
    let id = input.threadId;
    for (;;) {
      if (seen.has(id) || seen.size >= 9) return false;
      seen.add(id);
      const rows = yield* sql<{
        parent_thread_id: ThreadId | null;
      }>`SELECT json_extract(payload_json,'$.lineage.parentThreadId') AS parent_thread_id FROM orchestration_v2_projection_threads WHERE thread_id=${id} AND project_id=${input.backingProjectId} AND deleted_at IS NULL AND archived_at IS NULL`;
      if (rows.length !== 1) return false;
      if (id === input.canonicalThreadId) return true;
      const parent = rows[0]!.parent_thread_id;
      if (parent === null) return false;
      id = parent;
    }
  },
);
