// @effect-diagnostics nodeBuiltinImport:off -- Per-connection TLS verification needs raw HTTPS options.
import * as NodeHttps from "node:https";
import { expect, it } from "vite-plus/test";
import {
  createRouteProof,
  environmentId,
  pinnedIdentity,
} from "../../../web/test/relayRouteProof/fixture.ts";

function send(url: string, options: NodeHttps.RequestOptions, body?: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = NodeHttps.request(url, { ...options, agent: false }, (res) => {
      res.setEncoding("utf8");
      let received = "";
      res.on("data", (chunk: string) => {
        received += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, body: received }));
      res.on("error", reject);
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, body: "" });
    });
    req.on("error", reject);
    req.end(body);
  });
}

it("pins every credential-bearing connection even when a candidate copied the cached environment ID", async () => {
  await using proof = await createRouteProof();
  const { alpha, beta, ca } = proof;
  const descriptor = await send(`${beta.origin}/descriptor`, { ca });
  expect(JSON.parse(descriptor.body)).toEqual({ environmentId });

  const cached = { origin: alpha.origin, checkServerIdentity: pinnedIdentity(alpha.cert) };
  expect(await send(`${cached.origin}/outbound`, { ca, ...cached })).toMatchObject({ status: 503 });
  await proof.connectOutbound();
  expect(await send(`${cached.origin}/outbound`, { ca, ...cached })).toEqual({
    status: 200,
    body: "outbound environment",
  });

  const attempt = [
    { path: "/bootstrap", method: "POST", headers: {}, body: "pairing-code-a" },
    { path: "/ticket", method: "POST", headers: { authorization: "Bearer session-a" } },
    { path: "/mcp", method: "POST", headers: { authorization: "Bearer peer-token-a" } },
    { path: "/first", headers: { cookie: "__Host-route-proof=cookie-a" } },
    {
      path: "/ws?ticket=ticket-a-1",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        origin: alpha.origin,
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    },
  ];
  const ticket = await send(`${cached.origin}/ticket`, {
    ca,
    ...cached,
    method: "POST",
    headers: { authorization: "Bearer session-a", origin: alpha.origin },
  });
  expect(ticket).toEqual({ status: 200, body: "ticket-a-1" });

  const reconnectedOrigin = `https://localhost:${alpha.port}`;
  const routeTo =
    (address: string): NodeHttps.RequestOptions["lookup"] =>
    (_host, _options, reply) =>
      reply(null, address, 4);
  expect(
    await send(`${reconnectedOrigin}/descriptor`, {
      ca,
      ...cached,
      family: 4,
      lookup: routeTo("127.0.0.1"),
    }),
  ).toMatchObject({ status: 200 });

  for (const credential of attempt) {
    // Both certificates validate for beta's socket address. Only the SPKI differs.
    await expect(
      send(
        `${reconnectedOrigin}${credential.path}`,
        {
          ca,
          ...cached,
          family: 4,
          lookup: routeTo("127.0.0.2"),
          method: "method" in credential ? credential.method : "GET",
          headers: credential.headers,
        },
        credential.body,
      ),
    ).rejects.toThrow("Environment TLS key mismatch");
  }
  expect(
    await send(`${cached.origin}${attempt[4]!.path}`, {
      ca,
      ...cached,
      headers: attempt[4]!.headers,
    }),
  ).toMatchObject({ status: 101 });

  expect(
    await send(
      `${cached.origin}/redirect`,
      {
        ca,
        ...cached,
        method: "POST",
        headers: { authorization: "Bearer peer-token-a" },
      },
      "opaque peer request",
    ),
  ).toMatchObject({ status: 307 });
  expect(proof.observed.filter(({ environment }) => environment === "b")).toEqual([
    { environment: "b", method: "GET", path: "/descriptor" },
  ]);

  // The saved verified route remains usable without an enrollment connection.
  proof.disconnectOutbound();
  expect(await send(`${cached.origin}/outbound`, { ca, ...cached })).toMatchObject({ status: 503 });
  expect(
    await send(`${cached.origin}/mcp`, {
      ca,
      ...cached,
      headers: { authorization: "Bearer peer-token-a" },
    }),
  ).toMatchObject({ status: 200 });
});
