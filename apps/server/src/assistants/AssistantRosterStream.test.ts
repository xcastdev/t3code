import { assert, it } from "@effect/vitest";
import {
  CommandId,
  OrchestrationV2StoredEvent,
  OrchestrationV2DomainEvent,
  type AssistantListInput,
  type AuthSessionId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { AssistantError } from "./AssistantRepository.ts";
import { AssistantActivity } from "./AssistantActivity.ts";
import * as Bus from "./AssistantEventBus.ts";
import * as Roster from "./AssistantRosterStream.ts";
import { configuration, environmentId } from "./AssistantTestHelpers.ts";
import { layer, sessionId, setup } from "./AssistantActivity.test-utils.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationV2DomainEvent);
const decodeStoredEvent = Schema.decodeUnknownSync(OrchestrationV2StoredEvent);

it.effect(
  "subscribes before the initial snapshot, refreshes config-only changes, and disposes subscribers",
  () =>
    Effect.gen(function* () {
      const { activity, scope, repo, auth, seed } = yield* setup();
      const active = yield* Ref.make(0);
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const tailReady = yield* Deferred.make<void>();
      const bus = yield* Bus.AssistantEventBus;
      const cursorCaptured = yield* Ref.make(false);
      const firstRead = yield* Ref.make(true);
      const retainedEvent = decodeStoredEvent({
        sequence: 43,
        commandId: "command-window",
        event: {
          id: "event-window",
          threadId: scope.binding.canonicalThreadId,
          runId: "window",
          occurredAt: yield* DateTime.now,
          type: "run.updated",
          payload: {
            id: "window",
            threadId: scope.binding.canonicalThreadId,
            ordinal: 1,
            providerInstanceId: "codex",
            modelSelection: configuration.modelSelection,
            providerThreadId: null,
            userMessageId: "message-window",
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: yield* DateTime.now,
            startedAt: null,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      });
      const racingActivity = AssistantActivity.of({
        ...activity,
        roster: Effect.fn("AssistantRosterStreamTest.snapshot")(function* (
          input: AssistantListInput,
          session: AuthSessionId,
        ) {
          assert.isTrue(yield* Ref.get(cursorCaptured));
          const page = yield* activity.roster(input, session);
          if (yield* Ref.getAndSet(firstRead, false)) {
            yield* seed(scope, "window", "running");
            yield* Queue.offer(events, retainedEvent);
          }
          return page;
        }),
      });
      const service = EventSinkV2.of({
        write: () => Effect.die("unused"),
        writeWithEffects: () => Effect.die("unused"),
        writeIfRunCurrent: () => Effect.die("unused"),
        writeIfProviderThreadOwner: () => Effect.die("unused"),
        writeIfProviderThreadUnchanged: () => Effect.die("unused"),
        commitCommand: () => Effect.die("unused"),
        commitRejectedCommand: () => Effect.die("unused"),
        assertProjectCommand: () => Effect.die("unused"),
        commitProjectCommand: () => Effect.die("unused"),
        commitRejectedProjectCommand: () => Effect.die("unused"),
        readByCommandId: () => Stream.empty,
        latestSequence: () => Ref.set(cursorCaptured, true).pipe(Effect.as(42)),
        stream: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              assert.equal(input?.afterSequence, 42);
              assert.equal(input?.bounded, true);
              assert.isTrue(
                input?.eventType === "run.created" || input?.eventType === "run.updated",
              );
              yield* Effect.acquireRelease(
                Ref.update(active, (n) => n + 1),
                () => Ref.update(active, (n) => n - 1),
              );
              yield* Deferred.succeed(tailReady, undefined);
              return Stream.fromQueue(events);
            }),
          ),
      });
      const roster = yield* Roster.AssistantRosterStream.pipe(
        Effect.provide(Roster.layer),
        Effect.provideService(EventSinkV2, service),
        Effect.provideService(AssistantActivity, racingActivity),
      );
      const subscription = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(subscription, Exit.void));
      const pull = yield* Stream.toPull(
        roster.subscribe({ environmentId, includeArchived: true, limit: 1 }, sessionId),
      ).pipe(Scope.provide(subscription));
      const initial = yield* pull;
      assert.equal(initial[0]!.assistants[0]!.name, configuration.name);
      assert.equal(initial[0]!.assistants[0]!.attention.activeRuns, 0);
      // The committed event occurred after the snapshot read and before lazy tail acquisition.
      assert.equal((yield* pull)[0]!.assistants[0]!.attention.activeRuns, 1);
      yield* repo.updateConfiguration({
        ...scope,
        configuration: { ...configuration, name: "Changed elsewhere" },
        commandId: CommandId.make("config"),
        expectedRevision: scope.configurationRevision,
      });
      // Configuration-only hints do not need a V2 event.
      for (let i = 0; i < 200; i++) yield* bus.publish(scope);
      assert.equal((yield* pull)[0]!.assistants[0]!.name, "Changed elsewhere");
      yield* Deferred.await(tailReady);
      assert.equal(yield* Ref.get(active), 2);
      yield* auth.revoke({ sessionId, revokedAt: yield* DateTime.now });
      yield* bus.publish(scope);
      assert.equal((yield* pull.pipe(Effect.result))._tag, "Failure");
      yield* Scope.close(subscription, Exit.void);
      assert.equal(yield* Ref.get(active), 0);
      assert.equal(
        (yield* activity
          .roster({ environmentId, includeArchived: true, limit: 1 }, sessionId)
          .pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(Layer.merge(Bus.layer, layer))),
);

it.effect("keeps an unrelated oversized transcript outside the real bounded run tails", () =>
  Effect.gen(function* () {
    const { activity, scope, seed } = yield* setup();
    const events = yield* EventStore.EventStoreV2;
    const once = yield* Ref.make(true);
    const wrapped = AssistantActivity.of({
      ...activity,
      roster: Effect.fn("AssistantRosterStreamTest.largeTranscript")(function* (
        input: AssistantListInput,
        session: AuthSessionId,
      ) {
        const page = yield* activity.roster(input, session);
        if (yield* Ref.getAndSet(once, false)) {
          const at = yield* DateTime.now;
          yield* events
            .append({
              events: [
                decodeEvent({
                  id: "large-unrelated",
                  type: "turn-item.updated",
                  threadId: "ordinary-thread",
                  occurredAt: at,
                  payload: {
                    id: "large-tool",
                    type: "command_execution",
                    threadId: "ordinary-thread",
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "running",
                    title: "Large output",
                    input: "x".repeat(9 * 1024 * 1024),
                    startedAt: at,
                    completedAt: null,
                    updatedAt: at,
                  },
                }),
              ],
            })
            .pipe(Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })));
          yield* seed(scope, "real-tail", "running");
        }
        return page;
      }),
    });
    const realRosterLayer = Roster.layer.pipe(
      Layer.provide(EventSink.layer.pipe(Layer.provide(ProjectionStore.layer))),
    );
    const roster = yield* Roster.AssistantRosterStream.pipe(
      Effect.provide(realRosterLayer),
      Effect.provideService(AssistantActivity, wrapped),
    );
    const pull = yield* Stream.toPull(
      roster.subscribe({ environmentId, includeArchived: true, limit: 1 }, sessionId),
    );
    assert.equal((yield* pull)[0]!.assistants[0]!.attention.activeRuns, 0);
    assert.equal((yield* pull)[0]!.assistants[0]!.attention.activeRuns, 1);
  }).pipe(Effect.provide(Layer.merge(Bus.layer, layer))),
);
