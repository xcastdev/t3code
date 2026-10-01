import type * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";
import { makePiSdkWorker, type PiSdkWorkerOptions } from "./PiWorker.ts";
import {
  decodePiWorkerFrame,
  makePiWorkerDispatchQueue,
  makePiWorkerLineFramer,
  PI_WORKER_MAX_FRAME_BYTES,
} from "./PiWorkerProtocol.ts";

type Worker = ReturnType<typeof makePiSdkWorker>;

export interface PiWorkerHostOptions extends Omit<PiSdkWorkerOptions, "emit"> {
  /** Usable native emitClose:true streams become owned only after both pass admission. */
  readonly input: NodeStream.Readable;
  readonly output: NodeStream.Writable;
  readonly signal?: AbortSignal;
  /** Private transport-test seam; production always uses the pinned SDK worker. */
  readonly makeWorker?: (options: PiSdkWorkerOptions) => Worker;
}

export class PiWorkerHostUnsupportedStreamError extends Error {
  readonly code = "UNSUPPORTED_STREAM";
  readonly side: "input" | "output";
  constructor(side: "input" | "output") {
    super(`Unsupported pi worker host ${side}: native emitClose must be true`);
    this.name = "PiWorkerHostUnsupportedStreamError";
    this.side = side;
  }
}

function assertCloseEmission(
  stream: NodeStream.Readable | NodeStream.Writable,
  side: "input" | "output",
) {
  // Node exposes no public getter for this constructor option. Fail closed if its native
  // state layout changes; the host cannot join resource release without a close receipt.
  const state: unknown = Reflect.get(
    stream,
    side === "input" ? "_readableState" : "_writableState",
  );
  if (
    typeof state !== "object" ||
    state === null ||
    !("emitClose" in state) ||
    state.emitClose !== true
  )
    throw new PiWorkerHostUnsupportedStreamError(side);
}

