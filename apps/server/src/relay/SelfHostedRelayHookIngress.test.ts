// @effect-diagnostics nodeBuiltinImport:off -- The integration fixture owns real TLS sockets and an isolated relay database.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeWS from "@effect/platform-node/NodeWS";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProviderInstanceId,
  ScheduledTaskWebhookDeliveryId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { SELF_HOSTED_RELAY_HOOK_PROOF_HEADER } from "@t3tools/contracts/selfHostedRelayHooks";
import * as Runtime from "@t3tools/relay-core/RelayRuntime";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { fetch } from "undici";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RelayDeliveryProof from "../scheduledTasks/RelayDeliveryProof.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as WebhookRoute from "../scheduledTasks/webhookRoute.ts";
import { openProofRequest, serveLoopback } from "./fixtures/p1bIngress.testkit.ts";
import {
  initializeRelayHomeOriginRegistry,
  openRelayHomeOriginRegistry,
} from "./RelayOriginRegistry.ts";
import * as Application from "./SelfHostedRelayApplication.ts";
import * as Connector from "./SelfHostedRelayConnector.ts";
import { loadSelfHostedRelayConnectorConfig } from "./SelfHostedRelayForwardingConfig.ts";

class WebhookApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const host = "127.0.0.1";
const environmentId = EnvironmentId.make("hook-environment");
const canonicalOrigin = "https://hook-environment.example";
const rawQuery = "?value=+&value=%20&slash=%2f";
const rawBody = Buffer.of(0, 255, 13, 10, 128);
const signature = (bytes: Uint8Array) =>
  NodeCrypto.createHmac("sha256", "sender-fixture-secret").update(bytes).digest("hex");

const publicIngress = "/api/hooks/" + environmentId;
const policyPath = "/api/self-hosted-relay/v1/hooks/" + environmentId;
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeHeld = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ deliveryId: Schema.String })),
);

function sendHook(
  port: number,
  path: string,
  body: Buffer = rawBody,
  method = "PATCH",
  headers: Readonly<Record<string, string>> = {},
) {
  return new Promise<{
    status: number | undefined;
    headers: NodeHttp.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const request = openProofRequest(`https://${host}:${port}`, {
      method,
      path,
      headers: {
        host: `localhost:${port}`,
        "content-type": "application/octet-stream",
        "content-length": body.byteLength,
        "x-sender-signature": signature(body),
        authorization: "sender-only",
        [SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]: "untrusted-sender-proof",
        ...headers,
      },
    });
    request.on("error", reject);
    request.on("response", (response) => {
      let result = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        result += chunk;
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({ status: response.statusCode, headers: response.headers, body: result }),
      );
    });
    request.end(body);
  });
}

const availablePorts = Effect.scoped(
  Effect.forEach([0, 1, 2, 3, 4], () =>
    serveLoopback(NodeHttp.createServer()).pipe(
      Effect.map((origin) => Number(new URL(origin).port)),
    ),
  ),
);

