import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as CryptoError from "effect/crypto/CryptoError";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import { SELF_HOSTED_RELAY_HOOK_PROOF_HEADER } from "@t3tools/contracts/selfHostedRelayHooks";
import { signSelfHostedRelayHookDelivery } from "@t3tools/shared/selfHostedRelayHookProof";
import { RELAY_HOOK_DELIVERY_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import {
  EnvironmentHttpApi,
  EnvironmentId,
  ScheduledTaskWebhookDeliveryId,
  ScheduledTaskError,
} from "@t3tools/contracts";
import {
  ScheduledTaskService,
  type WebhookTriggerRequest,
  type WebhookTriggerResult,
} from "./ScheduledTaskService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as RelayDeliveryProof from "./RelayDeliveryProof.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "./webhookRoute.ts";
import * as WebhookRoute from "./webhookRoute.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const environmentId = EnvironmentId.make("env-1");
const relayIssuer = "https://relay.example.test";
const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const relayId = SelfHostedRelayId.make("self-hosted-relay");
const selfHostedKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const linkedSecrets: ReadonlyMap<string, string> = new Map([
  [CLOUD_MINT_PUBLIC_KEY, mintKeys.publicKey],
  [RELAY_ISSUER_SECRET, relayIssuer],
]);

const relayProof = Effect.fn("relayProof")(function* (claims: {
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly hookId: string;
  readonly privateKey?: string;
}) {
  const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
  return yield* signRelayJwt({
    privateKey: claims.privateKey ?? mintKeys.privateKey,
    typ: RELAY_HOOK_DELIVERY_TYP,
    payload: {
      iss: relayIssuer,
      aud: `t3-env:${environmentId}`,
      sub: environmentId,
      jti: `proof:${claims.deliveryId}`,
      iat: now,
      exp: now + 3_600,
      environmentId,
      deliveryId: claims.deliveryId,
      receivedAt: claims.receivedAt,
      hookId: claims.hookId,
    },
  }).pipe(Effect.provide(PlatformNodeCrypto.layerSignature));
});

const handlerFor = (
  trigger: (
    request: WebhookTriggerRequest,
  ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>,
  secrets: ReadonlyMap<string, string> = linkedSecrets,
  selfHostedAuthority: (typeof RelayDeliveryProof.SelfHostedRelayHookAuthority)["Service"] = null,
  getEnvironmentId = Effect.succeed(environmentId),
  signatureLayer: Layer.Layer<Signature.Signature> = PlatformNodeCrypto.layerSignature,
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(WebhookRoute.layer),
      Layer.provide(
        RelayDeliveryProof.layer.pipe(
          Layer.provide(signatureLayer),
          Layer.provide(
            Layer.succeed(RelayDeliveryProof.SelfHostedRelayHookAuthority, selfHostedAuthority),
          ),
        ),
      ),
      Layer.provide(Layer.mock(ScheduledTaskService)({ triggerWebhook: trigger })),
      Layer.provide(
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) =>
            Effect.succeed(
              Option.map(Option.fromUndefinedOr(secrets.get(name)), (value) =>
                new TextEncoder().encode(value),
              ),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId,
        }),
      ),
      Layer.provide(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
      Layer.provide([NodeServices.layer, PlatformNodeCrypto.layer]),
    ),
    { disableLogger: true },
  );

