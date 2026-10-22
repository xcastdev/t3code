import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";

export const controlledProviderId = ProviderInstanceId.make("codex");
export const controlledProviderModel = "p21-fixture-model";
export const controlledResponse = "Fixture response: the project uses a blue release label.";
const driver = ProviderDriverKind.make("codex");
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  // The in-memory adapter applies each turn's snapshot without mutating shared session state.
  instructionDelivery: { mode: "turn" as const, supportsSessionReplacement: false },
  threads: {
    ...CodexProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
  },
  tools: {
    ...CodexProviderCapabilitiesV2.tools,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
};

export class ControlledProviderTranscript extends Context.Service<
  ControlledProviderTranscript,
  {
    readonly turns: Effect.Effect<
      ReadonlyArray<{ readonly threadId: string; readonly runId: string; readonly text: string }>
    >;
  }
>()("t3/testUtils/upgradeControlledProviders/ControlledProviderTranscript") {}

/** Fixed in-memory replies exercise V2 admission, provider ingestion and terminal outbox effects. */
export const layerControlledProviders = Layer.unwrap(
  Effect.sync(() => {
    const turns: Array<{
      readonly threadId: string;
      readonly runId: string;
      readonly text: string;
    }> = [];
    const unsupported = () =>
      Effect.fail(
        new Adapter.ProviderAdapterProtocolError({
          driver,
          detail: "Unsupported by the controlled fixture",
        }),
      );
    const adapter: Adapter.ProviderAdapterV2["Service"] = {
      instanceId: controlledProviderId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: Effect.fn("ControlledProvider.openSession")(function* (input) {
        const events = yield* PubSub.unbounded<Adapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const runtime: Adapter.ProviderAdapterV2SessionRuntime = {
          instanceId: controlledProviderId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: controlledProviderId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? "",
            model: controlledProviderModel,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: Effect.fn("ControlledProvider.ensureThread")(function* (thread) {
            const createdAt = yield* DateTime.now;
            return {
              id: ProviderThreadId.make(`p21:${thread.threadId}`),
              driver,
              providerInstanceId: controlledProviderId,
              providerSessionId: input.providerSessionId,
              appThreadId: thread.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `p21:${thread.threadId}`,
                strength: "strong",
              },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              contextUsage: null,
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
            } satisfies OrchestrationV2ProviderThread;
          }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          injectHistory: () => Effect.succeed(true),
          compactThread: (turn) => runtime.startTurn(turn),
          startTurn: Effect.fn("ControlledProvider.startTurn")(function* (turn) {
            if (turn.instructionSnapshot && turn.onInstructionsApplied)
              yield* turn.onInstructionsApplied(turn.instructionSnapshot);
            turns.push({ threadId: turn.threadId, runId: turn.runId, text: turn.message.text });
            const at = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(`p21:${turn.runId}`);
            const emitted: ReadonlyArray<Adapter.ProviderAdapterV2Event> = [
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: { driver, nativeId: `p21:${turn.runId}`, strength: "strong" },
                  ordinal: turn.runOrdinal,
                  status: "completed",
                  startedAt: at,
                  completedAt: at,
                },
              },
              {
                type: "message.updated",
                driver,
                message: {
                  id: MessageId.make(`p21-message:${turn.runId}`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  createdBy: "agent",
                  creationSource: "provider",
                  role: "assistant",
                  text: controlledResponse,
                  attachments: [],
                  streaming: false,
                  createdAt: at,
                  updatedAt: at,
                },
              },
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`p21-item:${turn.runId}`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turn.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(`p21-message:${turn.runId}`),
                  text: controlledResponse,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ];
            for (const event of emitted) yield* PubSub.publish(events, event);
          }),
          steerTurn: unsupported,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: unsupported,
          readThreadSnapshot: unsupported,
          rollbackThread: unsupported,
          forkThread: unsupported,
        };
        return runtime;
      }),
    };
    const visible: ReadonlyArray<ServerProvider> = [
      {
        instanceId: controlledProviderId,
        driver,
        displayName: "P21 fixture provider",
        enabled: true,
        installed: true,
        version: "fixture",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00.000Z",
        models: [
          {
            slug: controlledProviderModel,
            name: "Fixture model",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
        supportsTextGeneration: true,
        continuation: { groupKey: "p21-fixture" },
      },
    ];
    return Layer.mergeAll(
      Registry.layerSingle(adapter),
      Layer.succeed(
        ProviderRegistry.ProviderRegistry,
        ProviderRegistry.ProviderRegistry.of({
          getProviders: Effect.succeed(visible),
          refresh: () => Effect.succeed(visible),
          refreshInstance: () => Effect.succeed(visible),
          refreshAfterUpdate: () => Effect.succeed(visible),
          refreshWorkspaceSnapshot: () => Effect.succeed(visible),
          getProviderMaintenanceCapabilitiesForInstance: () =>
            Effect.die("Fixture provider maintenance is disabled"),
          setProviderMaintenanceActionState: () => Effect.succeed(visible),
          streamChanges: Stream.empty,
        }),
      ),
      Layer.succeed(
        ControlledProviderTranscript,
        ControlledProviderTranscript.of({ turns: Effect.sync(() => [...turns]) }),
      ),
    );
  }),
);
