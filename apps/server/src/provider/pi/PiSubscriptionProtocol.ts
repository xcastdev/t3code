import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import * as Schema from "effect/Schema";
import { PI_WORKER_MAX_REQUEST_BYTES, PI_WORKER_MAX_RESPONSE_BYTES } from "./PiWorkerProtocol.ts";

const Json = Schema.decodeUnknownSync(Schema.Json);
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const isRecord = Schema.is(UnknownRecord);
const canonical = (value: Schema.Json): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
};
const only = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown): value is string =>
  typeof value === "string" && Buffer.byteLength(value) <= 12_288;
// Complete model output and opaque reasoning share the existing response-body budget.
// Request transport separately enforces its smaller whole-body budget.
const modelText = (value: unknown): value is string =>
  typeof value === "string" && Buffer.byteLength(value) <= PI_WORKER_MAX_RESPONSE_BYTES;
const isTextContent = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  only(value, ["type", "text", "annotations"]) &&
  (value.type === "input_text" || value.type === "output_text") &&
  typeof value.text === "string" &&
  Buffer.byteLength(value.text) <= PI_WORKER_MAX_REQUEST_BYTES &&
  (value.type === "input_text"
    ? value.annotations === undefined
    : value.annotations === undefined || Array.isArray(value.annotations));
const isReasoningPart = (value: unknown, type: "summary_text" | "reasoning_text") =>
  isRecord(value) && only(value, ["type", "text"]) && value.type === type && modelText(value.text);
const validLogprobs = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= 128 &&
  value.every(
    (entry) =>
      isRecord(entry) &&
      only(entry, ["token", "logprob", "top_logprobs"]) &&
      text(entry.token) &&
      Number.isFinite(entry.logprob) &&
      (entry.top_logprobs === undefined ||
        (Array.isArray(entry.top_logprobs) &&
          entry.top_logprobs.length <= 20 &&
          entry.top_logprobs.every(
            (top: Schema.JsonObject) =>
              isRecord(top) &&
              only(top, ["token", "logprob"]) &&
              (top.token === undefined || text(top.token)) &&
              (top.logprob === undefined || Number.isFinite(top.logprob)),
          ))),
  );
const validContentPart = (value: unknown) => {
  if (!isRecord(value)) return false;
  if (value.type === "refusal") return only(value, ["type", "refusal"]) && modelText(value.refusal);
  if (value.type === "reasoning_text")
    return only(value, ["type", "text"]) && modelText(value.text);
  return (
    value.type === "output_text" &&
    only(value, ["type", "text", "annotations", "logprobs"]) &&
    modelText(value.text) &&
    (value.annotations === undefined || Array.isArray(value.annotations)) &&
    (value.logprobs === undefined || validLogprobs(value.logprobs))
  );
};
const validMessageContent = (value: unknown) =>
  Array.isArray(value) &&
  value.every(
    (part) =>
      isRecord(part) &&
      (part.type === "output_text" || part.type === "refusal") &&
      validContentPart(part),
  );
const validReasoningItem = (value: Record<string, unknown>) =>
  only(value, ["id", "type", "summary", "content", "encrypted_content", "status"]) &&
  text(value.id) &&
  value.type === "reasoning" &&
  Array.isArray(value.summary) &&
  value.summary.every((part) => isReasoningPart(part, "summary_text")) &&
  (value.content === undefined ||
    (Array.isArray(value.content) &&
      value.content.every((part) => isReasoningPart(part, "reasoning_text")))) &&
  (value.encrypted_content === undefined ||
    value.encrypted_content === null ||
    modelText(value.encrypted_content)) &&
  (value.status === undefined ||
    ["in_progress", "completed", "incomplete"].includes(String(value.status)));
const validOutputMessage = (value: Record<string, unknown>) =>
  only(value, ["id", "type", "role", "content", "status", "phase"]) &&
  text(value.id) &&
  value.type === "message" &&
  value.role === "assistant" &&
  validMessageContent(value.content) &&
  (value.status === undefined ||
    ["in_progress", "completed", "incomplete"].includes(String(value.status))) &&
  (value.phase === undefined || value.phase === "commentary" || value.phase === "final_answer");

export interface PiSubscriptionRequest {
  readonly canonicalBody: string;
  readonly normalizedBody: string;
  readonly sessionId?: string;
}

