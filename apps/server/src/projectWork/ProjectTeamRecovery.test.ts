import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProjectWorkTaskId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Recovery from "./ProjectTeamRecovery.ts";
import type { DispatchSnapshot } from "./ProjectTeamDispatchJournal.ts";
const at = "2026-01-01T00:00:00.000Z";
const snapshot: DispatchSnapshot = {
  dispatchId: "dispatch",
  projectId: "project",
  taskId: "task",
  bindingId: "binding",
  threadId: "thread",
  generation: 0,
  fingerprint: "frozen",
  assignment: "Read source",
  stage: "uncertain",
  createdAt: at,
  updatedAt: at,
  request: {
    type: "project-team.dispatch",
    projectId: ProjectId.make("project"),
    commandId: CommandId.make("dispatch"),
    taskId: ProjectWorkTaskId.make("task"),
    expectedRevision: 0,
    expectedTaskRevision: 0,
    memberId: "member",
    expectedMemberRevision: 0,
    authorizationGateId: "grant",
    expectedGateRevision: 0,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
    workspace: { type: "root" },
  },
  result: {
    projectId: ProjectId.make("project"),
    revision: 0,
    receipt: {
      commandId: CommandId.make("dispatch"),
      projectId: ProjectId.make("project"),
      revision: 0,
      eventCount: 0,
      status: "accepted",
    },
    delta: { projectId: ProjectId.make("project"), revision: 0, eventIds: [], changedFields: [] },
  },
};
const layer = Layer.mergeAll(
  Receipts.layer,
  Layer.mock(Threads.ThreadManagementService)({
    getThreadProjection: () => Effect.die("A foreign receipt must not reach the thread projection"),
  }),
).pipe(Layer.provide(Sqlite.layerMemory));
it.effect("missing receipt permits only the retained identity to replay", () =>
  Effect.gen(function* () {
    const reconcile = yield* Recovery.make;
    assert.deepEqual(yield* reconcile(snapshot), { status: "replay" });
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "foreign or rejected exact command receipts preserve uncertainty instead of authorizing replacement",
  () =>
    Effect.gen(function* () {
      const receipts = yield* Receipts.CommandReceiptStoreV2;
      const reconcile = yield* Recovery.make;
      yield* receipts.insertIfAbsent({
        commandId: CommandId.make("dispatch:initial-message"),
        threadId: ThreadId.make("foreign"),
        commandType: "message.dispatch",
        acceptedAt: DateTime.makeUnsafe(at),
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
      const foreign = yield* reconcile(snapshot).pipe(Effect.result);
      assert.equal(foreign._tag, "Failure");
      yield* receipts.upsert({
        commandId: CommandId.make("dispatch:initial-message"),
        threadId: ThreadId.make("thread"),
        commandType: "message.dispatch",
        acceptedAt: DateTime.makeUnsafe(at),
        resultSequence: 1,
        status: "rejected",
        error: "rejected",
      });
      const rejected = yield* reconcile(snapshot).pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
    }).pipe(Effect.provide(layer)),
);
