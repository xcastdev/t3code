// @effect-diagnostics nodeBuiltinImport:off - The inspector backend packs to one builtin-only CommonJS file with no Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { compileHostPattern } from "../shared/hostPatterns.ts";
import type { InspectorTimer, ReplayChannel, ReplayMessage } from "./replay.ts";
import type {
  FlowInput,
  FlowType,
  HeaderPair,
  ProxyMode,
  TunnelInput,
  UpstreamAuth,
} from "./store.ts";

export const MITMDUMP_HINT =
  "Install mitmproxy (https://mitmproxy.org) and make mitmdump available on PATH.";

export const CONTROL_ENV = {
  port: "T3_INSPECTOR_CONTROL_PORT",
  token: "T3_INSPECTOR_CONTROL_TOKEN",
  maxBodyBytes: "T3_INSPECTOR_MAX_BODY_BYTES",
  record: "T3_INSPECTOR_RECORD",
  hosts: "T3_INSPECTOR_HOSTS",
  upstreamAuth: "T3_INSPECTOR_UPSTREAM_AUTH",
} as const;

export const DEFAULT_LISTEN_PORT = 8080;
export const AUTO_PORT_PROBES = 64;

const STOP_GRACE_MS = 5_000;
const MAX_HELLO_BYTES = 1024;
// A flow line carries two bodies of at most 16 MiB each as base64.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const OUTPUT_TAIL_BYTES = 2048;
const ADDRESS_IN_USE = /address already in use/i;

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
  /** The last bytes of stdout and stderr together; mitmdump logs bind errors to stdout. */
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
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });
  let tail = "";
  const append = (chunk: string) => {
    tail = (tail + chunk).slice(-OUTPUT_TAIL_BYTES);
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", append);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", append);
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

/** Anchored regex sources from `shared/hostPatterns.ts`, as mitmproxy's `ignore_hosts` takes them. */
export interface ProxyHosts {
  readonly passthrough: ReadonlyArray<string>;
  readonly ignored: ReadonlyArray<string>;
}

export const NO_HOSTS: ProxyHosts = { passthrough: [], ignored: [] };

export type CompiledHosts =
  | { readonly ok: true; readonly hosts: ProxyHosts }
  | { readonly ok: false; readonly pattern: string; readonly reason: string };

export function compileProxyHosts(
  passthroughHosts: ReadonlyArray<string>,
  ignoredHosts: ReadonlyArray<string>,
): CompiledHosts {
  const compile = (patterns: ReadonlyArray<string>) => {
    const sources: Array<string> = [];
    for (const pattern of patterns) {
      const compiled = compileHostPattern(pattern);
      if (!compiled.ok) return { pattern, reason: compiled.reason };
      sources.push(compiled.source);
    }
    return sources;
  };
  const passthrough = compile(passthroughHosts);
  if (!Array.isArray(passthrough)) return { ok: false, ...passthrough };
  const ignored = compile(ignoredHosts);
  if (!Array.isArray(ignored)) return { ok: false, ...ignored };
  return { ok: true, hosts: { passthrough, ignored } };
}

export interface ProxyRuntimeOptions {
  readonly listenHost: string;
  /** `"auto"` scans from `autoPortStart`, skipping `excludePorts` (D20). */
  readonly listenPort: number | "auto";
  readonly autoPortStart?: number;
  /** Ports held by the other running proxies. */
  readonly excludePorts?: ReadonlyArray<number>;
  readonly mode: ProxyMode;
  /** Used only in upstream mode. Reaches mitmdump through a 0600 config file, never argv. */
  readonly upstreamAuth?: UpstreamAuth | null;
  readonly hosts: ProxyHosts;
  /** Whether the addon starts out sending flows. */
  readonly recording: boolean;
}

export interface ReplayUpstream {
  readonly url: string;
  readonly auth?: UpstreamAuth | null;
}

export type MitmMode =
  | { readonly kind: "capture"; readonly proxy: ProxyRuntimeOptions }
  | { readonly kind: "replay"; readonly upstream?: ReplayUpstream };

/** The argv-relevant part of a mode, with the listen port resolved. Never carries credentials. */
export type MitmArgsMode =
  | {
      readonly kind: "capture";
      readonly listenHost: string;
      readonly listenPort: number;
      readonly mode: ProxyMode;
      readonly hosts: ProxyHosts;
    }
  | { readonly kind: "replay"; readonly upstreamUrl?: string };

