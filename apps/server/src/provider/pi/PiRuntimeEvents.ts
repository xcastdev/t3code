import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  EventId,
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeAgentKey,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import {
  PI_WORKER_MAX_EVENT_BYTES,
  PiNativeReference,
  PiWorkerFrame,
  PiWorkerIdentity,
  PiWorkerOperation,
  PiWorkerProtocolError,
  encodePiWorkerFrame,
} from "./PiWorkerProtocol.ts";

const Context = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  operationOrdinal: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  threadId: ThreadId,
  turnId: TurnId,
  agentKey: Schema.optional(RuntimeAgentKey),
  parentAgentKey: Schema.optional(RuntimeAgentKey),
  sessionId: Schema.optional(PiNativeReference.fields.sessionId),
  identity: PiWorkerIdentity,
  operation: Schema.Struct({
    operationId: PiWorkerOperation.fields.operationId,
    operationKind: Schema.Literal("prompt"),
  }),
});
export type PiRuntimeEventContext = typeof Context.Type;
const strict = { onExcessProperty: "error" } as const;
const decodeCreatedAt = Schema.decodeSync(IsoDateTime);
const decodeContext = Schema.decodeSync(Context, strict);
const decodeFrame = Schema.decodeUnknownSync(PiWorkerFrame, strict);
const EntryId = Schema.String.check(Schema.isPattern(/^message-[1-9][0-9]*$/));
const decodeEntryId = Schema.decodeUnknownSync(EntryId);
const decodeOrdinal = Schema.decodeUnknownSync(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
);
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => {
  throw new PiWorkerProtocolError(code);
};

type Item = {
  readonly itemId: RuntimeItemId;
  readonly providerOrderKey: string;
};
type Message = {
  readonly entryId: string;
  readonly item: Item;
  reasoning: Item | undefined;
};
type Tool = {
  readonly call: Extract<PiWorkerFrame["message"], { type: "tool-call" }>;
  readonly itemId: RuntimeItemId;
  started: Item | undefined;
};
type Translation = {
  readonly disposition: "observed" | "ignored" | "duplicate";
  readonly events: readonly ProviderRuntimeEvent[];
};

/**
 * Observe the full worker stream from sequence zero, after the parent protocol's authority
 * checks. This cursor accepts only exact last-frame replay; restart replay starts at zero
 * and consumers deduplicate its stable event IDs. SDK message-N IDs are worker correlations,
 * not persisted SessionManager entries. The parent must durably allocate operationOrdinal
 * in increasing order per provider/thread/agent, including replacement operations. Item order
 * is captured at start and never claims native SessionManager chronology. The parent owns
 * turn/accounting/drain receipts; item completion reports only its observed outcome.
 */
