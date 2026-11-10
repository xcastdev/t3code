// @effect-diagnostics nodeBuiltinImport:off - Real-mitmdump tests for the packed inspector.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import {
  compileProxyHosts,
  NO_HOSTS,
  type ProxyHosts,
  type ProxyRuntimeOptions,
} from "../backend/mitm.ts";
import { compileHostPattern, matchHost } from "../shared/hostPatterns.ts";
import {
  addonMatchHost,
  deferred,
  HELLO_ONLY_ADDON,
  freePort,
  openMitmRuntime,
  openPackedInspector,
  openTlsServer,
  openUpstream,
  processExit,
  type ReceivedRequest,
  socks5Request,
  tlsViaConnect,
  viaProxy,
} from "./harness.ts";

interface RequestItem {
  readonly kind: "request";
  readonly id: string;
  readonly path: string;
  readonly replayOf?: string;
}

const requestAt =
  (path: string) =>
  (item: unknown): item is RequestItem =>
    typeof item === "object" &&
    item !== null &&
    (item as RequestItem).kind === "request" &&
    (item as RequestItem).path === path &&
    (item as RequestItem).replayOf === undefined;

const listFiles = (dir: string): Array<string> =>
  NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => NodePath.relative(dir, NodePath.join(entry.parentPath, entry.name)))
    .toSorted();

const BINARY_BODY = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

type Inspector = Awaited<ReturnType<typeof openPackedInspector>>;

/** Starts the default proxy and a recording on it, and returns the proxy's listen port. */
async function startRecording(inspector: Inspector): Promise<number> {
  const endpoint = (await inspector.worker.invoke("start_proxy", { proxyId: "1" }).result) as {
    readonly listenPort: number;
  };
  await inspector.worker.invoke("start_recording", { proxyId: "1" }).result;
  return endpoint.listenPort;
}

const stopProxy = (inspector: Inspector) =>
  inspector.worker.invoke("stop_proxy", { proxyId: "1" }).result;

/** Records one POST with duplicate headers and a binary body, and returns its request id. */
async function captureSource(
  inspector: Inspector,
  proxyPort: number,
  upstreamPort: number,
  path: string,
): Promise<string> {
  const stored = inspector.nextItem("requests", {}, requestAt(path));
  await viaProxy(proxyPort, `http://127.0.0.1:${upstreamPort}${path}`, {
    method: "POST",
    rawHeaders: [
      "Host",
      `127.0.0.1:${upstreamPort}`,
      "X-Dup",
      "first",
      "Content-Type",
      "application/octet-stream",
      "X-Dup",
      "second",
      "Content-Length",
      String(BINARY_BODY.byteLength),
    ],
    body: BINARY_BODY,
  });
  return (await stored).id;
}

const replay = async (inspector: Inspector, requestId: string) => {
  const preview = (await inspector.worker.invoke("preview_replay", { requestId }).result) as {
    readonly idempotencyKey: string;
  };
  const accepted = (await inspector.worker.invoke("replay_request", {
    requestId,
    idempotencyKey: preview.idempotencyKey,
  }).result) as { readonly replayId: string; readonly state: string };
  return { ...accepted, idempotencyKey: preview.idempotencyKey };
};

const getReplay = (inspector: Inspector, replayId: string) =>
  inspector.worker.invoke("get_replay", { replayId, waitMs: 20_000 }).result as Promise<{
    readonly state: string;
    readonly dispatched: boolean;
    readonly resultRequestId?: string;
  }>;

const headerPairs = (raw: ReadonlyArray<string>): Array<readonly [string, string]> =>
  raw.flatMap((value, index) =>
    index % 2 === 0 ? [[value, raw[index + 1] as string] as const] : [],
  );

