import * as NodeStream from "node:stream";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect, it } from "@effect/vitest";
import { runPiWorkerHost, type PiWorkerHostOptions } from "./PiWorkerHost.ts";
import { makePiSdkWorker, type PiSdkWorkerOptions } from "./PiWorker.ts";
import {
  decodePiWorkerFrame,
  encodePiParentFrame,
  encodePiWorkerFrame,
  PI_WORKER_MAX_FRAME_BYTES,
  PI_WORKER_MAX_QUEUE_FRAMES,
  type PiParentFrame,
  type PiWorkerFrame,
} from "./PiWorkerProtocol.ts";

const identity = { workerId: "host-test", generation: 1 };
const operation = { operationId: "operation-1", operationKind: "initialize" as const };
const native = {
  sessionId: "session-1",
  sessionReference: "sessions/session.jsonl",
  leafId: null,
  persisted: true,
};
const base = { identity, operation, sessionDirectory: "/unused", localTools: {} };
const terminal = (options: PiSdkWorkerOptions, sequence = 0) =>
  encodePiWorkerFrame({
    version: 1,
    ...options.identity,
    ...options.operation,
    sequence,
    message:
      options.operation.operationKind === "initialize"
        ? { type: "initialized", native }
        : { type: "done" },
  });
const parent = (sequence: number, message: PiParentFrame["message"]) =>
  encodePiParentFrame({ version: 1, ...identity, ...operation, sequence, message });

function fixture(
  run: (options: PiSdkWorkerOptions, aborted: Promise<void>) => Promise<void>,
  accept?: (raw: string) => void,
  dispose?: () => Promise<void>,
) {
  const input = new NodeStream.PassThrough();
  const output = new NodeStream.Writable({
    write(_bytes, _encoding, callback) {
      callback();
    },
  });
  const abort = Promise.withResolvers<void>();
  const counts = { abort: 0, dispose: 0, accept: 0 };
  const makeWorker: NonNullable<PiWorkerHostOptions["makeWorker"]> = (options) => ({
    run: () => run(options, abort.promise),
    acceptParent(raw) {
      counts.accept++;
      accept?.(raw);
    },
    abort() {
      counts.abort++;
      abort.resolve();
    },
    async dispose() {
      counts.dispose++;
      await dispose?.();
    },
  });
  return { input, output, counts, makeWorker };
}

const awaitAbort = async (_options: PiSdkWorkerOptions, aborted: Promise<void>) => {
  await aborted;
  throw Error("WORKER_ABORTED");
};
const expectClosed = (f: ReturnType<typeof fixture>) => {
  expect(f.input.destroyed).toBe(true);
  expect(f.output.destroyed).toBe(true);
  for (const stream of [f.input, f.output])
    for (const event of ["data", "end", "error", "close", "drain", "finish"])
      expect(stream.listenerCount(event)).toBe(0);
  expect(f.counts.dispose).toBe(1);
};

