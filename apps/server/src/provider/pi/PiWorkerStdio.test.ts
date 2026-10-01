// @effect-diagnostics nodeBuiltinImport:off - Native Node streams and captured child handles prove the private stdio boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { makePiWorkerStdioTransport } from "./PiWorkerStdio.ts";
import {
  encodePiParentFrame,
  decodePiWorkerFrame,
  makePiWorkerLineFramer,
} from "./PiWorkerProtocol.ts";

const input = () => new NodeStream.PassThrough();
const output = (write?: NodeStream.WritableOptions["write"]) =>
  new NodeStream.Writable({ write: write ?? ((_bytes, _encoding, callback) => callback()) });
const write = (stream: NodeStream.Writable, bytes: Uint8Array) =>
  new Promise<void>((resolve, reject) =>
    stream.write(bytes, (error) => (error ? reject(error) : resolve())),
  );
const events = ["error", "close", "finish", "data", "drain", "readable"];
const listeners = (stream: NodeStream.Stream) => events.map((event) => stream.listenerCount(event));

const decodeReceipt = Schema.decodeUnknownSync(
  Schema.Struct({
    type: Schema.String,
    ok: Schema.optional(Schema.Boolean),
    code: Schema.optional(Schema.String),
    pid: Schema.optional(Schema.Finite),
    node: Schema.optional(Schema.String),
    remoteCalls: Schema.optional(Schema.Finite),
    workerEntries: Schema.optional(Schema.Finite),
    hostImports: Schema.optional(Schema.Finite),
    readerUnchanged: Schema.optional(Schema.Boolean),
    flowUnchanged: Schema.optional(Schema.Boolean),
    rawOutputEmitClose: Schema.optional(Schema.Boolean),
    inputEmitClose: Schema.optional(Schema.Boolean),
    outputEmitClose: Schema.optional(Schema.Boolean),
    returned: Schema.optional(Schema.Boolean),
    outputPending: Schema.optional(Schema.Boolean),
    inputClosed: Schema.optional(Schema.Boolean),
    outputClosed: Schema.optional(Schema.Boolean),
    rawInputDestroyed: Schema.optional(Schema.Boolean),
    rawOutputDestroyed: Schema.optional(Schema.Boolean),
    disposeRejected: Schema.optional(Schema.Boolean),
    readableBytes: Schema.optional(Schema.Finite),
    writableBytes: Schema.optional(Schema.Finite),
    listeners: Schema.optional(Schema.Array(Schema.Array(Schema.Finite))),
    baseline: Schema.optional(Schema.Array(Schema.Array(Schema.Finite))),
  }),
);

async function childFixture(mode: string, sessionDirectory = "/unused") {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--max-old-space-size=128",
      new URL("./fixtures/p7-worker-stdio-child.mjs", import.meta.url).pathname,
      mode,
      sessionDirectory,
    ],
    {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { PATH: "", PI_CODING_AGENT_DIR: sessionDirectory },
    },
  );
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    await spawned;
  } catch (error) {
    await closed;
    throw error;
  }
  const { stdin, stdout, stderr: stderrPipe } = child;
  if (!stdin || !stdout || !stderrPipe) {
    child.kill("SIGKILL");
    await closed;
    throw Error("CHILD_PIPE_UNAVAILABLE");
  }
  const receipt = Promise.withResolvers<void>();
  const messages: ReturnType<typeof decodeReceipt>[] = [];
  const observed: ReturnType<typeof decodeReceipt>[] = [];
  let next = receipt;
  child.on("message", (value) => {
    const message = decodeReceipt(value);
    messages.push(message);
    observed.push(message);
    next.resolve();
    next = Promise.withResolvers<void>();
  });
  stdin.on("error", () => {});
  let stderr = "";
  stderrPipe.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(0, 65536);
  });
  const wait = async (type: string) => {
    while (true) {
      const index = messages.findIndex((message) => message.type === type);
      if (index !== -1) return messages.splice(index, 1)[0]!;
      const arrived = next.promise;
      await Promise.race([
        arrived,
        closed.then(() => {
          throw Error(`CHILD_CLOSED_BEFORE_${type}: ${stderr}`);
        }),
      ]);
    }
  };
  return {
    child,
    stdin,
    stdout,
    stderrPipe,
    wait,
    closed,
    async send(value: string) {
      await new Promise<void>((resolve, reject) =>
        child.send(value, (error) => (error ? reject(error) : resolve())),
      );
    },
    async cleanup() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const exit = await closed;
      expect(stdin.closed).toBe(true);
      expect(stdout.closed).toBe(true);
      expect(stderrPipe.closed).toBe(true);
      const evidence = process.env.PI_WORKER_STDIO_EVIDENCE_DIRECTORY;
      if (evidence)
        await NodeFSP.writeFile(
          NodePath.join(evidence, `${mode}-${child.pid}.json`),
          JSON.stringify(
            {
              pid: child.pid,
              mode,
              exit,
              observed,
              pipeClosed: [stdin.closed, stdout.closed, stderrPipe.closed],
              stdoutEnded: stdout.readableEnded,
              stderrEnded: stderrPipe.readableEnded,
              stderr,
            },
            null,
            2,
          ),
        );
    },
    stderr: () => stderr,
  };
}

