import * as NodeStreamPromises from "node:stream/promises";
import { makePiWorkerStdioTransport } from "../PiWorkerStdio.ts";
import { encodePiWorkerFrame } from "../PiWorkerProtocol.ts";

const [mode, sessionDirectory] = process.argv.slice(2);
let remoteCalls = 0;
globalThis.fetch = async () => {
  remoteCalls++;
  throw Error("NETWORK_FORBIDDEN");
};
const notify = (value) =>
  new Promise((resolve, reject) => {
    if (!process.send) return reject(Error("FIXTURE_IPC_REQUIRED"));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
const release = Promise.withResolvers();
let transport;
let returned = false;
let workerEntries = 0;
let hostImports = 0;
const passiveObserver = () => {};
if (mode === "readable-admission") process.stdin.on("readable", passiveObserver);
const initialInputFlow = process.stdin.readableFlowing;
const cancellation = new AbortController();
process.on("message", async (message) => {
  if (message === "release") release.resolve();
  if (message === "cancel") cancellation.abort(Error("FIXTURE_CANCELED"));
  if (message === "snapshot")
    await notify({
      type: "snapshot",
      returned,
      inputClosed: transport?.input.closed,
      outputClosed: transport?.output.closed,
      inputPaused: process.stdin.readableFlowing === false,
      outputPending: transport?.output.writableLength > 0,
    });
});
const baseline = [process.stdin, process.stdout].map((stream) =>
  ["error", "close", "finish", "data", "drain", "readable"].map((event) =>
    stream.listenerCount(event),
  ),
);
try {
  if (mode === "raw-admission") {
    hostImports++;
    const { runPiWorkerHost } = await import("../PiWorkerHost.ts");
    await runPiWorkerHost({
      identity: { workerId: "raw", generation: 1 },
      operation: { operationId: "raw", operationKind: "initialize" },
      sessionDirectory,
      localTools: {},
      input: process.stdin,
      output: process.stdout,
      makeWorker() {
        workerEntries++;
        throw Error("UNEXPECTED_WORKER_ENTRY");
      },
    });
    throw Error("UNEXPECTED_RAW_ADMISSION");
  }
  transport = makePiWorkerStdioTransport();
  await notify({
    type: "ready",
    pid: process.pid,
    node: process.versions.node,
    rawInputEmitClose: process.stdin._readableState.emitClose,
    rawOutputEmitClose: process.stdout._writableState.emitClose,
    inputEmitClose: transport.input._readableState.emitClose,
    outputEmitClose: transport.output._writableState.emitClose,
  });
  if (mode === "echo" || mode === "input-held") {
    if (mode === "input-held") {
      process.stdin.on("pause", function paused() {
        if (transport.input.readableLength === 0) return;
        process.stdin.removeListener("pause", paused);
        void notify({
          type: "input-paused",
          readableBytes: transport.input.readableLength,
          writableBytes: transport.input.writableLength,
        });
      });
      await release.promise;
    }
    for await (const bytes of transport.input)
      await new Promise((resolve, reject) =>
        transport.output.write(bytes, (error) => (error ? reject(error) : resolve())),
      );
    transport.output.end();
    await NodeStreamPromises.finished(transport.output, { cleanup: true, readable: false });
  } else if (mode === "pressure" || mode === "broken-output") {
    const read = (async () => {
      for await (const bytes of transport.input)
        await notify({ type: "input", bytes: bytes.length });
    })();
    read.catch(() => {});
    if (mode === "broken-output") await release.promise;
    // Transport-only control: exceed the actual pipe capacity in one write.
    // The independent host/SDK case retains the protocol frame bound.
    const bytes = Buffer.alloc(4194304, 120);
    for (let index = 0; index < 1; index++) {
      let callbackDone = false;
      const written = new Promise((resolve, reject) =>
        transport.output.write(bytes, (error) => {
          callbackDone = true;
          if (error) reject(error);
          else resolve();
        }),
      );
      written.catch(() => {});
      if (process.stdout.writableNeedDrain && !callbackDone)
        await notify({ type: "output-pending", index });
      await written;
    }
    await read;
    transport.output.end();
    await NodeStreamPromises.finished(transport.output, { cleanup: true, readable: false });
  } else {
    hostImports++;
    const { runPiWorkerHost } = await import("../PiWorkerHost.ts");
    const identity = { workerId: "stdio-child", generation: 1 };
    const operation = { operationId: "stdio-initialize", operationKind: "initialize" };
    const started = Promise.withResolvers();
    const aborted = Promise.withResolvers();
    const running = runPiWorkerHost({
      identity,
      operation,
      sessionDirectory,
      localTools: {},
      input: transport.input,
      output: transport.output,
      signal: cancellation.signal,
      ...(mode === "sdk-initialize" || mode === "sdk-cancel"
        ? {}
        : {
            makeWorker: (options) => {
              workerEntries++;
              if (mode === "readable-admission") throw Error("UNEXPECTED_WORKER_ENTRY");
              return {
                acceptParent() {
                  started.resolve();
                },
                abort() {
                  aborted.resolve();
                },
                async run() {
                  await Promise.race([started.promise, aborted.promise]);
                  if (mode === "host-eof") {
                    await aborted.promise;
                    throw Error("WORKER_ABORTED");
                  }
                  await options.emit(
                    encodePiWorkerFrame({
                      version: 1,
                      ...identity,
                      ...operation,
                      sequence: 0,
                      message: {
                        type: "initialized",
                        native: {
                          sessionId: "synthetic",
                          sessionReference: "sessions/synthetic.jsonl",
                          leafId: null,
                          persisted: true,
                        },
                      },
                    }),
                  );
                },
                async dispose() {
                  if (mode === "host-dispose-held") {
                    await notify({ type: "dispose-held" });
                    await release.promise;
                  }
                },
              };
            },
          }),
    });
    running.catch(() => {});
    await notify({ type: "host-started" });
    await running;
  }
  await transport.dispose();
  returned = true;
  await notify({
    type: "result",
    ok: true,
    remoteCalls,
    inputClosed: transport.input.closed,
    outputClosed: transport.output.closed,
    rawInputDestroyed: process.stdin.destroyed,
    rawOutputDestroyed: process.stdout.destroyed,
    listeners: [process.stdin, process.stdout].map((stream) =>
      ["error", "close", "finish", "data", "drain", "readable"].map((event) =>
        stream.listenerCount(event),
      ),
    ),
    baseline,
  });
} catch (error) {
  let disposeRejected = false;
  try {
    await transport?.dispose();
  } catch {
    disposeRejected = true;
  }
  returned = true;
  await notify({
    type: "result",
    ok: false,
    code: error instanceof Error ? error.message : "UNKNOWN",
    remoteCalls,
    disposeRejected,
    workerEntries,
    hostImports,
    readerUnchanged: process.stdin.listeners("readable").includes(passiveObserver),
    flowUnchanged: process.stdin.readableFlowing === initialInputFlow,
    listeners: [process.stdin, process.stdout].map((stream) =>
      ["error", "close", "finish", "data", "drain", "readable"].map((event) =>
        stream.listenerCount(event),
      ),
    ),
    baseline,
    rawInputDestroyed: process.stdin.destroyed,
    rawOutputDestroyed: process.stdout.destroyed,
    inputClosed: transport?.input.closed,
    outputClosed: transport?.output.closed,
  });
  process.exitCode = 1;
} finally {
  process.stdin.pause();
  if (process.connected) process.disconnect();
}
