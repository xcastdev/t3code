// @effect-diagnostics nodeBuiltinImport:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import type { InspectorTimer, ReplayChannel, ReplayMessage, ReplayResult } from "./replay.ts";
import type { FlowInput, FlowType, HeaderPair } from "./store.ts";

export const MITMDUMP_HINT =
  "Install mitmproxy (https://mitmproxy.org) and make mitmdump available on PATH.";

export const CONTROL_ENV = {
  port: "T3_INSPECTOR_CONTROL_PORT",
  token: "T3_INSPECTOR_CONTROL_TOKEN",
  maxBodyBytes: "T3_INSPECTOR_MAX_BODY_BYTES",
} as const;

const STOP_GRACE_MS = 5_000;
const MAX_HELLO_BYTES = 1024;
// A flow line carries two bodies of at most 16 MiB each as base64.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 2048;

export type MitmStartFailure = "missing-prerequisite" | "port-in-use" | "not-started";

export class MitmStartError extends Error {
  readonly reason: MitmStartFailure;
  constructor(reason: MitmStartFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SpawnedProcess {
  readonly pid: number;
  readonly exited: Promise<void>;
  /** Signals the captured PID's process group (the PID itself where groups do not exist). */
  readonly kill: (signal: NodeJS.Signals) => void;
  readonly stderrTail: () => string;
}

export type MitmSpawner = (
  command: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
) => SpawnedProcess;

export const spawnMitmdump: MitmSpawner = (command, args, env) => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The packed backend has no Effect runtime.
  const detached = process.platform !== "win32";
  const child = NodeChildProcess.spawn(command, [...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
    detached,
  });
  let tail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_BYTES);
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const pid = child.pid ?? -1;
  return {
    pid,
    exited,
    kill: (signal) => {
      if (pid <= 0 || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (detached) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        child.kill(signal);
      }
    },
    stderrTail: () => tail,
  };
};

/** Finds `name` on `searchPath` the way a shell would, without running anything. */
export function resolveExecutable(
  name: string,
  searchPath: string | undefined,
): string | undefined {
  const extensions =
    // oxlint-disable-next-line t3code/no-global-process-runtime -- The packed backend has no Effect runtime.
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  for (const dir of (searchPath ?? "").split(NodePath.delimiter)) {
    if (dir === "") continue;
    for (const extension of extensions) {
      const candidate = NodePath.join(dir, `${name}${extension}`);
      try {
        if (!NodeFS.statSync(candidate).isFile()) continue;
        NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

export type MitmMode =
  | { readonly kind: "capture"; readonly listenHost: string; readonly listenPort: number }
  | { readonly kind: "replay" };

export function mitmdumpArgs(mode: MitmMode, confdir: string, addonPath: string): Array<string> {
  // Without unlimited concurrency mitmproxy replays one flow at a time, so one slow upstream
  // would hold every later replay past its deadline.
  const common = [
    "--set",
    `confdir=${confdir}`,
    "--set",
    "client_replay_concurrency=-1",
    "-q",
    "-s",
    addonPath,
  ];
  return mode.kind === "capture"
    ? ["--listen-host", mode.listenHost, "--listen-port", String(mode.listenPort), ...common]
    : ["--set", "server=false", ...common];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodePairs = (value: unknown): Array<HeaderPair> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const pairs: Array<HeaderPair> = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      return undefined;
    }
    pairs.push([Buffer.from(pair[0], "base64"), Buffer.from(pair[1], "base64")]);
  }
  return pairs;
};

const decodeBody = (value: unknown) => {
  if (!isRecord(value) || typeof value.data !== "string") return undefined;
  return { bytes: Buffer.from(value.data, "base64"), truncated: value.truncated === true };
};

const FLOW_TYPES: ReadonlySet<string> = new Set(["http", "websocket", "other"]);

/** Decodes one addon flow record. Returns undefined for anything malformed. */
export function parseFlowRecord(value: unknown): Omit<FlowInput, "captureId"> | undefined {
  if (!isRecord(value)) return undefined;
  const headers = decodePairs(value.headers);
  const strings = ["method", "scheme", "host", "path", "httpVersion"] as const;
  if (headers === undefined || strings.some((key) => typeof value[key] !== "string")) {
    return undefined;
  }
  if (typeof value.port !== "number" || typeof value.startedAt !== "number") return undefined;
  const body = decodeBody(value.body);
  let response: FlowInput["response"];
  if (isRecord(value.response)) {
    const responseHeaders = decodePairs(value.response.headers);
    if (responseHeaders === undefined || typeof value.response.status !== "number") {
      return undefined;
    }
    const responseBody = decodeBody(value.response.body);
    response = {
      status: value.response.status,
      ...(typeof value.response.reason === "string" ? { reason: value.response.reason } : {}),
      httpVersion:
        typeof value.response.httpVersion === "string" ? value.response.httpVersion : "HTTP/1.1",
      headers: responseHeaders,
      ...(responseBody === undefined ? {} : { body: responseBody }),
    };
  }
  const flowType =
    typeof value.flowType === "string" && FLOW_TYPES.has(value.flowType)
      ? (value.flowType as FlowType)
      : "http";
  return {
    startedAt: value.startedAt,
    flowType,
    method: value.method as string,
    scheme: value.scheme as string,
    host: value.host as string,
    port: value.port,
    ...(typeof value.authority === "string" ? { authority: value.authority } : {}),
    path: value.path as string,
    httpVersion: value.httpVersion as string,
    headers,
    ...(body === undefined ? {} : { body }),
    ...(response === undefined ? {} : { response }),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

export interface MitmHandlers {
  readonly onFlow: (flow: Omit<FlowInput, "captureId">) => Promise<void>;
  readonly onReplayResult: (result: ReplayResult) => Promise<void>;
}

export interface MitmProcess extends ReplayChannel {
  readonly pid: number;
  readonly mode: MitmMode["kind"];
  readonly exited: Promise<void>;
  /** Stops it by its captured PID (process group) and waits for the exit. */
  readonly stop: () => Promise<void>;
}

export interface MitmStart {
  /** Resolves once the addon's control connection says hello. */
  readonly ready: Promise<MitmProcess>;
  readonly stop: () => Promise<void>;
}

export interface MitmOptions {
  readonly dataDir: string;
  readonly addonSource: string;
  readonly maxBodyBytes: number;
  readonly materialize: (name: string, contents: string) => Promise<string>;
  readonly timer: InspectorTimer;
  readonly spawner?: MitmSpawner;
  /** PATH to search for mitmdump. Defaults to the worker's PATH. */
  readonly searchPath?: string;
  readonly log?: (message: string) => void;
}

const checkPortFree = (host: string, port: number) =>
  new Promise<void>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? new MitmStartError(
              "port-in-use",
              `Port ${port} on ${host} is already in use. Stop the program using it or change listenPort.`,
            )
          : new MitmStartError("not-started", `Cannot listen on ${host}:${port} (${error.code}).`),
      );
    });
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve()));
  });