/** Run one trusted SDK operation while parent responses and controls continue flowing. */
export async function runPiWorkerHost(options: PiWorkerHostOptions): Promise<void> {
  const { input, output, signal, makeWorker = makePiSdkWorker, ...sdkOptions } = options;
  assertCloseEmission(input, "input");
  assertCloseEmission(output, "output");
  // A disabled side or prior error/end can make a native stream unusable without destruction.
  // These transports cannot carry a new operation; leave both caller-owned.
  if (
    input.readable !== true ||
    input.errored !== null ||
    output.writable !== true ||
    output.errored !== null ||
    input.readableEnded ||
    input.destroyed ||
    input.closed ||
    output.writableEnded ||
    output.writableFinished ||
    output.destroyed ||
    output.closed
  )
    throw Error("TRANSPORT_CLOSED");
  const operation = Object.freeze({ ...sdkOptions.operation });
  const failed = Promise.withResolvers<void>();
  const inputClosed = Promise.withResolvers<void>();
  const outputClosed = Promise.withResolvers<void>();
  let failure: unknown;
  let hasFailure = false;
  let worker: Worker | undefined;
  let run: Promise<void> | undefined;
  let dispatch = Promise.resolve();
  let terminal = false;
  let inputEnded = false;
  let closing = false;
  let aborted = false;
  const queue = makePiWorkerDispatchQueue((raw) => {
    if (hasFailure) throw failure;
    if (terminal) throw Error("INPUT_AFTER_TERMINAL");
    worker!.acceptParent(raw);
  });
  const abortWorker = () => {
    if (worker && !aborted) {
      aborted = true;
      try {
        worker.abort();
      } catch (error) {
        if (!hasFailure) fail(error);
      }
    }
  };
  const fail = (error: unknown) => {
    if (hasFailure) return;
    hasFailure = true;
    failure = error;
    failed.resolve();
    queue.abort();
    abortWorker();
    closing = true;
    input.destroy();
    output.destroy();
  };
  const framer = makePiWorkerLineFramer((raw) => queue.push(raw));
  const onData = (chunk: unknown) => {
    try {
      if (!(chunk instanceof Uint8Array)) throw Error("INVALID_INPUT_CHUNK");
      if (terminal) throw Error("INPUT_AFTER_TERMINAL");
      input.pause();
      framer.push(chunk);
      dispatch = dispatch.then(() => queue.drain());
      void dispatch.then(() => {
        if (!closing) input.resume();
      }, fail);
    } catch (error) {
      fail(error);
    }
  };
  const onEnd = () => {
    if (closing) return;
    try {
      framer.finish();
      inputEnded = true;
      if (!terminal) throw Error("PARENT_EOF");
    } catch (error) {
      fail(error);
    }
  };
  const onInputClose = () => {
    inputClosed.resolve();
    if (!closing && !input.readableEnded) fail(Error("PARENT_CLOSED"));
  };
  const onOutputClose = () => {
    outputClosed.resolve();
    if (!closing) fail(Error("OUTPUT_CLOSED"));
  };
  const onOutputFinish = () => {
    if (!closing) fail(Error("OUTPUT_CLOSED"));
  };
  const onAbort = () => fail(signal?.reason ?? Error("CANCELED"));
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onInputClose);
  input.on("error", fail);
  output.on("error", fail);
  output.on("close", onOutputClose);
  output.on("finish", onOutputFinish);
  // Finishing and releasing an owned stream are distinct receipts when autoDestroy is false.
  const outputFinished = NodeStreamPromises.finished(output, {
    cleanup: true,
    readable: false,
  }).catch(fail);
  if (input.closed) inputClosed.resolve();
  if (output.closed) outputClosed.resolve();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    worker = makeWorker({
      ...sdkOptions,
      operation,
      emit: async (bytes) => {
        if (hasFailure) throw failure;
        if (terminal) throw Error("OUTPUT_AFTER_TERMINAL");
        if (bytes.length > PI_WORKER_MAX_FRAME_BYTES || bytes.at(-1) !== 10)
          throw Error("INVALID_OUTPUT_FRAME");
        const message = decodePiWorkerFrame(bytes.toString("utf8").slice(0, -1)).message;
        const isTerminal = message.type === "initialized" || message.type === "done";
        if (isTerminal) {
          if ((message.type === "initialized") !== (operation.operationKind === "initialize"))
            throw Error("INVALID_TERMINAL");
          terminal = true;
        }
        const written = Promise.withResolvers<void>();
        let callbackDone = false;
        let drained = false;
        const complete = () => {
          if (callbackDone && drained) written.resolve();
        };
        const onDrain = () => {
          drained = true;
          complete();
        };
        output.once("drain", onDrain);
        try {
          drained = output.write(bytes, (error) => {
            if (error) {
              written.reject(error);
              fail(error);
            } else {
              callbackDone = true;
              complete();
            }
          });
          complete();
          await Promise.race([
            written.promise,
            failed.promise.then(() => {
              throw failure;
            }),
          ]);
        } catch (error) {
          fail(error);
          throw error;
        } finally {
          output.removeListener("drain", onDrain);
        }
      },
    });
    run = worker.run();
    run.catch(fail);
    if (signal?.aborted) onAbort();
    if (input.destroyed || output.destroyed) fail(Error("TRANSPORT_CLOSED"));
    if (!closing) input.resume();
    await Promise.race([run, failed.promise]);
    if (!hasFailure) {
      await dispatch;
      queue.finish();
      if (!inputEnded) framer.finish();
      if (!terminal) throw Error("MISSING_TERMINAL");
      closing = true;
      input.destroy();
      output.end();
      await outputFinished;
      if (!output.writableFinished && !hasFailure) throw Error("OUTPUT_CLOSED");
    }
  } catch (error) {
    fail(error);
  } finally {
    closing = true;
    input.destroy();
    output.destroy();
    if (run) await run.catch(fail);
    await dispatch.catch(fail);
    try {
      await worker?.dispose();
    } catch (error) {
      fail(error);
    }
    await Promise.all([inputClosed.promise, outputClosed.promise, outputFinished]);
    signal?.removeEventListener("abort", onAbort);
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("close", onInputClose);
    input.removeListener("error", fail);
    output.removeListener("error", fail);
    output.removeListener("close", onOutputClose);
    output.removeListener("finish", onOutputFinish);
  }
  if (hasFailure) throw failure;
}
