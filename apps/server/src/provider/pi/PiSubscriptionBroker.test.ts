import { describe, expect, it } from "vite-plus/test";
import { Type, type AssistantMessage, type Model, type Usage } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { piManagedModelRoute } from "./PiManagedModels.ts";
import { PI_WORKER_MAX_CHUNK_BYTES } from "./PiWorkerProtocol.ts";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  makePiModelBroker,
  type PiModelBrokerConfig,
  type PiModelRequestReservation,
  type PiModelRequestSettlement,
} from "./PiModelBroker.ts";

const model = "gpt-6-luna";
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const accountId = "synthetic-parent-account";
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const credential = `${part({ alg: "none" })}.${part({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.synthetic-signature`;
const body = (extra: object = {}) =>
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
const event = <T extends { type: string }>(value: T) =>
  `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const success = (outputTokens = 10) =>
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
const sdkModel = {
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
const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const fixture = (
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

describe("Pi OpenAI subscription broker", () => {
  it.each(["reported-input", "large-frame"] as const)(
    "review R4/R6 preserves CommandCode hard limits: %s",
    async (boundary) => {
      const hardModel = "inclusionai/ling-3.1-flash:free";
      const data = (value: object) => `data: ${JSON.stringify(value)}\n\n`;
      const counts = { prompt_tokens: 17000, completion_tokens: 10, total_tokens: 17010 };
      const stream =
        boundary === "large-frame"
          ? "data: " + "x".repeat(65536)
          : data({
              model: hardModel,
              choices: [{ index: 0, delta: { content: "result" }, finish_reason: null }],
            }) +
            data({ model: hardModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
            data({ model: hardModel, choices: [], usage: counts }) +
            "data: [DONE]\n\n";
      const f = fixture({
        ...piManagedModelRoute(hardModel),
        model: hardModel,
        maxOutputTokens: 512,
        transport: async () =>
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      });
      const request = JSON.stringify({
        model: hardModel,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 512,
        messages: [
          { role: "system", content: "Trusted assignment" },
          { role: "user", content: "Investigate" },
        ],
      });
      await expect(f.invoke(request)).rejects.toMatchObject({
        code: boundary === "large-frame" ? "SSE_FRAME_BYTE_LIMIT" : "SSE_USAGE_OVER_RESERVATION",
      });
      expect(f.settlements).toMatchObject([
        {
          outcome: boundary === "large-frame" ? "unknown" : "failed",
          chargedInputTokens: boundary === "large-frame" ? 16384 : 17000,
        },
      ]);
      if (boundary === "large-frame") expect(f.chunks).toHaveLength(0);
    },
  );
  it.each([
    "valid",
    "arguments",
    "identity",
    "item-id",
    "extra-finalized",
    "missing-finalized",
    "missing-terminal",
  ])("review R2 actual SDK consumes only bound finalized calls: %s", async (mutation) => {
    const parameters = {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    };
    const declared = {
      type: "function" as const,
      function: { name: "lookup", description: "Look up a value", parameters },
    };
    const call = {
      id: "fc_1",
      type: "function_call",
      call_id: "call-1",
      name: "lookup",
      arguments: '{"key":"A"}',
    };
    const finalized = {
      ...call,
      ...(mutation === "arguments" ? { arguments: '{"key":"B"}' } : {}),
      ...(mutation === "identity" ? { call_id: "foreign-call" } : {}),
      ...(mutation === "item-id" ? { id: "foreign-item" } : {}),
    };
    const data =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...call, arguments: "" },
      }) +
      event({
        type: "response.function_call_arguments.delta",
        item_id: call.id,
        output_index: 0,
        delta: call.arguments,
      }) +
      event({
        type: "response.function_call_arguments.done",
        item_id: call.id,
        output_index: 0,
        arguments: call.arguments,
      }) +
      (mutation === "missing-finalized"
        ? ""
        : event({ type: "response.output_item.done", output_index: 0, item: finalized })) +
      (mutation === "extra-finalized"
        ? event({
            type: "response.output_item.done",
            output_index: 1,
            item: { ...call, id: "fc_extra", call_id: "extra-call" },
          })
        : "") +
      event({
        type: "response.completed",
        response: {
          id: "response-1",
          model,
          status: "completed",
          output: mutation === "missing-terminal" ? [] : [call],
          usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        },
      });
    const f = fixture({
      tools: [declared],
      transport: async () =>
        new Response(data, { headers: { "content-type": "text/event-stream" } }),
    });
    let brokerFailure: unknown;
    let joined: Promise<void> | undefined;
    const sdk = streamCodexResponses(
      sdkModel,
      normalizeContext({
        systemPrompt: "Trusted assignment",
        messages: [{ role: "user", content: "Investigate", timestamp: 1 }],
        tools: [
          {
            name: "lookup",
            description: declared.function.description,
            parameters: Type.Unsafe<{ key: string }>(parameters),
          },
        ],
      }),
      {
        apiKey: credential,
        reasoningEffort: "high",
        serviceTier: "default",
        transport: "sse",
        maxRetries: 0,
        fetch: async (_url, init) => {
          const encoded = init?.body;
          const request =
            typeof encoded === "string"
              ? encoded
              : encoded instanceof Uint8Array &&
                  new Headers(init?.headers).get("content-encoding") === "zstd"
                ? process
                    .getBuiltinModule("node:zlib")!
                    .zstdDecompressSync(encoded, { maxOutputLength: 16384 })
                    .toString("utf8")
                : undefined;
          if (request === undefined) throw Error("SDK request body must be bounded JSON");
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                joined = f
                  .invoke(request, (chunk) => controller.enqueue(chunk))
                  .then(
                    () => controller.close(),
                    (error: unknown) => {
                      brokerFailure = error;
                      controller.error(error);
                    },
                  );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    const result = await sdk.result();
    expect(joined).toBeDefined();
    await joined;
    const calls = result.content.filter((part) => part.type === "toolCall");
    if (mutation === "valid") {
      expect(brokerFailure).toBeUndefined();
      expect(result.stopReason).toBe("toolUse");
      expect(calls).toMatchObject([{ name: "lookup", arguments: { key: "A" } }]);
      expect(f.settlements).toMatchObject([{ outcome: "reported" }]);
    } else {
      expect(brokerFailure).toMatchObject({ code: "SSE_TOOL_INVALID" });
      expect(result.stopReason).toBe("error");
      expect(calls.some((call) => call.arguments.key === "B")).toBe(false);
      expect(f.settlements).toMatchObject([{ outcome: "unknown" }]);
    }
  });
  it("review R4 retains reported input overshoot on the monitored route", async () => {
    const data = success()
      .replace('"input_tokens":50', '"input_tokens":17000')
      .replace('"total_tokens":60', '"total_tokens":17010');
    const f = fixture({
      transport: async () =>
        new Response(data, { headers: { "content-type": "text/event-stream" } }),
    });
    expect((await f.invoke()).usage).toMatchObject({ prompt_tokens: 17000, total_tokens: 17010 });
    expect(f.settlements).toMatchObject([{ outcome: "reported", chargedInputTokens: 17000 }]);
  });

  it("review R5 accepts actual SDK array history below the complete request budget", async () => {
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model,
      content: [{ type: "text", text: "h".repeat(12500) }],
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 1,
    };
    const input = convertResponsesMessages(
      sdkModel,
      normalizeContext({
        messages: [assistant, { role: "user", content: "Continue", timestamp: 2 }],
      }),
      new Set(["openai-codex"]),
      { includeSystemPrompt: false },
    );
    const request = body({ input });
    expect(Buffer.byteLength(request)).toBeLessThan(16384);
    let transportCalls = 0;
    const f = fixture({
      transport: async () => {
        transportCalls++;
        return new Response(success(), { headers: { "content-type": "text/event-stream" } });
      },
    });
    await f.invoke(request);
    expect(f.reservations).toHaveLength(1);
    await expect(
      f.invoke(
        body({
          input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(16384) }] }],
        }),
      ),
    ).rejects.toMatchObject({ code: "REQUEST_BYTE_LIMIT" });
    expect(transportCalls).toBe(1);
  });

  it("review R6 handles fragmented complete reasoning items within the response budget", async () => {
    const item = {
      id: "reasoning-1",
      type: "reasoning",
      summary: [],
      encrypted_content: "e".repeat(70000),
    };
    const data =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({ type: "response.output_item.done", output_index: 0, item }) +
      event({
        type: "response.completed",
        response: {
          id: "response-1",
          model,
          status: "completed",
          output: [item],
          usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        },
      });
    const bytes = Buffer.from(data);
    const f = fixture({
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let offset = 0; offset < bytes.length; offset += 2048)
                controller.enqueue(bytes.subarray(offset, offset + 2048));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    expect((await f.invoke()).usage.total_tokens).toBe(60);
    expect(Buffer.concat(f.chunks).toString()).toContain(item.encrypted_content);
    expect(f.settlements).toMatchObject([{ outcome: "reported", transportDrained: true }]);
  });

  it("review R7 accepts the SDK terminal alias with unchanged identity and usage validation", async () => {
    for (const status of ["completed", "incomplete"]) {
      const f = fixture({
        transport: async () =>
          new Response(
            success()
              .replaceAll("response.completed", "response.done")
              .replace(
                '"status":"completed"',
                JSON.stringify("status") + ":" + JSON.stringify(status),
              ),
            { headers: { "content-type": "text/event-stream" } },
          ),
      });
      expect((await f.invoke()).usage.total_tokens).toBe(60);
    }
    const foreign = fixture({
      transport: async () =>
        new Response(
          success()
            .replaceAll("response.completed", "response.done")
            .replaceAll(
              '"id":"response-1","model":"gpt-6-luna","status":"completed"',
              '"id":"foreign","model":"gpt-6-luna","status":"completed"',
            ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    await expect(foreign.invoke()).rejects.toMatchObject({ code: "SSE_MODEL_REJECTED" });
  });
  it("authenticates the parent transport and retains real usage including reasoning", async () => {
    const f = fixture();
    const receipt = await f.invoke();
    expect(receipt.provider).toBe("openai-codex");
    expect(receipt.usage).toMatchObject({
      prompt_tokens: 50,
      completion_tokens: 10,
      total_tokens: 60,
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    expect(f.transportCalls()).toBe(1);
    expect(f.reservations).toHaveLength(1);
    expect(f.reservations[0]).toMatchObject({
      accountingMode: "openai-subscription-monitored",
      unknownMaximumTokens: 64_000,
      maxOutputTokens: 2_048,
    });
    expect(f.settlements[0]).toMatchObject({
      accountingMode: "openai-subscription-monitored",
      unknownMaximumTokens: 64_000,
    });
    expect(f.settlements).toMatchObject([
      {
        outcome: "reported",
        transportDrained: true,
        chargedInputTokens: 50,
        chargedOutputTokens: 10,
      },
    ]);
    const forwarded = Buffer.concat(f.chunks).toString();
    expect(forwarded).toContain("response.completed");
    expect(forwarded).not.toContain(credential);
    expect(forwarded).not.toContain(accountId);
  });

  it.each(["output_text", "encrypted_content"] as const)(
    "retains reported overshoot when subscription %s exceeds the control-text cap",
    async (field) => {
      const large = "x".repeat(13_000);
      const output =
        field === "output_text"
          ? [
              {
                id: "msg_large",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: large, annotations: [] }],
              },
            ]
          : [
              {
                id: "rs_large",
                type: "reasoning",
                status: "completed",
                summary: [],
                encrypted_content: large,
              },
            ];
      const stream =
        event({
          type: "response.created",
          response: {
            id: "response-large",
            model,
            status: "in_progress",
          },
        }) +
        event({
          type: "response.completed",
          response: {
            id: "response-large",
            model,
            status: "completed",
            output,
            usage: { input_tokens: 1_024, output_tokens: 3_072, total_tokens: 4_096 },
          },
        });
      const f = fixture({
        transport: async () =>
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      });
      const receipt = await f.invoke();
      expect(receipt.usage.total_tokens).toBe(4_096);
      expect(f.settlements).toMatchObject([
        { outcome: "reported", chargedInputTokens: 1_024, chargedOutputTokens: 3_072 },
      ]);
      expect(Buffer.concat(f.chunks).toString()).toContain(large);
    },
  );

  it("rejects subscription transport without the approved private test authority", () => {
    expect(() => fixture({}, true)).toThrowError("CONFIG_CALLBACK_REQUIRED");
  });

  it("rejects changed reasoning before reserving or transporting", async () => {
    const f = fixture();
    await expect(
      f.invoke(body({ reasoning: { effort: "low", summary: "auto" } })),
    ).rejects.toMatchObject({ code: "REQUEST_MODEL_OR_OUTPUT_INVALID" });
    expect(f.reservations).toHaveLength(0);
    expect(f.transportCalls()).toBe(0);
  });

  it("accepts model input text above the control-text cap while staying under the request byte limit", async () => {
    const longText = "x".repeat(12_500);
    const request = body({ input: [{ role: "user", content: longText }] });
    expect(Buffer.byteLength(request)).toBeLessThan(16_384);
    const transportedBodies: unknown[] = [];
    const f = fixture({
      transport: async (_url, init) => {
        transportedBodies.push(JSON.parse(init.body));
        return new Response(success(), { headers: { "content-type": "text/event-stream" } });
      },
    });

    await f.invoke(request);

    expect(transportedBodies).toHaveLength(1);
    expect(transportedBodies[0]).toMatchObject({ input: [{ role: "user", content: longText }] });
  });

  it("retains subscription output overshoot as reported usage instead of claiming a hard output cap", async () => {
    const f = fixture({
      transport: async () =>
        new Response(success(3_072), { headers: { "content-type": "text/event-stream" } }),
    });
    const receipt = await f.invoke();
    expect(receipt.usage.completion_tokens).toBe(3_072);
    expect(f.settlements).toMatchObject([
      { outcome: "reported", chargedInputTokens: 50, chargedOutputTokens: 3_072 },
    ]);
  });

  it("charges and quarantines the full subscription threshold when terminal usage is unknown", async () => {
    const f = fixture({
      transport: async () =>
        new Response(
          event({
            type: "response.created",
            response: { id: "response-1", model, status: "in_progress" },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "SSE_ACCOUNTING_REQUIRED" });
    expect(f.settlements).toMatchObject([
      { outcome: "unknown", chargedInputTokens: 16_384, chargedOutputTokens: 64_000 },
    ]);
  });

  it("rejects a foreign terminal model and retains unknown monitored usage", async () => {
    const foreign = success().replace(
      `"model":"${model}","status":"completed"`,
      `"model":"other-model","status":"completed"`,
    );
    const f = fixture({
      transport: async () =>
        new Response(foreign, { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "SSE_MODEL_REJECTED" });
    expect(f.settlements).toMatchObject([{ outcome: "unknown", chargedOutputTokens: 64_000 }]);
  });

  it("rejects subscription credential echoes in decoded Responses text", async () => {
    const echoed =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_text.delta",
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        delta: credential,
      }) +
      event({
        type: "response.completed",
        response: {
          id: "response-1",
          model,
          status: "completed",
          output: [],
          usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        },
      });
    const f = fixture({
      transport: async () =>
        new Response(echoed, { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "CREDENTIAL_ECHO_REJECTED" });
    expect(f.settlements).toMatchObject([{ outcome: "unknown", chargedOutputTokens: 64_000 }]);
  });

  it("authorizes only the declared Responses function and forwards native frames", async () => {
    const tool = {
      type: "function" as const,
      function: {
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
    };
    const request = body({
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          parameters: tool.function.parameters,
          strict: true,
        },
      ],
    });
    const stream =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "call-1",
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: "",
        },
      }) +
      event({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"key":"x"}',
      }) +
      event({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "call-1",
          type: "function_call",
          call_id: "call-1",
          name: "lookup",
          arguments: '{"key":"x"}',
        },
      }) +
      event({
        type: "response.completed",
        response: {
          id: "response-1",
          model,
          status: "completed",
          output: [
            {
              id: "call-1",
              type: "function_call",
              call_id: "call-1",
              name: "lookup",
              arguments: '{"key":"x"}',
            },
          ],
          usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
        },
      });
    const f = fixture({
      tools: [tool],
      transport: async () =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    await f.invoke(request);
    expect(Buffer.concat(f.chunks).toString()).toContain("response.output_item.added");
    expect(f.settlements).toMatchObject([{ outcome: "reported", chargedOutputTokens: 10 }]);
  });

  it("rejects an undeclared function before forwarding it", async () => {
    const stream =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "call-1",
          type: "function_call",
          call_id: "call-1",
          name: "delete_project",
          arguments: "{}",
        },
      });
    const f = fixture({
      transport: async () =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "SSE_TOOL_INVALID" });
    expect(Buffer.concat(f.chunks).toString()).not.toContain("delete_project");
    expect(f.settlements).toMatchObject([{ outcome: "unknown", chargedOutputTokens: 64_000 }]);
  });

  it("accepts the SDK message and content-item stream before real terminal usage", async () => {
    const message = {
      type: "message",
      id: "message-1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
    };
    const stream =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      }) +
      event({
        type: "response.content_part.added",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }) +
      event({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: "Done",
      }) +
      event({ type: "response.output_item.done", output_index: 0, item: message }) +
      event({
        type: "response.completed",
        response: {
          id: "response-1",
          model,
          status: "completed",
          output: [message],
          usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 },
        },
      });
    const f = fixture({
      transport: async () =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    const receipt = await f.invoke();
    expect(receipt.usage.total_tokens).toBe(9);
    expect(Buffer.concat(f.chunks).toString()).toContain("response.output_item.added");
  });

  it("accepts High Responses reasoning summary parts and SDK-forwarded event metadata", async () => {
    const reasoning = {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Check the request." }],
      content: [{ type: "reasoning_text", text: "Use the retained function result." }],
      encrypted_content: "opaque-reasoning-signature",
      status: "completed",
    };
    const message = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Done", annotations: [], logprobs: [] }],
    };
    const stream =
      event({
        type: "response.created",
        sequence_number: 0,
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { ...reasoning, status: "in_progress", summary: [], encrypted_content: null },
      }) +
      event({
        type: "response.reasoning_summary_part.added",
        sequence_number: 2,
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "Check the request." },
      }) +
      event({
        type: "response.reasoning_summary_text.delta",
        sequence_number: 3,
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        delta: "Check the request.",
      }) +
      event({
        type: "response.reasoning_summary_text.done",
        sequence_number: 4,
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        text: "Check the request.",
      }) +
      event({
        type: "response.reasoning_summary_part.done",
        sequence_number: 5,
        item_id: reasoning.id,
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "Check the request." },
      }) +
      event({
        type: "response.content_part.added",
        sequence_number: 6,
        item_id: reasoning.id,
        output_index: 0,
        content_index: 0,
        part: { type: "reasoning_text", text: "Use the retained function result." },
      }) +
      event({
        type: "response.output_item.done",
        sequence_number: 7,
        output_index: 0,
        item: reasoning,
      }) +
      event({
        type: "response.output_item.added",
        sequence_number: 8,
        output_index: 1,
        item: { ...message, status: "in_progress", content: [] },
      }) +
      event({
        type: "response.output_text.delta",
        sequence_number: 9,
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        delta: "Done",
      }) +
      event({
        type: "response.output_text.done",
        sequence_number: 10,
        item_id: message.id,
        output_index: 1,
        content_index: 0,
        text: "Done",
        logprobs: [],
      }) +
      event({
        type: "response.output_item.done",
        sequence_number: 11,
        output_index: 1,
        item: message,
      }) +
      event({
        type: "response.completed",
        sequence_number: 12,
        response: {
          id: "response-1",
          model,
          status: "completed",
          output: [reasoning, message],
          usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
        },
      });
    const f = fixture({
      transport: async () =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });

    const receipt = await f.invoke();

    expect(receipt.usage.total_tokens).toBe(11);
    const forwarded = Buffer.concat(f.chunks).toString();
    expect(forwarded).toContain("response.reasoning_summary_part.added");
    expect(forwarded).toContain("response.reasoning_summary_part.done");
    expect(forwarded).toContain("opaque-reasoning-signature");
  });

  it("rejects malformed fields inside newly accepted Responses event metadata", async () => {
    const malformedSummaryPart =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.reasoning_summary_part.added",
        sequence_number: 1,
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        part: { type: "summary_text", text: "Check.", unexpected: true },
      });
    const f = fixture({
      transport: async () =>
        new Response(malformedSummaryPart, { headers: { "content-type": "text/event-stream" } }),
    });

    await expect(f.invoke()).rejects.toMatchObject({ code: "SSE_FRAME_INVALID" });
    expect(Buffer.concat(f.chunks).toString()).not.toContain(
      "response.reasoning_summary_part.added",
    );
    expect(f.settlements).toMatchObject([{ outcome: "unknown", chargedOutputTokens: 64_000 }]);
  });

  it("rejects malformed SDK logprobs metadata on completed text events", async () => {
    const malformedLogprobs =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_text.done",
        sequence_number: 1,
        item_id: "message-1",
        output_index: 0,
        content_index: 0,
        text: "Done",
        logprobs: [{ token: "Done", logprob: "high" }],
      });
    const f = fixture({
      transport: async () =>
        new Response(malformedLogprobs, { headers: { "content-type": "text/event-stream" } }),
    });

    await expect(f.invoke()).rejects.toMatchObject({ code: "SSE_FRAME_INVALID" });
    expect(Buffer.concat(f.chunks).toString()).not.toContain("response.output_text.done");
    expect(f.settlements).toMatchObject([{ outcome: "unknown", chargedOutputTokens: 64_000 }]);
  });

  it("normalizes a second turn serialized by Pi AI with signed reasoning and function history", async () => {
    const tool = {
      type: "function" as const,
      function: {
        name: "lookup",
        description: "Look up a value",
        parameters: {
          type: "object",
          properties: { key: { type: "string" } },
          required: ["key"],
          additionalProperties: false,
        },
      },
    };
    const previousReasoning = {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Use lookup, then answer." }],
      content: [{ type: "reasoning_text", text: "The previous turn selected lookup." }],
      encrypted_content: "signed-reasoning-payload",
      status: "completed",
    };
    const assistant: AssistantMessage = {
      role: "assistant",
      api: "openai-codex-responses",
      provider: "openai-codex",
      model,
      content: [
        {
          type: "thinking",
          thinking: "Use lookup, then answer.",
          thinkingSignature: JSON.stringify(previousReasoning),
        },
        {
          type: "toolCall",
          id: "lookup-call|fc_lookup",
          name: "lookup",
          arguments: { key: "answer" },
        },
        {
          type: "text",
          text: "I will use the lookup result.",
          textSignature: JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" }),
        },
      ],
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 1,
    };
    const serializedInput = convertResponsesMessages(
      sdkModel,
      normalizeContext({
        systemPrompt: "Trusted assignment",
        messages: [
          assistant,
          {
            role: "toolResult",
            toolCallId: "lookup-call|fc_lookup",
            toolName: "lookup",
            content: [{ type: "text", text: "value=42" }],
            isError: false,
            timestamp: 2,
          },
          { role: "user", content: "Use that value.", timestamp: 3 },
        ],
      }),
      new Set(["openai-codex"]),
      { includeSystemPrompt: false },
    );
    const transportedBodies: unknown[] = [];
    const f = fixture({
      tools: [tool],
      transport: async (_url, init) => {
        transportedBodies.push(JSON.parse(init.body));
        return new Response(success(), { headers: { "content-type": "text/event-stream" } });
      },
    });

    await f.invoke(
      body({
        input: serializedInput,
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Look up a value",
            parameters: tool.function.parameters,
            strict: true,
          },
        ],
      }),
    );

    expect(transportedBodies).toHaveLength(1);
    expect(transportedBodies[0]).toMatchObject({ model, input: serializedInput });
    expect(serializedInput).toContainEqual(previousReasoning);
    expect(serializedInput).toContainEqual({
      type: "function_call",
      id: "fc_lookup",
      call_id: "lookup-call",
      name: "lookup",
      arguments: '{"key":"answer"}',
    });
    expect(serializedInput).toContainEqual({
      type: "function_call_output",
      call_id: "lookup-call",
      output: "value=42",
    });
  });

  it("rejects malformed SDK message and reasoning history fields before reserving", async () => {
    const invalidHistory = [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        phase: "private",
        content: [{ type: "output_text", text: "Prior answer", annotations: [] }],
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "Prior thought" }],
        content: [{ type: "output_text", text: "Not reasoning text" }],
        encrypted_content: "signed-reasoning-payload",
        status: "completed",
      },
    ];
    const f = fixture();

    for (const item of invalidHistory) {
      await expect(f.invoke(body({ input: [item] }))).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
    }

    expect(f.reservations).toHaveLength(0);
    expect(f.transportCalls()).toBe(0);
  });

  it("accepts a data-only Responses stream with its native event types", async () => {
    const stream = success().replace(/^event: [^\n]+\n/gm, "");
    const f = fixture({
      transport: async () =>
        new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    });
    expect((await f.invoke()).usage.total_tokens).toBe(60);
  });

  it.each([null, true])(
    "accepts the SDK function declaration with strict=%s and one completed argument value",
    async (strict) => {
      const tool = {
        type: "function" as const,
        function: {
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
        },
      };
      const call = {
        id: "call-1",
        type: "function_call",
        call_id: "call-1",
        name: "lookup",
        arguments: '{"key":"x"}',
      };
      const request = body({ tools: [{ type: "function", ...tool.function, strict }] });
      const stream =
        event({
          type: "response.created",
          response: { id: "response-1", model, status: "in_progress" },
        }) +
        event({
          type: "response.output_item.added",
          output_index: 0,
          item: { ...call, arguments: "" },
        }) +
        event({
          type: "response.function_call_arguments.delta",
          item_id: call.id,
          output_index: 0,
          delta: call.arguments,
        }) +
        event({
          type: "response.function_call_arguments.done",
          item_id: call.id,
          output_index: 0,
          arguments: call.arguments,
        }) +
        event({ type: "response.output_item.done", output_index: 0, item: call }) +
        event({
          type: "response.completed",
          response: {
            id: "response-1",
            model,
            status: "completed",
            output: [call],
            usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 },
          },
        });
      const f = fixture({
        tools: [tool],
        transport: async () =>
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      });
      expect((await f.invoke(request)).usage.total_tokens).toBe(60);
      expect(f.settlements).toMatchObject([{ outcome: "reported", chargedOutputTokens: 10 }]);
    },
  );
});

describe("SDK subscription request header parity", () => {
  it("preserves actual SDK user agent and clamped session pair with parent-owned credentials", async () => {
    let sdkHeaders: Headers | undefined;
    let sdkBody: unknown;
    let parentHeaders: Headers | undefined;
    let parentBody: unknown;
    let joined: Promise<void> | undefined;
    const sdkAccountId = "synthetic-worker-account";
    const sdkCredential = `${part({ alg: "none" })}.${part({ exp: 4_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: sdkAccountId } })}.synthetic-worker-signature`;
    const message = {
      type: "message",
      id: "message-1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
    };
    const response =
      event({
        type: "response.created",
        response: { id: "response-1", model, status: "in_progress" },
      }) +
      event({
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      }) +
      event({
        type: "response.content_part.added",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }) +
      event({
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: "Done",
      }) +
      event({ type: "response.output_item.done", output_index: 0, item: message }) +
      event({
        type: "response.completed",
        response: {
          id: "response-1",
          model,
          status: "completed",
          output: [message],
          usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 },
        },
      });
    const f = fixture({
      transport: async (_url, init) => {
        parentHeaders = new Headers(init.headers);
        parentBody = JSON.parse(init.body);
        return new Response(new TextEncoder().encode(response));
      },
    });
    const sdk = streamCodexResponses(
      sdkModel,
      normalizeContext({
        systemPrompt: "Trusted assignment",
        messages: [{ role: "user", content: "Investigate", timestamp: 1 }],
        tools: [],
      }),
      {
        apiKey: sdkCredential,
        sessionId: "sdk-session-" + "x".repeat(80),
        reasoningEffort: "high",
        serviceTier: "default",
        transport: "sse",
        maxRetries: 0,
        headers: { "x-worker-only": "must-not-reach-parent-transport" },
        fetch: async (_url, init) => {
          sdkHeaders = new Headers(init?.headers);
          const encoded = init?.body;
          const request =
            typeof encoded === "string"
              ? encoded
              : encoded instanceof Uint8Array && sdkHeaders.get("content-encoding") === "zstd"
                ? process
                    .getBuiltinModule("node:zlib")!
                    .zstdDecompressSync(encoded, { maxOutputLength: 16384 })
                    .toString("utf8")
                : undefined;
          if (!request) throw Error("Actual SDK request absent");
          sdkBody = JSON.parse(request);
          expect(sdkHeaders.get("session-id")).toHaveLength(64);
          expect(sdkBody).toMatchObject({ prompt_cache_key: sdkHeaders.get("session-id") });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                joined = f
                  .invoke(request, (chunk) => controller.enqueue(chunk))
                  .then(
                    () => controller.close(),
                    (error) => controller.error(error),
                  );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    const result = await sdk.result();
    await joined;
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).not.toBe("error");
    expect(result.content.some((part) => part.type === "text" && part.text === "Done")).toBe(true);
    expect(sdkHeaders).toBeDefined();
    expect(parentHeaders).toBeDefined();
    expect(parentHeaders!.get("user-agent")).toBe(sdkHeaders!.get("user-agent"));
    expect(parentHeaders!.get("session-id")).toBe(sdkHeaders!.get("session-id"));
    expect(parentHeaders!.get("x-client-request-id")).toBe(sdkHeaders!.get("x-client-request-id"));
    expect(parentHeaders!.get("session-id")).toHaveLength(64);
    expect(parentHeaders!.get("authorization")).toBe(`Bearer ${credential}`);
    expect(parentHeaders!.get("chatgpt-account-id")).toBe(accountId);
    expect(parentHeaders!.get("x-worker-only")).toBeNull();
    expect(parentBody).toEqual(sdkBody);
    expect(f.reservations).toHaveLength(1);
    expect(f.settlements).toMatchObject([{ outcome: "reported", transportDrained: true }]);
  });

  it.each(["absent", "empty"] as const)(
    "omits both session headers for an %s SDK cache key",
    async (mode) => {
      const f = fixture({
        transport: async (_url, init) => {
          const headers = new Headers(init.headers);
          expect(headers.get("user-agent")).toMatch(/^pi \(/);
          expect(headers.get("session-id")).toBeNull();
          expect(headers.get("x-client-request-id")).toBeNull();
          return new Response(success(), { headers: { "content-type": "text/event-stream" } });
        },
      });
      await f.invoke(body(mode === "empty" ? { prompt_cache_key: "" } : {}));
      expect(f.reservations).toHaveLength(1);
    },
  );

  it.each(["x".repeat(65), "line\nbreak", "line\rbreak", "null\0byte", "\u0100"])(
    "rejects a non-SDK session header before reservation: %j",
    async (prompt_cache_key) => {
      const f = fixture();
      await expect(f.invoke(body({ prompt_cache_key }))).rejects.toMatchObject({
        code: "REQUEST_MODEL_OR_OUTPUT_INVALID",
      });
      expect(f.reservations).toEqual([]);
      expect(f.transportCalls()).toBe(0);
    },
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const prefixFixture = (
  overrides: Partial<PiModelBrokerConfig> & Pick<PiModelBrokerConfig, "transport">,
) => {
  let calls = 0;
  const transport = overrides.transport;
  const f = fixture({
    ...overrides,
    transport: async (...args) => {
      calls++;
      return transport(...args);
    },
  });
  return { ...f, prefixTransportCalls: () => calls };
};

it.each([
  "complete",
  "one-byte fragments",
  "leading blank lines",
  "compact fields",
  "compact fragmented fields",
] as const)("validates and accounts subscription SSE without MIME: %s", async (fragmentation) => {
  const bytes = new TextEncoder().encode(
    (fragmentation === "leading blank lines" ? "\n\n" : "") +
      (fragmentation.startsWith("compact")
        ? success().replace(/^(event|data): /gm, "$1:")
        : success().replace(/^event:.*\n/gm, "")),
  );
  const f = prefixFixture({
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const size =
              fragmentation === "one-byte fragments" ||
              fragmentation === "compact fragmented fields"
                ? 1
                : bytes.length;
            for (let offset = 0; offset < bytes.length; offset += size)
              controller.enqueue(bytes.slice(offset, offset + size));
            controller.close();
          },
        }),
      ),
  });
  const receipt = await f.invoke();
  expect(receipt.usage).toMatchObject({ prompt_tokens: 50, completion_tokens: 10 });
  expect(f.prefixTransportCalls()).toBe(1);
  expect(Buffer.concat(f.chunks).toString()).toContain("bounded result");
  expect(f.settlements).toMatchObject([
    {
      outcome: "reported",
      transportDrained: true,
      chargedInputTokens: 50,
      chargedOutputTokens: 10,
    },
  ]);
});

const missingMimePrefixes = [
  [
    "JSON",
    new TextEncoder().encode('{"error":'),
    "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_JSON_PREFIX",
  ],
  [
    "HTML",
    new TextEncoder().encode("<!doctype html><html>"),
    "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_HTML_PREFIX",
  ],
  [
    "other text",
    new TextEncoder().encode("synthetic-proxy-response"),
    "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_OTHER_PREFIX",
  ],
] as const;

it.each([
  [
    "foreign model",
    success().replaceAll(`"model":"${model}"`, '"model":"foreign-model"'),
    "SSE_MODEL_REJECTED",
  ],
  [
    "missing terminal usage",
    success().replace(/event: response\.completed\ndata:.*\n\n$/, ""),
    "SSE_ACCOUNTING_REQUIRED",
  ],
  [
    "credential echo",
    success().replace('"delta":"bounded result"', `"delta":"${credential}"`),
    "CREDENTIAL_ECHO_REJECTED",
  ],
] as const)(
  "parses missing-MIME SSE candidates through validation (%s)",
  async (_name, data, code) => {
    const f = prefixFixture({
      transport: async () => new Response(new TextEncoder().encode(data)),
    });
    await expect(f.invoke()).rejects.toMatchObject({ code });
    expect(f.prefixTransportCalls()).toBe(1);
    expect(f.chunks).toHaveLength(0);
    expect(f.settlements).toMatchObject([
      { failureCode: code, outcome: "unknown", transportDrained: true },
    ]);
    expect(JSON.stringify(f.settlements)).not.toContain(data);
    expect(JSON.stringify(f.settlements)).not.toContain(credential);
  },
);

it("continues to reject a nonempty wrong MIME type", async () => {
  const f = prefixFixture({
    transport: async () => new Response(success(), { headers: { "content-type": "text/plain" } }),
  });
  await expect(f.invoke()).rejects.toMatchObject({ code: "TRANSPORT_RESPONSE_CONTENT_TYPE_TEXT" });
  expect(f.chunks).toHaveLength(0);
  expect(f.settlements).toMatchObject([
    {
      failureCode: "TRANSPORT_RESPONSE_CONTENT_TYPE_TEXT",
      outcome: "unknown",
      transportDrained: true,
    },
  ]);
});

it.each(missingMimePrefixes)(
  "retains only the bounded missing-MIME %s prefix category",
  async (_name, bytes, code) => {
    const f = prefixFixture({
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        ),
    });
    await expect(f.invoke()).rejects.toMatchObject({ code, message: code });
    expect(f.prefixTransportCalls()).toBe(1);
    expect(f.chunks).toHaveLength(0);
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({
      failureCode: code,
      outcome: "unknown",
      transportDrained: true,
      chargedInputTokens: 16_384,
      chargedOutputTokens: 64_000,
    });
    expect(JSON.stringify(f.settlements)).not.toContain(new TextDecoder().decode(bytes));
  },
);

it("retains EMPTY only for a completed empty missing-MIME body", async () => {
  const f = prefixFixture({
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      ),
  });
  await expect(f.invoke()).rejects.toMatchObject({
    code: "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_EMPTY",
  });
  expect(f.chunks).toHaveLength(0);
  expect(f.prefixTransportCalls()).toBe(1);
  expect(f.settlements[0]).toMatchObject({
    failureCode: "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING_EMPTY",
    outcome: "unknown",
    transportDrained: true,
  });
});

it("retains the fixed diagnostic when the initial missing-MIME body read fails", async () => {
  const f = prefixFixture({
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("synthetic private transport failure"));
          },
        }),
      ),
  });
  await expect(f.invoke()).rejects.toMatchObject({
    code: "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING",
    message: "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING",
  });
  expect(f.prefixTransportCalls()).toBe(1);
  expect(f.chunks).toHaveLength(0);
  expect(f.settlements).toMatchObject([
    { outcome: "unknown", failureCode: "TRANSPORT_RESPONSE_CONTENT_TYPE_MISSING" },
  ]);
  expect(JSON.stringify(f.settlements)).not.toContain("synthetic private transport failure");
});

it.each([
  ["malformed UTF-8", new Uint8Array([0xff, 0xfe]), "SSE_ACCOUNTING_REQUIRED"],
  ["whitespace only", new TextEncoder().encode(" \n\t"), "SSE_FRAME_INVALID"],
  ["malformed data marker", new TextEncoder().encode("data: {"), "SSE_ACCOUNTING_REQUIRED"],
  ["fragmented data marker", new TextEncoder().encode("da"), "SSE_ACCOUNTING_REQUIRED"],
  ["incomplete HTML marker", new TextEncoder().encode("<!doctype htm"), "SSE_ACCOUNTING_REQUIRED"],
  [
    "oversized first chunk",
    new Uint8Array(PI_WORKER_MAX_CHUNK_BYTES + 1).fill(123),
    "SSE_ACCOUNTING_REQUIRED",
  ],
] as const)(
  "replays indeterminate missing-MIME %s into the bounded parser",
  async (_name, bytes, code) => {
    const f = prefixFixture({
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        ),
    });
    await expect(f.invoke()).rejects.toMatchObject({
      code,
    });
    expect(f.chunks).toHaveLength(0);
    expect(f.prefixTransportCalls()).toBe(1);
    expect(f.settlements[0]).toMatchObject({
      failureCode: code,
      outcome: "unknown",
      transportDrained: true,
    });
  },
);

it("cancels and awaits a pending missing-MIME prefix read at its original deadline", async () => {
  const readEntered = deferred<void>();
  const cancelEntered = deferred<void>();
  const finishCancel = deferred<void>();
  const f = prefixFixture({
    deadlineMs: 100,
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            readEntered.resolve();
          },
          cancel() {
            cancelEntered.resolve();
            return finishCancel.promise;
          },
        }),
      ),
  });
  const pending = f.invoke();
  await readEntered.promise;
  await cancelEntered.promise;
  expect(f.settlements).toHaveLength(0);
  finishCancel.resolve();
  await expect(pending).rejects.toMatchObject({ code: "REQUEST_ABORTED" });
  expect(f.prefixTransportCalls()).toBe(1);
  expect(f.chunks).toHaveLength(0);
  expect(f.settlements).toHaveLength(1);
  expect(f.settlements[0]).toMatchObject({
    failureCode: "REQUEST_ABORTED",
    outcome: "unknown",
    transportDrained: true,
    chargedInputTokens: 16_384,
    chargedOutputTokens: 64_000,
  });
});
