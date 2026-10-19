import { getPiUserAgent } from "@earendil-works/pi-ai/utils/pi-user-agent";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  PiManagedModel,
  PiSubscriptionManagedModel,
  piManagedModelRoute,
  piSubscriptionModelRoute,
} from "./PiManagedModels.ts";
import {
  PI_SUBSCRIPTION_MAX_INSTRUCTIONS_BYTES,
  decodePiSubscriptionEvent,
  decodePiSubscriptionRequest,
  isPiSubscriptionCallId,
} from "./PiSubscriptionProtocol.ts";

import {
  PI_WORKER_MAX_CHUNK_BYTES,
  PI_WORKER_MAX_REQUEST_BYTES,
  PI_WORKER_MAX_RESPONSE_BYTES,
  PI_WORKER_MAX_TEXT_PART_BYTES,
  PiWorkerOperation,
} from "./PiWorkerProtocol.ts";

// Monitored subscription input bytes are independent of nominal token reservations.
const PI_SUBSCRIPTION_MAX_NORMALIZED_INPUT_BYTES = 65_536;

const strict = { onExcessProperty: "error" } as const;
const decodeManagedModel = Schema.decodeUnknownSync(PiManagedModel);
const decodeSubscriptionModel = Schema.decodeUnknownSync(PiSubscriptionManagedModel);
const Integer = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const Positive = Integer.check(Schema.isGreaterThan(0));
const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Text = Schema.String.check(
  Schema.makeFilter((s) => Buffer.byteLength(s) <= PI_WORKER_MAX_TEXT_PART_BYTES),
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
    Schema.NullOr(
      Schema.Struct({
        audio_tokens: Schema.optional(Integer),
        cached_tokens: Schema.optional(Integer),
        cache_write_tokens: Schema.optional(Integer),
        cache_creation_input_tokens: Schema.optional(Integer),
        cache_read_input_tokens: Schema.optional(Integer),
        text_tokens: Schema.optional(Integer),
        image_tokens: Schema.optional(Integer),
        video_tokens: Schema.optional(Integer),
      }),
    ),
  ),
  completion_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: Schema.optional(Integer),
        accepted_prediction_tokens: Schema.optional(Integer),
        rejected_prediction_tokens: Schema.optional(Integer),
        audio_tokens: Schema.optional(Integer),
      }),
    ),
  ),
  prompt_cache_hit_tokens: Schema.optional(Integer),
  prompt_cache_miss_tokens: Schema.optional(Integer),
  cached_tokens: Schema.optional(Integer),
});
const Delta = Schema.Struct({
  role: Schema.optional(Schema.Literal("assistant")),
  content: Schema.optional(Schema.NullOr(Text)),
  reasoning_content: Schema.optional(Schema.NullOr(Text)),
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
  sla_metrics: Schema.optional(Schema.Struct({ ttft_ms: Integer, ts_us: Integer })),
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
// Subscription call identities are opaque; CommandCode retains its identifier grammar.
const SubscriptionCallId = Schema.String.check(Schema.makeFilter(isPiSubscriptionCallId));
const SubscriptionMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), content: Content }),
  Schema.Struct({
    role: Schema.Literal("system"),
    content: Schema.Union([
      Schema.String.check(
        Schema.makeFilter(
          (value) => Buffer.byteLength(value) <= PI_SUBSCRIPTION_MAX_INSTRUCTIONS_BYTES,
        ),
      ),
      Content.members[1],
    ]),
  }),
  Schema.Struct({
    ...Message.members[1].fields,
    tool_calls: Schema.optional(
      Schema.Array(Schema.Struct({ ...FunctionCall.fields, id: SubscriptionCallId })).check(
        Schema.isMaxLength(32),
      ),
    ),
  }),
  Schema.Struct({ ...Message.members[2].fields, tool_call_id: SubscriptionCallId }),
]);
const decodeSubscriptionRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...Request.fields,
      messages: Schema.Array(SubscriptionMessage).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(128),
      ),
    }),
  ),
  strict,
);
const SubscriptionDelta = Schema.Struct({
  ...Delta.fields,
  tool_calls: Schema.optional(
    Schema.Array(
      Schema.Struct({
        index: Integer,
        id: Schema.optional(SubscriptionCallId),
        type: Schema.optional(Schema.Literal("function")),
        function: Schema.Struct({ name: Schema.optional(Name), arguments: Schema.optional(Text) }),
      }),
    ).check(Schema.isMaxLength(32)),
  ),
});
const decodeSubscriptionNative = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...Native.fields,
      choices: Schema.Array(
        Schema.Struct({
          index: Schema.Literal(0),
          delta: SubscriptionDelta,
          finish_reason: Schema.NullOr(Schema.Literals(["stop", "tool_calls", "length"])),
        }),
      ).check(Schema.isMaxLength(1)),
    }),
  ),
  strict,
);
const decodeRequest = Schema.decodeSync(Schema.fromJsonString(Request), strict);
const decodeNative = Schema.decodeSync(Schema.fromJsonString(Native), strict);
const encodeNative = Schema.encodeSync(Schema.fromJsonString(Native));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Request));
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json), strict);
const decodeArguments = Schema.decodeSync(Schema.fromJsonString(Schema.JsonObject), strict);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeTools = Schema.decodeUnknownSync(Schema.Array(FunctionTool), strict);
const decodeName = Schema.decodeSync(Name);
const decodeOperationId = Schema.decodeSync(PiWorkerOperation.fields.operationId);
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
  | "REQUEST_SYSTEM_INPUT_INVALID"
  | "REQUEST_INPUT_BINDING_FAILED"
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
  | "SSE_UPSTREAM_ERROR"
  | "SSE_USAGE_INVALID"
  | "SSE_USAGE_OVER_RESERVATION"
  | "TRANSPORT_DRAIN_FAILED"
  | "TRANSPORT_FAILED"
  | `TRANSPORT_RESPONSE_HTTP_${number}`
  | "TRANSPORT_RESPONSE_REDIRECTED"
  | "TRANSPORT_RESPONSE_BODY_MISSING"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_REJECTED"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_JSON"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_HTML"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_TEXT"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_JSON_PREFIX"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_HTML_PREFIX"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_SSE_MARKER_PREFIX"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_OTHER_PREFIX"
  | "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_EMPTY"
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
  readonly provider: "command-code" | "openai-codex";
  readonly model: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly callCount: 1;
  readonly deadlineAtMs: number;
  readonly accountingMode?: "openai-subscription-monitored";
  readonly unknownMaximumTokens?: 64_000;
}
export interface PiModelRequestSettlement extends PiModelRequestReservation {
  readonly reservationId: string;
  /** Parent-owned transport cleanup evidence; absence cannot release managed capacity. */
  readonly transportDrained?: boolean;
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
  readonly provider: "command-code" | "openai-codex";
  readonly model: string;
  readonly reportedModel: string;
  readonly usage: PiModelUsage;
}
export interface PiModelBrokerConfig {
  readonly workerId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly routeId: string;
  readonly provider: "command-code" | "openai-codex";
  readonly model: string;
  readonly endpoint: string;
  readonly acceptedReportedModels: readonly string[];
  readonly tools: readonly PiModelTool[];
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly deadlineMs: number;
  /** Private assignment custody; the broker binds only the exact outbound system input. */
  readonly requiredSystemText?: string;
  readonly bindRequestInput?: (
    input: { readonly reservationId: string; readonly encodedRequestSha256: string },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly getCredential: (signal: AbortSignal) => Promise<string>;
  /** Root-owned approved subscription test; absent on ordinary hard-budget routes. */
  readonly authorizeSubscriptionTest?: (signal: AbortSignal) => Promise<void>;
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
  let route: ReturnType<typeof piManagedModelRoute> | ReturnType<typeof piSubscriptionModelRoute>;
  const subscription = cfg.provider === "openai-codex";
  try {
    route = subscription
      ? piSubscriptionModelRoute(decodeSubscriptionModel(cfg.model))
      : piManagedModelRoute(decodeManagedModel(cfg.model));
  } catch {
    return fail("CONFIG_ROUTE_INVALID");
  }
  const routeAcceptedReportedModels: readonly string[] = route.acceptedReportedModels;
  if (
    cfg.provider !== route.provider ||
    cfg.routeId !== route.routeId ||
    cfg.endpoint !== route.endpoint ||
    cfg.acceptedReportedModels.length < 1 ||
    cfg.acceptedReportedModels.length > 2 ||
    cfg.acceptedReportedModels.some((m) => !routeAcceptedReportedModels.includes(m)) ||
    new Set(cfg.acceptedReportedModels).size !== cfg.acceptedReportedModels.length
  )
    fail("CONFIG_ROUTE_INVALID");
  if (subscription && typeof cfg.authorizeSubscriptionTest !== "function")
    fail("CONFIG_CALLBACK_REQUIRED");
  try {
    decodeName(cfg.workerId);
    decodeOperationId(cfg.operationId);
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
    subscription &&
    ((cfg.maxInputTokens !== 16_384 && cfg.maxInputTokens !== 32_768) ||
      cfg.maxOutputTokens !== 2_048)
  )
    fail("CONFIG_LIMITS_INVALID");
  if (
    [
      cfg.authorizeCurrent,
      cfg.getCredential,
      cfg.reserveRequest,
      cfg.settleRequest,
      cfg.transport,
      ...(subscription ? [cfg.authorizeSubscriptionTest] : []),
    ].some((f) => typeof f !== "function")
  )
    fail("CONFIG_CALLBACK_REQUIRED");
  if (
    (cfg.requiredSystemText === undefined) !== (cfg.bindRequestInput === undefined) ||
    (cfg.requiredSystemText !== undefined &&
      (typeof cfg.requiredSystemText !== "string" ||
        Buffer.byteLength(cfg.requiredSystemText) > 65_536 ||
        typeof cfg.bindRequestInput !== "function"))
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
    let outboundBody: string;
    let inputBudgetBody = operation.body;
    let subscriptionSessionId: string | undefined;
    try {
      if (Buffer.byteLength(operation.body) > PI_WORKER_MAX_REQUEST_BYTES)
        fail("REQUEST_BYTE_LIMIT");
      if (subscription) {
        const adapted = decodePiSubscriptionRequest(operation.body, cfg.model);
        parsed = decodeSubscriptionRequest(adapted.normalizedBody);
        // Opaque reasoning stays in the transport envelope, outside the normalized text input.
        inputBudgetBody = adapted.normalizedBody;
        outboundBody = adapted.canonicalBody;
        subscriptionSessionId = adapted.sessionId;
      } else {
        parsed = decodeRequest(operation.body);
        outboundBody = encodeRequest({ ...parsed, model: cfg.model });
      }
      decodePositive(operation.requestId);
    } catch (error) {
      if (error instanceof PiModelBrokerError) throw error;
      if (subscription && error instanceof Error) {
        if (error.message === "REQUEST_MODEL_OR_OUTPUT_INVALID")
          return fail("REQUEST_MODEL_OR_OUTPUT_INVALID");
        if (error.message === "REQUEST_TOOL_ARGUMENTS_INVALID")
          return fail("REQUEST_TOOL_ARGUMENTS_INVALID");
      }
      return fail("REQUEST_INVALID");
    }
    if (cfg.requiredSystemText !== undefined) {
      const systems = parsed.messages.filter((message) => message.role === "system");
      const content = systems[0]?.content;
      const systemText =
        typeof content === "string"
          ? content
          : Array.isArray(content) && content.length === 1
            ? content[0]?.text
            : undefined;
      if (systems.length !== 1 || systemText !== cfg.requiredSystemText)
        fail("REQUEST_SYSTEM_INPUT_INVALID");
    }
    const encodedBody = outboundBody!;
    if (usedRequestIds.has(operation.requestId)) fail("REQUEST_REPLAY");
    if (active) fail("REQUEST_CONCURRENT");
    if (usedRequestIds.size >= 1_024) fail("REQUEST_COUNT_LIMIT");
    if (parsed.model !== cfg.model || (!subscription && parsed.max_tokens > cfg.maxOutputTokens))
      fail("REQUEST_MODEL_OR_OUTPUT_INVALID");
    // CommandCode conservatively bounds tokens with UTF-8 bytes; monitored subscription
    // requests have a separate normalized-input byte ceiling.
    const maxInputBytes = subscription
      ? PI_SUBSCRIPTION_MAX_NORMALIZED_INPUT_BYTES
      : cfg.maxInputTokens;
    if (Buffer.byteLength(inputBudgetBody) > maxInputBytes) fail("REQUEST_INPUT_LIMIT");
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
        if (subscription) await cfg.authorizeSubscriptionTest!(controller.signal);
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
      ...(subscription
        ? {
            accountingMode: "openai-subscription-monitored" as const,
            unknownMaximumTokens: 64_000 as const,
          }
        : {}),
    };
    let reservationId: string | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let initialRead:
      | Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>
      | undefined;
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
      if (cfg.bindRequestInput !== undefined) {
        try {
          await cfg.bindRequestInput(
            {
              reservationId,
              encodedRequestSha256: NodeCrypto.createHash("sha256")
                .update(encodedBody)
                .digest("hex"),
            },
            controller.signal,
          );
        } catch {
          fail("REQUEST_INPUT_BINDING_FAILED");
        }
        check();
      }
      if (subscription) await authorize("beforeTransport");
      let credential: string;
      try {
        credential = await cfg.getCredential(controller.signal);
      } catch {
        fail("CREDENTIAL_UNAVAILABLE");
      }
      if (!credential || Buffer.byteLength(credential) > 8_192 || /[\r\n]/.test(credential))
        fail("CREDENTIAL_INVALID");
      let subscriptionAccountId: string | undefined;
      if (subscription) {
        try {
          const parts = credential.split(".");
          const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
          if (!payload || typeof payload !== "object") fail("CREDENTIAL_INVALID");
          const claims = payload as Record<string, unknown>;
          const auth = claims["https://api.openai.com/auth"];
          if (!auth || typeof auth !== "object") fail("CREDENTIAL_INVALID");
          const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
          if (
            typeof claims.exp !== "number" ||
            !Number.isSafeInteger(claims.exp) ||
            claims.exp * 1000 <= reservation.deadlineAtMs ||
            typeof accountId !== "string" ||
            accountId.length < 1 ||
            accountId.length > 4096 ||
            /[\p{Cc}\p{Cf}]/u.test(accountId)
          )
            fail("CREDENTIAL_INVALID");
          subscriptionAccountId = accountId;
        } catch (error) {
          if (error instanceof PiModelBrokerError) throw error;
          fail("CREDENTIAL_INVALID");
        }
      }
      // Keep the existing CommandCode check ordering unchanged; subscription authority is
      // rechecked after credential retrieval to close the asynchronous custody window.
      await authorize("beforeTransport");
      let response: Response;
      try {
        response = await cfg.transport(cfg.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${credential}`,
            ...(subscription
              ? {
                  "chatgpt-account-id": subscriptionAccountId!,
                  originator: "pi",
                  "User-Agent": getPiUserAgent(),
                  // The validated body owns SDK session metadata; arbitrary worker headers stay out.
                  ...(subscriptionSessionId
                    ? {
                        "session-id": subscriptionSessionId,
                        "x-client-request-id": subscriptionSessionId,
                      }
                    : {}),
                  "OpenAI-Beta": "responses=experimental",
                  accept: "text/event-stream",
                }
              : {}),
          },
          body: encodedBody,
          signal: controller.signal,
        });
      } catch {
        fail(controller.signal.aborted ? "REQUEST_ABORTED" : "TRANSPORT_FAILED");
      }
      // Own a returned body before checking abort or response policy so both paths join its drain.
      if (response.body) {
        try {
          reader = response.body.getReader();
        } catch {
          cancelFailed = true;
          fail("TRANSPORT_DRAIN_FAILED");
        }
      }
      check();
      if (response.redirected) fail("TRANSPORT_RESPONSE_REDIRECTED");
      // Retain bounded response facts only; bodies and arbitrary headers never enter receipts.
      if (response.status !== 200) {
        if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
          fail(`TRANSPORT_RESPONSE_HTTP_${response.status}`);
        fail("TRANSPORT_RESPONSE_REJECTED");
      }
      if (!reader) fail("TRANSPORT_RESPONSE_BODY_MISSING");
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== "text/event-stream" && (!subscription || !contentType)) {
        // Retain fixed categories so failed requests can be diagnosed without provider headers/bodies.
        if (!contentType) {
          if (!subscription) fail("TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING");
          let diagnostic: PiModelBrokerErrorCode = "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING";
          controller.signal.addEventListener("abort", cancelReader, { once: true });
          if (controller.signal.aborted) cancelReader();
          try {
            check();
            const first = await reader.read();
            check();
            initialRead = first;
            const bytes = first.value;
            if (first.done && (!bytes || bytes.byteLength === 0)) {
              diagnostic = "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_EMPTY";
            } else if (
              bytes &&
              bytes.byteLength > 0 &&
              bytes.byteLength <= PI_WORKER_MAX_CHUNK_BYTES
            ) {
              try {
                const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                  bytes,
                );
                const prefix = raw.replace(/^\uFEFF/, "");
                const trimmed = prefix.trimStart();
                if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
                  diagnostic = "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_JSON_PREFIX";
                } else if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(trimmed)) {
                  diagnostic = "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_HTML_PREFIX";
                } else if (
                  trimmed.length > 0 &&
                  !trimmed.startsWith("<") &&
                  !/^(?:data:|event:|id:|retry:|:)/.test(trimmed) &&
                  !["data:", "event:", "id:", "retry:"].some((marker) => marker.startsWith(trimmed))
                ) {
                  diagnostic = "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_OTHER_PREFIX";
                }
              } catch {
                // Invalid UTF-8 is not enough evidence to retain a more specific category.
              }
            }
          } catch {
            // The deadline/caller abort remains authoritative; other read errors stay indeterminate.
            initialRead = undefined;
            check();
            fail("TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING");
          }
          if (diagnostic !== "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING") fail(diagnostic);
        }
        if (contentType) {
          if (contentType === "application/json") fail("TRANSPORT_RESPONSE_CONTENT_TYPE_JSON");
          if (contentType === "text/html") fail("TRANSPORT_RESPONSE_CONTENT_TYPE_HTML");
          if (contentType === "text/plain") fail("TRANSPORT_RESPONSE_CONTENT_TYPE_TEXT");
          fail("TRANSPORT_RESPONSE_CONTENT_TYPE_REJECTED");
        }
      }
      controller.signal.addEventListener("abort", cancelReader, { once: true });
      if (controller.signal.aborted) cancelReader();
      const secret = Buffer.from(credential);
      const accountSecret = Buffer.from(subscriptionAccountId ?? "");
      let rawTail = Buffer.alloc(0);
      let rawAccountTail = Buffer.alloc(0);
      let semanticTail = Buffer.alloc(0);
      let semanticAccountTail = Buffer.alloc(0);
      let responseBytes = 0;
      let contentSeen = false;
      let finishSeen = false;
      let done = false;
      const outputCalls = new Map<number, { name: string; id: string }>();
      const subscriptionCalls = new Map<
        number,
        {
          name: string;
          callId: string;
          itemId: string | undefined;
          arguments: string;
          hasArgumentDelta: boolean;
          argumentsDone: boolean;
          finalized: boolean;
        }
      >();
      const pending: Array<{ bytes: Buffer; semanticBytes: number }> = [];
      let pendingSemanticBytes = 0;
      let outputBytes = 0;
      let frameCount = 0;
      let subscriptionEvent = "";
      let subscriptionData: string[] = [];
      let subscriptionFrameBytes = 0;
      let upstreamFailed = false;
      let subscriptionResponseId: string | undefined;
      let subscriptionStarted = false;
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
      const scanSecret = (tail: Buffer, bytes: Uint8Array, needle = secret) => {
        const combined = Buffer.concat([tail, bytes]);
        if (needle.length > 0 && combined.includes(needle)) fail("CREDENTIAL_ECHO_REJECTED");
        return Buffer.from(combined.subarray(Math.max(0, combined.length - needle.length + 1)));
      };
      const line = Buffer.alloc(subscription ? PI_WORKER_MAX_RESPONSE_BYTES : 65_536);
      let length = 0;
      const consumeData = async (data: string, bytes: Uint8Array) => {
        if (data === "[DONE]") {
          if (subscription) return;
          if (!usage || !contentSeen || !finishSeen) fail("SSE_ACCOUNTING_REQUIRED");
          done = true;
          enqueue(Buffer.from("data: [DONE]\n\n"), 0);
          return;
        }
        if (!subscription && usage) fail("SSE_AFTER_ACCOUNTING");
        let normalizedFrame = "";
        let terminalFailure = false;
        let native: typeof Native.Type;
        try {
          if (subscription) {
            let responsePayload: unknown;
            try {
              responsePayload = JSON.parse(data);
            } catch (error) {
              // Completion seals semantics; parse trailers only when possible to scan decoded secrets.
              if (done) return;
              throw error;
            }
            const scanValue = (value: unknown): void => {
              if (typeof value === "string") {
                if (
                  value.includes(credential) ||
                  value.includes(encodeJson(credential).slice(1, -1)) ||
                  (subscriptionAccountId && value.includes(subscriptionAccountId))
                )
                  fail("CREDENTIAL_ECHO_REJECTED");
              } else if (Array.isArray(value)) value.forEach(scanValue);
              else if (value && typeof value === "object")
                for (const [key, entry] of Object.entries(value)) {
                  scanValue(key);
                  scanValue(entry);
                }
            };
            scanValue(responsePayload);
            if (done) return;
            if (
              responsePayload === null ||
              typeof responsePayload !== "object" ||
              !("type" in responsePayload) ||
              typeof responsePayload.type !== "string"
            )
              fail("SSE_FRAME_INVALID");
            subscriptionEvent = responsePayload.type;
            const scanToolNames = (value: unknown): void => {
              if (Array.isArray(value)) value.forEach(scanToolNames);
              else if (value && typeof value === "object") {
                if (
                  "type" in value &&
                  value.type === "function_call" &&
                  (!("name" in value) ||
                    typeof value.name !== "string" ||
                    !advertised.has(value.name))
                )
                  fail("SSE_TOOL_INVALID");
                Object.values(value).forEach(scanToolNames);
              }
            };
            scanToolNames(responsePayload);
            normalizedFrame = `event: ${subscriptionEvent}\ndata: ${JSON.stringify(responsePayload)}\n\n`;
            const adapted = decodePiSubscriptionEvent(
              subscriptionEvent,
              responsePayload,
              cfg.model,
            );
            if (!adapted) return;
            terminalFailure = adapted.failed === true;
            for (const name of adapted.toolNames ?? [])
              if (!advertised.has(name)) fail("SSE_TOOL_INVALID");
            const item = adapted.toolItem;
            if (item) {
              if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= 32)
                fail("SSE_TOOL_INVALID");
              const prior = subscriptionCalls.get(item.index);
              if (item.phase === "added") {
                if (
                  prior ||
                  item.arguments !== "" ||
                  [...subscriptionCalls.values()].some(
                    (call) =>
                      call.callId === item.callId ||
                      (item.itemId !== undefined && call.itemId === item.itemId),
                  )
                )
                  fail("SSE_TOOL_INVALID");
                subscriptionCalls.set(item.index, {
                  name: item.name,
                  callId: item.callId,
                  itemId: item.itemId,
                  arguments: "",
                  hasArgumentDelta: false,
                  argumentsDone: false,
                  finalized: false,
                });
              } else {
                if (
                  !prior ||
                  prior.finalized ||
                  prior.name !== item.name ||
                  prior.callId !== item.callId ||
                  prior.itemId !== item.itemId ||
                  prior.arguments !== item.arguments
                )
                  fail("SSE_TOOL_INVALID");
                try {
                  decodeArguments(item.arguments);
                } catch {
                  fail("SSE_TOOL_INVALID");
                }
                prior.finalized = true;
              }
            }
            const argument = adapted.argumentItem;
            if (argument) {
              const prior = subscriptionCalls.get(argument.index);
              if (
                !prior ||
                prior.finalized ||
                prior.argumentsDone ||
                (argument.itemId !== undefined && prior.itemId !== argument.itemId)
              )
                fail("SSE_TOOL_INVALID");
              if (argument.complete) {
                try {
                  decodeArguments(argument.arguments);
                } catch {
                  fail("SSE_TOOL_INVALID");
                }
                if (prior.arguments !== argument.arguments) {
                  if (prior.hasArgumentDelta || prior.arguments !== "") fail("SSE_TOOL_INVALID");
                  prior.arguments = argument.arguments;
                }
                prior.argumentsDone = true;
              } else {
                prior.hasArgumentDelta = true;
                if (
                  Buffer.byteLength(prior.arguments) + Buffer.byteLength(argument.arguments) >
                  PI_WORKER_MAX_TEXT_PART_BYTES
                )
                  fail("SSE_TOOL_INVALID");
                prior.arguments += argument.arguments;
              }
            }
            if (adapted.terminal) {
              for (const call of adapted.toolCalls ?? []) {
                if (
                  !isPiSubscriptionCallId(call.callId) ||
                  Buffer.byteLength(call.arguments) > PI_WORKER_MAX_TEXT_PART_BYTES
                )
                  fail("SSE_TOOL_INVALID");
                try {
                  decodeArguments(call.arguments);
                } catch {
                  fail("SSE_TOOL_INVALID");
                }
              }
              if ([...subscriptionCalls.values()].some((call) => !call.finalized))
                fail("SSE_TOOL_INVALID");
            }
            if (
              subscriptionEvent === "response.created" ||
              subscriptionEvent === "response.in_progress"
            )
              subscriptionStarted = true;
            if (adapted.responseId) {
              if (subscriptionResponseId && subscriptionResponseId !== adapted.responseId)
                fail("SSE_MODEL_REJECTED");
              subscriptionResponseId = adapted.responseId;
            }
            if (terminalFailure && !adapted.usage) {
              upstreamFailed = true;
              done = true;
              return;
            }
            native = decodeSubscriptionNative(
              JSON.stringify({
                ...adapted.chunk,
                ...(adapted.usage === undefined ? {} : { usage: adapted.usage }),
              }),
            );
            if (adapted.terminal) {
              if ((!subscriptionStarted && !terminalFailure) || !subscriptionResponseId)
                fail("SSE_ACCOUNTING_REQUIRED");
              contentSeen = true;
              finishSeen = true;
            }
          } else native = decodeNative(data);
        } catch (error) {
          if (error instanceof PiModelBrokerError) throw error;
          if (
            error instanceof Error &&
            [
              "SSE_FRAME_INVALID",
              "SSE_MODEL_REJECTED",
              "SSE_ACCOUNTING_REQUIRED",
              "SSE_USAGE_INVALID",
              "SSE_TOOL_INVALID",
              "CREDENTIAL_ECHO_REJECTED",
            ].includes(error.message)
          )
            fail(error.message as PiModelBrokerErrorCode);
          fail("SSE_FRAME_INVALID");
        }
        if (!cfg.acceptedReportedModels.includes(native.model)) fail("SSE_MODEL_REJECTED");
        const values: string[] = [];
        for (const choice of native.choices) {
          if (choice.delta.content) values.push(choice.delta.content);
          if (choice.delta.reasoning_content) values.push(choice.delta.reasoning_content);
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
            if (call.function.arguments) {
              values.push(call.function.arguments);
            }
          }
        }
        const semantic = Buffer.from(values.join(""));
        semanticTail = scanSecret(semanticTail, semantic);
        if (accountSecret.length > 0)
          semanticAccountTail = scanSecret(semanticAccountTail, semantic, accountSecret);
        // Decode JSON escapes before checking arbitrary strings too, without retaining diagnostics.
        const nativeText = subscription ? JSON.stringify(native) : encodeNative(native);
        if (
          nativeText.includes(credential) ||
          nativeText.includes(encodeJson(credential).slice(1, -1))
        )
          fail("CREDENTIAL_ECHO_REJECTED");
        const hasContent = semantic.length > 0 || outputCalls.size > 0;
        const nativeUsage = native.usage;
        if (nativeUsage != null) {
          if (
            [
              ...Object.values(nativeUsage.prompt_tokens_details ?? {}),
              nativeUsage.prompt_cache_hit_tokens,
              nativeUsage.prompt_cache_miss_tokens,
              nativeUsage.cached_tokens,
            ].some((n) => n !== undefined && n > nativeUsage.prompt_tokens) ||
            Object.values(nativeUsage.completion_tokens_details ?? {}).some(
              (n) => n !== undefined && n > nativeUsage.completion_tokens,
            )
          )
            fail("SSE_USAGE_INVALID");
        }
        const preliminary =
          nativeUsage != null &&
          native.choices.length === 1 &&
          nativeUsage.prompt_tokens === 0 &&
          nativeUsage.completion_tokens === 0 &&
          nativeUsage.total_tokens === 0;
        if (preliminary) {
          const choice = native.choices[0]!;
          if (
            semantic.length > 0 ||
            Object.keys(choice.delta).some(
              (key) => key !== "role" && key !== "content" && key !== "reasoning_content",
            ) ||
            (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls")
          )
            fail("SSE_PRELIMINARY_INVALID");
          // Before content this is a free-route placeholder; after content it is the sole native finish.
          // Neither proves accounting: the choices-empty actual usage frame must still arrive.
          if (!contentSeen) {
            if (choice.finish_reason !== "stop") fail("SSE_PRELIMINARY_INVALID");
            return;
          }
          finishSeen = true;
        }
        if (nativeUsage != null && !preliminary) {
          if (
            native.choices.length !== 0 ||
            !contentSeen ||
            !finishSeen ||
            nativeUsage.total_tokens !== nativeUsage.prompt_tokens + nativeUsage.completion_tokens
          )
            fail("SSE_USAGE_INVALID");
          usage = nativeUsage;
          reportedModel = native.model;
          if (
            !subscription &&
            (usage.prompt_tokens > cfg.maxInputTokens ||
              usage.completion_tokens > parsed.max_tokens)
          )
            fail("SSE_USAGE_OVER_RESERVATION");
        } else if (!preliminary) {
          if (native.choices.length !== 1 || finishSeen) fail("SSE_CHOICE_INVALID");
          contentSeen ||= hasContent;
          const finish = native.choices[0]!.finish_reason;
          if (finish === "length") fail("SSE_OUTPUT_LIMIT");
          if (finish !== null) {
            if (!contentSeen) fail("SSE_CONTENT_REQUIRED");
            finishSeen = true;
          }
        }
        if (subscription) {
          if (terminalFailure) upstreamFailed = true;
          else enqueue(Buffer.from(normalizedFrame), semantic.length);
        } else {
          enqueue(bytes, semantic.length);
          enqueue(Buffer.from("\n"), 0);
        }
        if (subscription && finishSeen && usage) done = true;
        await flush(false);
      };
      // Retain one bounded SSE frame; only the blank delimiter dispatches its joined data.
      const consume = async (bytes: Uint8Array) => {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r?\n$/, "");
        if (subscription) {
          if (text === "") {
            const data = subscriptionData.join("\n");
            const hasData = subscriptionData.length > 0;
            subscriptionData = [];
            subscriptionFrameBytes = 0;
            if (hasData) await consumeData(data, bytes);
            return;
          }
          if (++frameCount > 16_384) fail("SSE_FRAME_INVALID");
          subscriptionFrameBytes += bytes.length;
          if (subscriptionFrameBytes > PI_WORKER_MAX_RESPONSE_BYTES) fail("SSE_FRAME_BYTE_LIMIT");
          if (text.startsWith("data:")) subscriptionData.push(text.slice(5).replace(/^ /, ""));
          return;
        }
        if (text === "") return;
        if (++frameCount > 16_384 || done || !text.startsWith("data: ")) fail("SSE_FRAME_INVALID");
        await consumeData(text.slice(6), bytes);
      };
      while (true) {
        check();
        const read = initialRead ?? (await reader.read());
        initialRead = undefined;
        check();
        const chunk = read.value;
        if (read.done && (!chunk || chunk.byteLength === 0)) break;
        if (!chunk) fail("TRANSPORT_RESPONSE_BODY_MISSING");
        if (responseBytes + chunk.length > PI_WORKER_MAX_RESPONSE_BYTES)
          fail("RESPONSE_BYTE_LIMIT");
        responseBytes += chunk.length;
        // Scan bounded slices before retention, including echoes across transport read boundaries.
        for (let start = 0; start < chunk.length; start += PI_WORKER_MAX_CHUNK_BYTES) {
          rawTail = scanSecret(rawTail, chunk.subarray(start, start + PI_WORKER_MAX_CHUNK_BYTES));
          if (accountSecret.length > 0)
            rawAccountTail = scanSecret(
              rawAccountTail,
              chunk.subarray(start, start + PI_WORKER_MAX_CHUNK_BYTES),
              accountSecret,
            );
        }
        for (let offset = 0; offset < chunk.length;) {
          const newline = chunk.indexOf(10, offset);
          const end = newline < 0 ? chunk.length : newline + 1;
          const size = end - offset;
          if (length + size > line.length) fail("SSE_FRAME_BYTE_LIMIT");
          line.set(chunk.subarray(offset, end), length);
          length += size;
          if (newline >= 0) {
            await consume(line.subarray(0, length));
            length = 0;
          }
          offset = end;
        }
        if (read.done) break;
      }
      if (subscription && done) {
        // Even an unterminated trailing frame is scanned after completion; it cannot replace accounting.
        if (length > 0) await consume(line.subarray(0, length));
        if (subscriptionData.length > 0)
          await consumeData(subscriptionData.join("\n"), Buffer.alloc(0));
      }
      if (upstreamFailed) fail("SSE_UPSTREAM_ERROR");
      if ((!subscription && length !== 0) || !done || !usage || !reportedModel)
        fail("SSE_ACCOUNTING_REQUIRED");
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
        try {
          reader.releaseLock();
        } catch {
          cancelFailed = true;
          failure ??= new PiModelBrokerError("TRANSPORT_DRAIN_FAILED");
        }
      }
      if (reservationId) {
        try {
          const settlement: PiModelRequestSettlement = {
            ...reservation,
            reservationId,
            transportDrained: !cancelFailed,
            outcome: usage ? (failure ? "failed" : "reported") : "unknown",
            chargedInputTokens: usage
              ? failure
                ? Math.max(usage.prompt_tokens, reservation.maxInputTokens)
                : usage.prompt_tokens
              : reservation.maxInputTokens,
            chargedOutputTokens: usage
              ? failure
                ? Math.max(usage.completion_tokens, reservation.maxOutputTokens)
                : usage.completion_tokens
              : subscription
                ? 64_000
                : reservation.maxOutputTokens,
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
          transportDrained: !cancelFailed,
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
