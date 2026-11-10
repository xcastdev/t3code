// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off globalConsole:off globalDate:off - Stages and probes isolated installed processes through their production protocol.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    "server-bin": { type: "string" },
    isolated: { type: "boolean" },
    bun: { type: "string" },
  },
});
NodeAssert.equal(
  values.isolated,
  true,
  "Pass --isolated; this check always owns disposable state.",
);
const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const serverBin = NodePath.resolve(values["server-bin"] ?? "apps/server/dist/bin.mjs");
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-installed-"));
const stage = NodePath.join(root, "server");
const native = NodePath.join(root, "native");
const home = NodePath.join(root, "home");
const t3Home = NodePath.join(root, "t3");
const audit = NodePath.join(root, "native-audit.jsonl");
const children = new Set<NodeChildProcess.ChildProcess>();
let socket: WebSocket | undefined;
let serverLog = "";

async function run(command: string, args: string[], cwd: string) {
  const child = NodeChildProcess.spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const [code] = await NodeEvents.EventEmitter.once(child, "exit");
  children.delete(child);
  NodeAssert.equal(code, 0, command + " failed: " + output.slice(-6000));
}

async function files(path: string): Promise<string[]> {
  const entries = await NodeFSP.readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const full = NodePath.join(path, entry.name);
        if (entry.isDirectory()) return files(full);
        return [full];
      }),
    )
  ).flat();
}

async function digest(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for (const file of (await files(path)).sort()) {
    const stat = await NodeFSP.lstat(file);
    hash.update(NodePath.relative(path, file));
    hash.update(
      stat.isSymbolicLink() ? await NodeFSP.readlink(file) : await NodeFSP.readFile(file),
    );
  }
  return hash.digest("hex");
}

async function outsideCheckout(path: string) {
  for (const file of await files(path)) {
    const resolved = await NodeFSP.realpath(file);
    NodeAssert.ok(
      !resolved.startsWith(repo + NodePath.sep),
      "Staged file resolves into checkout: " + file,
    );
  }
}

function awaitFile(path: string, child: NodeChildProcess.ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const watcher = NodeFS.watch(NodePath.dirname(path), () => {
      if (NodeFS.existsSync(path)) {
        cleanup();
        resolve();
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Staged server readiness timed out."));
    }, 60_000);
    const exited = () => {
      cleanup();
      reject(new Error("Staged server exited before readiness. Log: " + serverLog.slice(-3000)));
    };
    const cleanup = () => {
      watcher.close();
      clearTimeout(timer);
      child.off("exit", exited);
    };
    child.once("exit", exited);
    if (NodeFS.existsSync(path)) {
      cleanup();
      resolve();
    }
  });
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const events = () =>
  NodeFS.existsSync(audit)
    ? NodeFS.readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => record(JSON.parse(line)))
    : [];

