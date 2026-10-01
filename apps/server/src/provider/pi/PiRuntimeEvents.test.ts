import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import * as Schema from "effect/Schema";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  IsoDateTime,
  EventId,
  OrchestrationAgentTranscriptEntry,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  RuntimeAgentKey,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { makePiSdkWorker, splitPiWorkerText } from "./PiWorker.ts";
import {
  decodePiWorkerFrame,
  encodePiParentFrame,
  type PiWorkerFrame,
  type PiParentFrame,
  type PiNativeReference,
} from "./PiWorkerProtocol.ts";
import { mergeAgentTranscriptPageWindows } from "../../../../../packages/client-runtime/src/state/subagentRuntime.ts";
import { extractWorkLogToolLifecycleStatus } from "../../../../../packages/client-runtime/src/work-log/presentation.ts";
import { makePiRuntimeEventTranslator, type PiRuntimeEventContext } from "./PiRuntimeEvents.ts";

const context = {
  operationOrdinal: 0,
  providerInstanceId: ProviderInstanceId.make("pi-team"),
  threadId: ThreadId.make("thread-a"),
  turnId: TurnId.make("turn-a"),
  agentKey: RuntimeAgentKey.make("agent-a"),
  identity: { workerId: "worker-a", generation: 7 },
  operation: { operationId: "operation-a", operationKind: "prompt" as const },
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeRuntimeEvent = Schema.decodeSync(ProviderRuntimeEvent, { onExcessProperty: "error" });
const createdAt = Schema.decodeSync(IsoDateTime)("2026-10-01T04:00:00.000Z");
const frame = (sequence: number, message: PiWorkerFrame["message"]): PiWorkerFrame => ({
  version: 1,
  ...context.identity,
  ...context.operation,
  sequence,
  message,
});
const sdk = (
  sequence: number,
  event: Extract<PiWorkerFrame["message"], { type: "sdk-event" }>["event"],
  lifecycleId = 1,
) => frame(sequence, { type: "sdk-event", lifecycleId, event });
const start = frame(0, { type: "agent_start", lifecycleId: 1 });
const messageStart = sdk(1, { type: "message_start", entryId: "message-1", role: "assistant" });

function consume(frames: readonly PiWorkerFrame[]) {
  const translator = makePiRuntimeEventTranslator(context);
  const events = frames.flatMap((value) => translator.accept(value, createdAt).events);
  const text = new Map<string, string>();
  const ids = new Set<string>();
  for (const event of events) {
    decodeRuntimeEvent(event);
    if (ids.has(event.eventId)) continue;
    ids.add(event.eventId);
    if (event.type === "content.delta") {
      const key = `${event.itemId}:${event.payload.streamKind}`;
      text.set(key, (text.get(key) ?? "") + event.payload.delta);
    }
  }
  return { events, text };
}

describe("Pi runtime observations", () => {
  it("reassembles exact bounded worker deltas and completes items without appending phase-end text", () => {
    const text = "\uFEFF" + "a".repeat(8190) + "🧪".repeat(4097) + '\u0000\n\\"';
    const frames = [start, messageStart];
    for (const part of splitPiWorkerText(text))
      frames.push(sdk(frames.length, { type: "text_delta", text: part }));
    frames.push(
      sdk(frames.length, { type: "message_end", entryId: "message-1", role: "assistant" }),
    );
    frames.push(sdk(frames.length, { type: "assistant_result", stopReason: "stop" }));
    frames.push(frame(frames.length, { type: "agent_end", lifecycleId: 1 }));
    frames.push(frame(frames.length, { type: "agent_settled", lifecycleId: 1 }));
    frames.push(
      frame(frames.length, { type: "operation_settled", lifecycleId: 1, outcome: "success" }),
    );
    frames.push(frame(frames.length, { type: "done" }));
    const result = consume(frames);
    expect([...result.text.values()]).toEqual([text]);
    expect(result.events.map((event) => event.type)).toEqual([
      "item.started",
      ...splitPiWorkerText(text).map(() => "content.delta"),
      "item.completed",
    ]);
    expect(
      result.events.every(
        (event) =>
          event.providerInstanceId === context.providerInstanceId &&
          event.agentKey === context.agentKey,
      ),
    ).toBe(true);
    expect(result.events[0]?.nativeEntryId).toBeUndefined();
    expect(result.events[0]?.providerRefs?.sessionId).toBeUndefined();
    expect(result.events[0]?.payload).toMatchObject({ data: { source: "pi.worker.sdk-event" } });
  });

  it("emits separate reasoning and assistant items with deterministic IDs across full replay", () => {
    const frames = [
      start,
      messageStart,
      sdk(2, { type: "thinking_delta", text: "reason" }),
      sdk(3, { type: "text_delta", text: "answer" }),
      sdk(4, { type: "message_end", entryId: "message-1", role: "assistant" }),
      sdk(5, { type: "assistant_result", stopReason: "stop" }),
    ];
    const first = consume(frames);
    expect([...first.text.values()]).toEqual(["reason", "answer"]);
    expect(
      first.events
        .filter((event) => event.type === "item.started")
        .map((event) => event.payload.itemType),
    ).toEqual(["assistant_message", "reasoning"]);
    expect(first.events.filter((event) => event.type === "item.completed")).toHaveLength(2);
    expect(consume(frames).events).toEqual(first.events);
  });

  it("does not append duplicate frames and denies altered replay or replay outside its one-frame window", () => {
    const translator = makePiRuntimeEventTranslator(context);
    translator.accept(start, createdAt);
    translator.accept(messageStart, createdAt);
    const delta = sdk(2, { type: "text_delta", text: "once" });
    expect(translator.accept(delta, createdAt).events).toHaveLength(1);
    expect(translator.accept(delta, createdAt)).toEqual({ disposition: "duplicate", events: [] });
    expect(() =>
      translator.accept(sdk(2, { type: "text_delta", text: "forged" }), createdAt),
    ).toThrow("FRAME_ORDER");
    expect(() => translator.accept(messageStart, createdAt)).toThrow();
  });

  it("preserves two sequential native tool IDs and assigns unique tool items when native IDs repeat", () => {
    const frames: PiWorkerFrame[] = [start];
    for (const callId of [1, 2]) {
      frames.push(
        frame(frames.length, {
          type: "tool-call",
          callId,
          lifecycleId: 1,
          nativeCallId: "call-shared",
          toolName: "echo_assignment",
          execution: "local",
          input: { transferId: `input-${callId}`, totalBytes: 0 },
        }),
      );
      frames.push(sdk(frames.length, { type: "tool_start", callId, toolName: "echo_assignment" }));
      frames.push(
        sdk(frames.length, {
          type: "tool_end",
          callId,
          toolName: "echo_assignment",
          isError: callId === 2,
        }),
      );
    }
    const { events } = consume(frames);
    expect(events.map((event) => event.type)).toEqual([
      "item.started",
      "item.completed",
      "item.started",
      "item.completed",
    ]);
    expect(new Set(events.map((event) => event.itemId)).size).toBe(2);
    expect(events.every((event) => event.providerRefs?.providerItemId === "call-shared")).toBe(
      true,
    );
    expect(events.at(-1)?.payload).toMatchObject({
      status: "failed",
      data: { callId: 2, nativeCallId: "call-shared" },
    });
  });

  it.each([
    { workerId: "other" },
    { generation: 8 },
    { operationId: "other" },
    { operationKind: "compact" },
  ])("rejects forged source identity before output: %j", (change) => {
    const translator = makePiRuntimeEventTranslator(context);
    expect(() => translator.accept({ ...start, ...change }, createdAt)).toThrow(
      "IDENTITY_MISMATCH",
    );
  });

  it.each([
    sdk(0, { type: "text_delta", text: "no lifecycle" }),
    frame(1, { type: "agent_start", lifecycleId: 1 }),
    { ...start, version: 2 },
    {
      ...messageStart,
      sequence: 0,
      message: { type: "sdk-event", lifecycleId: 1, event: { type: "future-benign", text: "hi" } },
    },
    { ...start, authority: "approved" },
    sdk(0, { type: "text_delta", text: "\uD800" }),
    sdk(0, { type: "text_delta", text: "\u0000".repeat(8192) }),
  ])("rejects malformed, future or out-of-order frames without success: %j", (value) => {
    const translator = makePiRuntimeEventTranslator(context);
    expect(() => translator.accept(value, createdAt)).toThrow();
  });

  it.each([
    sdk(2, { type: "message_end", entryId: "message-2", role: "assistant" }),
    sdk(2, { type: "message_start", entryId: "message-1", role: "assistant" }),
    sdk(2, { type: "tool_start", callId: 1, toolName: "echo_assignment" }),
    sdk(2, { type: "text_delta", text: "wrong lifecycle" }, 2),
    frame(2, { type: "agent_end", lifecycleId: 1 }),
  ])("rejects mismatched item/lifecycle ordering: %j", (value) => {
    const translator = makePiRuntimeEventTranslator(context);
    translator.accept(start, createdAt);
    translator.accept(messageStart, createdAt);
    expect(() => translator.accept(value, createdAt)).toThrow();
  });

  it("distinguishes operation, generation, turn, thread, instance and agent routing in stable IDs", () => {
    const contexts = [
      context,
      { ...context, operation: { ...context.operation, operationId: "operation-b" } },
      { ...context, identity: { ...context.identity, generation: 8 } },
      { ...context, turnId: TurnId.make("turn-b") },
      { ...context, threadId: ThreadId.make("thread-b") },
      { ...context, providerInstanceId: ProviderInstanceId.make("pi-other") },
      { ...context, agentKey: RuntimeAgentKey.make("agent-b") },
    ];
    const ids = contexts.map((value) => {
      const translator = makePiRuntimeEventTranslator(value);
      translator.accept({ ...start, ...value.identity, ...value.operation }, createdAt);
      return translator.accept(
        { ...messageStart, ...value.identity, ...value.operation },
        createdAt,
      ).events[0]?.itemId;
    });
    expect(new Set(ids).size).toBe(contexts.length);
  });
});

effectIt.effect(
  "consumes the actual pinned SDK worker's full two-tool stream and retains exact correlations",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "pi-runtime-events-" });
      yield* Effect.promise(async () => {
        const translator = makePiRuntimeEventTranslator(context);
        const events: ProviderRuntimeEvent[] = [];
        const frames: PiWorkerFrame[] = [];
        const answer = "\uFEFF" + "a".repeat(8190) + "🧪".repeat(4097) + '\u0000\n\\"';
        let parentSequence = 0;
        let requests = 0;
        let response: { requestId: number; bytes: Buffer; offset: number } | undefined;
        const send = (message: PiParentFrame["message"]) =>
          worker.acceptParent(
            encodePiParentFrame({
              version: 1,
              ...context.identity,
              ...context.operation,
              sequence: parentSequence++,
              message,
            })
              .toString()
              .slice(0, -1),
          );
        const nextChunk = () => {
          if (!response) throw Error("MISSING_SYNTHETIC_RESPONSE");
          const pending = response;
          if (pending.offset === pending.bytes.length) {
            response = undefined;
            send({ type: "end", requestId: pending.requestId });
          } else {
            const end = Math.min(pending.offset + 8192, pending.bytes.length);
            const data = pending.bytes.subarray(pending.offset, end).toString("base64");
            pending.offset = end;
            send({ type: "chunk", requestId: pending.requestId, data });
          }
        };
        const calls: string[] = [];
        const worker = makePiSdkWorker({
          identity: context.identity,
          operation: context.operation,
          sessionDirectory: scratch,
          localTools: {
            echo_assignment: async (args) => {
              calls.push(String(args.text));
              return { kind: "text", text: String(args.text) };
            },
          },
          emit: async (wire) => {
            const value = decodePiWorkerFrame(wire.toString().slice(0, -1));
            frames.push(value);
            events.push(...translator.accept(value, createdAt).events);
            expect(translator.accept(value, createdAt)).toEqual({
              disposition: "duplicate",
              events: [],
            });
            const message = value.message;
            if (message.type === "request") {
              requests++;
              const delta =
                requests === 1
                  ? {
                      role: "assistant",
                      tool_calls: [1, 2].map((callId) => ({
                        index: callId - 1,
                        id: `call-${callId}`,
                        type: "function",
                        function: {
                          name: "echo_assignment",
                          arguments: JSON.stringify({ text: `tool-${callId}` }),
                        },
                      })),
                    }
                  : { role: "assistant", content: answer };
              const chunk = (value: unknown, finish: string | null = null) => ({
                id: "synthetic",
                object: "chat.completion.chunk",
                created: 1,
                model: "deterministic",
                choices: [{ index: 0, delta: value, finish_reason: finish }],
              });
              const chunks = [
                chunk(delta),
                chunk({}, requests === 1 ? "tool_calls" : "stop"),
                {
                  id: "synthetic",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "deterministic",
                  choices: [],
                  usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
                },
              ];
              response = {
                requestId: message.requestId,
                offset: 0,
                bytes: Buffer.from(
                  chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") +
                    "data: [DONE]\n\n",
                ),
              };
              send({ type: "headers", requestId: message.requestId, status: 200 });
              nextChunk();
            } else if (message.type === "ack") nextChunk();
            else if (
              message.type === "transfer-end" &&
              message.transferId.startsWith("tool-input-")
            )
              send({
                type: "tool-authorized",
                callId: Number(message.transferId.slice(11)),
                allowed: true,
              });
          },
        });
        const transfer = (transferId: string, text: string) => {
          send({
            type: "transfer-chunk",
            transferId,
            index: 0,
            offset: 0,
            data: Buffer.from(text).toString("base64"),
          });
          send({ type: "transfer-end", transferId });
        };
        try {
          const schemaText = encodeJson({
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          });
          send({
            type: "bootstrap",
            executionMode: "ordinary",
            expectedCwd: process.cwd(),
            native: null,
            context: { transferId: "context", totalBytes: 8 },
            prompt: { transferId: "prompt", totalBytes: 9 },
            model: {
              provider: "p7-synthetic",
              modelId: "deterministic",
              api: "openai-completions",
              contextWindow: 32768,
              maxTokens: 512,
              reasoning: false,
            },
            allowedTools: [
              {
                name: "echo_assignment",
                execution: "local",
                description: "Echo bounded text",
                inputSchema: { transferId: "schema", totalBytes: Buffer.byteLength(schemaText) },
              },
            ],
          });
          transfer("context", "Briefing");
          transfer("prompt", "Run tools");
          transfer("schema", schemaText);
          await worker.run();
          expect(requests).toBe(2);
          expect(calls).toEqual(["tool-1", "tool-2"]);
          const toolEvents = events.filter(
            (event) =>
              event.type === "item.started" && event.payload.itemType === "dynamic_tool_call",
          );
          expect(toolEvents.map((event) => event.providerRefs?.providerItemId)).toEqual([
            "call-1",
            "call-2",
          ]);
          expect(new Set(toolEvents.map((event) => event.itemId)).size).toBe(2);
          expect(
            events
              .filter((event) => event.type === "content.delta")
              .map((event) => event.payload.delta)
              .join(""),
          ).toBe(answer);
          expect(
            events.every((event) =>
              ["item.started", "item.completed", "content.delta"].includes(event.type),
            ),
          ).toBe(true);
          expect(frames.at(-1)?.message.type).toBe("done");
          expect(consume(frames).events).toEqual(events);
        } finally {
          await worker.dispose();
        }
      });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

