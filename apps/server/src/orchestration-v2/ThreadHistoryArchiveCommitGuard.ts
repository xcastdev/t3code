import {
  type ThreadId,
  ProjectId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2RunJson,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AssistantPolicy from "./ThreadHistoryRecoveryAssistantPolicy.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { assertOrdinaryAssistantDestination } from "../assistants/AssistantGuards.ts";
import { HistoryArchiveError } from "./ThreadHistoryArchiveService.ts";

export class HistoryArchiveCommitGuard extends Context.Reference<
  | {
      readonly threadId: ThreadId;
      readonly archiveId: string;
      readonly assistantStamp?: AssistantPolicy.AssistantArchiveRecoveryStamp;
      readonly rows: ReadonlyArray<{
        readonly kind: string;
        readonly sourceId: string;
        readonly payload: string;
      }>;
    }
  | undefined
>("t3/orchestration-v2/HistoryArchiveCommitGuard", { defaultValue: () => undefined }) {}

// Runs inside EventSink's writer transaction, so release cannot invalidate a verified source before its command commits.
export const validateHistoryArchiveCommit = Effect.fn("ThreadHistoryArchive.validateCommit")(
  function* () {
    const guard = yield* HistoryArchiveCommitGuard;
    if (guard === undefined) return;
    const sql = yield* SqlClient.SqlClient;
    const archives = yield* sql<{
      state: string;
    }>`SELECT state FROM t3_workflow_v2_history_archives WHERE archive_id=${guard.archiveId} AND thread_id=${guard.threadId}`;
    if (!archives[0] || !["ready", "executing", "completed"].includes(archives[0].state))
      return yield* new HistoryArchiveError({ reason: "conflict" });
    const current = yield* sql<{
      project_id: string;
    }>`SELECT project_id FROM orchestration_v2_projection_threads WHERE thread_id=${guard.threadId} AND deleted_at IS NULL`;
    if (!current[0]) return yield* new HistoryArchiveError({ reason: "conflict" });
    if (guard.assistantStamp !== undefined) {
      const policy = yield* Effect.serviceOption(
        AssistantPolicy.ThreadHistoryRecoveryAssistantPolicy,
      );
      if (
        Option.isNone(policy) ||
        guard.assistantStamp.threadId !== guard.threadId ||
        guard.assistantStamp.projectId !== current[0].project_id
      )
        return yield* new HistoryArchiveError({ reason: "conflict" });
      yield* policy.value.assertCurrent(guard.assistantStamp);
    } else
      yield* assertOrdinaryAssistantDestination({
        threadId: guard.threadId,
        projectId: ProjectId.make(current[0].project_id),
      });
    const active =
      yield* sql`SELECT 1 FROM orchestration_v2_projection_runs WHERE thread_id=${guard.threadId} AND status NOT IN ('completed','failed','cancelled','interrupted','rolled_back') LIMIT 1`;
    if (active.length) return yield* new HistoryArchiveError({ reason: "conflict" });

    for (const row of guard.rows) {
      const fragments = yield* sql<{
        payload: string;
      }>`SELECT payload FROM t3_workflow_v2_history_archive_rows WHERE archive_id=${guard.archiveId} AND kind=${row.kind} AND source_id=${row.sourceId} ORDER BY fragment`;
      if (fragments.map((fragment) => fragment.payload).join("") !== row.payload)
        return yield* new HistoryArchiveError({ reason: "conflict" });
    }
  },
  Effect.mapError((cause) => new HistoryArchiveError({ reason: "conflict", cause })),
);

const decodeStoredRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ payload_json: Schema.String })),
);
const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
export const archivedForkSource = Effect.fn("ThreadHistoryArchive.forkSource")(
  function* (input: { readonly archiveId: string; readonly sourceThreadId: ThreadId }) {
    const guard = yield* HistoryArchiveCommitGuard;
    if (
      guard === undefined ||
      guard.assistantStamp !== undefined ||
      guard.threadId !== input.sourceThreadId ||
      guard.archiveId !== input.archiveId
    )
      return yield* new HistoryArchiveError({ reason: "conflict" });
    const threadRow = guard.rows.find(
      (row) => row.kind === "threads" && row.sourceId === input.sourceThreadId,
    );
    const runRow = guard.rows.find((row) => row.kind === "runs");
    if (!threadRow || !runRow) return yield* new HistoryArchiveError({ reason: "conflict" });
    const thread = yield* decodeThread((yield* decodeStoredRow(threadRow.payload)).payload_json);
    const run = yield* decodeRun((yield* decodeStoredRow(runRow.payload)).payload_json);
    if (run.threadId !== thread.id) return yield* new HistoryArchiveError({ reason: "conflict" });
    return { thread, run };
  },
  Effect.mapError((cause) => new HistoryArchiveError({ reason: "conflict", cause })),
);
