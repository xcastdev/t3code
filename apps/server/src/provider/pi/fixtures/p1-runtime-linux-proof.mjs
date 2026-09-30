// Required Linux P1 ownership proof. Ordinary *.test discovery runs only the portable contracts.
// Run: node apps/server/src/provider/pi/fixtures/p1-runtime-linux-proof.mjs
// Missing systemd user manager, cgroup v2, Python pidfd, or pinned SDK fails this runner.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeAssert from "node:assert/strict";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

function sdkRoot() {
  return (
    process.env.PI_RUNTIME_CONTRACT_SDK_ROOT ??
    (() => {
      try {
        return NodePath.resolve(
          NodePath.dirname(
            NodeURL.fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
          ),
          "..",
        );
      } catch {
        throw new Error(
          "Pi runtime contract requires @earendil-works/pi-coding-agent@0.99.1. Install the pinned test dependency or set PI_RUNTIME_CONTRACT_SDK_ROOT; missing SDK is not a passing skip.",
        );
      }
    })()
  );
}

async function executeFixture(negativeControl = "") {
  // A user service owns every descendant before SDK startup, including detached shells.
  // Linux + a functional systemd user manager are explicit proof-harness prerequisites.
  const cache = NodePath.join(NodeOS.homedir(), ".cache", "t3-pi-runtime-contract");
  await NodeFSP.mkdir(cache, { recursive: true });
  const scratch = await NodeFSP.mkdtemp(NodePath.join(cache, "owned-"));
  const unit = `pi-runtime-contract-${NodeCrypto.randomUUID()}.service`;
  const source = NodeURL.fileURLToPath(new URL("./", import.meta.url));
  const names = ["p1-runtime-sdk.mjs", "p1-runtime-mcp.mjs", "p1-runtime-descendants.mjs"];
  let stdout = "";
  let stderr = "";
  let code = 0;
  let unitResult = {};
  try {
    await Promise.all(
      names.map((name) =>
        NodeFSP.copyFile(NodePath.join(source, name), NodePath.join(scratch, name)),
      ),
    );
    try {
      const output = await execute(
        "systemd-run",
        [
          "--user",
          "--wait",
          "--pipe",
          "--quiet",
          `--unit=${unit}`,
          "-p",
          "MemoryMax=512M",
          "-p",
          "MemorySwapMax=0",
          "-p",
          "OOMPolicy=kill",
          "-p",
          "KillMode=control-group",
          "-p",
          "RuntimeMaxSec=10s",
          "-p",
          "TimeoutStopSec=1s",
          `--setenv=PI_RUNTIME_CONTRACT_OWNED_UNIT=${unit}`,
          `--setenv=PI_RUNTIME_CONTRACT_SDK_ROOT=${await NodeFSP.realpath(sdkRoot())}`,
          `--setenv=PI_RUNTIME_CONTRACT_NEGATIVE_CONTROL=${negativeControl}`,
          process.execPath,
          "--max-old-space-size=128",
          NodePath.join(scratch, "p1-runtime-sdk.mjs"),
          "--linux-ownership",
        ],
        { timeout: 16_000, maxBuffer: 1024 * 1024 },
      );
      stdout = output.stdout;
      stderr = output.stderr;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("stdout" in error) ||
        !("stderr" in error) ||
        typeof error.stdout !== "string" ||
        typeof error.stderr !== "string"
      )
        throw error;
      stdout = error.stdout;
      stderr = error.stderr;
      code = "code" in error && typeof error.code === "number" ? error.code : -1;
    } finally {
      try {
        const receipt = await execute(
          "systemctl",
          ["--user", "show", unit, "--property=Result,ExecMainStatus,ActiveState,SubState"],
          { timeout: 3000 },
        );
        unitResult = Object.fromEntries(
          receipt.stdout
            .trim()
            .split("\n")
            .map((line) => line.split("=")),
        );
      } finally {
        // Stop only the unit identity allocated above; never discover processes by PID/name.
        await execute("systemctl", ["--user", "stop", unit], { timeout: 3000 }).catch(() => {});
      }
    }
    const lines = stdout.trim().split("\n");
    const ownerLine = lines.find((line) => line.startsWith("P1_OWNER:"));
    if (!ownerLine)
      throw new Error(`Owned Linux SDK fixture failed before its startup boundary: ${stderr}`);
    const owner = JSON.parse(ownerLine.slice("P1_OWNER:".length));
    NodeAssert.equal(owner.unit, unit);
    NodeAssert.equal(owner.policy.KillMode, "control-group");
    NodeAssert.equal(owner.policy.RuntimeMaxUSec, "10s");
    NodeAssert.equal(owner.policy.TimeoutStopUSec, "1s");
    NodeAssert.equal(owner.max, "536870912");
    NodeAssert.equal(owner.swapMax, "0");
    NodeAssert.equal(owner.oomGroup, "1");
    NodeAssert.equal(owner.path, `/sys/fs/cgroup${owner.policy.ControlGroup}`);
    NodeAssert.equal(owner.path.endsWith(`/${unit}`), true);
    const kernel = await NodeFSP.readFile(NodePath.join(owner.path, "cgroup.events"), "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return "removed";
        throw error;
      },
    );
    // The kernel cannot remove a populated cgroup. A retained cgroup must be empty.
    NodeAssert.equal(kernel === "removed" || kernel.split("\n").includes("populated 0"), true);
    const text =
      code === 0
        ? lines.find((line) => !line.startsWith("P1_OWNER:") && line.startsWith("{"))
        : stderr
            .trim()
            .split("\n")
            .findLast((line) => line.startsWith("{"));
    if (!text)
      throw new Error(`Owned fixture failed without a causal receipt (exit ${code}): ${stderr}`);
    const report = JSON.parse(text);
    NodeAssert.equal(unitResult.ExecMainStatus, String(code));
    NodeAssert.equal(unitResult.Result, code === 0 ? "success" : "exit-code");
    NodeAssert.equal(unitResult.ActiveState, code === 0 ? "inactive" : "failed");
    const outcome = { code, report, owner, unitResult, ownedExit: { kernel, confirmed: true } };
    const evidence = process.env.PI_RUNTIME_CONTRACT_EVIDENCE_DIR;
    if (evidence) {
      await NodeFSP.mkdir(evidence, { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(evidence, `${negativeControl || "success"}.json`),
        JSON.stringify({ ...outcome, stdout, stderr }, null, 2),
      );
    }
    return outcome;
  } finally {
    await execute("systemctl", ["--user", "reset-failed", unit], { timeout: 3000 }).catch(() => {});
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

const positive = await executeFixture();
NodeAssert.equal(positive.code, 0);
NodeAssert.equal(positive.report.remoteCalls, 0);
NodeAssert.equal(positive.report.records.length, 6);
NodeAssert.ok(positive.report.cleanupReceipts.every((receipt) => !receipt.cleanup));
console.log("PASS: six actual SDK positive cases");
for (const negativeControl of ["descendant-abort", "mcp-shutdown"]) {
  const result = await executeFixture(negativeControl);
  NodeAssert.equal(result.code, 1);
  NodeAssert.equal(result.report.status, "failed");
  NodeAssert.match(result.report.cause, /^WATCHDOG:/);
  NodeAssert.equal(result.report.negativeControl, negativeControl);
  NodeAssert.equal(result.report.cleanupReceipts.length, 1);
  NodeAssert.equal(result.report.cleanupReceipts[0].complete, true);
  NodeAssert.equal(result.report.cleanupReceipts[0].cleanup, true);
  NodeAssert.equal(
    result.report.cleanupReceipts[0].pids.length,
    negativeControl === "descendant-abort" ? 3 : 1,
  );
  console.log(`PASS: ${negativeControl}`);
}
for (const negativeControl of [
  "mcp-startup-stall",
  "shell-pre-receipt-stall",
  "cleanup-abort-stall",
  "cleanup-shutdown-stall",
]) {
  const result = await executeFixture(negativeControl);
  NodeAssert.notEqual(result.code, 0);
  NodeAssert.equal(result.report.status, "failed");
  NodeAssert.equal(result.report.negativeControl, negativeControl);
  NodeAssert.match(result.report.cause, /^WATCHDOG:/);
  NodeAssert.equal(result.report.remoteCalls, 0);
  NodeAssert.ok(
    result.report.ownedMembersBeforeCleanup.length >=
      (negativeControl.includes("abort") || negativeControl.includes("shell") ? 4 : 2),
  );
  if (negativeControl.startsWith("cleanup-"))
    NodeAssert.match(result.report.cleanupCause, /^CLEANUP_DEADLINE:/);
  if (negativeControl === "mcp-startup-stall") {
    // Native SDK shutdown leaves the opening MCP child alive. The pre-existing
    // service must own it until the independently verified unit drain above.
    NodeAssert.equal(result.report.cleanupCause, undefined);
    NodeAssert.ok(result.report.ownedMembersAfterCleanup.length >= 2);
    NodeAssert.deepEqual(
      result.report.ownedMembersAfterCleanup,
      result.report.ownedMembersBeforeCleanup,
    );
  }
  NodeAssert.equal(result.ownedExit.confirmed, true);
  console.log(`PASS: ${negativeControl}`);
}
