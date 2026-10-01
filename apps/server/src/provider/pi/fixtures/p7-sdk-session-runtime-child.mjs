import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
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
const [workerId, generation, operationId, operationKind, scenario] = process.argv.slice(2);
if (process.cwd() !== "/workspace" || process.env.OPENAI_API_KEY || process.env.AWS_ACCESS_KEY_ID)
  throw Error("MANAGED_CHILD_ENVIRONMENT");
const heldAck = Promise.withResolvers();
let ackHeld = false;
if (scenario === "descendant") {
  const descendant = NodeChildProcess.spawn(
    "/runtime/node",
    [
      "--max-old-space-size=32",
      "-e",
      'process.stdout.write(JSON.stringify({pid:process.pid})+"\\n");process.stdin.resume();',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const started = Promise.withResolvers();
  descendant.once("error", started.reject);
  descendant.stdout.once("data", (bytes) => started.resolve(bytes.toString()));
  await NodeFSP.writeFile("/state/descendant.json", await started.promise);
  descendant.unref();
  descendant.stdin.unref();
  descendant.stdout.unref();
  descendant.stderr.unref();
}
const worker = makePiSdkWorker({
  identity: { workerId, generation: Number(generation) },
  operation: { operationId, operationKind },
  sessionDirectory: "/state/sessions",
  localTools: {},
  emit: async (bytes) => {
    const message = decodePiWorkerFrame(bytes.toString().slice(0, -1)).message;
    if (scenario === "ack-hold" && message.type === "ack" && !ackHeld) {
      ackHeld = true;
      await new Promise((resolve, reject) =>
        process.stderr.write("P7_SDK_ACK_HELD\n", (error) => (error ? reject(error) : resolve())),
      );
      await heldAck.promise;
    }
    await new Promise((resolve, reject) => {
      process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  },
});
const queue = makePiWorkerDispatchQueue((raw) => {
  worker.acceptParent(raw);
  if (decodePiParentFrame(raw).message.type === "interrupt") heldAck.resolve();
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
  await NodeFSP.writeFile(
    `/state/${operationId}.fixture.json`,
    JSON.stringify({
      cwd: process.cwd(),
      pid: process.pid,
      environment: Object.keys(process.env).sort(),
      networkNamespace: await NodeFSP.readlink("/proc/self/ns/net"),
    }),
  );
}
