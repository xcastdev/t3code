// @effect-diagnostics nodeBuiltinImport:off - Real-mitmdump tests for the packed inspector.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import {
  deferred,
  openPackedInspector,
  openUpstream,
  processExit,
  type ReceivedRequest,
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

/** Captures one POST with duplicate headers and a binary body, and returns its request id. */
async function captureSource(
  inspector: Awaited<ReturnType<typeof openPackedInspector>>,
  upstreamPort: number,
  path: string,
): Promise<string> {
  const stored = inspector.nextItem("requests", {}, requestAt(path));
  await viaProxy(inspector.proxyPort, `http://127.0.0.1:${upstreamPort}${path}`, {
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

const replay = async (
  inspector: Awaited<ReturnType<typeof openPackedInspector>>,
  requestId: string,
) => {
  const preview = (await inspector.worker.invoke("preview_replay", { requestId }).result) as {
    readonly idempotencyKey: string;
  };
  const accepted = (await inspector.worker.invoke("replay_request", {
    requestId,
    idempotencyKey: preview.idempotencyKey,
  }).result) as { readonly replayId: string; readonly state: string };
  return { ...accepted, idempotencyKey: preview.idempotencyKey };
};

const getReplay = (inspector: Awaited<ReturnType<typeof openPackedInspector>>, replayId: string) =>
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
    await inspector.worker.invoke("start_capture", {}).result;
    const [mitmdump] = inspector.mitmdumpPids();
    if (mitmdump === undefined) throw new Error("mitmdump did not start");
    const exited = processExit(mitmdump);

    process.kill(inspector.worker.pid, "SIGKILL");
    await inspector.worker.exited;
    await exited;
  });

  it("the packed archive holds no addon.py entry, and capture spawns mitmdump with the addon materialized under dataDir/runtime", async () => {
    await using upstream = await openUpstream((_request, response) => {
      response.end("ok");
    });
    await using inspector = await openPackedInspector();
    expect(listFiles(inspector.extractedDir)).toEqual([
      NodePath.join("backend", "index.cjs"),
      "t3-plugin.json",
      NodePath.join("ui", "inspector.html"),
    ]);

    await inspector.worker.invoke("start_capture", {}).result;
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

    expect(await captureSource(inspector, upstream.port, "/captured")).toMatch(/^\d+$/);
    await inspector.worker.invoke("stop_capture", {}).result;
  });

  it.each(["through a running capture", "with no capture"] as const)(
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
      await inspector.worker.invoke("start_capture", {}).result;
      const source = await captureSource(inspector, upstream.port, "/login");
      if (mode === "with no capture") await inspector.worker.invoke("stop_capture", {}).result;
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
        includeSensitiveHeaders: true,
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
      if (mode === "with no capture") {
        expect(pids).toHaveLength(pidsBefore + 1);
        await processExit(pids.at(-1) as number);
      } else {
        expect(pids).toHaveLength(pidsBefore);
        await inspector.worker.invoke("stop_capture", {}).result;
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
    await inspector.worker.invoke("start_capture", {}).result;
    const source = await captureSource(inspector, upstream.port, "/slow");

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
    await inspector.worker.invoke("stop_capture", {}).result;
  });

  it("stop_capture after the upstream received a replay and before it answers reports unknown with dispatched true", async () => {
    const release = deferred<void>();
    let held = false;
    await using upstream = await openUpstream(async (_request, response) => {
      if (held) await release.promise;
      held = true;
      response.end("done");
    });
    await using inspector = await openPackedInspector();
    await inspector.worker.invoke("start_capture", {}).result;
    const source = await captureSource(inspector, upstream.port, "/held");
    const [capturePid] = inspector.mitmdumpPids();
    if (capturePid === undefined) throw new Error("mitmdump did not start");

    const replayed = upstream.nextRequest();
    const accepted = await replay(inspector, source);
    await replayed;
    const exited = processExit(capturePid);
    await inspector.worker.invoke("stop_capture", {}).result;
    await exited;

    expect(await getReplay(inspector, accepted.replayId)).toMatchObject({
      state: "unknown",
      dispatched: true,
    });
    release.resolve();
  });
});
