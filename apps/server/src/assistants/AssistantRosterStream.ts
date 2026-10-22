import type { AssistantListInput, AssistantListResult, AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { AssistantActivity } from "./AssistantActivity.ts";
import { AssistantEventBus } from "./AssistantEventBus.ts";
import { AssistantError } from "./AssistantRepository.ts";

export class AssistantRosterStream extends Context.Service<
  AssistantRosterStream,
  {
    readonly subscribe: (
      input: AssistantListInput,
      sessionId: AuthSessionId,
    ) => Stream.Stream<AssistantListResult, AssistantError>;
  }
>()("t3/assistants/AssistantRosterStream") {}

const make = Effect.gen(function* () {
  const activity = yield* AssistantActivity;
  const hints = yield* AssistantEventBus;
  const events = yield* EventSinkV2;
  return AssistantRosterStream.of({
    subscribe: (input, sessionId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // The hint subscription and durable cursor precede the snapshot. Lazy tail
          // acquisition can then replay only commits made during that snapshot read.
          const changes = yield* hints.subscribe;
          const cursor = yield* events
            .latestSequence()
            .pipe(Effect.mapError((cause) => new AssistantError({ reason: "unavailable", cause })));
          const initial = yield* activity.roster(input, sessionId);
          // Scope at the sink before its payload budget; unrelated transcript
          // events must never enter a status subscriber's retained buffer.
          const committed = Stream.merge(
            events.stream({ afterSequence: cursor, bounded: true, eventType: "run.created" }),
            events.stream({ afterSequence: cursor, bounded: true, eventType: "run.updated" }),
          ).pipe(Stream.mapError((cause) => new AssistantError({ reason: "unavailable", cause })));
          // Hints carry no detail. Re-read the visible page even when IDs coalesce,
          // since archive/create can change which records belong to that page.
          const wakes = Stream.merge(
            Stream.map(changes, () => undefined),
            Stream.map(committed, () => undefined),
          ).pipe(
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
            Stream.mapEffect(() => activity.roster(input, sessionId)),
          );
          // A run can start and finish between reads with identical attention counts.
          // Keep that wake as an invalidation for the client's bounded activity query.
          return Stream.concat(Stream.make(initial), wakes);
        }),
      ),
  });
});
export const layer = Layer.effect(AssistantRosterStream, make);
