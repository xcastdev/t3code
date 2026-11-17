// @effect-diagnostics nodeBuiltinImport:off - Drives the builtin-only mitm runtime with a fake mitmdump.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { flowRecord } from "./inspector.testkit.ts";
import {
  AUTO_PORT_PROBES,
  CONTROL_ENV,
  compileProxyHosts,
  makeMitm,
  type MitmHandlers,
  MITMDUMP_HINT,
  type MitmReplayResult,
  type MitmSpawner,
  mitmdumpArgs,
  MitmStartError,
  NO_HOSTS,
  pickListenPort,
  type PortProbe,
  type ProxyRuntimeOptions,
} from "./mitm.ts";
import { deferred, makeFakeTimer } from "./replay.testkit.ts";

const CONFDIR = "/data/mitmproxy";
const ADDON = "/data/runtime/0123456789abcdef-addon.py";
const COMMON = [
  "--set",
  `confdir=${CONFDIR}`,
  "--set",
  "client_replay_concurrency=-1",
  "-q",
  "-s",
  ADDON,
];
const AUTH = { username: "alice", password: "SECRET-PASSWORD" };
const confdirOf = (args: ReadonlyArray<string>) =>
  (args.find((arg) => arg.startsWith("confdir=")) ?? "").slice("confdir=".length);

interface FakeSpawn {
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly received: Array<Record<string, unknown>>;
  readonly send: (message: unknown) => void;
  readonly sendLine: (line: string) => void;
}

/**
 * A spawner whose "mitmdump" connects to the control socket, says hello, and acknowledges
 * control messages. `exitFirst` makes the first spawn exit before hello with that output.
 */
function fakeMitmdump(options: { readonly exitFirst?: string } = {}) {
  const spawns: Array<FakeSpawn> = [];
  const attempts: Array<ReadonlyArray<string>> = [];
  let next = deferred<FakeSpawn>();
  const spawner: MitmSpawner = (_command, args, env) => {
    attempts.push(args);
    if (options.exitFirst !== undefined && attempts.length === 1) {
      return {
        pid: 3_999_999,
        exited: Promise.resolve(),
        kill: () => undefined,
        stderrTail: () => options.exitFirst as string,
      };
    }
    const exited = deferred<void>();
    const socket = NodeNet.connect(Number(env[CONTROL_ENV.port]), "127.0.0.1");
    socket.on("error", () => undefined);
    socket.on("close", () => exited.resolve());
    const send = (message: unknown) => socket.write(`${JSON.stringify(message)}\n`);
    const spawn: FakeSpawn = {
      args,
      env,
      received: [],
      send,
      sendLine: (line) => socket.write(`${line}\n`),
    };
    send({ type: "hello", token: env[CONTROL_ENV.token] });
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffered += chunk;
      for (let newline = buffered.indexOf("\n"); newline !== -1; newline = buffered.indexOf("\n")) {
        const message = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
        buffered = buffered.slice(newline + 1);
        spawn.received.push(message);
        if (message.type === "record" || message.type === "hosts") {
          send({ type: "applied", id: message.id });
        }
      }
    });
    spawns.push(spawn);
    const current = next;
    next = deferred();
    current.resolve(spawn);
    return {
      pid: 4_000_000 + spawns.length,
      exited: exited.promise,
      kill: () => {
        socket.destroy();
        exited.resolve();
      },
      stderrTail: () => "",
    };
  };
  return {
    spawner,
    attempts,
    nextSpawn: (index: number) =>
      spawns[index] !== undefined ? Promise.resolve(spawns[index]) : next.promise,
  };
}

const quietHandlers: MitmHandlers = {
  onFlow: async () => undefined,
  onTunnel: async () => undefined,
  onReplayResult: async () => undefined,
};

const proxy = (overrides: Partial<ProxyRuntimeOptions> = {}): ProxyRuntimeOptions => ({
  listenHost: "127.0.0.1",
  listenPort: "auto",
  mode: { kind: "regular" },
  hosts: NO_HOSTS,
  recording: true,
  ...overrides,
});

/** A mitm runtime over a temp dataDir whose PATH holds a never-run `mitmdump`. */
async function openRuntime(
  spawner: MitmSpawner | undefined,
  { withMitmdump = true, logs = [] as Array<string> } = {},
): Promise<
  { readonly mitm: ReturnType<typeof makeMitm>; readonly dataDir: string } & AsyncDisposable
> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "request-inspector-mitm-"));
  const binDir = NodePath.join(root, "bin");
  await NodeFSP.mkdir(binDir);
  if (withMitmdump) {
    await NodeFSP.writeFile(NodePath.join(binDir, "mitmdump"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
  }
  const mitm = makeMitm({
    dataDir: root,
    addonSource: "# fake addon\n",
    maxBodyBytes: 1024,
    searchPath: binDir,
    materialize: async () => NodePath.join(root, "addon.py"),
    timer: makeFakeTimer().timer,
    ...(spawner === undefined ? {} : { spawner }),
    log: (message) => logs.push(message),
  });
  return {
    mitm,
    dataDir: root,
    [Symbol.asyncDispose]: () => NodeFSP.rm(root, { recursive: true, force: true }),
  };
}

const freeProbe: PortProbe = async () => undefined;

const busyProbe =
  (busy: ReadonlySet<number>, probed: Array<number>): PortProbe =>
  async (host, port) => {
    probed.push(port);
    if (busy.has(port)) throw new MitmStartError("port-in-use", `${host}:${port} busy`);
  };

describe("mitmdumpArgs", () => {
  it.each([
    {
      name: "regular capture",
      mode: {
        kind: "capture",
        listenHost: "127.0.0.1",
        listenPort: 8080,
        mode: { kind: "regular" },
        hosts: NO_HOSTS,
      },
      args: ["--listen-host", "127.0.0.1", "--listen-port", "8080", ...COMMON],
    },
    {
      name: "capture with host lists",
      mode: {
        kind: "capture",
        listenHost: "127.0.0.1",
        listenPort: 8080,
        mode: { kind: "regular" },
        hosts: { passthrough: ["^pass\\.test:\\d+$"], ignored: ["^skip\\.test:443$"] },
      },
      args: [
        "--listen-host",
        "127.0.0.1",
        "--listen-port",
        "8080",
        "--set",
        "ignore_hosts=^pass\\.test:\\d+$",
        "--set",
        "ignore_hosts=^skip\\.test:443$",
        "--set",
        "show_ignored_hosts=true",
        ...COMMON,
      ],
    },
    {
      name: "socks5 capture",
      mode: {
        kind: "capture",
        listenHost: "0.0.0.0",
        listenPort: 1080,
        mode: { kind: "socks5" },
        hosts: NO_HOSTS,
      },
      args: ["--listen-host", "0.0.0.0", "--listen-port", "1080", "--mode", "socks5", ...COMMON],
    },
    {
      name: "upstream capture",
      mode: {
        kind: "capture",
        listenHost: "127.0.0.1",
        listenPort: 8081,
        mode: { kind: "upstream", url: "http://10.0.0.2:3128" },
        hosts: NO_HOSTS,
      },
      args: [
        "--listen-host",
        "127.0.0.1",
        "--listen-port",
        "8081",
        "--mode",
        "upstream:http://10.0.0.2:3128",
        ...COMMON,
      ],
    },
    { name: "replay", mode: { kind: "replay" }, args: ["--set", "server=false", ...COMMON] },
    { name: "import", mode: { kind: "import" }, args: ["--set", "server=false", ...COMMON] },
    {
      name: "replay through an upstream",
      mode: { kind: "replay", upstreamUrl: "https://10.0.0.2:3128" },
      args: ["--set", "server=false", "--mode", "upstream:https://10.0.0.2:3128", ...COMMON],
    },
  ] as const)("$name", ({ mode, args }) => {
    expect(mitmdumpArgs(mode, CONFDIR, ADDON)).toEqual(args);
  });

  it("a replay-only process gets upstream auth through env, never argv", async () => {
    const fake = fakeMitmdump();
    await using runtime = await openRuntime(fake.spawner);
    const started = await runtime.mitm.start(
      { kind: "replay", upstream: { url: "http://10.0.0.2:3128", auth: AUTH } },
      quietHandlers,
    ).ready;
    const spawn = await fake.nextSpawn(0);
    expect(spawn.args.join(" ")).not.toContain(AUTH.password);
    expect(spawn.args.join(" ")).not.toContain(AUTH.username);
    expect(spawn.env[CONTROL_ENV.upstreamAuth]).toBe("alice:SECRET-PASSWORD");
    await started.stop();
  });

  it("a capture's upstream auth is in a 0600 config.yaml its own confdir holds until hello, beside a link to the shared CA, and never in argv or env", async () => {
    const seen: Array<{ readonly config: string; readonly mode: number; readonly ca: string }> = [];
    const fake = fakeMitmdump();
    const spawner: MitmSpawner = (command, args, env) => {
      const confdir = confdirOf(args);
      const config = NodePath.join(confdir, "config.yaml");
      seen.push({
        config: NodeFS.readFileSync(config, "utf8"),
        mode: NodeFS.statSync(config).mode & 0o777,
        ca: NodeFS.readFileSync(NodePath.join(confdir, "mitmproxy-ca.pem"), "utf8"),
      });
      return fake.spawner(command, args, env);
    };
    await using runtime = await openRuntime(spawner);
    NodeFS.mkdirSync(NodePath.join(runtime.dataDir, "mitmproxy"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(runtime.dataDir, "mitmproxy", "mitmproxy-ca.pem"), "CA");
    const started = await runtime.mitm.start(
      {
        kind: "capture",
        proxy: proxy({
          listenPort: 18_080,
          mode: { kind: "upstream", url: "http://10.0.0.2:3128" },
          upstreamAuth: AUTH,
        }),
      },
      quietHandlers,
    ).ready;
    const spawn = await fake.nextSpawn(0);
    expect(seen).toEqual([
      { config: JSON.stringify({ upstream_auth: "alice:SECRET-PASSWORD" }), mode: 0o600, ca: "CA" },
    ]);
    const launchConfdir = confdirOf(spawn.args);
    expect(NodePath.dirname(launchConfdir)).toBe(NodePath.join(runtime.dataDir, "runtime"));
    expect(NodeFS.existsSync(NodePath.join(launchConfdir, "config.yaml"))).toBe(false);
    expect(spawn.args.join(" ")).not.toContain(AUTH.password);
    expect(Object.values(spawn.env).join(" ")).not.toContain(AUTH.password);
    expect(spawn.env[CONTROL_ENV.record]).toBe("1");
    expect(started.listenPort).toBe(18_080);
    await started.stop();
    expect(NodeFS.existsSync(launchConfdir)).toBe(false);
  });

  it("upstream auth is not passed outside upstream mode", async () => {
    const fake = fakeMitmdump();
    await using runtime = await openRuntime(fake.spawner);
    const started = await runtime.mitm.start(
      { kind: "capture", proxy: proxy({ listenPort: 18_081, upstreamAuth: AUTH }) },
      quietHandlers,
    ).ready;
    expect((await fake.nextSpawn(0)).env[CONTROL_ENV.upstreamAuth]).toBeUndefined();
    await started.stop();
  });
});

describe("pickListenPort", () => {
  it("a busy start goes to the next port", async () => {
    const probed: Array<number> = [];
    expect(
      await pickListenPort("127.0.0.1", "auto", 8080, [], busyProbe(new Set([8080]), probed)),
    ).toBe(8081);
    expect(probed).toEqual([8080, 8081]);
  });

  it("excluded ports are skipped without probing or counting", async () => {
    const probed: Array<number> = [];
    expect(
      await pickListenPort("127.0.0.1", "auto", 8080, [8080, 8081], busyProbe(new Set(), probed)),
    ).toBe(8082);
    expect(probed).toEqual([8082]);

    const allBusy = new Set(Array.from({ length: 200 }, (_, index) => 8080 + index));
    const counted: Array<number> = [];
    await expect(
      pickListenPort("127.0.0.1", "auto", 8080, [8080, 8081], busyProbe(allBusy, counted)),
    ).rejects.toMatchObject({ reason: "port-in-use" });
    expect(counted).toHaveLength(AUTO_PORT_PROBES);
    expect(counted[0]).toBe(8082);
  });

  it("the scan gives up after 64 ports", async () => {
    const probed: Array<number> = [];
    const allBusy = new Set(Array.from({ length: 200 }, (_, index) => 9000 + index));
    await expect(
      pickListenPort("127.0.0.1", "auto", 9000, [], busyProbe(allBusy, probed)),
    ).rejects.toMatchObject({
      reason: "port-in-use",
      message:
        "No free port on 127.0.0.1 from 9000 after 64 tries. Stop other proxies or pick a listenPort.",
    });
    expect(probed).toEqual(Array.from({ length: 64 }, (_, index) => 9000 + index));
  });

  it("an explicit busy port is port-in-use and does not scan", async () => {
    const probed: Array<number> = [];
    await expect(
      pickListenPort("127.0.0.1", 8080, 8080, [], busyProbe(new Set([8080]), probed)),
    ).rejects.toMatchObject({ reason: "port-in-use" });
    expect(probed).toEqual([8080]);
    expect(await pickListenPort("127.0.0.1", 8090, 8080, [], freeProbe)).toBe(8090);
  });

  it("the real probe reports a bound port as port-in-use", async () => {
    const blocker = NodeNet.createServer();
    const listening = deferred<number>();
    blocker.listen({ host: "127.0.0.1", port: 0 }, () =>
      listening.resolve((blocker.address() as NodeNet.AddressInfo).port),
    );
    const port = await listening.promise;
    try {
      await expect(pickListenPort("127.0.0.1", port, port, [])).rejects.toMatchObject({
        reason: "port-in-use",
        message: `Port ${port} on 127.0.0.1 is already in use. Stop the program using it or change listenPort.`,
      });
    } finally {
      blocker.close();
    }
  });
});

describe("makeMitm", () => {
  it("an auto port lost to another program before mitmdump binds it retries once on the next port", async () => {
    const fake = fakeMitmdump({
      exitFirst: "[Errno 98] HTTP(S) proxy failed to listen on 127.0.0.1:1: address already in use",
    });
    const logs: Array<string> = [];
    await using runtime = await openRuntime(fake.spawner, { logs });
    const blocker = NodeNet.createServer();
    const listening = deferred<number>();
    blocker.listen({ host: "127.0.0.1", port: 0 }, () =>
      listening.resolve((blocker.address() as NodeNet.AddressInfo).port),
    );
    const start = await listening.promise;
    blocker.close();
    try {
      const started = await runtime.mitm.start(
        { kind: "capture", proxy: proxy({ autoPortStart: start }) },
        quietHandlers,
      ).ready;
      const [first, second] = fake.attempts.map((args) => Number(args[3]));
      expect(fake.attempts).toHaveLength(2);
      expect(second).toBeGreaterThan(first as number);
      expect(started.listenPort).toBe(second);
      expect(logs).toEqual([
        `Port ${first} was taken before mitmdump bound it; trying the next free port.`,
      ]);
      await started.stop();
    } finally {
      blocker.close();
    }
  });

  it("an explicit port lost before mitmdump binds it fails with port-in-use and no retry", async () => {
    const fake = fakeMitmdump({ exitFirst: "address already in use" });
    await using runtime = await openRuntime(fake.spawner);
    const port = await new Promise<number>((resolve) => {
      const probe = NodeNet.createServer();
      probe.listen({ host: "127.0.0.1", port: 0 }, () => {
        const { port: bound } = probe.address() as NodeNet.AddressInfo;
        probe.close(() => resolve(bound));
      });
    });
    await expect(
      runtime.mitm.start({ kind: "capture", proxy: proxy({ listenPort: port }) }, quietHandlers)
        .ready,
    ).rejects.toMatchObject({ reason: "port-in-use" });
    expect(fake.attempts).toHaveLength(1);
  });

  it("one runtime runs many processes, each with its own handlers and control messages", async () => {
    const fake = fakeMitmdump();
    await using runtime = await openRuntime(fake.spawner);
    const flows = { a: [] as Array<string>, b: [] as Array<string> };
    const tunnels: Array<unknown> = [];
    const arrived = deferred<void>();
    const handlers = (key: "a" | "b"): MitmHandlers => ({
      ...quietHandlers,
      onFlow: async (flow) => {
        flows[key].push(flow.path);
        if (flows.a.length === 1 && flows.b.length === 1 && tunnels.length === 1) {
          arrived.resolve();
        }
      },
      onTunnel: async (tunnel) => {
        tunnels.push(tunnel);
      },
    });
    const a = await runtime.mitm.start(
      { kind: "capture", proxy: proxy({ listenPort: "auto", autoPortStart: 18_100 }) },
      handlers("a"),
    ).ready;
    const b = await runtime.mitm.start(
      {
        kind: "capture",
        proxy: proxy({
          listenPort: "auto",
          autoPortStart: 18_100,
          excludePorts: [a.listenPort as number],
        }),
      },
      handlers("b"),
    ).ready;
    expect(b.listenPort).not.toBe(a.listenPort);
    const spawnA = await fake.nextSpawn(0);
    const spawnB = await fake.nextSpawn(1);

    const hosts = compileProxyHosts(["*.pass.test"], ["ignored.test:443"]);
    if (!hosts.ok) throw new Error(hosts.reason);
    await a.setRecording(false);
    await a.setHosts(hosts.hosts);
    expect(spawnA.received).toEqual([
      { type: "record", enabled: false, id: 1 },
      {
        type: "hosts",
        passthrough: ["^(?:[a-z0-9_-]+\\.)+pass\\.test:\\d+$"],
        ignored: ["^ignored\\.test:443$"],
        id: 2,
      },
    ]);
    expect(spawnB.received).toEqual([]);

    spawnB.send({
      type: "tunnel",
      startedAt: 1,
      endedAt: 2,
      host: "x.pass.test",
      port: 443,
      sni: "x.pass.test",
      clientAddr: "127.0.0.1:5000",
      bytesUp: 517,
      bytesDown: 1200,
      error: null,
    });
    spawnA.send(flowRecord({ path: "/a" }));
    spawnB.send(flowRecord({ path: "/b" }));
    await arrived.promise;
    expect(flows).toEqual({ a: ["/a"], b: ["/b"] });
    expect(tunnels).toEqual([
      {
        startedAt: 1,
        endedAt: 2,
        host: "x.pass.test",
        port: 443,
        sni: "x.pass.test",
        clientAddr: "127.0.0.1:5000",
        bytesUp: 517,
        bytesDown: 1200,
      },
    ]);
    await a.stop();
    await b.stop();
    await expect(a.setRecording(true)).rejects.toThrow("closed");
  });

  it("compileProxyHosts names the first invalid pattern", () => {
    expect(compileProxyHosts(["a.com"], ["https://b.com"])).toEqual({
      ok: false,
      pattern: "https://b.com",
      reason: "give a host, not a URL or path",
    });
  });

  it("a control message whose handler fails is dropped, malformed records are logged without their content, and later messages are still handled", async () => {
    const fake = fakeMitmdump();
    const logs: Array<string> = [];
    await using runtime = await openRuntime(fake.spawner, { logs });
    const result = deferred<MitmReplayResult>();
    let flows = 0;
    const started = await runtime.mitm.start(
      { kind: "replay" },
      {
        ...quietHandlers,
        onFlow: async () => {
          flows += 1;
          throw new Error("database is locked");
        },
        onReplayResult: async (value) => result.resolve(value),
      },
    ).ready;
    const spawn = await fake.nextSpawn(0);
    spawn.send(flowRecord());
    spawn.sendLine('{"type":"flow","headers":"SECRET-API-KEY"}');
    spawn.sendLine('{"type":"tunnel","host":"SECRET-HOST","bytesUp":-1}');
    spawn.sendLine("not json SECRET-REQUEST-BODY");
    spawn.send(flowRecord());
    spawn.send({ type: "replayResult", replayId: "r1", error: "refused" });

    expect(await result.promise).toEqual({ replayId: "r1", error: "refused" });
    expect(flows).toBe(2);
    expect(logs).toEqual([
      "Handling a control message from mitmdump failed.",
      "Dropped a malformed flow record from mitmdump.",
      "Dropped a malformed tunnel record from mitmdump.",
      "Dropped a malformed control message from mitmdump.",
      "Handling a control message from mitmdump failed.",
    ]);
    await started.stop();
  });

  it("start reports missing-prerequisite when mitmdump is absent", async () => {
    const fake = fakeMitmdump();
    await using runtime = await openRuntime(fake.spawner, { withMitmdump: false });
    await expect(runtime.mitm.start({ kind: "replay" }, quietHandlers).ready).rejects.toMatchObject(
      { reason: "missing-prerequisite", message: MITMDUMP_HINT },
    );
    expect(fake.attempts).toEqual([]);
  });
});