describe("Pi borrowed stdio native wrappers", () => {
  it("owns only wrappers and restores borrowed listeners with idempotent joined disposal", async () => {
    const source = input();
    const sink = output();
    const before = [listeners(source), listeners(sink)];
    const transport = makePiWorkerStdioTransport({ input: source, output: sink });
    expect(transport.input).not.toBe(source);
    expect(transport.output).not.toBe(sink);
    const first = transport.dispose();
    expect(transport.dispose()).toBe(first);
    await first;
    expect(transport.input.closed).toBe(true);
    expect(transport.output.closed).toBe(true);
    expect(source.destroyed).toBe(false);
    expect(sink.destroyed).toBe(false);
    expect([listeners(source), listeners(sink)]).toEqual(before);
    source.destroy();
    sink.destroy();
  });

  it("does not finish disposal while the borrowed write callback is held", async () => {
    const source = input();
    const entered = Promise.withResolvers<void>();
    let release: ((error?: Error | null) => void) | undefined;
    const sink = output((_bytes, _encoding, callback) => {
      release = callback;
      entered.resolve();
    });
    const transport = makePiWorkerStdioTransport({ input: source, output: sink });
    const written = write(transport.output, Buffer.from("held"));
    await entered.promise;
    let done = false;
    const disposed = transport.dispose().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(transport.output.closed).toBe(false);
    release?.();
    await written;
    await disposed;
    expect(source.destroyed).toBe(false);
    expect(sink.destroyed).toBe(false);
    source.destroy();
    sink.destroy();
  });

  it("joins the native failed-write error receipt without leaking an unhandled error", async () => {
    const source = input();
    const error = Error("SYNTHETIC_WRITE_FAILURE");
    const sink = output((_bytes, _encoding, callback) => callback(error));
    const transport = makePiWorkerStdioTransport({ input: source, output: sink });
    await expect(write(transport.output, Buffer.from("failure"))).rejects.toBe(error);
    await expect(transport.dispose()).rejects.toBe(error);
    expect(transport.input.closed).toBe(true);
    expect(transport.output.closed).toBe(true);
    source.destroy();
  });

  it("joins a source fault while an unrelated borrowed output callback remains pending", async () => {
    const source = input();
    const entered = Promise.withResolvers<void>();
    let release: (() => void) | undefined;
    const sink = output((_bytes, _encoding, callback) => {
      release = callback;
      entered.resolve();
    });
    const transport = makePiWorkerStdioTransport({ input: source, output: sink });
    const written = write(transport.output, Buffer.from("held"));
    written.catch(() => {});
    await entered.promise;
    const error = Error("SYNTHETIC_INPUT_FAILURE");
    const failed = new Promise<void>((resolve) => source.once("error", () => resolve()));
    source.destroy(error);
    await failed;
    const disposed = transport.dispose();
    disposed.catch(() => {});
    await Promise.resolve();
    expect(transport.output.closed).toBe(false);
    expect(sink.destroyed).toBe(false);
    release?.();
    await expect(written).rejects.toBe(error);
    await expect(disposed).rejects.toBe(error);
    expect(transport.input.closed).toBe(true);
    expect(transport.output.closed).toBe(true);
    sink.destroy();
  });

  it("fails an over-bound borrowed chunk and closes only the wrappers", async () => {
    const source = input();
    const sink = output();
    const transport = makePiWorkerStdioTransport({ input: source, output: sink });
    const failed = new Promise<Error>((resolve) => transport.input.once("error", resolve));
    source.write(Buffer.alloc(131073));
    expect((await failed).message).toBe("STDIO_INPUT_CHUNK_LIMIT");
    await expect(transport.dispose()).rejects.toThrow("STDIO_INPUT_CHUNK_LIMIT");
    expect(source.destroyed).toBe(false);
    expect(sink.destroyed).toBe(false);
    source.destroy();
    sink.destroy();
  });

  it("rejects a passive readable observer without changing its manual-reader ownership", async () => {
    const source = input();
    const sink = output();
    const observed = Promise.withResolvers<void>();
    const observer = () => observed.resolve();
    source.on("readable", observer);
    const before = [listeners(source), listeners(sink)];
    const flow = source.readableFlowing;
    let transport: ReturnType<typeof makePiWorkerStdioTransport> | undefined;
    try {
      expect(() => {
        transport = makePiWorkerStdioTransport({ input: source, output: sink });
      }).toThrow("STDIO_UNAVAILABLE");
      expect([listeners(source), listeners(sink)]).toEqual(before);
      expect(source.listeners("readable")).toEqual([observer]);
      expect(source.readableFlowing).toBe(flow);
      expect(source.destroyed).toBe(false);
      expect(sink.destroyed).toBe(false);
      const bytes = Buffer.from("still owned by the manual reader");
      source.write(bytes);
      await observed.promise;
      expect(source.readableLength).toBe(bytes.length);
      expect(source.read()).toEqual(bytes);
    } finally {
      await transport?.dispose();
      source.destroy();
      sink.destroy();
    }
  });

  it("rejects unavailable borrowed streams before attaching or changing their listeners", async () => {
    const source = input();
    const sink = output();
    source.setEncoding("utf8");
    const before = [listeners(source), listeners(sink)];
    expect(() => makePiWorkerStdioTransport({ input: source, output: sink })).toThrow(
      "STDIO_UNAVAILABLE",
    );
    expect([listeners(source), listeners(sink)]).toEqual(before);
    expect(source.destroyed).toBe(false);
    expect(sink.destroyed).toBe(false);
    source.destroy();
    sink.destroy();
  });
});

