// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeAssert from "node:assert/strict";
import { createControlServer } from "../server/controlChannel.ts";
import { ownedPolicyManifest } from "../server/runtimeOptions.ts";
import { OmpProtocolDecoder, type OmpRpcRecord } from "../server/protocol.ts";
import { OmpToolBridge, AuthorizedMcpClient } from "../server/toolBridge.ts";
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-native-products-"));
const nativeRoot = await NodeFSP.realpath(
  NodeURL.fileURLToPath(new URL("../../node_modules/@oh-my-pi/pi-coding-agent", import.meta.url)),
);
const bun =
  process.env.T3_OMP_PROOF_BUN ?? "/home/user/.local/share/mise/installs/bun/1.4.4/bin/bun";
let child: NodeChildProcess.ChildProcess | undefined;
const control = await createControlServer(
  (frame, reply) => {
    if (frame.type === "approval_request")
      reply({ ...frame, type: "approval_answer", answer: "once" });
  },
  () => {},
);
try {
  for (const name of ["home", "cwd", "agent", "tmp"])
    await NodeFSP.mkdir(NodePath.join(root, name));
  const config = NodePath.join(root, "config.json");
  await NodeFSP.writeFile(
    config,
    JSON.stringify({
      cwd: NodePath.join(root, "cwd"),
      agentDir: NodePath.join(root, "agent"),
      environment: "proof",
      project: "proof",
      providerSession: "product-proof",
      mode: "approval-required",
      credentialPath: control.credentialPath,
      policyManifest: ownedPolicyManifest,
    }),
  );
  child = NodeChildProcess.spawn(
    bun,
    [
      "--no-env-file",
      "--preload",
      NodeURL.fileURLToPath(new URL("../server/runtimeLoader.ts", import.meta.url)),
      NodeURL.fileURLToPath(new URL("./nativeProductChild.ts", import.meta.url)),
      nativeRoot,
      config,
    ],
    {
      cwd: NodePath.join(root, "cwd"),
      env: {
        HOME: NodePath.join(root, "home"),
        TMPDIR: NodePath.join(root, "tmp"),
        PATH: NodePath.dirname(bun) + ":/usr/bin:/bin",
        PI_CODING_AGENT_DIR: NodePath.join(root, "agent"),
        LANG: "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    },
  );
  const processExit = Promise.withResolvers<number | null>();
  child.once("exit", (code) => processExit.resolve(code));
  child.once("error", (error) => processExit.reject(error));
  let next = 0;
  const requests = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const proof = Promise.withResolvers<OmpRpcRecord>();
  const send = async (record: OmpRpcRecord) => {
    NodeAssert.ok(child?.stdin);
    await new Promise<void>((resolve, reject) =>
      child!.stdin!.write(JSON.stringify(record) + "\n", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  };
  const request = async (record: OmpRpcRecord) => {
    const id = `proof-${next++}`;
    const pending = Promise.withResolvers<unknown>();
    requests.set(id, pending);
    await send({ ...record, id });
    return pending.promise;
  };
  const definition = {
    name: "t3_scoped",
    description: "Authorized fixture tool",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  };
  let grant = true;
  let pendingAborted = false;
  const calls: string[] = [];
  const endpoint = new AuthorizedMcpClient(
    {
      endpoint: "https://fixture.invalid/mcp/session-proof",
      authorizationHeader: "Bearer fixture-secret",
    },
    async (url, init) => {
      NodeAssert.equal(String(url), "https://fixture.invalid/mcp/session-proof");
      NodeAssert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-secret");
      const frame = JSON.parse(String(init?.body));
      let result: unknown = {};
      if (frame.method === "initialize")
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "owned-fixture", version: "1" },
        };
      if (frame.method === "tools/list") result = { tools: grant ? [definition] : [] };
      if (frame.method === "tools/call") {
        NodeAssert.equal(frame.params.name, "t3_scoped");
        if (!grant) return new Response("", { status: 403 });
        const value = frame.params.arguments.value;
        calls.push(value);
        if (value === "pending") {
          grant = false;
          const aborted = Promise.withResolvers<void>();
          init?.signal?.addEventListener(
            "abort",
            () => {
              pendingAborted = true;
              aborted.resolve();
            },
            { once: true },
          );
          await bridge.replace([], "revoked-session-grant");
          await aborted.promise;
          result = { content: [{ type: "text", text: "stale secret result must be discarded" }] };
        } else
          result = {
            content: [
              { type: "text", text: String(value) },
              { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
            ],
          };
      }
      if (frame.id === undefined) return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
  );
  const bridge = new OmpToolBridge(
    (record) => (record.type === "set_host_tools" ? request(record) : send(record)),
    (name, args, signal, update) => endpoint.callTool(name, args, signal, update),
  );
  const decoder = new OmpProtocolDecoder();
  const background: Promise<unknown>[] = [];
  child.stdout!.on("data", (bytes: Buffer) => {
    try {
      for (const frame of decoder.push(bytes)) {
        if (frame.type === "ready") {
          background.push(
            (async () => {
              await request({ type: "negotiate_protocol", protocolVersion: 2 });
              await request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
              await endpoint.connect(new AbortController().signal);
              const tools = await endpoint.listTools(new AbortController().signal);
              await bridge.replace(tools, "session-proof:grant1");
            })().catch((error) => proof.reject(error)),
          );
        } else if (frame.type === "response" && typeof frame.id === "string") {
          if (frame.command === "negotiate_protocol" && frame.success === true) decoder.enableV2();
          const pending = requests.get(frame.id);
          requests.delete(frame.id);
          if (frame.success === true) pending?.resolve(frame.data);
          else pending?.reject(new Error("Native RPC rejected " + frame.command));
        } else if (frame.type === "host_tool_call" || frame.type === "host_tool_cancel")
          background.push(bridge.handle(frame).catch((error) => proof.reject(error)));
        else if (frame.type === "t3_product_proof") {
          proof.resolve(frame);
          child!.stdin!.end();
        }
      }
    } catch (error) {
      proof.reject(error);
    }
  });
  let stderr = "";
  child.stderr!.on("data", (bytes) => {
    stderr += String(bytes);
  });
  const result = await Promise.race([
    proof.promise,
    processExit.promise.then((code) => {
      throw new Error(`Native proof exited before completion: ${code}\n${stderr}`);
    }),
  ]);
  NodeAssert.equal(await processExit.promise, 0, stderr);
  await Promise.all(background);
  NodeAssert.deepEqual(calls, ["allowed", "mounted", "eval", "pending"]);
  NodeAssert.equal(pendingAborted, true);
  NodeAssert.ok(!JSON.stringify(result).includes("fixture-secret"));
  process.stdout.write(
    JSON.stringify({
      nativeProducts: "PASS",
      ...result,
      httpCalls: calls.length,
      pendingAborted,
      inference: 0,
    }),
  );
} finally {
  child?.stdin?.end();
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await control.close();
  await NodeFSP.rm(root, { recursive: true, force: true });
}
