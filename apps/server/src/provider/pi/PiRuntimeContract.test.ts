import * as NodeChildProcess from "node:child_process";
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
          "Pi runtime contract requires @earendil-works/pi-coding-agent@0.99.1. Install the pinned test dependency or set PI_RUNTIME_CONTRACT_SDK_ROOT to its package directory; missing SDK is not a passing skip.",
        );
      }
    })()
  );
}

function executeFixture(negativeControl?: string) {
  const fixture = NodeURL.fileURLToPath(new URL("./fixtures/p1-runtime-sdk.mjs", import.meta.url));
  return execute(process.execPath, ["--max-old-space-size=128", fixture], {
    env: {
      ...process.env,
      PI_RUNTIME_CONTRACT_SDK_ROOT: sdkRoot(),
      ...(negativeControl ? { PI_RUNTIME_CONTRACT_NEGATIVE_CONTROL: negativeControl } : {}),
    },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

it("exercises pinned AgentSession tools, authorization, continuation, and descendant abort", async () => {
  const { stdout, stderr } = await executeFixture();
  expect(stderr).toBe("");
  const report = JSON.parse(stdout);
  expect(report.remoteCalls).toBe(0);
  expect(report.records).toHaveLength(6);
}, 35_000);

it.each(["descendant-abort", "mcp-shutdown"])(
  "rejects when the actual %s consumer is disabled and cleans up bound identities",
  async (negativeControl) => {
    try {
      await executeFixture(negativeControl);
      throw new Error("Disabled SDK cleanup unexpectedly passed");
    } catch (error) {
      if (!(error instanceof Error) || !("stderr" in error) || typeof error.stderr !== "string") {
        throw error;
      }
      const report = JSON.parse(error.stderr);
      expect(report.status).toBe("failed");
      expect(report.cause).toMatch(/^WATCHDOG:/);
      expect(report.negativeControl).toBe(negativeControl);
      expect(report.remoteCalls).toBe(0);
      expect(report.cleanupReceipts).toHaveLength(1);
      expect(report.cleanupReceipts[0].complete).toBe(true);
      expect(report.cleanupReceipts[0].cleanup).toBe(true);
      expect(report.cleanupReceipts[0].pids).toHaveLength(
        negativeControl === "descendant-abort" ? 3 : 1,
      );
    }
  },
  10_000,
);
