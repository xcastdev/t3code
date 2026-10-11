// @effect-diagnostics nodeBuiltinImport:off - The regression boots and stops the actual Node CLI with isolated filesystem state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

it.skipIf(process.env.T3_SERVER_STARTUP_GATE !== "1")(
  "boots the complete server graph before publishing pairing access",
  async () => {
    const evidenceDirectory = process.env.T3_SERVER_STARTUP_EVIDENCE_DIR;
    if (!evidenceDirectory) throw new Error("An isolated startup evidence directory is required");
    await NodeFSP.mkdir(evidenceDirectory, { recursive: true });
    const home = await NodeFSP.mkdtemp(NodePath.join(evidenceDirectory, "startup-home-"));
    const socket = NodeNet.createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", resolve);
    });
    const address = socket.address();
    if (address === null || typeof address === "string") throw new Error("No startup port");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );
    const child = NodeChildProcess.spawn(
      "node",
      [
        "src/bin.ts",
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--base-dir",
        home,
        "--no-browser",
      ],
      {
        cwd: NodeURL.fileURLToPath(new URL("../", import.meta.url)),
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, T3CODE_DEV_AUTH_TOKEN: "", T3CODE_HOME: home },
      },
    );
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    const pairing = new Promise<string>((resolve, reject) => {
      const diagnostics: string[] = [];
      child.once("error", reject);
      child.once("exit", () =>
        reject(
          new Error(`Server exited before publishing pairing access: ${diagnostics.join("\n")}`),
        ),
      );
      for (const stream of [child.stdout, child.stderr]) {
        const lines = NodeReadline.createInterface({ input: stream });
        lines.on("line", (line) => {
          if (!line.includes("token=")) {
            diagnostics.push(line.slice(0, 512));
            if (diagnostics.length > 20) diagnostics.shift();
          }
          if (line.includes("Service not found:")) reject(new Error(diagnostics.join("\n")));
          const match = line.match(/https?:\/\/[^\s\p{Cc}"']+\/pair#token=[^\s\p{Cc}"']+/u);
          if (match) resolve(match[0]);
        });
      }
    });
    try {
      const url = new URL(await pairing);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.port).toBe(String(port));
      expect(url.pathname).toBe("/pair");
      expect(url.hash.startsWith("#token=")).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
      await done;
    }
  },
  45_000,
);
