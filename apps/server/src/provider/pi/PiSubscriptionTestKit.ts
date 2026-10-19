import { expect } from "vite-plus/test";
import type { Model } from "@earendil-works/pi-ai";
import {
  makePiModelBroker,
  type PiModelBrokerConfig,
  type PiModelRequestReservation,
  type PiModelRequestSettlement,
} from "./PiModelBroker.ts";

export const model = "gpt-6-luna";
export const endpoint = "https://chatgpt.com/backend-api/codex/responses";
export const accountId = "synthetic-parent-account";
export const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export const credential = `${part({ alg: "none" })}.${part({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.synthetic-signature`;
export const body = (extra: object = {}) =>
  JSON.stringify({
    model,
    store: false,
    stream: true,
    instructions: "Trusted assignment",
    input: [{ role: "user", content: [{ type: "input_text", text: "Investigate" }] }],
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" },
    service_tier: "default",
    ...extra,
  });
export const event = <T extends { type: string }>(value: T) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
export const success = (outputTokens = 10) =>
  event({
    type: "response.created",
    response: { id: "response-1", model, status: "in_progress" },
  }) +
  event({
    type: "response.output_text.delta",
    item_id: "message-1",
    output_index: 0,
    content_index: 0,
    delta: "bounded result",
  }) +
  event({
    type: "response.completed",
    response: {
      id: "response-1",
      model,
      status: "completed",
      output: [],
      usage: {
        input_tokens: 50,
        output_tokens: outputTokens,
        total_tokens: 50 + outputTokens,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 7 },
      },
    },
  });
export const sdkModel = {
  id: model,
  name: "GPT-6 Luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: endpoint,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: true,
  contextWindow: 128_000,
  maxTokens: 2_048,
} satisfies Model<"openai-codex-responses">;
export const fixture = (
  overrides: Partial<PiModelBrokerConfig> = {},
  omitSubscriptionAuthorization = false,
) => {
  const reservations: PiModelRequestReservation[] = [];
  const settlements: PiModelRequestSettlement[] = [];
  const chunks: Uint8Array[] = [];
  let transportCalls = 0;
  const cfg: PiModelBrokerConfig = {
    workerId: "worker",
    generation: 7,
    operationId: "operation",
    routeId: "openai-subscription-luna",
    provider: "openai-codex",
    model,
    endpoint,
    tools: [],
    acceptedReportedModels: [model],
    maxInputTokens: 16_384,
    maxOutputTokens: 2_048,
    deadlineMs: 10_000,
    requiredSystemText: "Trusted assignment",
    bindRequestInput: async () => {},
    authorizeCurrent: async () => {},
    ...(omitSubscriptionAuthorization ? {} : { authorizeSubscriptionTest: async () => {} }),
    getCredential: async () => credential,
    reserveRequest: async (reservation) => {
      reservations.push(reservation);
      return { reservationId: "reservation-1" };
    },
    settleRequest: async (settlement) => {
      settlements.push(settlement);
      return { accountingReceiptId: "accounted-1" };
    },
    transport: async (url, init) => {
      transportCalls++;
      expect(url).toBe(endpoint);
      expect(init.headers.Authorization).toBe(`Bearer ${credential}`);
      expect(init.headers["chatgpt-account-id"]).toBe(accountId);
      expect(init.headers.originator).toBe("pi");
      expect(init.headers["OpenAI-Beta"]).toBe("responses=experimental");
      expect(init.headers.accept).toBe("text/event-stream");
      expect(JSON.parse(init.body)).toEqual(JSON.parse(body()));
      return new Response(success(), { headers: { "content-type": "text/event-stream" } });
    },
    ...overrides,
  };
  const broker = makePiModelBroker(cfg);
  const invoke = (request = body(), forward?: (chunk: Uint8Array) => void) =>
    broker.request({
      requestId: 1,
      body: request,
      signal: new AbortController().signal,
      onChunk: async (chunk) => {
        chunks.push(chunk);
        forward?.(chunk);
      },
    });
  return { invoke, reservations, settlements, chunks, transportCalls: () => transportCalls };
};
