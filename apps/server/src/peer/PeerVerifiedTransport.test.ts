// @effect-diagnostics nodeBuiltinImport:off -- Own a disposable HTTPS listener and derive certificate pins.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { createRouteProof } from "../../../web/test/relayRouteProof/fixture.ts";
import { serveLoopback } from "../relay/fixtures/p1bIngress.testkit.ts";
import * as PeerEnrollment from "./PeerEnrollment.ts";
import * as PeerVerifiedTransport from "./PeerVerifiedTransport.ts";

const canonicalOrigin = "https://canonical-peer.invalid";
const mcpRequest = HttpClientRequest.post(`${canonicalOrigin}/mcp`).pipe(
  HttpClientRequest.setHeader("authorization", "Bearer peer-token-a"),
  HttpClientRequest.bodyText('{"jsonrpc":"2.0"}', "application/json"),
);

const pin = (certificate: Buffer) =>
  NodeCrypto.createHash("sha256")
    .update(
      new NodeCrypto.X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }),
    )
    .digest("base64url");

const serveRouteProof = Effect.acquireDisposable(Effect.promise(createRouteProof));

const relayCredential = `t3-session-1.11111111-1111-4111-8111-111111111111.1.${"a".repeat(43)}`;
const loadRoutes = (routes: ReadonlyArray<object>, origin = canonicalOrigin) =>
  PeerEnrollment.load.pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({
        env: {
          T3CODE_PEER_ENROLLMENTS: JSON.stringify([
            { environmentId: "peer-test", canonicalOrigin: origin, routes },
          ]),
        },
      }),
    ),
  );

