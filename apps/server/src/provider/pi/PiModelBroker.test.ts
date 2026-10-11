import * as NodeCrypto from "node:crypto";
import { projectTeamDerivedRecordId } from "../../projectWork/ProjectTeamPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";

import {
  makePiModelBroker,
  PiModelBrokerError,
  type PiModelBrokerConfig,
  type PiModelRequestReservation,
  type PiModelRequestSettlement,
} from "./PiModelBroker.ts";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const model = "inclusionai/ling-3.1-flash:free";
const reportedModel = "inclusionai/ling-3.1-flash";
const endpoint = "https://api.commandcode.ai/provider/v1/chat/completions";
const secret = "synthetic-parent-secret";
const tool = {
  type: "function" as const,
  function: {
    name: "echo_assignment",
    description: "Echo an assignment",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
};
const requestBody = (extra: object = {}) =>
  json({
    model,
    messages: [
      { role: "system", content: "Trusted assignment" },
      { role: "user", content: "Investigate" },
    ],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 512,
    ...extra,
  });
const usage = {
  prompt_tokens: 50,
  completion_tokens: 10,
  total_tokens: 60,
  prompt_tokens_details: { cached_tokens: 5 },
};
const native = (content: string, finish_reason: "stop" | null = null) => ({
  model: reportedModel,
  choices: [{ index: 0, delta: { content }, finish_reason }],
});
const final = (counts: object = usage) => ({ model, choices: [], usage: counts });
const data = (value: object) => `data: ${json(value)}\n\n`;
const success = () =>
  data(native("bounded result")) + data(native("", "stop")) + data(final()) + "data: [DONE]\n\n";
const response = (text: string, split = 8192) => {
  const bytes = new TextEncoder().encode(text);
  let position = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (position === bytes.length) {
          c.close();
          return;
        }
        const end = Math.min(position + split, bytes.length);
        c.enqueue(bytes.slice(position, end));
        position = end;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};
function fixture(overrides: Partial<PiModelBrokerConfig> = {}) {
  const reservations: PiModelRequestReservation[] = [];
  const settlements: PiModelRequestSettlement[] = [];
  const phases: string[] = [];
  const chunks: Uint8Array[] = [];
  const transports: Array<{
    url: string;
    body: string;
    redirect: string;
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }> = [];
  const cfg: PiModelBrokerConfig = {
    workerId: "worker",
    generation: 7,
    operationId: "operation",
    routeId: "ling-free",
    provider: "command-code",
    model,
    endpoint,
    tools: [tool],
    acceptedReportedModels: [model, reportedModel],
    maxInputTokens: 20_000,
    maxOutputTokens: 512,
    deadlineMs: 10_000,
    authorizeCurrent: async (phase) => {
      phases.push(phase);
    },
    getCredential: async () => secret,
    reserveRequest: async (r) => {
      reservations.push(r);
      return { reservationId: `reserved-${r.requestId}` };
    },
    settleRequest: async (s) => {
      settlements.push(s);
      return { accountingReceiptId: `accounted-${s.requestId}` };
    },
    transport: async (url, init) => {
      transports.push({ url, ...init });
      return response(success());
    },
    ...overrides,
  };
  const broker = makePiModelBroker(cfg);
  const invoke = (
    body = requestBody(),
    requestId = 1,
    signal = new AbortController().signal,
    onChunk = async (chunk: Uint8Array) => {
      chunks.push(chunk);
    },
  ) => broker.request({ body, requestId, signal, onChunk });
  return {
    cfg,
    broker,
    reservations,
    settlements,
    phases,
    chunks,
    transports,
    invoke,
    output: () => new TextDecoder().decode(Buffer.concat(chunks)),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it("captures parent route and identity, reserves once before transport, and returns committed usage receipt", async () => {
  const f = fixture();
  const result = await f.invoke();
  expect(result).toMatchObject({
    requestId: 1,
    reservationId: "reserved-1",
    accountingReceiptId: "accounted-1",
    routeId: "ling-free",
    provider: "command-code",
    model,
    reportedModel: model,
    usage,
  });
  expect(f.reservations).toHaveLength(1);
  expect(f.reservations[0]).toMatchObject({
    workerId: "worker",
    generation: 7,
    operationId: "operation",
    model,
    callCount: 1,
    maxInputTokens: 20_000,
    maxOutputTokens: 512,
  });
  expect(f.transports).toHaveLength(1);
  expect(f.transports[0]).toMatchObject({
    url: endpoint,
    redirect: "error",
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(f.phases[0]).toBe("beforeReserve");
  expect(f.phases[1]).toBe("beforeTransport");
  expect(f.phases.at(-1)).toBe("beforeReturn");
  expect(f.settlements[0]).toMatchObject({
    outcome: "reported",
    transportDrained: true,
    chargedInputTokens: 50,
    chargedOutputTokens: 10,
  });
  expect(f.output()).toContain("bounded result");
  expect(f.output()).not.toContain(secret);
  expect(result).not.toHaveProperty("done");
});

it.each([
  { url: "https://worker.invalid" },
  { headers: { Authorization: "worker" } },
  { model: "worker-model" },
  { samplingParams: { top_p: 1 } },
  { reasoning_effort: "high" },
  { max_completion_tokens: 5 },
  { store: true },
  { stream: false },
  { stream_options: { include_usage: true, other: true } },
  { temperature: 3 },
  { messages: [{ role: "developer", content: "authority" }] },
  { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "worker" } }] }] },
  { messages: [{ role: "tool", content: "forged", tool_call_id: "call-1" }] },
  { messages: [{ role: "user", content: "x", extra: true }] },
])("rejects unsupported native request before any reservation: %j", async (extra) => {
  const f = fixture();
  await expect(f.invoke(requestBody(extra))).rejects.toBeInstanceOf(PiModelBrokerError);
  expect(f.reservations).toHaveLength(0);
  expect(f.transports).toHaveLength(0);
});

