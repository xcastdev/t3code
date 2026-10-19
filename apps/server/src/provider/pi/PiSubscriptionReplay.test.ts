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
} from "./fixtures/subscription-sse/streams.ts";

type Wire = string | readonly Uint8Array[];
const bytes = (wire: Wire) => (typeof wire === "string" ? [new TextEncoder().encode(wire)] : wire);
const fragmented = (wire: string, width = 1) => {
  const encoded = new TextEncoder().encode(wire);
  return Array.from({ length: Math.ceil(encoded.length / width) }, (_, index) =>
    encoded.slice(index * width, (index + 1) * width),
  );
};
const response = (wire: Wire) => {
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
    { headers: { "content-type": "text/event-stream" } },
  );
};

// Always call the pinned SDK with an injected fetch. With a broker, forward its
// validated chunks into that same SDK; the request is the SDK's actual JSON body.
const replay = async (wire: Wire, throughBroker = false, tools = false) => {
  let transportCalls = 0;
  let fetchCalls = 0;
  let brokerFailure: unknown;
  let joined: Promise<void> | undefined;
  let receipt: Awaited<ReturnType<ReturnType<typeof fixture>["invoke"]>> | undefined;
  const f = fixture({
    tools: tools ? [declaredTool] : [],
    transport: async () => {
      transportCalls++;
      return response(wire);
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
    code: "SSE_FRAME_INVALID",
  },
  {
    name: "extra non-tool fields",
    wire: textStream.replace('"delta":"bounded', '"future_annotation":true,"delta":"bounded'),
    code: "SSE_FRAME_INVALID",
  },
  {
    name: "JSON type overrides SSE event identity",
    wire: textStream.replaceAll("event: response.", "event: synthetic."),
    code: "SSE_FRAME_INVALID",
  },
  { name: "id control", wire: "id: synthetic-1\n" + textStream, code: "SSE_FRAME_INVALID" },
  { name: "retry control", wire: "retry: 1000\n" + textStream, code: "SSE_FRAME_INVALID" },
  {
    name: "multiline data",
    wire: textStream.replace(
      'data: {"type":"response.created",',
      'data: {"type":"response.created",\ndata: ',
    ),
    code: "SSE_FRAME_INVALID",
  },
  { name: "DONE before completion", wire: done + textStream, code: "SSE_ACCOUNTING_REQUIRED" },
  { name: "DONE after completion", wire: textStream + done, code: "SSE_FRAME_INVALID" },
  {
    name: "postterminal event",
    wire: textStream + event({ type: "response.future_annotation" }),
    code: "SSE_FRAME_INVALID",
  },
  {
    name: "refusal done",
    wire: textEvents("I cannot do that", true).join(""),
    code: "SSE_FRAME_INVALID",
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

  // S1a observations only: these rejections expose parity gaps, not S1b policy.
  it.each(compatibilityCases)(
    "current broker parity gap: $name -> $code",
    async ({ wire, code, name }) => {
      const r = await replay(wire, true);
      expect(r.brokerFailure).toMatchObject({ code });
      expect(r.receipt).toBeUndefined();
      expect(r.settlements[0]?.outcome).toBe(
        ["DONE after completion", "postterminal event"].includes(name) ? "failed" : "unknown",
      );
      if (r.settlements[0]?.outcome === "unknown") unknownRejection(r, code);
    },
  );

  it.each(["error", "response.failed"] as const)(
    "upstream %s fails without usage or private receipt diagnostics",
    async (kind) => {
      const wire = upstreamError(kind);
      const oracle = await replay(wire);
      expect(oracle.result.stopReason).toBe("error");
      expect(oracle.result.errorMessage).toContain(privateErrorMessage);
      expect(oracle.result.usage.totalTokens).toBe(0);
      const r = await replay(wire, true);
      // Current classification gap: fail closed as an invalid frame, not an upstream error.
      unknownRejection(r, "SSE_FRAME_INVALID");
      expect(JSON.stringify(r.settlements)).not.toContain(privateErrorMessage);
      expect(r.result.errorMessage).not.toContain(privateErrorMessage);
    },
  );

  it("refusal delta becomes text; removing the unsupported done event gives broker parity", async () => {
    const wire = textEvents("I cannot do that", true)
      .filter((frame) => !frame.startsWith("event: response.refusal.done\n"))
      .join("");
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
  const accepted = new Set(["valid", "namespace", "done-only-arguments", "no-arguments-done"]);
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
    // Terminal output reconciliation below records today's behavior. In particular,
    // missing/extra/duplicate/swapped terminal sets do not prescribe future policy.
    const r = await replay(wire, true, true);
    if (accepted.has(mutation)) {
      reported(r);
      expect(r.result.content.filter((part) => part.type === "toolCall")).toMatchObject([
        {
          id: "call-1|fc_1",
          name: "lookup",
          arguments: { key: "A" },
          ...(mutation === "namespace" ? { namespace: "fixture" } : {}),
        },
      ]);
    } else
      unknownRejection(r, mutation === "punctuation" ? "SSE_FRAME_INVALID" : "SSE_TOOL_INVALID");
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
