// @effect-diagnostics nodeBuiltinImport:off - Real-mitmdump fixtures for the packed inspector, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import { packPlugin } from "@t3tools/plugin-sdk/pack";
import {
  extractPluginArchive,
  type PackedBackend,
  startPackedBackend,
} from "@t3tools/plugin-sdk/testing";

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
