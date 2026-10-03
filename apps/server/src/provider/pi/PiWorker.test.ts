import { describe, expect, it, vi } from "vite-plus/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  makePiWorkerModelBridge,
  makePiWorkerSettings,
  makePiSdkWorker,
  splitPiWorkerText,
} from "./PiWorker.ts";
import {
  encodePiWorkerFrame,
  decodePiWorkerFrame,
  encodePiParentFrame,
  type PiWorkerFrame,
  type PiWorkerBootstrap,
} from "./PiWorkerProtocol.ts";

describe("Pinned Pi worker effective settings", () => {
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
        body: "x".repeat(12289),
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
