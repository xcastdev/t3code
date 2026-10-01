import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  PI_WORKER_MAX_CHUNK_BYTES,
  PI_WORKER_MAX_REQUEST_BYTES,
  PI_WORKER_MAX_RESPONSE_BYTES,
} from "./PiWorkerProtocol.ts";

const strict = { onExcessProperty: "error" } as const;
const Integer = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Integer.check(Schema.isGreaterThan(0));
const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Text = Schema.String.check(
  Schema.makeFilter((s) => Buffer.byteLength(s) <= PI_WORKER_MAX_REQUEST_BYTES),
);
const Content = Schema.Union([
  Text,
  Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Text })).check(
    Schema.isMaxLength(128),
  ),
]);
const FunctionCall = Schema.Struct({
  id: Name,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Name, arguments: Text }),
});
const FunctionTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Name, description: Text, parameters: Schema.JsonObject }),
});
const Message = Schema.Union([
  Schema.Struct({ role: Schema.Literals(["system", "user"]), content: Content }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Content),
    tool_calls: Schema.optional(Schema.Array(FunctionCall).check(Schema.isMaxLength(32))),
  }),
  Schema.Struct({
    role: Schema.Literal("tool"),
    content: Text,
    tool_call_id: Name,
    name: Schema.optional(Name),
  }),
]);
const Request = Schema.Struct({
  model: Text,
  messages: Schema.Array(Message).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  stream: Schema.Literal(true),
  stream_options: Schema.Struct({ include_usage: Schema.Literal(true) }),
  store: Schema.optional(Schema.Literal(false)),
  max_tokens: Positive,
  temperature: Schema.optional(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 2 }))),
  tools: Schema.optional(Schema.Array(FunctionTool).check(Schema.isMaxLength(32))),
  tool_choice: Schema.optional(Schema.Literals(["auto", "none", "required"])),
});
const Usage = Schema.Struct({
  prompt_tokens: Integer,
  completion_tokens: Integer,
  total_tokens: Integer,
  prompt_tokens_details: Schema.optional(
    Schema.Struct({
      cached_tokens: Schema.optional(Integer),
      cache_write_tokens: Schema.optional(Integer),
    }),
  ),
  completion_tokens_details: Schema.optional(
    Schema.Struct({
      reasoning_tokens: Schema.optional(Integer),
      accepted_prediction_tokens: Schema.optional(Integer),
      rejected_prediction_tokens: Schema.optional(Integer),
      audio_tokens: Schema.optional(Integer),
    }),
  ),
  prompt_cache_hit_tokens: Schema.optional(Integer),
  prompt_cache_miss_tokens: Schema.optional(Integer),
  cached_tokens: Schema.optional(Integer),
});
const Delta = Schema.Struct({
  role: Schema.optional(Schema.Literal("assistant")),
  content: Schema.optional(Schema.NullOr(Text)),
  tool_calls: Schema.optional(
    Schema.Array(
      Schema.Struct({
        index: Integer,
        id: Schema.optional(Name),
        type: Schema.optional(Schema.Literal("function")),
        function: Schema.Struct({ name: Schema.optional(Name), arguments: Schema.optional(Text) }),
      }),
    ).check(Schema.isMaxLength(32)),
  ),
});
const Native = Schema.Struct({
  id: Schema.optional(Text),
  object: Schema.optional(Text),
  created: Schema.optional(Integer),
  model: Text,
  system_fingerprint: Schema.optional(Schema.NullOr(Text)),
  choices: Schema.Array(
    Schema.Struct({
      index: Schema.Literal(0),
      delta: Delta,
      finish_reason: Schema.NullOr(Schema.Literals(["stop", "tool_calls", "length"])),
      logprobs: Schema.optional(Schema.Null),
    }),
  ).check(Schema.isMaxLength(1)),
  usage: Schema.optional(Schema.NullOr(Usage)),
});
const decodeRequest = Schema.decodeSync(Schema.fromJsonString(Request), strict);
const decodeNative = Schema.decodeSync(Schema.fromJsonString(Native), strict);
const encodeNative = Schema.encodeSync(Schema.fromJsonString(Native));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json), strict);
const decodeArguments = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject), strict);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeTools = Schema.decodeUnknownSync(Schema.Array(FunctionTool), strict);
const decodeName = Schema.decodeSync(Name);
const decodeInteger = Schema.decodeSync(Integer);
const decodePositive = Schema.decodeSync(Positive);
export type PiModelUsage = typeof Usage.Type;
export type PiModelTool = typeof FunctionTool.Type;

