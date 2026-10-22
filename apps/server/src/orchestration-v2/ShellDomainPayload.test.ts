import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  OrchestrationV2RpcSchemas,
  ProjectId,
  ProjectWorkCommentId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as AssistantRepository from "../assistants/AssistantRepository.ts";
import { configuration } from "../assistants/AssistantTestHelpers.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Work from "../projectWork/ProjectWorkRepository.ts";
import { memoryHash } from "../projectWork/memory/ProjectMemoryRepository.ts";
import * as Memory from "../projectWork/memory/ProjectMemoryService.ts";
import {
  at,
  env,
  human,
  layer as memoryLayer,
  projectId,
  seed,
} from "../projectWork/memory/ProjectMemoryService.test-utils.ts";
import * as Projects from "./ProjectStore.ts";
import * as Projection from "./ProjectionStore.ts";
import { buildActiveShellSnapshot, loadShellSnapshotParts } from "./ShellStream.ts";
import { THREAD_HISTORY_PAGE_POLICY } from "./threadHistoryPaging.ts";

// Exceed the assistant roster's 100-record page while preserving every ordinary shell row.
const OWNER_COUNT = 101;
const NOW = DateTime.makeUnsafe(at);
const ordinaryThreadId = ThreadId.make("ordinary-history");
const providerInstanceId = ProviderInstanceId.make("codex");
const encodeFrame = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2RpcSchemas.subscribeShell.output),
);
const layer = Layer.mergeAll(Projection.layer, AssistantRepository.layer, Events.layer).pipe(
  Layer.provideMerge(memoryLayer),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(env),
      getDescriptor: Effect.die("descriptor is not part of a shell read"),
    }),
  ),
);