function transcriptRows(events: readonly ProviderRuntimeEvent[]) {
  return events.flatMap((event, eventSequence): OrchestrationAgentTranscriptEntry[] => {
    if (event.type !== "item.completed" || !event.itemId) return [];
    const content = events
      .flatMap((value) =>
        value.type === "content.delta" && value.itemId === event.itemId
          ? [value.payload.delta]
          : [],
      )
      .join("");
    const isTool = event.payload.itemType === "dynamic_tool_call";
    return [
      {
        id: EventId.make(`agent-transcript:${event.itemId}`),
        eventSequence,
        createdAt: event.createdAt,
        kind: isTool ? "tool" : "message",
        role: isTool ? "tool" : "assistant",
        summary: event.payload.title ?? "message",
        content,
        status: event.payload.status === "completed" ? "completed" : "failed",
        ...(event.nativeEntryId === undefined ? {} : { nativeEntryId: event.nativeEntryId }),
        ...(event.providerOrderKey === undefined
          ? {}
          : { providerOrderKey: event.providerOrderKey }),
      },
    ];
  });
}

const completeAssistant = (text: string) => [
  start,
  messageStart,
  sdk(2, { type: "text_delta", text }),
  sdk(3, { type: "message_end", entryId: "message-1", role: "assistant" }),
  sdk(4, { type: "assistant_result", stopReason: "stop" }),
];
const toolCall = frame(2, {
  type: "tool-call",
  lifecycleId: 1,
  callId: 1,
  nativeCallId: "call-1",
  toolName: "echo_assignment",
  execution: "local",
  input: { transferId: "input", totalBytes: 0 },
});