export type PiModelBrokerErrorCode =
  | "ACCOUNTING_RECEIPT_INVALID"
  | "ACCOUNTING_RECEIPT_REQUIRED"
  | "AUTHORIZATION_REJECTED"
  | "CONFIG_CALLBACK_REQUIRED"
  | "CONFIG_LIMITS_INVALID"
  | "CONFIG_ROUTE_INVALID"
  | "CONFIG_TOOLS_INVALID"
  | "CREDENTIAL_ECHO_REJECTED"
  | "CREDENTIAL_INVALID"
  | "CREDENTIAL_UNAVAILABLE"
  | "FORWARD_FAILED"
  | "REQUEST_ABORTED"
  | "REQUEST_BYTE_LIMIT"
  | "REQUEST_CONCURRENT"
  | "REQUEST_COUNT_LIMIT"
  | "REQUEST_FAILED"
  | "REQUEST_INPUT_LIMIT"
  | "REQUEST_INVALID"
  | "REQUEST_MODEL_OR_OUTPUT_INVALID"
  | "REQUEST_REPLAY"
  | "REQUEST_TOOL_ARGUMENTS_INVALID"
  | "REQUEST_TOOL_HISTORY_INVALID"
  | "REQUEST_TOOL_NOT_AUTHORIZED"
  | "REQUEST_TOOL_RESULT_INVALID"
  | "REQUEST_TOOL_RESULT_REQUIRED"
  | "RESERVATION_FAILED"
  | "RESERVATION_RECEIPT_INVALID"
  | "RESPONSE_BYTE_LIMIT"
  | "SETTLEMENT_FAILED"
  | "SSE_ACCOUNTING_REQUIRED"
  | "SSE_AFTER_ACCOUNTING"
  | "SSE_CHOICE_INVALID"
  | "SSE_CONTENT_REQUIRED"
  | "SSE_FRAME_BYTE_LIMIT"
  | "SSE_FRAME_INVALID"
  | "SSE_MODEL_REJECTED"
  | "SSE_OUTPUT_LIMIT"
  | "SSE_PRELIMINARY_INVALID"
  | "SSE_TOOL_INVALID"
  | "SSE_USAGE_INVALID"
  | "SSE_USAGE_OVER_RESERVATION"
  | "TRANSPORT_DRAIN_FAILED"
  | "TRANSPORT_FAILED"
  | "TRANSPORT_RESPONSE_REJECTED";

export class PiModelBrokerError extends Error {
  readonly code: PiModelBrokerErrorCode;
  constructor(code: PiModelBrokerErrorCode) {
    super(code);
    this.name = "PiModelBrokerError";
    this.code = code;
  }
}
function fail(code: PiModelBrokerErrorCode): never {
  throw new PiModelBrokerError(code);
}

