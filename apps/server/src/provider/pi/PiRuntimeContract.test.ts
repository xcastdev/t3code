// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - The standalone SDK fixture uses captured Node process handles and an independent deadline.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeURL from "node:url";
import { expect, it } from "vitest";

function sdkRoot() {
  if (process.env.PI_RUNTIME_CONTRACT_SDK_ROOT) return process.env.PI_RUNTIME_CONTRACT_SDK_ROOT;
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
}

async function executePortable(
  negativeControl = "",
  args = ["--portable"],
  root = sdkRoot(),
  ownedUnit = "",
) {
  const env = {
    ...process.env,
    PATH: "",
    PI_RUNTIME_CONTRACT_SDK_ROOT: root,
    PI_RUNTIME_CONTRACT_NEGATIVE_CONTROL: negativeControl,
    PI_RUNTIME_CONTRACT_OWNED_UNIT: ownedUnit,
  };
  // No platform command is available. Only this directly captured Node child may run.
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--max-old-space-size=128",
      NodeURL.fileURLToPath(new URL("./fixtures/p1-runtime-sdk.mjs", import.meta.url)),
      ...args,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let failure: Error | undefined;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutDecoder = new NodeStringDecoder.StringDecoder("utf8");
  const stderrDecoder = new NodeStringDecoder.StringDecoder("utf8");
  const completion = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const deadline = setTimeout(() => {
        failure = new Error("Portable SDK fixture deadline expired");
        child.kill("SIGKILL");
      }, 10_000);
      child.on("error", (error) => {
        failure = error;
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (failure) return;
        if (stdoutBytes + chunk.byteLength > 1024 * 1024) {
          failure = new Error("Portable output bound exceeded");
          child.kill("SIGKILL");
          return;
        }
        stdoutBytes += chunk.byteLength;
        stdout += stdoutDecoder.write(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (failure) return;
        if (stderrBytes + chunk.byteLength > 1024 * 1024) {
          failure = new Error("Portable output bound exceeded");
          child.kill("SIGKILL");
          return;
        }
        stderrBytes += chunk.byteLength;
        stderr += stderrDecoder.write(chunk);
      });
      child.on("close", (code) => {
        clearTimeout(deadline);
        if (failure) reject(failure);
        else
          resolve({
            code,
            stdout: stdout + stdoutDecoder.end(),
            stderr: stderr + stderrDecoder.end(),
          });
      });
    },
  );
  return { ...(await completion), pid: child.pid };
}

it("exercises four actual pinned SDK consumers without Linux commands or child trees", async () => {
  const result = await executePortable();
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout.trim());
  expect(report.mode).toBe("portable");
  expect(report.pin).toBe("0.99.1");
  expect(report.fixturePid).toBe(result.pid);
  expect(report.remoteCalls).toBe(0);
  expect(report.callbackCount).toBe(9);
  expect(report.records.map((record: { name: string }) => record.name)).toEqual([
    "AgentSession dispatch resolves assigned cwd and trusted resources",
    "Advertised custom tool enforces role denial in its handler",
    "Steering and follow-up drain before true settlement",
    "Transient failure cannot settle before successful retry",
  ]);
  expect(report.cleanupReceipts).toEqual([]);
  const evidence = process.env.PI_RUNTIME_CONTRACT_EVIDENCE_DIR;
  if (evidence) {
    await NodeFSP.mkdir(evidence, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(evidence, "portable-success.json"),
      JSON.stringify(result, null, 2),
    );
  }
}, 15_000);

it.each([
  "descendant-abort",
  "mcp-shutdown",
  "mcp-startup-stall",
  "shell-pre-receipt-stall",
  "cleanup-abort-stall",
  "cleanup-shutdown-stall",
])(
  "portable mode refuses process negative control %s before SDK startup",
  async (control) => {
    const result = await executePortable(control);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Portable mode forbids process negative controls");
  },
  15_000,
);

it("portable mode cannot select the Linux process cases or fall back to ownership", async () => {
  const result = await executePortable("", ["--portable", "--linux-ownership"]);
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Select exactly --portable or --linux-ownership");
}, 15_000);

it("portable mode refuses an inherited Linux owner before any platform access", async () => {
  const result = await executePortable(
    "",
    ["--portable"],
    sdkRoot(),
    "forbidden-inherited-owner.service",
  );
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Portable mode forbids Linux ownership fallback");
}, 15_000);

it("missing pinned SDK remains a hard failure", async () => {
  const result = await executePortable(
    "",
    ["--portable"],
    NodePath.join(NodePath.dirname(process.execPath), "missing-pi-sdk"),
  );
  expect(result.code).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ENOENT");
}, 15_000);
