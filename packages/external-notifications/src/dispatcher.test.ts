import { expect, it } from "@effect/vitest";
import type {
  ExternalNotificationDestination,
  ExternalNotificationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeExternalNotificationDispatcher } from "./dispatcher.ts";
import { ExternalNotificationError } from "./webhook.ts";

it.effect("filters each entry and claims each occurrence per environment and destination", () =>
  Effect.gen(function* () {
    const first: ExternalNotificationDestination = {
      id: "first",
      kind: "generic-webhook",
      enabled: true,
      name: "First",
      webhookUrl: "http://example.test/first",
      events: ["completion"],
    };
    const destinations = [
      first,
      { ...first, id: "overlap" },
      { ...first, id: "rejected" },
      { ...first, id: "legacy", kind: "home-assistant" as const },
      { ...first, id: "empty", events: [] },
      { ...first, id: "disabled", enabled: false },
      { ...first, id: "different", events: ["needs-input"] as const },
    ];
    const event = {
      environmentId: "a",
      environmentName: "Alpha",
      eventType: "completion",
      occurrenceId: "occurrence",
      title: "Finished",
      timestamp: "2026-11-18T12:00:00.000Z",
    } satisfies ExternalNotificationEvent;
    const claims = new Set<string>();
    const sent: string[] = [];
    const recorded: string[] = [];
    const dispatcher = makeExternalNotificationDispatcher({
      readDestinations: () => Effect.succeed(destinations),
      claim: (key) =>
        Effect.sync(() => {
          const serialized = JSON.stringify(key);
          if (claims.has(serialized)) return false;
          claims.add(serialized);
          return true;
        }),
      record: (key, status) =>
        Effect.sync(() => {
          recorded.push(`${key.environmentId}/${key.destinationId}/${status}`);
        }),
      send: (destination, sample) =>
        Effect.sync(() => {
          sent.push(`${sample.environmentId}/${destination.id}/${sample.eventType}`);
        }).pipe(
          Effect.andThen(
            destination.id === "overlap"
              ? Effect.fail(new ExternalNotificationError({ reason: "timeout" }))
              : destination.id === "rejected"
                ? Effect.fail(new ExternalNotificationError({ reason: "http-status" }))
                : Effect.void,
          ),
        ),
    });
    yield* dispatcher.dispatch(event);
    yield* dispatcher.dispatch(event);
    yield* dispatcher.dispatch(
      { ...event, environmentId: "b" },
      { destinationKind: "generic-webhook" },
    );
    expect(yield* dispatcher.test("disabled", { ...event, eventType: "test" })).toEqual({
      status: "delivered",
    });
    expect(sent).toEqual([
      "a/first/completion",
      "a/overlap/completion",
      "a/rejected/completion",
      "a/legacy/completion",
      "b/first/completion",
      "b/overlap/completion",
      "b/rejected/completion",
      "a/disabled/test",
    ]);
    expect(recorded).toEqual([
      "a/first/delivered",
      "a/overlap/uncertain",
      "a/rejected/failed",
      "a/legacy/delivered",
      "b/first/delivered",
      "b/overlap/uncertain",
      "b/rejected/failed",
    ]);
  }),
);