export interface PiModelRequestReservation {
  readonly workerId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly requestId: number;
  readonly routeId: string;
  readonly provider: "command-code";
  readonly model: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly callCount: 1;
  readonly deadlineAtMs: number;
}
export interface PiModelRequestSettlement extends PiModelRequestReservation {
  readonly reservationId: string;
  readonly outcome: "reported" | "failed" | "unknown";
  readonly failureCode?: PiModelBrokerErrorCode;
  readonly chargedInputTokens: number;
  readonly chargedOutputTokens: number;
  readonly reportedModel?: string;
  readonly reportedUsage?: PiModelUsage;
}
export interface PiModelAccountingReceipt {
  readonly requestId: number;
  readonly reservationId: string;
  readonly accountingReceiptId: string;
  readonly routeId: string;
  readonly provider: "command-code";
  readonly model: string;
  readonly reportedModel: string;
  readonly usage: PiModelUsage;
}
export interface PiModelBrokerConfig {
  readonly workerId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly routeId: string;
  readonly provider: "command-code";
  readonly model: string;
  readonly endpoint: string;
  readonly acceptedReportedModels: readonly string[];
  readonly tools: readonly PiModelTool[];
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly deadlineMs: number;
  readonly getCredential: (signal: AbortSignal) => Promise<string>;
  readonly authorizeCurrent: (
    phase: "beforeReserve" | "beforeTransport" | "beforeForward" | "beforeReturn",
    signal: AbortSignal,
  ) => Promise<void>;
  readonly reserveRequest: (
    reservation: PiModelRequestReservation,
    signal: AbortSignal,
  ) => Promise<{ readonly reservationId: string }>;
  // Settlement must commit after abort and support idempotent same-key reported -> failed upgrades.
  // Identity/route/model are immutable; charges only increase on an upgrade. The durable producer owns this guarantee.
  readonly settleRequest: (
    settlement: PiModelRequestSettlement,
  ) => Promise<{ readonly accountingReceiptId: string }>;
  // Exactly one parent transport per reservation. Implementations must honor AbortSignal and disable retries.
  readonly transport: (
    endpoint: string,
    init: {
      readonly method: "POST";
      readonly redirect: "error";
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      readonly signal: AbortSignal;
    },
  ) => Promise<Response>;
}
export interface PiModelBrokerRequest {
  readonly requestId: number;
  readonly body: string;
  readonly signal: AbortSignal;
  // Runtime supplies the single-chunk ACK window; resolving this promise permits the next chunk.
  readonly onChunk: (chunk: Uint8Array, signal: AbortSignal) => Promise<void>;
}