const populateAndRead = Effect.fn("ShellDomainPayloadTest.populateAndRead")(function* (
  repetitions: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* Projects.ProjectStoreV2;
  const projection = yield* Projection.ProjectionStoreV2;
  const assistants = yield* AssistantRepository.AssistantRepository;
  const work = yield* Work.ProjectWorkRepository;
  const memory = yield* Memory.ProjectMemoryService;
  const events = yield* Events.OrchestrationEventStore;
  yield* seed();

  const addThread = Effect.fn("ShellDomainPayloadTest.addThread")(function* (
    threadId: ThreadId,
    ownerProjectId: ProjectId,
  ) {
    yield* projection.apply({
      id: EventId.make(`thread-${threadId}`),
      type: "thread.created",
      threadId,
      occurredAt: NOW,
      payload: {
        id: threadId,
        projectId: ownerProjectId,
        title: "Shell row",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-6-astra" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        deletedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
      },
    });
  });
  yield* addThread(ordinaryThreadId, projectId);

  for (let index = 0; index < OWNER_COUNT; index++) {
    const record = yield* assistants.create({
      environmentId: env,
      commandId: CommandId.make(`assistant-${index}`),
      configuration: {
        ...configuration,
        name: `Assistant ${index}`,
        prompt: "PRIVATE_ASSISTANT_CONFIGURATION ".repeat(repetitions),
      },
    });
    const binding = record.detail.summary.binding;
    yield* projects.apply({
      sequence: index + 2,
      eventId: EventId.make(`project-${index}`),
      aggregateKind: "project",
      aggregateId: binding.backingProjectId,
      occurredAt: at,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: binding.backingProjectId,
        title: record.detail.summary.name,
        workspaceRoot: `/fixture/${binding.backingProjectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: at,
        updatedAt: at,
      },
    });
    yield* addThread(binding.canonicalThreadId, binding.backingProjectId);
    yield* assistants.setProvisioning(
      { environmentId: env, assistantId: binding.assistantId },
      { state: "ready", binding },
      `/fixture/${binding.backingProjectId}`,
    );

    const taskId = ProjectWorkTaskId.make(`task-${index}`);
    yield* work.execute({
      type: "project-work.task.create",
      projectId,
      taskId,
      commandId: CommandId.make(`task-${index}`),
      title: `Task ${index}`,
      createdAt: at,
      attribution: human,
    });
    for (const kind of ["WORK_DETAIL", "DOMAIN_MEMORY"] as const) {
      const commentId = ProjectWorkCommentId.make(`${kind}-${index}`);
      const body = `PRIVATE_${kind} `.repeat(repetitions);
      yield* work.execute({
        type: "project-work.comment.add",
        projectId,
        commandId: CommandId.make(commentId),
        comment: {
          commentId,
          projectId,
          taskId,
          body,
          revision: 0,
          createdAt: at,
          attribution: human,
        },
        addedAt: at,
        attribution: human,
      });
      if (kind === "DOMAIN_MEMORY") {
        yield* memory.capture({
          environmentId: env,
          owner: { kind: "project", projectId },
          ownerRevision: 0,
          reference: { kind: "comment", retainedId: commentId, retainedRevision: 0, taskId },
          selection: {
            owner: { kind: "project", projectId },
            ownerRevision: 0,
            kind: "comment",
            retainedId: commentId,
            retainedRevision: 0,
            sourceRecordId: `memory-${index}`,
            expectedSourceRecordRevision: 0,
            sourceRevision: 0,
            sourceGeneration: 0,
            contentHash: memoryHash(body),
            effectId: `capture-${index}`,
            expectedEffectRevision: 0,
            expectedClaimGeneration: 0,
          },
          now: at,
        });
      }
    }
  }

  const historyCount = THREAD_HISTORY_PAGE_POLICY.maxItems + 1;
  for (let index = 0; index < historyCount; index++) {
    const messageId = MessageId.make(`history-${index}`);
    const text = "PRIVATE_TRANSCRIPT ".repeat(repetitions);
    yield* projection.apply({
      id: EventId.make(`message-${index}`),
      type: "message.updated",
      threadId: ordinaryThreadId,
      occurredAt: NOW,
      payload: {
        id: messageId,
        threadId: ordinaryThreadId,
        runId: null,
        nodeId: null,
        role: "user",
        text,
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    yield* projection.apply({
      id: EventId.make(`item-${index}`),
      type: "turn-item.updated",
      threadId: ordinaryThreadId,
      occurredAt: NOW,
      payload: {
        id: TurnItemId.make(`history-${index}`),
        threadId: ordinaryThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        type: "user_message",
        title: "User message",
        status: "completed",
        messageId,
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        startedAt: NOW,
        completedAt: NOW,
        updatedAt: NOW,
      },
    });
  }

  const snapshot = buildActiveShellSnapshot(
    yield* loadShellSnapshotParts({
      sql,
      readThreads: projection.readShellSnapshot({ location: "active" }),
      listProjects: projects.listShells(),
      latestSequence: events.latestApplicationSequence,
    }),
  );
  assert.equal(snapshot.projects.length, OWNER_COUNT + 1);
  assert.equal(snapshot.threads.length, OWNER_COUNT + 1);
  assert.equal(
    snapshot.threads.find((row) => row.id === ordinaryThreadId)?.visibleItemCount,
    historyCount,
  );
  assert.equal(
    (yield* assistants.list({ environmentId: env, includeArchived: false, limit: 100 })).length,
    100,
  );
  assert.equal(
    (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_assistants WHERE provisioning_state='ready'`)[0]
      ?.n,
    OWNER_COUNT,
  );
  assert.equal(
    (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_work_tasks`)[0]?.n,
    OWNER_COUNT + 1,
  );
  assert.equal(
    (yield* sql`SELECT body FROM t3_workflow_v2_work_comments WHERE comment_id='WORK_DETAIL-0'`)[0]
      ?.body,
    "PRIVATE_WORK_DETAIL ".repeat(repetitions),
  );
  assert.equal(
    (yield* sql`SELECT count(*) AS n FROM t3_workflow_v2_memory_sources WHERE status='current' AND owner_kind='project'`)[0]
      ?.n,
    OWNER_COUNT,
  );
  const recalled = yield* memory.listCurrent({
    environmentId: env,
    owner: { kind: "project", projectId },
    ownerRevision: 0,
    limit: 100,
  });
  assert.equal(recalled.length, 100);
  assert.equal(recalled[0]?.content, "PRIVATE_DOMAIN_MEMORY ".repeat(repetitions));
  const transcript = yield* projection.getThreadRecords(ordinaryThreadId, ["messages"]);
  assert.equal(transcript.messages.length, historyCount);
  assert.equal(transcript.messages[0]?.text, "PRIVATE_TRANSCRIPT ".repeat(repetitions));
  const frame = JSON.stringify({
    _tag: "Chunk",
    requestId: 0,
    values: [encodeFrame({ kind: "snapshot", snapshot })],
  });
  for (const sentinel of [
    "PRIVATE_WORK_DETAIL",
    "PRIVATE_DOMAIN_MEMORY",
    "PRIVATE_TRANSCRIPT",
    "PRIVATE_ASSISTANT_CONFIGURATION",
  ])
    assert.notInclude(frame, sentinel);
  return {
    frame,
    threadIds: snapshot.threads.map((row) => row.id).toSorted(),
    projectIds: snapshot.projects.map((row) => row.id).toSorted(),
  };
});

it.effect(
  "ordinary SQL shell snapshots exclude persisted Work, assistant and owner-scoped memory bodies at scale",
  () =>
    Effect.gen(function* () {
      const short = yield* populateAndRead(1).pipe(Effect.provide(layer));
      const large = yield* populateAndRead(512).pipe(Effect.provide(layer));
      assert.deepStrictEqual(large, short);
      assert.isBelow(
        Buffer.byteLength(large.frame, "utf8"),
        THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
      );
    }),
);