export function makePiRuntimeEventTranslator(input: PiRuntimeEventContext) {
  const context = decodeContext(input);
  const provider = ProviderDriverKind.make("piAgent");
  const scope = [
    context.providerInstanceId,
    context.threadId,
    context.turnId,
    context.agentKey ?? null,
    context.parentAgentKey ?? null,
    context.identity.workerId,
    context.identity.generation,
    context.operation.operationId,
    context.operation.operationKind,
    context.operationOrdinal,
  ];
  let nextSequence = 0;
  let lastHash: string | undefined;
  let bytes = 0;
  let failed = false;
  let terminal = false;
  let lifecycleId = 0;
  let phase: "idle" | "running" | "ended" | "settled" = "idle";
  let messageOrdinal = 0;
  let callOrdinal = 0;
  let pendingAssistant: Message | undefined;
  const messages = new Map<"user" | "assistant" | "tool", Message>();
  let tool: Tool | undefined;
  const id = (kind: string, correlation: string | number) =>
    `pi-${hash(JSON.stringify([...scope, lifecycleId, kind, correlation]))}`;

  return {
    accept(inputFrame: unknown, createdAt: IsoDateTime): Translation {
      if (failed) return fail("TRANSLATOR_FAILED");
      try {
        const frame = decodeFrame(inputFrame);
        const wire = encodePiWorkerFrame(frame);
        if (
          frame.workerId !== context.identity.workerId ||
          frame.generation !== context.identity.generation ||
          frame.operationId !== context.operation.operationId ||
          frame.operationKind !== context.operation.operationKind
        )
          return fail("IDENTITY_MISMATCH");
        const frameHash = hash(wire.toString("utf8"));
        if (frame.sequence === nextSequence - 1 && frameHash === lastHash)
          return { disposition: "duplicate", events: [] };
        if (frame.sequence !== nextSequence) return fail("FRAME_ORDER");
        if (terminal) return fail("OBSERVATION_TERMINAL");
        if (bytes + wire.length > PI_WORKER_MAX_EVENT_BYTES) return fail("EVENT_BYTE_LIMIT");
        decodeCreatedAt(createdAt);
        const events: ProviderRuntimeEvent[] = [];
        const message = frame.message;
        const requireLifecycle = (value: number) => {
          if (phase !== "running" || value !== lifecycleId) fail("EVENT_LIFECYCLE");
        };
        const startItem = (itemId: RuntimeItemId, subordinal = 0): Item => ({
          itemId,
          providerOrderKey: `${String(context.operationOrdinal).padStart(16, "0")}:${String(frame.sequence).padStart(16, "0")}:${String(subordinal).padStart(2, "0")}`,
        });
        const base = (item: Item, correlation: string) => ({
          eventId: EventId.make(
            `pi-${hash(JSON.stringify([...scope, lifecycleId, correlation, frame.sequence, events.length]))}`,
          ),
          provider,
          providerInstanceId: context.providerInstanceId,
          threadId: context.threadId,
          turnId: context.turnId,
          createdAt,
          ...item,
          sessionGeneration: String(context.identity.generation),
          ...(context.agentKey === undefined ? {} : { agentKey: context.agentKey }),
          ...(context.parentAgentKey === undefined
            ? {}
            : { parentAgentKey: context.parentAgentKey }),
          providerRefs: {
            ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
            providerTurnId: context.operation.operationId,
            providerItemId: ProviderItemId.make(correlation),
          },
        });
        const provenance = {
          source: "pi.worker.sdk-event",
          workerId: context.identity.workerId,
          generation: context.identity.generation,
          operationId: context.operation.operationId,
          lifecycleId,
        };
        const completeAssistant = (
          active: Message,
          status: "completed" | "failed",
          outcome: {
            readonly stopReason?: string;
            readonly failureCode?: string;
            readonly outcome: "completed" | "canceled" | "error";
          },
        ) => {
          const data = { ...provenance, entryId: active.entryId, ...outcome };
          events.push({
            ...base(active.item, active.entryId),
            type: "item.completed",
            payload: { itemType: "assistant_message", status, data },
          });
          if (active.reasoning)
            events.push({
              ...base(active.reasoning, active.entryId),
              type: "item.completed",
              payload: { itemType: "reasoning", status, data },
            });
        };
        const completeTool = (active: Tool, failureCode: string) => {
          if (!active.started) return;
          events.push({
            ...base(active.started, active.call.nativeCallId),
            type: "item.completed",
            payload: {
              itemType: "dynamic_tool_call",
              status: "failed",
              title: active.call.toolName,
              data: {
                ...provenance,
                callId: active.call.callId,
                nativeCallId: active.call.nativeCallId,
                toolName: active.call.toolName,
                execution: active.call.execution,
                failureCode,
                outcome: failureCode === "CANCELED" ? "canceled" : "error",
              },
            },
          });
        };
        const closeFailedItems = (failureCode: string) => {
          const active = messages.get("assistant") ?? pendingAssistant;
          if (active)
            completeAssistant(active, "failed", {
              failureCode,
              outcome: failureCode === "CANCELED" ? "canceled" : "error",
            });
          if (tool) completeTool(tool, failureCode);
          messages.clear();
          pendingAssistant = undefined;
          tool = undefined;
        };
        switch (message.type) {
          case "agent_start":
            if (
              (phase !== "idle" && phase !== "settled") ||
              messages.size ||
              tool ||
              pendingAssistant ||
              message.lifecycleId !== lifecycleId + 1
            )
              return fail("LIFECYCLE_ORDER");
            lifecycleId = message.lifecycleId;
            phase = "running";
            break;
          case "agent_end":
            requireLifecycle(message.lifecycleId);
            if (messages.size || tool || pendingAssistant) return fail("ITEMS_ACTIVE");
            phase = "ended";
            break;
          case "agent_settled":
            if (phase !== "ended" || message.lifecycleId !== lifecycleId)
              return fail("LIFECYCLE_ORDER");
            phase = "settled";
            break;
          case "operation_settled":
            if (phase !== "settled" || message.lifecycleId !== lifecycleId)
              return fail("LIFECYCLE_ORDER");
            break;
          case "done":
            terminal = true;
            break;
          case "worker-failure":
            closeFailedItems(message.code);
            terminal = true;
            break;
          case "tool-call":
            requireLifecycle(message.lifecycleId);
            if (tool || message.callId <= callOrdinal) return fail("TOOL_CALL_ORDER");
            callOrdinal = message.callId;
            tool = {
              call: message,
              itemId: RuntimeItemId.make(
                id("tool", JSON.stringify([message.callId, message.nativeCallId])),
              ),
              started: undefined,
            };
            break;
          case "tool-failure":
            if (!tool || tool.call.callId !== message.callId) return fail("TOOL_CALL_ORDER");
            closeFailedItems(message.code);
            break;
          case "sdk-event": {
            requireLifecycle(message.lifecycleId);
            const event = message.event;
            switch (event.type) {
              case "message_start": {
                decodeEntryId(event.entryId);
                const ordinal = decodeOrdinal(Number(event.entryId.slice(8)));
                if (
                  messages.has(event.role) ||
                  ordinal <= messageOrdinal ||
                  (event.role === "assistant" && pendingAssistant)
                )
                  return fail("MESSAGE_ORDER");
                messageOrdinal = ordinal;
                const active = {
                  entryId: event.entryId,
                  item: startItem(RuntimeItemId.make(id("message", event.entryId))),
                  reasoning: undefined,
                };
                messages.set(event.role, active);
                if (event.role === "assistant")
                  events.push({
                    ...base(active.item, event.entryId),
                    type: "item.started",
                    payload: {
                      itemType: "assistant_message",
                      status: "inProgress",
                      data: { ...provenance, entryId: event.entryId },
                    },
                  });
                break;
              }
              case "message_end": {
                const active = messages.get(event.role);
                if (!active || active.entryId !== event.entryId) return fail("MESSAGE_ORDER");
                if (event.role === "assistant") pendingAssistant = active;
                messages.delete(event.role);
                break;
              }
              case "text_delta":
              case "thinking_delta": {
                const active = messages.get("assistant");
                if (!active) return fail("MESSAGE_ORDER");
                if (event.type === "thinking_delta" && !active.reasoning) {
                  active.reasoning = startItem(RuntimeItemId.make(id("reasoning", active.entryId)));
                  events.push({
                    ...base(active.reasoning, active.entryId),
                    type: "item.started",
                    payload: {
                      itemType: "reasoning",
                      status: "inProgress",
                      data: { ...provenance, entryId: active.entryId },
                    },
                  });
                }
                const item = event.type === "text_delta" ? active.item : active.reasoning;
                if (!item) return fail("MESSAGE_ORDER");
                events.push({
                  ...base(item, active.entryId),
                  type: "content.delta",
                  payload: {
                    delta: event.text,
                    streamKind: event.type === "text_delta" ? "assistant_text" : "reasoning_text",
                  },
                });
                break;
              }
              case "assistant_result":
                if (!pendingAssistant) return fail("MESSAGE_ORDER");
                completeAssistant(
                  pendingAssistant,
                  event.stopReason === "error" || event.stopReason === "aborted"
                    ? "failed"
                    : "completed",
                  {
                    stopReason: event.stopReason,
                    outcome:
                      event.stopReason === "aborted"
                        ? "canceled"
                        : event.stopReason === "error"
                          ? "error"
                          : "completed",
                  },
                );
                pendingAssistant = undefined;
                break;
              case "tool_start":
              case "tool_end": {
                if (
                  !tool ||
                  tool.call.callId !== event.callId ||
                  tool.call.toolName !== event.toolName ||
                  (event.type === "tool_start" ? tool.started : !tool.started)
                )
                  return fail("TOOL_CALL_ORDER");
                const active = tool;
                const item = active.started ?? startItem(active.itemId);
                events.push({
                  ...base(item, active.call.nativeCallId),
                  type: event.type === "tool_start" ? "item.started" : "item.completed",
                  payload: {
                    itemType: "dynamic_tool_call",
                    status:
                      event.type === "tool_start"
                        ? "inProgress"
                        : event.isError
                          ? "failed"
                          : "completed",
                    title: event.toolName,
                    data: {
                      ...provenance,
                      callId: event.callId,
                      nativeCallId: active.call.nativeCallId,
                      toolName: event.toolName,
                      execution: active.call.execution,
                    },
                  },
                });
                if (event.type === "tool_start") active.started = item;
                else tool = undefined;
                break;
              }
            }
            break;
          }
          default:
            break;
        }
        bytes += wire.length;
        nextSequence++;
        lastHash = frameHash;
        return { disposition: events.length ? "observed" : "ignored", events };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  };
}
