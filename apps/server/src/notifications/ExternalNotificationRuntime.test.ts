import { it, expect } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RunAttemptId,
  ProjectWorkCriterionId,
  ProjectWorkAttemptId,
  type ProjectTeamRecord,
  type ProjectWorkAttribution,
  ProjectId,
  ProjectWorkBlockerId,
  ProjectWorkCommentId,
  ProjectWorkTaskId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import {
  applyProjectWorkEvents,
  decideProjectWorkCommand,
} from "../projectWork/ProjectWorkDecider.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Bus from "../projectWork/ProjectWorkEventBus.ts";
import * as Query from "../projectWork/ProjectWorkQuery.ts";
import * as Repository from "../projectWork/ProjectWorkRepository.ts";
import * as Dispatcher from "./ExternalNotificationDispatcher.ts";
import * as Runtime from "./ExternalNotificationRuntime.ts";
const at = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("notifications-runtime");
const taskId = ProjectWorkTaskId.make("task");
const attribution: ProjectWorkAttribution = {
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web" },
  recordedAt: at,
};
const infrastructure = Layer.mergeAll(
  Repository.ProjectWorkRepositoryLive,
  Query.ProjectWorkQueryLive,
).pipe(
  Layer.provideMerge(Bus.ProjectWorkEventBusLive),
  Layer.provideMerge(ProjectStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory))),
);
const seed = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("project-created"),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/notifications-runtime",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const repo = yield* Repository.ProjectWorkRepository;
  yield* repo.execute({
    type: "project-work.task.create",
    commandId: CommandId.make("create"),
    projectId,
    taskId,
    title: "Task",
    createdAt: at,
  });
});
const block = Effect.gen(function* () {
  const repo = yield* Repository.ProjectWorkRepository;
  return yield* repo.execute({
    type: "project-work.task.block",
    commandId: CommandId.make("block"),
    projectId,
    taskId,
    blockerId: ProjectWorkBlockerId.make("blocker"),
    reason: "Needs input",
    resolver: "human",
    referenceIds: [],
    blockedAt: at,
  });
});
const commitRecord = Effect.fn("NotificationRuntimeTest.commitRecord")(function* (
  record: ProjectTeamRecord,
) {
  const repo = yield* Repository.ProjectWorkRepository;
  const query = yield* Query.ProjectWorkQuery;
  return yield* repo.execute({
    type: "project-work.foundation.commit",
    commandId: CommandId.make(`record-${record.recordId}-${record.revision}`),
    projectId,
    expectedRevision: yield* query.getProjectRevision(projectId),
    attribution,
    records: [record],
    committedAt: at,
  });
});
const fixture = Effect.gen(function* () {
  const facts = yield* Queue.unbounded<Dispatcher.ExternalNotificationFact>();
  const domain = yield* PubSub.sliding<OrchestrationV2DomainEvent>(64);
  const subscribed = yield* Deferred.make<void>();
  const domainProcessed = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const starts: number[] = [];
  const bus = yield* Bus.ProjectWorkEventBus;
  const workProcessed = yield* Queue.unbounded<Bus.ProjectWorkCommittedEvent>();
  const dependencies = Layer.mergeAll(
    Layer.succeed(Bus.ProjectWorkEventBus, {
      ...bus,
      subscribe: bus.subscribe.pipe(
        Effect.map((stream) =>
          stream.pipe(
            Stream.flatMap((event) =>
              Stream.make(event).pipe(
                Stream.concat(
                  Stream.fromEffect(Queue.offer(workProcessed, event)).pipe(Stream.drain),
                ),
              ),
            ),
          ),
        ),
      ),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.unwrap(
        PubSub.subscribe(domain).pipe(
          Effect.tap(() => Deferred.succeed(subscribed, undefined)),
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(
              Stream.flatMap((event) =>
                Stream.make(event).pipe(
                  Stream.concat(
                    Stream.fromEffect(Queue.offer(domainProcessed, event)).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    }),
    Layer.succeed(Dispatcher.ExternalNotificationDispatcher, {
      start: Effect.sync(() => {
        starts.push(1);
      }),
      notifyCommitted: (fact) => Queue.offer(facts, fact).pipe(Effect.asVoid),
      test: () => Effect.succeed({ status: "delivered" }),
      drain: Effect.void,
    }),
  );
  const runtime = yield* Runtime.ExternalNotificationRuntime.pipe(
    Effect.provide(Runtime.layer.pipe(Layer.provide(dependencies))),
  );
  yield* runtime.start;
  yield* runtime.start;
  yield* Deferred.await(subscribed);
  return { facts, domain, starts, workProcessed, domainProcessed };
});
it.effect("real committed Work mutations publish the exact current attention occurrence", () =>
  Effect.gen(function* () {
    yield* seed;
    const { facts, starts } = yield* fixture;
    const result = yield* block;
    const fact = yield* Queue.take(facts);
    expect(fact.kind).toBe("work-attention");
    if (fact.kind !== "work-attention") throw new Error("Expected Work attention");
    expect(fact.attention.reason).toBe("blocked");
    expect(fact.attention.taskId).toBe(taskId);
    const query = yield* Query.ProjectWorkQuery;
    expect(yield* query.getProjectRevision(projectId)).toBe(result.revision);
    expect(yield* query.listAttention({ projectId, taskId, limit: 8 })).toContainEqual(
      fact.attention,
    );
    expect(starts).toEqual([1]);
  }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);

it.effect(
  "startup does not replay old attention and unrelated committed activity cannot publish it",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* block;
      const { facts, workProcessed } = yield* fixture;
      const repo = yield* Repository.ProjectWorkRepository;
      yield* repo.execute({
        type: "project-work.comment.add",
        commandId: CommandId.make("comment"),
        projectId,
        addedAt: at,
        comment: {
          commentId: ProjectWorkCommentId.make("comment"),
          projectId,
          taskId,
          body: "Unrelated note",
          createdAt: at,
          revision: 0,
        },
      });
      const consumed = yield* Queue.take(workProcessed);
      expect(consumed.event.type).toBe("project-work.comment.added");
      expect(Queue.sizeUnsafe(facts)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);

it.effect("live committed notification messages preserve their persisted message identity", () =>
  Effect.gen(function* () {
    const { facts, domain } = yield* fixture;
    const now = DateTime.makeUnsafe(at);
    const event = {
      type: "message.updated",
      id: EventId.make("notice-event"),
      threadId: ThreadId.make("thread"),
      occurredAt: now,
      payload: {
        id: MessageId.make("persisted-message"),
        threadId: ThreadId.make("thread"),
        runId: null,
        nodeId: null,
        role: "system",
        text: "Notice",
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
        createdBy: "system",
        creationSource: "server",
        notification: {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: "Done",
        },
      },
    } satisfies OrchestrationV2DomainEvent;
    yield* PubSub.publish(domain, event);
    expect(yield* Queue.take(facts)).toEqual({
      kind: "notification",
      messageId: "persisted-message",
      threadId: "thread",
      notification: event.payload.notification,
    });
  }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);

it.effect("actual pending gates and guided questions each publish their committed occurrence", () =>
  Effect.gen(function* () {
    yield* seed;
    const fields = { projectId, revision: 0, generation: 0, updatedAt: at };
    yield* commitRecord({
      ...fields,
      recordId: "role",
      kind: "role-revision",
      status: "available",
      roleId: "coordinator",
      roleRevision: 0,
      role: "coordinator",
      instructions: "",
      skills: [],
      tools: [],
      model: "test",
      memoryAccess: "none",
      delegationDepth: 0,
    });
    yield* commitRecord({
      ...fields,
      recordId: "member",
      kind: "member",
      status: "active",
      name: "Coordinator",
      coordinator: true,
      roleRevisionId: "role",
    });
    const { facts, workProcessed } = yield* fixture;
    const gate = yield* commitRecord({
      ...fields,
      recordId: "gate",
      kind: "gate",
      status: "pending",
      taskId,
      gate: "specification",
      specRevision: 0,
      planRevision: 0,
      contentHash: "spec",
      attribution,
      evidenceIds: [],
    });
    const gateFact = yield* Queue.take(facts);
    expect(gateFact).toEqual({
      kind: "work-attention",
      projectId,
      attention: { taskId, reason: "approval-required", revision: gate.revision },
    });
    yield* Queue.take(workProcessed);
    const question = yield* commitRecord({
      ...fields,
      recordId: "question",
      kind: "question",
      status: "pending",
      taskId,
      senderId: "member",
      targetGateId: "gate",
      targetRevision: 0,
      body: "Which option?",
      choices: [],
    });
    expect(yield* Queue.take(facts)).toEqual({
      kind: "work-attention",
      projectId,
      attention: { taskId, reason: "approval-required", revision: question.revision },
    });
    yield* Queue.take(workProcessed);
    const [oldGate] = gate.events;
    if (oldGate === undefined) throw new Error("Expected gate event");
    const bus = yield* Bus.ProjectWorkEventBus;
    yield* bus.publish([{ cursor: 100, event: oldGate }]);
    yield* Queue.take(workProcessed);
    expect(Queue.sizeUnsafe(facts)).toBe(0);
  }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);

it.effect(
  "pending provider approvals and questions preserve request identity and stop on resolution",
  () =>
    Effect.gen(function* () {
      const { facts, domain, domainProcessed } = yield* fixture;
      const now = DateTime.makeUnsafe(at);
      for (const kind of ["command", "user_input", "mcp-elicitation"] as const) {
        const event = {
          type: "runtime-request.updated",
          id: EventId.make(`event-${kind}`),
          threadId: ThreadId.make("thread"),
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make(`request-${kind}`),
            nodeId: NodeId.make("node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        } satisfies OrchestrationV2DomainEvent;
        yield* PubSub.publish(domain, event);
        const fact = yield* Queue.take(facts);
        expect(fact.kind).toBe("notification");
        if (fact.kind !== "notification") throw new Error("Expected provider notification");
        expect(fact.messageId).toBe(`runtime-request:request-${kind}`);
        expect(fact.threadId).toBe("thread");
        expect(fact.notification.summary).toBe(
          kind === "command" ? "Approval required" : "A question needs an answer",
        );
        yield* Queue.take(domainProcessed);
        yield* PubSub.publish(domain, {
          ...event,
          payload: { ...event.payload, status: "resolved", resolvedAt: now },
        });
        yield* Queue.take(domainProcessed);
        expect(Queue.sizeUnsafe(facts)).toBe(0);
      }
    }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);

it.effect(
  "an open review-finding committed event publishes review attention without exposing its body",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const { facts, workProcessed } = yield* fixture;
      const query = yield* Query.ProjectWorkQuery;
      const revision = yield* query.getProjectRevision(projectId);
      const provenance = {
        reviewTaskId: taskId,
        bindingId: "binding",
        generation: 0,
        memberId: "reviewer",
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId: ThreadId.make("review-thread"),
        sessionId: ProviderSessionId.make("session"),
        runId: RunId.make("run"),
        runAttemptId: RunAttemptId.make("attempt"),
        nodeId: NodeId.make("node"),
        initializeOperationId: "initialize",
        dispatchId: "dispatch",
        targetSha256: "a".repeat(64),
      };
      // Review execution is tested by ProjectTeamReviewFreshness; this fixture tests its committed record boundary.
      const record = {
        projectId,
        recordId: "finding",
        revision: 0,
        generation: 0,
        updatedAt: at,
        kind: "review-finding",
        taskId,
        findingId: "finding",
        severity: "high",
        criterionIds: [ProjectWorkCriterionId.make("criterion")],
        detail: "Private finding body",
        status: "open",
        resolutionArtifactIds: [],
        target: {
          projectId,
          taskId,
          specRevision: 0,
          planRevision: 0,
          baseSha: "base",
          headSha: "head",
        },
        originReviewer: provenance,
        reportedBy: provenance,
      } satisfies ProjectTeamRecord;
      const bus = yield* Bus.ProjectWorkEventBus;
      yield* bus.publish([
        {
          cursor: 100,
          event: {
            type: "project-work.foundation.recorded",
            eventId: EventId.make("finding-event"),
            projectId,
            revision,
            occurredAt: at,
            record,
          },
        },
      ]);
      expect(yield* Queue.take(facts)).toEqual({
        kind: "work-attention",
        projectId,
        attention: { taskId, reason: "needs-review", revision },
      });
      yield* Queue.take(workProcessed);
      yield* bus.publish([
        {
          cursor: 101,
          event: {
            type: "project-work.foundation.recorded",
            eventId: EventId.make("finding-resolved"),
            projectId,
            revision,
            occurredAt: at,
            record: {
              ...record,
              status: "resolved",
              resolutionArtifactIds: ["resolution"],
              revision: 1,
            },
          },
        },
      ]);
      yield* Queue.take(workProcessed);
      expect(Queue.sizeUnsafe(facts)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);

it.effect(
  "protecting a current specification publishes its newly persisted approval attention",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const repo = yield* Repository.ProjectWorkRepository;
      const criterionId = ProjectWorkCriterionId.make("criterion");
      yield* repo.execute({
        type: "project-work.criterion.upsert",
        commandId: CommandId.make("criterion"),
        projectId,
        taskId,
        updatedAt: at,
        criterion: {
          criterionId,
          taskId,
          description: "Required result",
          required: true,
          status: "unsatisfied",
          satisfiedByEvidenceIds: [],
          revision: 0,
          updatedAt: at,
        },
      });
      yield* repo.execute({
        type: "project-work.task.specify",
        commandId: CommandId.make("specify"),
        projectId,
        taskId,
        specification: {
          objective: "Result",
          scopeIn: "This task",
          scopeOut: "Other tasks",
          criterionIds: [criterionId],
          revision: 0,
          protected: false,
        },
        updatedAt: at,
      });
      const { facts } = yield* fixture;
      yield* repo.execute({
        type: "project-work.task.protect-specification",
        commandId: CommandId.make("protect"),
        projectId,
        taskId,
        specRevision: 0,
        protectedAt: at,
      });
      const fact = yield* Queue.take(facts);
      expect(fact.kind).toBe("work-attention");
      if (fact.kind !== "work-attention") throw new Error("Expected approval attention");
      expect(fact.attention.reason).toBe("approval-required");
      const query = yield* Query.ProjectWorkQuery;
      expect(yield* query.listAttention({ projectId, taskId, limit: 8 })).toContainEqual(
        fact.attention,
      );
    }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);

it.effect(
  "an existing lease becoming stale on a committed watch uses the reducer's persisted occurrence",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const base = yield* Repository.readCurrentState(sql, projectId);
      const attemptId = ProjectWorkAttemptId.make("lease-attempt");
      const source = {
        ...base,
        tasks: base.tasks.map((task) => ({
          ...task,
          state: "in-progress" as const,
          activeAttemptId: attemptId,
        })),
        attempts: [
          {
            attemptId,
            taskId,
            state: "running" as const,
            leaseToken: "lease",
            leasedUntil: at,
            checkpointIds: [],
            revision: 0,
          },
        ],
      };
      const events = decideProjectWorkCommand(source, {
        type: "project-work.task.watch",
        commandId: CommandId.make("watch"),
        projectId,
        taskId,
        watcher: attribution.actor,
        watchedAt: at,
      });
      const next = applyProjectWorkEvents(source, events);
      expect(next.attention[0]?.reason).toBe("stale");
      // Exercise the same committed-event/query boundary as production without starting a lease timer.
      const { facts } = yield* fixture.pipe(
        Effect.provide(
          Layer.mock(Query.ProjectWorkQuery)({
            listAttention: () => Effect.succeed(next.attention),
            withProjectRevision: (_projectId, read) =>
              read.pipe(Effect.map((value) => ({ value, revision: next.revision }))),
          }),
        ),
      );
      const bus = yield* Bus.ProjectWorkEventBus;
      yield* bus.publish(events.map((event, cursor) => ({ event, cursor })));
      expect(yield* Queue.take(facts)).toEqual({
        kind: "work-attention",
        projectId,
        attention: next.attention[0],
      });
    }).pipe(Effect.scoped, Effect.provide(infrastructure)),
);
