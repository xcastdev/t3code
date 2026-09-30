import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "vitest";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);

it("exercises pinned AgentSession tools, authorization, continuation, and descendant abort", async () => {
  const sdkRoot =
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
    })();
  const fixture = NodeURL.fileURLToPath(new URL("./fixtures/p1-runtime-sdk.mjs", import.meta.url));
  const { stdout, stderr } = await execute(
    process.execPath,
    ["--max-old-space-size=128", fixture],
    {
      env: { ...process.env, PI_RUNTIME_CONTRACT_SDK_ROOT: sdkRoot },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(stderr).toBe("");
  const report = JSON.parse(stdout);
  expect(report.remoteCalls).toBe(0);
  expect(report.records).toHaveLength(6);
}, 35_000);
