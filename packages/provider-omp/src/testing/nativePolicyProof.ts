// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { verifyInstallation } from "../server/compatibility.ts";
import { resolveInstalledOmp } from "../server/launch.ts";
import { createControlServer } from "../server/controlChannel.ts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// No native OMP import may precede the isolated child environment.
if (!process.argv.includes("--isolated")) throw new Error("--isolated is required");
const python = process.argv[process.argv.indexOf("--python") + 1];
if (!python || python.startsWith("--")) throw new Error("--python is required");
const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-native-"));
try {
  for (const name of ["home", "cwd", "tmp", "agent", "t3"])
    NodeFS.mkdirSync(NodePath.join(root, name));
  const pythonPath = python.includes("/")
    ? NodeFS.realpathSync(python)
    : NodeChildProcess.spawnSync("which", [python], { encoding: "utf8" }).stdout.trim();
  if (!pythonPath) throw new Error("Python interpreter not found");
  // The materialized-asset proof runs `node`, which CI images don't put in /usr/bin.
  const nodePath = NodeChildProcess.spawnSync("which", ["node"], {
    encoding: "utf8",
  }).stdout.trim();
  if (!nodePath) throw new Error("node not found");
  const env = {
    PATH: [
      NodePath.dirname(process.execPath),
      NodePath.dirname(nodePath),
      NodePath.dirname(pythonPath),
      "/usr/bin",
      "/bin",
    ].join(":"),
    HOME: NodePath.join(root, "home"),
    TMPDIR: NodePath.join(root, "tmp"),
    XDG_CONFIG_HOME: NodePath.join(root, "home", ".config"),
    T3CODE_HOME: NodePath.join(root, "t3"),
    PI_CODING_AGENT_DIR: NodePath.join(root, "agent"),
    LANG: "C.UTF-8",
    TERM: "dumb",
  };
  const check = NodeChildProcess.spawnSync(python, ["--version"], { env, encoding: "utf8" });
  if (check.status !== 0) throw new Error(`Python unavailable: ${check.stderr}`);
  const packageRoot = NodePath.dirname(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent"))),
  );
  const configuredIndex = process.argv.indexOf("--omp-binary");
  const nativeRoot =
    configuredIndex >= 0
      ? resolveInstalledOmp(process.argv[configuredIndex + 1]!, process.env)
      : packageRoot;
  verifyInstallation(NodeFS.realpathSync(nativeRoot), process.versions.bun ?? "missing");
  const reviewIndex = process.argv.indexOf("--review-case");
  const reviewCase = reviewIndex >= 0 ? process.argv[reviewIndex + 1] : undefined;
  if (reviewCase === "assets") {
    const { proveMaterialized } = await import("./nativeMaterialized.ts");
    await proveMaterialized(
      NodeFS.realpathSync(nativeRoot),
      env,
      NodePath.join(root, "cwd"),
      pythonPath,
    );
  } else {
    const child = NodeChildProcess.spawnSync(
      process.execPath,
      [
        ...(process.argv.includes("--unguarded")
          ? []
          : [
              "--preload",
              NodeURL.fileURLToPath(new URL("../server/runtimeLoader.ts", import.meta.url)),
            ]),
        NodeURL.fileURLToPath(new URL("./nativePolicyChild.ts", import.meta.url)),
        NodeFS.realpathSync(nativeRoot),
        pythonPath,
        ...(process.argv.includes("--unguarded") ? ["--unguarded"] : []),
        ...(reviewCase ? ["--review-case", reviewCase] : []),
      ],
      { env, cwd: NodePath.join(root, "cwd"), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    process.stdout.write(child.stdout ?? "");
    process.stderr.write(child.stderr ?? "");
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
    if (child.status === 0 && !process.argv.includes("--unguarded") && !reviewCase) {
      const missing = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--no-env-file",
          NodeURL.fileURLToPath(new URL("./nativePolicyChild.ts", import.meta.url)),
          NodeFS.realpathSync(nativeRoot),
          pythonPath,
          "--missing-hooks",
        ],
        { env, cwd: NodePath.join(root, "cwd"), encoding: "utf8" },
      );
      process.stdout.write(missing.stdout);
      process.stderr.write(missing.stderr);
      NodeAssert.equal(missing.status, 0, "missing guard startup must refuse");
      const { proveMaterialized } = await import("./nativeMaterialized.ts");
      await proveMaterialized(
        NodeFS.realpathSync(nativeRoot),
        env,
        NodePath.join(root, "cwd"),
        pythonPath,
      );
      let complete = false;
      let nativeDialogs = 0;
      const requests: Extract<
        import("../server/controlChannel.ts").ControlEnvelope,
        { type: "approval_request" }
      >[] = [];
      const server = await createControlServer(
        (frame, reply) => {
          if (frame.type === "approval_request") {
            requests.push(frame);
            const send = (request: typeof frame, epoch = request.epoch) =>
              reply({
                v: 1,
                type: "approval_answer",
                providerSession: request.providerSession,
                epoch,
                id: request.id,
                answer: "once",
              });
            if (requests.length === 2) {
              send(requests[0]!, "stale-epoch");
              send(requests[1]!);
              send(requests[0]!);
              send(requests[0]!);
            } else if (requests.length > 2) send(frame);
          }
          if (frame.type === "ready" && frame.id === "proof-complete") {
            complete = true;
            rpc.stdin.end();
          }
          if (frame.type === "cancel") {
            rpc.stdin.end();
          }
        },
        () => {},
      );
      const rpc = NodeChildProcess.spawn(
        process.execPath,
        [
          "--no-env-file",
          "--preload",
          NodeURL.fileURLToPath(new URL("../server/runtimeLoader.ts", import.meta.url)),
          NodeURL.fileURLToPath(new URL("./nativePolicyChild.ts", import.meta.url)),
          NodeFS.realpathSync(nativeRoot),
          pythonPath,
          "--rpc-proof",
          server.credentialPath,
        ],
        { env, cwd: NodePath.join(root, "cwd"), stdio: ["pipe", "pipe", "pipe"] },
      );
      let buffer = "";
      rpc.stdout.setEncoding("utf8");
      rpc.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.type === "extension_ui_request" && frame.method === "select") {
              nativeDialogs++;
              rpc.stdin.write(
                JSON.stringify({ type: "extension_ui_response", id: frame.id, value: "Deny" }) +
                  "\n",
              );
            }
          } catch {
            throw new Error("Malformed native RPC stdout: " + line);
          }
        }
      });
      rpc.stderr.on("data", (chunk) => process.stderr.write(chunk));
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          rpc.once("error", reject);
          rpc.once("close", resolve);
        });
        NodeAssert.equal(code, 0, "native RPC child must shut down cleanly");
        NodeAssert.ok(complete, "native RPC proof must acknowledge completion");
        NodeAssert.equal(nativeDialogs, 1);
        NodeAssert.equal(requests.length, 4);
        NodeAssert.notEqual(requests[0]!.id, requests[1]!.id);
        process.stdout.write(
          JSON.stringify({
            nativeRpc: "PASS",
            approvals: requests.length,
            nativeDialogs,
            privateChannel: true,
            inference: 0,
          }) + "\n",
        );
      } finally {
        if (rpc.exitCode === null) rpc.kill();
        await server.close();
      }
    }
  }
  verifyInstallation(NodeFS.realpathSync(nativeRoot), process.versions.bun ?? "missing");
} finally {
  NodeFS.rmSync(root, { recursive: true, force: true });
}
