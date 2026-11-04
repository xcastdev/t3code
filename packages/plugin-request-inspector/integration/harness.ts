// @effect-diagnostics nodeBuiltinImport:off - Real-mitmdump fixtures for the packed inspector, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";
import * as NodeURL from "node:url";

import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import { packPlugin } from "@t3tools/plugin-sdk/pack";
import {
  extractPluginArchive,
  type PackedBackend,
  startPackedBackend,
} from "@t3tools/plugin-sdk/testing";

import {
  makeMitm,
  type MitmFlow,
  type MitmMode,
  type MitmProcess,
  type MitmReplayResult,
  type MitmTunnel,
} from "../backend/mitm.ts";
import { realTimer } from "../backend/replay.ts";

const PACKAGE_DIR = NodeURL.fileURLToPath(new URL("..", import.meta.url));

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Every item a source delivered, and a promise for the first one that matches. */
export interface Inbox<T> {
  readonly items: Array<T>;
  readonly push: (item: T) => void;
  readonly next: (match?: (item: T) => boolean) => Promise<T>;
}

export function makeInbox<T>(): Inbox<T> {
  const items: Array<T> = [];
  const waiters: Array<{ readonly match: (item: T) => boolean; readonly found: Deferred<T> }> = [];
  return {
    items,
    push: (item) => {
      items.push(item);
      for (const waiter of waiters.filter(({ match }) => match(item))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.found.resolve(item);
      }
    },
    next: (match = () => true) => {
      const existing = items.find(match);
      if (existing !== undefined) return Promise.resolve(existing);
      const found = deferred<T>();
      waiters.push({ match, found });
      return found.promise;
    },
  };
}