// Convert only the Responses fields needed by the shared authorization and tool-history checks.
// Transport retains the canonical Responses document; it is never sent as Chat Completions.
export function decodePiSubscriptionRequest(body: string, model: string): PiSubscriptionRequest {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("REQUEST_INVALID");
  }
  if (
    !isRecord(value) ||
    !only(value, [
      "model",
      "store",
      "stream",
      "instructions",
      "input",
      "text",
      "include",
      "prompt_cache_key",
      "tool_choice",
      "parallel_tool_calls",
      "tools",
      "reasoning",
      "service_tier",
    ]) ||
    value.model !== model ||
    value.store !== false ||
    value.stream !== true ||
    !text(value.instructions) ||
    !Array.isArray(value.input) ||
    value.input.length > 128 ||
    !isRecord(value.text) ||
    !only(value.text, ["verbosity"]) ||
    !["low", "medium", "high"].includes(String(value.text.verbosity)) ||
    !Array.isArray(value.include) ||
    value.include.length !== 1 ||
    value.include[0] !== "reasoning.encrypted_content" ||
    !["auto", "required", "none"].includes(String(value.tool_choice)) ||
    value.parallel_tool_calls !== true ||
    !isRecord(value.reasoning) ||
    !only(value.reasoning, ["effort", "summary"]) ||
    value.reasoning.effort !== "high" ||
    value.reasoning.summary !== "auto" ||
    value.service_tier !== "default" ||
    (value.prompt_cache_key !== undefined &&
      (!text(value.prompt_cache_key) ||
        value.prompt_cache_key.length > OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH ||
        !/^[\x20-\x7E\xA0-\xFF]*$/u.test(value.prompt_cache_key) ||
        /\p{Cf}/u.test(value.prompt_cache_key)))
  )
    throw new Error("REQUEST_MODEL_OR_OUTPUT_INVALID");
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: value.instructions },
  ];
  for (const item of value.input) {
    if (!isRecord(item)) throw new Error("REQUEST_INVALID");
    if (item.type === "message" || item.type === undefined) {
      if (
        !only(item, ["type", "id", "status", "phase", "role", "content"]) ||
        !["user", "assistant"].includes(String(item.role)) ||
        (item.id !== undefined && !text(item.id)) ||
        (item.status !== undefined &&
          !["in_progress", "completed", "incomplete"].includes(String(item.status))) ||
        (item.phase !== undefined && item.phase !== "commentary" && item.phase !== "final_answer")
      )
        throw new Error("REQUEST_INVALID");
      const content =
        typeof item.content === "string"
          ? item.content
          : Array.isArray(item.content) && item.content.every(isTextContent)
            ? item.content.map((part: Schema.JsonObject) => String(part.text)).join("")
            : undefined;
      if (content === undefined) throw new Error("REQUEST_INVALID");
      messages.push({ role: item.role, content });
    } else if (item.type === "function_call") {
      if (
        !only(item, ["type", "name", "call_id", "id", "arguments"]) ||
        !text(item.name) ||
        !text(item.call_id) ||
        !text(item.arguments)
      )
        throw new Error("REQUEST_INVALID");
      let args: unknown;
      try {
        args = JSON.parse(item.arguments);
      } catch {
        throw new Error("REQUEST_TOOL_ARGUMENTS_INVALID");
      }
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: canonical(Json(args)) },
          },
        ],
      });
    } else if (item.type === "function_call_output") {
      if (
        !only(item, ["type", "call_id", "output"]) ||
        !text(item.call_id) ||
        !(text(item.output) || isRecord(item.output) || Array.isArray(item.output))
      )
        throw new Error("REQUEST_INVALID");
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : canonical(Json(item.output)),
      });
    } else if (item.type === "reasoning") {
      if (!validReasoningItem(item)) throw new Error("REQUEST_INVALID");
    } else throw new Error("REQUEST_INVALID");
  }
  const tools =
    value.tools === undefined
      ? undefined
      : Array.isArray(value.tools) &&
          value.tools.every(
            (tool) =>
              isRecord(tool) &&
              only(tool, ["type", "name", "description", "parameters", "strict"]) &&
              tool.type === "function" &&
              text(tool.name) &&
              (tool.description === undefined || text(tool.description)) &&
              isRecord(tool.parameters) &&
              (tool.strict === true || tool.strict === null || tool.strict === undefined),
          )
        ? value.tools.map((tool) =>
            isRecord(tool)
              ? {
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description ?? "",
                    parameters: tool.parameters,
                  },
                }
              : (() => {
                  throw new Error("REQUEST_INVALID");
                })(),
          )
        : (() => {
            throw new Error("REQUEST_INVALID");
          })();
  const normalized = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    store: false,
    max_tokens: 2_048,
    ...(tools ? { tools } : {}),
    tool_choice:
      value.tool_choice === "required"
        ? "required"
        : value.tool_choice === "none"
          ? "none"
          : "auto",
  };
  return {
    canonicalBody: canonical(Json(value)),
    normalizedBody: JSON.stringify(normalized),
    ...(typeof value.prompt_cache_key === "string" && value.prompt_cache_key
      ? { sessionId: value.prompt_cache_key }
      : {}),
  };
}

