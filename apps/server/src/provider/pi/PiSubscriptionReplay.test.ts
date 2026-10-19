import * as NodeZlib from "node:zlib";
import { Type } from "@earendil-works/pi-ai";
import { stream as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vite-plus/test";
import { accountId, credential, event, fixture, sdkModel } from "./PiSubscriptionTestKit.ts";
import { PI_WORKER_MAX_RESPONSE_BYTES } from "./PiWorkerProtocol.ts";
import {
  completed,
  created,
  declaredTool,
  done,
  parameters,
  privateErrorMessage,
  textEvents,
  textStream,
  toolMutations,
  toolStream,
  upstreamError,
  usage,
} from "./fixtures/subscription-sse/streams.ts";

type Wire = string | readonly Uint8Array[];
const bytes = (wire: Wire) => (typeof wire === "string" ? [new TextEncoder().encode(wire)] : wire);
const fragmented = (wire: string, width = 1) => {
  const encoded = new TextEncoder().encode(wire);
  return Array.from({ length: Math.ceil(encoded.length / width) }, (_, index) =>
    encoded.slice(index * width, (index + 1) * width),
  );
};
const response = (wire: Wire, mime: string | null = "text/event-stream") => {
  const chunks = bytes(wire);
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
    { headers: mime === null ? {} : { "content-type": mime } },
  );
};