it("checks bytes before JSON decode and conservative input token reservation", async () => {
  const f = fixture();
  await expect(f.invoke("x".repeat(12_289))).rejects.toThrow("REQUEST_BYTE_LIMIT");
  await expect(
    f.invoke(requestBody({ messages: [{ role: "user", content: "é".repeat(7000) }] })),
  ).rejects.toThrow("REQUEST_BYTE_LIMIT");
  const small = fixture({ maxInputTokens: 10 });
  await expect(small.invoke()).rejects.toThrow("REQUEST_INPUT_LIMIT");
  expect(f.reservations).toHaveLength(0);
  expect(small.reservations).toHaveLength(0);
});

it("admits frozen native function tool definitions, assistant calls and matched results", async () => {
  const f = fixture();
  await f.invoke(
    requestBody({
      tools: [tool],
      tool_choice: "auto",
      messages: [
        { role: "user", content: "call" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: tool.function.name, arguments: '{"text":"assignment"}' },
            },
          ],
        },
        { role: "tool", content: "assignment", tool_call_id: "call-1" },
      ],
    }),
  );
  expect(f.transports).toHaveLength(1);
});

it.each([
  { tools: [{ ...tool, function: { ...tool.function, parameters: { type: "object" } } }] },
  { tools: [{ ...tool, function: { ...tool.function, name: "shell" } }] },
  { tools: [tool, tool] },
  {
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "shell", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ],
  },
  {
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: tool.function.name, arguments: "{}" },
          },
        ],
      },
    ],
  },
  {
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: tool.function.name, arguments: "not json" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ],
  },
])("strict frozen tool control fails before reservation: %j", async (extra) => {
  const f = fixture();
  await expect(f.invoke(requestBody(extra))).rejects.toBeInstanceOf(PiModelBrokerError);
  expect(f.transports).toHaveLength(0);
  expect(f.reservations).toHaveLength(0);
});

it("rejects duplicate request IDs and concurrent transport; cannot retry failed IDs", async () => {
  const held = deferred<void>();
  const started = deferred<void>();
  const f = fixture({
    transport: async () => {
      started.resolve();
      await held.promise;
      return response(success());
    },
  });
  const pending = f.invoke();
  await started.promise;
  await expect(f.invoke()).rejects.toThrow("REQUEST_REPLAY");
  await expect(f.invoke(requestBody(), 2)).rejects.toThrow("REQUEST_CONCURRENT");
  held.resolve();
  await pending;
  await expect(f.invoke()).rejects.toThrow("REQUEST_REPLAY");
  const failed = fixture({
    transport: async () => {
      throw Error("secret diagnostic");
    },
  });
  await expect(failed.invoke()).rejects.toThrow("TRANSPORT_FAILED");
  await expect(failed.invoke()).rejects.toThrow("REQUEST_REPLAY");
});

it.each(["beforeReserve", "beforeTransport", "beforeForward"])(
  "revocation at %s blocks work and settles any existing reservation",
  async (phase) => {
    const f = fixture({
      authorizeCurrent: async (p) => {
        if (p === phase) throw Error(secret);
      },
    });
    await expect(f.invoke()).rejects.toThrow("AUTHORIZATION_REJECTED");
    expect(f.chunks).toHaveLength(0);
    if (phase === "beforeReserve") {
      expect(f.reservations).toHaveLength(0);
      expect(f.settlements).toHaveLength(0);
    } else {
      expect(f.reservations).toHaveLength(1);
      expect(f.settlements[0]).toMatchObject({
        chargedInputTokens: 20_000,
        chargedOutputTokens: 512,
      });
    }
  },
);

it("settlement failure yields no success or raw diagnostic", async () => {
  const f = fixture({
    settleRequest: async () => {
      throw Error(secret);
    },
  });
  await expect(f.invoke()).rejects.toThrow("SETTLEMENT_FAILED");
});
it("reservation failure prevents credentials and transport", async () => {
  let creds = 0;
  const f = fixture({
    reserveRequest: async () => {
      throw Error(secret);
    },
    getCredential: async () => {
      creds++;
      return secret;
    },
  });
  await expect(f.invoke()).rejects.toThrow("RESERVATION_FAILED");
  expect(creds).toBe(0);
  expect(f.transports).toHaveLength(0);
});