describe("request inspector with a real mitmdump", () => {
  it("addon shuts mitmdump down when its control socket closes", async () => {
    await using inspector = await openPackedInspector();
    await startRecording(inspector);
    const [mitmdump] = inspector.mitmdumpPids();
    if (mitmdump === undefined) throw new Error("mitmdump did not start");
    const exited = processExit(mitmdump);

    process.kill(inspector.worker.pid, "SIGKILL");
    await inspector.worker.exited;
    await exited;
  });

  it("the packed archive holds no addon.py entry, and start_proxy spawns mitmdump with the addon materialized under dataDir/runtime", async () => {
    await using upstream = await openUpstream((_request, response) => {
      response.end("ok");
    });
    await using inspector = await openPackedInspector();
    expect(listFiles(inspector.extractedDir)).toEqual([
      NodePath.join("backend", "index.cjs"),
      "t3-plugin.json",
      NodePath.join("ui", "inspector.html"),
    ]);
    // The panel is one inlined HTML file; keep it well under a megabyte so panels open fast.
    expect(
      NodeFS.statSync(NodePath.join(inspector.extractedDir, "ui", "inspector.html")).size,
    ).toBeLessThan(1024 * 1024);

    const proxyPort = await startRecording(inspector);
    const runtime = NodePath.join(inspector.dataDir, "runtime");
    const [addon] = NodeFS.readdirSync(runtime);
    expect(listFiles(runtime)).toEqual([addon]);
    expect(addon).toMatch(/^[0-9a-f]{16}-addon\.py$/);
    expect(NodeFS.readFileSync(NodePath.join(runtime, addon as string), "utf8")).toContain(
      "replay.client",
    );
    const [pid] = inspector.mitmdumpPids();
    const cmdline = NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    expect(cmdline).toContain(NodePath.join(runtime, addon as string));

    expect(await captureSource(inspector, proxyPort, upstream.port, "/captured")).toMatch(/^\d+$/);
    await stopProxy(inspector);
  });

  it.each(["through the running source proxy", "with the source proxy stopped"] as const)(
    "replay preserves an upstream 302, duplicate request and response headers, a binary request body, and a raw gzip response, and links the new record to its source (%s)",
    async (mode) => {
      const gzip = NodeZlib.gzipSync(Buffer.from("redirecting body"));
      await using upstream = await openUpstream((_request, response) => {
        response.writeHead(302, [
          "Location",
          "/elsewhere",
          "Set-Cookie",
          "a=1",
          "Content-Encoding",
          "gzip",
          "Set-Cookie",
          "b=2",
          "Content-Length",
          String(gzip.byteLength),
        ]);
        response.end(gzip);
      });
      await using inspector = await openPackedInspector();
      const proxyPort = await startRecording(inspector);
      const source = await captureSource(inspector, proxyPort, upstream.port, "/login");
      if (mode === "with the source proxy stopped") await stopProxy(inspector);
      const pidsBefore = inspector.mitmdumpPids().length;

      const replayed = upstream.nextRequest();
      const accepted = await replay(inspector, source);
      expect(accepted.state).toBe("pending");
      const received: ReceivedRequest = await replayed;
      const result = await getReplay(inspector, accepted.replayId);

      expect(result).toMatchObject({ state: "completed", dispatched: true });
      expect(upstream.received).toHaveLength(2);
      expect(received.method).toBe("POST");
      expect(received.body.equals(BINARY_BODY)).toBe(true);
      expect(
        headerPairs(received.rawHeaders).filter(([name]) => name.toLowerCase() === "x-dup"),
      ).toEqual([
        ["X-Dup", "first"],
        ["X-Dup", "second"],
      ]);

      const stored = (await inspector.worker.invoke("get_request", {
        requestId: result.resultRequestId,
      }).result) as {
        readonly replayOf?: string;
        readonly response: {
          readonly status: number;
          readonly headers: ReadonlyArray<readonly [string, string]>;
        };
      };
      expect(stored.replayOf).toBe(source);
      expect(stored.response.status).toBe(302);
      expect(
        stored.response.headers.filter(([name]) => name.toLowerCase() === "set-cookie"),
      ).toEqual([
        ["Set-Cookie", "a=1"],
        ["Set-Cookie", "b=2"],
      ]);
      const body = (await inspector.worker.invoke("read_body", {
        requestId: result.resultRequestId,
        side: "response",
        offset: 0,
        length: 131072,
      }).result) as { readonly base64: string };
      expect(Buffer.from(body.base64, "base64").equals(gzip)).toBe(true);

      const pids = inspector.mitmdumpPids();
      if (mode === "with the source proxy stopped") {
        expect(pids).toHaveLength(pidsBefore + 1);
        await processExit(pids.at(-1) as number);
      } else {
        expect(pids).toHaveLength(pidsBefore);
        await stopProxy(inspector);
      }
    },
  );

  it("a delayed upstream leaves the replay pending, and a same-key retry returns it without a second upstream request", async () => {
    const release = deferred<void>();
    let held = false;
    await using upstream = await openUpstream(async (_request, response) => {
      if (held) await release.promise;
      held = true;
      response.end("done");
    });
    await using inspector = await openPackedInspector();
    const proxyPort = await startRecording(inspector);
    const source = await captureSource(inspector, proxyPort, upstream.port, "/slow");

    const replayed = upstream.nextRequest();
    const accepted = await replay(inspector, source);
    expect(accepted.state).toBe("pending");
    const retry = (await inspector.worker.invoke("replay_request", {
      requestId: source,
      idempotencyKey: accepted.idempotencyKey,
    }).result) as { readonly replayId: string; readonly state: string };
    expect(retry).toMatchObject({ replayId: accepted.replayId, state: "pending" });
    await replayed;
    expect(upstream.received).toHaveLength(2);

    release.resolve();
    expect(await getReplay(inspector, accepted.replayId)).toMatchObject({ state: "completed" });
    expect(upstream.received).toHaveLength(2);
    await stopProxy(inspector);
  });

  it("stop_proxy after the upstream received a replay and before it answers reports unknown with dispatched true", async () => {
    const release = deferred<void>();
    let held = false;
    await using upstream = await openUpstream(async (_request, response) => {
      if (held) await release.promise;
      held = true;
      response.end("done");
    });
    await using inspector = await openPackedInspector();
    const proxyPort = await startRecording(inspector);
    const source = await captureSource(inspector, proxyPort, upstream.port, "/held");
    const [capturePid] = inspector.mitmdumpPids();
    if (capturePid === undefined) throw new Error("mitmdump did not start");

    const replayed = upstream.nextRequest();
    const accepted = await replay(inspector, source);
    await replayed;
    const exited = processExit(capturePid);
    await stopProxy(inspector);
    await exited;

    expect(await getReplay(inspector, accepted.replayId)).toMatchObject({
      state: "unknown",
      dispatched: true,
    });
    release.resolve();
  });
});