// Always call the pinned SDK with an injected fetch. With a broker, forward its
// validated chunks into that same SDK; the request is the SDK's actual JSON body.
const replay = async (
  wire: Wire,
  throughBroker = false,
  tools = false,
  mime: string | null = "text/event-stream",
) => {
  let transportCalls = 0;
  let fetchCalls = 0;
  let brokerFailure: unknown;
  let joined: Promise<void> | undefined;
  let receipt: Awaited<ReturnType<ReturnType<typeof fixture>["invoke"]>> | undefined;
  const f = fixture({
    tools: tools ? [declaredTool] : [],
    transport: async () => {
      transportCalls++;
      return response(wire, mime);
    },
  });
  const providerEvents: unknown[] = [];
  const sdk = streamCodexResponses(
    sdkModel,
    normalizeContext({
      systemPrompt: "Trusted assignment",
      messages: [{ role: "user", content: "Investigate", timestamp: 1 }],
      ...(tools
        ? {
            tools: [
              {
                name: "lookup",
                description: declaredTool.function.description,
                parameters: Type.Unsafe<{ key: string }>(parameters),
              },
            ],
          }
        : {}),
    }),
    {
      apiKey: credential,
      reasoningEffort: "high",
      serviceTier: "default",
      transport: "sse",
      maxRetries: 0,
      onProviderStreamEvent: (value) => {
        providerEvents.push(value);
      },
      fetch: async (_url, init) => {
        fetchCalls++;
        if (!throughBroker) return response(wire);
        const encoded = init?.body;
        const request =
          typeof encoded === "string"
            ? encoded
            : encoded instanceof Uint8Array &&
                new Headers(init?.headers).get("content-encoding") === "zstd"
              ? NodeZlib.zstdDecompressSync(encoded, { maxOutputLength: 16384 }).toString("utf8")
              : undefined;
        if (request === undefined) throw Error("SDK request body absent");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              joined = f
                .invoke(request, (chunk) => controller.enqueue(chunk))
                .then(
                  (value) => {
                    receipt = value;
                    controller.close();
                  },
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
  const textDeltas: string[] = [];
  for await (const sdkEvent of sdk) {
    if (sdkEvent.type === "text_delta") textDeltas.push(sdkEvent.delta);
  }
  const result = await sdk.result();
  if (throughBroker) expect(joined).toBeDefined();
  await joined;
  expect(fetchCalls).toBe(1);
  expect(transportCalls).toBe(throughBroker ? 1 : 0);
  if (throughBroker) {
    expect(f.reservations).toHaveLength(1);
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]?.transportDrained).toBe(true);
  }
  return { result, brokerFailure, receipt, providerEvents, textDeltas, ...f };
};
const reported = (r: Awaited<ReturnType<typeof replay>>) => {
  expect(r.brokerFailure).toBeUndefined();
  expect(r.result.errorMessage).toBeUndefined();
  expect(r.result.usage).toMatchObject({ input: 45, cacheRead: 5, output: 10, totalTokens: 60 });
  expect(r.receipt?.usage).toMatchObject({
    prompt_tokens: 50,
    completion_tokens: 10,
    total_tokens: 60,
  });
  expect(r.settlements).toMatchObject([
    { outcome: "reported", chargedInputTokens: 50, chargedOutputTokens: 10 },
  ]);
};
const unknownRejection = (r: Awaited<ReturnType<typeof replay>>, code: string) => {
  expect(r.brokerFailure).toMatchObject({ code });
  expect(r.receipt).toBeUndefined();
  expect(r.result.stopReason).toBe("error");
  expect(r.settlements).toMatchObject([
    { outcome: "unknown", chargedInputTokens: 16384, chargedOutputTokens: 64000 },
  ]);
  expect(r.settlements[0]?.reportedUsage).toBeUndefined();
};

const compatibilityCases = [
  {
    name: "unknown non-tool event",
    wire:
      created +
      event({ type: "response.future_annotation", annotation: "synthetic" }) +
      textStream.slice(created.length),
  },
  {
    name: "extra non-tool fields",
    wire: textStream.replace('"delta":"bounded', '"future_annotation":true,"delta":"bounded'),
  },
  {
    name: "JSON type overrides SSE event identity",
    wire: textStream.replaceAll("event: response.", "event: synthetic."),
  },
  { name: "id control", wire: "id: synthetic-1\n" + textStream },
  { name: "retry control", wire: "retry: 1000\n" + textStream },
  {
    name: "multiline data",
    wire: textStream.replace(
      'data: {"type":"response.created",',
      'data: {"type":"response.created",\ndata: ',
    ),
  },
  { name: "DONE before completion", wire: done + textStream },
  { name: "DONE after completion", wire: textStream + done },
  ...["{", "not-json", '{"type":'].flatMap((payload) =>
    ["\n\n", ""].map((suffix) => ({
      name: `malformed postterminal JSON ${JSON.stringify(payload + suffix)}`,
      wire: textStream + `data: ${payload}` + suffix,
    })),
  ),
  {
    name: "postterminal event",
    wire: textStream + event({ type: "response.future_annotation" }),
  },
  {
    name: "refusal done",
    wire: textEvents("I cannot do that", true).join(""),
  },
];

describe("synthetic subscription SSE replay through pinned SDK", () => {
  it.each([false, true])("baseline through broker=%s", async (throughBroker) => {
    const r = await replay(textStream, throughBroker);
    expect(r.result.stopReason).toBe("stop");
    expect(r.result.content).toMatchObject([{ type: "text", text: "bounded result 🛰" }]);
    if (throughBroker) reported(r);
    else expect(r.result.usage.totalTokens).toBe(60);
  });

  it.each(compatibilityCases)("SDK oracle: $name", async ({ wire, name }) => {
    const r = await replay(wire);
    expect(r.result.stopReason).toBe("stop");
    expect(r.result.errorMessage).toBeUndefined();
    expect(r.result.usage.totalTokens).toBe(60);
    expect(r.result.content).toMatchObject([
      { type: "text", text: name === "refusal done" ? "I cannot do that" : "bounded result 🛰" },
    ]);
    if (name === "refusal done") expect(r.textDeltas).toEqual(["I cannot do that"]);
    if (name === "postterminal event") expect(r.providerEvents).toHaveLength(textEvents().length);
  });

  it.each(compatibilityCases)("broker/SDK parity: $name", async ({ wire, name }) => {
    const r = await replay(wire, true);
    reported(r);
    expect(r.result.content).toMatchObject([
      { type: "text", text: name === "refusal done" ? "I cannot do that" : "bounded result 🛰" },
    ]);
    if (name === "refusal done") expect(r.textDeltas).toEqual(["I cannot do that"]);
  });

  it.each(["error", "response.failed"] as const)(
    "upstream %s fails without usage or private receipt diagnostics",
    async (kind) => {
      const wire = upstreamError(kind);
      const oracle = await replay(wire);
      expect(oracle.result.stopReason).toBe("error");
      expect(oracle.result.errorMessage).toContain(privateErrorMessage);
      expect(oracle.result.usage.totalTokens).toBe(0);
      const r = await replay(wire, true);
      unknownRejection(r, "SSE_UPSTREAM_ERROR");
      expect(JSON.stringify(r.settlements)).not.toContain(privateErrorMessage);
      expect(r.result.errorMessage).not.toContain(privateErrorMessage);
    },
  );

  it.each([null, "text/plain", "application/json", "text/html"])(
    "replays valid SSE with MIME %s",
    async (mime) => {
      reported(await replay(fragmented(textStream, 7), true, false, mime));
    },
  );

  it.each(
    [
      { reportedUsage: usage, input: 16384, output: 2048 },
      {
        reportedUsage: { ...usage, input_tokens: 20000, output_tokens: 3000, total_tokens: 23000 },
        input: 20000,
        output: 3000,
      },
    ].flatMap((test) => [true, false].map((started) => ({ ...test, started }))),
  )(
    "retains validated upstream failure usage and existing maximum charges (%#)",
    async ({ reportedUsage, input, output, started }) => {
      const r = await replay(
        upstreamError("response.failed", reportedUsage).slice(started ? 0 : created.length),
        true,
      );
      expect(r.brokerFailure).toMatchObject({ code: "SSE_UPSTREAM_ERROR" });
      expect(r.result.stopReason).toBe("error");
      expect(r.settlements).toMatchObject([
        {
          outcome: "failed",
          reportedModel: sdkModel.id,
          chargedInputTokens: input,
          chargedOutputTokens: output,
          reportedUsage: {
            prompt_tokens: reportedUsage.input_tokens,
            completion_tokens: reportedUsage.output_tokens,
            total_tokens: reportedUsage.total_tokens,
          },
          failureCode: "SSE_UPSTREAM_ERROR",
          transportDrained: true,
        },
      ]);
      expect(JSON.stringify(r.settlements)).not.toContain(privateErrorMessage);
      expect(Buffer.concat(r.chunks).toString()).not.toContain(privateErrorMessage);
    },
  );

  it.each([
    { ...usage, total_tokens: 59 },
    { ...usage, input_tokens_details: { cached_tokens: -1 } },
    { ...usage, input_tokens_details: { cached_tokens: 51 } },
    { ...usage, output_tokens_details: { reasoning_tokens: 11 } },
    { ...usage, output_tokens_details: { reasoning_tokens: "invalid" } },
  ])("rejects malformed supplied upstream failure usage (%#)", async (invalid) => {
    unknownRejection(
      await replay(upstreamError("response.failed", invalid), true),
      "SSE_USAGE_INVALID",
    );
  });

  it("refusal delta becomes text without duplicating refusal done", async () => {
    const wire = textEvents("I cannot do that", true).join("");
    const r = await replay(wire, true);
    reported(r);
    expect(r.result.content).toMatchObject([{ type: "text", text: "I cannot do that" }]);
  });

  it("interleaves controls/comments and splits every UTF-8 byte in the SDK oracle", async () => {
    const wire = textEvents()
      .map((frame) => ": synthetic 🟢\nid: synthetic\nretry: 1000\n" + frame)
      .join("");
    const r = await replay(fragmented(wire));
    expect(r.result.stopReason).toBe("stop");
    expect(r.result.content).toMatchObject([{ type: "text", text: "bounded result 🛰" }]);
    expect(r.result.usage.totalTokens).toBe(60);
  });

  it("comments, line boundaries, and fragmented UTF-8 retain broker parity", async () => {
    const wire =
      textEvents()
        .map((frame) => ": synthetic 🟢\n" + frame)
        .join("") + ": trailing comment\n";
    const r = await replay(fragmented(wire), true);
    reported(r);
    expect(r.result.content).toMatchObject([{ type: "text", text: "bounded result 🛰" }]);
    expect(Buffer.concat(r.chunks).toString()).not.toContain("synthetic 🟢");
  });

  it("records pinned SDK LF-only multi-frame CRLF limitation; broker normalizes it", async () => {
    const wire = fragmented(textStream.replaceAll("\n", "\r\n"));
    const oracle = await replay(wire);
    expect(oracle.result.stopReason).toBe("error");
    expect(oracle.result.errorMessage).toContain("Invalid Codex SSE JSON");
    reported(await replay(wire, true));
  });

  it("DONE without a terminal response never reports usage", async () => {
    const wire = created + done;
    const oracle = await replay(wire);
    expect(oracle.result.stopReason).toBe("error");
    expect(oracle.result.errorMessage).toContain("before a terminal response");
    unknownRejection(await replay(wire, true), "SSE_ACCOUNTING_REQUIRED");
  });
});

describe("synthetic tool identity and reconciliation baseline", () => {
  const accepted = new Set([
    "valid",
    "namespace",
    "punctuation",
    "done-only-arguments",
    "no-arguments-done",
    "missing-terminal-call",
    "extra-terminal-call",
    "duplicate-terminal-call",
    "swapped-terminal-calls",
    "changed-terminal-arguments",
  ]);
  it.each(toolMutations)("SDK oracle and current broker: %s", async (mutation) => {
    const wire = toolStream(mutation);
    const oracle = await replay(wire, false, true);
    if (mutation === "unfinished" || mutation === "duplicate-added") {
      expect(oracle.result.stopReason).toBe("error");
      expect(oracle.result.errorMessage).toContain("unfinished tool call");
    } else {
      expect(oracle.result.stopReason).toBe("toolUse");
      expect(oracle.result.usage.totalTokens).toBe(60);
    }
    if (mutation === "punctuation" || mutation === "namespace")
      expect(oracle.result.content).toMatchObject([
        {
          type: "toolCall",
          id: mutation === "punctuation" ? "call.a:b/c+1=2-3_4|fc_1" : "call-1|fc_1",
          name: "lookup",
          arguments: { key: "A" },
          ...(mutation === "namespace" ? { namespace: "fixture" } : {}),
        },
      ]);
    if (mutation === "undeclared-tool")
      expect(oracle.result.content).toMatchObject([{ type: "toolCall", name: "delete_project" }]);
    // Only live calls supply executable tool output; terminal calls are validated independently.
    const r = await replay(wire, true, true);
    if (accepted.has(mutation)) {
      reported(r);
      expect(r.result.content.filter((part) => part.type === "toolCall")).toMatchObject([
        {
          id: mutation === "punctuation" ? "call.a:b/c+1=2-3_4|fc_1" : "call-1|fc_1",
          name: "lookup",
          arguments: { key: "A" },
          ...(mutation === "namespace" ? { namespace: "fixture" } : {}),
        },
        ...(mutation === "swapped-terminal-calls"
          ? [{ id: "call-2|fc_2", name: "lookup", arguments: { key: "B" } }]
          : []),
      ]);
    } else unknownRejection(r, "SSE_TOOL_INVALID");
  });
});

describe("retained safety controls on replayed streams", () => {
  it.each([credential, accountId])(
    "scans postterminal raw bytes across reads (%#)",
    async (secret) => {
      // A comment is otherwise accepted after terminal usage. Omit its final LF so
      // this specifically proves raw trailing-byte scanning, before line parsing.
      reported(await replay(textStream + ": harmless trailing comment\n", true));
      const r = await replay([...bytes(textStream), ...fragmented(": " + secret, 7)], true);
      expect(r.brokerFailure).toMatchObject({ code: "CREDENTIAL_ECHO_REJECTED" });
      expect(r.receipt).toBeUndefined();
      expect(Buffer.concat(r.chunks).toString()).not.toContain(secret);
      expect(JSON.stringify(r.settlements)).not.toContain(secret);
    },
  );

  it.each([credential, accountId])(
    "scans escaped echo in unknown non-tool field before rejecting its shape (%#)",
    async (secret) => {
      const escaped = [...secret]
        .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
      const wire = textStream.replace(
        '"delta":"bounded',
        `"future_annotation":"${escaped}","delta":"bounded`,
      );
      unknownRejection(await replay(fragmented(wire, 7), true), "CREDENTIAL_ECHO_REJECTED");
    },
  );

  it.each([credential, accountId])(
    "scans escaped echoes in ignored trailing JSON, including EOF (%#)",
    async (secret) => {
      const escaped = [...secret]
        .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
      for (const payload of [
        `{"type":"response.future_annotation","value":"${escaped}"}`,
        `"${escaped}"`,
        `{"${escaped}":"ignored"}`,
      ]) {
        for (const suffix of ["\n\n", ""]) {
          const r = await replay(fragmented(textStream + `data: ${payload}` + suffix, 7), true);
          expect(r.brokerFailure).toMatchObject({ code: "CREDENTIAL_ECHO_REJECTED" });
          expect(r.settlements).toMatchObject([
            { outcome: "failed", reportedUsage: { total_tokens: 60 } },
          ]);
          expect(Buffer.concat(r.chunks).toString()).not.toContain(secret);
        }
      }
    },
  );

  it("ignores trailing output, tools and replacement accounting after the first terminal", async () => {
    const trailing =
      event({ type: "response.output_text.delta", delta: "late-output" }) +
      toolStream("undeclared-tool") +
      completed([], { input_tokens: -1 });
    const r = await replay(fragmented(textStream + trailing, 7), true);
    reported(r);
    expect(r.result.content).toMatchObject([{ type: "text", text: "bounded result 🛰" }]);
    expect(Buffer.concat(r.chunks).toString()).not.toContain("late-output");
    expect(Buffer.concat(r.chunks).toString()).not.toContain("delete_project");
  });

  it("bounds accumulated arguments before live finalization", async () => {
    const added = event({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "fc_1", type: "function_call", call_id: "call-1", name: "lookup", arguments: "" },
    });
    const delta = event({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: "fc_1",
      delta: "x".repeat(8192),
    });
    unknownRejection(
      await replay(created + added + delta.repeat(3), true, true),
      "SSE_TOOL_INVALID",
    );
  });

  it.each(["[]", "null", "{", '{"key":"A"'])(
    "independently rejects invalid terminal-only arguments %s",
    async (argumentsText) => {
      unknownRejection(
        await replay(
          created +
            completed([
              {
                type: "function_call",
                name: "lookup",
                call_id: "opaque.id:1",
                arguments: argumentsText,
              },
            ]),
          true,
          true,
        ),
        "SSE_TOOL_INVALID",
      );
    },
  );

  it("never creates an executable call from a terminal-only tool", async () => {
    const r = await replay(
      created +
        completed([
          { type: "function_call", name: "lookup", call_id: "opaque.id:1", arguments: "{}" },
        ]),
      true,
      true,
    );
    reported(r);
    expect(r.result.content.filter((part) => part.type === "toolCall")).toEqual([]);
  });

  it("rejects unadvertised terminal-only tools", async () => {
    unknownRejection(
      await replay(
        created +
          completed([
            {
              type: "function_call",
              name: "delete_project",
              call_id: "opaque.id:1",
              arguments: "{}",
            },
          ]),
        true,
        true,
      ),
      "SSE_TOOL_INVALID",
    );
  });

  it.each([
    ["negative", { input_tokens: -1, output_tokens: 10, total_tokens: 9 }, "SSE_USAGE_INVALID"],
    [
      "inconsistent",
      { input_tokens: 50, output_tokens: 10, total_tokens: 59 },
      "SSE_USAGE_INVALID",
    ],
    ["missing", {}, "SSE_USAGE_INVALID"],
  ] as const)("rejects %s terminal usage", async (_name, usage, code) => {
    unknownRejection(await replay(created + completed([], usage), true), code);
  });

  it("does not accept comments or output as a substitute for terminal usage", async () => {
    unknownRejection(
      await replay(textEvents().slice(0, -1).join("") + ": no terminal\n", true),
      "SSE_ACCOUNTING_REQUIRED",
    );
  });

  it("enforces kept-byte budget on otherwise ignorable trailing comments", async () => {
    const wire =
      textStream +
      ": " +
      "x".repeat(PI_WORKER_MAX_RESPONSE_BYTES - Buffer.byteLength(textStream) - 3) +
      "\n";
    reported(await replay(fragmented(wire, 16384), true));
    const r = await replay(fragmented(wire + "x", 16384), true);
    expect(r.brokerFailure).toMatchObject({ code: "RESPONSE_BYTE_LIMIT" });
    expect(r.receipt).toBeUndefined();
    expect(r.chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBeLessThanOrEqual(
      PI_WORKER_MAX_RESPONSE_BYTES,
    );
  });
});
