import {
  AssistantConfigurationSnapshot,
  MessageId,
  RunId,
  RunAttemptId,
  ThreadId,
  canonicalProjectWorkPayload,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectMemoryError } from "../projectWork/memory/ProjectMemoryRepository.ts";
import { AssistantRepository } from "./AssistantRepository.ts";
import { AssistantMemoryEvidence, AssistantMemorySources } from "./AssistantMemory.ts";

const decodeAdmission = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      configuration: AssistantConfigurationSnapshot,
      runAttemptId: Schema.NullOr(RunAttemptId),
    }),
  ),
);
const isMemoryError = Schema.is(ProjectMemoryError);
const decodeEvidence = Schema.decodeUnknownEffect(AssistantMemoryEvidence);
const unavailable = (cause: unknown) =>
  isMemoryError(cause) ? cause : new ProjectMemoryError({ reason: "unavailable", cause });
export class AssistantSettledMemorySource extends Context.Service<
  AssistantSettledMemorySource,
  {
    readonly forRun: (
      threadId: ThreadId,
      runId: RunId,
    ) => Effect.Effect<AssistantMemoryEvidence | null, ProjectMemoryError>;
  }
>()("t3/assistants/AssistantMemorySources/AssistantSettledMemorySource") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* AssistantRepository;
  const projections = yield* ProjectionStoreV2;
  const environment = yield* ServerEnvironment;
  const resolve = Effect.fn("AssistantMemorySources.resolve")(function* (input: {
    threadId: ThreadId;
    messageId: MessageId;
    runId: RunId;
  }) {
    const owner = yield* repository.findByThread(input.threadId);
    if (
      owner === null ||
      owner.workspaceRoot === null ||
      owner.detail.summary.provisioningState !== "ready"
    )
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const shell = yield* projections.getThreadShell(input.threadId);
    const binding = owner.detail.summary.binding;
    const project =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${binding.backingProjectId} AND workspace_root=${owner.workspaceRoot} AND deleted_at IS NULL`;
    if (
      project.length !== 1 ||
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      shell.projectId !== binding.backingProjectId ||
      (shell.worktreePath !== null && shell.worktreePath !== owner.workspaceRoot)
    )
      return yield* new ProjectMemoryError({ reason: "stale" });
    const records = yield* projections.getThreadRecords(input.threadId, ["messages", "runs"], {
      messageIds: [input.messageId],
      runIds: [input.runId],
    });
    const message = records.messages.find((value) => value.id === input.messageId);
    const run = records.runs.find((value) => value.id === input.runId);
    if (
      message === undefined ||
      run === undefined ||
      run.userMessageId !== message.id ||
      message.runId !== run.id ||
      message.role !== "user" ||
      message.createdBy !== "user" ||
      message.streaming ||
      message.workflowScript ||
      message.delegatedCompletion !== undefined ||
      run.completedAt === null ||
      !["completed", "interrupted", "failed", "cancelled"].includes(run.status)
    )
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const admission = (yield* sql<{
      configuration_json: string;
      configuration_revision: number;
    }>`SELECT configuration_json,configuration_revision FROM t3_workflow_v2_assistant_admissions WHERE thread_id=${input.threadId} AND run_id=${input.runId} AND assistant_id=${binding.assistantId}`)[0];
    if (admission === undefined) return yield* new ProjectMemoryError({ reason: "forbidden" });
    const captured = yield* decodeAdmission(admission.configuration_json);
    if (run.activeAttemptId === null || captured.runAttemptId !== run.activeAttemptId)
      return yield* new ProjectMemoryError({ reason: "stale" });
    const retained = captured.configuration;
    if (
      retained.revision !== admission.configuration_revision ||
      canonicalProjectWorkPayload(retained.configuration.modelSelection) !==
        canonicalProjectWorkPayload(run.modelSelection)
    )
      return yield* new ProjectMemoryError({ reason: "stale" });
    return yield* decodeEvidence({
      environmentId: binding.environmentId,
      assistantId: binding.assistantId,
      ownerRevision: owner.ownerRevision,
      configurationRevision: admission.configuration_revision,
      threadId: input.threadId,
      messageId: input.messageId,
      runId: input.runId,
      runAttemptId: run.activeAttemptId,
      content: message.text,
      settledAt: DateTime.formatIso(run.completedAt),
      modelSelection: retained.configuration.modelSelection,
      cwd: owner.workspaceRoot,
    });
  });
  const verify = Effect.fn("AssistantMemorySources.verify")(function* (
    evidence: AssistantMemoryEvidence,
  ) {
    const current = yield* resolve(evidence);
    if (canonicalProjectWorkPayload(current) !== canonicalProjectWorkPayload(evidence))
      return yield* new ProjectMemoryError({ reason: "stale" });
  }, Effect.mapError(unavailable));
  const discover = Effect.fn("AssistantMemorySources.discover")(function* (input: {
    after?: string;
    limit: number;
  }) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 128)
      return yield* new ProjectMemoryError({ reason: "invalid" });
    const environmentId = yield* environment.getEnvironmentId;
    const rows = yield* sql<{
      thread_id: ThreadId;
      message_id: MessageId;
      run_id: RunId;
    }>`SELECT m.thread_id,m.message_id,m.run_id FROM orchestration_v2_projection_messages m JOIN t3_workflow_v2_assistants a ON a.thread_id=m.thread_id WHERE a.environment_id=${environmentId} AND m.message_id>${input.after ?? ""} AND m.run_id IS NOT NULL AND m.role='user' AND m.streaming=0 ORDER BY m.message_id LIMIT ${input.limit}`;
    const items: AssistantMemoryEvidence[] = [];
    for (const row of rows) {
      const resolved = yield* resolve({
        threadId: row.thread_id,
        messageId: row.message_id,
        runId: row.run_id,
      }).pipe(
        Effect.catchIf(
          (cause) =>
            isMemoryError(cause) && (cause.reason === "forbidden" || cause.reason === "stale"),
          () => Effect.succeed(null),
        ),
      );
      if (resolved !== null) items.push(resolved);
    }
    return { items, nextCursor: rows.length < input.limit ? null : rows.at(-1)!.message_id };
  }, Effect.mapError(unavailable));
  const forRun = Effect.fn("AssistantMemorySources.forRun")(function* (
    threadId: ThreadId,
    runId: RunId,
  ) {
    const records = yield* projections.getThreadRecords(threadId, ["runs"], { runIds: [runId] });
    const run = records.runs.find((value) => value.id === runId);
    if (run === undefined) return null;
    return yield* resolve({ threadId, runId, messageId: run.userMessageId }).pipe(
      Effect.catchIf(
        (cause) =>
          isMemoryError(cause) && (cause.reason === "forbidden" || cause.reason === "stale"),
        () => Effect.succeed(null),
      ),
    );
  }, Effect.mapError(unavailable));
  return Context.make(AssistantMemorySources, { verify, discover }).pipe(
    Context.add(AssistantSettledMemorySource, { forRun }),
  );
});
export const layer = Layer.effectContext(make);
