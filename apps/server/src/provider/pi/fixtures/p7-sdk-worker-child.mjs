import { makePiSdkWorker } from "../PiWorker.ts";
import {
  makePiWorkerLineFramer,
  makePiWorkerDispatchQueue,
  decodePiWorkerFrame,
  decodePiParentFrame,
} from "../PiWorkerProtocol.ts";

globalThis.fetch = async () => {
  throw Error("NETWORK_FORBIDDEN");
};
const [operationKind, sessionDirectory, scenario] = process.argv.slice(2);
let callbackCount = 0;
const callbackSignals = [];
const heldStart = Promise.withResolvers();
const heldCallback = Promise.withResolvers();
const notify = (message) =>
  new Promise((resolve, reject) => {
    if (!process.send) return resolve();
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
process.on("message", (message) => {
  if (message.type === "release-tool-start") heldStart.resolve();
  if (message.type === "release-tool-callback") heldCallback.resolve();
});
const worker = makePiSdkWorker({
  identity: { workerId: "actual-sdk-worker", generation: 1 },
  operation: { operationId: `actual-${operationKind}`, operationKind },
  sessionDirectory,
  emit: async (bytes) => {
    const message = decodePiWorkerFrame(bytes.toString().slice(0, -1)).message;
    await new Promise((resolve, reject) => {
      process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
    if (
      message.type === "sdk-event" &&
      message.event.type === "tool_start" &&
      ["tool-start-cancel", "tool-start-bridge-cancel", "tool-start-control"].includes(scenario)
    ) {
      await notify({ type: "tool-start-write-held", callbackCount });
      await heldStart.promise;
    }
  },
  localTools: {
    echo_assignment: async (args, signal) => {
      callbackCount++;
      callbackSignals.push(signal.aborted);
      if (scenario === "tool-callback-cancel") {
        await notify({ type: "tool-callback-held", callbackCount });
        await heldCallback.promise;
      }
      return {
        kind: "text",
        text: scenario === "tool-output-limit" ? "x".repeat(65500) : args.text,
      };
    },
  },
});
const queue = makePiWorkerDispatchQueue((raw) => {
  worker.acceptParent(raw);
  if (decodePiParentFrame(raw).message.type === "interrupt")
    void notify({ type: "interrupt-accepted", callbackCount });
});
const framer = makePiWorkerLineFramer((raw) => queue.push(raw));
let dispatch = Promise.resolve();
let complete = false;
process.stdin.on("data", (bytes) => {
  try {
    framer.push(bytes);
    dispatch = dispatch.then(() => queue.drain());
    dispatch.catch(() => worker.abort());
  } catch {
    queue.abort();
    worker.abort();
  }
});
process.stdin.on("end", () => {
  if (!complete) worker.abort();
  try {
    framer.finish();
  } catch {
    worker.abort();
  }
  dispatch.then(() => queue.finish()).catch(() => worker.abort());
});
try {
  await worker.run();
} finally {
  complete = true;
  await worker.dispose();
  process.stdin.destroy();
  await notify({ type: "callback-observation", callbackCount, callbackSignals });
  if (process.connected) process.disconnect();
}
