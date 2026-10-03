import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";

const [, rawLaunchJson] = process.argv.slice(2);
let remoteCalls = 0;
let hostImports = 0;
let sdkImports = 0;
let sdkEnvironmentCorrect;
const files = process.getBuiltinModule("fs").promises;
const originalOpen = files.open;
let descriptorOpened = 0;
let descriptorClosed = 0;
const descriptors = new Set();
files.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (typeof args[0] === "string" && (args[0] === "/workspace" || args[0].startsWith("/proc/"))) {
    descriptorOpened++;
    descriptors.add(handle);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      await close();
      if (descriptors.delete(handle)) descriptorClosed++;
    };
  }
  return handle;
};
const notify = (value) =>
  process.stderr.write(JSON.stringify({ hostImports, sdkImports, ...value }) + "\n");
globalThis.fetch = async () => {
  remoteCalls++;
  throw Error("NETWORK_FORBIDDEN");
};
const originalSpawn = NodeChildProcess.spawn;
const builtinChildProcess = NodeChildProcess.default;
// Observe the actual native SDK process handle; retain its implementation and arguments.
builtinChildProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  notify({ type: "native-spawn", pid: child.pid, executable: args[0] });
  child.stdout?.on("data", (bytes) => {
    if (bytes.toString().includes("entry-descendant-ready"))
      notify({ type: "native-data", data: bytes.toString() });
  });
  child.once("exit", (exitCode, exitSignal) => {
    notify({ type: "native-exit", pid: child.pid, exitCode, exitSignal });
  });
  return child;
};
NodeModule.syncBuiltinESMExports();
const hook = NodeModule.registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (/\/PiWorkerHost-[^/]+\.mjs$/.test(url)) hostImports++;
    if (String(result.source).includes("function getPackageDir()")) {
      sdkImports++;
      sdkEnvironmentCorrect = process.env.PI_PACKAGE_DIR === "/runtime/pi-sdk";
    }
    return result;
  },
});
const events = ["error", "close", "finish", "data", "drain", "readable"];
const listeners = () =>
  [process.stdin, process.stdout].map((stream) =>
    events.map((event) => stream.listenerCount(event)),
  );
const baseline = listeners();
const packageDir = process.env.PI_PACKAGE_DIR;
try {
  const { runPiWorkerEntrypoint } = await import("/runtime/PiWorkerEntrypoint.mjs");
  notify({
    type: "imported",
    pid: process.pid,
    node: process.versions.node,
    environmentUnchanged: process.env.PI_PACKAGE_DIR === packageDir,
    listenersUnchanged: JSON.stringify(listeners()) === JSON.stringify(baseline),
  });
  let code;
  try {
    await runPiWorkerEntrypoint(rawLaunchJson);
  } catch (error) {
    code = error instanceof Error ? error.message : "UNKNOWN";
  }
  notify({
    type: "result",
    ok: code === undefined,
    code,
    remoteCalls,
    sdkEnvironmentCorrect,
    listenersUnchanged: JSON.stringify(listeners()) === JSON.stringify(baseline),
    rawInputDestroyed: process.stdin.destroyed,
    rawOutputDestroyed: process.stdout.destroyed,
    rawOutputEnded: process.stdout.writableEnded,
    descriptorOpened,
    descriptorClosed,
    descriptorsHeld: descriptors.size,
  });
  if (code) process.exitCode = 1;
} finally {
  hook.deregister();
  files.open = originalOpen;
  builtinChildProcess.spawn = originalSpawn;
  NodeModule.syncBuiltinESMExports();
}
