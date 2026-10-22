import {
  ProjectWorkCriterionId,
  ProjectWorkCriterion,
  ProjectWorkTaskRead,
  ProjectWorkDecisionId,
  ProjectWorkDecisionRead,
  ProjectWorkTaskReviseProtectedSpecificationCommand,
  projectWorkPayloadFingerprint,
  projectWorkProtectedRevisionFingerprintPayload,
} from "@t3tools/contracts";
import * as TestClock from "effect/testing/TestClock";
import {
  ProjectWorkCommentId,
  ProjectWorkCommentRead,
  ProjectWorkApprovalId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProjectWorkTaskId,
  ProjectWorkTaskCreateCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Gateway from "./ProjectWorkGateway.ts";
import * as Runtime from "./ProjectWorkRuntime.ts";

const projectId = ProjectId.make("runtime-project");
const environmentId = EnvironmentId.make("runtime-environment");
const human: Gateway.ProjectWorkPrincipal = {
  environmentId,
  projectId,
  actor: { kind: "human", id: "maintainer" },
  source: { kind: "web", id: "client" },
};
const at = "2026-01-01T00:00:00.000Z";
const decodeCriteria = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkCriterion));
const decodeTask = Schema.decodeUnknownEffect(ProjectWorkTaskRead);
const decodeDecisions = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkDecisionRead));
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(ProjectWorkCommentRead));
const create = (id: string): typeof ProjectWorkTaskCreateCommand.Type => ({
  type: "project-work.task.create",
  commandId: CommandId.make(`create-${id}`),
  projectId,
  taskId: ProjectWorkTaskId.make(id),
  title: id,
  createdAt: at,
});
const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused descriptor"),
});
const testLayer = Runtime.coreLayer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provide(environment),
  Layer.provide(Sqlite.layerMemory),
);
const seed = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make("runtime-project-created"),
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
      title: "Runtime",
      workspaceRoot: "/tmp/runtime-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  return yield* Gateway.ProjectWorkGateway;
});

