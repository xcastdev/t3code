// @effect-diagnostics nodeBuiltinImport:off -- The TLS fixture uses Node's real socket and certificate store.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import * as Redacted from "effect/Redacted";
import { expect, it } from "vite-plus/test";

import { parseRelayHttp } from "./DesktopRelayPolicy.ts";
import { makeDesktopRelayTransport } from "./DesktopRelayTransport.ts";

const readFixture = (name: string) =>
  NodeFS.readFileSync(
    new URL(`../../../server/src/relay/fixtures/relay-push-apns-${name}.pem`, import.meta.url),
    "utf8",
  );

it("sends the exact signed request only after same-socket CA and pin verification", async () => {
  const cert = readFixture("cert");
  const key = readFixture("key");
  const spki = new NodeCrypto.X509Certificate(cert).publicKey.export({
    type: "spki",
    format: "der",
  });
  const pin = NodeCrypto.createHash("sha256").update(spki).digest("base64");
  const requests: { url: string | undefined; authorization: string | undefined; body: Buffer }[] =
    [];
  const server = NodeHttps.createServer({ cert, key }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      authorization: request.headers["proxy-authorization"],
      body: Buffer.concat(chunks),
    });
    response.writeHead(307, { Location: "/api/auth/session" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originalCa = NodeTls.getCACertificates("default");
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing fixture listener.");
    const origin = `https://127.0.0.1:${address.port}`;
    const target = "/api/attachments/upload/fixture.signature?a=%2f+b&a=2";
    const input = parseRelayHttp({ url: origin + target, method: "POST", headers: [], body: true });
    if (input === null) throw new Error("Fixture URL was refused.");
    const transport = (spkiSha256: string) =>
      makeDesktopRelayTransport(
        [
          {
            origin,
            hostname: "127.0.0.1",
            environmentId: "fixture",
            transportRole: "relay",
            spkiSha256,
          },
        ],
        new Map([[origin, Redacted.make("relay-fixture")]]),
      );
    const signal = new AbortController().signal;
    async function* body() {
      await Promise.resolve();
      yield new Uint8Array([9, 0, 255]);
    }
    await expect(transport(pin).request(input, signal, body())).rejects.toThrow();
    NodeTls.setDefaultCACertificates([...originalCa, cert]);
    await expect(
      transport(Buffer.alloc(32).toString("base64")).request(input, signal, body()),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
    await expect(transport(pin).request(input, signal, body())).rejects.toThrow();
    expect(requests).toEqual([
      { url: target, authorization: "Bearer relay-fixture", body: Buffer.from([9, 0, 255]) },
    ]);
  } finally {
    NodeTls.setDefaultCACertificates(originalCa);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
