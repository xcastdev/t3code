import {
  EnvironmentId,
  ExternalNotificationError,
  ExternalNotificationHomeAssistantDestination,
  ProjectId,
  ProjectWorkTaskId,
  ThreadId,
  type ExternalNotificationPayload,
} from "@t3tools/contracts";
import { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ExternalNotificationDispatcher from "./ExternalNotificationDispatcher.ts";
import * as HomeAssistantWebhookAdapter from "./HomeAssistantWebhookAdapter.ts";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
const destination = Schema.decodeUnknownSync(ExternalNotificationHomeAssistantDestination)({
  _tag: "home-assistant-webhook",
  id: "home",
  label: "Home Assistant",
  enabled: true,
  configured: true,
  webhookUrl: "https://home.example.test/api/webhook/token",
});
const state = Schema.decodeUnknownSync(RelayAgentActivityState)({
  environmentId,
  threadId,
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  phase: "running",
  headline: "Running",
  updatedAt: "2026-09-01T00:00:00.000Z",
  deepLink: "/threads/environment/thread",
});

it.effect(
  "ExternalNotificationDispatcher emits durable Work task links instead of a synthetic thread",
  () => {
    const owner = EnvironmentId.make("remote server");
    const sent: ExternalNotificationPayload[] = [];
    const layer = ExternalNotificationDispatcher.layer.pipe(
      Layer.provide(
        Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
          send: ({ payload }) => Effect.sync(() => sent.push(payload)),
        }),
      ),
      Layer.provide(
        ServerSettings.layerTest({
          externalNotifications: { appScheme: "t3code", destinations: [destination] },
        }),
      ),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(owner),
          getDescriptor: Effect.die("unused"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      const result = yield* dispatcher.dispatchDetailed({
        environmentId: owner,
        threadId: ThreadId.make("project-work:shared project"),
        state: null,
        reason: "project-work:blocked",
        projectWork: {
          projectId: "shared project",
          taskId: "task/42",
          state: "blocked",
          reason: "blocked",
          revision: 7,
        },
        bypassMemoryDedup: true,
      });
      assert.deepEqual(result.deliveredDestinationIds, [destination.id]);
      assert.lengthOf(sent, 1);
      assert.equal(
        sent[0]?.relativeRoute,
        "/work/remote%20server/shared%20project?taskId=task%2F42",
      );
      assert.equal(
        sent[0]?.deepLink,
        "t3code://work/remote%20server/shared%20project/tasks/task%2F42",
      );
      assert.deepEqual(sent[0]?.projectWork, {
        projectId: ProjectId.make("shared project"),
        taskId: ProjectWorkTaskId.make("task/42"),
        state: "blocked",
        reason: "blocked",
        revision: 7,
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "ExternalNotificationDispatcher deduplicates state excluding updatedAt and sends tombstones",
  () => {
    const sent: unknown[] = [];
    const layer = ExternalNotificationDispatcher.layer.pipe(
      Layer.provide(
        Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
          send: ({ payload }) => Effect.sync(() => sent.push(payload)),
        }),
      ),
      Layer.provide(
        ServerSettings.layerTest({ externalNotifications: { destinations: [destination] } }),
      ),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.die("unused"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      yield* dispatcher.dispatch({ environmentId, threadId, state, reason: "activity" });
      yield* dispatcher.dispatch({
        environmentId,
        threadId,
        state: { ...state, updatedAt: "2026-09-01T00:00:01.000Z" },
        reason: "activity",
      });
      yield* dispatcher.dispatch({ environmentId, threadId, state: null, reason: "deleted" });
      assert.equal(sent.length, 2);
      assert.deepInclude(sent[1], { state: null, schemaVersion: 1 });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("ExternalNotificationDispatcher rejects tests for an unconfigured destination", () => {
  const layer = ExternalNotificationDispatcher.layer.pipe(
    Layer.provide(
      Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
        send: () => Effect.void,
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  );
  return Effect.gen(function* () {
    const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
    const error = yield* Effect.flip(dispatcher.test("missing"));
    assert.instanceOf(error, ExternalNotificationError);
    assert.equal(error.reason, "not-configured");
  }).pipe(Effect.provide(layer));
});

it.effect("ExternalNotificationDispatcher deduplicates durable project-work attention", () => {
  const sent: unknown[] = [];
  const layer = ExternalNotificationDispatcher.layer.pipe(
    Layer.provide(
      Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
        send: ({ payload }) => Effect.sync(() => sent.push(payload)),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({ externalNotifications: { destinations: [destination] } }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  );
  return Effect.gen(function* () {
    const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
    const projectWork = {
      projectId: "project-1",
      taskId: "task-1",
      state: "blocked",
      reason: "blocked",
      revision: 2,
    };
    yield* dispatcher.dispatch({
      environmentId,
      threadId,
      state: null,
      reason: "project-work:blocked",
      projectWork,
    });
    yield* dispatcher.dispatch({
      environmentId,
      threadId,
      state: null,
      reason: "project-work:blocked",
      projectWork,
    });
    yield* dispatcher.dispatch({
      environmentId,
      threadId,
      state: null,
      reason: "project-work:blocked",
      projectWork: { ...projectWork, revision: 3 },
    });
    assert.lengthOf(sent, 2);
    assert.equal(
      (sent[0] as { projectWork: { taskId: string; revision: number } }).projectWork.taskId,
      "task-1",
    );
    assert.equal(
      (sent[0] as { projectWork: { taskId: string; revision: number } }).projectWork.revision,
      2,
    );
    assert.equal(
      (sent[1] as { projectWork: { taskId: string; revision: number } }).projectWork.revision,
      3,
    );
  }).pipe(Effect.provide(layer));
});

const linkTestLayer = (sent: ExternalNotificationPayload[]) =>
  ExternalNotificationDispatcher.layer.pipe(
    Layer.provide(
      Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
        send: ({ payload }) => Effect.sync(() => sent.push(payload)),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({
        externalNotifications: { appScheme: "t3code", destinations: [destination] },
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  );

it.effect(
  "ExternalNotificationDispatcher preserves encoded Work identity and ordinary thread links",
  () => {
    const sent: ExternalNotificationPayload[] = [];
    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      yield* dispatcher.dispatch({ environmentId, threadId, state, reason: "activity" });
      assert.equal(sent[0]?.relativeRoute, "/threads/environment/thread");
      assert.equal(sent[0]?.deepLink, "t3code://threads/environment/thread");
      const owner = EnvironmentId.make("env/remote %雪");
      yield* dispatcher.dispatch({
        environmentId: owner,
        threadId,
        state: null,
        reason: "project-work:blocked",
        projectWork: {
          projectId: "project/?#%",
          taskId: "task/with space💡",
          state: "blocked",
          reason: "blocked",
          revision: 0,
        },
      });
      assert.lengthOf(sent, 2);
      assert.equal(
        sent[1]?.relativeRoute,
        "/work/env%2Fremote%20%25%E9%9B%AA/project%2F%3F%23%25?taskId=task%2Fwith%20space%F0%9F%92%A1",
      );
      assert.equal(
        sent[1]?.deepLink,
        "t3code://work/env%2Fremote%20%25%E9%9B%AA/project%2F%3F%23%25/tasks/task%2Fwith%20space%F0%9F%92%A1",
      );
      const boundaryId = "x".repeat(256);
      yield* dispatcher.dispatch({
        environmentId,
        threadId,
        state: null,
        reason: "project-work:blocked",
        projectWork: {
          projectId: boundaryId,
          taskId: boundaryId,
          state: "blocked",
          reason: "blocked",
          revision: Number.MAX_SAFE_INTEGER,
        },
      });
      assert.lengthOf(sent, 3);
      assert.equal(sent[2]?.relativeRoute, `/work/environment/${boundaryId}?taskId=${boundaryId}`);
    }).pipe(Effect.provide(linkTestLayer(sent)));
  },
);

it.effect(
  "ExternalNotificationDispatcher rejects invalid Work targets without sending or a defect",
  () => {
    const sent: ExternalNotificationPayload[] = [];
    return Effect.gen(function* () {
      const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
      const valid = {
        environmentId,
        threadId,
        state: null,
        reason: "project-work:blocked",
        projectWork: {
          projectId: "project",
          taskId: "task",
          state: "blocked",
          reason: "blocked",
          revision: 1,
        },
      };
      const invalid = [
        // Deliberately bypass fixture construction checks to exercise the dispatch boundary.
        { ...valid, environmentId: EnvironmentId.make("", { disableChecks: true }) },
        { ...valid, environmentId: EnvironmentId.make(" environment ", { disableChecks: true }) },
        { ...valid, projectWork: { ...valid.projectWork, projectId: "" } },
        { ...valid, projectWork: { ...valid.projectWork, taskId: " task " } },
        { ...valid, projectWork: { ...valid.projectWork, taskId: "x".repeat(257) } },
        { ...valid, projectWork: { ...valid.projectWork, taskId: "\ud800" } },
        { ...valid, projectWork: { ...valid.projectWork, state: "future-state" } },
        { ...valid, projectWork: { ...valid.projectWork, reason: "future-reason" } },
        { ...valid, projectWork: { ...valid.projectWork, revision: -1 } },
        { ...valid, projectWork: { ...valid.projectWork, revision: Number.NaN } },
        { ...valid, environmentId: EnvironmentId.make(".") },
        { ...valid, environmentId: EnvironmentId.make("..") },
        { ...valid, projectWork: { ...valid.projectWork, projectId: "." } },
        { ...valid, projectWork: { ...valid.projectWork, projectId: ".." } },
        { ...valid, projectWork: { ...valid.projectWork, taskId: "." } },
        { ...valid, projectWork: { ...valid.projectWork, taskId: ".." } },
      ];
      for (const input of invalid) {
        assert.throws(() =>
          ExternalNotificationDispatcher.buildExternalNotificationPayload({
            ...input,
            appScheme: "t3code",
            test: false,
          }),
        );
        assert.deepEqual(yield* dispatcher.dispatchDetailed(input), {
          attemptedDestinationIds: [],
          deliveredDestinationIds: [],
          failedDestinationIds: [],
          outcomes: [],
        });
      }
      assert.lengthOf(sent, 0);
      yield* dispatcher.dispatchDetailed(valid);
      assert.lengthOf(sent, 1);
    }).pipe(Effect.provide(linkTestLayer(sent)));
  },
);

it.effect("ExternalNotificationDispatcher treats delivery failures as best effort", () => {
  const layer = ExternalNotificationDispatcher.layer.pipe(
    Layer.provide(
      Layer.succeed(HomeAssistantWebhookAdapter.HomeAssistantWebhookAdapter, {
        send: () =>
          Effect.fail(
            new ExternalNotificationError({ destinationId: "home", reason: "transport" }),
          ),
      }),
    ),
    Layer.provide(
      ServerSettings.layerTest({ externalNotifications: { destinations: [destination] } }),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(environmentId),
        getDescriptor: Effect.die("unused"),
      }),
    ),
  );
  return Effect.gen(function* () {
    const dispatcher = yield* ExternalNotificationDispatcher.ExternalNotificationDispatcher;
    yield* dispatcher.dispatch({
      environmentId,
      threadId,
      state: null,
      reason: "project-work:failed",
    });
  }).pipe(Effect.provide(layer));
});
