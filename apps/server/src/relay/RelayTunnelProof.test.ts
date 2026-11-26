// @effect-diagnostics nodeBuiltinImport:off -- The proofs own raw HTTP and TLS sockets.
import * as NodeHttp from "node:http";
import type * as NodeTls from "node:tls";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  openProofRequest,
  proofRequest,
  serveLoopback,
  serveOutboundProof,
  serveProofIngress,
} from "./fixtures/p1bIngress.testkit.ts";

it.live("only accepts external authority from the enrolled TLS ingress", () =>
  Effect.gen(function* () {
    const seen: Array<string> = [];
    const upstream = yield* serveLoopback(
      NodeHttp.createServer((request, response) => {
        response.end(JSON.stringify(request.headers));
      }),
    );
    const ingress = yield* serveProofIngress(upstream, "https://enrolled.test", (origin) =>
      seen.push(origin),
    );
    const headers = {
      host: "caller.test",
      forwarded: "host=caller.test;proto=http",
      "x-forwarded-host": "caller.test",
      "x-forwarded-proto": "http",
      "x-forwarded-for": "192.0.2.10",
      "x-forwarded-port": "80",
      "t3-proof-external-authority": "caller.test",
      connection: "x-hop-test",
      "x-hop-test": "private hop header",
    };

    // Even correct metadata grants no authority without the enrolled client certificate.
    const denied = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          proofRequest(ingress.privateUrl, {
            headers: {
              ...headers,
              "t3-proof-external-authority": new URL(ingress.url).host,
            },
          }),
        catch: () => "tls-admission-rejected" as const,
      }),
    );
    expect(denied._tag).toBe("Failure");
    expect(seen).toEqual([]);
    const absolute = yield* Effect.promise(() =>
      proofRequest(ingress.url, { path: "https://caller.test/mcp", headers }),
    );
    expect(absolute.status).toBe(400);
    expect(seen).toEqual([]);

    const result = yield* Effect.promise(() => proofRequest(ingress.url, { headers }));
    expect(result.status).toBe(200);
    expect(seen).toEqual([ingress.url]);
    expect(
      Object.fromEntries(
        Object.entries(JSON.parse(result.body)).filter(
          ([name]) =>
            name === "host" ||
            name === "forwarded" ||
            name.startsWith("x-forwarded-") ||
            name === "t3-proof-external-authority" ||
            name === "x-hop-test",
        ),
      ),
    ).toEqual({
      host: "enrolled.test",
      "x-forwarded-proto": "https",
    });
  }),
);

it.live("streams request bytes before EOF and cancels a partial upload at the upstream", () =>
  Effect.gen(function* () {
    const received = Promise.withResolvers<Buffer>();
    const cancelled = Promise.withResolvers<boolean>();
    const upstream = yield* serveLoopback(
      NodeHttp.createServer((request, response) => {
        if (request.method === "GET") {
          response.end("still reachable");
          return;
        }
        request.once("data", received.resolve);
        request.once("close", () => cancelled.resolve(!request.complete));
      }),
    );
    const ingress = yield* serveProofIngress(upstream);
    const upload = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const request = openProofRequest(ingress.url + "/attachment", { method: "POST" });
        request.on("error", received.reject);
        return request;
      }),
      (request) => Effect.sync(() => request.destroy()),
    );
    const prefix = Buffer.from([0x01, 0x00, 0x80, 0xff]);
    upload.write(prefix);
    expect(yield* Effect.promise(() => received.promise)).toEqual(prefix);
    upload.destroy();
    expect(yield* Effect.promise(() => cancelled.promise)).toBe(true);

    const next = yield* Effect.promise(() => proofRequest(ingress.url));
    expect(next.status).toBe(200);
    expect(next.body).toBe("still reachable");
  }),
);