describe("Pi host close-event admission", () => {
  it.each([
    {
      inputEmitClose: false,
      outputEmitClose: true,
      constructorFailure: false,
      cancelled: false,
      side: "input",
    },
    {
      inputEmitClose: true,
      outputEmitClose: false,
      constructorFailure: false,
      cancelled: false,
      side: "output",
    },
    {
      inputEmitClose: false,
      outputEmitClose: false,
      constructorFailure: false,
      cancelled: false,
      side: "input",
    },
    {
      inputEmitClose: true,
      outputEmitClose: false,
      constructorFailure: true,
      cancelled: false,
      side: "output",
    },
    {
      inputEmitClose: true,
      outputEmitClose: false,
      constructorFailure: false,
      cancelled: true,
      side: "output",
    },
  ] as const)(
    "rejects unsupported $side before ownership, constructorFailure=$constructorFailure cancelled=$cancelled",
    async (settings) => {
      const released = Promise.withResolvers<void>();
      const inputDestroyed = Promise.withResolvers<void>();
      const outputDestroyed = Promise.withResolvers<void>();
      const destroys = { input: 0, output: 0 };
      const input = new NodeStream.PassThrough({
        emitClose: settings.inputEmitClose,
        destroy(error, callback) {
          destroys.input++;
          void released.promise.then(() => {
            callback(error);
            inputDestroyed.resolve();
          });
        },
      });
      const output = new NodeStream.Writable({
        emitClose: settings.outputEmitClose,
        autoDestroy: false,
        write(_bytes, _encoding, callback) {
          callback();
        },
        destroy(error, callback) {
          destroys.output++;
          void released.promise.then(() => {
            callback(error);
            outputDestroyed.resolve();
          });
        },
      });
      const callerError = () => {};
      input.on("error", callerError);
      output.on("error", callerError);
      const events = ["data", "end", "error", "close", "finish", "drain"];
      const listeners = () =>
        [input, output].map((stream) => events.map((event) => stream.listenerCount(event)));
      const callerListeners = listeners();
      const controller = new AbortController();
      if (settings.cancelled) controller.abort(Error("PRE_ADMISSION_CANCEL"));
      let sdkEntries = 0;
      const outcome = runPiWorkerHost({
        ...base,
        input,
        output,
        signal: controller.signal,
        makeWorker(options) {
          sdkEntries++;
          if (settings.constructorFailure) throw Error("SDK_CONSTRUCTOR_MUST_NOT_RUN");
          return makePiSdkWorker(options);
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        expect(sdkEntries).toBe(0);
        expect(destroys).toEqual({ input: 0, output: 0 });
        expect(input.destroyed).toBe(false);
        expect(output.destroyed).toBe(false);
        expect(listeners()).toEqual(callerListeners);
        const error = await outcome;
        expect(error).toMatchObject({
          name: "PiWorkerHostUnsupportedStreamError",
          code: "UNSUPPORTED_STREAM",
          side: settings.side,
        });
        expect(listeners()).toEqual(callerListeners);
      } finally {
        // Release caller-owned resources even on the negative-source control.
        input.destroy();
        output.destroy();
        released.resolve();
        await Promise.all([inputDestroyed.promise, outputDestroyed.promise]);
        if (sdkEntries !== 0) {
          // A missing admission guard waits for these suppressed events; release only that failing control.
          if (!settings.inputEmitClose) input.emit("close");
          if (!settings.outputEmitClose) output.emit("close");
        }
        await outcome;
        input.removeListener("error", callerError);
        output.removeListener("error", callerError);
      }
      expect(destroys).toEqual({ input: 1, output: 1 });
      expect(input.closed).toBe(true);
      expect(output.closed).toBe(true);
      expect(listeners()).toEqual([events.map(() => 0), events.map(() => 0)]);
    },
  );
});

describe("Pi host terminal-state admission", () => {
  it.each([
    "input-ended",
    "output-finished",
    "output-end-pending",
    "input-closed",
    "output-closed",
    "input-destroy-pending",
    "output-destroy-pending",
  ] as const)("rejects %s before ownership or actual SDK entry", async (state) => {
    const destroyRelease = Promise.withResolvers<void>();
    const input = new NodeStream.PassThrough({
      autoDestroy: false,
      destroy(error, callback) {
        if (state === "input-destroy-pending")
          void destroyRelease.promise.then(() => callback(error));
        else callback(error);
      },
    });
    const finalEntered = Promise.withResolvers<void>();
    let finish!: () => void;
    const output = new NodeStream.Writable({
      autoDestroy: false,
      write(_bytes, _encoding, callback) {
        callback();
      },
      final(callback) {
        finish = callback;
        finalEntered.resolve();
        if (state !== "output-end-pending") callback();
      },
      destroy(error, callback) {
        if (state === "output-destroy-pending")
          void destroyRelease.promise.then(() => callback(error));
        else callback(error);
      },
    });
    if (state === "input-ended") {
      const ended = Promise.withResolvers<void>();
      input.once("end", ended.resolve);
      input.resume();
      input.end();
      await ended.promise;
      expect(input.readableEnded).toBe(true);
      expect(input.destroyed).toBe(false);
    } else if (
      state.startsWith("output-") &&
      state !== "output-closed" &&
      state !== "output-destroy-pending"
    ) {
      const finished = Promise.withResolvers<void>();
      if (state === "output-finished") output.once("finish", finished.resolve);
      output.end();
      await finalEntered.promise;
      if (state === "output-finished") await finished.promise;
      expect(output.writableEnded).toBe(true);
      expect(output.writableFinished).toBe(state === "output-finished");
      expect(output.destroyed).toBe(false);
    } else {
      const stream = state.startsWith("input-") ? input : output;
      const closed = Promise.withResolvers<void>();
      stream.once("close", closed.resolve);
      stream.destroy();
      if (state.endsWith("closed")) await closed.promise;
      expect(stream.destroyed).toBe(true);
      expect(stream.closed).toBe(state.endsWith("closed"));
    }
    const controller = new AbortController();
    const events = ["data", "end", "error", "close", "finish", "drain"];
    const listeners = () =>
      [input, output].map((stream) => events.map((event) => stream.listenerCount(event)));
    const callerListeners = listeners();
    const destroyed = [input.destroyed, output.destroyed];
    let sdkEntries = 0;
    const outcome = runPiWorkerHost({
      ...base,
      input,
      output,
      signal: controller.signal,
      makeWorker(options) {
        sdkEntries++;
        return makePiSdkWorker(options);
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      expect(sdkEntries).toBe(0);
      expect([input.destroyed, output.destroyed]).toEqual(destroyed);
      expect(listeners()).toEqual(callerListeners);
      expect(await outcome).toMatchObject({ message: "TRANSPORT_CLOSED" });
      expect(listeners()).toEqual(callerListeners);
    } finally {
      // Abort releases the actual SDK in the original-source failing control.
      controller.abort(Error("NEGATIVE_CONTROL_RELEASE"));
      const closes = [input, output].map((stream) => {
        if (stream.closed) return Promise.resolve();
        const closed = Promise.withResolvers<void>();
        stream.once("close", closed.resolve);
        return closed.promise;
      });
      input.destroy();
      output.destroy();
      destroyRelease.resolve();
      if (state === "output-end-pending") finish();
      await Promise.all([...closes, outcome]);
    }
    expect(listeners()).toEqual([events.map(() => 0), events.map(() => 0)]);
  });

  it.each(["input-end-pending", "input-end-after", "output-finish-after"] as const)(
    "rejects %s through a live receipt and joins the actual SDK",
    async (state) => {
      const input = new NodeStream.PassThrough({ autoDestroy: false });
      const output = new NodeStream.Writable({
        autoDestroy: false,
        write(_bytes, _encoding, callback) {
          callback();
        },
      });
      let sdkEntries = 0;
      let aborts = 0;
      let disposals = 0;
      if (state === "input-end-pending") {
        input.end();
        expect(input.readableEnded).toBe(false);
      }
      const host = runPiWorkerHost({
        ...base,
        input,
        output,
        makeWorker(options) {
          sdkEntries++;
          const worker = makePiSdkWorker(options);
          return {
            ...worker,
            abort() {
              aborts++;
              worker.abort();
            },
            async dispose() {
              disposals++;
              await worker.dispose();
            },
          };
        },
      });
      const failure = expect(host).rejects.toThrow(
        state === "output-finish-after" ? "OUTPUT_CLOSED" : "PARENT_EOF",
      );
      expect(sdkEntries).toBe(1);
      if (state === "input-end-after") input.end();
      if (state === "output-finish-after") output.end();
      await failure;
      expect(aborts).toBe(1);
      expect(disposals).toBe(1);
      for (const stream of [input, output]) {
        expect(stream.closed).toBe(true);
        for (const event of ["data", "end", "error", "close", "finish", "drain"])
          expect(stream.listenerCount(event)).toBe(0);
      }
    },
  );
});

describe("Pi host native availability admission", () => {
  it.each([
    "input-prior-error",
    "output-prior-error",
    "input-prior-error-autoDestroy",
    "input-unavailable",
    "output-unavailable",
    "input-prior-error-unsupported",
    "output-prior-error-unsupported",
  ] as const)("rejects %s before ownership without exposing its cause", async (state) => {
    const cause = Error("PRIVATE_NATIVE_TRANSPORT_CAUSE");
    const unavailableSide =
      state === "input-unavailable"
        ? new NodeStream.Writable({
            write(_bytes, _encoding, callback) {
              callback();
            },
          })
        : state === "output-unavailable"
          ? new NodeStream.Readable({ read() {} })
          : undefined;
    const unavailableClosed = Promise.withResolvers<void>();
    unavailableSide?.once("close", unavailableClosed.resolve);
    const input =
      state === "input-unavailable" && unavailableSide
        ? NodeStream.Duplex.from(unavailableSide)
        : new NodeStream.Duplex({
            autoDestroy: state === "input-prior-error-autoDestroy",
            emitClose: state !== "input-prior-error-unsupported",
            read() {
              if (state.startsWith("input-prior-error")) throw cause;
            },
            write(_bytes, _encoding, callback) {
              callback();
            },
          });
    const output =
      state === "output-unavailable" && unavailableSide
        ? NodeStream.Duplex.from(unavailableSide)
        : new NodeStream.Duplex({
            autoDestroy: false,
            emitClose: state !== "output-prior-error-unsupported",
            read() {},
            write(_bytes, _encoding, callback) {
              callback(state.startsWith("output-prior-error") ? cause : undefined);
            },
          });
    const callerError = () => {};
    input.on("error", callerError);
    output.on("error", callerError);
    if (state.includes("prior-error")) {
      const stream = state.startsWith("input-") ? input : output;
      const observed = Promise.withResolvers<Error>();
      stream.once("error", observed.resolve);
      if (state.startsWith("input-")) input.read(0);
      else output.write(Buffer.from("native write probe"));
      expect(await observed.promise).toBe(cause);
      expect(stream.errored).toBe(cause);
      if (state === "input-prior-error" || state === "output-prior-error") {
        expect(stream.destroyed).toBe(false);
        expect(stream.closed).toBe(false);
        expect(input.readableEnded).toBe(false);
        expect(output.writableEnded).toBe(false);
        expect(output.writableFinished).toBe(false);
      }
    }
    if (state.startsWith("input-")) expect(input.readable).toBe(false);
    else expect(output.writable).toBe(false);
    const events = ["data", "end", "error", "close", "finish", "drain"];
    const listeners = () =>
      [input, output].map((stream) => events.map((event) => stream.listenerCount(event)));
    const callerListeners = listeners();
    const destroyed = [input.destroyed, output.destroyed];
    const controller = new AbortController();
    let sdkEntries = 0;
    const outcome = runPiWorkerHost({
      ...base,
      input,
      output,
      signal: controller.signal,
      makeWorker(options) {
        sdkEntries++;
        return makePiSdkWorker(options);
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      expect(sdkEntries).toBe(0);
      expect([input.destroyed, output.destroyed]).toEqual(destroyed);
      expect(listeners()).toEqual(callerListeners);
      const error = await outcome;
      expect(error).not.toBe(cause);
      expect(String(error)).not.toContain(cause.message);
      if (state.endsWith("unsupported"))
        expect(error).toMatchObject({
          code: "UNSUPPORTED_STREAM",
          side: state.startsWith("input-") ? "input" : "output",
        });
      else expect(error).toMatchObject({ message: "TRANSPORT_CLOSED" });
      expect(listeners()).toEqual(callerListeners);
    } finally {
      controller.abort(Error("NEGATIVE_CONTROL_RELEASE"));
      const closes = [input, output].map((stream, index) => {
        if (
          stream.closed ||
          state ===
            (index === 0 ? "input-prior-error-unsupported" : "output-prior-error-unsupported")
        )
          return Promise.resolve();
        const closed = Promise.withResolvers<void>();
        stream.once("close", closed.resolve);
        return closed.promise;
      });
      input.destroy();
      output.destroy();
      await Promise.all([...closes, outcome]);
      if (unavailableSide) {
        await unavailableClosed.promise;
        expect(unavailableSide.closed).toBe(true);
      }
      input.removeListener("error", callerError);
      output.removeListener("error", callerError);
    }
    expect(input.closed).toBe(true);
    expect(output.closed).toBe(true);
    expect(listeners()).toEqual([events.map(() => 0), events.map(() => 0)]);
  });

  it.each(["input", "output"] as const)(
    "joins the actual SDK after a live native %s error",
    async (side) => {
      const cause = Error("LIVE_NATIVE_TRANSPORT_CAUSE");
      const input = new NodeStream.Readable({
        autoDestroy: false,
        read() {
          if (side === "input") throw cause;
        },
      });
      const output = new NodeStream.Writable({
        autoDestroy: false,
        write(_bytes, _encoding, callback) {
          callback(cause);
        },
      });
      let sdkEntries = 0;
      let aborts = 0;
      let disposals = 0;
      const host = runPiWorkerHost({
        ...base,
        input,
        output,
        makeWorker(options) {
          sdkEntries++;
          const worker = makePiSdkWorker(options);
          return {
            ...worker,
            abort() {
              aborts++;
              worker.abort();
            },
            async dispose() {
              disposals++;
              await worker.dispose();
            },
          };
        },
      });
      const failure = expect(host).rejects.toBe(cause);
      expect(sdkEntries).toBe(1);
      if (side === "input") input.read(0);
      else output.write(Buffer.from("native write probe"));
      await failure;
      expect(side === "input" ? input.errored : output.errored).toBe(cause);
      expect(side === "input" ? output.errored : input.errored).toBe(null);
      expect(aborts).toBe(1);
      expect(disposals).toBe(1);
      for (const stream of [input, output]) {
        expect(stream.closed).toBe(true);
        for (const event of ["data", "end", "error", "close", "finish", "drain"])
          expect(stream.listenerCount(event)).toBe(0);
      }
    },
  );
});

describe("Pi worker owned transport", () => {
  it("writes initialization fully, accepts terminal EOF, and disposes without aborting success", async () => {
    const f = fixture(async (options) => {
      await options.emit(terminal(options));
    });
    const written = Promise.withResolvers<void>();
    let release!: () => void;
    const output = new NodeStream.Writable({
      highWaterMark: 1,
      write(_bytes, _encoding, callback) {
        release = callback;
        written.resolve();
      },
    });
    const host = runPiWorkerHost({ ...base, ...f, output });
    await Promise.race([written.promise, host]);
    f.input.end();
    let completed = false;
    host.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    await host;
    expect(f.counts).toEqual({ abort: 0, dispose: 1, accept: 0 });
    expect(output.destroyed).toBe(true);
    expectClosed({ ...f, output });
  });

  it("keeps parent input flowing while an output write is held by backpressure", async () => {
    const sent = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const f = fixture(
      async (options) => {
        await options.emit(
          encodePiWorkerFrame({
            version: 1,
            ...identity,
            ...operation,
            sequence: 0,
            message: { type: "ready", actualCwd: "/bounded", native },
          }),
        );
        terminalStarted = true;
        await options.emit(terminal(options, 1));
      },
      () => accepted.resolve(),
    );
    let release!: () => void;
    let writes = 0;
    let terminalStarted = false;
    const output = new NodeStream.Writable({
      highWaterMark: 1,
      write(_bytes, _encoding, callback) {
        if (++writes === 1) {
          release = callback;
          sent.resolve();
        } else callback();
      },
    });
    const host = runPiWorkerHost({ ...base, ...f, output });
    await Promise.race([sent.promise, host]);
    f.input.write(parent(0, { type: "interrupt", controlId: 1 }));
    await Promise.race([accepted.promise, host]);
    expect(writes).toBe(1);
    expect(terminalStarted).toBe(false);
    release();
    await host;
    expect(f.counts.abort).toBe(0);
    expectClosed({ ...f, output });
  });

  it.each([false, true])("rejects parent EOF before bootstrap, partial=%s", async (partial) => {
    const f = fixture(awaitAbort);
    const host = runPiWorkerHost({ ...base, ...f });
    f.input.end(partial ? "{" : undefined);
    await expect(host).rejects.toThrow(partial ? "INCOMPLETE_FRAME" : "PARENT_EOF");
    expect(f.counts.abort).toBe(1);
    expectClosed(f);
  });

  it("retains the original stream failure while joining a held cleanup", async () => {
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const f = fixture(awaitAbort, undefined, async () => {
      entered.resolve();
      await cleanup.promise;
      throw Error("CLEANUP_FAILURE");
    });
    const error = Error("INPUT_FAILURE");
    const host = runPiWorkerHost({ ...base, ...f });
    let completed = false;
    void host.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    const rejected = expect(host).rejects.toBe(error);
    f.input.destroy(error);
    await entered.promise;
    expect(completed).toBe(false);
    expect(f.counts.abort).toBe(1);
    cleanup.resolve();
    await rejected;
    expectClosed(f);
  });

  it("fails a write without waiting for a drain that can never arrive", async () => {
    const error = Error("WRITE_FAILURE");
    const f = fixture(async (options) => {
      await options.emit(terminal(options));
    });
    const output = new NodeStream.Writable({
      highWaterMark: 1,
      write(_bytes, _encoding, callback) {
        callback(error);
      },
    });
    await expect(runPiWorkerHost({ ...base, ...f, output })).rejects.toBe(error);
    expect(f.counts.abort).toBe(1);
    expect(output.listenerCount("drain")).toBe(0);
    expectClosed({ ...f, output });
  });

  it("cancels a held output and joins worker and streams exactly once", async () => {
    const entered = Promise.withResolvers<void>();
    const f = fixture(async (options) => {
      await options.emit(terminal(options));
    });
    const output = new NodeStream.Writable({
      write(_bytes, _encoding, _callback) {
        entered.resolve();
      },
    });
    const controller = new AbortController();
    const reason = Error("ROOT_CANCEL");
    const host = runPiWorkerHost({ ...base, ...f, output, signal: controller.signal });
    await Promise.race([entered.promise, host]);
    controller.abort(reason);
    await expect(host).rejects.toBe(reason);
    expect(f.counts.abort).toBe(1);
    expectClosed({ ...f, output });
  });

  it("rejects oversized partial input before accepting any frame", async () => {
    const f = fixture(awaitAbort);
    const host = runPiWorkerHost({ ...base, ...f });
    f.input.write(Buffer.alloc(PI_WORKER_MAX_FRAME_BYTES, 65));
    await expect(host).rejects.toThrow("FRAME_BYTE_LIMIT");
    expect(f.counts.accept).toBe(0);
    expectClosed(f);
  });

  it("rejects a coalesced dispatch overflow without consuming an unbounded queue", async () => {
    const f = fixture(awaitAbort);
    const host = runPiWorkerHost({ ...base, ...f });
    f.input.write(
      Buffer.concat(
        Array.from({ length: PI_WORKER_MAX_QUEUE_FRAMES + 1 }, () =>
          parent(0, { type: "interrupt", controlId: 1 }),
        ),
      ),
    );
    await expect(host).rejects.toThrow("DISPATCH_QUEUE_LIMIT");
    expect(f.counts.accept).toBe(0);
    expectClosed(f);
  });

  it("rejects frames queued behind an accepted terminal transition", async () => {
    let options!: PiSdkWorkerOptions;
    const emitted = Promise.withResolvers<void>();
    const f = fixture(
      async (value) => {
        options = value;
        await emitted.promise;
      },
      () => {
        void options.emit(terminal(options)).then(emitted.resolve, emitted.reject);
      },
    );
    const host = runPiWorkerHost({ ...base, ...f });
    f.input.write(
      Buffer.concat([
        parent(0, { type: "interrupt", controlId: 1 }),
        parent(1, { type: "interrupt", controlId: 2 }),
      ]),
    );
    await expect(host).rejects.toThrow("INPUT_AFTER_TERMINAL");
    expect(f.counts.accept).toBe(1);
    expectClosed(f);
  });

  it("rejects retained partial input even when the worker reaches terminal success", async () => {
    const accepted = Promise.withResolvers<void>();
    const f = fixture(
      async (options) => {
        await accepted.promise;
        await options.emit(terminal(options));
      },
      () => accepted.resolve(),
    );
    const host = runPiWorkerHost({ ...base, ...f });
    f.input.write(
      Buffer.concat([parent(0, { type: "interrupt", controlId: 1 }), Buffer.from("{")]),
    );
    await expect(host).rejects.toThrow("INCOMPLETE_FRAME");
    expectClosed(f);
  });

  it("closes both streams if worker construction fails", async () => {
    const f = fixture(awaitAbort);
    const error = Error("CONSTRUCTOR_FAILURE");
    await expect(
      runPiWorkerHost({
        ...base,
        ...f,
        makeWorker() {
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(f.input.destroyed).toBe(true);
    expect(f.output.destroyed).toBe(true);
    expect(f.counts).toEqual({ abort: 0, dispose: 0, accept: 0 });
  });

  it.each(["input", "output"] as const)(
    "fails unexpected %s closure and joins cleanup",
    async (side) => {
      const f = fixture(awaitAbort);
      const host = runPiWorkerHost({ ...base, ...f });
      f[side].destroy();
      await expect(host).rejects.toThrow(side === "input" ? "PARENT_CLOSED" : "OUTPUT_CLOSED");
      expect(f.counts.abort).toBe(1);
      expectClosed(f);
    },
  );

  it("fails a naturally finished output before worker completion", async () => {
    const f = fixture(awaitAbort);
    const host = runPiWorkerHost({ ...base, ...f });
    f.output.end();
    await expect(host).rejects.toThrow("OUTPUT_CLOSED");
    expect(f.counts.abort).toBe(1);
    expectClosed(f);
  });

  it("preserves worker failure over later disposal failure", async () => {
    const error = Error("ORIGINAL_WORKER_FAILURE");
    const f = fixture(
      async () => {
        throw error;
      },
      undefined,
      async () => {
        throw Error("DISPOSE_FAILURE");
      },
    );
    await expect(runPiWorkerHost({ ...base, ...f })).rejects.toBe(error);
    expect(f.counts.abort).toBe(1);
    expectClosed(f);
  });

  it("fails disposal after a fully written successful operation", async () => {
    const error = Error("DISPOSE_FAILURE");
    const f = fixture(
      async (options) => {
        await options.emit(terminal(options));
      },
      undefined,
      async () => {
        throw error;
      },
    );
    await expect(runPiWorkerHost({ ...base, ...f })).rejects.toBe(error);
    expectClosed(f);
  });

  it.each(["oversized", "truncated"])("rejects %s output and disposes", async (kind) => {
    const f = fixture(async (options) => {
      await options.emit(
        kind === "oversized" ? Buffer.alloc(PI_WORKER_MAX_FRAME_BYTES + 1) : Buffer.from("{}"),
      );
    });
    await expect(runPiWorkerHost({ ...base, ...f })).rejects.toThrow("INVALID_OUTPUT_FRAME");
    expectClosed(f);
  });

  it("rejects invalid UTF8 without accepting a parent frame", async () => {
    const f = fixture(awaitAbort);
    const host = runPiWorkerHost({ ...base, ...f });
    f.input.write(Buffer.from([0xff, 10]));
    await expect(host).rejects.toThrow("INVALID_FRAME_UTF8");
    expect(f.counts.accept).toBe(0);
    expectClosed(f);
  });

  it("joins cleanup and rejects a worker that returns without a terminal receipt", async () => {
    const f = fixture(async () => {});
    await expect(runPiWorkerHost({ ...base, ...f })).rejects.toThrow("MISSING_TERMINAL");
    expectClosed(f);
  });
});

describe("Pi host actual pinned SDK", () => {
  it.effect.each([
    { operationKind: "initialize", behavior: "normal" },
    { operationKind: "prompt", behavior: "normal" },
    { operationKind: "initialize", behavior: "premature-close" },
    { operationKind: "initialize", behavior: "autoDestroy-false" },
    { operationKind: "initialize", behavior: "held-destroy" },
    { operationKind: "initialize", behavior: "held-destroy-no-autoDestroy" },
    { operationKind: "initialize", behavior: "final-error" },
    { operationKind: "initialize", behavior: "mutable-operation" },
  ] as const)(
    "completes $operationKind/$behavior with retained native context and owned cleanup",
    ({ operationKind, behavior }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const scratch = yield* fs.makeTempDirectoryScoped();
        const input = new NodeStream.PassThrough();
        const messages: PiWorkerFrame["message"][] = [];
        const op = { operationId: "sdk-host-1", operationKind };
        const admittedOperation = { ...op };
        const destroyEntered = Promise.withResolvers<void>();
        const destroyRelease = Promise.withResolvers<void>();
        const finalError = Error("SDK_OUTPUT_FINAL_ERROR");
        const emittedKinds: string[] = [];
        let destroyedCount = 0;
        let sequence = 0;
        const send = (message: PiParentFrame["message"]) =>
          input.write(
            encodePiParentFrame({
              version: 1,
              ...identity,
              ...admittedOperation,
              sequence: sequence++,
              message,
            }),
          );
        let requests = 0;
        const output = new NodeStream.Writable({
          autoDestroy:
            behavior !== "autoDestroy-false" && behavior !== "held-destroy-no-autoDestroy",
          final(callback) {
            if (behavior === "premature-close") this.destroy();
            else callback(behavior === "final-error" ? finalError : undefined);
          },
          destroy(error, callback) {
            destroyedCount++;
            if (behavior === "held-destroy" || behavior === "held-destroy-no-autoDestroy") {
              destroyEntered.resolve();
              void destroyRelease.promise.then(() => callback(error));
            } else callback(error);
          },
          write(bytes: Buffer, _encoding, callback) {
            const frame = decodePiWorkerFrame(bytes.toString().slice(0, -1));
            if (frame.operationKind) emittedKinds.push(frame.operationKind);
            const message = frame.message;
            messages.push(message);
            if (message.type === "request") {
              requests++;
              send({ type: "headers", requestId: message.requestId, status: 200 });
              const chunks = [
                {
                  id: "synthetic",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "deterministic",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "Retained host result." },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "synthetic",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "deterministic",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                  usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
                },
              ];
              send({
                type: "chunk",
                requestId: message.requestId,
                data: Buffer.from(
                  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
                    "data: [DONE]\n\n",
                ).toString("base64"),
              });
            } else if (message.type === "ack") send({ type: "end", requestId: message.requestId });
            else if (message.type === "initialized" || message.type === "done") input.end();
            callback();
          },
        });
        const outputClose = Promise.withResolvers<void>();
        output.once("close", outputClose.resolve);
        const context = "Bounded authoritative context.";
        const prompt = "Produce retained findings.";
        const host = runPiWorkerHost({
          identity,
          operation: op,
          sessionDirectory: scratch,
          localTools: {},
          input,
          output,
        });
        if (behavior === "mutable-operation") op.operationKind = "prompt";
        send({
          type: "bootstrap",
          executionMode: "ordinary",
          expectedCwd: process.cwd(),
          native: null,
          context: { transferId: "context", totalBytes: Buffer.byteLength(context) },
          prompt:
            operationKind === "prompt"
              ? { transferId: "prompt", totalBytes: Buffer.byteLength(prompt) }
              : null,
          model: {
            provider: "synthetic",
            modelId: "deterministic",
            api: "openai-completions",
            contextWindow: 32768,
            maxTokens: 512,
            reasoning: false,
          },
          allowedTools: [],
        });
        send({
          type: "transfer-chunk",
          transferId: "context",
          index: 0,
          offset: 0,
          data: Buffer.from(context).toString("base64"),
        });
        send({ type: "transfer-end", transferId: "context" });
        if (operationKind === "prompt") {
          send({
            type: "transfer-chunk",
            transferId: "prompt",
            index: 0,
            offset: 0,
            data: Buffer.from(prompt).toString("base64"),
          });
          send({ type: "transfer-end", transferId: "prompt" });
        }
        const outcome = host.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        if (behavior === "held-destroy" || behavior === "held-destroy-no-autoDestroy") {
          let returned = false;
          void outcome.then(() => {
            returned = true;
          });
          yield* Effect.tryPromise(() =>
            Promise.race([
              destroyEntered.promise,
              outcome.then(async () => {
                destroyRelease.resolve();
                output.destroy();
                await outputClose.promise;
                throw Error("RETURNED_BEFORE_DESTROY_RECEIPT");
              }),
            ]),
          );
          expect(returned).toBe(false);
          destroyRelease.resolve();
        }
        const result = yield* Effect.tryPromise(() => outcome);
        // The negative-source run also releases its deliberately non-auto-destroying sink.
        try {
          if (behavior === "premature-close") {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toMatchObject({ message: "OUTPUT_CLOSED" });
          } else if (behavior === "final-error") {
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toBe(finalError);
          } else expect(result.ok).toBe(true);
          expect(requests).toBe(operationKind === "prompt" ? 1 : 0);
          expect(messages.at(-1)?.type).toBe(operationKind === "prompt" ? "done" : "initialized");
          const reference = messages.find(
            (message) => message.type === "native" || message.type === "initialized",
          );
          if (!reference || !("native" in reference)) throw Error("MISSING_NATIVE");
          const contents = yield* fs.readFileString(
            `${scratch}/${reference.native.sessionReference.replace("sessions/", "")}`,
          );
          expect(contents).toContain(context);
          if (operationKind === "prompt") expect(contents).toContain("Retained host result.");
          expect(input.destroyed).toBe(true);
          expect(output.destroyed).toBe(true);
          expect(output.closed).toBe(true);
          expect(output.writableFinished).toBe(
            behavior !== "premature-close" && behavior !== "final-error",
          );
          expect(destroyedCount).toBe(1);
          expect(emittedKinds).toEqual(messages.map(() => operationKind));
          for (const stream of [input, output])
            for (const event of ["data", "end", "error", "close", "finish", "drain"])
              expect(stream.listenerCount(event)).toBe(0);
        } finally {
          destroyRelease.resolve();
          output.destroy();
          yield* Effect.promise(() => outputClose.promise);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
  );

  it("cancels the actual SDK before bootstrap and joins its disposal", async () => {
    const input = new NodeStream.PassThrough();
    const output = new NodeStream.Writable({
      write(_bytes, _encoding, callback) {
        callback();
      },
    });
    const controller = new AbortController();
    const reason = Error("ROOT_ABORT_BEFORE_BOOTSTRAP");
    controller.abort(reason);
    await expect(
      runPiWorkerHost({ ...base, input, output, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(input.destroyed).toBe(true);
    expect(output.destroyed).toBe(true);
    expect(input.listenerCount("error")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
  });

  it("rejects actual protocol input and aborts an unbootstrapped SDK", async () => {
    const input = new NodeStream.PassThrough();
    const output = new NodeStream.Writable({
      write(_bytes, _encoding, callback) {
        callback();
      },
    });
    const host = runPiWorkerHost({ ...base, input, output });
    input.write("{}\n");
    await expect(host).rejects.toThrow("INVALID_PARENT_FRAME");
    expect(input.destroyed).toBe(true);
    expect(output.destroyed).toBe(true);
  });
});
