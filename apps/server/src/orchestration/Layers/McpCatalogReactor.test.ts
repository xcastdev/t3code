import {
  CommandId,
  CorrelationId,
  EventId,
  McpCatalogSessionId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { McpCatalogReactor } from "../Services/McpCatalogReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { McpCatalogReactorLive } from "./McpCatalogReactor.ts";

describe("McpCatalogReactor", () => {
  effectIt.effect("applies updates in order and emits an applied receipt", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const applied = yield* Deferred.make<void>();
      const seenRevisions: number[] = [];
      const dispatched: Array<{ readonly type: string; readonly revision: number }> = [];
      const threadId = ThreadId.make("mcp-reactor-thread");
      const catalogSessionId = McpCatalogSessionId.make("mcp-reactor-session");
      const update = (revision: number): OrchestrationEvent =>
        ({
          sequence: revision,
          eventId: EventId.make(`mcp-reactor-event-${revision}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          type: "thread.mcp-catalog.updated",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: CommandId.make(`mcp-reactor-command-${revision}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`mcp-reactor-correlation-${revision}`),
          metadata: {},
          payload: {
            threadId,
            mcpCatalogSessionId: catalogSessionId,
            desiredCatalog: [],
            desiredRevision: revision,
          },
        }) as OrchestrationEvent;
      const engine = {
        streamDomainEvents: Stream.fromPubSub(events),
        subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        dispatch: (command: { readonly type: string; readonly revision: number }) =>
          Effect.sync(() => {
            dispatched.push({ type: command.type, revision: command.revision });
            return { sequence: dispatched.length };
          }),
      } as unknown as OrchestrationEngineShape;
      const provider = {
        applyMcpCatalog: (input: { readonly revision: number }) =>
          Effect.gen(function* () {
            seenRevisions.push(input.revision);
            yield* Deferred.succeed(applied, undefined);
            return "applied" as const;
          }),
      } as unknown as ProviderServiceShape;
      const layer = McpCatalogReactorLive.pipe(
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provide(Layer.succeed(ProviderService, provider)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* McpCatalogReactor;
          yield* reactor.start();
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          yield* PubSub.publish(events, update(1));
          yield* Deferred.await(applied);
          yield* reactor.drain;
        }),
      ).pipe(Effect.provide(layer));

      expect(seenRevisions).toEqual([1]);
      expect(dispatched).toEqual([{ type: "thread.mcp-catalog.applied", revision: 1 }]);
    }),
  );
});