it.live.each(["complete", "cancel"] as const)(
  "streams HTTP through the environment's outbound mTLS connection (%s)",
  (outcome) =>
    Effect.gen(function* () {
      const streamSucceeded = Promise.withResolvers<boolean>();
      const app = yield* HttpRouter.toHttpEffect(
        HttpRouter.add("POST", "/echo", (request) =>
          Effect.succeed(
            HttpServerResponse.stream(
              request.stream.pipe(
                Stream.onExit((exit) =>
                  Effect.sync(() => streamSucceeded.resolve(Exit.isSuccess(exit))),
                ),
              ),
            ),
          ),
        ),
      );
      const scope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(app, { scope });
      const backend = NodeHttp.createServer(handler);

      const relay = yield* serveOutboundProof(backend, 1);
      const relaySocket = yield* Effect.promise(() => dialStream(relay));
      expect(backend.address()).toBeNull();

      const prefix = Buffer.from([0x01, 0x00, 0x80, 0xff]);
      const suffix = Buffer.from([0xf0, 0x02]);
      const firstBytes = Promise.withResolvers<{ status: number | undefined; body: Buffer }>();
      const closed = Promise.withResolvers<boolean>();
      let body = Buffer.alloc(0);
      const request = NodeHttp.request(
        { method: "POST", path: "/echo", createConnection: () => relaySocket },
        (response) => {
          response.on("data", (chunk: Buffer) => {
            body = Buffer.concat([body, chunk]);
            if (body.length >= prefix.length) {
              firstBytes.resolve({ status: response.statusCode, body });
            }
          });
          response.once("error", firstBytes.reject);
          response.once("close", () => {
            firstBytes.reject(new Error("Response closed before echoing the upload prefix"));
            closed.resolve(response.complete);
          });
        },
      ).on("error", firstBytes.reject);

      request.write(prefix);
      expect(yield* Effect.promise(() => firstBytes.promise)).toEqual({
        status: 200,
        body: prefix,
      });
      if (outcome === "complete") {
        request.end(suffix);
        expect(yield* Effect.promise(() => closed.promise)).toBe(true);
        expect(body).toEqual(Buffer.concat([prefix, suffix]));
      } else {
        request.destroy();
        expect(yield* Effect.promise(() => closed.promise)).toBe(false);
      }
      expect(yield* Effect.promise(() => streamSucceeded.promise)).toBe(outcome === "complete");
    }),
);

async function dialStream(relay: { dial: () => Promise<NodeTls.TLSSocket | string> }) {
  const stream = await relay.dial();
  if (typeof stream === "string") throw new Error(`Relay refused stream: ${stream}`);
  return stream;
}

it.live("refuses a pending outbound socket when the enrollment is revoked", () =>
  Effect.gen(function* () {
    let accepted = 0;
    const backend = NodeHttp.createServer().on("connection", () => {
      accepted += 1;
    });
    const relay = yield* serveOutboundProof(backend, 1);
    const pending = relay.dial();

    relay.revoke();

    expect(yield* Effect.promise(() => pending)).toBe("revoked");
    expect(accepted).toBe(0);
    expect(yield* Effect.promise(relay.dial)).toBe("revoked");
  }),
);

function readResponse(
  socket: NodeTls.TLSSocket,
  path: string,
  observe?: (response: NodeHttp.IncomingMessage) => void,
) {
  const ready = Promise.withResolvers<NodeHttp.IncomingMessage>();
  const request = NodeHttp.get({ path, createConnection: () => socket }, (response) => {
    response.on("error", ready.reject);
    observe?.(response);
    ready.resolve(response);
  });
  request.on("error", ready.reject);
  return ready.promise;
}

