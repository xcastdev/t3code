import { makePiSdkWorker } from "../PiWorker.ts";
import { makePiWorkerLineFramer, makePiWorkerDispatchQueue } from "../PiWorkerProtocol.ts";

globalThis.fetch = async () => {
  throw Error("NETWORK_FORBIDDEN");
};
const [operationKind, sessionDirectory, scenario] = process.argv.slice(2);
const worker = makePiSdkWorker({
  identity: { workerId: "actual-sdk-worker", generation: 1 },
  operation: { operationId: `actual-${operationKind}`, operationKind },
  sessionDirectory,
  emit: (bytes) =>
    new Promise((resolve, reject) => {
      process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
    }),
  localTools: {
    echo_assignment: async (args) => ({
      kind: "text",
      text: scenario === "tool-output-limit" ? "x".repeat(65500) : args.text,
    }),
  },
});
const queue = makePiWorkerDispatchQueue((raw) => worker.acceptParent(raw));
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
}