const fixture = Effect.fn("SelfHostedRelayHookTest.fixture")(function* () {
  const files = yield* FileSystem.FileSystem;
  const directory = yield* files.makeTempDirectoryScoped({ prefix: "t3-hook-tls-" });
  const homeDirectory = `${directory}/relay`;
  const [ingressPort, controlPort, tunnelPort, hookPort, embeddedPort] = yield* availablePorts;
  const publicOrigin = `https://localhost:${ingressPort!}`;
  const controlOrigin = `https://localhost:${controlPort!}`;
  const hookOrigin = `https://localhost:${hookPort!}`;
  const listen = (port: number) => ({ host, port });
  const keys = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const relayCert = NodeFS.readFileSync(
    new URL("../peer/fixtures/localhost-cert.pem", import.meta.url),
  );
  const relayKey = NodeFS.readFileSync(
    new URL("../peer/fixtures/localhost-key.pem", import.meta.url),
  );
  const publisherCert = NodeFS.readFileSync(
    new URL("./fixtures/p1b-ingress-client-cert.pem", import.meta.url),
  );
  const publisherKey = NodeFS.readFileSync(
    new URL("./fixtures/p1b-ingress-client-key.pem", import.meta.url),
  );
  const relayFingerprint = new NodeCrypto.X509Certificate(relayCert).fingerprint256;
  const environmentFingerprint = new NodeCrypto.X509Certificate(publisherCert).fingerprint256;
  const { owner, publisher, forwarder, relayId } = yield* Effect.gen(function* () {
    const relay = yield* Runtime.RelayRuntime;
    const owner = yield* relay.bootstrapOwner();
    yield* relay.enrollEnvironment(owner.credential, {
      version: 1,
      environmentId,
      name: environmentId,
    });
    const publisherInvite = yield* relay.issuePairing(owner.credential, {
      version: 1,
      expiresAt: "2099-01-01T00:00:00Z",
      subject: { kind: "publisher", environmentId },
      scope: {
        permissions: ["environment.tunnel"],
        environments: { kind: "selected", environmentIds: [environmentId] },
      },
    });
    const forwarderInvite = yield* relay.issuePairing(owner.credential, {
      version: 1,
      expiresAt: "2099-01-01T00:00:00Z",
      subject: { kind: "client" },
      scope: {
        permissions: ["forward"],
        environments: { kind: "selected", environmentIds: [environmentId] },
      },
    });
    return {
      owner,
      publisher: yield* relay.redeemPairing(publisherInvite.credential),
      forwarder: yield* relay.redeemPairing(forwarderInvite.credential),
      relayId: (yield* relay.localStatus()).relayId,
    };
  }).pipe(Effect.provide(Runtime.relayRuntimeLayer({ homeDirectory })));
  yield* Effect.sync(() => {
    initializeRelayHomeOriginRegistry(homeDirectory);
    using registry = openRelayHomeOriginRegistry(homeDirectory);
    registry?.register(publicOrigin, environmentId);
  });
  const pair = { certPath: "relay-cert.pem", keyPath: "relay-key.pem" };
  const forwardingConfigPath = `${directory}/forwarding.json`;
  yield* files.writeFileString(
    forwardingConfigPath,
    encode({
      version: 1,
      ingress: {
        listen: listen(ingressPort!),
        certificates: [{ ...pair, serverNames: ["localhost"] }],
      },
      control: { ...pair, listen: listen(controlPort!), origin: controlOrigin },
      hookIngress: {
        ...pair,
        listen: listen(hookPort!),
        origin: hookOrigin,
        signingKeyPath: "hook-key.pem",
      },
      bindings: [
        {
          environmentId,
          publicOrigin,
          canonicalOrigin,
          environmentFingerprint,
          tunnelListen: listen(tunnelPort!),
          tunnelCaPath: "publisher-cert.pem",
          tunnelCertPath: pair.certPath,
          tunnelKeyPath: pair.keyPath,
        },
      ],
    }),
  );
  const connectorPath = `${directory}/connector.json`;
  yield* files.writeFileString(
    connectorPath,
    encode({
      version: 1,
      environmentId,
      publicOrigin,
      canonicalOrigin,
      controlOrigin,
      controlCaPath: pair.certPath,
      controlFingerprint: relayFingerprint,
      publisherCredentialPath: "publisher-credential",
      relayHost: host,
      relayPort: tunnelPort,
      relayServername: "localhost",
      relayFingerprint,
      caPath: pair.certPath,
      certPath: "publisher-cert.pem",
      keyPath: "publisher-key.pem",
      hookAuthority: { relayId, publicKeyPath: "hook-public.pem", hookOrigin },
    }),
  );
  yield* files.writeFile(`${directory}/relay-cert.pem`, relayCert);
  yield* files.writeFile(`${directory}/relay-key.pem`, relayKey, { mode: 0o600 });
  yield* files.writeFile(`${directory}/publisher-cert.pem`, publisherCert);
  yield* files.writeFile(`${directory}/publisher-key.pem`, publisherKey, { mode: 0o600 });
  yield* files.writeFileString(`${directory}/hook-key.pem`, keys.privateKey, { mode: 0o600 });
  yield* files.writeFileString(`${directory}/hook-public.pem`, keys.publicKey);
  yield* files.writeFileString(`${directory}/publisher-credential`, publisher.credential, {
    mode: 0o600,
  });

  const testClock = yield* TestClock.make({ warningDelay: "30 seconds" });
  yield* testClock.setTime(yield* Clock.currentTimeMillis);
  const start = Effect.fn("SelfHostedRelayHookTest.start")(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const publisherReady = yield* Deferred.make<void>();
    let managementOrigin: string | undefined;
    const logger = Logger.make(({ message }) => {
      const line = String(message);
      managementOrigin ??= /Self-hosted relay listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(
        line,
      )?.[1];
      if (line.includes("Self-hosted relay publisher ready"))
        Deferred.doneUnsafe(publisherReady, Effect.void);
    });
    yield* Layer.buildWithScope(
      Application.layer({ homeDirectory, port: 0, forwardingConfigPath }).pipe(
        Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Layer.provide(Layer.succeed(Clock.Clock, testClock)),
      ),
      scope,
    );
    assert.isDefined(managementOrigin);
    const setPolicy = (
      hookId: string,
      enabled: boolean,
      holdEnabled: boolean,
      credential = owner.credential,
    ) =>
      Effect.promise((signal) =>
        fetch(`${managementOrigin}${policyPath}/${encodeURIComponent(hookId)}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: encode({ version: 1, environmentId, hookId, enabled, holdEnabled }),
          signal,
        }),
      );
    return { setPolicy, publisherReady, stop: Scope.close(scope, Exit.void) };
  });

  return {
    start,
    directory,
    forwardingConfigPath,
    connectorPath,
    ownerCredential: owner.credential,
    hookPort: hookPort!,
    homeDirectory,
    embeddedPort: embeddedPort!,
    relayId,
    connector: yield* loadSelfHostedRelayConnectorConfig(connectorPath, environmentId),
    forwardCredential: forwarder.credential,
    testClock,
    receivedAt: DateTime.formatIso(
      yield* DateTime.now.pipe(Effect.provideService(Clock.Clock, testClock)),
    ),
  };
});

const destination = Effect.fn("SelfHostedRelayHookTest.destination")(function* (
  connector: Effect.Success<ReturnType<typeof fixture>>["connector"],
  receive: (
    input: ScheduledTaskService.WebhookTriggerRequest,
  ) => Effect.Effect<ScheduledTaskService.WebhookTriggerResult>,
) {
  const http = yield* HttpRouter.toHttpEffect(
    HttpApiBuilder.layer(WebhookApi).pipe(
      Layer.provide(WebhookRoute.layer),
      Layer.provide(
        RelayDeliveryProof.layer.pipe(
          Layer.provide(
            Layer.succeed(
              RelayDeliveryProof.SelfHostedRelayHookAuthority,
              connector.hookAuthority ?? null,
            ),
          ),
          Layer.provide(NodePlatformCrypto.layer),
        ),
      ),
      Layer.provide(
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({ triggerWebhook: receive }),
      ),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    ),
  );
  const scope = yield* Effect.scope;
  const handler = yield* NodeHttpServer.makeHandler(http, { scope });
  const server = NodeHttp.createServer((request, response) => {
    if (request.url?.startsWith("/api/relay-hooks/rate/")) response.setHeader("retry-after", "17");
    handler(request, response);
  });
  yield* Connector.start(server, connector, { host, environmentId });
  return server;
});

const rawHook = (id: string, token: string, suffix = "") =>
  `${publicIngress}/${id}/${token}${suffix}`;

const probeListener = (port: number, path: string) =>
  Effect.promise(() =>
    sendHook(port, path).then(
      () => "listening",
      () => "closed",
    ),
  );

it.live("restores acknowledged holds through the pinned publisher with exact request bytes", () =>
  Effect.gen(function* () {
    const setup = yield* fixture();
    const original = yield* setup.start();
    for (const id of ["signed:hook", "rotated", "expired"]) {
      assert.equal((yield* original.setPolicy(id, true, true)).status, 200);
    }
    assert.equal(
      (yield* original.setPolicy("rate", true, false, setup.forwardCredential)).status,
      403,
    );
    assert.equal((yield* original.setPolicy("rate", true, false)).status, 200);

    const send = (path: string, body?: Buffer, method?: string) =>
      Effect.promise(() => sendHook(setup.hookPort, path, body, method));
    for (const path of [
      "/",
      "/ws",
      "/api/status",
      "/api/mcp",
      "/api/auth/pair",
      policyPath + "/rate",
      "/api/self-hosted-relay/v1/tunnel/publisher/" + environmentId,
      "/api/relay-hooks/signed/token",
    ]) {
      assert.equal((yield* send(path, Buffer.alloc(0), "GET")).status, 404);
    }
    assert.equal((yield* send(rawHook("unknown", "key"))).headers["x-t3-hook-outcome"], "disabled");
    const offlineNoHold = yield* send(rawHook("rate", "key"));
    assert.equal(offlineNoHold.status, 503);
    assert.equal(offlineNoHold.headers["x-t3-hook-outcome"], "retry");

    const protectedTarget = rawHook("signed%3ahook", "key%2b", rawQuery);
    const held = yield* send(protectedTarget);
    const rotated = yield* send(rawHook("rotated", "old", "?"));
    const expired = yield* send(rawHook("expired", "key"));
    for (const reply of [held, rotated, expired]) {
      assert.equal(reply.status, 202);
      assert.equal(reply.headers["x-t3-hook-outcome"], "held");
    }
    const { deliveryId: heldId } = yield* decodeHeld(held.body);
    const { deliveryId: rotatedId } = yield* decodeHeld(rotated.body);
    const { deliveryId: expiredId } = yield* decodeHeld(expired.body);
    yield* original.stop;
    assert.equal(yield* probeListener(setup.hookPort, protectedTarget), "closed");
    yield* Effect.sync(() => {
      using db = new NodeSqlite.DatabaseSync(`${setup.homeDirectory}/relay.sqlite`);
      const saved = db
        .prepare(
          "SELECT delivery_id, raw_target, body FROM relay_hook_deliveries WHERE kind = 'held'",
        )
        .all();
      assert.lengthOf(saved, 3);
      assert.equal(
        saved.find((row) => row.delivery_id === heldId)?.raw_target,
        "/api/relay-hooks/signed%3ahook/key%2b" + rawQuery,
      );
      db.prepare(
        "UPDATE relay_hook_deliveries SET received_at = received_at - ? WHERE delivery_id = ?",
      ).run(25 * 60 * 60 * 1_000, expiredId);
    });

    const restarted = yield* setup.start();
    const attempts = yield* Queue.unbounded<ScheduledTaskService.WebhookTriggerRequest>();
    const stalled = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    yield* destination(setup.connector, (input) =>
      input.hookId === "stall"
        ? Deferred.succeed(stalled, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
          )
        : Queue.offer(attempts, input).pipe(
            Effect.as(
              input.hookId === "rotated"
                ? { _tag: "not_found" }
                : input.hookId === "rate"
                  ? { _tag: "rate_limited", outcome: "rate_limited" }
                  : input.token === "key+" &&
                      input.headers["x-sender-signature"] === signature(input.body)
                    ? {
                        _tag: "accepted",
                        deliveryId: ScheduledTaskWebhookDeliveryId.make("logical-delivery"),
                        outcome: "accepted",
                      }
                    : { _tag: "rejected_signature" },
            ),
          ),
    );
    yield* Deferred.await(restarted.publisherReady);
    const rate = yield* send(rawHook("rate", "key"));
    assert.equal(rate.status, 429);
    assert.equal(rate.headers["retry-after"], "17");
    assert.equal(rate.headers["x-t3-hook-outcome"], "retry");
    assert.equal((yield* Queue.take(attempts)).hookId, "rate");
    yield* setup.testClock.adjust("10 seconds");
    const byId = new Map([
      yield* Queue.take(attempts).pipe(Effect.map((input) => [input.hookId, input] as const)),
      yield* Queue.take(attempts).pipe(Effect.map((input) => [input.hookId, input] as const)),
    ]);
    assert.equal(byId.get("signed:hook")?.relayDeliveryId, heldId);
    assert.equal(byId.get("signed:hook")?.relayIssuer, setup.relayId);
    assert.equal(byId.get("signed:hook")?.receivedAt, setup.receivedAt);
    assert.equal(byId.get("signed:hook")?.method, "PATCH");
    assert.equal(byId.get("signed:hook")?.query, rawQuery.slice(1));
    assert.equal(byId.get("signed:hook")?.token, "key+");
    assert.equal(byId.get("signed:hook")?.headers.authorization, "sender-only");
    assert.equal(byId.get("signed:hook")?.headers[SELF_HOSTED_RELAY_HOOK_PROOF_HEADER], undefined);
    assert.deepEqual(byId.get("signed:hook")?.body, new Uint8Array(rawBody));
    assert.equal(byId.get("rotated")?.relayDeliveryId, rotatedId);
    assert.equal(byId.get("rotated")?.token, "old");
    assert.equal(byId.has("expired"), false);

    assert.equal((yield* restarted.setPolicy("stall", true, true)).status, 200);
    const inFlight = yield* send(rawHook("stall", "key")).pipe(Effect.forkScoped);
    yield* Deferred.await(stalled);
    assert.equal((yield* restarted.setPolicy("stall", false, false)).status, 200);
    yield* Deferred.await(cancelled);
    assert.equal((yield* Fiber.join(inFlight)).headers["x-t3-hook-outcome"], "disabled");
    assert.equal((yield* send(rawHook("stall", "key"))).status, 404);
    yield* restarted.stop;
    yield* Effect.sync(() => {
      using db = new NodeSqlite.DatabaseSync(`${setup.homeDirectory}/relay.sqlite`, {
        readOnly: true,
      });
      const outcome = db.prepare(
        "SELECT kind, status, body FROM relay_hook_deliveries WHERE delivery_id = ?",
      );
      assert.deepEqual(outcome.get(heldId), { kind: "admitted", status: 202, body: null });
      assert.deepEqual(outcome.get(rotatedId), { kind: "rejected", status: 404, body: null });
      assert.deepEqual(outcome.get(expiredId), { kind: "rejected", status: 410, body: null });
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("returns explicit non-acceptance when the durable hold is full or its commit fails", () =>
  Effect.gen(function* () {
    const setup = yield* fixture();
    const original = yield* setup.start();
    for (const hook of ["full", "fault"]) {
      assert.equal((yield* original.setPolicy(hook, true, true)).status, 200);
    }
    const held = yield* Effect.promise(() => sendHook(setup.hookPort, rawHook("full", "key")));
    assert.equal(held.status, 202);
    const { deliveryId } = yield* decodeHeld(held.body);
    yield* original.stop;
    yield* Effect.sync(() => {
      using db = new NodeSqlite.DatabaseSync(`${setup.homeDirectory}/relay.sqlite`);
      db.prepare(`
        WITH RECURSIVE available(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM available WHERE n < 99)
        INSERT INTO relay_hook_deliveries
          (relay_id, delivery_id, environment_id, hook_id, received_at, kind, status,
           due_at, revision, method, raw_target, headers, body, charge)
        SELECT relay_id, 'fixture-' || n, environment_id, hook_id, received_at, kind, status,
          due_at, revision, method, raw_target, headers, body, charge
        FROM relay_hook_deliveries CROSS JOIN available WHERE delivery_id = ?
      `).run(deliveryId);
      db.exec(`
        CREATE TRIGGER fixture_hold_write_failure BEFORE INSERT ON relay_hook_deliveries
        WHEN NEW.hook_id = 'fault'
        BEGIN SELECT RAISE(ABORT, 'fixture hold write failure'); END
      `);
    });
    yield* setup.start();
    for (const [id, outcome] of [
      ["full", "capacity"],
      ["fault", "storage"],
    ] as const) {
      const reply = yield* Effect.promise(() => sendHook(setup.hookPort, rawHook(id, "key")));
      assert.equal(reply.status, 503);
      assert.equal(reply.headers["x-t3-hook-outcome"], outcome);
      assert.equal(reply.body, encode({ outcome }));
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

const loseFirstRelayReply = `
import { Server } from "node:http";
const emit = Server.prototype.emit;
const wrapped = new WeakSet();
let droppedAcceptedReply = false;
let droppedBeforeAdmission = false;
Server.prototype.emit = function (event, ...args) {
  const [request, response] = args;
  if (event === "request" &&
      request.url?.startsWith("/api/relay-hooks/") &&
      !wrapped.has(response)) {
    wrapped.add(response);
    const id = request.headers["x-p5-event-id"];
    if (id === "rotated-1" && !droppedBeforeAdmission) {
      droppedBeforeAdmission = true;
      response.destroy();
      return true;
    }
    const end = response.end;
    response.end = function (...parameters) {
      if (id === "relay-1" && this.statusCode === 202) {
        if (!droppedAcceptedReply) {
          droppedAcceptedReply = true;
          this.destroy();
          return this;
        }
        process.stdout.write("P5 relay delivery answered again\\n");
      }
      if (id === "rotated-1" && this.statusCode === 404) {
        process.stdout.write("P5 rotated token rejected\\n");
      }
      return end.apply(this, parameters);
    };
  }
  return emit.call(this, event, ...args);
};
`;

const makeClient = RpcClient.make(WsRpcGroup);
const replayInstanceId = ProviderInstanceId.make("hookReplay");

const proveEmbeddedAdmission = Effect.fn("SelfHostedRelayHookTest.proveEmbeddedAdmission")(
  function* (
    setup: Effect.Success<ReturnType<typeof fixture>>,
    managementOrigin: string,
    bootstrapToken: string,
    retried: Deferred.Deferred<void>,
    rejected: Deferred.Deferred<void>,
  ) {
    const origin = `http://${host}:${setup.embeddedPort}`;
    const session = yield* Effect.promise((signal) =>
      fetch(`${origin}/api/auth/browser-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: encode({ credential: bootstrapToken }),
        signal,
      }),
    );
    assert.equal(session.status, 200);
    const cookie = session.headers.getSetCookie()[0]?.split(";", 1)[0];
    assert.isDefined(cookie);
    const socketUrl = new URL(`ws://${host}:${setup.embeddedPort}/ws`);
    socketUrl.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      String(ORCHESTRATION_PROTOCOL_VERSION),
    );
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(
          Socket.layerWebSocket(socketUrl.href, {
            headers: { cookie: cookie! },
          }).pipe(Layer.provide(NodeWS.layerWebSocketConstructor)),
        ),
      ),
    );
    const client = yield* makeClient.pipe(Effect.provideContext(protocol));
    const { projectId } = yield* client[WS_METHODS.projectsCreateNew]({ name: "Relay hooks" });
    const { task } = yield* client[WS_METHODS.scheduledTasksUpsert]({
      title: "Signed relay hook",
      prompt: "A signed webhook arrived.",
      enabled: true,
      schedule: {
        type: "webhook",
        relayEnabled: true,
        signature: {
          header: "Authorization",
          encoding: "hex",
          prefix: "",
          secret: "sender-fixture-secret",
        },
        dedupe: { replayKey: "{{headers.x-p5-event-id}}" },
      },
      projectId,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: replayInstanceId, model: "showcase" },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    assert.isDefined(task.webhook?.relayUrl);
    const publicUrl = new URL(task.webhook!.relayUrl!);
    assert.equal(publicUrl.origin, `https://localhost:${setup.hookPort}`);
    assert.isTrue(
      publicUrl.pathname.startsWith(`${publicIngress}/${encodeURIComponent(task.id)}/`),
    );
    const policy = yield* Effect.promise((signal) =>
      fetch(`${managementOrigin}${policyPath}/${encodeURIComponent(task.id)}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${setup.ownerCredential}`,
          "content-type": "application/json",
        },
        body: encode({
          version: 1,
          environmentId,
          hookId: task.id,
          enabled: true,
          holdEnabled: true,
        }),
        signal,
      }),
    );
    assert.equal(policy.status, 200);

    const signedHeaders = (eventId: string) => ({
      "content-type": "application/octet-stream",
      authorization: signature(rawBody),
      "x-p5-event-id": eventId,
    });
    const sendDirect = (eventId: string, path: string) =>
      Effect.promise((signal) =>
        fetch(origin + path + rawQuery, {
          method: "PATCH",
          headers: signedHeaders(eventId),
          body: rawBody,
          signal,
        }),
      );
    const direct = yield* sendDirect("direct-1", task.webhook!.path);
    assert.equal(direct.status, 202);
    assert.equal(direct.headers.get("x-t3-hook-outcome"), "accepted");
    const hold = (eventId: string) =>
      Effect.promise(() =>
        sendHook(
          setup.hookPort,
          publicUrl.pathname + rawQuery,
          rawBody,
          "PATCH",
          signedHeaders(eventId),
        ),
      ).pipe(
        Effect.flatMap((held) => {
          assert.equal(held.status, 202);
          assert.equal(held.headers["x-t3-hook-outcome"], "held");
          return decodeHeld(held.body);
        }),
      );
    const { deliveryId } = yield* hold("relay-1");
    const { deliveryId: rejectedId } = yield* hold("rotated-1");
    const rotation = yield* client[WS_METHODS.scheduledTasksRotateWebhookToken]({ id: task.id });
    assert.notEqual(rotation.task.webhook?.path, task.webhook!.path);
    yield* Effect.all([Deferred.await(retried), Deferred.await(rejected)], {
      concurrency: "unbounded",
    });
    const duplicate = yield* sendDirect("relay-1", rotation.task.webhook!.path);
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.headers.get("x-t3-hook-outcome"), "duplicate");
    yield* client[WS_METHODS.scheduledTasksSubscribe]({}).pipe(
      Stream.filter((list) =>
        list.tasks.some((entry) => entry.id === task.id && entry.runCount === 2),
      ),
      Stream.runHead,
    );
    return { taskId: task.id, deliveryId, rejectedId };
  },
);

