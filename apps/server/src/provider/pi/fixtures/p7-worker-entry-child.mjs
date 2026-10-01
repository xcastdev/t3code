import * as NodeModule from "node:module";

const [mode, rawLaunchJson] = process.argv.slice(2);
let remoteCalls = 0;
let hostImports = 0;
let sdkImports = 0;
let sdkEnvironmentCorrect;
let expectedSdkDirectory;
try {
  expectedSdkDirectory = JSON.parse(rawLaunchJson).trustedSdkPackageDirectory;
} catch {}
globalThis.fetch = async () => {
  remoteCalls++;
  throw Error("NETWORK_FORBIDDEN");
};
const hook = NodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/PiWorkerHost.ts")) hostImports++;
    if (url.includes("/pi-coding-agent/dist/index.js")) {
      sdkImports++;
      sdkEnvironmentCorrect = process.env.PI_PACKAGE_DIR === expectedSdkDirectory;
    }
    return nextLoad(url, context);
  },
});
const notify = (value) =>
  new Promise((resolve, reject) => {
    if (!process.send) return reject(Error("FIXTURE_IPC_REQUIRED"));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
const events = ["error", "close", "finish", "data", "drain", "readable"];
const listeners = () =>
  [process.stdin, process.stdout].map((stream) =>
    events.map((event) => stream.listenerCount(event)),
  );
const passiveObserver = () => {};
if (mode === "readable-admission") process.stdin.on("readable", passiveObserver);
if (mode === "data-admission") process.stdin.on("data", passiveObserver);
const baseline = listeners();
const flow = process.stdin.readableFlowing;
const packageDir = process.env.PI_PACKAGE_DIR;
try {
  const { runPiWorkerEntrypoint } = await import("../PiWorkerEntrypoint.ts");
  await notify({
    type: "imported",
    pid: process.pid,
    node: process.versions.node,
    hostImports,
    sdkImports,
    environmentUnchanged: process.env.PI_PACKAGE_DIR === packageDir,
    listenersUnchanged: JSON.stringify(listeners()) === JSON.stringify(baseline),
  });
  if (mode === "import-only") {
    await notify({ type: "result", ok: true, hostImports, sdkImports, remoteCalls });
  } else {
    let code;
    try {
      await runPiWorkerEntrypoint(rawLaunchJson === "undefined" ? undefined : rawLaunchJson);
    } catch (error) {
      code = error instanceof Error ? error.message : "UNKNOWN";
    }
    let repeatedCode;
    try {
      await runPiWorkerEntrypoint(rawLaunchJson);
    } catch (error) {
      repeatedCode = error instanceof Error ? error.message : "UNKNOWN";
    }
    await notify({
      type: "result",
      ok: code === undefined,
      code,
      repeatedCode,
      hostImports,
      sdkImports,
      sdkEnvironmentCorrect,
      remoteCalls,
      environmentUnchanged: process.env.PI_PACKAGE_DIR === packageDir,
      listenersUnchanged: JSON.stringify(listeners()) === JSON.stringify(baseline),
      readerUnchanged: process.stdin.listeners("readable").includes(passiveObserver),
      flowUnchanged: process.stdin.readableFlowing === flow,
      inputBytes: process.stdin.readableLength,
      rawInputDestroyed: process.stdin.destroyed,
      rawOutputDestroyed: process.stdout.destroyed,
      rawOutputEnded: process.stdout.writableEnded,
    });
    if (code) process.exitCode = 1;
  }
} finally {
  hook.deregister();
  if (process.connected) process.disconnect();
}
