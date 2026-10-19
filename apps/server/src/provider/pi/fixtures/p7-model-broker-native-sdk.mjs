import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";

// Actual pinned SDK request generation, with no network or filesystem tools.
const configuredRoot = process.env.PI_RUNTIME_CONTRACT_SDK_ROOT;
NodeAssert.ok(configuredRoot, "Pinned SDK root is required; absence is a failure");
const root = await NodeFSP.realpath(configuredRoot);
const metadata = JSON.parse(await NodeFSP.readFile(NodePath.join(root, "package.json"), "utf8"));
NodeAssert.equal(metadata.name, "@earendil-works/pi-coding-agent");
NodeAssert.equal(metadata.version, "0.99.1");
globalThis.fetch = async () => {
  throw Error("NETWORK_FORBIDDEN");
};
const sdkURL = NodeURL.pathToFileURL(NodePath.join(root, "dist/index.js"));
const sdk = await import(sdkURL.href);
const aiPath = NodeModule.findPackageJSON("@earendil-works/pi-ai", sdkURL);
NodeAssert.equal(JSON.parse(await NodeFSP.readFile(aiPath, "utf8")).version, "0.99.1");
const { streamSimple } = await import(
  NodeURL.pathToFileURL(NodePath.join(NodePath.dirname(aiPath), "dist/api/openai-completions.js"))
    .href
);
const { makePiModelBroker } = await import(new URL("../PiModelBroker.ts", import.meta.url).href);
// Exact retained successful CommandCode ordinal-6 bytes, compressed only to keep this fixture compact.
// Source SHA256 is pinned; replay never obtains credentials or reaches the network.
async function replayCapturedLing() {
  const raw = NodeZlib.gunzipSync(
    Buffer.from(
      "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",
      "base64",
    ),
    { maxOutputLength: 51_532 },
  );
  const rawSHA256 = NodeCrypto.createHash("sha256").update(raw).digest("hex");
  NodeAssert.equal(raw.length, 51_532);
  NodeAssert.equal(rawSHA256, "9ef3ec0c33b7653b8db9cc00474045f76c67e4f0e7dc8939c30e3a6c24b71247");
  const model = "inclusionai/ling-3.1-flash:free";
  const reported = "inclusionai/ling-3.1-flash";
  const endpoint = "https://api.commandcode.ai/provider/v1/chat/completions";
  const selected = {
    id: model,
    name: "Retained Ling replay",
    api: "openai-completions",
    provider: "command-code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 65_536,
    maxTokens: 512,
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
  };
  const response = () => {
    let offset = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (offset === raw.length) return controller.close();
          const end = Math.min(offset + 37, raw.length);
          controller.enqueue(raw.subarray(offset, end));
          offset = end;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  async function replay(throughBroker) {
    const settlements = [];
    let transportCalls = 0;
    let bridgeCalls = 0;
    let failureCode;
    let receipt;
    let pending = Promise.resolve();
    const broker = makePiModelBroker({
      workerId: "retained-worker",
      generation: 1,
      operationId: "retained-operation",
      routeId: "command-code-ling-free",
      provider: "command-code",
      model,
      endpoint,
      acceptedReportedModels: [model, reported],
      tools: [],
      maxInputTokens: 20_000,
      maxOutputTokens: 512,
      deadlineMs: 10_000,
      authorizeCurrent: async () => {},
      getCredential: async () => "synthetic-replay-parent-secret",
      reserveRequest: async () => ({ reservationId: "retained-reservation" }),
      settleRequest: async (value) => {
        settlements.push(value);
        return { accountingReceiptId: "retained-accounted" };
      },
      transport: async (url, init) => {
        NodeAssert.equal(url, endpoint);
        NodeAssert.equal(init.redirect, "error");
        NodeAssert.equal(++transportCalls, 1);
        return response();
      },
    });
    const fetch = async (url, init) => {
      NodeAssert.equal(String(url), endpoint);
      NodeAssert.equal(init.method, "POST");
      NodeAssert.equal(++bridgeCalls, 1);
      if (!throughBroker) return response();
      let controller;
      const stream = new ReadableStream({
        start(value) {
          controller = value;
        },
      });
      pending = broker
        .request({
          requestId: 1,
          body: init.body,
          signal: init.signal,
          onChunk: async (chunk) => controller.enqueue(chunk),
        })
        .then(
          (value) => {
            receipt = value;
            controller.close();
          },
          (error) => {
            failureCode = error.code;
            controller.error(error);
          },
        );
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const stream = streamSimple(
      selected,
      {
        systemPrompt: "Bounded retained native replay",
        messages: [{ role: "user", content: "Answer the approved assignment.", timestamp: 1 }],
      },
      { apiKey: "worker-placeholder", fetch, maxRetries: 0, maxTokens: 512 },
    );
    const events = [];
    for await (const event of stream) events.push(event.type);
    const message = await stream.result();
    await pending;
    return {
      stopReason: message.stopReason,
      usage: message.usage,
      content: message.content,
      events,
      bridgeCalls,
      transportCalls,
      settlements,
      receipt,
      failureCode,
    };
  }
  const direct = await replay(false);
  const broker = await replay(true);
  const summary = {
    sdk: metadata.version,
    remoteCalls: 0,
    rawSHA256,
    rawBytes: raw.length,
    direct: { stopReason: direct.stopReason, usage: direct.usage },
    broker: {
      stopReason: broker.stopReason,
      usage: broker.usage,
      failureCode: broker.failureCode,
      transportCalls: broker.transportCalls,
      settlements: broker.settlements,
      receipt: broker.receipt,
    },
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
  NodeAssert.equal(direct.stopReason, "stop");
  NodeAssert.equal(direct.usage.output, 376);
  NodeAssert.equal(direct.usage.totalTokens, 595);
  NodeAssert.equal(broker.stopReason, "stop", broker.failureCode);
  NodeAssert.deepEqual(broker.usage, direct.usage);
  NodeAssert.deepEqual(broker.content, direct.content);
  NodeAssert.equal(broker.transportCalls, 1);
  NodeAssert.equal(broker.settlements.length, 1);
  NodeAssert.equal(broker.settlements[0].outcome, "reported");
  NodeAssert.equal(broker.settlements[0].chargedInputTokens, 219);
  NodeAssert.equal(broker.settlements[0].chargedOutputTokens, 376);
  NodeAssert.equal(broker.receipt.usage.total_tokens, 595);
}
if (process.argv.includes("--captured-ling-replay")) {
  await replayCapturedLing();
  process.exit(0);
}
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-p7-broker-native-"));
const model = "inclusionai/ling-3.1-flash:free";
const reported = "inclusionai/ling-3.1-flash";
const endpoint = "https://api.commandcode.ai/provider/v1/chat/completions";
const parameters = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const frozenTool = {
  type: "function",
  function: {
    name: "echo_assignment",
    description: "Echo the bounded synthetic assignment",
    parameters,
  },
};
const native = (delta, finish_reason = null, usage) => ({
  id: "fixture",
  object: "chat.completion.chunk",
  created: 1,
  model: reported,
  choices: [{ index: 0, delta, finish_reason }],
  ...(usage ? { usage } : {}),
});
const sse = (frames) =>
  frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
const requests = [];
const settlements = [];
const phases = [];
let transportCalls = 0;
let toolCalls = 0;
const broker = makePiModelBroker({
  workerId: "native-worker",
  generation: 1,
  operationId: "native-operation",
  routeId: "command-code-ling-free",
  provider: "command-code",
  model,
  endpoint,
  acceptedReportedModels: [model, reported],
  tools: [frozenTool],
  maxInputTokens: 20_000,
  maxOutputTokens: 512,
  deadlineMs: 10_000,
  authorizeCurrent: async (phase) => {
    phases.push(phase);
  },
  getCredential: async () => "synthetic-parent-secret-do-not-forward",
  reserveRequest: async (value) => {
    requests.push(value);
    return { reservationId: `reserved-${value.requestId}` };
  },
  settleRequest: async (value) => {
    settlements.push(value);
    return { accountingReceiptId: `accounted-${value.requestId}` };
  },
  transport: async (url, init) => {
    NodeAssert.equal(url, endpoint);
    NodeAssert.equal(init.redirect, "error");
    NodeAssert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    NodeAssert.equal(body.model, model);
    NodeAssert.deepEqual(body.tools, [frozenTool]);
    NodeAssert.ok(++transportCalls <= 2);
    const frames =
      transportCalls === 1
        ? [
            native({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "echo_assignment", arguments: '{"text":"bounded assignment"}' },
                },
              ],
            }),
            native({}, "tool_calls", {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              prompt_tokens_details: null,
              completion_tokens_details: null,
            }),
          ]
        : [
            native({ role: "assistant", content: "Assignment echoed." }),
            native({}, "stop", {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              prompt_tokens_details: null,
              completion_tokens_details: null,
            }),
          ];
    if (transportCalls === 2) {
      NodeAssert.deepEqual(body.messages.at(-1), {
        role: "tool",
        content: "bounded assignment",
        tool_call_id: "call-1",
      });
      NodeAssert.deepEqual(body.messages.at(-2).tool_calls, [
        {
          id: "call-1",
          type: "function",
          function: { name: "echo_assignment", arguments: '{"text":"bounded assignment"}' },
        },
      ]);
    }
    frames.push({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 1,
      model,
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        total_tokens: 60,
        prompt_tokens_details: { cached_tokens: 5 },
      },
    });
    const bytes = Buffer.from(sse(frames));
    // Fragment inside both JSON fields and usage while retaining the actual native SSE protocol.
    let offset = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 37, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
let sequence = 0;
let barrier = Promise.resolve();
const bodies = [];
const fetch = async (url, init) => {
  await barrier;
  NodeAssert.equal(String(url), endpoint);
  NodeAssert.equal(init.method, "POST");
  bodies.push(JSON.parse(init.body));
  if (process.env.PI_MODEL_BROKER_FIXTURE_EVIDENCE_DIR)
    await NodeFSP.writeFile(
      NodePath.join(
        process.env.PI_MODEL_BROKER_FIXTURE_EVIDENCE_DIR,
        `native-request-${bodies.length}.json`,
      ),
      JSON.stringify(bodies.at(-1), null, 2),
    );
  NodeAssert.deepEqual(bodies.at(-1).tools, [frozenTool], "Actual native SDK tool wire shape");
  let streamController;
  const body = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
  });
  const pending = broker.request({
    requestId: ++sequence,
    body: init.body,
    signal: init.signal,
    onChunk: async (chunk) => {
      streamController.enqueue(chunk);
    },
  });
  barrier = pending.then(
    (receipt) => {
      NodeAssert.ok(receipt.accountingReceiptId);
      streamController.close();
    },
    (error) => {
      streamController.error(error);
      throw error;
    },
  );
  barrier.catch(() => undefined);
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
};
let session;
try {
  const runtime = await sdk.ModelRuntime.create({
    authPath: NodePath.join(scratch, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider("command-code", {
    api: "openai-completions",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    apiKey: "worker-placeholder",
    models: [
      {
        id: model,
        name: "Synthetic Ling free",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 65_536,
        maxTokens: 512,
        compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      },
    ],
    streamSimple: (selected, context, options) =>
      streamSimple(selected, context, {
        ...options,
        apiKey: "worker-placeholder",
        fetch,
        maxRetries: 0,
        maxTokens: 512,
      }),
  });
  ({ session } = await sdk.createAgentSession({
    cwd: scratch,
    agentDir: scratch,
    modelRuntime: runtime,
    model: runtime.getModel("command-code", model),
    sessionManager: sdk.SessionManager.inMemory(scratch),
    settingsManager: sdk.SettingsManager.inMemory({
      packages: [],
      blockImages: true,
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: { enabled: false },
    }),
    resourceLoader: {
      getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => "Use the assigned echo tool once.",
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {
        throw Error("RESOURCE_MUTATION_FORBIDDEN");
      },
      reload: async () => {},
    },
    tools: ["echo_assignment"],
    customTools: [
      {
        name: "echo_assignment",
        label: "Echo",
        description: frozenTool.function.description,
        parameters,
        execute: async (_id, args) => {
          toolCalls++;
          NodeAssert.deepEqual(args, { text: "bounded assignment" });
          return { content: [{ type: "text", text: args.text }], details: {} };
        },
      },
    ],
    thinkingLevel: "off",
  }));
  const events = [];
  session.subscribe((event) => events.push(event.type));
  await session.prompt("Echo the bounded assignment.");
  await session.waitForIdle();
  await barrier;
  NodeAssert.ok(session.isIdle);
  NodeAssert.equal(
    session.messages.at(-1).stopReason,
    "stop",
    session.messages.at(-1).errorMessage,
  );
  NodeAssert.equal(events.at(-1), "agent_settled");
  NodeAssert.equal(toolCalls, 1);
  NodeAssert.equal(transportCalls, 2);
  NodeAssert.equal(settlements.length, 2);
  NodeAssert.ok(
    settlements.every((s) => s.chargedInputTokens === 50 && s.chargedOutputTokens === 10),
  );
  NodeAssert.ok(!JSON.stringify(session.messages).includes("synthetic-parent-secret"));
  process.stdout.write(
    JSON.stringify({
      sdk: metadata.version,
      remoteCalls: 0,
      transportCalls,
      toolCalls,
      requests: bodies,
      settlements,
      phases,
      nativeStop: session.messages.at(-1).stopReason,
      nativeUsage: session.messages.at(-1).usage,
      settled: true,
    }) + "\n",
  );
} finally {
  if (session) {
    await session.abort();
    session.dispose();
  }
  await NodeFSP.rm(scratch, { recursive: true, force: true });
}