const checkEmbeddedReceipts = (
  setup: Effect.Success<ReturnType<typeof fixture>>,
  evidence: Effect.Success<ReturnType<typeof proveEmbeddedAdmission>>,
) =>
  Effect.sync(() => {
    using state = new NodeSqlite.DatabaseSync(`${setup.directory}/userdata/statev2.sqlite`, {
      readOnly: true,
    });
    const commands = state
      .prepare(`
    SELECT command_id FROM orchestration_command_receipts
    WHERE command_id LIKE 'scheduled-task:%' AND command_type = 'thread.create' AND status = 'accepted'
  `)
      .all();
    assert.lengthOf(commands, 2);
    assert.lengthOf(
      state.prepare("SELECT 1 FROM orchestration_events WHERE event_type = 'run.created'").all(),
      2,
    );
    const receipt = state
      .prepare(`
    SELECT relay_issuer, relay_delivery_id, result_json, work_delivery_id
    FROM scheduled_task_webhook_relay_receipts
  `)
      .all();
    assert.lengthOf(receipt, 2);
    const admitted = receipt.find((row) => row.relay_delivery_id === evidence.deliveryId);
    assert.equal(admitted?.relay_issuer, `self-hosted:${setup.relayId}`);
    assert.equal(
      admitted?.result_json,
      encode({
        _tag: "accepted",
        deliveryId: admitted?.work_delivery_id,
        outcome: "accepted",
      }),
    );
    assert.deepEqual(
      receipt.find((row) => row.relay_delivery_id === evidence.rejectedId),
      {
        relay_issuer: `self-hosted:${setup.relayId}`,
        relay_delivery_id: evidence.rejectedId,
        result_json: encode({ _tag: "not_found" }),
        work_delivery_id: null,
      },
    );
    const accepted = state
      .prepare(`
    SELECT method, query, body_bytes, signature_verified
    FROM scheduled_task_webhook_deliveries WHERE task_id = ? AND outcome = 'accepted'
  `)
      .all(evidence.taskId);
    assert.deepEqual(
      accepted,
      Array.from({ length: 2 }, () => ({
        method: "PATCH",
        query: rawQuery.slice(1),
        body_bytes: rawBody.length,
        signature_verified: 1,
      })),
    );
    using relay = new NodeSqlite.DatabaseSync(`${setup.homeDirectory}/relay.sqlite`, {
      readOnly: true,
    });
    const getOutcome = relay.prepare(`
    SELECT kind, status, body FROM relay_hook_deliveries WHERE delivery_id = ?
  `);
    assert.deepEqual(getOutcome.get(evidence.deliveryId), {
      kind: "admitted",
      status: 202,
      body: null,
    });
    assert.deepEqual(getOutcome.get(evidence.rejectedId), {
      kind: "rejected",
      status: 404,
      body: null,
    });
  });

