import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantError } from "./AssistantRepository.ts";

// These checks also protect reservations whose canonical thread has not been created yet.
export const assertOrdinaryAssistantDestination = Effect.fn(
  "AssistantGuards.assertOrdinaryDestination",
)(function* (input: { readonly projectId?: ProjectId; readonly threadId?: ThreadId }) {
  const sql = yield* SqlClient.SqlClient;
  const schema =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='t3_workflow_v2_assistants'`;
  if (schema.length === 0) {
    const ledger =
      yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='t3_workflow_v2_migrations'`;
    if (ledger.length === 0) return;
    if (
      (yield* sql`SELECT migration_id FROM t3_workflow_v2_migrations WHERE migration_id=14`)
        .length === 0
    )
      return;
    return yield* new AssistantError({
      reason: "unavailable",
      cause: "Assistant ownership schema is missing.",
    });
  }
  const rows =
    yield* sql`SELECT assistant_id FROM t3_workflow_v2_assistants WHERE project_id=${input.projectId ?? ""} OR thread_id=${input.threadId ?? ""} LIMIT 1`;
  if (rows.length !== 0)
    return yield* new AssistantError({
      reason: "forbidden",
      cause: "This workspace is owned by an assistant. Use its assistant controls.",
    });
});