it.live(
  "bounds active HTTP and WebSocket exchanges, recovers capacity, and closes them on revocation",
  () =>
    Effect.gen(function* () {
      const streamLimit = 64;
      const allDownloadsInterrupted = Promise.withResolvers<void>();
      const upgradeInterrupted = Promise.withResolvers<boolean>();
      let interruptedDownloads = 0;
      const heldBody = Stream.concat(Stream.make(Uint8Array.of(1)), Stream.never).pipe(
        Stream.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.hasInterrupts(exit) && ++interruptedDownloads === streamLimit) {
              allDownloadsInterrupted.resolve();
            }
          }),
        ),
      );
      const webSockets = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeWS.WebSocketServer({ noServer: true })),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const socket of server.clients) socket.terminate();
                server.close(() => resolve());
              }),
          ),
      );
      const app = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          HttpRouter.add("GET", "/hold", HttpServerResponse.stream(heldBody)),
          HttpRouter.add("GET", "/ws", (request) =>
            Effect.scoped(
              Effect.gen(function* () {
                const socket = yield* request.upgrade;
                const input = yield* socket.reader;
                const output = yield* socket.writer;
                yield* output.writeAll(yield* input.pull);
                return yield* Effect.never;
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => upgradeInterrupted.resolve(Exit.hasInterrupts(exit))),
              ),
            ),
          ),
        ),
      );
      const scope = yield* Effect.scope;
      const handler = yield* NodeHttpServer.makeHandler(app, { scope });
      const upgrade = yield* NodeHttpServer.makeUpgradeHandler(Effect.succeed(webSockets), app, {
        scope,
      });
      const backend = NodeHttp.createServer(handler).on("upgrade", upgrade);
      const relay = yield* serveOutboundProof(backend, streamLimit);

      const wsStream = yield* Effect.promise(() => dialStream(relay));
      const ws = new NodeWS.WebSocket("ws://localhost/ws", {
        createConnection: () => wsStream,
      });
      const received = Promise.withResolvers<Uint8Array>();
      const wsClosed = Promise.withResolvers<number>();
      const message = Uint8Array.of(0x01, 0x00, 0x80, 0xff);
      ws.binaryType = "arraybuffer";
      ws.once("open", () => ws.send(message));
      ws.on("error", received.reject);
      ws.once("message", (data, binary) => {
        if (binary && data instanceof ArrayBuffer) received.resolve(new Uint8Array(data));
        else received.reject(new Error("Expected a binary WebSocket frame"));
      });
      ws.once("close", (code) => {
        received.reject(new Error("WebSocket closed before echoing a frame"));
        wsClosed.resolve(code);
      });
      expect(yield* Effect.promise(() => received.promise)).toEqual(message);
      expect(backend.address()).toBeNull();

      const openDownload = async () => {
        const socket = await dialStream(relay);
        const socketClosed = new Promise<void>((resolve) => socket.once("close", resolve));
        const complete = Promise.withResolvers<boolean>();
        const started = Promise.withResolvers<void>();
        await Promise.all([
          started.promise,
          readResponse(socket, "/hold", (response) => {
            response.on("error", started.reject);
            response.once("data", () => started.resolve());
            response.once("close", () => {
              started.reject(new Error("HTTP stream closed before its first byte"));
              complete.resolve(response.complete);
            });
          }),
        ]);
        return { socket, socketClosed, complete: complete.promise };
      };

      const [disconnected, ...remaining] = yield* Effect.promise(() =>
        Promise.all(Array.from({ length: streamLimit - 1 }, openDownload)),
      );
      expect(yield* Effect.promise(relay.dial)).toBe("saturated");

      if (disconnected === undefined) throw new Error("Expected a live HTTP download");
      disconnected.socket.destroy();
      yield* Effect.promise(() => disconnected.socketClosed);
      expect(yield* Effect.promise(() => disconnected.complete)).toBe(false);
      const replacement = yield* Effect.promise(openDownload);
      const downloads = [...remaining, replacement];
      expect(yield* Effect.promise(relay.dial)).toBe("saturated");

      relay.revoke();
      expect(yield* Effect.promise(relay.dial)).toBe("revoked");
      expect(yield* Effect.promise(() => wsClosed.promise)).toBe(1006);
      expect(
        yield* Effect.promise(() => Promise.all(downloads.map(({ complete }) => complete))),
      ).toEqual(Array.from({ length: streamLimit - 1 }, () => false));
      expect(yield* Effect.promise(() => upgradeInterrupted.promise)).toBe(true);
      yield* Effect.promise(() => allDownloadsInterrupted.promise);
    }),
);

it.live("backpressures a stalled HTTP consumer before buffering the full response", () =>
  Effect.gen(function* () {
    const byteChunk = Buffer.alloc(64 * 1024);
    const totalChunks = 512;
    let produced = 0;
    const app = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/download",
          HttpServerResponse.stream(
            Stream.fromEffectRepeat(
              Effect.sync(() => {
                produced += 1;
                return byteChunk;
              }),
            ).pipe(Stream.take(totalChunks)),
          ),
        ),
        HttpRouter.add("GET", "/probe", HttpServerResponse.empty({ status: 204 })),
      ),
    );
    const scope = yield* Effect.scope;
    const handler = yield* NodeHttpServer.makeHandler(app, { scope });
    const relay = yield* serveOutboundProof(NodeHttp.createServer(handler), 2);
    const download = yield* Effect.promise(() => dialStream(relay));
    const response = yield* Effect.promise(() => readResponse(download, "/download"));
    response.pause();

    const probe = yield* Effect.promise(() => dialStream(relay));
    const probeResponse = yield* Effect.promise(() => readResponse(probe, "/probe"));
    expect(probeResponse.statusCode).toBe(204);
    probeResponse.resume();
    expect(produced).toBeGreaterThan(0);
    expect(produced).toBeLessThan(totalChunks);

    const received = yield* Effect.promise(async () => {
      let bytes = 0;
      for await (const chunk of response) bytes += chunk.length;
      return bytes;
    });
    expect(received).toBe(totalChunks * byteChunk.length);
    expect(response.complete).toBe(true);
  }),
);