it.live.each(["standalone", "embedded"] as const)(
  "scopes the public hook listener to the %s CLI",
  (mode) =>
    Effect.gen(function* () {
      const setup = yield* fixture();
      if (mode === "embedded") {
        const files = yield* FileSystem.FileSystem;
        yield* files.makeDirectory(`${setup.directory}/userdata`);
        yield* files.writeFileString(`${setup.directory}/userdata/environment-id`, environmentId);
        yield* files.writeFileString(
          `${setup.directory}/userdata/settings.json`,
          encode({
            providerInstances: {
              [replayInstanceId]: {
                displayName: "Replay hook fixture",
                driver: "acpRegistry",
                config: {
                  source: "local",
                  commandPath: process.execPath,
                  commandArgs: [
                    NodeURL.fileURLToPath(
                      new URL("../../scripts/dev-replay-agent.ts", import.meta.url),
                    ),
                  ],
                },
              },
            },
          }),
        );
      }
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const entry = yield* Config.String("T3_TEST_SERVER_ENTRY").pipe(
        Config.withDefault(NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url))),
      );
      assert.isTrue(NodePath.isAbsolute(entry), "T3_TEST_SERVER_ENTRY must be absolute");
      const standalone = [
        entry,
        "relay",
        "serve",
        "--home-dir",
        setup.homeDirectory,
        "--forwarding-config",
        setup.forwardingConfigPath,
      ];
      const embedded = [
        "--import",
        `data:text/javascript,${encodeURIComponent(loseFirstRelayReply)}`,
        entry,
        "serve",
        "--base-dir",
        setup.directory,
        "--host",
        host,
        "--port",
        String(setup.embeddedPort),
        "--relay",
        "--relay-port",
        "0",
      ];
      const child = yield* spawner.spawn(
        ChildProcess.make(process.execPath, mode === "standalone" ? standalone : embedded, {
          env: {
            T3CODE_HOME: setup.directory,
            T3CODE_RELAY_FORWARDING_CONFIG: setup.forwardingConfigPath,
            ...(mode === "embedded" ? { T3CODE_RELAY_CONNECTOR_CONFIG: setup.connectorPath } : {}),
          },
        }),
      );
      const listening = yield* Deferred.make<string>();
      const publisherReady = yield* Deferred.make<void>();
      const bootstrap = yield* Deferred.make<string>();
      const retried = yield* Deferred.make<void>();
      const rejected = yield* Deferred.make<void>();
      const logs = yield* child.all.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.tap((line) => {
          const origin = /Self-hosted relay listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(
            line,
          )?.[1];
          if (origin !== undefined) return Deferred.succeed(listening, origin);
          if (line.includes("Self-hosted relay publisher ready"))
            return Deferred.succeed(publisherReady, undefined);
          const token = /^Token:\s+(\S+)/.exec(line)?.[1];
          if (token !== undefined) return Deferred.succeed(bootstrap, token);
          if (line === "P5 relay delivery answered again")
            return Deferred.succeed(retried, undefined);
          if (line === "P5 rotated token rejected") return Deferred.succeed(rejected, undefined);
          return Effect.void;
        }),
        Stream.filter((line) => !/^(?:Token|Pairing URL|App link):/u.test(line)),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const managementOrigin = yield* Effect.raceFirst(
        Deferred.await(listening),
        Fiber.join(logs).pipe(
          Effect.flatMap((lines) =>
            Effect.die(new Error(`Relay exited before listening: ${lines.slice(-12).join("\n")}`)),
          ),
        ),
      );
      const target = rawHook("unknown", "key");
      const reply = yield* Effect.promise(() => sendHook(setup.hookPort, target));
      assert.equal(reply.status, 404);
      assert.equal(reply.headers["x-t3-hook-outcome"], "disabled");
      let evidence: Effect.Success<ReturnType<typeof proveEmbeddedAdmission>> | undefined;
      if (mode === "embedded") {
        yield* Deferred.await(publisherReady);
        evidence = yield* proveEmbeddedAdmission(
          setup,
          managementOrigin,
          yield* Deferred.await(bootstrap),
          retried,
          rejected,
        );
      }
      yield* child.kill();
      yield* Effect.ignore(child.exitCode);
      assert.equal(yield* probeListener(setup.hookPort, target), "closed");
      if (evidence !== undefined) yield* checkEmbeddedReceipts(setup, evidence);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("refuses an origin already reserved by the durable authority for hook ingress", () =>
  Effect.gen(function* () {
    const setup = yield* fixture();
    yield* Effect.sync(() => {
      using registry = openRelayHomeOriginRegistry(setup.homeDirectory);
      assert.isDefined(registry);
      const origin = `https://localhost:${setup.hookPort}`;
      registry!.register(origin, environmentId);
      registry!.retire(origin, environmentId);
    });
    const failure = yield* Effect.result(setup.start());
    assert.equal(failure._tag, "Failure");
    assert.equal(yield* probeListener(setup.hookPort, "/"), "closed");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("rejects permanently unsignable requests without accepting an offline hold", () =>
  Effect.gen(function* () {
    const setup = yield* fixture();
    const relay = yield* setup.start();
    assert.equal((yield* relay.setPolicy("large-proof", true, true)).status, 200);
    const headers = Object.fromEntries(
      Array.from({ length: 180 }, (_, index) => [`x-sender-${index}-${"a".repeat(65)}`, "v"]),
    );
    const result = yield* Effect.promise(() =>
      sendHook(setup.hookPort, rawHook("large-proof", "token"), rawBody, "PATCH", headers),
    );
    assert.equal(result.status, 400);
    assert.equal(result.headers["x-t3-hook-outcome"], "rejected");
  }).pipe(Effect.provide(NodeServices.layer)),
);
