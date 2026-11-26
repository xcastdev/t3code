// @effect-diagnostics-next-line nodeBuiltinImport:off -- Generate disposable provider signing keys.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Load the loopback TLS fixtures.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Firebase stub owns a raw HTTP listener.
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Raw provider HTTP streams.
import type * as NodeStream from "node:stream";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as RelayConfiguration from "../../../../infra/relay/src/Config.ts";
import * as WebCrypto from "../../../../infra/relay/src/WebCrypto.ts";
import * as ApnsClient from "../../../../infra/relay/src/agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "../../../../infra/relay/src/agentActivity/ApnsProviderTokens.ts";
import * as FcmAssertionSigner from "../../../../infra/relay/src/agentActivity/FcmAssertionSigner.ts";
import * as FcmClient from "../../../../infra/relay/src/agentActivity/FcmClient.ts";

async function listenOnLoopback(server: NodeHttp.Server | NodeHttp2.Http2SecureServer) {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a loopback TCP listener");
  }
  return `127.0.0.1:${address.port}`;
}

function readBody(request: NodeStream.Readable, onBody: (body: string) => void) {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk: string) => {
    body += chunk;
  });
  request.on("error", () => undefined);
  request.on("end", () => {
    if (!request.destroyed) onBody(body);
  });
}

function loopbackHttpLayer(
  loopbackOrigin: string,
  providerUrls: ReadonlyArray<string>,
  tlsCertificate?: Buffer,
) {
  return Layer.effect(
    HttpClient.HttpClient,
    HttpClient.HttpClient.useSync(
      HttpClient.mapRequestEffect((request) => {
        const url = new URL(request.url);
        if (!providerUrls.includes(url.href)) {
          return Effect.die(new Error(`Unexpected provider URL: ${url.href}`));
        }
        return Effect.succeed(
          HttpClientRequest.setUrl(request, loopbackOrigin + url.pathname + url.search),
        );
      }),
    ),
  ).pipe(
    Layer.provide(
      NodeHttpClient.layerUndiciOptions(
        tlsCertificate ? { allowH2: true, connect: { ca: tlsCertificate } } : {},
      ),
    ),
  );
}