try {
  await Promise.all(
    [stage, native, home, NodePath.join(root, "bin"), NodePath.join(t3Home, "userdata")].map(
      (path) => NodeFSP.mkdir(path, { recursive: true }),
    ),
  );
  await NodeFSP.cp(NodePath.dirname(serverBin), NodePath.join(stage, "dist"), { recursive: true });
  const manifest = JSON.parse(
    await NodeFSP.readFile(NodePath.join(repo, "apps/server/package.json"), "utf8"),
  );
  const external = selectCliRuntimeExternalDependencies(manifest.dependencies);
  for (const name of Object.keys(external)) {
    const installed = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(repo, "apps/server/node_modules", name, "package.json"),
        "utf8",
      ),
    );
    external[name] = installed.version;
  }
  await NodeFSP.writeFile(
    NodePath.join(stage, "package.json"),
    JSON.stringify({
      name: "t3-omp-installed-server",
      private: true,
      type: "module",
      packageManager: "pnpm@12.14.0",
      dependencies: external,
    }),
  );
  const fixture = NodePath.join(repo, "scripts/fixtures/omp-installed");
  for (const file of ["package.json", "pnpm-lock.yaml"])
    await NodeFSP.copyFile(NodePath.join(fixture, file), NodePath.join(native, file));
  await run("pnpm", ["install", "--prod", "--ignore-scripts"], stage);
  await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], native);
  const nativeRoot = await NodeFSP.realpath(
    NodePath.join(native, "node_modules/@oh-my-pi/pi-coding-agent"),
  );
  NodeAssert.equal(
    JSON.parse(await NodeFSP.readFile(NodePath.join(nativeRoot, "package.json"), "utf8")).version,
    "18.16.0",
  );
  await outsideCheckout(stage);
  await outsideCheckout(native);
  const originalHash = await digest(nativeRoot);
  const bun = values.bun ?? process.env.T3_OMP_PROOF_BUN ?? "bun";
  const actualBun = NodeChildProcess.execFileSync(
    bun,
    ["--no-env-file", "-e", "process.stdout.write(process.execPath)"],
    { encoding: "utf8" },
  ).trim();
  NodeAssert.equal(
    NodeChildProcess.execFileSync(actualBun, ["--version"], { encoding: "utf8" }).trim(),
    "1.4.4",
  );
  const preload = NodePath.join(root, "network-guard.mjs");
  await NodeFSP.writeFile(
    preload,
    [
      'import fs from "node:fs"; import net from "node:net"; import tls from "node:tls";',
      "const audit = " + JSON.stringify(audit) + ";",
      'const log = (event) => fs.appendFileSync(audit, JSON.stringify({pid:process.pid,...event})+"\\n");',
      'log({kind:"start"}); process.on("exit",(code)=>log({kind:"exit",code}));',
      'process.on("uncaughtExceptionMonitor",(error)=>log({kind:"error",message:String(error.stack ?? error)}));',
      'globalThis.fetch = async (input) => { log({kind:"blockedFetch", inference:/messages|completions|responses/.test(String(input))}); throw new Error("Installed fixture forbids network/inference"); };',
      'const connect = net.Socket.prototype.connect; net.Socket.prototype.connect = function(...args) { const options=Array.isArray(args[0])?args[0][0]:args[0]; if(typeof options?.path !== "string" && !(typeof options === "string" && options.startsWith("/"))) { log({kind:"blockedConnect"}); throw new Error("Installed fixture permits only private IPC"); } return connect.apply(this,args); };',
      'tls.connect = () => { log({kind:"blockedTls"}); throw new Error("Installed fixture forbids TLS"); };',
      'const write = net.Socket.prototype.write; net.Socket.prototype.write = function(...args) { try { const frame=JSON.parse(String(args[0])); if(frame.type==="ready") log({kind:"ready",payload:frame.payload}); } catch {} return write.apply(this,args); };',
      'const stdout=process.stdout.write.bind(process.stdout); process.stdout.write = function(...args) { try { const frame=JSON.parse(String(args[0])); if(frame.type==="response") log({kind:"rpc",command:frame.command,success:frame.success}); } catch {} return stdout(...args); };',
    ].join("\n"),
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  await NodeFSP.writeFile(
    NodePath.join(root, "bin/bun"),
    "#!/bin/sh\nexec " + quote(actualBun) + " --preload " + quote(preload) + ' "$@"\n',
    { mode: 0o700 },
  );
  const serverPreload = NodePath.join(root, "server-network-guard.mjs");
  await NodeFSP.writeFile(
    serverPreload,
    [
      'import net from "node:net"; import tls from "node:tls";',
      'const local=(host)=>host==="127.0.0.1"||host==="localhost"||host==="::1"||host==="[::1]";',
      'const request=globalThis.fetch; globalThis.fetch=(input,...args)=>{const url=new URL(typeof input==="string"||input instanceof URL?input:input.url); if(!local(url.hostname)) throw new Error("Staged server forbids external network"); return request(input,...args);};',
      'const connect=net.Socket.prototype.connect; net.Socket.prototype.connect=function(...args){const value=Array.isArray(args[0])?args[0][0]:args[0]; const path=typeof value==="string"&&value.startsWith("/")||typeof value?.path==="string"; const host=typeof value==="object"?value.host:typeof args[1]==="string"?args[1]:undefined; if(!path&&host!==undefined&&!local(host)) throw new Error("Staged server forbids external sockets"); return connect.apply(this,args);};',
      'tls.connect=()=>{throw new Error("Staged server forbids TLS");};',
    ].join("\n"),
  );
  const environment = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: root,
    TEMP: root,
    LANG: "C.UTF-8",
    PATH:
      NodePath.join(root, "bin") +
      NodePath.delimiter +
      NodePath.dirname(process.execPath) +
      NodePath.delimiter +
      "/usr/bin:/bin",
    PI_CODING_AGENT_DIR: NodePath.join(root, "agent"),
    XDG_CONFIG_HOME: NodePath.join(home, ".config"),
    XDG_DATA_HOME: NodePath.join(home, ".local/share"),
    XDG_CACHE_HOME: NodePath.join(home, ".cache"),
    T3CODE_HOME: t3Home,
    T3CODE_NO_BROWSER: "true",
  };
  const portServer = NodeNet.createServer();
  portServer.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(portServer, "listening");
  const address = portServer.address();
  NodeAssert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    portServer.close((error) => (error ? reject(error) : resolve())),
  );
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const server = NodeChildProcess.spawn(
    process.execPath,
    [
      "--import",
      serverPreload,
      NodePath.join(stage, "dist", NodePath.basename(serverBin)),
      "serve",
      "--bootstrap-fd",
      "3",
    ],
    {
      cwd: stage,
      env: environment,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  children.add(server);
  server.stdout!.on("data", (chunk) => {
    serverLog += String(chunk);
  });
  server.stderr!.on("data", (chunk) => {
    serverLog += String(chunk);
  });
  const serverExit = NodeEvents.EventEmitter.once(server, "exit");
  const bootstrap = server.stdio[3];
  NodeAssert.ok(bootstrap && "end" in bootstrap);
  bootstrap.end(
    JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port,
      host: "127.0.0.1",
      t3Home,
      desktopBootstrapToken: token,
      shellEnvironmentPrepared: true,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    }) + "\n",
  );
  await awaitFile(NodePath.join(t3Home, "userdata/server-runtime.json"), server);
  const origin = "http://127.0.0.1:" + port;
  const paired = await fetch(origin + "/api/auth/browser-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: token }),
  });
  NodeAssert.equal(paired.status, 200, "Staged bootstrap authentication failed.");
  const cookie = paired.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  const ticketResponse = await fetch(origin + "/api/auth/websocket-ticket", {
    method: "POST",
    headers: { cookie },
  });
  NodeAssert.equal(ticketResponse.status, 200);
  const ticket = record(await ticketResponse.json()).ticket;
  NodeAssert.equal(typeof ticket, "string");
  socket = new WebSocket(
    origin.replace("http:", "ws:") +
      "/ws?orchestrationProtocol=2&wsTicket=" +
      encodeURIComponent(String(ticket)),
  );
  await NodeEvents.EventEmitter.once(socket, "open");
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const parsed: unknown = JSON.parse(String(event.data));
    for (const frame of Array.isArray(parsed) ? parsed : [parsed]) {
      const message = record(frame);
      if (message._tag === "Ping") {
        socket!.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      if (message._tag !== "Exit") continue;
      const waiting = pending.get(String(message.requestId));
      if (!waiting) continue;
      pending.delete(String(message.requestId));
      const exit = record(message.exit);
      if (exit._tag === "Success") waiting.resolve(exit.value);
      else waiting.reject(new Error("Staged RPC failed: " + JSON.stringify(exit)));
    }
  });
  const rpc = async (tag: string, payload: unknown = {}) => {
    const id = String(++nextId);
    const response = Promise.withResolvers<unknown>();
    pending.set(id, response);
    socket!.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    const timer = setTimeout(
      () => response.reject(new Error("Staged RPC timed out: " + tag)),
      60_000,
    );
    try {
      return await response.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  const config = record(await rpc("server.getConfig"));
  const providers = config.providers;
  NodeAssert.ok(Array.isArray(providers));
  const disabled = providers.map(record).find((provider) => provider.driver === "omp");
  NodeAssert.ok(disabled, "Built artifact has no native OMP registration.");
  NodeAssert.equal(disabled.status, "disabled");
  const instanceId = String(disabled.instanceId);
  const configure = (binaryPath: string, enabled = true) =>
    rpc("server.updateSettings", {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId,
        instance: { driver: "omp", enabled, config: { binaryPath, launchArgs: "" } },
      },
    });
  const refresh = async () => {
    const response = record(
      await rpc("server.refreshProviders", { instanceId, cwd: stage, fresh: true }),
    );
    NodeAssert.ok(Array.isArray(response.providers));
    const provider = response.providers
      .map(record)
      .find((value) => value.instanceId === instanceId);
    NodeAssert.ok(provider);
    return provider;
  };
  await configure(NodePath.join(nativeRoot, "dist/cli.js"));
  const installed = await refresh();
  NodeAssert.equal(installed.installed, true, "Pinned native fixture was not resolved.");
  NodeAssert.equal(
    installed.version,
    "18.16.0",
    "Discovery did not complete the guarded native RPC handshake.",
  );
  NodeAssert.ok(
    installed.status === "ready" || installed.status === "warning",
    "Native discovery failed: " + JSON.stringify(installed),
  );
  const ready = events().find((event) => event.kind === "ready");
  NodeAssert.ok(ready, "Private control acknowledgement absent.");
  const guards = record(ready.payload);
  NodeAssert.equal(guards.recipe, "omp-18.16.0-bun-1.4.4");
  NodeAssert.ok(
    Array.isArray(guards.guards) &&
      guards.guards.includes("eval/preludes.ts") &&
      guards.guards.includes("config/settings.ts"),
  );
  for (const command of ["negotiate_protocol", "get_state", "get_available_models"])
    NodeAssert.ok(
      events().some(
        (event) => event.kind === "rpc" && event.command === command && event.success === true,
      ),
      "Native RPC acknowledgement absent: " + command,
    );
  const cacheFiles = await files(NodePath.join(t3Home, "caches"));
  NodeAssert.ok(cacheFiles.some((path) => path.endsWith("/preload.ts")));
  NodeAssert.ok(cacheFiles.some((path) => path.endsWith("/runtimeMain.ts")));
  for (const file of cacheFiles.filter((path) => path.endsWith(".ts")))
    NodeAssert.ok(
      !(await NodeFSP.readFile(file, "utf8")).includes('from "@t3tools/'),
      "Materialized runtime depends on checkout imports.",
    );
  const usageDirectory = NodePath.join(
    t3Home,
    "userdata/provider-omp",
    encodeURIComponent(instanceId),
  );
  await NodeFSP.mkdir(usageDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  await NodeFSP.writeFile(
    NodePath.join(usageDirectory, "installed-check.jsonl"),
    [
      JSON.stringify({ type: "session", id: "installed-check-session" }),
      JSON.stringify({
        type: "message",
        id: "installed-check-message",
        timestamp,
        message: {
          role: "assistant",
          provider: "fixture",
          model: "installed-fixture",
          usage: {
            input: 7,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0.01 },
          },
        },
      }),
    ].join("\n") + "\n",
  );
  const summary = record(
    await rpc("server.getUsageSummary", {
      sinceDay: timestamp.slice(0, 10),
      untilDay: timestamp.slice(0, 10),
      timeZone: "UTC",
      awaitRefresh: true,
    }),
  );
  NodeAssert.ok(Array.isArray(summary.buckets));
  const usage = summary.buckets
    .map(record)
    .find((bucket) => bucket.provider === "omp" && bucket.model === "installed-fixture");
  NodeAssert.ok(usage, "Built usage service did not scan the registered OMP reader.");
  NodeAssert.equal(record(usage.totals).uncachedInputTokens, 7);
  NodeAssert.equal(record(usage.totals).outputTokens, 3);
  NodeAssert.equal(usage.records, 1);
  await configure(NodePath.join(root, "missing/omp"));
  const unavailable = await refresh();
  NodeAssert.equal(unavailable.status, "error", "Unavailable executable must fail closed.");
  NodeAssert.equal(unavailable.installed, false);
  const changed = NodePath.join(root, "changed-native");
  await NodeFSP.cp(nativeRoot, changed, { recursive: true, dereference: true });
  await NodeFSP.appendFile(
    NodePath.join(changed, "src/eval/preludes.ts"),
    "\n// Changed source fixture\n",
  );
  await configure(NodePath.join(changed, "dist/cli.js"));
  NodeAssert.equal(
    (await refresh()).status,
    "error",
    "Same-version changed native source must fail closed.",
  );
  NodeAssert.ok(
    events().some(
      (event) =>
        event.kind === "error" &&
        String(event.message).includes("Unsupported OMP source fingerprint"),
    ),
    "Changed-source rejection did not identify the native fingerprint.",
  );
  await configure(NodePath.join(nativeRoot, "dist/cli.js"), false);
  NodeAssert.equal((await refresh()).status, "disabled");
  socket.close();
  server.kill("SIGTERM");
  const [serverCode, serverSignal] = await serverExit;
  NodeAssert.ok(
    // Effect's normal signal interruption exits 130 after scoped finalizers.
    serverCode === 0 || serverCode === 130 || serverSignal === "SIGTERM",
    "Staged server did not shut down cleanly.",
  );
  children.delete(server);
  NodeAssert.equal(
    NodeFS.existsSync(NodePath.join(t3Home, "userdata/server-runtime.json")),
    false,
    "Staged runtime record survived shutdown.",
  );
  NodeAssert.equal(
    await digest(nativeRoot),
    originalHash,
    "Verification changed the installed native package.",
  );
  NodeAssert.ok(
    !events().some((event) => event.kind === "blockedFetch" && event.inference === true),
    "Inference was attempted.",
  );
  for (const event of events().filter((entry) => entry.kind === "ready")) {
    NodeAssert.ok(
      events().some(
        (entry) => entry.kind === "exit" && entry.pid === event.pid && entry.code === 0,
      ),
      "A ready native session did not exit cleanly.",
    );
  }
  const started = events().filter((event) => event.kind === "start");
  NodeAssert.ok(
    started.every((event) =>
      events().some((other) => other.kind === "exit" && other.pid === event.pid),
    ),
    "A native process did not shut down cleanly.",
  );
  console.log(
    JSON.stringify({
      installedBundle: true,
      independentLockedFixture: true,
      nativeUnchanged: true,
      cacheAssets: true,
      guardAcknowledgements: true,
      rpcAcknowledgements: true,
      usageReader: true,
      unavailableRefused: true,
      changedFingerprintRefused: true,
      inference: 0,
      nativeProcesses: started.length,
      nativeNetworkBlocked: events().filter((event) => event.kind === "blockedFetch").length,
      serverExitCode: serverCode,
    }),
  );
} catch (error) {
  throw new Error(String(error) + " Native diagnostics: " + JSON.stringify(events()), {
    cause: error,
  });
} finally {
  socket?.close();
  for (const child of children) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  await NodeFSP.rm(root, { recursive: true, force: true });
}