describe("Pi transcript identity, order and honest item outcomes", () => {
  it("retains replaced-operation rows through the shared consumer without synthetic native identities", () => {
    const first = consume(completeAssistant("first")).events;
    const ctx = {
      ...context,
      operationOrdinal: 1,
      turnId: TurnId.make("turn-b"),
      identity: { workerId: "worker-b", generation: 8 },
      operation: { operationId: "operation-b", operationKind: "prompt" as const },
    };
    const translator = makePiRuntimeEventTranslator(ctx);
    const second = completeAssistant("second").flatMap(
      (value) =>
        translator.accept({ ...value, ...ctx.identity, ...ctx.operation }, createdAt).events,
    );
    expect([...first, ...second].every((event) => event.nativeEntryId === undefined)).toBe(true);
    const rows = transcriptRows([...first, ...second]);
    expect(mergeAgentTranscriptPageWindows(rows, rows, []).map((row) => row.content)).toEqual([
      "first",
      "second",
    ]);
    // This reproduces the consumer's former collision using the unsupported correlation.
    expect(
      mergeAgentTranscriptPageWindows(
        rows.map((row) => ({ ...row, nativeEntryId: "message-1" })),
        [],
        [],
      ),
    ).toHaveLength(1);
  });

  it("captures a single stable sortable position for each started assistant/reasoning/tool item", () => {
    const frames = [
      start,
      messageStart,
      sdk(2, { type: "thinking_delta", text: "reason" }),
      sdk(3, { type: "text_delta", text: "answer" }),
      sdk(4, { type: "message_end", entryId: "message-1", role: "assistant" }),
      sdk(5, { type: "assistant_result", stopReason: "toolUse" }),
      { ...toolCall, sequence: 6 },
      sdk(7, { type: "tool_start", callId: 1, toolName: "echo_assignment" }),
      sdk(8, { type: "tool_end", callId: 1, toolName: "echo_assignment", isError: false }),
    ];
    const events = consume(frames).events;
    for (const itemId of new Set(events.map((event) => event.itemId))) {
      const keys = events
        .filter((event) => event.itemId === itemId)
        .map((event) => event.providerOrderKey);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(/^\d{16}:\d{16}:\d{2}$/);
    }
  });

  it("orders same-timestamp 9/10/11 operations in the shared thread/agent consumer", () => {
    const rows = [10, 11, 9].flatMap((operationOrdinal) => {
      const ctx = {
        ...context,
        operationOrdinal,
        turnId: TurnId.make(`turn-${operationOrdinal}`),
        identity: { workerId: `worker-${12 - operationOrdinal}`, generation: operationOrdinal },
        operation: {
          operationId: `operation-${12 - operationOrdinal}`,
          operationKind: "prompt" as const,
        },
      };
      const translator = makePiRuntimeEventTranslator(ctx);
      return transcriptRows(
        completeAssistant(`operation ${operationOrdinal}`).flatMap(
          (value) =>
            translator.accept({ ...value, ...ctx.identity, ...ctx.operation }, createdAt).events,
        ),
      );
    });
    expect(mergeAgentTranscriptPageWindows(rows, rows, []).map((row) => row.content)).toEqual([
      "operation 9",
      "operation 10",
      "operation 11",
    ]);
  });

  it.each(["stop", "toolUse", "error", "aborted"] as const)(
    "waits for assistant_result and reports %s honestly",
    (stopReason) => {
      const translator = makePiRuntimeEventTranslator(context);
      translator.accept(start, createdAt);
      translator.accept(messageStart, createdAt);
      translator.accept(sdk(2, { type: "thinking_delta", text: "reason" }), createdAt);
      expect(
        translator.accept(
          sdk(3, { type: "message_end", entryId: "message-1", role: "assistant" }),
          createdAt,
        ).events,
      ).toEqual([]);
      const completion = sdk(4, { type: "assistant_result", stopReason });
      const events = translator.accept(completion, createdAt).events;
      expect(events).toHaveLength(2);
      expect(
        events.every(
          (event) =>
            event.type === "item.completed" &&
            event.payload.status ===
              (stopReason === "error" || stopReason === "aborted" ? "failed" : "completed"),
        ),
      ).toBe(true);
      if (stopReason === "error" || stopReason === "aborted")
        expect(events[0]?.payload).toMatchObject({
          data: { stopReason, outcome: stopReason === "aborted" ? "canceled" : "error" },
        });
      expect(translator.accept(completion, createdAt).events).toEqual([]);
    },
  );

  it.each(["CANCELED", "SDK_FAILURE"])(
    "closes active or pending assistant/reasoning items once on %s",
    (code) => {
      for (const pending of [false, true]) {
        const translator = makePiRuntimeEventTranslator(context);
        translator.accept(start, createdAt);
        translator.accept(messageStart, createdAt);
        translator.accept(sdk(2, { type: "thinking_delta", text: "partial thought" }), createdAt);
        if (pending)
          translator.accept(
            sdk(3, { type: "message_end", entryId: "message-1", role: "assistant" }),
            createdAt,
          );
        const failure = frame(pending ? 4 : 3, { type: "worker-failure", code });
        const events = translator.accept(failure, createdAt).events;
        expect(events).toHaveLength(2);
        expect(
          events.every(
            (event) => event.type === "item.completed" && event.payload.status === "failed",
          ),
        ).toBe(true);
        expect(events[0]?.payload).toMatchObject({
          data: { failureCode: code, outcome: code === "CANCELED" ? "canceled" : "error" },
        });
        expect(translator.accept(failure, createdAt).events).toEqual([]);
      }
    },
  );

  it.each(["tool-failure", "worker-failure"] as const)(
    "closes started tools on %s without closing an unstarted or already closed tool",
    (type) => {
      for (const started of [false, true]) {
        const translator = makePiRuntimeEventTranslator(context);
        translator.accept(start, createdAt);
        translator.accept({ ...toolCall, sequence: 1 }, createdAt);
        if (started)
          translator.accept(
            sdk(2, { type: "tool_start", callId: 1, toolName: "echo_assignment" }),
            createdAt,
          );
        const failure = frame(
          started ? 3 : 2,
          type === "tool-failure"
            ? { type, callId: 1, code: "CANCELED" }
            : { type, code: "CANCELED" },
        );
        const events = translator.accept(failure, createdAt).events;
        expect(events).toHaveLength(started ? 1 : 0);
        if (started) {
          expect(events[0]?.type).toBe("item.completed");
          expect(extractWorkLogToolLifecycleStatus(events[0]?.payload)).toBe("failed");
          expect(events[0]?.payload).toMatchObject({
            data: { outcome: "canceled", nativeCallId: "call-1" },
          });
        }
        expect(translator.accept(failure, createdAt).events).toEqual([]);
        if (type === "tool-failure")
          expect(
            translator.accept(
              frame(started ? 4 : 3, { type: "worker-failure", code: "CANCELED" }),
              createdAt,
            ).events,
          ).toEqual([]);
      }
    },
  );
});

