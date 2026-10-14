import { describe, expect, it, vi } from "vite-plus/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai";
import * as Schema from "effect/Schema";
import { makePiModelBroker } from "./PiModelBroker.ts";
import {
  makePiWorkerModelBridge,
  makePiWorkerSettings,
  makePiSdkWorker,
  splitPiWorkerText,
  streamPiWorkerSubscription,
} from "./PiWorker.ts";
import {
  PI_WORKER_MAX_REQUEST_BYTES,
  encodePiWorkerFrame,
  decodePiWorkerFrame,
  encodePiParentFrame,
  type PiWorkerFrame,
  type PiWorkerBootstrap,
} from "./PiWorkerProtocol.ts";

const decodeWorkerBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));
const decodeDiagnosticSessions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
  ),
);
const decodeDiagnosticEntry = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      message: Schema.optional(
        Schema.Struct({ role: Schema.String, content: Schema.optional(Schema.Unknown) }),
      ),
    }),
  ),
);
const decodeDiagnosticContent = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
);
const zstdCompressor = () => process.getBuiltinModule("node:zlib")?.zstdCompressSync;
describe("Pinned Pi worker effective settings", () => {
  it("retains exact initial context as SDK provenance without duplicating the conversation", async () => {
    const fs = process.getBuiltinModule("fs").promises;
    const directory = await fs.mkdtemp(
      process.getBuiltinModule("os").tmpdir() + "/pi-initial-context-",
    );
    const context = "Exact approved briefing\n" + "x".repeat(6500);
    const identity = { workerId: "initial-context", generation: 0 };
    const operation = {
      operationId: "initial-context-operation",
      operationKind: "initialize",
    } as const;
    const frames: PiWorkerFrame["message"][] = [];
    const worker = makePiSdkWorker({
      identity,
      operation,
      sessionDirectory: directory,
      localTools: {},
      emit: async (bytes) => {
        frames.push(decodePiWorkerFrame(bytes.toString().slice(0, -1)).message);
      },
    });
    let sequence = 0;
    const parent = (message: Parameters<typeof encodePiParentFrame>[0]["message"]) =>
      worker.acceptParent(
        encodePiParentFrame({
          version: 1,
          ...identity,
          ...operation,
          sequence: sequence++,
          message,
        })
          .toString()
          .slice(0, -1),
      );
    const running = worker.run();
    try {
      parent({
        type: "bootstrap",
        executionMode: "ordinary",
        expectedCwd: process.cwd(),
        native: null,
        context: { transferId: "context", totalBytes: Buffer.byteLength(context) },
        prompt: null,
        model: {
          provider: "synthetic",
          modelId: "no-inference",
          api: "openai-completions",
          contextWindow: 20000,
          maxTokens: 512,
          reasoning: false,
        },
        allowedTools: [],
      });
      parent({
        type: "transfer-chunk",
        transferId: "context",
        index: 0,
        offset: 0,
        data: Buffer.from(context).toString("base64"),
      });
      parent({ type: "transfer-end", transferId: "context" });
      await running;
      expect(frames.map((frame) => frame.type)).toEqual(["ready", "initialized"]);
      const initialized = frames[1];
      if (initialized?.type !== "initialized")
        throw Error("Missing actual initialized SDK receipt");
      const file = directory + "/" + initialized.native.sessionReference.slice("sessions/".length);
      const reopened = SessionManager.open(file, directory);
      expect(reopened.getSessionId()).toBe(initialized.native.sessionId);
      expect(reopened.getLeafId()).toBe(initialized.native.leafId);
      const provenance = reopened.getEntries().filter((entry) => entry.type === "custom");
      expect(provenance).toEqual([
        expect.objectContaining({
          customType: "t3-approved-initial-context",
          data: { text: context },
        }),
      ]);
      expect(reopened.buildSessionContext().messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [
            { type: "text", text: "Session initialized. Approved context is supplied separately." },
          ],
        }),
      ]);
      expect(await fs.readFile(file, "utf8")).toContain(JSON.stringify(context));
      await worker.dispose();
      const promptOperation = { operationId: "approved-prompt", operationKind: "prompt" } as const;
      const assignment = "Retain this exact original assignment";
      const model = "inclusionai/ling-3.1-flash:free";
      const tools = [
        {
          type: "function" as const,
          function: {
            name: "approved_read",
            description: "Selected read capability",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        },
      ];
      let promptSequence = 0;
      let ack: ReturnType<typeof Promise.withResolvers<void>> | undefined;
      let brokerTask: Promise<void> | undefined;
      let brokerFailure: unknown;
      let reservations = 0;
      let settlements = 0;
      const associations: Array<{ reservationId: string; encodedRequestSha256: string }> = [];
      const requests: string[] = [];
      const promptFrames: PiWorkerFrame["message"][] = [];
      const broker = makePiModelBroker({
        ...identity,
        ...promptOperation,
        routeId: "command-code-ling-free",
        provider: "command-code",
        model,
        endpoint: "https://api.commandcode.ai/provider/v1/chat/completions",
        acceptedReportedModels: [model],
        tools,
        maxInputTokens: 10000,
        maxOutputTokens: 512,
        deadlineMs: 10000,
        requiredSystemText: context,
        bindRequestInput: async (input) => {
          associations.push(input);
        },
        authorizeCurrent: async () => {},
        getCredential: async () => "synthetic-parent-secret",
        reserveRequest: async () => {
          reservations++;
          return { reservationId: "original-reservation" };
        },
        settleRequest: async () => {
          settlements++;
          return { accountingReceiptId: "original-accounting" };
        },
        transport: async (_endpoint, init) => {
          requests.push(init.body);
          const events = [
            {
              model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Approved result" },
                  finish_reason: null,
                },
              ],
            },
            { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            {
              model,
              choices: [],
              usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
            },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
              "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      const promptWorker = makePiSdkWorker({
        identity,
        operation: promptOperation,
        sessionDirectory: directory,
        localTools: {},
        emit: async (bytes) => {
          const message = decodePiWorkerFrame(bytes.toString().slice(0, -1)).message;
          promptFrames.push(message);
          if (message.type === "request") {
            promptParent({ type: "headers", requestId: message.requestId, status: 200 });
            brokerTask = broker
              .request({
                requestId: message.requestId,
                body: message.body,
                signal: new AbortController().signal,
                onChunk: async (chunk) => {
                  ack = Promise.withResolvers<void>();
                  promptParent({
                    type: "chunk",
                    requestId: message.requestId,
                    data: Buffer.from(chunk).toString("base64"),
                  });
                  await ack.promise;
                },
              })
              .then(
                () => {
                  promptParent({ type: "end", requestId: message.requestId });
                },
                (error: unknown) => {
                  brokerFailure = error;
                  promptParent({
                    type: "error",
                    requestId: message.requestId,
                    code: "SDK_FAILURE",
                  });
                },
              );
          } else if (message.type === "ack") ack?.resolve();
        },
      });
      const promptParent = (message: Parameters<typeof encodePiParentFrame>[0]["message"]) =>
        promptWorker.acceptParent(
          encodePiParentFrame({
            version: 1,
            ...identity,
            ...promptOperation,
            sequence: promptSequence++,
            message,
          })
            .toString()
            .slice(0, -1),
        );
      const promptRun = promptWorker.run().then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        promptParent({
          type: "bootstrap",
          executionMode: "ordinary",
          expectedCwd: process.cwd(),
          native: initialized.native,
          context: { transferId: "context", totalBytes: Buffer.byteLength(context) },
          prompt: { transferId: "prompt", totalBytes: Buffer.byteLength(assignment) },
          model: {
            provider: "command-code",
            modelId: model,
            api: "openai-completions",
            contextWindow: 20000,
            maxTokens: 512,
            reasoning: false,
          },
          allowedTools: [
            { name: "approved_read", description: "Selected read capability", execution: "bridge" },
          ],
        });
        for (const [transferId, text] of [
          ["context", context],
          ["prompt", assignment],
        ] as const) {
          promptParent({
            type: "transfer-chunk",
            transferId,
            index: 0,
            offset: 0,
            data: Buffer.from(text).toString("base64"),
          });
          promptParent({ type: "transfer-end", transferId });
        }
        const failed = await promptRun;
        await brokerTask;
        if (brokerFailure || failed) throw brokerFailure ?? failed;
        expect(reservations).toBe(1);
        expect(settlements).toBe(1);
        expect(requests).toHaveLength(1);
        expect(associations).toEqual([
          {
            reservationId: "original-reservation",
            encodedRequestSha256: process
              .getBuiltinModule("crypto")
              .createHash("sha256")
              .update(requests[0] ?? "")
              .digest("hex"),
          },
        ]);
        const body = decodeWorkerBody(requests[0]);
        expect(body.messages).toEqual([
          { role: "system", content: context },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Session initialized. Approved context is supplied separately.",
              },
            ],
          },
          { role: "user", content: [{ type: "text", text: assignment }] },
        ]);
        expect(body.tools).toEqual(tools);
        expect(promptFrames[0]).toMatchObject({ type: "ready", native: initialized.native });
        expect(promptFrames.at(-1)?.type).toBe("done");
        expect(promptFrames.some((frame) => frame.type === "ack")).toBe(true);
      } finally {
        promptWorker.abort();
        await promptRun;
        await brokerTask;
        await promptWorker.dispose();
      }
    } finally {
      worker.abort();
      await running.catch(() => {});
      await worker.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["unavailable", "held-empty", "held-selected"] as const)(
    "admits resources once before native persistence and joins %s activation",
    async (mode) => {
      const fs = process.getBuiltinModule("fs").promises;
      const directory = await fs.mkdtemp(
        process.getBuiltinModule("os").tmpdir() + "/pi-worker-resources-",
      );
      const frames: PiWorkerFrame["message"][] = [];
      const identity = { workerId: "resource-activation", generation: 1 };
      const operation = {
        operationId: "initialize-resources",
        operationKind: "initialize" as const,
      };
      const entered = Promise.withResolvers<NonNullable<PiWorkerBootstrap["resources"]>>();
      const release = Promise.withResolvers<void>();
      const create = vi.spyOn(SessionManager, "create");
      const open = vi.spyOn(SessionManager, "open");
      const initializeLocalResources = vi.fn(
        async (resources: NonNullable<PiWorkerBootstrap["resources"]>) => {
          entered.resolve(resources);
          if (mode === "unavailable") throw Error("UNAVAILABLE");
          await release.promise;
        },
      );
      const worker = makePiSdkWorker({
        identity,
        operation,
        sessionDirectory: directory,
        localTools: {},
        initializeLocalResources,
        emit: async (bytes) => {
          frames.push(decodePiWorkerFrame(bytes.toString().slice(0, -1)).message);
        },
      });
      let sequence = 0;
      const parent = (message: Parameters<typeof encodePiParentFrame>[0]["message"]) =>
        worker.acceptParent(
          encodePiParentFrame({
            version: 1,
            ...identity,
            ...operation,
            sequence: sequence++,
            message,
          })
            .toString()
            .slice(0, -1),
        );
      const skills =
        mode === "held-selected"
          ? [
              {
                key: "example",
                path: "/runtime/skills/example/SKILL.md",
                description: "Selected catalogue",
              },
            ]
          : [];
      const context = "Validated context";
      let joined = false;
      const outcome = worker.run().then(
        () => "unexpected success",
        (error: unknown) => {
          joined = true;
          return String(error);
        },
      );
      try {
        parent({
          type: "bootstrap",
          executionMode: "ordinary",
          expectedCwd: process.cwd(),
          native: null,
          context: { transferId: "context", totalBytes: Buffer.byteLength(context) },
          prompt: null,
          model: {
            provider: "synthetic",
            modelId: "no-inference",
            api: "openai-completions",
            contextWindow: 32768,
            maxTokens: 512,
            reasoning: false,
          },
          allowedTools: [],
          ...(mode === "held-selected" ? { resources: { skills } } : {}),
        });
        expect(initializeLocalResources).not.toHaveBeenCalled();
        parent({
          type: "transfer-chunk",
          transferId: "context",
          index: 0,
          offset: 0,
          data: Buffer.from(context).toString("base64"),
        });
        expect(initializeLocalResources).not.toHaveBeenCalled();
        parent({ type: "transfer-end", transferId: "context" });
        expect(await entered.promise).toEqual({ skills });
        expect(await fs.readdir(directory)).toEqual([]);
        expect(create).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        if (mode !== "unavailable") {
          parent({ type: "interrupt", controlId: 1 });
          expect(joined).toBe(false);
          release.resolve();
        }
        expect(await outcome).toBe(
          "Error: " + (mode === "unavailable" ? "UNAVAILABLE" : "CANCELED"),
        );
        expect(initializeLocalResources).toHaveBeenCalledExactlyOnceWith({ skills });
        expect(create).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(await fs.readdir(directory)).toEqual([]);
        expect(frames.some((frame) => frame.type === "ready" || frame.type === "request")).toBe(
          false,
        );
        expect(frames.at(-1)).toEqual({
          type: "worker-failure",
          code: mode === "unavailable" ? "UNAVAILABLE" : "CANCELED",
        });
      } finally {
        release.resolve();
        worker.abort();
        await outcome;
        await worker.dispose();
        create.mockRestore();
        open.mockRestore();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("disables SDK cache warming and image processing through the pinned public getters", () => {
    const settings = makePiWorkerSettings(512);
    expect(settings.getCacheWarmingMode()).toBe("off");
    expect(settings.getBlockImages()).toBe(true);
    expect(settings.getPackages()).toEqual([]);
    expect(settings.getRetrySettings().enabled).toBe(false);
    expect(settings.getCompactionSettings().enabled).toBe(false);
    expect(settings.getCompactionSettings().keepRecentTokens).toBe(512);
  });

  it("acknowledges an interrupt before readiness without touching native sessions or models", async () => {
    const frames: PiWorkerFrame["message"][] = [];
    const identity = { workerId: "early-interrupt", generation: 1 };
    const operation = { operationId: "initialize-1", operationKind: "initialize" as const };
    const worker = makePiSdkWorker({
      identity,
      operation,
      sessionDirectory: "/must-not-be-opened",
      localTools: {},
      emit: async (bytes) => {
        frames.push(decodePiWorkerFrame(bytes.toString().slice(0, -1)).message);
      },
    });
    const run = worker.run();
    const parent = (
      sequence: number,
      message: Parameters<typeof encodePiParentFrame>[0]["message"],
    ) =>
      worker.acceptParent(
        encodePiParentFrame({ version: 1, ...identity, ...operation, sequence, message })
          .toString()
          .slice(0, -1),
      );
    parent(0, {
      type: "bootstrap",
      executionMode: "ordinary",
      expectedCwd: process.cwd(),
      native: null,
      context: { transferId: "context", totalBytes: 0 },
      prompt: null,
      model: {
        provider: "synthetic",
        modelId: "synthetic",
        api: "openai-completions",
        contextWindow: 32768,
        maxTokens: 512,
        reasoning: false,
      },
      allowedTools: [],
    });
    parent(1, { type: "interrupt", controlId: 1 });
    await expect(run).rejects.toThrow("CANCELED");
    await worker.dispose();
    expect(frames).toEqual([
      { type: "control-receipt", controlId: 1, kind: "interrupt" },
      { type: "worker-failure", code: "CANCELED" },
    ]);
  });
});

describe("Pi worker parent model stream", () => {
  it("produces the frozen subscription High and Standard request through the intercepted SDK", async () => {
    const frames: PiWorkerFrame["message"][] = [];
    const message = {
      type: "message",
      id: "synthetic-message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
    };
    const events = [
      {
        type: "response.created",
        response: { id: "synthetic-response", model: "gpt-6-luna", status: "in_progress" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        item_id: message.id,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        item_id: message.id,
        delta: "Done",
      },
      { type: "response.output_item.done", output_index: 0, item: message },
      {
        type: "response.completed",
        response: {
          id: "synthetic-response",
          model: "gpt-6-luna",
          status: "completed",
          output: [message],
          usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 },
        },
      },
    ]
      .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const bridge = makePiWorkerModelBridge({
      api: "openai-codex-responses",
      lifecycleId: () => 1,
      emit: async (frame) => {
        frames.push(frame);
        if (frame.type === "request") {
          bridge.accept({ type: "headers", requestId: frame.requestId, status: 200 }, 0);
          bridge.accept(
            {
              type: "chunk",
              requestId: frame.requestId,
              data: Buffer.from(events).toString("base64"),
            },
            1,
          );
        } else if (frame.type === "ack") {
          bridge.accept({ type: "end", requestId: frame.requestId }, 2);
        }
      },
    });
    const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-only" } })).toString("base64url")}.`;
    const result = await streamPiWorkerSubscription(
      {
        api: "openai-codex-responses",
        id: "gpt-6-luna",
        provider: "openai-codex",
        name: "Synthetic",
        baseUrl: "https://t3-worker.invalid/codex",
        reasoning: true,
        input: ["text"],
        contextWindow: 272_000,
        maxTokens: 2_048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      normalizeContext({
        systemPrompt: "Exact approved assignment",
        messages: [{ role: "user", content: "Investigate", timestamp: 0 }],
      }),
      {
        apiKey: token,
        fetch: bridge.fetch,
        reasoning: "low",
        transport: "auto",
        maxRetries: 3,
      },
    ).result();
    await bridge.drain();
    expect(result.stopReason).toBe("stop");
    expect(result.usage.totalTokens).toBe(9);
    const requests = frames.filter((frame) => frame.type === "request");
    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request?.type !== "request") throw Error("Missing intercepted SDK request");
    expect(JSON.parse(request.body)).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "high" },
      service_tier: "default",
    });
    expect(request.body).not.toContain(token);
    expect(request.body).not.toContain("synthetic-only");
  });
  const sdkControlContext = () => {
    const path = process.env.PI_WORKER_BODY_DIAGNOSTIC_SESSION;
    if (!path) return "x".repeat(6500);
    const fs = process.getBuiltinModule("fs");
    if (fs.statSync(path).size > 1048576) throw Error("Native context evidence exceeds its bound");
    const sessions = decodeDiagnosticSessions(fs.readFileSync(path, "utf8"));
    if (sessions.length !== 1 || !sessions[0])
      throw Error("Expected one retained native SDK session");
    for (const line of sessions[0].content.trim().split("\n")) {
      const entry = decodeDiagnosticEntry(line);
      if (entry.type !== "message" || entry.message?.role !== "user") continue;
      const content = decodeDiagnosticContent(entry.message.content);
      if (content.length !== 1 || !content[0]) throw Error("Expected exact initial native context");
      return content[0].text;
    }
    throw Error("Retained native initialization context missing");
  };
  it("carries the pinned SDK request through the parent bridge and joins accounting", async () => {
    const frames: PiWorkerFrame["message"][] = [];
    const methods: Array<string | undefined> = [];
    const body =
      [
        {
          choices: [
            { index: 0, delta: { role: "assistant", content: "Done" }, finish_reason: null },
          ],
        },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 },
        },
      ]
        .map((part) => `data: ${JSON.stringify(part)}\n\n`)
        .join("") + "data: [DONE]\n\n";
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        frames.push(message);
        if (message.type === "request") {
          bridge.accept({ type: "headers", requestId: message.requestId, status: 200 }, 0);
          bridge.accept(
            {
              type: "chunk",
              requestId: message.requestId,
              data: Buffer.from(body).toString("base64"),
            },
            1,
          );
        } else if (message.type === "ack") {
          bridge.accept({ type: "end", requestId: message.requestId }, 2);
        }
      },
      lifecycleId: () => 7,
    });
    const result = await streamSimple(
      {
        api: "openai-completions",
        id: "inclusionai/ling-3.1-flash:free",
        name: "Synthetic",
        provider: "command-code",
        baseUrl: "https://t3-worker.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 20000,
        maxTokens: 512,
        compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      },
      normalizeContext({
        systemPrompt: sdkControlContext(),
        messages: [{ role: "user", content: "Investigate current assignment", timestamp: 0 }],
      }),
      {
        apiKey: "synthetic-worker-key",
        env: {},
        maxRetries: 0,
        fetch: (url, init) => {
          methods.push(init?.method);
          return bridge.fetch(url, init);
        },
      },
    ).result();
    expect(methods).toEqual(["POST"]);
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "Done" }]);
    expect(result.usage.input).toBe(8);
    expect(result.usage.output).toBe(1);
    await bridge.drain();
    expect(frames).toEqual([
      expect.objectContaining({ type: "request", requestId: 1, lifecycleId: 7 }),
      { type: "ack", requestId: 1, chunkSequence: 1 },
    ]);
  });

  it("bounds the SDK body containing both initial native context and system context", async () => {
    const context = sdkControlContext().padEnd(PI_WORKER_MAX_REQUEST_BYTES / 2 + 1, "x");
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(PI_WORKER_MAX_REQUEST_BYTES);
    const frames: PiWorkerFrame["message"][] = [];
    const bodies: Array<{ bytes: number; method: string | undefined }> = [];
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        frames.push(message);
        throw Error("Unexpected admitted oversized SDK request");
      },
      lifecycleId: () => 1,
    });
    const result = await streamSimple(
      {
        api: "openai-completions",
        id: "inclusionai/ling-3.1-flash:free",
        name: "Synthetic",
        provider: "command-code",
        baseUrl: "https://t3-worker.invalid/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 20000,
        maxTokens: 512,
        compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
      },
      normalizeContext({
        systemPrompt: context,
        messages: [
          { role: "user", content: context, timestamp: 0 },
          { role: "user", content: "Investigate current assignment", timestamp: 1 },
        ],
      }),
      {
        apiKey: "synthetic-worker-key",
        env: {},
        maxRetries: 0,
        fetch: (url, init) => {
          if (typeof init?.body !== "string") throw Error("Missing captured SDK JSON body");
          bodies.push({ bytes: Buffer.byteLength(init.body), method: init.method });
          return bridge.fetch(url, init);
        },
      },
    ).result();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.method).toBe("POST");
    expect(bodies[0]?.bytes).toBeGreaterThan(PI_WORKER_MAX_REQUEST_BYTES);
    expect(result.stopReason).toBe("error");
    expect(frames).toEqual([]);
    await bridge.drain();
  });

  it.each(["GET", "get", "PATCH", "PoSt", "POST\n", "POST\r", ""])(
    "refuses non-pinned method %j before parent invocation",
    async (method) => {
      const frames: PiWorkerFrame["message"][] = [];
      const bridge = makePiWorkerModelBridge({
        emit: async (message) => {
          frames.push(message);
        },
        lifecycleId: () => 1,
      });
      await expect(
        bridge.fetch("https://t3-worker.invalid/v1/chat/completions", { method, body: "{}" }),
      ).rejects.toThrow("INVALID_MODEL_REQUEST");
      expect(frames).toEqual([]);
    },
  );

  it("keeps native stream open until the actual parent accounting end", async () => {
    const frames: PiWorkerFrame["message"][] = [];
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        frames.push(message);
      },
      lifecycleId: () => 7,
    });
    const responsePromise = bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
      method: "POST",
      body: '{"model":"synthetic","messages":[]}',
    });
    bridge.accept({ type: "headers", requestId: 1, status: 200 }, 0);
    const reader = (await responsePromise).body!.getReader();
    const read = reader.read();
    bridge.accept(
      { type: "chunk", requestId: 1, data: Buffer.from("data: [DONE]\n\n").toString("base64") },
      1,
    );
    const chunk = await read;
    expect(chunk.done).toBe(false);
    expect(Buffer.from(chunk.value!).toString()).toBe("data: [DONE]\n\n");
    let closed = false;
    const finalRead = reader.read().then((value) => {
      closed = true;
      return value;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(frames).toContainEqual({ type: "ack", requestId: 1, chunkSequence: 1 });
    bridge.accept({ type: "end", requestId: 1 }, 2);
    expect(await finalRead).toEqual({ value: undefined, done: true });
    await bridge.drain();
  });

  it("fails a stream on parent accounting error after native finish bytes", async () => {
    const bridge = makePiWorkerModelBridge({ emit: async () => {}, lifecycleId: () => 1 });
    const responsePromise = bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    bridge.accept({ type: "headers", requestId: 1, status: 200 }, 0);
    const reader = (await responsePromise).body!.getReader();
    bridge.accept({ type: "error", requestId: 1, code: "ACCOUNTING_FAILURE" }, 1);
    await expect(reader.read()).rejects.toThrow("ACCOUNTING_FAILURE");
    await expect(bridge.drain()).rejects.toThrow("ACCOUNTING_FAILURE");
  });

  it("retains the accounting barrier when the native SSE parser closes its reader", async () => {
    const bridge = makePiWorkerModelBridge({ emit: async () => {}, lifecycleId: () => 1 });
    const responsePromise = bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    bridge.accept({ type: "headers", requestId: 1, status: 200 }, 0);
    await (await responsePromise).body!.cancel();
    let accounted = false;
    const drained = bridge.drain().then(() => {
      accounted = true;
    });
    await Promise.resolve();
    expect(accounted).toBe(false);
    bridge.accept({ type: "end", requestId: 1 }, 1);
    await drained;
    expect(accounted).toBe(true);
  });

  it("waits for the exact final ACK write receipt before reporting a drained request", async () => {
    const ack = Promise.withResolvers<void>();
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        if (message.type === "ack") await ack.promise;
      },
      lifecycleId: () => 1,
    });
    const responsePromise = bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    bridge.accept({ type: "headers", requestId: 1, status: 200 }, 0);
    const reader = (await responsePromise).body!.getReader();
    const read = reader.read();
    bridge.accept(
      { type: "chunk", requestId: 1, data: Buffer.from("final").toString("base64") },
      1,
    );
    await read;
    bridge.accept({ type: "end", requestId: 1 }, 2);
    let drained = false;
    const drain = bridge.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    ack.resolve();
    await drain;
    expect(drained).toBe(true);
  });

  it("captures request lifecycle before awaiting preceding accounting", async () => {
    let lifecycle = 1;
    const requests: unknown[] = [];
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        requests.push(message);
      },
      lifecycleId: () => lifecycle,
    });
    const first = bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    bridge.accept({ type: "headers", requestId: 1, status: 200 }, 0);
    await first;
    lifecycle = 2;
    const second = bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    lifecycle = 99;
    bridge.accept({ type: "end", requestId: 1 }, 1);
    await bridge.drain();
    await Promise.resolve();
    expect(requests.at(-1)).toMatchObject({ type: "request", requestId: 2, lifecycleId: 2 });
    bridge.accept({ type: "headers", requestId: 2, status: 200 }, 2);
    await second;
    bridge.accept({ type: "end", requestId: 2 }, 3);
    await bridge.drain();
  });

  it("does not ACK a chunk until the native reader consumes it", async () => {
    const frames: PiWorkerFrame["message"][] = [];
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        frames.push(message);
      },
      lifecycleId: () => 1,
    });
    const responsePromise = bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    bridge.accept({ type: "headers", requestId: 1, status: 200 }, 0);
    const response = await responsePromise;
    bridge.accept(
      { type: "chunk", requestId: 1, data: Buffer.from("bounded").toString("base64") },
      1,
    );
    await Promise.resolve();
    expect(frames.some((message) => message.type === "ack")).toBe(false);
    await response.body!.getReader().read();
    await Promise.resolve();
    expect(frames).toContainEqual({ type: "ack", requestId: 1, chunkSequence: 1 });
    bridge.accept({ type: "end", requestId: 1 }, 2);
    await bridge.drain();
  });

  it("brokers the configured Codex Responses endpoint and decoded JSON body without headers", async () => {
    const frames: PiWorkerFrame["message"][] = [];
    const bridge = makePiWorkerModelBridge({
      api: "openai-codex-responses",
      emit: async (message) => {
        frames.push(message);
        if (message.type === "request") {
          bridge.accept({ type: "headers", requestId: message.requestId, status: 200 }, 0);
          bridge.accept({ type: "end", requestId: message.requestId }, 1);
        }
      },
      lifecycleId: () => 4,
    });
    const body = JSON.stringify({ model: "gpt-6-luna", input: [{ role: "user", content: "hi" }] });
    const response = await bridge.fetch("https://t3-worker.invalid/codex/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-only",
        "chatgpt-account-id": "synthetic-account-only",
        "openai-beta": "responses=experimental",
      },
      body,
    });
    await response.body?.cancel();
    await bridge.drain();

    expect(frames).toEqual([{ type: "request", requestId: 1, lifecycleId: 4, body }]);
    const request = frames[0];
    if (request?.type !== "request") throw Error("Expected the bridged subscription request");
    expect(JSON.parse(request.body)).toEqual({
      model: "gpt-6-luna",
      input: [{ role: "user", content: "hi" }],
    });
  });

  it.skipIf(!zstdCompressor())(
    "decompresses a bounded zstd Codex request before crossing the parent bridge",
    async () => {
      const frames: PiWorkerFrame["message"][] = [];
      const bridge = makePiWorkerModelBridge({
        api: "openai-codex-responses",
        emit: async (message) => {
          frames.push(message);
          if (message.type === "request") {
            bridge.accept({ type: "headers", requestId: message.requestId, status: 200 }, 0);
            bridge.accept({ type: "end", requestId: message.requestId }, 1);
          }
        },
        lifecycleId: () => 5,
      });
      const body = JSON.stringify({
        model: "gpt-6-luna",
        input: [{ role: "user", content: "compressed" }],
      });
      const compressed = zstdCompressor()?.(Buffer.from(body));
      if (!compressed) throw Error("zstd compressor is unavailable");
      const response = await bridge.fetch("https://t3-worker.invalid/codex/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-encoding": "zstd",
        },
        body: compressed,
      });
      await response.body?.cancel();
      await bridge.drain();
      expect(frames).toEqual([{ type: "request", requestId: 1, lifecycleId: 5, body }]);
    },
  );

  it.each([
    ["Completions endpoint", "https://t3-worker.invalid/v1/chat/completions"],
    ["external endpoint", "https://example.com/codex/responses"],
    ["query-bearing endpoint", "https://t3-worker.invalid/codex/responses?alternate=1"],
    ["noncanonical endpoint", "https://t3-worker.invalid/codex/responses/"],
  ])("rejects the %s before emitting a parent request", async (_case, url) => {
    const frames: PiWorkerFrame["message"][] = [];
    const bridge = makePiWorkerModelBridge({
      api: "openai-codex-responses",
      emit: async (message) => {
        frames.push(message);
      },
      lifecycleId: () => 1,
    });
    await expect(
      bridge.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ).rejects.toThrow("INVALID_MODEL_REQUEST");
    expect(frames).toEqual([]);
  });

  it.each([
    ["unsupported method", { method: "GET", headers: { "content-type": "application/json" } }],
    ["wrong content type", { method: "POST", headers: { "content-type": "text/plain" } }],
    [
      "wrong encoding",
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
      },
    ],
  ])("rejects a Codex request with %s before emitting it", async (_case, init) => {
    const frames: PiWorkerFrame["message"][] = [];
    const bridge = makePiWorkerModelBridge({
      api: "openai-codex-responses",
      emit: async (message) => {
        frames.push(message);
      },
      lifecycleId: () => 1,
    });
    await expect(
      bridge.fetch("https://t3-worker.invalid/codex/responses", { ...init, body: "{}" }),
    ).rejects.toThrow("INVALID_MODEL_REQUEST");
    expect(frames).toEqual([]);
  });

  it("rejects oversized compressed and uncompressed Codex request bodies before emitting", async () => {
    const frames: PiWorkerFrame["message"][] = [];
    const bridge = makePiWorkerModelBridge({
      api: "openai-codex-responses",
      emit: async (message) => {
        frames.push(message);
      },
      lifecycleId: () => 1,
    });
    const url = "https://t3-worker.invalid/codex/responses";
    await expect(
      bridge.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "x".repeat(PI_WORKER_MAX_REQUEST_BYTES + 1),
      }),
    ).rejects.toThrow("INVALID_MODEL_REQUEST");
    const compress = zstdCompressor();
    if (compress) {
      const expanded = Buffer.from("x".repeat(PI_WORKER_MAX_REQUEST_BYTES + 1));
      await expect(
        bridge.fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-encoding": "zstd",
          },
          body: compress(expanded),
        }),
      ).rejects.toThrow("INVALID_MODEL_REQUEST");
    }
    expect(frames).toEqual([]);
  });

  it("rejects an external URL before emitting a parent request", async () => {
    const frames: unknown[] = [];
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        frames.push(message);
      },
      lifecycleId: () => 1,
    });
    await expect(
      bridge.fetch("https://example.com", { method: "POST", body: "{}" }),
    ).rejects.toThrow("INVALID_MODEL_REQUEST");
    expect(frames).toEqual([]);
  });

  it("rejects an oversized native body without truncation or parent invocation", async () => {
    const frames: unknown[] = [];
    const bridge = makePiWorkerModelBridge({
      emit: async (message) => {
        frames.push(message);
      },
      lifecycleId: () => 1,
    });
    await expect(
      bridge.fetch("https://t3-worker.invalid/v1/chat/completions", {
        method: "POST",
        body: "x".repeat(PI_WORKER_MAX_REQUEST_BYTES + 1),
      }),
    ).rejects.toThrow("INVALID_MODEL_REQUEST");
    expect(frames).toEqual([]);
  });
});

