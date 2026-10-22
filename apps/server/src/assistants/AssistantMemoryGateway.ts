import { AssistantEventBus } from "./AssistantEventBus.ts";
import {
  type AssistantMemoryReadInput,
  type AssistantMemoryReadResult,
  type AssistantMemoryWriteInput,
  type AssistantMemoryWriteResult,
  type AuthSessionId,
  type ThreadId,
  type AssistantId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { AuthSessionRepository } from "../persistence/AuthSessions.ts";
import { ProjectMemoryService } from "../projectWork/memory/ProjectMemoryService.ts";
import { ProjectMemoryConfiguration } from "../projectWork/memory/ProjectMemoryConfiguration.ts";
import { ProjectMemoryError } from "../projectWork/memory/ProjectMemoryRepository.ts";
import { AssistantMemory } from "./AssistantMemory.ts";
import { AssistantRepository } from "./AssistantRepository.ts";
import { AssistantSettledMemorySource } from "./AssistantMemorySources.ts";
import { AssistantMemoryActivity } from "./AssistantMemoryActivity.ts";
import { assistantThreadIsCurrent } from "./AssistantThreadAuthority.ts";
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bus = yield* Effect.serviceOption(AssistantEventBus);
  const repository = yield* AssistantRepository;
  const memory = yield* AssistantMemory;
  const shared = yield* ProjectMemoryService;
  const config = yield* ProjectMemoryConfiguration;
  const sources = yield* AssistantSettledMemorySource;
  const sessions = yield* AuthSessionRepository;
  const activity = yield* AssistantMemoryActivity;
  const authorize = Effect.fn("AssistantMemoryGateway.authorize")(function* (
    sessionId: AuthSessionId,
    write: boolean,
  ) {
    const session = yield* sessions.getById({ sessionId });
    const now = yield* DateTime.now;
    if (
      Option.isNone(session) ||
      session.value.revokedAt !== null ||
      session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
      !session.value.scopes.includes(
        write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
      )
    )
      return yield* new ProjectMemoryError({ reason: "forbidden" });
  });
  const native = Effect.fn("AssistantMemoryGateway.native")(function* (
    input: { assistantId: AssistantId },
    caller: { threadId: ThreadId; providerSessionId: string },
  ) {
    const record = yield* repository.findByThread(caller.threadId);
    if (
      record === null ||
      record.detail.summary.assistantId !== input.assistantId ||
      record.detail.summary.provisioningState !== "ready"
    )
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    if (
      !(yield* assistantThreadIsCurrent({
        threadId: caller.threadId,
        ...record.detail.summary.binding,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
    )
      return yield* new ProjectMemoryError({ reason: "forbidden" });
    const projects =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id=${record.detail.summary.binding.backingProjectId} AND workspace_root=${record.workspaceRoot} AND deleted_at IS NULL`;
    if (projects.length !== 1) return yield* new ProjectMemoryError({ reason: "forbidden" });
    const rows =
      yield* sql`SELECT r.run_id FROM orchestration_v2_projection_runs r JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=r.provider_thread_id AND p.thread_id=r.thread_id JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=p.provider_session_id JOIN t3_workflow_v2_assistant_admissions a ON a.thread_id=r.thread_id AND a.run_id=r.run_id WHERE r.thread_id=${caller.threadId} AND p.provider_session_id=${caller.providerSessionId} AND a.assistant_id=${input.assistantId} AND r.status IN ('running','waiting') AND s.status NOT IN ('stopped','error') AND json_extract(a.configuration_json,'$.runAttemptId')=json_extract(r.payload_json,'$.activeAttemptId') LIMIT 2`;
    if (rows.length !== 1) return yield* new ProjectMemoryError({ reason: "forbidden" });
  });
  const read = Effect.fn("AssistantMemoryGateway.read")(function* (
    input: AssistantMemoryReadInput,
  ) {
    const record = yield* repository.get(input);
    const scope = {
      environmentId: input.environmentId,
      owner: { kind: "assistant" as const, assistantId: input.assistantId },
      ownerRevision: record.ownerRevision,
    };
    if (input.operation === "recipient")
      return {
        operation: "recipient",
        ...(yield* memory.recipientMetadata({
          environmentId: input.environmentId,
          owner: input.recipient,
        })),
      } satisfies AssistantMemoryReadResult;
    const page = {
      ...scope,
      limit: input.limit ?? 32,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    };
    switch (input.operation) {
      case "confirmations":
        return {
          operation: "confirmations",
          ...(yield* memory.confirmations(page)),
        } satisfies AssistantMemoryReadResult;
      case "list":
        return {
          operation: "list",
          ...(yield* memory.list(page)),
        } satisfies AssistantMemoryReadResult;
      case "status":
        return {
          operation: "status",
          ...(yield* memory.status(scope)),
        } satisfies AssistantMemoryReadResult;
      case "context":
        return {
          operation: "context",
          ...(yield* memory.context(record)),
        } satisfies AssistantMemoryReadResult;
      case "configuration":
        return {
          operation: "configuration",
          ...(yield* config.read(scope)),
        } satisfies AssistantMemoryReadResult;
      case "grants": {
        const grants = yield* shared.listGrants(page);
        return {
          operation: "grants",
          grants,
          nextCursor: grants.length === page.limit ? grants.at(-1)!.id : null,
        } satisfies AssistantMemoryReadResult;
      }
    }
  });
  const write = Effect.fn("AssistantMemoryGateway.write")(function* (
    input: AssistantMemoryWriteInput,
  ) {
    const record = yield* repository.get(input);
    const scope = {
      environmentId: input.environmentId,
      owner: { kind: "assistant" as const, assistantId: input.assistantId },
      ownerRevision: record.ownerRevision,
    };
    switch (input.operation) {
      case "confirm":
        return {
          operation: "confirm",
          source: (yield* memory.confirm({ ...scope, ...input.source })).source,
        } satisfies AssistantMemoryWriteResult;
      case "forget":
        yield* memory.forget({ ...scope, ...input.source });
        break;
      case "edit":
        return {
          operation: "edit",
          source: (yield* memory.edit({
            previous: { ...scope, ...input.source },
            content: input.content,
          })).source,
        } satisfies AssistantMemoryWriteResult;
      case "reteach": {
        const evidence = yield* sources.forRun(
          record.detail.summary.binding.canonicalThreadId,
          input.runId,
        );
        if (evidence === null || evidence.messageId !== input.messageId)
          return yield* new ProjectMemoryError({ reason: "forbidden" });
        return {
          operation: "reteach",
          source: (yield* memory.capture(evidence, { reteach: true })).source,
        } satisfies AssistantMemoryWriteResult;
      }
      case "configure":
        return {
          operation: "configure",
          configurationRevision: yield* config.set(
            scope,
            input.expectedRevision,
            input.configuration,
          ),
        } satisfies AssistantMemoryWriteResult;
      case "grant":
      case "revoke": {
        const source = {
          owner: scope.owner,
          sourceId: input.source.sourceId,
          sourceRevision: input.source.sourceRevision,
        };
        if (!(yield* shared.readSource({ ...scope, ...input.source })))
          return yield* new ProjectMemoryError({ reason: "stale" });
        const grant = {
          ...scope,
          source,
          recipient: input.recipient,
          recipientRevision: input.recipientRevision,
        };
        if (input.operation === "grant") {
          const recipient = yield* memory.recipientMetadata({
            environmentId: input.environmentId,
            owner: input.recipient,
          });
          if (recipient.ownerRevision !== input.recipientRevision)
            return yield* new ProjectMemoryError({ reason: "stale" });
          return {
            operation: "grant",
            grant: yield* memory.grant(grant),
          } satisfies AssistantMemoryWriteResult;
        }
        yield* memory.revoke({ ...grant, grantId: input.grantId });
        break;
      }
    }
    return { operation: input.operation } satisfies AssistantMemoryWriteResult;
  });
  return {
    read: Effect.fn("AssistantMemoryGateway.readHuman")(function* (
      input: AssistantMemoryReadInput,
      sessionId: AuthSessionId,
    ) {
      return yield* sql.withTransaction(
        authorize(sessionId, false).pipe(Effect.andThen(read(input))),
      );
    }),
    write: Effect.fn("AssistantMemoryGateway.writeHuman")(function* (
      input: AssistantMemoryWriteInput,
      sessionId: AuthSessionId,
    ) {
      const result = yield* sql.withTransaction(
        authorize(sessionId, true).pipe(Effect.andThen(write(input))),
      );
      yield* activity.wake;
      if (Option.isSome(bus)) yield* bus.value.publish(input);
      return result;
    }),
    readNative: Effect.fn("AssistantMemoryGateway.readNative")(function* (
      input: AssistantMemoryReadInput,
      caller: { threadId: ThreadId; providerSessionId: string },
    ) {
      if (!["list", "context", "status"].includes(input.operation))
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      return yield* sql.withTransaction(native(input, caller).pipe(Effect.andThen(read(input))));
    }),
    writeNative: Effect.fn("AssistantMemoryGateway.writeNative")(function* (
      input: AssistantMemoryWriteInput,
      caller: { threadId: ThreadId; providerSessionId: string },
    ) {
      if (input.operation !== "forget")
        return yield* new ProjectMemoryError({ reason: "forbidden" });
      const result = yield* sql.withTransaction(
        native(input, caller).pipe(Effect.andThen(write(input))),
      );
      yield* activity.wake;
      if (Option.isSome(bus)) yield* bus.value.publish(input);
      return result;
    }),
  };
});
export class AssistantMemoryGateway extends Context.Service<
  AssistantMemoryGateway,
  Effect.Success<typeof make>
>()("t3/assistants/AssistantMemoryGateway") {}
export const layer = Layer.effect(AssistantMemoryGateway, make);