type ActualScenario = "text" | "error" | "tool" | "cancel-tool" | "cancel-partial";

async function actualSdkOperation(
  ctx: PiRuntimeEventContext,
  sessionDirectory: string,
  scenario: ActualScenario,
  text: string,
  native: PiNativeReference | null = null,
) {
  const translator = makePiRuntimeEventTranslator(ctx);
  const events: ProviderRuntimeEvent[] = [];
  const frames: PiWorkerFrame[] = [];
  let parentSequence = 0;
  let requests = 0;
  let callbacks = 0;
  let response: { requestId: number; bytes: Buffer; offset: number } | undefined;
  const send = (message: PiParentFrame["message"]) =>
    worker.acceptParent(
      encodePiParentFrame({
        version: 1,
        ...ctx.identity,
        ...ctx.operation,
        sequence: parentSequence++,
        message,
      })
        .toString()
        .slice(0, -1),
    );
  const nextChunk = () => {
    if (!response) throw Error("MISSING_SYNTHETIC_RESPONSE");
    const pending = response;
    if (pending.offset === pending.bytes.length) {
      if (scenario === "cancel-partial") return; // No finish bytes; interruption owns this active stream.
      response = undefined;
      send({ type: "end", requestId: pending.requestId });
    } else {
      const end = Math.min(pending.offset + 8192, pending.bytes.length);
      const data = pending.bytes.subarray(pending.offset, end).toString("base64");
      pending.offset = end;
      send({ type: "chunk", requestId: pending.requestId, data });
    }
  };
  const tools = scenario === "tool" || scenario === "cancel-tool";
  const worker = makePiSdkWorker({
    identity: ctx.identity,
    operation: ctx.operation,
    sessionDirectory,
    localTools: {
      echo_assignment: async () => {
        callbacks++;
        return { kind: "text", text: "echoed" };
      },
    },
    emit: async (wire) => {
      const value = decodePiWorkerFrame(wire.toString().slice(0, -1));
      frames.push(value);
      events.push(...translator.accept(value, createdAt).events);
      const message = value.message;
      if (message.type === "request") {
        requests++;
        const delta =
          tools && requests === 1
            ? {
                role: "assistant",
                content: "before tools",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "echo_assignment", arguments: "{}" },
                  },
                ],
              }
            : scenario === "cancel-partial"
              ? {
                  role: "assistant",
                  reasoning_content: "partial thought",
                  content: "partial answer",
                }
              : { role: "assistant", content: tools ? "after tools" : text };
        const chunk = (delta: Schema.Json, finish_reason: string | null = null) => ({
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "deterministic",
          choices: [{ index: 0, delta, finish_reason }],
        });
        const chunks: Schema.Json[] =
          scenario === "cancel-partial"
            ? [
                chunk({ role: "assistant", reasoning_content: "partial thought" }),
                chunk({ content: "partial answer" }),
              ]
            : [chunk(delta)];
        if (scenario !== "cancel-partial")
          chunks.push(
            chunk(
              {},
              scenario === "error"
                ? "network_error"
                : tools && requests === 1
                  ? "tool_calls"
                  : "stop",
            ),
            {
              id: "synthetic",
              object: "chat.completion.chunk",
              created: 1,
              model: "deterministic",
              choices: [],
              usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
            },
          );
        response = {
          requestId: message.requestId,
          offset: 0,
          bytes: Buffer.from(
            chunks.map((value) => `data: ${encodeJson(value)}\n\n`).join("") +
              (scenario === "cancel-partial" ? "" : "data: [DONE]\n\n"),
          ),
        };
        send({ type: "headers", requestId: message.requestId, status: 200 });
        nextChunk();
      } else if (message.type === "ack") nextChunk();
      else if (message.type === "transfer-end" && message.transferId.startsWith("tool-input-"))
        send({
          type: "tool-authorized",
          callId: Number(message.transferId.slice(11)),
          allowed: true,
        });
      else if (
        message.type === "sdk-event" &&
        ((scenario === "cancel-tool" && message.event.type === "tool_start") ||
          (scenario === "cancel-partial" && message.event.type === "text_delta"))
      )
        send({ type: "interrupt", controlId: 1 });
    },
  });
  const transfer = (transferId: string, text: string) => {
    send({
      type: "transfer-chunk",
      transferId,
      index: 0,
      offset: 0,
      data: Buffer.from(text).toString("base64"),
    });
    send({ type: "transfer-end", transferId });
  };
  let failure: string | undefined;
  try {
    send({
      type: "bootstrap",
      executionMode: "ordinary",
      expectedCwd: process.cwd(),
      native,
      context: { transferId: "context", totalBytes: 8 },
      prompt: { transferId: "prompt", totalBytes: 9 },
      model: {
        provider: "p7-synthetic",
        modelId: "deterministic",
        api: "openai-completions",
        contextWindow: 32768,
        maxTokens: 512,
        reasoning: false,
      },
      allowedTools: tools
        ? [{ name: "echo_assignment", execution: "local", description: "Echo bounded text" }]
        : [],
    });
    transfer("context", "Briefing");
    transfer("prompt", "Run tools");
    await worker.run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    failure = error.message;
  } finally {
    await worker.dispose();
  }
  const nativeMessage = frames.findLast((value) => value.message.type === "native")?.message;
  return {
    frames,
    events,
    requests,
    callbacks,
    failure,
    native: nativeMessage?.type === "native" ? nativeMessage.native : null,
  };
}