const listenControl = () =>
  new Promise<NodeNet.Server>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve(server));
  });

/** Reads NDJSON lines, pausing the socket while a line is handled. */
function readLines(
  socket: NodeNet.Socket,
  handle: (line: string) => Promise<void>,
  log: (message: string) => void,
) {
  const queue: Array<string> = [];
  let parts: Array<Buffer> = [];
  let partBytes = 0;
  let discarding = false;
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    socket.pause();
    while (queue.length > 0) {
      try {
        await handle(queue.shift() as string);
      } catch {
        log("Handling a control message from mitmdump failed.");
      }
    }
    pumping = false;
    if (!socket.destroyed) socket.resume();
  };
  socket.on("data", (chunk: Buffer) => {
    let data = chunk;
    for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10)) {
      const head = data.subarray(0, newline);
      data = data.subarray(newline + 1);
      if (!discarding && partBytes + head.byteLength <= MAX_LINE_BYTES) {
        queue.push(Buffer.concat([...parts, head]).toString("utf8"));
      }
      parts = [];
      partBytes = 0;
      discarding = false;
    }
    if (!discarding && data.byteLength > 0) {
      partBytes += data.byteLength;
      if (partBytes > MAX_LINE_BYTES) {
        discarding = true;
        parts = [];
        partBytes = 0;
      } else {
        parts.push(data);
      }
    }
    void pump();
  });
}

