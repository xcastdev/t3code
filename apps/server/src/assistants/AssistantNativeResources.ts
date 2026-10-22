import { type ThreadId, OrchestrationV2InstructionSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { AssistantRecord } from "./AssistantRepository.ts";
import { assistantThreadIsCurrent } from "./AssistantThreadAuthority.ts";

export class AssistantNativeResources extends Context.Service<
  AssistantNativeResources,
  {
    readonly tools: (
      threadId: ThreadId,
      providerSessionId: string,
    ) => Effect.Effect<ReadonlyArray<string> | undefined>;
  }
>()("t3/assistants/AssistantNativeResources") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantRecord));
  const decodeSnapshot = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Struct({ snapshot: OrchestrationV2InstructionSnapshot })),
  );
  return AssistantNativeResources.of({
    tools: Effect.fn("AssistantNativeResources.tools")(
      function* (threadId, providerSessionId) {
        const row = (yield* sql<{
          payload_json: string;
        }>`SELECT DISTINCT a.payload_json FROM t3_workflow_v2_assistants a LEFT JOIN orchestration_v2_projection_threads t ON t.project_id=a.project_id LEFT JOIN t3_workflow_v2_assistant_admissions r ON r.assistant_id=a.assistant_id WHERE a.thread_id=${threadId} OR t.thread_id=${threadId} OR r.thread_id=${threadId} LIMIT 1`)[0];
        if (row === undefined) return undefined;
        const record = yield* decode(row.payload_json);
        if (record.detail.summary.provisioningState !== "ready") return [];
        const binding = record.detail.summary.binding;
        const home =
          yield* sql`SELECT t.thread_id FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id WHERE t.thread_id=${binding.canonicalThreadId} AND t.project_id=${binding.backingProjectId} AND t.deleted_at IS NULL AND t.archived_at IS NULL AND p.deleted_at IS NULL AND p.workspace_root=${record.workspaceRoot}`;
        if (home.length !== 1) return [];
        if (
          !(yield* assistantThreadIsCurrent({ threadId, ...binding }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          ))
        )
          return [];
        const admitted = (yield* sql<{
          configuration_json: string;
        }>`SELECT a.configuration_json FROM t3_workflow_v2_assistant_admissions a JOIN orchestration_v2_projection_runs r ON r.thread_id=a.thread_id AND r.run_id=a.run_id JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id AND p.thread_id=a.thread_id WHERE a.thread_id=${threadId} AND p.provider_session_id=${providerSessionId} AND r.status IN ('starting','running','waiting') ORDER BY r.ordinal DESC LIMIT 1`)[0];
        if (admitted === undefined) return [];
        const snapshot = (yield* decodeSnapshot(admitted.configuration_json)).snapshot;
        const current = new Set(
          record.detail.configuration.configuration.resources.mcpTools.flatMap((entry) =>
            entry.toolNames.map((name) => `${entry.definitionId}:${name}`),
          ),
        );
        return snapshot.toolIds.filter((id) => current.has(id));
      },
      Effect.catch(() => Effect.succeed([])),
    ),
  });
});
export const layer = Layer.effect(AssistantNativeResources, make);
