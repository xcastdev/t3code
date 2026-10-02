import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Invoke explicitly inside the measured 2 GiB / zero-swap test scope. Ordinary
// discovery retains the portable SDK case without requiring a Linux user manager.
const manifestPath = process.env.PI_SDK_SESSION_RUNTIME_CLOSURE;
const evidence = process.env.PI_SDK_SESSION_RUNTIME_EVIDENCE_DIR;
const reportPath = process.env.PI_SDK_SESSION_RUNTIME_REPORT;
if (!manifestPath || !evidence || !reportPath)
  throw Error(
    "Required Linux proof needs an explicit closure, evidence directory, and report path",
  );
const root = NodeURL.fileURLToPath(new URL("../../../../../../", import.meta.url));
const cgroupLine = (await NodeFSP.readFile("/proc/self/cgroup", "utf8"))
  .split("\n")
  .find((line) => line.startsWith("0::"));
if (!cgroupLine) throw Error("Required Linux proof needs unified cgroup ownership");
const cgroup = "/sys/fs/cgroup" + cgroupLine.slice(3);
if (
  (await NodeFSP.readFile(NodePath.join(cgroup, "memory.max"), "utf8")).trim() !== "2147483648" ||
  (await NodeFSP.readFile(NodePath.join(cgroup, "memory.swap.max"), "utf8")).trim() !== "0"
)
  throw Error("Required Linux proof needs measured 2 GiB memory and zero swap");
const closure = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
if (closure.sdkVersion !== "0.99.1" || !Array.isArray(closure.files) || closure.files.length > 128)
  throw Error("Pinned SDK closure required");
for (const file of closure.files) {
  const bytes = await NodeFSP.readFile(file.source);
  if (
    bytes.length !== file.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== file.sha256
  )
    throw Error("Pinned SDK closure bytes changed: " + file.target);
}
const find = (target) => {
  const file = closure.files.find((candidate) => candidate.target === target);
  if (!file) throw Error("Pinned SDK closure missing " + target);
  return file.source;
};
const metadata = JSON.parse(await NodeFSP.readFile(find("/runtime/package.json"), "utf8"));
if (metadata.name !== "@earendil-works/pi-coding-agent" || metadata.version !== "0.99.1")
  throw Error("Real pinned SDK package metadata required");
find("/runtime/dist/worker.mjs");
const children = [];
await NodeFSP.mkdir(evidence, { recursive: true });
const run = async (command, args, options = {}) => {
  const child = NodeChildProcess.spawn(command, args, { cwd: root, stdio: "inherit", ...options });
  children.push({ pid: child.pid, command, args });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      children.at(-1).exitCode = exitCode;
      children.at(-1).signal = signal;
      resolve(exitCode);
    });
  });
  await NodeFSP.writeFile(
    NodePath.join(evidence, "proof-subprocesses.json"),
    JSON.stringify({ cgroup, children }, null, 2),
  );
  if (code !== 0) throw Error("Required Linux proof subprocess failed: " + command);
};
await run(find("/runtime/node"), ["--version"]);
await run("/usr/bin/systemctl", ["--user", "show", "--property=Version"]);
await run("/usr/bin/bwrap", ["--version"]);
await run(
  NodePath.join(root, "node_modules/.bin/vp"),
  [
    "test",
    "run",
    "apps/server/src/provider/pi/PiSdkSessionRuntime.integration.test.ts",
    "--testTimeout=30000",
    "--reporter=json",
    "--outputFile=" + reportPath,
  ],
  {
    env: {
      ...process.env,
      PI_SDK_SESSION_RUNTIME_LINUX_GATE: "1",
      NODE_OPTIONS: "--max-old-space-size=512",
    },
  },
);
const report = JSON.parse(await NodeFSP.readFile(reportPath, "utf8"));
const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
if (
  assertions.length !== 11 ||
  assertions.some((assertion) => assertion.status !== "passed") ||
  !report.success
)
  throw Error(
    "Required Linux proof must execute every portable and actual-child case with no skipped tests",
  );