const encodeTrace = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const retainTrace = (fs: FileSystem.FileSystem, name: string, value: unknown) => {
  const directory = process.env.PI_RUNTIME_EVENTS_EVIDENCE_DIRECTORY;
  return directory === undefined
    ? Effect.void
    : fs.writeFileString(`${directory}/${name}.json`, encodeTrace(value));
};

effectIt.effect(
  "preserves actual SDK fresh/resumed rows and synthetic-correlation collision controls in the shared consumer",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "pi-runtime-events-resume-" });
      const first = yield* Effect.promise(() =>
        actualSdkOperation({ ...context, operationOrdinal: 9 }, scratch, "text", "first"),
      );
      expect(first.failure).toBeUndefined();
      expect(first.native).not.toBeNull();
      const resumedContext = {
        ...context,
        operationOrdinal: 10,
        turnId: TurnId.make("turn-b"),
        identity: { workerId: "worker-b", generation: 8 },
        operation: { operationId: "operation-b", operationKind: "prompt" as const },
      };
      const second = yield* Effect.promise(() =>
        actualSdkOperation(resumedContext, scratch, "text", "second", first.native),
      );
      expect(second.failure).toBeUndefined();
      expect(second.native?.sessionId).toBe(first.native?.sessionId);
      expect(second.native?.leafId).not.toBe(first.native?.leafId);
      const rows = transcriptRows([...first.events, ...second.events]);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.nativeEntryId === undefined)).toBe(true);
      expect(mergeAgentTranscriptPageWindows(rows, rows, []).map((row) => row.content)).toEqual([
        "first",
        "second",
      ]);
      const correlations = [first, second].map((result) =>
        result.frames.flatMap((value) =>
          value.message.type === "sdk-event" &&
          value.message.event.type === "message_start" &&
          value.message.event.role === "assistant"
            ? [value.message.event.entryId]
            : [],
        ),
      );
      expect(correlations[0]).toEqual(correlations[1]);
      expect(
        mergeAgentTranscriptPageWindows(
          rows.map((row) => ({ ...row, nativeEntryId: "message-2" })),
          [],
          [],
        ),
      ).toHaveLength(1);
      yield* retainTrace(fs, "actual-fresh-resume", { first, second, rows, correlations });
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);