// Stable equality permits harmless JSON key order differences without allowing different tool schemas.
function canonical(value: Schema.Json): string {
  if (value === null || typeof value !== "object") return encodeJson(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${encodeJson(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

export function makePiModelBroker(input: PiModelBrokerConfig) {
  // Capture parent configuration and schemas before worker data or asynchronous callbacks can mutate it.
  let tools: ReadonlyArray<PiModelTool>;
  try {
    tools = decodeTools(decodeJson(encodeJson(input.tools)));
  } catch {
    return fail("CONFIG_TOOLS_INVALID");
  }
  const cfg = { ...input, tools, acceptedReportedModels: [...input.acceptedReportedModels] };
  if (
    cfg.provider !== "command-code" ||
    cfg.model !== "inclusionai/ling-3.1-flash:free" ||
    cfg.endpoint !== "https://api.commandcode.ai/provider/v1/chat/completions" ||
    cfg.acceptedReportedModels.length < 1 ||
    cfg.acceptedReportedModels.length > 2 ||
    cfg.acceptedReportedModels.some((m) => m !== cfg.model && m !== "inclusionai/ling-3.1-flash") ||
    new Set(cfg.acceptedReportedModels).size !== cfg.acceptedReportedModels.length
  )
    fail("CONFIG_ROUTE_INVALID");
  try {
    decodeName(cfg.workerId);
    decodeName(cfg.operationId);
    decodeName(cfg.routeId);
    decodeInteger(cfg.generation);
    decodePositive(cfg.maxInputTokens);
    decodePositive(cfg.maxOutputTokens);
    decodePositive(cfg.deadlineMs);
  } catch {
    fail("CONFIG_LIMITS_INVALID");
  }
  if (cfg.deadlineMs > 300_000 || cfg.maxInputTokens > 1_000_000 || cfg.maxOutputTokens > 65_536)
    fail("CONFIG_LIMITS_INVALID");
  if (
    [
      cfg.authorizeCurrent,
      cfg.getCredential,
      cfg.reserveRequest,
      cfg.settleRequest,
      cfg.transport,
    ].some((f) => typeof f !== "function")
  )
    fail("CONFIG_CALLBACK_REQUIRED");
  const allowedTools = new Map(tools.map((tool) => [tool.function.name, canonical(tool)]));
  if (
    tools.length > 32 ||
    allowedTools.size !== tools.length ||
    Buffer.byteLength(encodeJson(tools)) > 65_536
  )
    fail("CONFIG_TOOLS_INVALID");
  const usedRequestIds = new Set<number>();
  let active = false;

  const request = async (operation: PiModelBrokerRequest): Promise<PiModelAccountingReceipt> => {
    let parsed: typeof Request.Type;
    try {
      if (Buffer.byteLength(operation.body) > PI_WORKER_MAX_REQUEST_BYTES)
        fail("REQUEST_BYTE_LIMIT");
      parsed = decodeRequest(operation.body);
      decodePositive(operation.requestId);
    } catch (error) {
      if (error instanceof PiModelBrokerError) throw error;
      return fail("REQUEST_INVALID");
    }
    if (usedRequestIds.has(operation.requestId)) fail("REQUEST_REPLAY");
    if (active) fail("REQUEST_CONCURRENT");
    if (usedRequestIds.size >= 1_024) fail("REQUEST_COUNT_LIMIT");
    if (parsed.model !== cfg.model || parsed.max_tokens > cfg.maxOutputTokens)
      fail("REQUEST_MODEL_OR_OUTPUT_INVALID");
    // UTF-8 bytes conservatively bound the plain text tokenizer's input, including the serialized overhead.
    if (Buffer.byteLength(operation.body) > cfg.maxInputTokens) fail("REQUEST_INPUT_LIMIT");
    const advertised = new Set<string>();
    for (const tool of parsed.tools ?? []) {
      if (
        allowedTools.get(tool.function.name) !== canonical(tool) ||
        advertised.has(tool.function.name)
      )
        fail("REQUEST_TOOL_NOT_AUTHORIZED");
      advertised.add(tool.function.name);
    }
    const calls = new Map<string, string>();
    const completed = new Set<string>();
    for (const message of parsed.messages) {
      if (message.role === "assistant")
        for (const call of message.tool_calls ?? []) {
          if (!allowedTools.has(call.function.name) || calls.has(call.id) || calls.size >= 32)
            fail("REQUEST_TOOL_HISTORY_INVALID");
          try {
            decodeArguments(call.function.arguments);
          } catch {
            fail("REQUEST_TOOL_ARGUMENTS_INVALID");
          }
          calls.set(call.id, call.function.name);
        }
      if (message.role === "tool") {
        const name = calls.get(message.tool_call_id);
        if (
          !name ||
          completed.has(message.tool_call_id) ||
          (message.name !== undefined && message.name !== name)
        )
          fail("REQUEST_TOOL_RESULT_INVALID");
        completed.add(message.tool_call_id);
      }
    }
    if (completed.size !== calls.size) fail("REQUEST_TOOL_RESULT_REQUIRED");
    usedRequestIds.add(operation.requestId);
    active = true;
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(cfg.deadlineMs);
    const abort = () => controller.abort();
    deadline.addEventListener("abort", abort, { once: true });
    operation.signal.addEventListener("abort", abort, { once: true });
    if (operation.signal.aborted) abort();
    const check = () => {
      if (controller.signal.aborted) fail("REQUEST_ABORTED");
    };
    const authorize = async (phase: Parameters<PiModelBrokerConfig["authorizeCurrent"]>[0]) => {
      check();
      try {
        await cfg.authorizeCurrent(phase, controller.signal);
      } catch {
        fail("AUTHORIZATION_REJECTED");
      }
      check();
    };
    const reservation: PiModelRequestReservation = {
      workerId: cfg.workerId,
      generation: cfg.generation,
      operationId: cfg.operationId,
      requestId: operation.requestId,
      routeId: cfg.routeId,
      provider: cfg.provider,
      model: cfg.model,
      maxInputTokens: cfg.maxInputTokens,
      maxOutputTokens: parsed.max_tokens,
      callCount: 1,
      deadlineAtMs: DateTime.toEpochMillis(DateTime.nowUnsafe()) + cfg.deadlineMs,
    };
    let reservationId: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelPending: Promise<void> | undefined;
    let cancelFailed = false;
    const cancelReader = () => {
      if (reader && !cancelPending)
        cancelPending = reader.cancel().catch(() => {
          cancelFailed = true;
        });
    };
    let usage: PiModelUsage | undefined;
    let reportedModel: string | undefined;
    let failure: PiModelBrokerError | undefined;
    let receiptId: string | undefined;
    try {
      await authorize("beforeReserve");
      try {
        reservationId = (await cfg.reserveRequest(reservation, controller.signal)).reservationId;
      } catch {
        fail("RESERVATION_FAILED");
      }
      if (!reservationId || reservationId.length > 256) fail("RESERVATION_RECEIPT_INVALID");
      check();
      let credential: string;
      try {
        credential = await cfg.getCredential(controller.signal);
      } catch {
        fail("CREDENTIAL_UNAVAILABLE");
      }
      if (!credential || Buffer.byteLength(credential) > 8_192 || /[\r\n]/.test(credential))
        fail("CREDENTIAL_INVALID");
      await authorize("beforeTransport");
      let response: Response;
      try {
        response = await cfg.transport(cfg.endpoint, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
          body: encodeRequest({ ...parsed, model: cfg.model }),
          signal: controller.signal,
        });
      } catch {
        fail(controller.signal.aborted ? "REQUEST_ABORTED" : "TRANSPORT_FAILED");
      }
      check();
      if (
        response.redirected ||
        response.status !== 200 ||
        !response.body ||
        response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
          "text/event-stream"
      ) {
        try {
          await response.body?.cancel();
        } catch {
          fail("TRANSPORT_DRAIN_FAILED");
        }
        fail("TRANSPORT_RESPONSE_REJECTED");
      }
      reader = response.body.getReader();
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      const secret = Buffer.from(credential);
      let rawTail = Buffer.alloc(0);
      let semanticTail = Buffer.alloc(0);
      let responseBytes = 0;
      let contentSeen = false;
      let finishSeen = false;
      let done = false;
      const outputCalls = new Map<number, { name: string; id: string }>();
      const pending: Array<{ bytes: Buffer; semanticBytes: number }> = [];
      let pendingSemanticBytes = 0;
      let outputBytes = 0;
      let frameCount = 0;
      const enqueue = (bytes: Uint8Array, semanticBytes: number) => {
        if (outputBytes + bytes.length > PI_WORKER_MAX_RESPONSE_BYTES) fail("RESPONSE_BYTE_LIMIT");
        outputBytes += bytes.length;
        pending.push({ bytes: Buffer.from(bytes), semanticBytes });
        pendingSemanticBytes += semanticBytes;
      };
      const forward = async (bytes: Uint8Array) => {
        for (let offset = 0; offset < bytes.length; offset += PI_WORKER_MAX_CHUNK_BYTES) {
          await authorize("beforeForward");
          try {
            await operation.onChunk(
              bytes.slice(offset, offset + PI_WORKER_MAX_CHUNK_BYTES),
              controller.signal,
            );
          } catch {
            fail("FORWARD_FAILED");
          }
          check();
        }
      };
      const flush = async (final: boolean) => {
        while (pending.length > 0) {
          const first = pending[0]!;
          if (!final && pendingSemanticBytes - first.semanticBytes < secret.length - 1) break;
          pending.shift();
          pendingSemanticBytes -= first.semanticBytes;
          await forward(first.bytes);
        }
      };
      const scanSecret = (tail: Buffer, bytes: Uint8Array) => {
        const combined = Buffer.concat([tail, bytes]);
        if (combined.includes(secret)) fail("CREDENTIAL_ECHO_REJECTED");
        return Buffer.from(combined.subarray(Math.max(0, combined.length - secret.length + 1)));
      };
      const line = Buffer.alloc(65_536);
      let length = 0;
      const consume = async (bytes: Uint8Array) => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, "");
        if (text === "") return;
        if (!text.startsWith("data: ") || done || ++frameCount > 16_384) fail("SSE_FRAME_INVALID");
        if (text === "data: [DONE]") {
          if (!usage || !contentSeen || !finishSeen) fail("SSE_ACCOUNTING_REQUIRED");
          done = true;
          enqueue(Buffer.from("data: [DONE]\n\n"), 0);
          return;
        }
        if (usage) fail("SSE_AFTER_ACCOUNTING");
        let native: typeof Native.Type;
        try {
          native = decodeNative(text.slice(6));
        } catch {
          fail("SSE_FRAME_INVALID");
        }
        if (!cfg.acceptedReportedModels.includes(native.model)) fail("SSE_MODEL_REJECTED");
        const values: string[] = [];
        for (const choice of native.choices) {
          if (choice.delta.content) values.push(choice.delta.content);
          for (const call of choice.delta.tool_calls ?? []) {
            if (call.index >= 32) fail("SSE_TOOL_INVALID");
            if (call.function.name !== undefined || call.id !== undefined) {
              if (
                outputCalls.has(call.index) ||
                !call.function.name ||
                !call.id ||
                !advertised.has(call.function.name)
              )
                fail("SSE_TOOL_INVALID");
              outputCalls.set(call.index, { name: call.function.name, id: call.id });
            }
            if (!outputCalls.has(call.index)) fail("SSE_TOOL_INVALID");
            if (call.function.arguments) values.push(call.function.arguments);
          }
        }
        const semantic = Buffer.from(values.join(""));
        semanticTail = scanSecret(semanticTail, semantic);
        // Decode JSON escapes before checking arbitrary strings too, without retaining diagnostics.
        const nativeText = encodeNative(native);
        if (
          nativeText.includes(credential) ||
          nativeText.includes(encodeJson(credential).slice(1, -1))
        )
          fail("CREDENTIAL_ECHO_REJECTED");
        const hasContent = semantic.length > 0 || outputCalls.size > 0;
        const nativeUsage = native.usage;
        const preliminary =
          nativeUsage != null &&
          native.choices.length === 1 &&
          nativeUsage.prompt_tokens === 0 &&
          nativeUsage.completion_tokens === 0 &&
          nativeUsage.total_tokens === 0;
        if (preliminary) {
          const choice = native.choices[0]!;
          if (
            hasContent ||
            Object.keys(choice.delta).some((key) => key !== "role" && key !== "content") ||
            choice.delta.content ||
            choice.finish_reason !== "stop"
          )
            fail("SSE_PRELIMINARY_INVALID");
          // Free route may emit an empty zero-usage stop before content. It is not native completion.
          return;
        }
        if (nativeUsage != null) {
          if (
            native.choices.length !== 0 ||
            !contentSeen ||
            !finishSeen ||
            nativeUsage.total_tokens !== nativeUsage.prompt_tokens + nativeUsage.completion_tokens
          )
            fail("SSE_USAGE_INVALID");
          const promptDetails = nativeUsage.prompt_tokens_details;
          const completionDetails = nativeUsage.completion_tokens_details;
          if (
            [
              promptDetails?.cached_tokens,
              promptDetails?.cache_write_tokens,
              nativeUsage.prompt_cache_hit_tokens,
              nativeUsage.prompt_cache_miss_tokens,
              nativeUsage.cached_tokens,
            ].some((n) => n !== undefined && n > nativeUsage.prompt_tokens) ||
            Object.values(completionDetails ?? {}).some(
              (n) => n !== undefined && n > nativeUsage.completion_tokens,
            )
          )
            fail("SSE_USAGE_INVALID");
          usage = nativeUsage;
          reportedModel = native.model;
          if (
            usage.prompt_tokens > cfg.maxInputTokens ||
            usage.completion_tokens > parsed.max_tokens
          )
            fail("SSE_USAGE_OVER_RESERVATION");
        } else {
          if (native.choices.length !== 1 || finishSeen) fail("SSE_CHOICE_INVALID");
          contentSeen ||= hasContent;
          const finish = native.choices[0]!.finish_reason;
          if (finish === "length") fail("SSE_OUTPUT_LIMIT");
          if (finish !== null) {
            if (!contentSeen) fail("SSE_CONTENT_REQUIRED");
            finishSeen = true;
          }
        }
        enqueue(bytes, semantic.length);
        enqueue(Buffer.from("\n"), 0);
        await flush(false);
      };
      while (true) {
        check();
        const read = await reader.read();
        check();
        if (read.done) break;
        if (responseBytes + read.value.length > PI_WORKER_MAX_RESPONSE_BYTES)
          fail("RESPONSE_BYTE_LIMIT");
        responseBytes += read.value.length;
        // Scan bounded slices before retention, including echoes across transport read boundaries.
        for (let start = 0; start < read.value.length; start += PI_WORKER_MAX_CHUNK_BYTES) {
          rawTail = scanSecret(
            rawTail,
            read.value.subarray(start, start + PI_WORKER_MAX_CHUNK_BYTES),
          );
        }
        for (let offset = 0; offset < read.value.length;) {
          const newline = read.value.indexOf(10, offset);
          const end = newline < 0 ? read.value.length : newline + 1;
          const size = end - offset;
          if (length + size > line.length) fail("SSE_FRAME_BYTE_LIMIT");
          line.set(read.value.subarray(offset, end), length);
          length += size;
          if (newline >= 0) {
            await consume(line.subarray(0, length));
            length = 0;
          }
          offset = end;
        }
      }
      if (length !== 0 || !done || !usage || !reportedModel) fail("SSE_ACCOUNTING_REQUIRED");
      await flush(true);
    } catch (error) {
      controller.abort();
      failure =
        error instanceof PiModelBrokerError ? error : new PiModelBrokerError("REQUEST_FAILED");
    } finally {
      // Completion or rejection never outlives its owned reader/fetch. No abandoned Promise.race transport.
      if (reader) {
        if (failure) cancelReader();
        if (cancelPending) await cancelPending;
        if (cancelFailed) failure ??= new PiModelBrokerError("TRANSPORT_DRAIN_FAILED");
        controller.signal.removeEventListener("abort", cancelReader);
        reader.releaseLock();
      }
      if (reservationId) {
        try {
          const settlement: PiModelRequestSettlement = {
            ...reservation,
            reservationId,
            outcome: usage ? (failure ? "failed" : "reported") : "unknown",
            chargedInputTokens: failure
              ? Math.max(usage?.prompt_tokens ?? 0, reservation.maxInputTokens)
              : (usage?.prompt_tokens ?? reservation.maxInputTokens),
            chargedOutputTokens: failure
              ? Math.max(usage?.completion_tokens ?? 0, reservation.maxOutputTokens)
              : (usage?.completion_tokens ?? reservation.maxOutputTokens),
            ...(failure ? { failureCode: failure.code } : {}),
            ...(usage && reportedModel ? { reportedUsage: usage, reportedModel } : {}),
          };
          receiptId = (await cfg.settleRequest(settlement)).accountingReceiptId;
          if (!receiptId || receiptId.length > 256) fail("ACCOUNTING_RECEIPT_INVALID");
        } catch {
          failure = new PiModelBrokerError("SETTLEMENT_FAILED");
        }
      }
    }
    const release = () => {
      deadline.removeEventListener("abort", abort);
      operation.signal.removeEventListener("abort", abort);
      active = false;
    };
    if (failure) {
      release();
      throw failure;
    }
    if (!usage || !reportedModel || !reservationId || !receiptId)
      fail("ACCOUNTING_RECEIPT_REQUIRED");
    try {
      await authorize("beforeReturn");
    } catch (error) {
      controller.abort();
      const denied =
        error instanceof PiModelBrokerError
          ? error
          : new PiModelBrokerError("AUTHORIZATION_REJECTED");
      try {
        const upgraded = await cfg.settleRequest({
          ...reservation,
          reservationId,
          outcome: "failed",
          failureCode: denied.code,
          chargedInputTokens: Math.max(usage.prompt_tokens, reservation.maxInputTokens),
          chargedOutputTokens: Math.max(usage.completion_tokens, reservation.maxOutputTokens),
          reportedUsage: usage,
          reportedModel,
        });
        if (!upgraded.accountingReceiptId || upgraded.accountingReceiptId.length > 256)
          fail("ACCOUNTING_RECEIPT_INVALID");
      } catch {
        release();
        return fail("SETTLEMENT_FAILED");
      }
      release();
      throw denied;
    }
    release();
    return {
      requestId: operation.requestId,
      reservationId,
      accountingReceiptId: receiptId,
      routeId: cfg.routeId,
      provider: cfg.provider,
      model: cfg.model,
      reportedModel,
      usage,
    };
  };
  return { request };
}