export interface PiSubscriptionEvent {
  readonly responseId?: string;
  readonly model?: string;
  readonly terminal?: boolean;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
  };
  readonly chunk: Record<string, unknown>;
  readonly semanticText: string;
  readonly toolNames?: readonly string[];
  readonly toolItem?: {
    readonly phase: "added" | "finalized";
    readonly index: number;
    readonly itemId?: string;
    readonly name: string;
    readonly callId: string;
    readonly arguments: string;
  };
  readonly argumentItem?: {
    readonly index: number;
    readonly itemId?: string;
    readonly arguments: string;
    readonly complete: boolean;
  };
  readonly toolCalls?: readonly {
    readonly index: number;
    readonly itemId?: string;
    readonly name: string;
    readonly callId: string;
    readonly arguments: string;
  }[];
}

export function decodePiSubscriptionEvent(
  eventType: string,
  payload: unknown,
  expectedModel: string,
): PiSubscriptionEvent {
  if (
    !isRecord(payload) ||
    !only(payload, [
      "type",
      "sequence_number",
      "response",
      "item_id",
      "output_index",
      "content_index",
      "summary_index",
      "delta",
      "item",
      "arguments",
      "text",
      "content_part",
      "part",
      "logprobs",
    ]) ||
    payload.type !== eventType ||
    (payload.sequence_number !== undefined &&
      (!Number.isSafeInteger(payload.sequence_number) || Number(payload.sequence_number) < 0))
  )
    throw new Error("SSE_FRAME_INVALID");
  if (eventType.endsWith(".delta")) {
    if (
      !text(payload.delta) ||
      (payload.item_id !== undefined && !text(payload.item_id)) ||
      (payload.output_index !== undefined && !Number.isSafeInteger(payload.output_index)) ||
      (payload.content_index !== undefined && !Number.isSafeInteger(payload.content_index)) ||
      (payload.summary_index !== undefined && !Number.isSafeInteger(payload.summary_index))
    )
      throw new Error("SSE_FRAME_INVALID");
    const key =
      eventType === "response.output_text.delta" || eventType === "response.refusal.delta"
        ? "content"
        : eventType === "response.reasoning_summary_text.delta" ||
            eventType === "response.reasoning_text.delta"
          ? "reasoning_content"
          : undefined;
    if (key)
      return {
        chunk: {
          model: expectedModel,
          choices: [{ index: 0, delta: { [key]: payload.delta }, finish_reason: null }],
        },
        semanticText: payload.delta,
      };
    if (eventType === "response.function_call_arguments.delta")
      return {
        argumentItem: {
          index: Number(payload.output_index),
          ...(payload.item_id === undefined ? {} : { itemId: String(payload.item_id) }),
          arguments: payload.delta,
          complete: false,
        },
        chunk: {
          model: expectedModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: Number(payload.output_index), function: { arguments: payload.delta } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        semanticText: payload.delta,
      };
    throw new Error("SSE_FRAME_INVALID");
  }
  if (eventType === "response.output_item.added") {
    const item = payload.item;
    if (isRecord(item) && (item.type === "message" || item.type === "reasoning")) {
      if (item.type === "message" ? !validOutputMessage(item) : !validReasoningItem(item))
        throw new Error("SSE_FRAME_INVALID");
      return {
        chunk: { model: expectedModel, choices: [{ index: 0, delta: {}, finish_reason: null }] },
        semanticText: "",
      };
    }
    if (
      !isRecord(item) ||
      !only(item, ["id", "type", "call_id", "name", "arguments", "status"]) ||
      item.type !== "function_call" ||
      !text(item.name) ||
      !text(item.call_id) ||
      !Number.isSafeInteger(payload.output_index) ||
      (item.id !== undefined && !text(item.id)) ||
      (item.status !== undefined &&
        !["in_progress", "completed", "incomplete"].includes(String(item.status))) ||
      (item.arguments !== undefined && !text(item.arguments))
    )
      throw new Error("SSE_TOOL_INVALID");
    return {
      toolItem: {
        phase: "added",
        index: Number(payload.output_index),
        ...(item.id === undefined ? {} : { itemId: String(item.id) }),
        name: item.name,
        callId: item.call_id,
        arguments: String(item.arguments ?? ""),
      },
      chunk: {
        model: expectedModel,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: payload.output_index,
                  id: item.call_id,
                  type: "function",
                  function: { name: item.name },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      semanticText: "",
    };
  }
  if (eventType === "response.created" || eventType === "response.in_progress") {
    const response = payload.response;
    if (
      !isRecord(response) ||
      !text(response.id) ||
      response.model !== expectedModel ||
      !text(response.status)
    )
      throw new Error("SSE_MODEL_REJECTED");
    return {
      responseId: response.id,
      model: response.model,
      chunk: { model: expectedModel, choices: [{ index: 0, delta: {}, finish_reason: null }] },
      semanticText: "",
    };
  }
  if (
    eventType === "response.completed" ||
    eventType === "response.done" ||
    eventType === "response.incomplete"
  ) {
    const response = payload.response;
    if (!isRecord(response) || !text(response.id)) throw new Error("SSE_ACCOUNTING_REQUIRED");
    if (response.model !== expectedModel) throw new Error("SSE_MODEL_REJECTED");
    if (
      (eventType === "response.done"
        ? response.status !== "completed" && response.status !== "incomplete"
        : response.status !== (eventType === "response.incomplete" ? "incomplete" : "completed")) ||
      !isRecord(response.usage) ||
      !Array.isArray(response.output)
    )
      throw new Error("SSE_ACCOUNTING_REQUIRED");
    for (const item of response.output) {
      if (!isRecord(item) || !["message", "function_call", "reasoning"].includes(String(item.type)))
        throw new Error("SSE_FRAME_INVALID");
      if (item.type === "function_call") {
        if (
          !only(item, ["id", "type", "call_id", "name", "arguments", "status"]) ||
          !text(item.name) ||
          !text(item.call_id) ||
          !text(item.arguments) ||
          (item.id !== undefined && !text(item.id)) ||
          (item.status !== undefined &&
            !["in_progress", "completed", "incomplete"].includes(String(item.status)))
        )
          throw new Error("SSE_TOOL_INVALID");
        try {
          Json(JSON.stringify(JSON.parse(item.arguments)));
        } catch {
          throw new Error("SSE_TOOL_INVALID");
        }
      }
      if (item.type === "message" && !validOutputMessage(item))
        throw new Error("SSE_FRAME_INVALID");
      if (item.type === "reasoning" && !validReasoningItem(item))
        throw new Error("SSE_FRAME_INVALID");
    }
    const u = response.usage;
    if (
      !isRecord(u) ||
      ![u.input_tokens, u.output_tokens, u.total_tokens].every(
        (n) => Number.isSafeInteger(n) && Number(n) >= 0,
      )
    )
      throw new Error("SSE_USAGE_INVALID");
    const toolCalls: NonNullable<PiSubscriptionEvent["toolCalls"]>[number][] = [];
    for (const [index, item] of response.output.entries()) {
      if (
        isRecord(item) &&
        item.type === "function_call" &&
        text(item.name) &&
        text(item.call_id) &&
        text(item.arguments)
      ) {
        toolCalls.push({
          index,
          ...(item.id === undefined ? {} : { itemId: String(item.id) }),
          name: item.name,
          callId: item.call_id,
          arguments: item.arguments,
        });
      }
    }
    const inputDetails = isRecord(u.input_tokens_details) ? u.input_tokens_details : undefined;
    const outputDetails = isRecord(u.output_tokens_details) ? u.output_tokens_details : undefined;
    return {
      responseId: response.id,
      model: response.model,
      terminal: true,
      toolNames: toolCalls.map((call) => call.name),
      toolCalls,
      usage: {
        prompt_tokens: Number(u.input_tokens),
        completion_tokens: Number(u.output_tokens),
        total_tokens: Number(u.total_tokens),
        ...(inputDetails && Number.isSafeInteger(inputDetails.cached_tokens)
          ? { prompt_tokens_details: { cached_tokens: Number(inputDetails.cached_tokens) } }
          : {}),
        ...(outputDetails && Number.isSafeInteger(outputDetails.reasoning_tokens)
          ? {
              completion_tokens_details: {
                reasoning_tokens: Number(outputDetails.reasoning_tokens),
              },
            }
          : {}),
      },
      chunk: {
        model: expectedModel,
        choices: [],
        usage: {
          prompt_tokens: Number(u.input_tokens),
          completion_tokens: Number(u.output_tokens),
          total_tokens: Number(u.total_tokens),
        },
      },
      semanticText: "",
    };
  }
  if (
    [
      "response.output_text.done",
      "response.reasoning_summary_text.done",
      "response.reasoning_text.done",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_part.done",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.content_part.added",
      "response.content_part.done",
    ].includes(eventType)
  ) {
    if (
      eventType === "response.reasoning_summary_part.added" ||
      eventType === "response.reasoning_summary_part.done"
    ) {
      if (
        !text(payload.item_id) ||
        !Number.isSafeInteger(payload.output_index) ||
        !Number.isSafeInteger(payload.summary_index) ||
        !isReasoningPart(payload.part, "summary_text")
      )
        throw new Error("SSE_FRAME_INVALID");
      return {
        chunk: { model: expectedModel, choices: [{ index: 0, delta: {}, finish_reason: null }] },
        semanticText: "",
      };
    }
    if (eventType === "response.function_call_arguments.done") {
      if (!text(payload.arguments) || !Number.isSafeInteger(payload.output_index))
        throw new Error("SSE_TOOL_INVALID");
      return {
        argumentItem: {
          index: Number(payload.output_index),
          ...(payload.item_id === undefined ? {} : { itemId: String(payload.item_id) }),
          arguments: payload.arguments,
          complete: true,
        },
        chunk: {
          model: expectedModel,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: payload.output_index, function: { arguments: payload.arguments } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        semanticText: payload.arguments,
      };
    }
    if (
      eventType.endsWith(".done") &&
      eventType !== "response.output_item.done" &&
      eventType !== "response.content_part.done" &&
      eventType !== "response.function_call_arguments.done" &&
      !modelText(payload.text)
    )
      throw new Error("SSE_FRAME_INVALID");
    if (
      eventType === "response.output_text.done" &&
      payload.logprobs !== undefined &&
      !validLogprobs(payload.logprobs)
    )
      throw new Error("SSE_FRAME_INVALID");
    if (
      (eventType === "response.content_part.added" || eventType === "response.content_part.done") &&
      !validContentPart(payload.part)
    )
      throw new Error("SSE_FRAME_INVALID");
    if (eventType === "response.output_item.done") {
      if (
        !isRecord(payload.item) ||
        !["message", "function_call", "reasoning"].includes(String(payload.item.type))
      )
        throw new Error("SSE_FRAME_INVALID");
      if (
        payload.item.type === "function_call" &&
        (!only(payload.item, ["id", "type", "status", "call_id", "name", "arguments"]) ||
          !text(payload.item.name) ||
          !text(payload.item.call_id) ||
          !text(payload.item.arguments) ||
          (payload.item.id !== undefined && !text(payload.item.id)))
      )
        throw new Error("SSE_TOOL_INVALID");
      if (payload.item.type === "function_call") {
        if (
          !Number.isSafeInteger(payload.output_index) ||
          !text(payload.item.name) ||
          !text(payload.item.call_id) ||
          !text(payload.item.arguments) ||
          (payload.item.status !== undefined &&
            !["in_progress", "completed", "incomplete"].includes(String(payload.item.status)))
        )
          throw new Error("SSE_TOOL_INVALID");
        return {
          toolItem: {
            phase: "finalized",
            index: Number(payload.output_index),
            ...(payload.item.id === undefined ? {} : { itemId: String(payload.item.id) }),
            name: payload.item.name,
            callId: payload.item.call_id,
            arguments: payload.item.arguments,
          },
          chunk: { model: expectedModel, choices: [{ index: 0, delta: {}, finish_reason: null }] },
          semanticText: "",
        };
      }
      if (payload.item.type === "message" && !validOutputMessage(payload.item))
        throw new Error("SSE_FRAME_INVALID");
      if (payload.item.type === "reasoning" && !validReasoningItem(payload.item))
        throw new Error("SSE_FRAME_INVALID");
    }
    return {
      chunk: { model: expectedModel, choices: [{ index: 0, delta: {}, finish_reason: null }] },
      semanticText: "",
    };
  }
  throw new Error("SSE_FRAME_INVALID");
}
