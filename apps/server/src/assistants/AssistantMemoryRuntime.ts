import { AssistantMemoryActivity } from "./AssistantMemoryActivity.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { AssistantMemory } from "./AssistantMemory.ts";
import { AssistantSettledMemorySource } from "./AssistantMemorySources.ts";
import { ProjectMemoryProcessing } from "../projectWork/memory/ProjectMemoryProcessing.ts";

export const workerLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventSinkV2;
    const memory = yield* AssistantMemory;
    const sources = yield* AssistantSettledMemorySource;
    const processing = yield* ProjectMemoryProcessing;
    const activity = yield* AssistantMemoryActivity;
    const afterSequence = yield* events.latestSequence();
    const reconcile = Effect.gen(function* () {
      let cursor: string | undefined;
      for (;;) {
        const keys = yield* processing.reconcile(cursor);
        if (keys.length === 0) break;
        cursor = keys.at(-1)!;
      }
    });
    const cleanup = Effect.gen(function* () {
      let after: string | undefined;
      for (;;) {
        const ids = yield* processing.cleanup(after);
        if (ids.length === 0) break;
        after = ids.at(-1)!;
      }
    });
    const cleanupSafely = cleanup.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Assistant memory cleanup remains pending.", { cause }),
      ),
    );
    const drain = cleanupSafely.pipe(
      Effect.andThen(
        reconcile.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Assistant memory processing remains pending.", { cause }),
          ),
        ),
      ),
      Effect.andThen(cleanupSafely),
    );
    const recover = Effect.gen(function* () {
      let after: string | undefined;
      for (;;) {
        const next = yield* memory.recover(after);
        if (next === null) break;
        after = next;
      }
    });
    yield* (yield* activity.subscribe).pipe(
      Stream.runForEach(() =>
        drain.pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Assistant memory processing remains pending.", { cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    yield* recover.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Assistant memory recovery remains pending.", { cause }),
      ),
      Effect.andThen(drain),
      Effect.forkScoped,
    );
    yield* events.stream({ afterSequence, bounded: false }).pipe(
      Stream.runForEach((stored) =>
        Effect.gen(function* () {
          const event = stored.event;
          if (event.type !== "run.updated" && event.type !== "message.updated") return;
          if (
            event.type === "message.updated" &&
            (event.payload.role !== "user" || event.payload.streaming)
          )
            return;
          if (
            event.type === "run.updated" &&
            !["completed", "interrupted", "failed", "cancelled"].includes(event.payload.status)
          )
            return;
          const runId = event.type === "run.updated" ? event.payload.id : event.payload.runId;
          if (runId === null) return;
          const evidence = yield* sources.forRun(event.threadId, runId);
          if (evidence === null) return;
          const captured = yield* memory.capture(evidence);
          yield* activity.wake;
          yield* memory.process(captured.operationKey);
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Assistant memory capture remains pending.", { cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