effectIt.effect("orders an actual SDK text/tool/text turn through the shared consumer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "pi-runtime-events-order-" });
    const result = yield* Effect.promise(() => actualSdkOperation(context, scratch, "tool", ""));
    expect(result.failure).toBeUndefined();
    expect(result.callbacks).toBe(1);
    const rows = transcriptRows(result.events);
    expect(
      mergeAgentTranscriptPageWindows(rows.toReversed(), [], rows).map((row) => row.content),
    ).toEqual(["before tools", "", "after tools"]);
    for (const row of rows) {
      const keys = result.events
        .filter((event) => `agent-transcript:${event.itemId}` === row.id)
        .map((event) => event.providerOrderKey);
      expect(new Set(keys).size).toBe(1);
    }
    yield* retainTrace(fs, "actual-text-tool-text", { ...result, rows });
  }).pipe(Effect.provide(NodeFileSystem.layer)),
);

effectIt.effect.each(["error", "cancel-tool", "cancel-partial"] as const)(
  "closes actual SDK %s items with failed outcomes",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "pi-runtime-events-failure-" });
      const result = yield* Effect.promise(() =>
        actualSdkOperation(context, scratch, scenario, "partial"),
      );
      yield* retainTrace(fs, `actual-${scenario}`, result);
      expect(result.failure).toBeDefined();
      const last = result.frames.at(-1)?.message;
      expect(last).toMatchObject({
        type: "worker-failure",
        code: scenario === "error" ? "SDK_FAILURE" : "CANCELED",
      });
      const ends = result.events.filter((event) => event.type === "item.completed");
      if (scenario === "error") {
        expect(ends).toHaveLength(1);
        expect(ends[0]?.payload).toMatchObject({
          status: "failed",
          data: { stopReason: "error", outcome: "error" },
        });
      } else if (scenario === "cancel-tool") {
        expect(result.callbacks).toBe(0);
        expect(ends.filter((event) => event.payload.itemType === "dynamic_tool_call")).toHaveLength(
          1,
        );
        expect(extractWorkLogToolLifecycleStatus(ends.at(-1)?.payload)).toBe("failed");
        expect(ends.at(-1)?.payload).toMatchObject({
          status: "failed",
          data: { failureCode: "CANCELED", outcome: "canceled" },
        });
      } else {
        expect(ends).toHaveLength(2);
        expect(ends.map((event) => event.payload.itemType)).toEqual([
          "assistant_message",
          "reasoning",
        ]);
        expect(ends.every((event) => event.payload.status === "failed")).toBe(true);
        expect(ends[0]?.payload).toMatchObject({
          data: { failureCode: "CANCELED", outcome: "canceled" },
        });
      }
      const starts = result.events.filter((event) => event.type === "item.started");
      expect(starts.every((event) => ends.some((end) => end.itemId === event.itemId))).toBe(true);
      expect(new Set(ends.map((event) => event.itemId)).size).toBe(ends.length);
      expect(result.events.some((event) => event.type === "turn.completed")).toBe(false);
    }).pipe(Effect.provide(NodeFileSystem.layer)),
);