export function mitmdumpArgs(
  mode: MitmArgsMode,
  confdir: string,
  addonPath: string,
): Array<string> {
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
  if (mode.kind === "replay") {
    const upstream =
      mode.upstreamUrl === undefined ? [] : ["--mode", `upstream:${mode.upstreamUrl}`];
    return ["--set", "server=false", ...upstream, ...common];
  }
  const proxyMode =
    mode.mode.kind === "socks5"
      ? ["--mode", "socks5"]
      : mode.mode.kind === "upstream"
        ? ["--mode", `upstream:${mode.mode.url}`]
        : [];
  // On argv so they hold from the first connection: the addon's running hook comes after listen.
  const ignored = [...mode.hosts.passthrough, ...mode.hosts.ignored].flatMap((source) => [
    "--set",
    `ignore_hosts=${source}`,
  ]);
  const showIgnored = mode.hosts.passthrough.length > 0 ? ["--set", "show_ignored_hosts=true"] : [];
  return [
    "--listen-host",
    mode.listenHost,
    "--listen-port",
    String(mode.listenPort),
    ...proxyMode,
    ...ignored,
    ...showIgnored,
    ...common,
  ];
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

/** A flow as the addon reports it; the caller adds the recording. */
export type MitmFlow = Omit<FlowInput, "recordingId">;
/** A pass-through tunnel as the addon reports it; the caller adds the recording. */
export type MitmTunnel = Omit<TunnelInput, "recordingId">;
export type MitmReplayResult =
  | { readonly replayId: string; readonly flow: MitmFlow }
  | { readonly replayId: string; readonly error: string };

type HttpFlowType = Exclude<FlowType, "tunnel">;
const FLOW_TYPES: ReadonlySet<string> = new Set<HttpFlowType>(["http", "websocket", "other"]);

/** Decodes one addon flow record. Returns undefined for anything malformed. */
export function parseFlowRecord(value: unknown): MitmFlow | undefined {
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
      ? (value.flowType as HttpFlowType)
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

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Decodes one addon tunnel record. Returns undefined for anything malformed. */
export function parseTunnelRecord(value: unknown): MitmTunnel | undefined {
  if (!isRecord(value)) return undefined;
  const { startedAt, endedAt, host, port, sni, clientAddr, bytesUp, bytesDown, error } = value;
  if (typeof startedAt !== "number" || typeof host !== "string" || typeof port !== "number") {
    return undefined;
  }
  if (!isCount(bytesUp) || !isCount(bytesDown)) return undefined;
  return {
    startedAt,
    ...(typeof endedAt === "number" ? { endedAt } : {}),
    host,
    port,
    ...(typeof sni === "string" ? { sni } : {}),
    ...(typeof clientAddr === "string" ? { clientAddr } : {}),
    bytesUp,
    bytesDown,
    ...(typeof error === "string" ? { error } : {}),
  };
}

export interface MitmHandlers {
  readonly onFlow: (flow: MitmFlow) => Promise<void>;
  readonly onTunnel: (tunnel: MitmTunnel) => Promise<void>;
  readonly onReplayResult: (result: MitmReplayResult) => Promise<void>;
}

export interface MitmProcess extends ReplayChannel {
  readonly pid: number;
  readonly mode: MitmMode["kind"];
  /** The bound port for a capture process, null for replay-only. */
  readonly listenPort: number | null;
  readonly exited: Promise<void>;
  /** Turns flow and tunnel reporting on or off; resolves once the addon applied it (D18). */
  readonly setRecording: (enabled: boolean) => Promise<void>;
  /** Replaces both host lists; resolves once the next connection will see them (D19). */
  readonly setHosts: (hosts: ProxyHosts) => Promise<void>;
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
  /** Checks a listen port before spawning. Tests replace it so they bind nothing. */
  readonly probePort?: PortProbe;
}

const portInUse = (host: string, port: number) =>
  new MitmStartError(
    "port-in-use",
    `Port ${port} on ${host} is already in use. Stop the program using it or change listenPort.`,
  );

export type PortProbe = (host: string, port: number) => Promise<void>;

/** Rejects with `port-in-use` when `host:port` cannot be bound right now. */
const probePort: PortProbe = (host, port) =>
  new Promise<void>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "EADDRINUSE"
          ? portInUse(host, port)
          : new MitmStartError("not-started", `Cannot listen on ${host}:${port} (${error.code}).`),
      );
    });
    probe.listen({ host, port, exclusive: true }, () => probe.close(() => resolve()));
  });

/**
 * An explicit port is probed once. `"auto"` probes up to 64 ports upward from `start`, skipping
 * `exclude` without counting them.
 */
export async function pickListenPort(
  host: string,
  spec: number | "auto",
  start: number,
  exclude: ReadonlyArray<number>,
  probe: PortProbe = probePort,
): Promise<number> {
  if (spec !== "auto") {
    await probe(host, spec);
    return spec;
  }
  const skipped = new Set(exclude);
  let probes = 0;
  for (let port = start; port <= 65_535 && probes < AUTO_PORT_PROBES; port += 1) {
    if (skipped.has(port)) continue;
    probes += 1;
    try {
      await probe(host, port);
      return port;
    } catch (error) {
      if (!(error instanceof MitmStartError) || error.reason !== "port-in-use") throw error;
    }
  }
  throw new MitmStartError(
    "port-in-use",
    `No free port on ${host} from ${start} after ${probes} tries. Stop other proxies or pick a listenPort.`,
  );
}

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