describe("Pi SDK text projection", () => {
  it("preserves BOM and multibyte codepoints across bounded delta splits", () => {
    const text = "\uFEFF" + "a".repeat(8190) + "🧪".repeat(4097);
    const parts = splitPiWorkerText(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((part) => Buffer.byteLength(part) <= 8192)).toBe(true);
    expect(parts.some((part) => part.includes("\uFFFD"))).toBe(false);
  });

  it("rejects invalid surrogate text before projection", () => {
    expect(() => splitPiWorkerText("broken\uD800")).toThrow("INVALID_TEXT");
  });

  it("preserves heavily escaped text within actual encoded frame budgets", () => {
    const text = "\u0000".repeat(5000) + '\n\\"'.repeat(2000);
    const parts = splitPiWorkerText(text);
    expect(parts.join("")).toBe(text);
    expect(() => {
      for (const part of parts)
        encodePiWorkerFrame({
          version: 1,
          workerId: "w".repeat(128),
          generation: Number.MAX_SAFE_INTEGER,
          operationId: "o".repeat(128),
          operationKind: "prompt",
          sequence: Number.MAX_SAFE_INTEGER,
          message: {
            type: "sdk-event",
            lifecycleId: Number.MAX_SAFE_INTEGER,
            event: { type: "text_delta", text: part },
          },
        });
    }).not.toThrow();
  });
});
