import type { AssistantResolveThreadInput, AssistantThreadOwner } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment/ServerEnvironment.ts";
import { AssistantError, AssistantRecord } from "./AssistantRepository.ts";
import * as Repository from "./AssistantRepository.ts";
import { assistantThreadIsCurrent } from "./AssistantThreadAuthority.ts";

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(AssistantRecord));
const isAssistantError = Schema.is(AssistantError);

export class AssistantThreadOwnerRead extends Context.Service<
  AssistantThreadOwnerRead,
  {
    readonly resolve: (
      input: AssistantResolveThreadInput,
    ) => Effect.Effect<AssistantThreadOwner | null, AssistantError>;
  }
>()("t3/assistants/AssistantThreadOwnerRead") {}

const make = Effect.gen(function* () {
  const repository = yield* Repository.AssistantRepository;
  const sql = yield* SqlClient.SqlClient;
  const environment = yield* Environment.ServerEnvironment;
  const resolve = Effect.fn("AssistantThreadOwnerRead.resolve")(
    function* (input: AssistantResolveThreadInput) {
      if (input.environmentId !== (yield* environment.getEnvironmentId))
        return yield* new AssistantError({ reason: "forbidden" });
      let record = yield* repository.findByThread(input.threadId);
      const isCanonicalHome = record !== null;
      if (record === null) {
        // Retained receipts identify an owner candidate after stock mutation, but
        // only the current bounded lineage below can authorize a child result.
        const candidates = yield* sql<{
          payload_json: string;
        }>`SELECT a.payload_json FROM t3_workflow_v2_assistants a
          WHERE a.environment_id=${input.environmentId} AND a.project_id=(
            SELECT project_id FROM orchestration_v2_projection_threads
            WHERE thread_id=${input.threadId} AND deleted_at IS NULL AND archived_at IS NULL LIMIT 1)
          UNION SELECT a.payload_json FROM t3_workflow_v2_assistant_admissions r
            JOIN t3_workflow_v2_assistants a ON a.assistant_id=r.assistant_id
            WHERE r.thread_id=${input.threadId} AND a.environment_id=${input.environmentId}
          LIMIT 2`;
        if (candidates.length > 1) return yield* new AssistantError({ reason: "conflict" });
        if (candidates[0] === undefined) return null;
        record = yield* decodeRecord(candidates[0].payload_json);
        const binding = record.detail.summary.binding;
        const home = yield* sql`SELECT t.thread_id FROM orchestration_v2_projection_threads t
          JOIN projection_projects p ON p.project_id=t.project_id
          WHERE t.thread_id=${binding.canonicalThreadId} AND t.project_id=${binding.backingProjectId}
            AND t.deleted_at IS NULL AND t.archived_at IS NULL
            AND p.deleted_at IS NULL AND p.workspace_root=${record.workspaceRoot}`;
        if (home.length !== 1) return null;
        if (
          !(yield* assistantThreadIsCurrent({
            threadId: input.threadId,
            ...record.detail.summary.binding,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
        )
          return null;
      }
      const summary = record.detail.summary;
      return {
        environmentId: input.environmentId,
        threadId: input.threadId,
        assistantId: summary.assistantId,
        backingProjectId: summary.binding.backingProjectId,
        canonicalThreadId: summary.binding.canonicalThreadId,
        configurationRevision: summary.configurationRevision,
        lifecycle: summary.lifecycle,
        provisioningState: summary.provisioningState,
        isCanonicalHome,
      } satisfies AssistantThreadOwner;
    },
    Effect.mapError((cause) =>
      isAssistantError(cause) ? cause : new AssistantError({ reason: "unavailable", cause }),
    ),
  );
  return AssistantThreadOwnerRead.of({ resolve });
});

export const layer = Layer.effect(AssistantThreadOwnerRead, make);
