import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vitest";

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
  const source = NodeURL.fileURLToPath(new URL("./fixtures/", import.meta.url));
  const names = ["p1-runtime-sdk.mjs", "p1-runtime-mcp.mjs", "p1-runtime-descendants.mjs"];
  let stdout = "";
  let stderr = "";
  let code = 0;
  let unitResult: Record<string, string> = {};
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
    expect(owner.unit).toBe(unit);
    expect(owner.policy.KillMode).toBe("control-group");
    expect(owner.policy.RuntimeMaxUSec).toBe("10s");
    expect(owner.policy.TimeoutStopUSec).toBe("1s");
    expect(owner.max).toBe("536870912");
    expect(owner.swapMax).toBe("0");
    expect(owner.oomGroup).toBe("1");
    expect(owner.path).toBe(`/sys/fs/cgroup${owner.policy.ControlGroup}`);
    expect(owner.path.endsWith(`/${unit}`)).toBe(true);
    const kernel = await NodeFSP.readFile(NodePath.join(owner.path, "cgroup.events"), "utf8").catch(
      (error) => {
        if (error.code === "ENOENT") return "removed";
        throw error;
      },
    );
    // The kernel cannot remove a populated cgroup. A retained cgroup must be empty.
    expect(kernel === "removed" || kernel.split("\n").includes("populated 0")).toBe(true);
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
    expect(unitResult.ExecMainStatus).toBe(String(code));
    expect(unitResult.Result).toBe(code === 0 ? "success" : "exit-code");
    expect(unitResult.ActiveState).toBe(code === 0 ? "inactive" : "failed");
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

it("exercises pinned AgentSession tools, authorization, continuation, and descendant abort", async () => {
  const result = await executeFixture();
  expect(result.code).toBe(0);
  expect(result.report.remoteCalls).toBe(0);
  expect(result.report.records).toHaveLength(6);
  expect(
    result.report.cleanupReceipts.every((receipt: { cleanup: boolean }) => !receipt.cleanup),
  ).toBe(true);
}, 25_000);

it.each(["descendant-abort", "mcp-shutdown"])(
  "rejects when the actual %s consumer is disabled and drains the owned subtree",
  async (negativeControl) => {
    const result = await executeFixture(negativeControl);
    expect(result.code).toBe(1);
    expect(result.report.status).toBe("failed");
    expect(result.report.cause).toMatch(/^WATCHDOG:/);
    expect(result.report.negativeControl).toBe(negativeControl);
    expect(result.report.cleanupReceipts).toHaveLength(1);
    expect(result.report.cleanupReceipts[0].complete).toBe(true);
    expect(result.report.cleanupReceipts[0].cleanup).toBe(true);
    expect(result.report.cleanupReceipts[0].pids).toHaveLength(
      negativeControl === "descendant-abort" ? 3 : 1,
    );
  },
  25_000,
);

it.each([
  "mcp-startup-stall",
  "shell-pre-receipt-stall",
  "cleanup-abort-stall",
  "cleanup-shutdown-stall",
])(
  "bounds %s before SDK receipts or through hanging cleanup",
  async (negativeControl) => {
    const result = await executeFixture(negativeControl);
    expect(result.code).not.toBe(0);
    expect(result.report.status).toBe("failed");
    expect(result.report.negativeControl).toBe(negativeControl);
    expect(result.report.cause).toMatch(/^WATCHDOG:/);
    expect(result.report.remoteCalls).toBe(0);
    expect(result.report.ownedMembersBeforeCleanup.length).toBeGreaterThanOrEqual(
      negativeControl.includes("abort") || negativeControl.includes("shell") ? 4 : 2,
    );
    if (negativeControl.startsWith("cleanup-"))
      expect(result.report.cleanupCause).toMatch(/^CLEANUP_DEADLINE:/);
    expect(result.ownedExit.confirmed).toBe(true);
  },
  25_000,
);
