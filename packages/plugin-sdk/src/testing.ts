// @effect-diagnostics nodeBuiltinImport:off - Test helpers for plugin packages, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";

import type { PluginSubscriptionEvent } from "@t3tools/contracts";
import JSZip from "jszip";

import { PLUGIN_WORKER_PROTOCOL_VERSION, type PluginCaller } from "./backend.ts";

export class WorkerRequestError extends Error {
  readonly code: number;
  readonly reason: string | undefined;
  readonly detail: string | undefined;
  constructor(code: number, message: string, reason?: string, detail?: string) {
    super(message);
    this.code = code;
    this.reason = reason;
    this.detail = detail;
  }
}

export interface WorkerInitializeParams {
  readonly pluginId: string;
  readonly version: string;
  readonly previousVersion?: string;
  readonly dataDir: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
}

export interface WorkerClient {
  readonly initialize: (overrides?: Partial<WorkerInitializeParams>) => Promise<unknown>;
  readonly invoke: (
    operation: string,
    input: unknown,
    caller?: PluginCaller,
  ) => { readonly id: number; readonly result: Promise<unknown> };
  readonly cancel: (id: number) => void;
  readonly subscribe: (
    topic: string,
    params: unknown,
    onEvent: (event: PluginSubscriptionEvent) => void,
  ) => Promise<() => Promise<void>>;
  readonly resolveReference: (
    locator: Readonly<Record<string, string>>,
  ) => Promise<{ readonly title: string; readonly detail: string }>;
  readonly statuses: ReadonlyArray<{ readonly state: string; readonly detail?: string }>;
  /** Closes the worker's stdin, which makes it stop and exit. */
  readonly close: () => Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A host-side protocol client over a worker's stdout (`input`) and stdin (`output`). */
export function makeWorkerClient(options: {
  readonly input: NodeStream.Readable;
  readonly output: NodeStream.Writable;
  readonly initialize: WorkerInitializeParams;
}): WorkerClient {
  let nextId = 1;
  let nextSubscription = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  const listeners = new Map<string, (event: PluginSubscriptionEvent) => void>();
  const statuses: Array<{ state: string; detail?: string }> = [];

  const send = (message: unknown) => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: unknown) => {
    const id = nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return { id, result };
  };

  const handle = (message: unknown) => {
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (waiter === undefined) return;
      if (isRecord(message.error)) {
        const data = isRecord(message.error.data) ? message.error.data : {};
        waiter.reject(
          new WorkerRequestError(
            typeof message.error.code === "number" ? message.error.code : 0,
            String(message.error.message),
            typeof data.reason === "string" ? data.reason : undefined,
            typeof data.detail === "string" ? data.detail : undefined,
          ),
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === "event" && typeof params.subscriptionId === "string") {
      listeners.get(params.subscriptionId)?.(params.event as PluginSubscriptionEvent);
    } else if (message.method === "status" && typeof params.state === "string") {
      statuses.push(
        typeof params.detail === "string"
          ? { state: params.state, detail: params.detail }
          : { state: params.state },
      );
    }
  };

  let buffered = "";
  options.input.setEncoding("utf8");
  options.input.on("data", (chunk: string) => {
    buffered += chunk;
    for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() !== "") handle(JSON.parse(line));
    }
  });
  options.input.on("end", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("Worker closed its output."));
    pending.clear();
  });

  return {
    initialize: (overrides) =>
      request("initialize", {
        apiVersion: PLUGIN_WORKER_PROTOCOL_VERSION,
        ...options.initialize,
        ...overrides,
      }).result,
    invoke: (operation, input, caller = "ui") => request("invoke", { operation, input, caller }),
    cancel: (id) => send({ jsonrpc: "2.0", method: "cancel", params: { id } }),
    subscribe: async (topic, params, onEvent) => {
      const subscriptionId = `s${nextSubscription++}`;
      listeners.set(subscriptionId, onEvent);
      try {
        await request("subscribe", { subscriptionId, topic, params }).result;
      } catch (error) {
        listeners.delete(subscriptionId);
        throw error;
      }
      return async () => {
        listeners.delete(subscriptionId);
        await request("unsubscribe", { subscriptionId }).result;
      };
    },
    resolveReference: async (locator) =>
      (await request("resolveReference", { locator }).result) as {
        title: string;
        detail: string;
      },
    statuses,
    close: async () => {
      await new Promise<void>((resolve) => options.output.end(resolve));
    },
  };
}

/** Extracts a packed `.t3plugin` archive (path or bytes) into `dir`. */
export async function extractPluginArchive(
  archive: string | Uint8Array,
  dir: string,
): Promise<void> {
  const bytes = typeof archive === "string" ? await NodeFSP.readFile(archive) : archive;
  const zip = await JSZip.loadAsync(bytes);
  const root = NodePath.resolve(dir);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const target = NodePath.resolve(root, entry.name);
    if (!target.startsWith(`${root}${NodePath.sep}`)) {
      throw new Error(`Archive entry "${entry.name}" escapes the extraction directory.`);
    }
    await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
    await NodeFSP.writeFile(target, await entry.async("uint8array"));
  }
}

export interface PackedBackend extends WorkerClient {
  readonly pid: number;
  /** Resolves with the exit code (or signal name) once the worker process ends. */
  readonly exited: Promise<number | string | null>;
  readonly stderr: () => string;
}

/** Spawns `process.execPath <entryPath>` and returns a protocol client for it. */
export function startPackedBackend(options: {
  readonly entryPath: string;
  readonly dataDir: string;
  readonly pluginId?: string;
  readonly version?: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, string>>;
}): PackedBackend {
  const child = NodeChildProcess.spawn(process.execPath, [options.entryPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid === undefined) throw new Error("Could not spawn the plugin backend.");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number | string | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(code ?? signal));
  });
  const client = makeWorkerClient({
    input: child.stdout,
    output: child.stdin,
    initialize: {
      pluginId: options.pluginId ?? "echo",
      version: options.version ?? "0.0.0",
      dataDir: options.dataDir,
      config: options.config ?? {},
      secrets: options.secrets ?? {},
    },
  });
  return {
    ...client,
    pid: child.pid,
    exited,
    stderr: () => stderr,
    close: async () => {
      await client.close();
      await exited;
    },
  };
}