export function findOnPath(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(NodePath.delimiter)) {
    const candidate = NodePath.join(dir, name);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`${name} is not on PATH.`);
}

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen({ host: "127.0.0.1", port: 0 }, () => {
      const { port } = probe.address() as NodeNet.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Resolves when `pid` has exited, using a kernel pidfd rather than polling. */
export function processExit(pid: number): Promise<void> {
  const watcher = NodeChildProcess.spawn(
    findOnPath("python3"),
    [
      "-I",
      "-c",
      [
        "import os, select, sys",
        "try:",
        "    fd = os.pidfd_open(int(sys.argv[1]))",
        "except ProcessLookupError:",
        "    sys.exit(0)",
        "select.select([fd], [], [])",
      ].join("\n"),
      String(pid),
    ],
    { stdio: "ignore" },
  );
  return new Promise((resolve, reject) => {
    watcher.once("error", reject);
    watcher.once("exit", () => resolve());
  });
}

export interface PackedInspector extends AsyncDisposable {
  readonly worker: PackedBackend;
  readonly dataDir: string;
  readonly extractedDir: string;
  readonly proxyPort: number;
  /** PIDs of every mitmdump the worker started, in start order. */
  readonly mitmdumpPids: () => Array<number>;
  /** Subscribes to `topic` and resolves with the first snapshot or batch item that satisfies `match`. */
  readonly nextItem: <T>(
    topic: string,
    params: unknown,
    match: (item: unknown) => item is T,
  ) => Promise<T>;
}

/**
 * Packs the package into a fresh temp directory, extracts the archive, and starts its backend.
 * mitmdump resolves to a wrapper that records each PID before it execs the real mitmdump.
 */
export async function openPackedInspector(): Promise<PackedInspector> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inspector-integration-"));
  const archive = NodePath.join(root, "request-inspector.t3plugin");
  const extractedDir = NodePath.join(root, "extracted");
  const dataDir = NodePath.join(root, "data");
  const binDir = NodePath.join(root, "bin");
  const pidsFile = NodePath.join(root, "mitmdump.pids");
  await packPlugin(PACKAGE_DIR, archive);
  await extractPluginArchive(archive, extractedDir);
  await NodeFSP.mkdir(binDir);
  await NodeFSP.writeFile(
    NodePath.join(binDir, "mitmdump"),
    `#!/bin/sh\necho $$ >> '${pidsFile}'\nexec '${findOnPath("mitmdump")}' "$@"\n`,
    { mode: 0o755 },
  );
  const proxyPort = await freePort();
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${NodePath.delimiter}${previousPath ?? ""}`;
  let worker: PackedBackend;
  try {
    worker = startPackedBackend({
      entryPath: NodePath.join(extractedDir, "backend", "index.cjs"),
      dataDir,
      pluginId: "request-inspector",
      version: "0.1.0",
      config: { listenHost: "127.0.0.1", listenPort: proxyPort },
    });
  } finally {
    process.env.PATH = previousPath;
  }
  let workerExited = false;
  void worker.exited.then(() => {
    workerExited = true;
  });
  await worker.initialize();
  return {
    worker,
    dataDir,
    extractedDir,
    proxyPort,
    mitmdumpPids: () =>
      NodeFS.existsSync(pidsFile)
        ? NodeFS.readFileSync(pidsFile, "utf8").trim().split("\n").map(Number)
        : [],
    nextItem: async <T>(topic: string, params: unknown, match: (item: unknown) => item is T) => {
      const found = deferred<T>();
      const stop = await worker.subscribe(topic, params, (event: PluginSubscriptionEvent) => {
        if (event.type !== "batch" && event.type !== "snapshot") return;
        const item = event.items.find(match);
        if (item !== undefined) found.resolve(item);
      });
      const item = await found.promise;
      await stop();
      return item;
    },
    [Symbol.asyncDispose]: async () => {
      // Closing the stdin of a worker that already died never completes.
      if (!workerExited) await worker.close();
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

export interface ReceivedRequest {
  readonly method: string;
  readonly url: string;
  readonly rawHeaders: ReadonlyArray<string>;
  readonly body: Buffer;
}

export interface Upstream extends AsyncDisposable {
  readonly port: number;
  readonly received: Array<ReceivedRequest>;
  /** Resolves with the next request the upstream receives. */
  readonly nextRequest: () => Promise<ReceivedRequest>;
}

/** A local HTTP upstream. `respond` writes each response, and may hold it. */
export async function openUpstream(
  respond: (request: ReceivedRequest, response: NodeHttp.ServerResponse) => void | Promise<void>,
): Promise<Upstream> {
  const received: Array<ReceivedRequest> = [];
  let waiter = deferred<ReceivedRequest>();
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry: ReceivedRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        rawHeaders: request.rawHeaders,
        body: Buffer.concat(chunks),
      };
      received.push(entry);
      const current = waiter;
      waiter = deferred();
      current.resolve(entry);
      void respond(entry, response);
    });
  });
  const listening = deferred<number>();
  server.listen({ host: "127.0.0.1", port: 0 }, () =>
    listening.resolve((server.address() as NodeNet.AddressInfo).port),
  );
  return {
    port: await listening.promise,
    received,
    nextRequest: () => waiter.promise,
    [Symbol.asyncDispose]: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Sends one request through the HTTP proxy at `proxyPort` and resolves with the status. */
export function viaProxy(
  proxyPort: number,
  url: string,
  options: { readonly method: string; readonly rawHeaders: Array<string>; readonly body: Buffer },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: options.method,
      path: url,
      headers: options.rawHeaders,
      agent: false,
    });
    request.once("error", reject);
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.end(options.body);
  });
}

const ADDON_PATH = NodeURL.fileURLToPath(new URL("../backend/addon.py", import.meta.url));

export interface RunningMitm {
  readonly process: MitmProcess;
  readonly flows: Inbox<MitmFlow>;
  readonly tunnels: Inbox<MitmTunnel>;
  readonly replays: Inbox<MitmReplayResult>;
}

export interface MitmRuntime extends AsyncDisposable {
  readonly dataDir: string;
  /** Starts a real mitmdump running backend/addon.py; disposal stops it by its captured PID. */
  readonly start: (mode: MitmMode) => Promise<RunningMitm>;
}

/**
 * An addon that only says hello and then ignores every control message, so whatever the proxy
 * does comes from mitmdump's own startup options.
 */
export const HELLO_ONLY_ADDON = `
import asyncio, json, os

class HelloOnly:
    async def running(self):
        _, writer = await asyncio.open_connection(
            "127.0.0.1", int(os.environ["T3_INSPECTOR_CONTROL_PORT"])
        )
        token = os.environ["T3_INSPECTOR_CONTROL_TOKEN"]
        writer.write(json.dumps({"type": "hello", "token": token}).encode() + b"\\n")
        await writer.drain()
        self.writer = writer

addons = [HelloOnly()]
`;

/** The mitm runtime from backend/mitm.ts over a temp dataDir, without the packed worker. */
export async function openMitmRuntime(
  options: { readonly addonSource?: string } = {},
): Promise<MitmRuntime> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inspector-mitm-"));
  const dataDir = NodePath.join(root, "data");
  const runtimeDir = NodePath.join(dataDir, "runtime");
  await NodeFSP.mkdir(runtimeDir, { recursive: true });
  const mitm = makeMitm({
    dataDir,
    addonSource: options.addonSource ?? (await NodeFSP.readFile(ADDON_PATH, "utf8")),
    maxBodyBytes: 1024 * 1024,
    materialize: async (name, contents) => {
      const path = NodePath.join(runtimeDir, name);
      await NodeFSP.writeFile(path, contents);
      return path;
    },
    timer: realTimer,
  });
  const running: Array<MitmProcess> = [];
  return {
    dataDir,
    start: async (mode) => {
      const flows = makeInbox<MitmFlow>();
      const tunnels = makeInbox<MitmTunnel>();
      const replays = makeInbox<MitmReplayResult>();
      const process = await mitm.start(mode, {
        onFlow: async (flow) => flows.push(flow),
        onTunnel: async (tunnel) => tunnels.push(tunnel),
        onReplayResult: async (result) => replays.push(result),
      }).ready;
      running.push(process);
      return { process, flows, tunnels, replays };
    },
    [Symbol.asyncDispose]: async () => {
      await Promise.all(running.map((process) => process.stop()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

/** The Python interpreter mitmdump runs under, read from its shebang. */
export function mitmdumpPython(): string {
  const first = NodeFS.readFileSync(findOnPath("mitmdump"), "utf8").split("\n", 1)[0] ?? "";
  const interpreter = first.startsWith("#!") ? first.slice(2).trim().split(/\s+/) : [];
  if (interpreter[0]?.endsWith("/env") === true && interpreter[1] !== undefined) {
    return findOnPath(interpreter[1]);
  }
  if (interpreter[0] === undefined) throw new Error("mitmdump has no shebang to read.");
  return interpreter[0];
}

/** Runs `match_host` from backend/addon.py on each case with mitmdump's Python. */
export function addonMatchHost(
  cases: ReadonlyArray<{
    readonly sources: ReadonlyArray<string>;
    readonly host: string;
    readonly port: number;
  }>,
): Array<boolean> {
  const result = NodeChildProcess.spawnSync(
    mitmdumpPython(),
    [
      "-I",
      "-B",
      "-c",
      [
        "import importlib.util, json, sys",
        "spec = importlib.util.spec_from_file_location('t3_addon', sys.argv[1])",
        "addon = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(addon)",
        "cases = json.load(sys.stdin)",
        "print(json.dumps([addon.match_host(c['sources'], c['host'], c['port']) for c in cases]))",
      ].join("\n"),
      ADDON_PATH,
    ],
    { input: JSON.stringify(cases), encoding: "utf8", env: { PYTHONDONTWRITEBYTECODE: "1" } },
  );
  if (result.status !== 0) throw new Error(`match_host failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as Array<boolean>;
}

export interface TlsConnection {
  readonly sni: string | undefined;
  /** Raw TCP bytes, TLS records included, as the server's socket counted them. */
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

export interface TlsServer extends AsyncDisposable {
  readonly port: number;
  readonly cert: string;
  readonly connections: Inbox<TlsConnection>;
}

/**
 * A TLS echo-ish server with a fresh self-signed cert for `names`. It answers each line with
 * `ok <line>` and closes; each connection's raw byte counts arrive once its socket closes.
 */
export async function openTlsServer(names: ReadonlyArray<string>): Promise<TlsServer> {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "inspector-tls-"));
  const keyPath = NodePath.join(dir, "key.pem");
  const certPath = NodePath.join(dir, "cert.pem");
  const generated = NodeChildProcess.spawnSync(
    findOnPath("openssl"),
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      `/CN=${names[0]}`,
      "-addext",
      `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (generated.status !== 0) throw new Error(`openssl failed: ${generated.stderr}`);
  const cert = await NodeFSP.readFile(certPath, "utf8");
  const context = NodeTls.createSecureContext({ key: await NodeFSP.readFile(keyPath), cert });
  const connections = makeInbox<TlsConnection>();
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((raw) => {
    sockets.add(raw);
    let sni: string | undefined;
    const secure = new NodeTls.TLSSocket(raw, {
      isServer: true,
      secureContext: context,
      SNICallback: (name, done) => {
        sni = name;
        done(null, context);
      },
    });
    secure.on("error", () => undefined);
    let line = "";
    secure.setEncoding("utf8");
    secure.on("data", (chunk: string) => {
      line += chunk;
      if (line.includes("\n")) secure.end(`ok ${line}`);
    });
    raw.on("error", () => undefined);
    raw.once("close", () => {
      sockets.delete(raw);
      connections.push({ sni, bytesRead: raw.bytesRead, bytesWritten: raw.bytesWritten });
    });
  });
  const listening = deferred<number>();
  server.listen({ host: "127.0.0.1", port: 0 }, () =>
    listening.resolve((server.address() as NodeNet.AddressInfo).port),
  );
  return {
    port: await listening.promise,
    cert,
    connections,
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * CONNECTs through the HTTP proxy, then speaks TLS trusting only `ca` with `servername` as SNI.
 * Resolves with the server's reply, so it fails if the proxy intercepted TLS.
 */
export function tlsViaConnect(
  proxyPort: number,
  target: { readonly host: string; readonly port: number },
  options: { readonly servername: string; readonly ca: string; readonly line: string },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: `${target.host}:${target.port}`,
      agent: false,
    });
    request.once("error", reject);
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT answered ${response.statusCode}`));
        return;
      }
      const secure = NodeTls.connect({ socket, servername: options.servername, ca: options.ca });
      let reply = "";
      secure.setEncoding("utf8");
      secure.once("error", reject);
      secure.once("secureConnect", () => secure.write(`${options.line}\n`));
      secure.on("data", (chunk: string) => {
        reply += chunk;
      });
      secure.once("end", () => {
        secure.end();
        resolve(reply);
      });
    });
    request.end();
  });
}

