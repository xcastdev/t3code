import {
  EventId,
  ProjectId,
  EnvironmentId,
  CommandId,
  ProjectWorkTaskId,
  ProjectWorkCommentId,
  type ProjectTeamMemorySelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Crypto from "@effect/platform-node/NodeCrypto";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Environment from "../../environment/ServerEnvironment.ts";
import * as Repository from "../ProjectWorkRepository.ts";
import * as Memory from "./ProjectMemoryService.ts";
import { memoryHash } from "./ProjectMemoryRepository.ts";
export const at = "2026-01-01T00:00:00.000Z";
export const env = EnvironmentId.make("env");
export const projectId = ProjectId.make("memory-project");
export const taskId = ProjectWorkTaskId.make(`task-${projectId}`);
export const human = {
  actor: { kind: "human" as const, id: "person" },
  source: { kind: "web" as const, id: "session" },
  recordedAt: at,
};
const base = ProjectStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
export const layer = Memory.layer.pipe(
  Layer.provideMerge(Repository.ProjectWorkRepositoryLive.pipe(Layer.provideMerge(base))),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(env),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Layer.provide(Crypto.layer),
);
export const scope = {
  environmentId: env,
  owner: { kind: "project" as const, projectId },
  ownerRevision: 0,
};
export const seed = Effect.fn("MemoryTest.seed")(function* (
  id = projectId,
  content = "Use focused tests",
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  yield* projects.apply({
    sequence: 1,
    eventId: EventId.make(`create-${id}`),
    aggregateKind: "project",
    aggregateId: id,
    occurredAt: at,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: id,
      title: "Memory",
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const taskId = ProjectWorkTaskId.make(`task-${id}`);
  const repository = yield* Repository.ProjectWorkRepository;
  yield* repository.execute({
    type: "project-work.task.create",
    projectId: id,
    taskId,
    commandId: CommandId.make(`task-${id}`),
    title: "Task",
    createdAt: at,
    attribution: human,
  });
  yield* repository.execute({
    type: "project-work.comment.add",
    projectId: id,
    commandId: CommandId.make(`comment-${id}`),
    comment: {
      commentId: ProjectWorkCommentId.make(`note-${id}`),
      projectId: id,
      taskId,
      body: content,
      revision: 0,
      createdAt: at,
      attribution: human,
    },
    addedAt: at,
    attribution: human,
  });
  return content;
});
export const captureInput = (content = "Use focused tests", id = projectId) => ({
  environmentId: env,
  owner: { kind: "project" as const, projectId: id },
  ownerRevision: 0,
  reference: {
    kind: "comment" as const,
    retainedId: `note-${id}`,
    retainedRevision: 0,
    taskId: ProjectWorkTaskId.make(`task-${id}`),
  },
  selection: {
    owner: { kind: "project" as const, projectId: id },
    ownerRevision: 0,
    kind: "comment",
    retainedId: `note-${id}`,
    retainedRevision: 0,
    sourceRecordId: "source",
    expectedSourceRecordRevision: 0,
    sourceRevision: 0,
    sourceGeneration: 0,
    contentHash: memoryHash(content),
    effectId: "capture",
    expectedEffectRevision: 0,
    expectedClaimGeneration: 0,
  } satisfies ProjectTeamMemorySelection,
  now: at,
});