interface Launch {
  readonly args: MitmArgsMode;
  readonly env: Readonly<Record<string, string>>;
  /** Options for a 0600 config.yaml that mitmdump reads before it listens; never argv. */
  readonly secretOptions?: Readonly<Record<string, string>>;
}

const CA_KEY_FILE = "mitmproxy-ca.pem";
const LAUNCH_DIR_PREFIX = "launch-";

/** Rejected when mitmdump exited before hello because its listen port was taken. */
class AddressInUse extends MitmStartError {}

/**
 * Runs mitmdump processes; each `start` is independent, so one instance runs any number of
 * proxies and replay carriers at once.
 */
export function makeMitm(options: MitmOptions) {
  const spawner = options.spawner ?? spawnMitmdump;
  const probe = options.probePort ?? probePort;
  const log = options.log ?? (() => undefined);
  const confdir = NodePath.join(options.dataDir, "mitmproxy");
  const runtimeDir = NodePath.join(options.dataDir, "runtime");
  // A launch dir left by a crash still holds a config with credentials.
  try {
    for (const name of NodeFS.readdirSync(runtimeDir)) {
      if (name.startsWith(LAUNCH_DIR_PREFIX)) {
        NodeFS.rmSync(NodePath.join(runtimeDir, name), { recursive: true, force: true });
      }
    }
  } catch {
    // No runtime dir yet.
  }

  /**
   * mitmdump reads config.yaml only from its confdir, so a launch with secret options gets its
   * own confdir holding that file and a link to the shared CA.
   */
  const makeLaunchConfdir = (secretOptions: Readonly<Record<string, string>>) => {
    const dir = NodePath.join(
      runtimeDir,
      `${LAUNCH_DIR_PREFIX}${NodeCrypto.randomBytes(8).toString("hex")}`,
    );
    NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const sharedCa = NodePath.join(confdir, CA_KEY_FILE);
    const launchCa = NodePath.join(dir, CA_KEY_FILE);
    try {
      NodeFS.linkSync(sharedCa, launchCa);
    } catch {
      NodeFS.copyFileSync(sharedCa, launchCa);
      NodeFS.chmodSync(launchCa, 0o600);
    }
    // JSON is YAML, and quoting every value keeps YAML from reinterpreting it.
    NodeFS.writeFileSync(NodePath.join(dir, "config.yaml"), JSON.stringify(secretOptions), {
      mode: 0o600,
    });
    return dir;
  };

  const start = (mode: MitmMode, handlers: MitmHandlers): MitmStart => {
    let stopRequested = false;
    let stopProcess: (() => Promise<void>) | undefined;

    const launch = async (
      executable: string,
      addonPath: string,
      { args, env, secretOptions }: Launch,
    ): Promise<MitmProcess> => {
      const server = await listenControl();
      const address = server.address() as NodeNet.AddressInfo;
      const token = NodeCrypto.randomBytes(32).toString("hex");
      if (stopRequested) {
        server.close();
        throw new MitmStartError("not-started", "mitmdump was stopped before it started.");
      }

      let launchConfdir: string | undefined;
      try {
        launchConfdir = secretOptions === undefined ? undefined : makeLaunchConfdir(secretOptions);
      } catch {
        server.close();
        throw new MitmStartError("not-started", "The mitmdump config could not be written.");
      }
      const removeLaunchConfig = () => {
        if (launchConfdir === undefined) return;
        NodeFS.rmSync(NodePath.join(launchConfdir, "config.yaml"), { force: true });
      };
      const child = spawner(executable, mitmdumpArgs(args, launchConfdir ?? confdir, addonPath), {
        ...env,
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
      let nextControlId = 1;
      const pendingControls = new Map<
        number,
        { readonly resolve: () => void; readonly reject: (error: Error) => void }
      >();
      void closed.then(() => {
        for (const pending of pendingControls.values()) {
          pending.reject(new Error("The mitmdump control connection closed."));
        }
        pendingControls.clear();
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
        if (launchConfdir !== undefined) {
          NodeFS.rmSync(launchConfdir, { recursive: true, force: true });
        }
      });

      const write = (message: unknown) =>
        new Promise<void>((resolveWrite, rejectWrite) => {
          const connection = socket;
          if (!open || connection === undefined || connection.destroyed) {
            rejectWrite(new Error("The mitmdump control connection is closed."));
            return;
          }
          connection.write(`${JSON.stringify(message)}\n`, (error) =>
            error ? rejectWrite(error) : resolveWrite(),
          );
        });

      const control = (message: Readonly<Record<string, unknown>>) => {
        const id = nextControlId;
        nextControlId += 1;
        const applied = new Promise<void>((resolveApplied, rejectApplied) => {
          pendingControls.set(id, { resolve: resolveApplied, reject: rejectApplied });
        });
        return write({ ...message, id }).then(
          () => applied,
          (error: Error) => {
            pendingControls.delete(id);
            throw error;
          },
        );
      };

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
        } else if (message.type === "tunnel") {
          const tunnel = parseTunnelRecord(message);
          if (tunnel === undefined) log("Dropped a malformed tunnel record from mitmdump.");
          else await handlers.onTunnel(tunnel);
        } else if (message.type === "applied" && typeof message.id === "number") {
          const pending = pendingControls.get(message.id);
          pendingControls.delete(message.id);
          if (typeof message.error === "string") {
            pending?.reject(new Error(`mitmdump refused the change (${message.error}).`));
          } else {
            pending?.resolve();
          }
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

      return await new Promise<MitmProcess>((resolve, reject) => {
        let settled = false;
        void child.exited.then(() => {
          if (settled) return;
          settled = true;
          const tail = child.stderrTail().trim();
          if (args.kind === "capture" && ADDRESS_IN_USE.test(tail)) {
            reject(
              new AddressInUse("port-in-use", portInUse(args.listenHost, args.listenPort).message),
            );
            return;
          }
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
            // mitmdump read its config at startup, long before hello.
            removeLaunchConfig();
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
              listenPort: args.kind === "capture" ? args.listenPort : null,
              exited: child.exited,
              closed,
              isOpen: () => open,
              stop,
              send: (replay: ReplayMessage) => write(replay),
              setRecording: (enabled) => control({ type: "record", enabled }),
              setHosts: (hosts) =>
                control({ type: "hosts", passthrough: hosts.passthrough, ignored: hosts.ignored }),
            });
          };
          connection.on("data", onHello);
          connection.on("error", () => undefined);
        });
      });
    };

    const prepare = async () => {
      const addonPath = await options.materialize("addon.py", options.addonSource);
      NodeFS.mkdirSync(confdir, { recursive: true });
      return addonPath;
    };

    const ready = (async (): Promise<MitmProcess> => {
      const executable = resolveExecutable("mitmdump", options.searchPath ?? process.env.PATH);
      if (executable === undefined) {
        throw new MitmStartError("missing-prerequisite", MITMDUMP_HINT);
      }
      if (mode.kind === "replay") {
        const addonPath = await prepare();
        const auth = mode.upstream?.auth;
        return launch(executable, addonPath, {
          args: {
            kind: "replay",
            ...(mode.upstream === undefined ? {} : { upstreamUrl: mode.upstream.url }),
          },
          env: auth ? { [CONTROL_ENV.upstreamAuth]: `${auth.username}:${auth.password}` } : {},
        });
      }
      const proxy = mode.proxy;
      const exclude = proxy.excludePorts ?? [];
      const firstPort = await pickListenPort(
        proxy.listenHost,
        proxy.listenPort,
        proxy.autoPortStart ?? DEFAULT_LISTEN_PORT,
        exclude,
        probe,
      );
      const addonPath = await prepare();
      const auth = proxy.mode.kind === "upstream" ? proxy.upstreamAuth : undefined;
      if (auth && !NodeFS.existsSync(NodePath.join(confdir, CA_KEY_FILE))) {
        // The launch confdir links the shared CA, so one short start creates it first.
        const bootstrap = await launch(executable, addonPath, {
          args: { kind: "replay" },
          env: {},
        });
        await bootstrap.stop();
        if (!NodeFS.existsSync(NodePath.join(confdir, CA_KEY_FILE))) {
          throw new MitmStartError("not-started", "mitmdump did not create its CA certificate.");
        }
      }
      const env = {
        [CONTROL_ENV.record]: proxy.recording ? "1" : "0",
        [CONTROL_ENV.hosts]: JSON.stringify(proxy.hosts),
      };
      const attempt = (listenPort: number) =>
        launch(executable, addonPath, {
          args: {
            kind: "capture",
            listenHost: proxy.listenHost,
            listenPort,
            mode: proxy.mode,
            hosts: proxy.hosts,
          },
          env,
          ...(auth
            ? { secretOptions: { upstream_auth: `${auth.username}:${auth.password}` } }
            : {}),
        });
      try {
        return await attempt(firstPort);
      } catch (error) {
        // The probe and mitmdump's bind race other programs; an auto port gets one more try.
        if (!(error instanceof AddressInUse) || proxy.listenPort !== "auto" || stopRequested) {
          throw error;
        }
        log(`Port ${firstPort} was taken before mitmdump bound it; trying the next free port.`);
        return attempt(
          await pickListenPort(proxy.listenHost, "auto", firstPort + 1, exclude, probe),
        );
      }
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