it.effect(
  "shares durable idempotent writes and rejects stale commands without execution admission",
  () =>
    Effect.gen(function* () {
      const gateway = yield* seed;
      const command = create("task-1");
      const first = yield* gateway.write(command, human);
      const duplicate = yield* gateway.write(command, human);
      assert.strictEqual(first.revision, duplicate.revision);
      assert.deepStrictEqual(first, duplicate);
      const stale = yield* Effect.result(
        gateway.write({ ...create("task-2"), expectedRevision: 0 }, human),
      );
      assert.strictEqual(stale._tag, "Failure");
      assert.strictEqual(
        (yield* Effect.result(
          gateway.write(
            {
              type: "project-work.task.complete",
              commandId: command.commandId,
              projectId,
              taskId: command.taskId,
              satisfiedCriterionIds: [],
              completedAt: at,
            },
            human,
          ),
        ))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.result(gateway.read({ projectId, operation: "supervision" })))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "bounds collection pages and resumes a subscription without keeping a subscriber alive",
  () =>
    Effect.gen(function* () {
      const gateway = yield* seed;
      yield* gateway.write(create("task-1"), human);
      yield* gateway.write(create("task-2"), human);
      const page = yield* gateway.read({ projectId, operation: "tasks", limit: 1, envelope: true });
      assert.isObject(page);
      assert.deepStrictEqual((page as { items: unknown[] }).items.length, 1);
      assert.strictEqual((page as { hasMore: boolean }).hasMore, true);
      const items = yield* gateway.subscribe({ projectId, requestCompletionMarker: true }).pipe(
        Stream.takeUntil((item) => item.kind === "synchronized"),
        Stream.runCollect,
      );
      assert.strictEqual(items[items.length - 1]?.kind, "synchronized");
      const subscription = yield* gateway
        .subscribe({ projectId })
        .pipe(Stream.runDrain, Effect.forkChild);
      yield* Fiber.interrupt(subscription);
      yield* gateway.write(create("task-3"), human);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects deleted, foreign project and foreign environment authority", () =>
  Effect.gen(function* () {
    const gateway = yield* seed;
    for (const principal of [
      { ...human, projectId: ProjectId.make("other") },
      { ...human, environmentId: EnvironmentId.make("other") },
    ]) {
      assert.strictEqual(
        (yield* Effect.result(gateway.write(create("denied"), principal)))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.result(gateway.read({ projectId, operation: "tasks" }, principal)))._tag,
        "Failure",
      );
      assert.strictEqual(
        (yield* Effect.result(gateway.subscribe({ projectId }, principal).pipe(Stream.runCollect)))
          ._tag,
        "Failure",
      );
    }
    assert.strictEqual(
      (yield* Effect.result(
        gateway.read({ projectId: ProjectId.make("missing"), operation: "tasks" }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("attributes nested records to the real caller and refuses agent human approvals", () =>
  Effect.gen(function* () {
    const gateway = yield* seed;
    const agent = {
      ...human,
      actor: { kind: "agent" as const, id: "actual-agent" },
      source: { kind: "mcp" as const, id: "actual-session" },
    };
    const attribution = {
      actor: { kind: "human" as const, id: "forged-human" },
      source: { kind: "web" as const, id: "forged-source" },
      recordedAt: at,
    };
    yield* gateway.write(
      {
        type: "project-work.comment.add",
        commandId: CommandId.make("agent-comment"),
        projectId,
        comment: {
          commentId: ProjectWorkCommentId.make("comment"),
          projectId,
          body: "Planning note",
          createdAt: at,
          revision: 0,
          attribution,
        },
        addedAt: at,
        attribution,
      },
      agent,
    );
    const comments = yield* decodeComments(
      yield* gateway.read({ projectId, operation: "comments" }),
    );
    assert.deepStrictEqual(comments[0]?.attribution?.actor, agent.actor);
    assert.deepStrictEqual(comments[0]?.attribution?.source, agent.source);
    assert.strictEqual(
      (yield* Effect.result(
        gateway.write(
          {
            type: "project-work.task.approve",
            commandId: CommandId.make("approve"),
            projectId,
            taskId: ProjectWorkTaskId.make("task"),
            approvalId: ProjectWorkApprovalId.make("approval"),
            specRevision: 0,
            approvedAt: at,
            attribution,
          },
          agent,
        ),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.result(
        gateway.read({ projectId, operation: "export-json", exportVersion: 2 }),
      ))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "preserves reviewed human protected revisions and their receipts across server timestamp changes",
  () =>
    Effect.gen(function* () {
      const gateway = yield* seed;
      const taskId = ProjectWorkTaskId.make("protected-task");
      const criterionId = ProjectWorkCriterionId.make("protected-criterion");
      yield* gateway.write(create(taskId), human);
      yield* gateway.write(
        {
          type: "project-work.criterion.upsert",
          commandId: CommandId.make("criterion"),
          projectId,
          taskId,
          criterion: {
            criterionId,
            taskId,
            description: "Reviewed criterion",
            required: true,
            status: "unsatisfied",
            satisfiedByEvidenceIds: [],
            revision: 0,
            updatedAt: at,
          },
          updatedAt: at,
        },
        human,
      );
      const specification = {
        objective: "Initial objective",
        scopeIn: "Included work",
        scopeOut: "Excluded work",
        criterionIds: [criterionId],
        revision: 1,
        protected: false,
      };
      yield* gateway.write(
        {
          type: "project-work.task.specify",
          commandId: CommandId.make("specify"),
          projectId,
          taskId,
          specification,
          updatedAt: at,
        },
        human,
      );
      yield* gateway.write(
        {
          type: "project-work.criterion.waive",
          commandId: CommandId.make("waive"),
          projectId,
          taskId,
          criterionId,
          waiver: {
            reason: "Reviewed exception",
            evidenceIds: [],
            specRevision: 1,
            waivedAt: at,
            attribution: { actor: human.actor, source: human.source, recordedAt: at },
          },
          waivedAt: at,
        },
        human,
      );
      const protectedResult = yield* gateway.write(
        {
          type: "project-work.task.protect-specification",
          commandId: CommandId.make("protect"),
          projectId,
          taskId,
          specRevision: 1,
          protectedAt: at,
        },
        human,
      );
      const criterionSnapshots = yield* decodeCriteria(
        yield* gateway.read({ projectId, operation: "criteria", taskId }),
      );
      const attribution = {
        actor: { kind: "human" as const, id: "reviewed-client-human" },
        source: { kind: "web" as const, id: "reviewed-client-source" },
        recordedAt: at,
      };
      const bind = (command: typeof ProjectWorkTaskReviseProtectedSpecificationCommand.Type) => ({
        ...command,
        approval: {
          ...command.approval,
          payloadFingerprint: projectWorkPayloadFingerprint(
            projectWorkProtectedRevisionFingerprintPayload(command),
          ),
        },
      });
      const command = bind({
        type: "project-work.task.revise-protected-specification",
        commandId: CommandId.make("revise"),
        projectId,
        taskId,
        expectedRevision: protectedResult.revision,
        specification: {
          ...specification,
          objective: "Reviewed revised objective",
          revision: 2,
          protected: true,
        },
        criterionSnapshots,
        affectedResultIds: [],
        approval: {
          approvalId: ProjectWorkApprovalId.make("reviewed-approval"),
          taskId,
          specRevision: 2,
          payloadFingerprint: "unbound",
          approvedAt: at,
          attribution,
        },
        revisedAt: at,
        attribution,
      });
      const changed = {
        ...command,
        specification: { ...command.specification, objective: "Unreviewed changed objective" },
      };
      const oldProof = yield* Effect.result(gateway.write(changed, human));
      assert.strictEqual(oldProof._tag, "Failure");
      const wrongRevision = bind({
        ...command,
        approval: { ...command.approval, specRevision: 3 },
      });
      assert.strictEqual(
        (yield* Effect.result(gateway.write(wrongRevision, human)))._tag,
        "Failure",
      );
      const first = yield* gateway.write(command, human);
      yield* TestClock.adjust(1000);
      assert.deepStrictEqual(yield* gateway.write(command, human), first);
      assert.strictEqual(
        (yield* Effect.result(gateway.write(bind(changed), human)))._tag,
        "Failure",
      );
      const task = yield* decodeTask(yield* gateway.read({ projectId, operation: "task", taskId }));
      assert.strictEqual(task.specification?.objective, command.specification.objective);
      assert.deepStrictEqual(task.approval?.attribution.actor, human.actor);
      assert.deepStrictEqual(task.approval?.attribution.source, human.source);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("stores a proposed decision's transition attribution as its actual agent caller", () =>
  Effect.gen(function* () {
    const gateway = yield* seed;
    const agent = {
      ...human,
      actor: { kind: "agent" as const, id: "real-agent" },
      source: { kind: "mcp" as const, id: "real-agent-session" },
    };
    const forged = {
      actor: { kind: "human" as const, id: "forged-human" },
      source: { kind: "web" as const, id: "forged-session" },
      recordedAt: at,
    };
    yield* gateway.write(
      {
        type: "project-work.decision.propose",
        commandId: CommandId.make("propose"),
        projectId,
        proposedAt: at,
        decision: {
          decisionId: ProjectWorkDecisionId.make("decision"),
          projectId,
          title: "Proposal",
          body: "Proposal body",
          state: "proposed",
          revision: 0,
          createdAt: at,
          updatedAt: at,
          attribution: forged,
          stateTransitionAttribution: forged,
        },
      },
      agent,
    );
    const decisions = yield* decodeDecisions(
      yield* gateway.read({ projectId, operation: "decisions" }),
    );
    assert.deepStrictEqual(decisions[0]?.stateTransitionAttribution?.actor, agent.actor);
    assert.deepStrictEqual(decisions[0]?.stateTransitionAttribution?.source, agent.source);
    assert.deepStrictEqual(decisions[0]?.attribution?.actor, agent.actor);
  }).pipe(Effect.provide(testLayer)),
);
