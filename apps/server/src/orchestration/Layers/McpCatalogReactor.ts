import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { McpCatalogReactor, type McpCatalogReactorShape } from "../Services/McpCatalogReactor.ts";

type CatalogMutationEvent = Extract<
  OrchestrationEvent,
  {
    readonly type:
      | "thread.mcp-catalog.updated"
      | "thread.mcp-catalog.reset"
      | "thread.mcp-catalog.disposed";
  }
>;

const reasonFromCause = (cause: Cause.Cause<unknown>): string => Cause.pretty(cause).slice(0, 500);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const provider = yield* ProviderService;
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const process = (event: CatalogMutationEvent) =>
    Effect.gen(function* () {
      const desiredCatalog =
        event.type === "thread.mcp-catalog.updated"
          ? event.payload.desiredCatalog
          : event.type === "thread.mcp-catalog.reset"
            ? event.payload.baseline
            : undefined;
      const revision =
        event.type === "thread.mcp-catalog.disposed"
          ? event.payload.revision
          : event.payload.desiredRevision;
      if (event.type === "thread.mcp-catalog.disposed") {
        if (provider.disposeMcpCatalog !== undefined)
          yield* provider.disposeMcpCatalog({
            threadId: event.payload.threadId,
            catalogSessionId: event.payload.mcpCatalogSessionId,
          });
        return;
      }
      if (provider.applyMcpCatalog === undefined) return;
      const dispatchFailure = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const failedAt = yield* nowIso;
          yield* engine
            .dispatch({
              type: "thread.mcp-catalog.apply-failed",
              commandId: CommandId.make(
                `server:mcp-catalog-failed:${event.payload.threadId}:${event.payload.mcpCatalogSessionId}:${revision}`,
              ),
              threadId: event.payload.threadId,
              mcpCatalogSessionId: event.payload.mcpCatalogSessionId,
              revision,
              reason: reasonFromCause(cause),
              failedAt,
            })
            .pipe(Effect.ignoreCause);
        });
      const result = yield* provider
        .applyMcpCatalog({
          threadId: event.payload.threadId,
          catalogSessionId: event.payload.mcpCatalogSessionId,
          revision,
          desiredCatalog: desiredCatalog!,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : dispatchFailure(cause).pipe(Effect.as("failed" as const)),
          ),
        );
      if (result === "failed") return;
      // Restart-required and inactive are expected capability outcomes, not
      // applied receipts. Leave the durable applied revision untouched.
      if (result !== "applied") return;
      yield* Effect.gen(function* () {
        const appliedAt = yield* nowIso;
        return yield* engine.dispatch({
          type: "thread.mcp-catalog.applied",
          commandId: CommandId.make(
            `server:mcp-catalog-applied:${event.payload.threadId}:${event.payload.mcpCatalogSessionId}:${revision}`,
          ),
          threadId: event.payload.threadId,
          mcpCatalogSessionId: event.payload.mcpCatalogSessionId,
          revision,
          appliedCatalog: desiredCatalog!,
          appliedAt,
        });
      }).pipe(Effect.catchCause((cause) => dispatchFailure(cause)));
    });

  const worker = yield* makeDrainableWorker((event: CatalogMutationEvent) =>
    process(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("mcp catalog reactor failed to process event", {
              eventType: event.type,
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const start: McpCatalogReactorShape["start"] = Effect.fn("McpCatalogReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.mcp-catalog.updated" ||
        event.type === "thread.mcp-catalog.reset" ||
        event.type === "thread.mcp-catalog.disposed"
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies McpCatalogReactorShape;
});

export const McpCatalogReactorLive = Layer.effect(McpCatalogReactor, make);