it.live("sends APNs alert and Live Activity requests over TLS HTTP/2", () =>
  Effect.gen(function* () {
    const cert = NodeFS.readFileSync(
      new URL("./fixtures/relay-push-apns-cert.pem", import.meta.url),
    );
    const key = NodeFS.readFileSync(new URL("./fixtures/relay-push-apns-key.pem", import.meta.url));
    const requests: Array<{
      alpn: string | undefined;
      headers: NodeHttp2.IncomingHttpHeaders;
      body: string;
    }> = [];
    const receiver = yield* Effect.acquireDisposable(
      Effect.sync(() => NodeHttp2.createSecureServer({ cert, key, allowHTTP1: false })),
    );
    receiver.on("stream", (stream, headers) => {
      readBody(stream, (body) => {
        requests.push({ alpn: stream.session?.alpnProtocol, headers, body });
        if (headers[":path"] === "/3/device/expired-token") {
          stream.respond({
            ":status": 410,
            "apns-id": "expired-id",
            "content-type": "application/json",
          });
          stream.end('{"reason":"Unregistered"}');
          return;
        }
        stream.respond({ ":status": 200, "apns-id": "activity-id" });
        stream.end();
      });
    });
    const origin = `https://${yield* Effect.promise(() => listenOnLoopback(receiver))}`;
    const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const credentials = {
      environment: "sandbox",
      teamId: "test-team",
      keyId: "test-key",
      bundleId: "com.t3tools.test",
      privateKey: Redacted.make(privateKey),
    } satisfies RelayConfiguration.ApnsCredentials;
    const nowIso = "1970-01-01T00:00:00.000Z";

    const results = yield* Effect.gen(function* () {
      const client = yield* ApnsClient.ApnsClient;
      const update = yield* client.sendLiveActivityRequest({
        credentials,
        issuedAtUnixSeconds: 0,
        request: client.makeLiveActivityRequest({
          event: "update",
          token: "activity-token",
          nowEpochSeconds: 0,
          nowIso,
          state: {
            title: "T3 Code",
            subtitle: "Working",
            activeCount: 0,
            updatedAt: nowIso,
            activities: [],
          },
        }),
      });
      const alert = yield* client.sendPushNotificationRequest({
        credentials,
        issuedAtUnixSeconds: 0,
        request: client.makePushNotificationRequest({
          token: "expired-token",
          notification: {
            title: "Thread",
            body: "Input: Project",
            environmentId: "env",
            threadId: "thread",
            deepLink: "/threads/env/thread",
          },
        }),
      });
      return { update, alert };
    }).pipe(
      Effect.provide(
        ApnsClient.layer.pipe(
          Layer.provide(ApnsProviderTokens.layer),
          Layer.provide(
            loopbackHttpLayer(
              origin,
              [
                "https://api.sandbox.push.apple.com/3/device/activity-token",
                "https://api.sandbox.push.apple.com/3/device/expired-token",
              ],
              cert,
            ),
          ),
        ),
      ),
    );

    expect(results).toEqual({
      update: { ok: true, status: 200, apnsId: "activity-id" },
      alert: { ok: false, status: 410, reason: "Unregistered", apnsId: "expired-id" },
    });
    expect(requests).toHaveLength(2);
    const [update, alert] = requests;
    const authorization = expect.stringMatching(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(update).toMatchObject({
      alpn: "h2",
      headers: {
        ":method": "POST",
        ":path": "/3/device/activity-token",
        authorization,
        "apns-priority": "5",
        "apns-push-type": "liveactivity",
        "apns-topic": "com.t3tools.test.push-type.liveactivity",
      },
    });
    expect(JSON.parse(update!.body)).toEqual({
      aps: {
        event: "update",
        timestamp: 0,
        "stale-date": 600,
        "content-state": {
          name: "AgentActivity",
          props: JSON.stringify({
            title: "T3 Code",
            subtitle: "Working",
            activeCount: 0,
            updatedAt: "1970-01-01T00:00:00.000Z",
            activities: [],
          }),
        },
      },
    });
    expect(alert).toMatchObject({
      alpn: "h2",
      headers: {
        ":method": "POST",
        ":path": "/3/device/expired-token",
        authorization,
        "apns-priority": "10",
        "apns-push-type": "alert",
        "apns-topic": "com.t3tools.test",
      },
    });
    expect(JSON.parse(alert!.body)).toEqual({
      aps: {
        alert: { title: "Thread", body: "Input: Project" },
        sound: "default",
        "thread-id": "env/thread",
      },
      body: { environmentId: "env", threadId: "thread", deepLink: "/threads/env/thread" },
    });
  }),
);

it.live("sends a data-only Android message through the FCM provider seam", () =>
  Effect.gen(function* () {
    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      authorization: string | undefined;
      contentType: string | undefined;
      body: string;
    }> = [];
    const endpoint = yield* Effect.acquireDisposable(
      Effect.sync(() =>
        NodeHttp.createServer((request, response) => {
          readBody(request, (body) => {
            requests.push({
              method: request.method,
              path: request.url,
              authorization: request.headers.authorization,
              contentType: request.headers["content-type"],
              body,
            });
            response.setHeader("content-type", "application/json");
            if (request.url === "/token") {
              response.end('{"access_token":"stub-access-token"}');
            } else if (request.url === "/v1/projects/test-project/messages:send") {
              response.end('{"name":"projects/test-project/messages/test-message"}');
            } else {
              response.statusCode = 404;
              response.end("{}");
            }
          });
        }),
      ),
    );
    const origin = `http://${yield* Effect.promise(() => listenOnLoopback(endpoint))}`;
    const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const unused = Redacted.make("unused");
    const config = RelayConfiguration.layer({
      relayIssuer: "https://relay.test",
      apns: null,
      fcmServiceAccount: Redacted.make(
        JSON.stringify({
          project_id: "test-project",
          client_email: "push@test-project.iam.gserviceaccount.com",
          private_key: privateKey,
        }),
      ),
      clerkSecretKey: unused,
      clerkPublishableKey: "unused",
      clerkJwtAudience: "unused",
      apnsDeliveryJobSigningSecret: unused,
      cloudMintPrivateKey: unused,
      cloudMintPublicKey: "unused",
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
    });

    const result = yield* Effect.gen(function* () {
      const client = yield* FcmClient.FcmClient;
      return yield* client.send({
        token: "device-token",
        packageName: "com.t3tools.t3code.dev",
        data: { t3_kind: "agent_activity", active: "true", environmentId: "env" },
        alert: false,
      });
    }).pipe(
      Effect.provide(
        FcmClient.layer.pipe(
          Layer.provide(config),
          Layer.provide(
            FcmAssertionSigner.layer.pipe(
              Layer.provide(
                Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle }),
              ),
            ),
          ),
          Layer.provide(
            loopbackHttpLayer(origin, [
              "https://oauth2.googleapis.com/token",
              "https://fcm.googleapis.com/v1/projects/test-project/messages:send",
            ]),
          ),
        ),
      ),
    );

    expect(result).toEqual({ unregistered: false });
    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/token"],
      ["POST", "/v1/projects/test-project/messages:send"],
    ]);
    const [token, message] = requests;
    expect(token!.contentType).toMatch(/^application\/x-www-form-urlencoded(?:;|$)/);
    expect(message!.contentType).toMatch(/^application\/json(?:;|$)/);
    const grant = new URLSearchParams(token!.body);
    expect(grant.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(grant.get("assertion")).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(message!.authorization).toBe("Bearer stub-access-token");
    expect(JSON.parse(message!.body)).toEqual({
      message: {
        token: "device-token",
        data: { t3_kind: "agent_activity", active: "true", environmentId: "env" },
        android: {
          priority: "HIGH",
          ttl: "300s",
          collapse_key: "t3-agent-activity",
          restricted_package_name: "com.t3tools.t3code.dev",
        },
      },
    });
  }),
);