export function makeMitm(options: MitmOptions) {
  const spawner = options.spawner ?? spawnMitmdump;
  const log = options.log ?? (() => undefined);
  const confdir = NodePath.join(options.dataDir, "mitmproxy");

  const start = (mode: MitmMode, handlers: MitmHandlers): MitmStart => {
    let stopRequested = false;
    let stopProcess: (() => Promise<void>) | undefined;

    const ready = (async (): Promise<MitmProcess> => {
      const executable = resolveExecutable("mitmdump", options.searchPath ?? process.env.PATH);
      if (executable === undefined) {
        throw new MitmStartError("missing-prerequisite", MITMDUMP_HINT);
      }
      if (mode.kind === "capture") await checkPortFree(mode.listenHost, mode.listenPort);
      const addonPath = await options.materialize("addon.py", options.addonSource);
      NodeFS.mkdirSync(confdir, { recursive: true });
      const server = await listenControl();
      const address = server.address() as NodeNet.AddressInfo;
      const token = NodeCrypto.randomBytes(32).toString("hex");
      if (stopRequested) {
        server.close();
        throw new MitmStartError("not-started", "mitmdump was stopped before it started.");
      }

      const child = spawner(executable, mitmdumpArgs(mode, confdir, addonPath), {
        [CONTROL_ENV.port]: String(address.port),
        [CONTROL_ENV.token]: token,
        [CONTROL_ENV.maxBodyBytes]: String(options.maxBodyBytes),
        // runtime/ holds only materialized assets; keep Python from adding __pycache__ there.
        PYTHONDONTWRITEBYTECODE: "1",
      });

      let socket: NodeNet.Socket | undefined;
      let open = false;
      let markClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        markClosed = () => {
          open = false;
          resolve();
        };
      });

      const stop = async () => {
        socket?.destroy();
        server.close();
        child.kill("SIGTERM");
        const cancel = options.timer.after(STOP_GRACE_MS, () => child.kill("SIGKILL"));
        await child.exited;
        cancel();
      };
      stopProcess = stop;

      void child.exited.then(() => {
        server.close();
        socket?.destroy();
        markClosed();
      });

      const handleLine = async (line: string) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          log("Dropped a malformed control message from mitmdump.");
          return;
        }
        if (!isRecord(message)) return;
        if (message.type === "flow") {
          const flow = parseFlowRecord(message);
          if (flow === undefined) log("Dropped a malformed flow record from mitmdump.");
          else await handlers.onFlow(flow);
        } else if (message.type === "replayResult" && typeof message.replayId === "string") {
          if (typeof message.error === "string") {
            await handlers.onReplayResult({ replayId: message.replayId, error: message.error });
          } else {
            const flow = parseFlowRecord(message.flow);
            if (flow === undefined) log("Dropped a malformed replay result from mitmdump.");
            else await handlers.onReplayResult({ replayId: message.replayId, flow });
          }
        }
      };

      const started: MitmProcess = await new Promise<MitmProcess>((resolve, reject) => {
        let settled = false;
        void child.exited.then(() => {
          if (settled) return;
          settled = true;
          const tail = child.stderrTail().trim();
          reject(
            new MitmStartError(
              "not-started",
              tail === ""
                ? "mitmdump exited before it was ready."
                : `mitmdump exited before it was ready: ${tail}`,
            ),
          );
        });
        server.on("connection", (connection: NodeNet.Socket) => {
          if (socket !== undefined) {
            connection.destroy();
            return;
          }
          let hello = Buffer.alloc(0);
          const onHello = (chunk: Buffer) => {
            hello = Buffer.concat([hello, chunk]);
            const newline = hello.indexOf(10);
            if (newline === -1) {
              if (hello.byteLength > MAX_HELLO_BYTES) connection.destroy();
              return;
            }
            connection.off("data", onHello);
            let parsed: unknown;
            try {
              parsed = JSON.parse(hello.subarray(0, newline).toString("utf8"));
            } catch {
              parsed = undefined;
            }
            const offered = Buffer.from(
              isRecord(parsed) && typeof parsed.token === "string" ? parsed.token : "",
            );
            const expected = Buffer.from(token);
            if (
              socket !== undefined ||
              !isRecord(parsed) ||
              parsed.type !== "hello" ||
              offered.byteLength !== expected.byteLength ||
              !NodeCrypto.timingSafeEqual(offered, expected)
            ) {
              connection.destroy();
              return;
            }
            socket = connection;
            open = true;
            server.close();
            connection.on("close", () => {
              markClosed();
              child.kill("SIGTERM");
            });
            connection.on("error", () => undefined);
            readLines(connection, handleLine, log);
            const rest = hello.subarray(newline + 1);
            if (rest.byteLength > 0) connection.emit("data", rest);
            if (settled) return;
            settled = true;
            resolve({
              pid: child.pid,
              mode: mode.kind,
              exited: child.exited,
              closed,
              isOpen: () => open,
              stop,
              send: (replay: ReplayMessage) =>
                new Promise<void>((resolveSend, rejectSend) => {
                  if (!open || connection.destroyed) {
                    rejectSend(new Error("The mitmdump control connection is closed."));
                    return;
                  }
                  connection.write(`${JSON.stringify(replay)}\n`, (error) =>
                    error ? rejectSend(error) : resolveSend(),
                  );
                }),
            });
          };
          connection.on("data", onHello);
          connection.on("error", () => undefined);
        });
      });
      return started;
    })();

    return {
      ready,
      stop: async () => {
        stopRequested = true;
        await stopProcess?.();
      },
    };
  };

  return { start };
}
