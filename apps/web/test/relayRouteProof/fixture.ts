// @effect-diagnostics nodeBuiltinImport:off -- The TLS proof needs raw sockets and certificates.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeHttp2 from "node:http2";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";

export const environmentId = "route-proof-environment";

function certificates(directory: string) {
  const openssl = (...args: string[]) =>
    NodeChildProcess.execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  openssl(
    "req",
    "-new",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=T3 disposable route proof CA",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
  );
  return ["a", "b"].map((name) => {
    openssl(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=route-proof-${name}`,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2",
    );
    openssl(
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-copy_extensions",
      "copy",
      "-days",
      "2",
      "-out",
      `${name}.pem`,
    );
    return {
      cert: NodeFS.readFileSync(NodePath.join(directory, `${name}.pem`)),
      key: NodeFS.readFileSync(NodePath.join(directory, `${name}.key`)),
    };
  });
}

export function pinnedIdentity(cert: Buffer) {
  const pin = new NodeCrypto.X509Certificate(cert).publicKey.export({
    format: "der",
    type: "spki",
  });
  return (host: string, peer: Parameters<typeof NodeTls.checkServerIdentity>[1]) =>
    NodeTls.checkServerIdentity(host, peer) ??
    (peer.pubkey?.equals(pin) ? undefined : new Error("Environment TLS key mismatch"));
}

export async function createRouteProof() {
  const resources = new AsyncDisposableStack();
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-route-proof-"));
  resources.defer(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  try {
    const [a, b] = certificates(directory);
    const caPath = NodePath.join(directory, "ca.pem");
    const ca = NodeFS.readFileSync(caPath);
    const observed: Array<{
      environment: "a" | "b";
      method: string;
      path: string;
      cookie?: string;
      authorization?: string;
      body?: string;
    }> = [];
    const uploadStarted = Promise.withResolvers<void>();
    const uploadEnded = Promise.withResolvers<"aborted" | "committed">();
    let attachment: string | undefined;
    let commits = 0;
    let active = true;
    let outbound: NodeStream.Duplex | undefined;
    let nextTicket = 0;
    const tickets = new Set<string>();
    const sockets = new Set<NodeStream.Duplex>();
    const track = (socket: NodeStream.Duplex) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    };

    const listen = async (environment: "a" | "b", host: string, port: number) => {
      const tls = environment === "a" ? a! : b!;
      const server = NodeHttp2.createSecureServer({ ...tls, allowHTTP1: true });
      server.on("connection", track);
      server.on("session", (session) => {
        // A cancelled HTTP/2 request stream is independent of the TLS session.
        session.on("error", () => session.destroy());
      });
      resources.defer(async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await closed;
      });
      const serving = Promise.withResolvers<void>();
      server.once("error", serving.reject);
      server.listen(port, host, serving.resolve);
      await serving.promise;
      server.off("error", serving.reject);
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing listener");
      const origin = `https://${host}:${address.port}`;
      return { server, origin, cert: tls.cert, port: address.port, environment };
    };

    const alpha = await listen("a", "127.0.0.1", 0);
    const beta = await listen("b", "127.0.0.2", alpha.port);
    for (const endpoint of [alpha, beta]) {
      const { server, environment } = endpoint;
      server.on("request", (req, res) => {
        const path = req.url ?? "/";
        if (req.method === "CONNECT") return;
        res.setHeader("cache-control", "no-store");
        if (environment === "a" && !active) {
          res.writeHead(410).end();
          return;
        }
        const record: (typeof observed)[number] = {
          environment,
          method: req.method ?? "",
          path,
          ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
          ...(req.headers.authorization === undefined
            ? {}
            : { authorization: req.headers.authorization }),
        };
        observed.push(record);
        const ownOrigin = req.headers.origin === alpha.origin;
        const hostedOrigin = req.headers.origin === beta.origin;
        const sessionAuthorized =
          req.headers.authorization === "Bearer session-a" ||
          req.headers.cookie === "__Host-route-proof=cookie-a";
        if (hostedOrigin && path !== "/deny") {
          res.setHeader("access-control-allow-origin", beta.origin);
          res.setHeader("vary", "origin");
          res.setHeader("access-control-allow-headers", "authorization");
          res.setHeader("access-control-allow-methods", "GET, POST");
        }
        if (req.method === "OPTIONS") {
          res.writeHead(hostedOrigin && path !== "/deny" ? 204 : 403).end();
          return;
        }
        switch (path) {
          case "/":
          case "/hosted":
          case "/first":
          case "/seed":
            if (path === "/seed" && environment === "a") {
              res.setHeader(
                "set-cookie",
                "__Host-route-proof=cookie-a; Secure; HttpOnly; Path=/; SameSite=Lax",
              );
            }
            res.setHeader("content-type", "text/html");
            res.end(
              '<!doctype html><meta name="color-scheme" content="dark"><body style="background:#111;color:#eee">Route proof</body>',
            );
            return;
          case "/descriptor":
            res.end(JSON.stringify({ environmentId }));
            return;
          case "/redirect":
            res.writeHead(307, { location: `${beta.origin}/receive` }).end();
            return;
          case "/ticket": {
            if (environment !== "a" || (!ownOrigin && !hostedOrigin) || !sessionAuthorized) {
              res.writeHead(403).end();
              return;
            }
            const ticket = `ticket-a-${++nextTicket}`;
            tickets.add(ticket);
            res.end(ticket);
            return;
          }
          case "/outbound":
            if (outbound === undefined || outbound.destroyed) {
              res.writeHead(503).end();
              return;
            }
            outbound.once("data", (body) => res.end(body));
            outbound.write("read");
            return;
          case "/mcp":
            res
              .writeHead(
                environment === "a" && req.headers.authorization === "Bearer peer-token-a"
                  ? 200
                  : 401,
              )
              .end();
            return;
          case "/upload-started":
            void uploadStarted.promise.then(() => res.end("started"));
            return;
          case "/attachment":
          case "/interrupt": {
            if (environment !== "a" || !sessionAuthorized) {
              res.writeHead(403).end();
              return;
            }
            if (req.method === "GET") {
              if (attachment === undefined) res.writeHead(404).end();
              else res.writeHead(200).end(attachment);
              return;
            }
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              if (path === "/interrupt") uploadStarted.resolve();
            });
            req.on("error", () => {
              if (path === "/interrupt") uploadEnded.resolve("aborted");
            });
            req.on("close", () => {
              if (path === "/interrupt" && !req.complete) uploadEnded.resolve("aborted");
            });
            req.on("end", () => {
              const body = Buffer.concat(chunks).toString();
              // HTTP/2 can end the compatibility stream after a reset. Require the whole write.
              if (!req.complete || body !== "attachment bytes") {
                if (path === "/interrupt") uploadEnded.resolve("aborted");
                if (!res.destroyed) res.writeHead(400).end();
                return;
              }
              attachment = body;
              commits += 1;
              if (path === "/interrupt") uploadEnded.resolve("committed");
              res.writeHead(201).end();
            });
            return;
          }
          default: {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
              record.body = Buffer.concat(chunks).toString();
              res.end("ok");
            });
          }
        }
      });
      server.on("upgrade", (req, socket) => {
        const path = new URL(req.url ?? "/", endpoint.origin);
        if (environment === "a" && !active) {
          socket.end("HTTP/1.1 410 Gone\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        observed.push({
          environment,
          method: "UPGRADE",
          path: path.pathname + path.search,
          ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }),
          ...(req.headers.authorization === undefined
            ? {}
            : { authorization: req.headers.authorization }),
        });
        if (path.pathname === "/ws-redirect") {
          socket.end(
            `HTTP/1.1 307 Temporary Redirect\r\nLocation: ${beta.origin}/ws\r\nContent-Length: 0\r\n\r\n`,
          );
          return;
        }
        const key = req.headers["sec-websocket-key"];
        const ticket = path.searchParams.get("ticket") ?? "";
        if (
          environment !== "a" ||
          path.pathname !== "/ws" ||
          key === undefined ||
          (req.headers.origin !== alpha.origin && req.headers.origin !== beta.origin) ||
          !tickets.delete(ticket)
        ) {
          socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const accept = NodeCrypto.createHash("sha1")
          .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.once("data", () => socket.end(Buffer.from([0x88, 0x00])));
      });
    }

    alpha.server.on("connect", (req, socket) => {
      if (
        req.url !== new URL(alpha.origin).host ||
        req.headers.authorization !== "Bearer enrollment-a"
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      outbound = socket;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    });

    return {
      directory,
      ca,
      caPath,
      alpha,
      beta,
      observed,
      get commits() {
        return commits;
      },
      uploadEnded: uploadEnded.promise,
      disconnectOutbound() {
        outbound?.destroy();
      },
      removeBinding() {
        active = false;
        outbound?.destroy();
        tickets.clear();
      },
      assignBinding(id: string) {
        // The provisioned origin can never be recycled after removal.
        return active && id === environmentId;
      },
      connectOutbound: () =>
        new Promise<void>((resolve, reject) => {
          const enrollment = NodeHttps.request(alpha.origin, {
            method: "CONNECT",
            path: new URL(alpha.origin).host,
            ca,
            checkServerIdentity: pinnedIdentity(alpha.cert),
            headers: { authorization: "Bearer enrollment-a" },
            agent: false,
          });
          enrollment.on("error", reject);
          enrollment.on("connect", (res, socket) => {
            track(socket);
            if (res.statusCode !== 200) {
              socket.destroy();
              reject(new Error(`Enrollment returned ${res.statusCode}`));
              return;
            }
            socket.on("data", () => socket.write("outbound environment"));
            socket.on("error", () => socket.destroy());
            resolve();
          });
          enrollment.end();
        }),
      [Symbol.asyncDispose]: () => resources.disposeAsync(),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