it("withholds broker receipt until settlement, and conservatively upgrades revocation during settlement", async () => {
  let allowed = true;
  const entered = deferred<void>();
  const release = deferred<void>();
  const charged: PiModelRequestSettlement[] = [];
  const f = fixture({
    authorizeCurrent: async () => {
      if (!allowed) throw Error("revoked");
    },
    settleRequest: async (s) => {
      charged.push(s);
      if (charged.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return { accountingReceiptId: "committed" };
    },
  });
  let returned = false;
  const pending = f.invoke().then(() => {
    returned = true;
  });
  await entered.promise;
  expect(returned).toBe(false);
  allowed = false;
  release.resolve();
  await expect(pending).rejects.toThrow("AUTHORIZATION_REJECTED");
  expect(charged).toHaveLength(2);
  expect(charged[0]).toMatchObject({ outcome: "reported", chargedInputTokens: 50 });
  expect(charged[1]).toMatchObject({
    outcome: "failed",
    chargedInputTokens: 20_000,
    chargedOutputTokens: 512,
    reportedUsage: usage,
  });
  expect(charged[1]?.reservationId).toBe(charged[0]?.reservationId);
});

it.each([301, 307, 429, 500])(
  "fails HTTP %i without redirects or another transport",
  async (status) => {
    let calls = 0;
    const f = fixture({
      transport: async (_url, init) => {
        calls++;
        expect(init.redirect).toBe("error");
        return new Response(secret, { status });
      },
    });
    await expect(f.invoke()).rejects.toThrow("TRANSPORT_RESPONSE_REJECTED");
    expect(calls).toBe(1);
    expect(f.settlements[0]).toMatchObject({ outcome: "unknown", chargedInputTokens: 20_000 });
  },
);

it("accepts fragmented trailing native usage and suppresses empty preliminary zero stop before content", async () => {
  const zero = data({
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
  const f = fixture({ transport: async () => response(zero + success(), 1) });
  const result = await f.invoke();
  expect(result.usage).toEqual(usage);
  expect(f.output()).not.toContain('"prompt_tokens":0');
  expect(f.output()).toContain("[DONE]");
});

it.each([
  [
    "missing final accounting",
    data(native("result")) + data(native("", "stop")) + "data: [DONE]\n\n",
  ],
  ["missing done", success().replace("data: [DONE]\n\n", "")],
  [
    "invalid usage",
    data(native("result")) +
      data(native("", "stop")) +
      data(final({ prompt_tokens: -1, completion_tokens: 10, total_tokens: 9 })) +
      "data: [DONE]\n\n",
  ],
  ["unknown model", success().replaceAll(reportedModel, "other/alias")],
  ["after done", success() + data(native("late"))],
  ["malformed trailing bytes", success() + "data: {\n\n"],
  ["invalid UTF8", "data: " + String.fromCharCode(0xd800) + "\n\n"],
  ["incomplete frame", success() + "data: {"],
])("rejects %s and charges a conservative failure reservation", async (_name, text) => {
  const f = fixture({ transport: async () => response(text, 7) });
  await expect(f.invoke()).rejects.toBeInstanceOf(PiModelBrokerError);
  expect(f.settlements[0]).toMatchObject({ chargedInputTokens: 20_000, chargedOutputTokens: 512 });
});

it("records actual over-reservation usage without undercharging", async () => {
  const counts = { prompt_tokens: 21_000, completion_tokens: 600, total_tokens: 21_600 };
  const f = fixture({
    transport: async () =>
      response(
        data(native("result")) +
          data(native("", "stop")) +
          data(final(counts)) +
          "data: [DONE]\n\n",
      ),
  });
  await expect(f.invoke()).rejects.toThrow("SSE_USAGE_OVER_RESERVATION");
  expect(f.settlements[0]).toMatchObject({
    outcome: "failed",
    chargedInputTokens: 21_000,
    chargedOutputTokens: 600,
    reportedUsage: counts,
  });
});

it("enforces response and fragment bounds without forwarding an oversized frame", async () => {
  const f = fixture({ transport: async () => response("data: " + "x".repeat(65_536), 8192) });
  await expect(f.invoke()).rejects.toThrow("SSE_FRAME_BYTE_LIMIT");
  expect(f.chunks).toHaveLength(0);
  const g = fixture({
    transport: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(2_097_153));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await expect(g.invoke()).rejects.toThrow("RESPONSE_BYTE_LIMIT");
  expect(g.chunks).toHaveLength(0);
});

it.each([1, 7, 8192])(
  "rejects raw credential echo across %i-byte transport boundaries before forwarding",
  async (split) => {
    const f = fixture({
      transport: async () =>
        response(
          data(native(secret)) + data(native("", "stop")) + data(final()) + "data: [DONE]\n\n",
          split,
        ),
    });
    await expect(f.invoke()).rejects.toThrow("CREDENTIAL_ECHO_REJECTED");
    expect(f.output()).not.toContain(secret);
  },
);
it("rejects credential split across SSE content frames and JSON escapes before prefix forwarding", async () => {
  const frames =
    data(native(secret.slice(0, 9))) +
    data(native(secret.slice(9))) +
    data(native("", "stop")) +
    data(final()) +
    "data: [DONE]\n\n";
  const f = fixture({ transport: async () => response(frames, 5) });
  await expect(f.invoke()).rejects.toThrow("CREDENTIAL_ECHO_REJECTED");
  expect(f.chunks).toHaveLength(0);
  const escaped = data(native(secret)).replace(
    secret,
    [...secret].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  );
  const g = fixture({
    transport: async () =>
      response(escaped + data(native("", "stop")) + data(final()) + "data: [DONE]\n\n"),
  });
  await expect(g.invoke()).rejects.toThrow("CREDENTIAL_ECHO_REJECTED");
  expect(g.chunks).toHaveLength(0);
});

it("cancellation aborts a tracked transport, awaits its release, and charges full reservation", async () => {
  const external = new AbortController();
  const entered = deferred<void>();
  const drain = deferred<void>();
  let aborted = false;
  const f = fixture({
    transport: async (_url, init) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      await drain.promise;
      throw Error(secret);
    },
  });
  let finished = false;
  const pending = f.invoke(requestBody(), 1, external.signal).finally(() => {
    finished = true;
  });
  await entered.promise;
  external.abort();
  expect(finished).toBe(false);
  drain.resolve();
  await expect(pending).rejects.toThrow("REQUEST_ABORTED");
  expect(aborted).toBe(true);
  expect(f.settlements[0]).toMatchObject({ outcome: "unknown", chargedInputTokens: 20_000 });
});

it("honors one chunk ACK promise and checks authorization again before releasing more", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let forwarded = 0;
  let allowed = true;
  const f = fixture({
    authorizeCurrent: async () => {
      if (!allowed) throw Error("revoked");
    },
  });
  const pending = f.invoke(requestBody(), 1, new AbortController().signal, async () => {
    forwarded++;
    if (forwarded === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  await entered.promise;
  expect(forwarded).toBe(1);
  allowed = false;
  release.resolve();
  await expect(pending).rejects.toThrow("AUTHORIZATION_REJECTED");
  expect(forwarded).toBe(1);
});

it("deadline aborts the actual parent transport without a timeout-success race", async () => {
  let aborted = false;
  const f = fixture({
    deadlineMs: 10,
    transport: async (_url, init) => {
      await new Promise<void>((resolve) => {
        if (init.signal.aborted) resolve();
        else
          init.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
      });
      throw Error("aborted transport");
    },
  });
  await expect(f.invoke()).rejects.toThrow("REQUEST_ABORTED");
  expect(aborted).toBe(true);
  expect(f.settlements[0]).toMatchObject({
    outcome: "unknown",
    chargedInputTokens: 20_000,
    chargedOutputTokens: 512,
  });
});

it("canceling a pending response read awaits its actual cancel drain", async () => {
  const external = new AbortController();
  const reading = deferred<void>();
  const cancelEntered = deferred<void>();
  const drained = deferred<void>();
  const f = fixture({
    transport: async () =>
      new Response(
        new ReadableStream({
          pull() {
            reading.resolve();
          },
          cancel() {
            cancelEntered.resolve();
            return drained.promise;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  let returned = false;
  const pending = f.invoke(requestBody(), 1, external.signal).finally(() => {
    returned = true;
  });
  await reading.promise;
  external.abort();
  await cancelEntered.promise;
  expect(returned).toBe(false);
  expect(f.settlements).toHaveLength(0);
  drained.resolve();
  await expect(pending).rejects.toThrow("REQUEST_ABORTED");
  expect(f.settlements).toHaveLength(1);
  expect(f.settlements[0]).toMatchObject({ transportDrained: true });
});

it("retains failed drain evidence independently of an earlier parsing failure", async () => {
  const cancelEntered = deferred<void>();
  const releaseCancel = deferred<void>();
  const f = fixture({
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: invalid-json\n\n"));
          },
          async cancel() {
            cancelEntered.resolve();
            await releaseCancel.promise;
            throw Error("synthetic failed cancel");
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const result = f.invoke().catch((error: unknown) => error);
  await cancelEntered.promise;
  expect(f.settlements).toHaveLength(0);
  releaseCancel.resolve();
  expect(await result).toMatchObject({ code: "SSE_FRAME_INVALID" });
  expect(f.settlements).toHaveLength(1);
  expect(f.settlements[0]).toMatchObject({
    outcome: "unknown",
    failureCode: "SSE_FRAME_INVALID",
    transportDrained: false,
    chargedInputTokens: 20_000,
    chargedOutputTokens: 512,
  });
  await expect(f.invoke()).rejects.toThrow("REQUEST_REPLAY");
  expect(f.settlements).toHaveLength(1);
});

it.each([true, false])(
  "joins a response arriving after abort and records cancellation success %s",
  async (cancelSucceeds) => {
    const external = new AbortController();
    const entered = deferred<void>();
    const responseReady = deferred<void>();
    const cancelEntered = deferred<void>();
    const drain = deferred<void>();
    const f = fixture({
      transport: async () => {
        entered.resolve();
        await responseReady.promise;
        return new Response(
          new ReadableStream<Uint8Array>({
            async cancel() {
              cancelEntered.resolve();
              await drain.promise;
              if (!cancelSucceeds) throw Error("synthetic failed cancel");
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const result = f.invoke(requestBody(), 1, external.signal).catch((error: unknown) => error);
    await entered.promise;
    external.abort();
    responseReady.resolve();
    // Settlement, if reached before cancellation, gives the old implementation a deterministic exit.
    const first = await Promise.race([
      cancelEntered.promise.then(() => "cancel"),
      result.then(() => "settled"),
    ]);
    expect(first).toBe("cancel");
    expect(f.settlements).toHaveLength(0);
    drain.resolve();
    expect(await result).toMatchObject({ code: "REQUEST_ABORTED" });
    expect(f.settlements[0]).toMatchObject({
      outcome: "unknown",
      transportDrained: cancelSucceeds,
      chargedInputTokens: 20_000,
      chargedOutputTokens: 512,
    });
  },
);

it("records failed rejected-response drain without releasing capacity", async () => {
  const f = fixture({
    transport: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw Error("synthetic failed cancel");
          },
        }),
        { status: 429 },
      ),
  });
  await expect(f.invoke()).rejects.toThrow("TRANSPORT_RESPONSE_REJECTED");
  expect(f.settlements[0]).toMatchObject({ transportDrained: false, outcome: "unknown" });
});

it("settlement upgrade failure preserves denial without a success receipt", async () => {
  let current = true;
  let count = 0;
  const f = fixture({
    authorizeCurrent: async () => {
      if (!current) throw Error("revoked");
    },
    settleRequest: async () => {
      if (++count === 1) {
        current = false;
        return { accountingReceiptId: "initial" };
      }
      throw Error(secret);
    },
  });
  await expect(f.invoke()).rejects.toThrow("SETTLEMENT_FAILED");
  expect(count).toBe(2);
});

it("capture freezes parent tool definitions and reported aliases before caller mutation", async () => {
  const allowed = [model, reportedModel];
  const tools = [{ ...tool, function: { ...tool.function } }];
  const f = fixture({ tools, acceptedReportedModels: allowed });
  tools[0]!.function.name = "mutated";
  allowed[0] = "mutated";
  await f.invoke(requestBody({ tools: [tool] }));
  expect(f.settlements[0]?.reportedModel).toBe(model);
});

it("rejects malformed UTF-8 response bytes with full reservation and no diagnostics", async () => {
  const f = fixture({
    transport: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(Uint8Array.from([100, 97, 116, 97, 58, 32, 255, 10]));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  await expect(f.invoke()).rejects.toThrow("REQUEST_FAILED");
  expect(f.chunks).toHaveLength(0);
  expect(f.settlements[0]).toMatchObject({ outcome: "unknown", chargedInputTokens: 20_000 });
});

it("rejects non-native response content types and credential errors without worker disclosure", async () => {
  const f = fixture({
    transport: async () =>
      new Response(secret, { headers: { "content-type": "text/event-streaming" } }),
  });
  await expect(f.invoke()).rejects.toThrow("TRANSPORT_RESPONSE_REJECTED");
  expect(f.chunks).toHaveLength(0);
  const g = fixture({
    getCredential: async () => {
      throw Error(secret);
    },
  });
  await expect(g.invoke()).rejects.toThrow("CREDENTIAL_UNAVAILABLE");
  expect(g.transports).toHaveLength(0);
});

it("rejects a model-invented function not in the parent advertisement", async () => {
  const forged = data({
    model: reportedModel,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "shell", arguments: "{}" },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
  const f = fixture({
    transport: async () => response(forged + data(final()) + "data: [DONE]\n\n"),
  });
  await expect(f.invoke(requestBody({ tools: [tool] }))).rejects.toThrow("SSE_TOOL_INVALID");
  expect(f.chunks).toHaveLength(0);
});

describe("trusted configuration", () => {
  it.each([
    { endpoint: "https://api.openai.com/v1/chat/completions" },
    { endpoint: "http://localhost:11434/v1/chat/completions" },
    { endpoint: "https://127.0.0.1/v1" },
    { model: "local" },
    { acceptedReportedModels: ["other/alias"] },
    { maxOutputTokens: 0 },
    { maxInputTokens: 0 },
    { tools: Array.from({ length: 33 }, () => tool) },
  ])("rejects forbidden route or missing limits: %j", (extra) => {
    const f = fixture();
    expect(() => makePiModelBroker({ ...f.cfg, ...extra })).toThrow(PiModelBrokerError);
  });
});

function runNativeFixture(args: ReadonlyArray<string> = []) {
  return Effect.gen(function* () {
    const sdkRoot =
      process.env.PI_RUNTIME_CONTRACT_SDK_ROOT ??
      NodeURL.fileURLToPath(new URL("..", import.meta.resolve("@earendil-works/pi-coding-agent")));
    expect(sdkRoot, "Required pinned SDK root is missing").toBeTruthy();
    const execute = Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          process.execPath,
          [
            "--max-old-space-size=128",
            NodeURL.fileURLToPath(
              new URL("./fixtures/p7-model-broker-native-sdk.mjs", import.meta.url),
            ),
            ...args,
          ],
          {
            env: { PI_RUNTIME_CONTRACT_SDK_ROOT: sdkRoot, PATH: "" },
            extendEnv: false,
            stdin: "ignore",
            killSignal: "SIGKILL",
          },
        ),
      );
      let bytes = 0;
      const collect = (stream: typeof handle.stdout) => {
        const initial: Array<Uint8Array> = [];
        return stream.pipe(
          Stream.runFold(
            () => initial,
            (chunks, chunk) => {
              bytes += chunk.length;
              if (bytes > 65_536) throw new Error("Native fixture output exceeds its byte limit");
              chunks.push(chunk);
              return chunks;
            },
          ),
        );
      };
      const [out, err, code] = yield* Effect.all(
        [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return {
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        code,
      };
    }).pipe(Effect.timeout("15 seconds"), Effect.scoped, Effect.provide(NodeServices.layer));
    return yield* execute;
  });
}

effectIt.effect(
  "runs actual pinned SDK tool-bearing two-request turn through the broker with synthetic transport",
  () =>
    Effect.gen(function* () {
      const outcome = yield* runNativeFixture();
      expect(outcome.stderr).toBe("");
      expect(outcome.code).toBe(0);
      const report = Schema.Struct({
        sdk: Schema.String,
        remoteCalls: Schema.Int,
        transportCalls: Schema.Int,
        toolCalls: Schema.Int,
        nativeStop: Schema.String,
        settled: Schema.Boolean,
        requests: Schema.Array(
          Schema.Struct({ messages: Schema.Array(Schema.Struct({ role: Schema.String })) }),
        ),
        settlements: Schema.Array(Schema.Unknown),
      });
      const result = yield* Schema.decodeEffect(Schema.fromJsonString(report))(outcome.stdout);
      expect(result).toMatchObject({
        sdk: "0.99.1",
        remoteCalls: 0,
        transportCalls: 2,
        toolCalls: 1,
        nativeStop: "stop",
        settled: true,
      });
      expect(result.requests).toHaveLength(2);
      expect(result.requests[1]?.messages.at(-1)?.role).toBe("tool");
      expect(result.settlements).toHaveLength(2);
    }),
  20_000,
);

effectIt.effect(
  "replays exact retained CommandCode Ling bytes identically in direct SDK and broker",
  () =>
    Effect.gen(function* () {
      const outcome = yield* runNativeFixture(["--captured-ling-replay"]);
      expect(outcome.code, outcome.stdout + outcome.stderr).toBe(0);
      expect(outcome.stderr).toBe("");
      const report = Schema.Struct({
        rawSHA256: Schema.String,
        rawBytes: Schema.Int,
        remoteCalls: Schema.Int,
        direct: Schema.Struct({ stopReason: Schema.String }),
        broker: Schema.Struct({ stopReason: Schema.String, transportCalls: Schema.Int }),
      });
      const result = yield* Schema.decodeEffect(Schema.fromJsonString(report))(outcome.stdout);
      expect(result).toMatchObject({
        rawSHA256: "9ef3ec0c33b7653b8db9cc00474045f76c67e4f0e7dc8939c30e3a6c24b71247",
        rawBytes: 51_532,
        remoteCalls: 0,
        direct: { stopReason: "stop" },
        broker: { stopReason: "stop", transportCalls: 1 },
      });
    }),
  20_000,
);

it.each(["stop", "tool_calls"] as const)(
  "preserves sole after-content zero-usage %s before actual accounting",
  async (finish) => {
    const output =
      finish === "stop"
        ? native("result")
        : {
            model: reportedModel,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: tool.function.name, arguments: "{}" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
    const zero = {
      model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: finish }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const text = data(output) + data(zero) + data(final()) + "data: [DONE]\n\n";
    const f = fixture({ transport: async () => response(text, 1) });
    const receipt = await f.invoke(requestBody({ tools: [tool] }));
    expect(receipt.usage).toEqual(usage);
    expect(f.output()).toContain('"finish_reason":"' + finish + '"');
    expect(f.settlements[0]).toMatchObject({
      outcome: "reported",
      chargedInputTokens: 50,
      chargedOutputTokens: 10,
    });
  },
);

it.each([
  { sla_metrics: { ttft_ms: 1, ts_us: 2, unknown: 0 } },
  { sla_metrics: { ttft_ms: -1, ts_us: 2 } },
  { sla_metrics: { ttft_ms: 1, ts_us: Number.MAX_SAFE_INTEGER + 1 } },
  { unknown: "ignored" },
  { choices: [{ index: 0, delta: { reasoning_content: 1 }, finish_reason: null }] },
  {
    choices: [
      {
        index: 0,
        delta: { reasoning_content: "bounded", unknown: "ignored" },
        finish_reason: null,
      },
    ],
  },
])("rejects unobserved or invalid native route fields: %j", async (extra) => {
  const f = fixture({
    transport: async () => response(data({ ...native("result"), ...extra }) + success()),
  });
  await expect(f.invoke()).rejects.toThrow("SSE_FRAME_INVALID");
  expect(f.chunks).toHaveLength(0);
  expect(f.settlements[0]).toMatchObject({
    outcome: "unknown",
    chargedInputTokens: 20_000,
    chargedOutputTokens: 512,
  });
});

it.each([
  { prompt_tokens_details: { unknown: 0 } },
  { completion_tokens_details: { unknown: 0 } },
  { prompt_tokens_details: { audio_tokens: 51 } },
  { prompt_tokens_details: { cache_creation_input_tokens: 51 } },
  { prompt_tokens_details: { cache_read_input_tokens: 51 } },
  { prompt_tokens_details: { text_tokens: 51 } },
  { prompt_tokens_details: { image_tokens: 51 } },
  { prompt_tokens_details: { video_tokens: 51 } },
  { completion_tokens_details: { reasoning_tokens: 11 } },
])("rejects invalid known details and unknown detail fields: %j", async (extra) => {
  const text =
    data(native("result")) +
    data(native("", "stop")) +
    data(final({ ...usage, ...extra })) +
    "data: [DONE]\n\n";
  const f = fixture({ transport: async () => response(text, 7) });
  await expect(f.invoke()).rejects.toBeInstanceOf(PiModelBrokerError);
  expect(f.settlements[0]).toMatchObject({
    outcome: "unknown",
    chargedInputTokens: 20_000,
    chargedOutputTokens: 512,
  });
});

it("protects credentials across reasoning delta frames and reasoning-to-content boundaries", async () => {
  const reasoning = (text: string) => ({
    model: reportedModel,
    choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }],
  });
  for (const second of [reasoning(secret.slice(9)), native(secret.slice(9))]) {
    const text =
      data(reasoning(secret.slice(0, 9))) +
      data(second) +
      data(native("", "stop")) +
      data(final()) +
      "data: [DONE]\n\n";
    const f = fixture({ transport: async () => response(text, 1) });
    await expect(f.invoke()).rejects.toThrow("CREDENTIAL_ECHO_REJECTED");
    expect(f.chunks).toHaveLength(0);
  }
});

const zeroFinish = (finish: "stop" | "tool_calls" = "stop") => ({
  model,
  choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: finish }],
  usage: {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: null,
    completion_tokens_details: null,
  },
});
it.each([
  ["placeholder alone", data(zeroFinish()) + data(final())],
  [
    "placeholder before content with no actual finish",
    data(zeroFinish()) + data(native("result")) + data(final()),
  ],
  ["terminal without accounting", data(native("result")) + data(zeroFinish())],
  ["tool placeholder before content", data(zeroFinish("tool_calls")) + success()],
  [
    "zero usage with nonzero details",
    data(native("result")) +
      data({
        ...zeroFinish(),
        usage: { ...zeroFinish().usage, prompt_tokens_details: { audio_tokens: 1 } },
      }) +
      data(final()),
  ],
])("zero-usage finish requires valid content and final accounting: %s", async (_name, text) => {
  const f = fixture({ transport: async () => response(text + "data: [DONE]\n\n", 3) });
  await expect(f.invoke()).rejects.toBeInstanceOf(PiModelBrokerError);
  expect(f.settlements[0]).toMatchObject({
    outcome: "unknown",
    chargedInputTokens: 20_000,
    chargedOutputTokens: 512,
  });
});

it("accepts an existing finish followed by the route's zero-usage marker and actual accounting", async () => {
  const text =
    data(native("result")) +
    data(native("", "stop")) +
    data(zeroFinish()) +
    data(final()) +
    "data: [DONE]\n\n";
  const f = fixture({ transport: async () => response(text, 3) });
  expect((await f.invoke()).usage).toEqual(usage);
  expect(f.settlements[0]).toMatchObject({
    outcome: "reported",
    chargedInputTokens: 50,
    chargedOutputTokens: 10,
  });
});

describe("sealed assignment input", () => {
  it("binds the exact encoded outbound body after reservation and before transport", async () => {
    let binding: { reservationId: string; encodedRequestSha256: string } | undefined;
    const f = fixture({
      requiredSystemText: "Trusted assignment",
      bindRequestInput: async (input) => {
        binding = input;
      },
      transport: async (_url, init) => {
        expect(binding).toEqual({
          reservationId: "reserved-1",
          encodedRequestSha256: NodeCrypto.createHash("sha256").update(init.body).digest("hex"),
        });
        expect(init.body).not.toContain(secret);
        return response(success());
      },
    });
    await f.invoke();
    expect(f.reservations).toHaveLength(1);
  });

  it.each(
    [
      [{ role: "user", content: "Trusted assignment" }],
      [{ role: "system", content: "Trusted assignment suffix" }],
      [
        { role: "system", content: "Trusted assignment" },
        { role: "system", content: "extra" },
      ],
      [
        {
          role: "system",
          content: [
            { type: "text", text: "Trusted assignment" },
            { type: "text", text: "" },
          ],
        },
      ],
    ].map((messages) => ({ messages })),
  )("rejects substituted or fragmented system input before reservation", async ({ messages }) => {
    const f = fixture({
      requiredSystemText: "Trusted assignment",
      bindRequestInput: async () => {},
    });
    await expect(f.invoke(requestBody({ messages }))).rejects.toMatchObject({
      code: "REQUEST_SYSTEM_INPUT_INVALID",
    });
    expect(f.reservations).toHaveLength(0);
    expect(f.transports).toHaveLength(0);
  });

  it("accepts one exact text part and captures the host binding configuration", async () => {
    const bound: string[] = [];
    const f = fixture({
      requiredSystemText: "Trusted assignment",
      bindRequestInput: async ({ reservationId }) => {
        bound.push(reservationId);
      },
    });
    Object.assign(f.cfg, {
      requiredSystemText: "changed after construction",
      bindRequestInput: async () => {
        throw new Error("mutated callback");
      },
    });
    await f.invoke(
      requestBody({
        messages: [
          { role: "system", content: [{ type: "text", text: "Trusted assignment" }] },
          { role: "user", content: "Investigate" },
        ],
      }),
    );
    expect(bound).toEqual(["reserved-1"]);
    expect(f.transports).toHaveLength(1);
  });

  it("requires paired private input configuration", () => {
    const f = fixture();
    expect(() => makePiModelBroker({ ...f.cfg, requiredSystemText: "Trusted assignment" })).toThrow(
      PiModelBrokerError,
    );
    expect(() => makePiModelBroker({ ...f.cfg, bindRequestInput: async () => {} })).toThrow(
      PiModelBrokerError,
    );
  });

  it("joins failed binding settlement without transport or successful receipt", async () => {
    const f = fixture({
      requiredSystemText: "Trusted assignment",
      bindRequestInput: async () => {
        throw new Error("binding commit failed");
      },
    });
    await expect(f.invoke()).rejects.toMatchObject({ code: "REQUEST_INPUT_BINDING_FAILED" });
    expect(f.transports).toHaveLength(0);
    expect(f.settlements).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({
      outcome: "unknown",
      failureCode: "REQUEST_INPUT_BINDING_FAILED",
      transportDrained: true,
    });
  });
});

describe("retained dispatch broker operation IDs", () => {
  it("preserves guided and legacy operation IDs through reservation and settlement", async () => {
    for (const operationId of [
      projectTeamDerivedRecordId("approved-dispatch", "initialize"),
      "legacy_operation-1",
    ]) {
      const f = fixture({ operationId });
      await f.invoke();
      expect(f.reservations).toHaveLength(1);
      expect(f.settlements).toHaveLength(1);
      expect(f.reservations[0]).toMatchObject({
        operationId,
        workerId: "worker",
        generation: 7,
        requestId: 1,
      });
      expect(f.settlements[0]).toMatchObject({
        ...f.reservations[0],
        reservationId: "reserved-1",
        outcome: "reported",
        transportDrained: true,
      });
      expect(f.transports).toHaveLength(1);
    }
  });
  it("refuses malformed operation IDs and guided generic identities before transport", () => {
    const guided = projectTeamDerivedRecordId("approved-dispatch", "initialize");
    const f = fixture();
    for (const operationId of [
      "guided:" + "a".repeat(63),
      "guided:" + "a".repeat(65),
      "guided:" + "A".repeat(64),
      "guided:" + "g".repeat(64),
      "other:" + "a".repeat(64),
      "../operation",
      "a".repeat(129),
      guided + "\n",
      guided + "\r",
      "legacy\n",
      "legacy\r",
    ]) {
      expect(() => makePiModelBroker({ ...f.cfg, operationId })).toThrow("CONFIG_LIMITS_INVALID");
    }
    for (const field of ["workerId", "routeId"] as const)
      expect(() => makePiModelBroker({ ...f.cfg, [field]: guided })).toThrow(
        "CONFIG_LIMITS_INVALID",
      );
    expect(f.reservations).toEqual([]);
    expect(f.settlements).toEqual([]);
    expect(f.transports).toEqual([]);
  });
});