describe("inspector certificate helper with a real mitmdump", () => {
  it("certificate_info on a fresh data dir creates the CA with one short mitmdump start and never lists the private key", async () => {
    await using inspector = await openPackedInspector();
    const info = (await inspector.worker.invoke("certificate_info", {}).result) as {
      readonly exists: boolean;
      readonly files: Readonly<Record<string, string>>;
      readonly combinedBundle?: string;
    };
    expect(info.exists).toBe(true);
    for (const file of Object.values(info.files)) expect(NodeFS.existsSync(file)).toBe(true);
    expect(Object.values(info.files).some((file) => file.endsWith("mitmproxy-ca.pem"))).toBe(false);
    const pids = inspector.mitmdumpPids();
    expect(pids).toHaveLength(1);
    await processExit(pids[0] as number);

    await inspector.worker.invoke("certificate_info", {}).result;
    expect(inspector.mitmdumpPids()).toHaveLength(1);
  });
});

const proxyOptions = (overrides: Partial<ProxyRuntimeOptions> = {}): ProxyRuntimeOptions => ({
  listenHost: "127.0.0.1",
  listenPort: "auto",
  mode: { kind: "regular" },
  hosts: NO_HOSTS,
  recording: true,
  ...overrides,
});

const hostsOf = (
  passthrough: ReadonlyArray<string>,
  ignored: ReadonlyArray<string>,
): ProxyHosts => {
  const compiled = compileProxyHosts(passthrough, ignored);
  if (!compiled.ok) throw new Error(compiled.reason);
  return compiled.hosts;
};