describe("Pi actual spawned Node stdio", () => {
  it("echoes byte-exact input through real process globals and drains the captured child", async () => {
    const f = await childFixture("echo");
    const chunks: Buffer[] = [];
    f.stdout.on("data", (bytes: Buffer) => chunks.push(bytes));
    try {
      const ready = await f.wait("ready");
      expect(ready.node).toMatch(/^24\./);
      expect(ready.pid).toBe(f.child.pid);
      expect(ready.rawOutputEmitClose).toBe(false);
      expect(ready.inputEmitClose).toBe(true);
      expect(ready.outputEmitClose).toBe(true);
      const bytes = Buffer.from("exact bounded stdin \u03bb\n");
      await write(f.stdin, bytes);
      f.stdin.end();
      const result = await f.wait("result");
      expect(result.ok).toBe(true);
      expect(result.remoteCalls).toBe(0);
      expect(result.listeners).toEqual(result.baseline);
      expect(result.rawOutputDestroyed).toBe(false);
      expect(await f.closed).toEqual({ code: 0, signal: null });
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(f.stdout.readableEnded).toBe(true);
      expect(f.stderrPipe.readableEnded).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("bounds paused input buffering then drains after an explicit reader-release receipt", async () => {
    const f = await childFixture("input-held");
    const chunks: Buffer[] = [];
    f.stdout.on("data", (bytes: Buffer) => chunks.push(bytes));
    try {
      await f.wait("ready");
      const bytes = Buffer.alloc(524288, 120);
      const sent = write(f.stdin, bytes);
      sent.catch(() => {});
      const paused = await f.wait("input-paused");
      expect(paused.readableBytes).toBeLessThanOrEqual(131072);
      expect(paused.writableBytes).toBeLessThanOrEqual(131072);
      await f.send("release");
      await sent;
      f.stdin.end();
      expect((await f.wait("result")).ok).toBe(true);
      expect(await f.closed).toEqual({ code: 0, signal: null });
      expect(Buffer.concat(chunks)).toEqual(bytes);
    } finally {
      await f.cleanup();
    }
  });

  it("accepts input while actual stdout is backpressured and finishes only after pipe drain", async () => {
    const f = await childFixture("pressure");
    let byteCount = 0;
    try {
      await f.wait("ready");
      await f.wait("output-pending");
      await write(f.stdin, Buffer.from("control-during-output"));
      await f.wait("input");
      await f.send("snapshot");
      const snapshot = await f.wait("snapshot");
      expect(snapshot.returned).toBe(false);
      expect(snapshot.outputPending).toBe(true);
      f.stdout.on("data", (bytes: Buffer) => {
        byteCount += bytes.length;
      });
      f.stdin.end();
      expect((await f.wait("result")).ok).toBe(true);
      expect(await f.closed).toEqual({ code: 0, signal: null });
      expect(byteCount).toBe(4194304);
    } finally {
      await f.cleanup();
    }
  });

  it("handles actual parent stdout closure and EPIPE with joined failure", async () => {
    const f = await childFixture("broken-output");
    try {
      await f.wait("ready");
      const closed = new Promise<void>((resolve) => f.stdout.once("close", resolve));
      f.stdout.destroy();
      await closed;
      await f.send("release");
      const result = await f.wait("result");
      expect(result.ok).toBe(false);
      expect(result.code).toMatch(/EPIPE|STDIO_OUTPUT/);
      expect(result.inputClosed).toBe(true);
      expect(result.outputClosed).toBe(true);
      expect(result.disposeRejected).toBe(true);
      expect(await f.closed).toEqual({ code: 1, signal: null });
      expect(f.stderr()).not.toContain("Unhandled");
    } finally {
      await f.cleanup();
    }
  });

  it("preserves the host's pending worker-disposal barrier in an actual child", async () => {
    const f = await childFixture("host-dispose-held");
    f.stdout.resume();
    try {
      await f.wait("ready");
      await write(f.stdin, Buffer.from("{}\n"));
      await f.wait("dispose-held");
      await f.send("snapshot");
      expect((await f.wait("snapshot")).returned).toBe(false);
      await f.send("release");
      expect((await f.wait("result")).ok).toBe(true);
      expect(await f.closed).toEqual({ code: 0, signal: null });
    } finally {
      await f.cleanup();
    }
  });

  for (const bytes of ["", "partial"]) {
    it(`rejects actual parent EOF with ${bytes ? "partial framing" : "no bootstrap"}`, async () => {
      const f = await childFixture("host-eof");
      f.stdout.resume();
      try {
        await f.wait("ready");
        f.stdin.end(bytes);
        const result = await f.wait("result");
        expect(result.ok).toBe(false);
        expect(result.code).toMatch(/PARENT_EOF|INCOMPLETE_FRAME/);
        expect(result.inputClosed).toBe(true);
        expect(result.outputClosed).toBe(true);
        expect(await f.closed).toEqual({ code: 1, signal: null });
      } finally {
        await f.cleanup();
      }
    });
  }

  it("rejects an existing default-stdin readable observer before host or SDK worker entry", async () => {
    const f = await childFixture("readable-admission");
    f.stdout.resume();
    try {
      const result = await f.wait("result");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("STDIO_UNAVAILABLE");
      expect(result.hostImports).toBe(0);
      expect(result.workerEntries).toBe(0);
      expect(result.remoteCalls).toBe(0);
      expect(result.readerUnchanged).toBe(true);
      expect(result.flowUnchanged).toBe(true);
      expect(result.listeners).toEqual(result.baseline);
      expect(result.rawInputDestroyed).toBe(false);
      expect(result.rawOutputDestroyed).toBe(false);
      f.stdin.end();
      expect(await f.closed).toEqual({ code: 1, signal: null });
      expect(f.stderr()).toBe("");
    } finally {
      await f.cleanup();
    }
  });

  it("rejects the actual raw stdout before invoking a worker", async () => {
    const f = await childFixture("raw-admission");
    f.stdout.resume();
    try {
      const result = await f.wait("result");
      expect(result.ok).toBe(false);
      expect(result.code).toContain("native emitClose must be true");
      expect(result.workerEntries).toBe(0);
      expect(result.rawInputDestroyed).toBe(false);
      expect(result.rawOutputDestroyed).toBe(false);
      expect(result.remoteCalls).toBe(0);
      expect(await f.closed).toEqual({ code: 1, signal: null });
    } finally {
      await f.cleanup();
    }
  });

  it("joins actual host and SDK cancellation while awaiting bootstrap", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-stdio-cancel-"));
    const f = await childFixture("sdk-cancel", directory);
    const framer = makePiWorkerLineFramer((raw) => {
      decodePiWorkerFrame(raw);
    });
    f.stdout.on("data", (bytes: Buffer) => framer.push(bytes));
    try {
      await f.wait("ready");
      await f.wait("host-started");
      await f.send("cancel");
      const result = await f.wait("result");
      expect(result.ok).toBe(false);
      expect(result.code).toBe("FIXTURE_CANCELED");
      expect(result.remoteCalls).toBe(0);
      expect(result.inputClosed).toBe(true);
      expect(result.outputClosed).toBe(true);
      expect(await f.closed).toEqual({ code: 1, signal: null });
      framer.finish();
    } finally {
      await f.cleanup();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("initializes the actual pinned SDK through the approved host without any model call", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-stdio-sdk-"));
    const f = await childFixture("sdk-initialize", directory);
    const frames: ReturnType<typeof decodePiWorkerFrame>[] = [];
    const terminal = Promise.withResolvers<void>();
    const framer = makePiWorkerLineFramer((raw) => {
      const frame = decodePiWorkerFrame(raw);
      frames.push(frame);
      if (frame.message.type === "initialized") {
        terminal.resolve();
        f.stdin.end();
      }
    });
    f.stdout.on("data", (bytes: Buffer) => framer.push(bytes));
    try {
      await f.wait("ready");
      const context = "No inference: bounded authoritative initialization.";
      const send = (
        sequence: number,
        message: Parameters<typeof encodePiParentFrame>[0]["message"],
      ) =>
        write(
          f.stdin,
          encodePiParentFrame({
            version: 1,
            workerId: "stdio-child",
            generation: 1,
            operationId: "stdio-initialize",
            operationKind: "initialize",
            sequence,
            message,
          }),
        );
      await send(0, {
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
      });
      await send(1, {
        type: "transfer-chunk",
        transferId: "context",
        index: 0,
        offset: 0,
        data: Buffer.from(context).toString("base64"),
      });
      await send(2, { type: "transfer-end", transferId: "context" });
      const result = await f.wait("result");
      expect(result.ok).toBe(true);
      expect(result.remoteCalls).toBe(0);
      await terminal.promise;
      expect(await f.closed).toEqual({ code: 0, signal: null });
      framer.finish();
      expect(frames.map((frame) => frame.sequence)).toEqual([0, 1]);
      expect(frames.map((frame) => frame.message.type)).toEqual(["ready", "initialized"]);
      expect(frames.some((frame) => frame.message.type === "request")).toBe(false);
      const last = frames.at(-1)?.message;
      if (!last || last.type !== "initialized") throw Error("NO_NATIVE_RECEIPT");
      const native = await NodeFSP.readFile(
        NodePath.join(directory, last.native.sessionReference.slice(9)),
        "utf8",
      );
      expect(native).toContain(context);
      expect(last.native.persisted).toBe(true);
    } finally {
      await f.cleanup();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
