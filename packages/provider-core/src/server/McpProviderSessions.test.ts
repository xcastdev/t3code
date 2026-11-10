import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Sessions from "./McpProviderSessions.ts";
it.effect("notifies catalog consumers on scoped grant replacement and revocation", () =>
  Effect.gen(function* () {
    const service = yield* Sessions.McpProviderSessions;
    const changes = yield* Queue.unbounded<ThreadId>();
    const unsubscribe = yield* service.onChanged!((id) =>
      Queue.offer(changes, id).pipe(Effect.asVoid),
    );
    const config = {
      threadId: ThreadId.make("t"),
      environmentId: EnvironmentId.make("e"),
      providerInstanceId: ProviderInstanceId.make("omp"),
      providerSessionId: "s",
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer fixture",
      browserToolsAvailable: false,
    };
    yield* service.set(config);
    expect(yield* Queue.take(changes)).toBe(config.threadId);
    yield* service.replaceIfCurrent(
      { threadId: config.threadId, providerSessionId: "s" },
      { ...config, catalogRevision: 2 },
    );
    expect(yield* Queue.take(changes)).toBe(config.threadId);
    yield* service.clear(config.threadId);
    expect(yield* Queue.take(changes)).toBe(config.threadId);
    unsubscribe();
  }).pipe(Effect.provide(Sessions.layer)),
);