const getVia = (proxyPort: number, url: string) =>
  viaProxy(proxyPort, url, {
    method: "GET",
    rawHeaders: ["Host", new URL(url).host],
    body: Buffer.alloc(0),
  });

const headerValue = (
  flow: { readonly headers: ReadonlyArray<readonly [Uint8Array, Uint8Array]> },
  name: string,
) =>
  flow.headers
    .filter(([key]) => Buffer.from(key).toString("latin1").toLowerCase() === name)
    .map(([, value]) => Buffer.from(value).toString("latin1"));

describe("mitm runtime with a real mitmdump", () => {
  it("the addon's Python host matcher agrees with shared/hostPatterns.ts", () => {
    const cases = [
      ["example.com", "example.com", 443],
      ["example.com", "EXAMPLE.com", 80],
      ["example.com", "api.example.com", 443],
      ["example.com", "example.com.evil.io", 443],
      ["*.a.com", "a.com", 443],
      ["*.a.com", "x.y.a.com", 443],
      ["*.a.com", "xa.com", 443],
      ["example.com:8443", "example.com", 8443],
      ["example.com:8443", "example.com", 443],
      ["10.0.0.1", "10.0.0.11", 22],
      ["[::1]:443", "::1", 443],
      ["[::1]:443", "[::1]", 443],
      ["[::1]", "::1", 8080],
    ] as const;
    const python = addonMatchHost(
      cases.map(([pattern, host, port]) => {
        const compiled = compileHostPattern(pattern);
        if (!compiled.ok) throw new Error(compiled.reason);
        return { sources: [compiled.source], host, port };
      }),
    );
    expect(python).toEqual(cases.map(([pattern, host, port]) => matchHost([pattern], host, port)));
    expect(python).toContain(true);
    expect(python).toContain(false);
  });

  it("two proxies run at once and each records only its own flows", async () => {
    await using upstream = await openUpstream((_request, response) => {
      response.end("ok");
    });
    await using runtime = await openMitmRuntime();
    const start = await freePort();
    const a = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: start }),
    });
    const portA = a.process.listenPort as number;
    const b = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: start, excludePorts: [portA] }),
    });
    const portB = b.process.listenPort as number;
    expect(portB).not.toBe(portA);

    expect(await getVia(portA, `http://127.0.0.1:${upstream.port}/via-a`)).toBe(200);
    expect(await getVia(portB, `http://127.0.0.1:${upstream.port}/via-b`)).toBe(200);
    await a.flows.next();
    await b.flows.next();
    expect(a.flows.items.map((flow) => flow.path)).toEqual(["/via-a"]);
    expect(b.flows.items.map((flow) => flow.path)).toEqual(["/via-b"]);
  });

  it("a pass-through host is tunnelled without interception and recorded with its SNI and the bytes the server counted", async () => {
    await using server = await openTlsServer(["pass.test"]);
    await using runtime = await openMitmRuntime();
    const proxy = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: await freePort(), hosts: hostsOf(["pass.test"], []) }),
    });
    const reply = await tlsViaConnect(
      proxy.process.listenPort as number,
      { host: "127.0.0.1", port: server.port },
      { servername: "pass.test", ca: server.cert, line: "hello" },
    );
    expect(reply).toBe("ok hello\n");
    const counted = await server.connections.next();
    const tunnel = await proxy.tunnels.next();
    expect(counted.sni).toBe("pass.test");
    expect(tunnel).toMatchObject({
      host: "pass.test",
      port: server.port,
      sni: "pass.test",
      bytesUp: counted.bytesRead,
      bytesDown: counted.bytesWritten,
    });
    expect(tunnel.bytesUp).toBeGreaterThan(0);
    expect(tunnel.error).toBeUndefined();
    expect(tunnel.endedAt).toBeGreaterThanOrEqual(tunnel.startedAt);
    expect(tunnel.clientAddr).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(proxy.flows.items).toEqual([]);
  });

  it("an ignored host is forwarded and gives no row, over TLS or plain HTTP", async () => {
    await using server = await openTlsServer(["ignored.test", "pass.test"]);
    await using upstream = await openUpstream((_request, response) => {
      response.end("ok");
    });
    await using runtime = await openMitmRuntime();
    const proxy = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({
        autoPortStart: await freePort(),
        hosts: hostsOf(["pass.test"], ["ignored.test", `127.0.0.1:${upstream.port}`]),
      }),
    });
    const port = proxy.process.listenPort as number;
    const target = { host: "127.0.0.1", port: server.port };
    expect(
      await tlsViaConnect(port, target, { servername: "ignored.test", ca: server.cert, line: "a" }),
    ).toBe("ok a\n");
    expect(await getVia(port, `http://127.0.0.1:${upstream.port}/ignored`)).toBe(200);
    expect(upstream.received.map((request) => request.url)).toEqual(["/ignored"]);
    // A later pass-through tunnel is the marker: the addon reports in order on one socket.
    expect(
      await tlsViaConnect(port, target, { servername: "pass.test", ca: server.cert, line: "b" }),
    ).toBe("ok b\n");
    await proxy.tunnels.next();
    expect(proxy.tunnels.items.map((tunnel) => tunnel.sni)).toEqual(["pass.test"]);
    expect(proxy.flows.items).toEqual([]);
  });

  it("with recording off the proxy forwards and reports nothing, and turning it on applies to the next flow", async () => {
    await using upstream = await openUpstream((_request, response) => {
      response.end("ok");
    });
    await using runtime = await openMitmRuntime();
    const proxy = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: await freePort(), recording: false }),
    });
    const port = proxy.process.listenPort as number;
    expect(await getVia(port, `http://127.0.0.1:${upstream.port}/off`)).toBe(200);
    await proxy.process.setRecording(true);
    expect(await getVia(port, `http://127.0.0.1:${upstream.port}/on`)).toBe(200);
    await proxy.flows.next();
    expect(proxy.flows.items.map((flow) => flow.path)).toEqual(["/on"]);
    expect(upstream.received.map((request) => request.url)).toHaveLength(2);
  });

  it("a live hosts update takes effect on the next connection", async () => {
    await using server = await openTlsServer(["pass.test"]);
    await using runtime = await openMitmRuntime();
    const proxy = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: await freePort() }),
    });
    const port = proxy.process.listenPort as number;
    const target = { host: "127.0.0.1", port: server.port };
    const tls = { servername: "pass.test", ca: server.cert, line: "x" };
    // Not listed yet: mitmproxy intercepts, and a client that trusts only the server cert refuses.
    await expect(tlsViaConnect(port, target, tls)).rejects.toThrow();
    await proxy.process.setHosts(hostsOf(["pass.test"], []));
    expect(await tlsViaConnect(port, target, tls)).toBe("ok x\n");
    expect(await proxy.tunnels.next()).toMatchObject({ sni: "pass.test" });
  });

  it("proxy A's upstream is proxy B: B records the request with A's upstream auth, which never reaches argv", async () => {
    await using upstream = await openUpstream((_request, response) => {
      response.end("ok");
    });
    await using runtime = await openMitmRuntime();
    const b = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: await freePort() }),
    });
    const portB = b.process.listenPort as number;
    const auth = { username: "alice", password: "SECRET-UPSTREAM-PASSWORD" };
    const a = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({
        autoPortStart: portB + 1,
        mode: { kind: "upstream", url: `http://127.0.0.1:${portB}` },
        upstreamAuth: auth,
      }),
    });
    const cmdline = NodeFS.readFileSync(`/proc/${a.process.pid}/cmdline`, "utf8");
    expect(cmdline).toContain(`upstream:http://127.0.0.1:${portB}`);
    expect(cmdline).not.toContain(auth.password);

    expect(
      await getVia(a.process.listenPort as number, `http://127.0.0.1:${upstream.port}/chained`),
    ).toBe(200);
    const atB = await b.flows.next();
    expect(atB.path).toBe("/chained");
    expect(headerValue(atB, "proxy-authorization")).toEqual([
      `Basic ${Buffer.from("alice:SECRET-UPSTREAM-PASSWORD").toString("base64")}`,
    ]);
    const atA = await a.flows.next();
    expect(atA.path).toBe("/chained");
    expect(headerValue(atA, "proxy-authorization")).toEqual([]);
  });

  it("pass-through hosts and upstream auth hold from the first connection, before the addon applies anything", async () => {
    await using server = await openTlsServer(["pass.test"]);
    await using upstream = await openUpstream((_request, response) => {
      response.end("ok");
    });
    await using runtime = await openMitmRuntime();
    const b = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: await freePort() }),
    });
    const portB = b.process.listenPort as number;
    // A fresh dataDir, so the upstream-auth start also has to create the shared CA first.
    await using bare = await openMitmRuntime({ addonSource: HELLO_ONLY_ADDON });
    const pass = await bare.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: portB + 1, hosts: hostsOf(["pass.test"], []) }),
    });
    const passPort = pass.process.listenPort as number;
    const chained = await bare.start({
      kind: "capture",
      proxy: proxyOptions({
        autoPortStart: passPort + 1,
        mode: { kind: "upstream", url: `http://127.0.0.1:${portB}` },
        upstreamAuth: { username: "carol", password: "EARLY-PASSWORD" },
      }),
    });

    expect(
      await tlsViaConnect(
        passPort,
        { host: "127.0.0.1", port: server.port },
        { servername: "pass.test", ca: server.cert, line: "early" },
      ),
    ).toBe("ok early\n");
    expect(
      await getVia(chained.process.listenPort as number, `http://127.0.0.1:${upstream.port}/early`),
    ).toBe(200);
    expect(headerValue(await b.flows.next(), "proxy-authorization")).toEqual([
      `Basic ${Buffer.from("carol:EARLY-PASSWORD").toString("base64")}`,
    ]);
    expect(NodeFS.readdirSync(NodePath.join(bare.dataDir, "mitmproxy"))).toContain(
      "mitmproxy-ca.pem",
    );
  });

  it("a replay-only process with an upstream sends the replay through it with its auth", async () => {
    await using upstream = await openUpstream((_request, response) => {
      response.end("replayed");
    });
    await using runtime = await openMitmRuntime();
    const b = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: await freePort() }),
    });
    const carrier = await runtime.start({
      kind: "replay",
      upstream: {
        url: `http://127.0.0.1:${b.process.listenPort as number}`,
        auth: { username: "bob", password: "pw" },
      },
    });
    const bodyFile = NodePath.join(runtime.dataDir, "replay-body");
    NodeFS.writeFileSync(bodyFile, "");
    const b64 = (text: string) => Buffer.from(text).toString("base64");
    await carrier.process.send({
      type: "replay",
      replayId: "r1",
      request: {
        method: "GET",
        scheme: "http",
        host: "127.0.0.1",
        port: upstream.port,
        authority: "",
        path: "/replayed",
        httpVersion: "HTTP/1.1",
        headers: [[b64("Host"), b64(`127.0.0.1:${upstream.port}`)]],
        bodyFile,
      },
    });
    const result = await carrier.replays.next();
    expect(result).toMatchObject({ replayId: "r1", flow: { response: { status: 200 } } });
    const atB = await b.flows.next();
    expect(atB.path).toBe("/replayed");
    expect(headerValue(atB, "proxy-authorization")).toEqual([
      `Basic ${Buffer.from("bob:pw").toString("base64")}`,
    ]);
  });

  it("SOCKS5 mode records an HTTP flow", async () => {
    await using upstream = await openUpstream((_request, response) => {
      response.end("socks");
    });
    await using runtime = await openMitmRuntime();
    const proxy = await runtime.start({
      kind: "capture",
      proxy: proxyOptions({ autoPortStart: await freePort(), mode: { kind: "socks5" } }),
    });
    const reply = await socks5Request(
      proxy.process.listenPort as number,
      { host: "127.0.0.1", port: upstream.port },
      `GET /over-socks HTTP/1.1\r\nHost: 127.0.0.1:${upstream.port}\r\nConnection: close\r\n\r\n`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(reply.endsWith("socks")).toBe(true);
    const flow = await proxy.flows.next();
    expect(flow).toMatchObject({ method: "GET", path: "/over-socks", port: upstream.port });
    expect(flow.response?.status).toBe(200);
  });
});