/** Sends `rawRequest` through a SOCKS5 proxy (no auth, IPv4 target) and resolves with the reply. */
export function socks5Request(
  proxyPort: number,
  target: { readonly host: string; readonly port: number },
  rawRequest: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1");
    socket.once("error", reject);
    let stage: "greeting" | "connect" | "http" = "greeting";
    let buffered = Buffer.alloc(0);
    const reply: Array<Buffer> = [];
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk: Buffer) => {
      if (stage === "http") {
        reply.push(chunk);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      if (stage === "greeting" && buffered.byteLength >= 2) {
        if (buffered[0] !== 5 || buffered[1] !== 0) reject(new Error("SOCKS5 greeting refused"));
        buffered = buffered.subarray(2);
        stage = "connect";
        const port = Buffer.alloc(2);
        port.writeUInt16BE(target.port);
        socket.write(
          Buffer.concat([
            Buffer.from([5, 1, 0, 1]),
            Buffer.from(target.host.split(".").map(Number)),
            port,
          ]),
        );
      }
      if (stage === "connect" && buffered.byteLength >= 10) {
        if (buffered[1] !== 0) reject(new Error(`SOCKS5 connect failed (${buffered[1]})`));
        stage = "http";
        if (buffered.byteLength > 10) reply.push(buffered.subarray(10));
        socket.write(rawRequest);
      }
    });
    socket.once("end", () => resolve(Buffer.concat(reply).toString("latin1")));
  });
}
