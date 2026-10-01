import * as NodeAssert from "node:assert/strict";
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
  routeId: "ling-free",
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
            native({}, "tool_calls"),
          ]
        : [native({ role: "assistant", content: "Assignment echoed." }), native({}, "stop")];
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
