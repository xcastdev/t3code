// @effect-diagnostics nodeBuiltinImport:off - Native wrappers expose close receipts around borrowed process stdio.
import * as NodeStream from "node:stream";

import { PI_WORKER_MAX_QUEUE_BYTES } from "./PiWorkerProtocol.ts";

// Pipe backpressure stays fixed when the maximum serialized frame grows.
const STDIO_HIGH_WATER_BYTES = 32_768;

/**
 * Borrow one child process's stdio for its protocol. The wrappers own forwarding
 * and close receipts; the parent still owns process exit and pipe drain. Callers
 * must await dispose in finally, including when host admission fails.
 */
export function makePiWorkerStdioTransport(
  stdio: { readonly input: NodeStream.Readable; readonly output: NodeStream.Writable } = {
    input: process.stdin,
    output: process.stdout,
  },
) {
  const source = stdio.input;
  const sink = stdio.output;
  if (
    !NodeStream.isReadable(source) ||
    source.errored !== null ||
    source.destroyed ||
    source.closed ||
    source.readableEnded ||
    source.readableObjectMode ||
    source.readableEncoding !== null ||
    source.readableFlowing === true ||
    source.listenerCount("data") !== 0 ||
    // Even a passive readable observer keeps Node stdin in manual-read mode.
    source.listenerCount("readable") !== 0 ||
    !NodeStream.isWritable(sink) ||
    sink.errored !== null ||
    sink.destroyed ||
    sink.closed ||
    sink.writableEnded ||
    sink.writableFinished ||
    sink.writableObjectMode
  )
    throw Error("STDIO_UNAVAILABLE");

  const inputClosed = Promise.withResolvers<void>();
  const outputClosed = Promise.withResolvers<void>();
  let failure: Error | undefined;
  let active: { readonly joined: Promise<void>; readonly fault: () => void } | undefined;
  let disposal: Promise<void> | undefined;
  let detached = false;
  const input = new NodeStream.PassThrough({
    highWaterMark: STDIO_HIGH_WATER_BYTES,
    emitClose: true,
    autoDestroy: true,
    transform(bytes: Buffer, _encoding, callback) {
      if (bytes.length > PI_WORKER_MAX_QUEUE_BYTES) callback(Error("STDIO_INPUT_CHUNK_LIMIT"));
      else callback(null, bytes);
    },
    destroy(error, callback) {
      source.unpipe(input);
      source.pause();
      callback(error);
    },
  });
  const output = new NodeStream.Writable({
    highWaterMark: STDIO_HIGH_WATER_BYTES,
    emitClose: true,
    autoDestroy: true,
    write(bytes: Buffer, _encoding, callback) {
      const joined = Promise.withResolvers<void>();
      let returned = false;
      let callbackDone = false;
      let drained = false;
      let faultObserved = false;
      let writeError: Error | undefined;
      let completed = false;
      const complete = () => {
        // Node calls the failed-write callback before its error event. Retain
        // our error guard until that receipt, unless close already established it.
        if (
          completed ||
          !returned ||
          !callbackDone ||
          (!(failure || writeError) && !drained) ||
          (writeError && !faultObserved && !sink.closed)
        )
          return;
        completed = true;
        sink.removeListener("drain", onDrain);
        active = undefined;
        joined.resolve();
        callback(failure ?? writeError);
      };
      const onDrain = () => {
        drained = true;
        complete();
      };
      active = {
        joined: joined.promise,
        fault: () => {
          faultObserved = true;
          complete();
        },
      };
      sink.on("drain", onDrain);
      try {
        drained = sink.write(bytes, (error) => {
          callbackDone = true;
          writeError = error ?? undefined;
          complete();
        });
        returned = true;
        complete();
      } catch {
        writeError = Error("STDIO_OUTPUT_WRITE");
        faultObserved = true;
        callbackDone = true;
        returned = true;
        complete();
      }
    },
    destroy(error, callback) {
      // Borrowed stdout is never destroyed or ended. If the peer stops reading,
      // the parent's owned process deadline is the bound on this joined write.
      const joined = active?.joined ?? Promise.resolve();
      void joined.then(() => callback(error));
    },
  });
  const remember = (error: Error) => {
    failure ??= error;
  };
  const fail = (error: Error) => {
    remember(error);
    active?.fault();
    input.destroy(error);
    output.destroy(error);
  };
  const onInputClose = () => {
    if (!source.readableEnded && !detached) fail(Error("STDIO_INPUT_CLOSED"));
  };
  const onOutputClose = () => fail(Error("STDIO_OUTPUT_CLOSED"));
  const onOutputFinish = () => fail(Error("STDIO_OUTPUT_CLOSED"));
  input.on("error", remember);
  output.on("error", remember);
  input.once("close", inputClosed.resolve);
  output.once("close", outputClosed.resolve);
  source.on("error", fail);
  source.on("close", onInputClose);
  sink.on("error", fail);
  sink.on("close", onOutputClose);
  sink.on("finish", onOutputFinish);
  source.pipe(input);

  return Object.freeze({
    input,
    output,
    dispose() {
      disposal ??= (async () => {
        detached = true;
        input.destroy();
        output.destroy();
        await Promise.all([inputClosed.promise, outputClosed.promise]);
        source.unpipe(input);
        source.pause();
        source.removeListener("error", fail);
        source.removeListener("close", onInputClose);
        sink.removeListener("error", fail);
        sink.removeListener("close", onOutputClose);
        sink.removeListener("finish", onOutputFinish);
        input.removeListener("error", remember);
        output.removeListener("error", remember);
        if (failure) throw failure;
      })();
      return disposal;
    },
  });
}