it.live("sends only the route's configured relay credential alongside canonical headers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "peer-relay-" });
    const path = `${dir}/credential`;
    yield* fs.writeFileString(path, `${relayCredential}\r\n`, { mode: 0o600 });
    const key = NodeFS.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url));
    const cert = NodeFS.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url));
    const observed: Array<object> = [];
    const record: import("node:http").RequestListener = (request, response) => {
      observed.push({
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
        relay: request.headers["proxy-authorization"],
        dpop: request.headers.dpop,
      });
      response.writeHead(204).end();
    };
    const alias = yield* serveLoopback(NodeHttps.createServer({ key, cert }, record));
    const direct = yield* serveLoopback(NodeHttps.createServer({ key, cert }, record));
    const otherCert = NodeFS.readFileSync(
      new URL("../relay/fixtures/p1b-ingress-client-cert.pem", import.meta.url),
      "utf8",
    );
    const settings = {
      spkiSha256: pin(cert),
      caPem: `${otherCert.trimEnd()}\n\n${cert}`.replaceAll(/\r?\n/gu, "\r\n"),
    };
    const [enrollment] = yield* loadRoutes(
      [
        { ...settings, origin: direct },
        { ...settings, origin: alias, relayCredentialPath: path },
      ],
      direct,
    );
    const logicalRequest = mcpRequest.pipe(
      HttpClientRequest.setUrl(`${direct}/mcp?resource=canonical`),
      HttpClientRequest.setHeaders({
        "Proxy-Authorization": "Bearer caller-supplied",
        Expect: "100-continue",
        Host: "other.invalid",
        DPoP: "canonical-proof",
      }),
    );
    for (const route of enrollment!.routes) {
      expect((yield* route.transport.httpClient.execute(logicalRequest)).status).toBe(204);
    }
    expect(observed).toEqual([
      {
        url: "/mcp?resource=canonical",
        host: new URL(direct).host,
        authorization: "Bearer peer-token-a",
        relay: undefined,
        dpop: "canonical-proof",
      },
      {
        url: "/mcp?resource=canonical",
        host: new URL(alias).host,
        authorization: "Bearer peer-token-a",
        relay: `Bearer ${relayCredential}`,
        dpop: "canonical-proof",
      },
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects unsafe or malformed credential files with one sanitized error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "peer-relay-" });
    const path = `${dir}/credential`;
    const binding = { origin: canonicalOrigin, spkiSha256: Buffer.alloc(32).toString("base64url") };
    const reject = Effect.fn("PeerVerifiedTransportTest.rejectEnrollment")(function* (
      route: object,
    ) {
      const exit = yield* Effect.exit(loadRoutes([{ ...binding, ...route }]));
      expect(exit._tag).toBe("Failure");
      if (Exit.isFailure(exit)) {
        expect(Cause.prettyErrors(exit.cause).map((error) => error.message)).toEqual([
          "Invalid peer enrollment configuration.",
        ]);
      }
    });
    yield* reject({ relayCredentialPath: path });
    yield* reject({ relayCredentialPath: dir });
    yield* reject({ relayCredential: relayCredential });
    yield* reject({ caPem: "sensitive-malformed-ca" });
    const cert = NodeFS.readFileSync(
      new URL("./fixtures/localhost-cert.pem", import.meta.url),
      "utf8",
    );
    yield* reject({ caPem: `${cert.trimEnd()}${cert}` });
    for (const contents of [
      "",
      `Bearer ${relayCredential}`,
      `${relayCredential}\n\n`,
      `${relayCredential}\r\nX-Relay-Secret: hidden`,
      "a".repeat(1025),
    ]) {
      yield* fs.writeFileString(path, contents, { mode: 0o600 });
      yield* reject({ relayCredentialPath: path });
    }
    if ((yield* HostProcess.Platform) !== "win32") {
      yield* fs.writeFileString(path, relayCredential);
      const symlink = `${dir}/symlink`;
      yield* fs.symlink(path, symlink);
      yield* reject({ relayCredentialPath: symlink });
      yield* reject({ relayCredentialPath: symlink }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      );
      yield* fs.chmod(path, 0o640);
      yield* reject({ relayCredentialPath: path });
      expect(
        yield* loadRoutes([{ ...binding, relayCredentialPath: path }]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
      ).toHaveLength(1);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("delivers a canonical MCP request only to a trusted alias with the enrolled TLS key", () =>
  Effect.gen(function* () {
    const proof = yield* serveRouteProof;
    const { alpha, beta, ca } = proof;
    const binding = { canonicalOrigin, aliasOrigin: alpha.origin, spkiSha256: pin(alpha.cert) };

    const accepted = yield* PeerVerifiedTransport.make(binding, { ca }).execute(mcpRequest);
    expect(accepted.status).toBe(200);
    expect(yield* accepted.text).toBe("");
    expect(accepted.request.url).toBe(`${canonicalOrigin}/mcp`);

    const wrongKey = yield* PeerVerifiedTransport.make(
      { ...binding, aliasOrigin: beta.origin },
      { ca },
    )
      .execute(mcpRequest)
      .pipe(Effect.flip);
    expect(wrongKey.reason).toMatchObject({
      _tag: "TransportError",
      cause: { message: "Peer alias TLS key mismatch" },
    });

    const untrusted = yield* PeerVerifiedTransport.make(binding)
      .execute(mcpRequest)
      .pipe(Effect.flip);
    expect(untrusted.reason).toMatchObject({
      _tag: "TransportError",
      cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    });

    expect(proof.observed).toEqual([
      { environment: "a", method: "POST", path: "/mcp", authorization: "Bearer peer-token-a" },
    ]);
  }),
);

it.live("requires the certificate to name the physical alias even when the pin matches", () =>
  Effect.gen(function* () {
    const key = NodeFS.readFileSync(new URL("./fixtures/localhost-key.pem", import.meta.url));
    const cert = NodeFS.readFileSync(new URL("./fixtures/localhost-cert.pem", import.meta.url));
    let received = 0;
    const server = yield* Effect.acquireDisposable(
      Effect.sync(() =>
        NodeHttps.createServer({ key, cert }, (_request, response) => {
          received += 1;
          response.end();
        }),
      ),
    );
    yield* Effect.promise(
      () => new Promise<void>((resolve) => server.listen(0, "127.0.0.2", resolve)),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
    const client = PeerVerifiedTransport.make(
      { canonicalOrigin, aliasOrigin: `https://127.0.0.2:${address.port}`, spkiSha256: pin(cert) },
      { ca: cert },
    );
    const failure = yield* client.execute(mcpRequest).pipe(Effect.flip);
    expect(failure.reason).toMatchObject({
      _tag: "TransportError",
      cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    });
    expect(received).toBe(0);
  }),
);

it.live(
  "blocks third-origin requests and refuses redirects before a second credential-bearing send",
  () =>
    Effect.gen(function* () {
      const proof = yield* serveRouteProof;
      const { alpha, beta, ca } = proof;
      const client = PeerVerifiedTransport.make(
        {
          canonicalOrigin,
          aliasOrigin: alpha.origin,
          spkiSha256: pin(alpha.cert),
          relayCredential: Redacted.make(relayCredential),
        },
        { ca },
      ).pipe(HttpClient.followRedirects());

      const foreign = yield* client
        .execute(HttpClientRequest.setUrl(mcpRequest, `${beta.origin}/mcp`))
        .pipe(Effect.flip);
      expect(foreign.reason._tag).toBe("InvalidUrlError");

      const redirect = yield* client
        .execute(HttpClientRequest.setUrl(mcpRequest, `${canonicalOrigin}/redirect`))
        .pipe(Effect.flip);
      expect(redirect.reason).toMatchObject({
        _tag: "TransportError",
        cause: { message: "Peer alias refused HTTP redirect (307)" },
      });

      expect(proof.observed).toEqual([
        {
          environment: "a",
          method: "POST",
          path: "/redirect",
          authorization: "Bearer peer-token-a",
        },
      ]);
    }),
);