const post = (
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => new Request(`http://env.local${path}`, { method: "POST", body, headers });

describe("webhook route", () => {
  it("rejects missing or invalid self-hosted proof without calling the task service", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      const attempts: ReadonlyArray<Record<string, string>> = [
        {},
        { [SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]: "malformed" },
      ];
      for (const headers of attempts) {
        const response = await handler(post("/api/relay-hooks/id/tok", "{}", headers));
        expect(response.status).toBe(401);
        expect(response.headers.get("x-t3-hook-outcome")).toBe("invalid_relay_proof");
        expect(await response.json()).toEqual({ error: "invalid_relay_proof" });
      }
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it.live("extracts the exact self-hosted request and admits only verified relay metadata", () =>
    Effect.gen(function* () {
      const body = new Uint8Array([255, 10, 0, 13]);
      const headers = {
        authorization: "sha256=sender-signature",
        "x-sender-signature": "sha256=exact",
        "x-sender-event-id": "event-1",
      };
      const rawTarget = "/api/relay-hooks/%69d/t%6fk?x=%2f&x=+&bare";
      const delivery = {
        relayId,
        environmentId,
        hookId: "id",
        deliveryId: "delivery-1",
        receivedAt: DateTime.formatIso(
          DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 60_000),
        ),
        method: "POST",
        rawTarget,
        body,
        headers,
        privateKey: selfHostedKeys.privateKey,
      } as const;
      const sign = (
        overrides: Partial<Parameters<typeof signSelfHostedRelayHookDelivery>[0]> = {},
      ) =>
        signSelfHostedRelayHookDelivery({ ...delivery, ...overrides }).pipe(
          Effect.provide(PlatformNodeCrypto.layer),
        );
      const proof = yield* sign();
      const received: Array<WebhookTriggerRequest> = [];
      const { handler, dispose } = handlerFor(
        (request) => {
          received.push(request);
          return Effect.succeed({
            _tag: "accepted",
            deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
            outcome: "accepted",
          });
        },
        new Map([[RELAY_URL_SECRET, "https://untrusted-address-hint.test"]]),
        { relayId, publicKey: selfHostedKeys.publicKey },
      );
      const send = ({
        target = rawTarget,
        method = "POST",
        requestHeaders = headers,
        token = proof,
      }: {
        target?: string;
        method?: string;
        requestHeaders?: Record<string, string>;
        token?: string;
      } = {}) =>
        Effect.promise(() =>
          handler(
            new Request(`http://env.local${target}`, {
              method,
              ...(method === "GET" ? {} : { body }),
              headers: { ...requestHeaders, [SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]: token },
            }),
          ),
        );
      try {
        const wronglySigned = yield* sign({ privateKey: mintKeys.privateKey });
        for (const change of [
          { target: rawTarget.replace("%69", "i") },
          { target: rawTarget.replace("%6f", "o") },
          { target: rawTarget.replace("%2f", "%2F") },
          { target: rawTarget.replace("+", "%20") },
          { token: wronglySigned },
        ]) {
          const response = yield* send(change);
          expect(response.status).toBe(401);
          expect(response.headers.get("x-t3-hook-outcome")).toBe("invalid_relay_proof");
        }
        expect(received).toHaveLength(0);
        const response = yield* send({
          requestHeaders: {
            ...headers,
            "x-unsigned-signature": "unsigned-value",
            "x-t3-relay-delivery-id": "untrusted-id",
            "x-t3-relay-received-at": "untrusted-time",
          },
        });
        expect(response.status).toBe(202);
        expect(received).toEqual([
          expect.objectContaining({
            hookId: "id",
            token: "tok",
            method: "POST",
            path: "/api/hooks/id",
            query: "x=%2f&x=+&bare",
            headers,
            body,
            relaySource: "self-hosted",
            relayIssuer: relayId,
            relayDeliveryId: delivery.deliveryId,
            receivedAt: delivery.receivedAt,
          }),
        ]);

        const direct = yield* send({ target: "/api/hooks/id/tok" });
        expect(direct.status).toBe(202);
        expect(received[1]?.relayDeliveryId).toBeUndefined();
        expect(received[1]?.relaySource).toBeUndefined();
        expect(received[1]?.headers).toEqual(expect.objectContaining(headers));
        expect(received[1]?.headers[SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]).toBeUndefined();

        const getTarget = "/api/relay-hooks/id/tok?";
        const getProof = yield* sign({
          method: "GET",
          rawTarget: getTarget,
          body: new Uint8Array(),
          deliveryId: "delivery-2",
        });
        expect((yield* send({ target: getTarget, method: "GET", token: getProof })).status).toBe(
          202,
        );
        expect(
          (yield* send({ target: getTarget.slice(0, -1), method: "GET", token: getProof })).status,
        ).toBe(401);
      } finally {
        yield* Effect.promise(() => dispose());
      }
    }),
  );

  it("reports verifier runtime defects with a retryable response", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(
      () => {
        calls += 1;
        return Effect.succeed({ _tag: "not_found" });
      },
      new Map(),
      { relayId, publicKey: selfHostedKeys.publicKey },
      Effect.die(new Error("private runtime details")),
    );
    try {
      const response = await handler(
        post("/api/relay-hooks/id/tok", "{}", { [SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]: "proof" }),
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("x-t3-hook-outcome")).toBe("error");
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it.live("reports a typed signature provider failure with a retryable response", () =>
    Effect.gen(function* () {
      const rawTarget = "/api/relay-hooks/id/tok";
      const proof = yield* signSelfHostedRelayHookDelivery({
        ...selfHostedKeys,
        relayId,
        environmentId,
        hookId: "id",
        deliveryId: "delivery-1",
        receivedAt: DateTime.formatIso(yield* DateTime.now),
        method: "POST",
        rawTarget,
        body: new TextEncoder().encode("{}"),
        headers: {},
      }).pipe(Effect.provide(PlatformNodeCrypto.layer));
      const unavailable = new CryptoError.CryptoError({
        module: "Signature",
        method: "verify",
        reason: new CryptoError.Unsupported({ description: "private provider diagnostic" }),
      });
      const signatureLayer = Layer.effect(
        Signature.Signature,
        Effect.map(Signature.Signature, (signature) => ({
          ...signature,
          verify: () => Effect.fail(unavailable),
        })),
      ).pipe(Layer.provide(PlatformNodeCrypto.layerSignature));
      let calls = 0;
      const { handler, dispose } = handlerFor(
        () => {
          calls += 1;
          return Effect.succeed({ _tag: "not_found" });
        },
        new Map(),
        { relayId, publicKey: selfHostedKeys.publicKey },
        Effect.succeed(environmentId),
        signatureLayer,
      );
      try {
        const response = yield* Effect.promise(() =>
          handler(post(rawTarget, "{}", { [SELF_HOSTED_RELAY_HOOK_PROOF_HEADER]: proof })),
        );
        expect(response.status).toBe(500);
        expect(response.headers.get("x-t3-hook-outcome")).toBe("error");
        expect(yield* Effect.promise(() => response.json())).toEqual({ error: "internal_error" });
        expect(calls).toBe(0);
      } finally {
        yield* Effect.promise(() => dispose());
      }
    }),
  );

  it.live("trusts the relay's delivery id and receive time only with its signed proof", () =>
    Effect.gen(function* () {
      const received: Array<WebhookTriggerRequest> = [];
      const { handler, dispose } = handlerFor((request) => {
        received.push(request);
        return Effect.succeed({
          _tag: "accepted",
          deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
          outcome: "accepted",
        });
      });
      const send = (path: string, headers: Record<string, string>) =>
        Effect.promise(() => handler(post(path, "{}", headers)));
      const receivedAt = "2026-10-04T10:00:00.000Z";
      const relayHeaders = {
        "x-t3-relay-delivery-id": "relay-1",
        "x-t3-relay-received-at": receivedAt,
      };
      const forged = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { format: "pem", type: "pkcs8" },
        publicKeyEncoding: { format: "pem", type: "spki" },
      });
      const proof = yield* relayProof({ deliveryId: "relay-1", receivedAt, hookId: "id" });
      const forgedProof = yield* relayProof({
        deliveryId: "relay-1",
        receivedAt,
        hookId: "id",
        privateKey: forged.privateKey,
      });
      yield* send("/api/hooks/id/tok", { ...relayHeaders, "x-t3-relay-delivery": proof });
      yield* send("/api/hooks/id/tok", relayHeaders);
      yield* send("/api/hooks/id/tok", { ...relayHeaders, "x-t3-relay-delivery": forgedProof });
      yield* send("/api/hooks/id/tok", {
        ...relayHeaders,
        "x-t3-relay-delivery-id": "relay-2",
        "x-t3-relay-delivery": proof,
      });
      yield* send("/api/hooks/other/tok", { ...relayHeaders, "x-t3-relay-delivery": proof });
      yield* Effect.promise(() => dispose());
      expect(received.map((request) => request.relayDeliveryId)).toEqual([
        "relay-1",
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(received[0]?.receivedAt).toBe(receivedAt);
      expect(received[0]?.relayIssuer).toBe(relayIssuer);
      expect(received.map((request) => request.relaySource)).toEqual([
        "hosted",
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(received.slice(1).every((request) => request.receivedAt === undefined)).toBe(true);
    }),
  );

  it.live("trusts no relay headers on an environment not linked to T3 Connect", () =>
    Effect.gen(function* () {
      const received: Array<WebhookTriggerRequest> = [];
      const { handler, dispose } = handlerFor((request) => {
        received.push(request);
        return Effect.succeed({ _tag: "not_found" });
      }, new Map());
      const receivedAt = "2026-10-04T10:00:00.000Z";
      const proof = yield* relayProof({ deliveryId: "relay-1", receivedAt, hookId: "id" });
      yield* Effect.promise(() =>
        handler(
          post("/api/hooks/id/tok", "{}", {
            "x-t3-relay-delivery-id": "relay-1",
            "x-t3-relay-received-at": receivedAt,
            "x-t3-relay-delivery": proof,
          }),
        ),
      );
      yield* Effect.promise(() => dispose());
      expect(received[0]?.relayDeliveryId).toBeUndefined();
    }),
  );

  it("maps service outcomes to status codes and names each outcome for the relay", async () => {
    const deliveryId = ScheduledTaskWebhookDeliveryId.make("delivery:1");
    const cases: ReadonlyArray<[WebhookTriggerResult, number, string]> = [
      [{ _tag: "accepted", deliveryId, outcome: "accepted" }, 202, "accepted"],
      [{ _tag: "accepted", deliveryId, outcome: "duplicate" }, 202, "duplicate"],
      [{ _tag: "accepted", deliveryId, outcome: "prompt_too_long" }, 202, "prompt_too_long"],
      [{ _tag: "accepted", deliveryId, outcome: "filtered" }, 202, "filtered"],
      [{ _tag: "not_found" }, 404, "not_found"],
      [{ _tag: "rejected_signature" }, 401, "rejected_signature"],
      [{ _tag: "disabled" }, 409, "disabled"],
      [{ _tag: "blocked_by_policy" }, 403, "blocked_by_policy"],
      [{ _tag: "rate_limited", outcome: "rate_limited" }, 429, "rate_limited"],
      [{ _tag: "rate_limited", outcome: "queue_full" }, 429, "queue_full"],
      [{ _tag: "expired" }, 410, "expired"],
    ];
    for (const [result, status, outcome] of cases) {
      const { handler, dispose } = handlerFor(() => Effect.succeed(result));
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(status);
        expect(response.headers.get("x-t3-hook-outcome")).toBe(outcome);
        if (status === 429) expect(await response.json()).toEqual({ error: outcome });
      } finally {
        await dispose();
      }
    }
  });

  it("rejects oversized bodies and malformed paths before reaching the service", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
      expect((await handler(post("/api/hooks/id/tok", big))).status).toBe(413);
      expect((await handler(post("/api/hooks/id", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/id/tok/extra", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/%E0/tok", "{}"))).status).toBe(404);
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= WEBHOOK_MAX_BODY_BYTES; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024));
          }
          controller.close();
        },
      });
      const streamed = await handler(
        new Request("http://env.local/api/hooks/id/tok", {
          method: "POST",
          body: chunked,
          // Node's fetch needs duplex for streamed bodies.
          duplex: "half",
        }),
      );
      expect(streamed.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it("refuses HEAD probes without triggering the hook", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({
        _tag: "accepted",
        deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
        outcome: "accepted",
      });
    });
    try {
      const response = await handler(
        new Request("http://env.local/api/hooks/id/tok", { method: "HEAD" }),
      );
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, POST, PUT, PATCH");
      expect(response.headers.get("x-t3-hook-outcome")).toBe("method_not_allowed");
      expect(calls).toBe(0);
      const get = await handler(new Request("http://env.local/api/hooks/id/tok"));
      expect(get.status).toBe(202);
      expect(calls).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("hides service failures and defects behind a fixed 500", async () => {
    const failures = [
      Effect.fail(new ScheduledTaskError({ message: "database locked" })),
      Effect.die(new Error("database exploded")),
    ];
    for (const failure of failures) {
      const { handler, dispose } = handlerFor(() => failure);
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error" });
      } finally {
        await dispose();
      }
    }
  });
});
