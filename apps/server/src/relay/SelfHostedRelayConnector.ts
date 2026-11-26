// @effect-diagnostics nodeBuiltinImport:off -- The connector owns its pinned HTTPS request and unlistened HTTP parser.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeTls from "node:tls";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  decodeSelfHostedRelayPublisherControlFrame,
  SELF_HOSTED_RELAY_PUBLISHER_CONTROL_MAX_FRAME_BYTES,
  SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER,
} from "@t3tools/contracts/selfHostedRelayForwarding";
import { connectStaticRelayTunnel } from "@t3tools/relay-core/RelayTunnelTransport";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import { bindDirectRelayProof } from "../requestUrl.ts";
import * as ServerActivation from "../serverActivation.ts";
import type { SelfHostedRelayConnectorConfig } from "./SelfHostedRelayForwardingConfig.ts";

export class SelfHostedRelayHookBaseUrl extends Context.Reference<string | null>(
  "t3/relay/SelfHostedRelayHookBaseUrl",
  { defaultValue: () => null },
) {}

const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

export class SelfHostedRelayConnectorError extends Schema.TaggedError<
  SelfHostedRelayConnectorError,
  { readonly brand: unique symbol }
>()("SelfHostedRelayConnectorError", {
  reason: Schema.Literals([
    "configuration",
    "conflicting_configuration",
    "control_tls",
    "tunnel_tls",
    "control_status",
    "control_protocol",
    "control_unavailable",
  ]),
}) {
  override get message(): string {
    return this.reason === "conflicting_configuration"
      ? "T3CODE_RELAY_CONNECTOR_CONFIG and T3CODE_STATIC_RELAY_PROOF_CONFIG cannot be combined."
      : `Self-hosted relay connector failed (${this.reason}).`;
  }
}

const connectPublisher = Effect.fn("SelfHostedRelayConnector.connectPublisher")(function* (
  config: SelfHostedRelayConnectorConfig,
  backend: NodeHttp.Server,
) {
  const ready = yield* Deferred.make<void>();
  let nextHeartbeat = Deferred.makeUnsafe<void>();
  const watchdog = Deferred.await(ready).pipe(
    Effect.timeout("15 seconds"),
    Effect.andThen(
      Effect.suspend(() => Deferred.await(nextHeartbeat)).pipe(
        Effect.timeout("20 seconds"),
        Effect.forever,
      ),
    ),
    Effect.mapError(() => new SelfHostedRelayConnectorError({ reason: "control_unavailable" })),
  );
  const exchange = Effect.callback<never, SelfHostedRelayConnectorError>((resume) => {
    let request: NodeHttp.ClientRequest | undefined;
    let response: NodeHttp.IncomingMessage | undefined;
    let tunnel: ReturnType<typeof connectStaticRelayTunnel> | undefined;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      tunnel?.close();
      response?.destroy();
      request?.destroy();
    };
    const fail = (reason: SelfHostedRelayConnectorError["reason"]) => {
      if (closed) return;
      close();
      resume(Effect.fail(new SelfHostedRelayConnectorError({ reason })));
    };
    const frame = Buffer.alloc(SELF_HOSTED_RELAY_PUBLISHER_CONTROL_MAX_FRAME_BYTES);
    let buffered = 0;
    let expected: "accepted" | "ready" | "heartbeat" = "accepted";
    const read = (chunk: Buffer) => {
      if (closed) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(0x0a, offset);
        const end = newline === -1 ? chunk.length : newline;
        const length = end - offset;
        if (buffered + length > frame.length) {
          fail("control_protocol");
          return;
        }
        chunk.copy(frame, buffered, offset, end);
        buffered += length;
        if (newline === -1) return;
        offset = newline + 1;

        const decoded = decodeSelfHostedRelayPublisherControlFrame(frame.subarray(0, buffered));
        buffered = 0;
        if (decoded?.status !== expected) {
          fail("control_protocol");
          return;
        }
        if (expected === "accepted") {
          expected = "ready";
          try {
            tunnel = connectStaticRelayTunnel({
              relay: config.relay,
              relayFingerprint: config.relayFingerprint,
              publicOrigin: config.publicOrigin,
              canonicalOrigin: config.canonicalOrigin,
              backend,
              onIdentityRejected: () => fail("tunnel_tls"),
            });
          } catch {
            fail("configuration");
            return;
          }
        } else if (expected === "ready") {
          expected = "heartbeat";
          Deferred.doneUnsafe(ready, Effect.void);
        } else {
          const received = nextHeartbeat;
          nextHeartbeat = Deferred.makeUnsafe<void>();
          Deferred.doneUnsafe(received, Effect.void);
        }
      }
    };

    const onResponse = (reply: NodeHttp.IncomingMessage) => {
      response = reply;
      reply.on("error", () => fail("control_unavailable"));
      reply.once("close", () => fail("control_unavailable"));
      const status = reply.statusCode ?? 0;
      if (status !== 200) {
        fail(status === 409 || status >= 500 ? "control_unavailable" : "control_status");
        return;
      }
      if (reply.headers["content-type"]?.split(";")[0]?.trim() !== "application/x-ndjson") {
        fail("control_protocol");
        return;
      }
      reply.on("data", read);
    };

    const pinError = new Error("Publisher control certificate fingerprint mismatch");
    try {
      request = NodeHttps.request(
        new URL(config.controlOrigin),
        {
          agent: false,
          ca: config.controlCa,
          rejectUnauthorized: true,
          minVersion: "TLSv1.3",
          checkServerIdentity: (host, cert) =>
            NodeTls.checkServerIdentity(host, cert) ??
            (cert.fingerprint256 === config.controlFingerprint ? undefined : pinError),
          method: "POST",
          path: `/api/self-hosted-relay/v1/tunnel/publisher/${encodeURIComponent(config.environmentId)}`,
          headers: {
            authorization: `Bearer ${config.publisherCredential}`,
            [SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER]: new NodeCrypto.X509Certificate(
              config.relay.cert,
            ).fingerprint256,
            "content-length": "0",
          },
        },
        onResponse,
      );
      request.once("upgrade", (_reply, socket) => {
        socket.destroy();
        fail("control_status");
      });
      request.once("error", (error) => {
        const socket = request?.socket;
        const code: unknown = Reflect.get(error, "code");
        fail(
          error === pinError ||
            (socket instanceof NodeTls.TLSSocket && socket.authorizationError != null) ||
            (typeof code === "string" && /^(?:ERR_SSL_|ERR_TLS_)/u.test(code))
            ? "control_tls"
            : "control_unavailable",
        );
      });
      request.end();
    } catch {
      fail("configuration");
    }

    return Effect.sync(close);
  });
  return yield* Effect.raceFirst(exchange, watchdog);
});

export const start = Effect.fn("SelfHostedRelayConnector.start")(function* (
  server: NodeHttp.Server,
  config: SelfHostedRelayConnectorConfig,
  input: { readonly host: string; readonly environmentId: EnvironmentId },
) {
  if (
    (input.host !== "127.0.0.1" && input.host !== "::1") ||
    config.environmentId !== input.environmentId ||
    config.environmentId === "." ||
    config.environmentId === ".."
  ) {
    return yield* new SelfHostedRelayConnectorError({ reason: "configuration" });
  }

  yield* Effect.acquireRelease(
    Effect.sync(() =>
      bindDirectRelayProof(server, config.canonicalOrigin, config.directTerminatorToken),
    ),
    (unbind) => Effect.sync(unbind),
  );

  // Hook exchanges add a signed envelope after the public listener has bounded sender headers.
  const backend = NodeHttp.createServer({ maxHeaderSize: 34 * 1024 }, (request, response) => {
    server.emit("request", request, response);
  });
  backend.on("checkContinue", (request, response) => {
    server.emit("checkContinue", request, response);
  });
  backend.on("upgrade", (request, socket, head) => {
    server.emit("upgrade", request, socket, head);
  });

  return yield* ServerActivation.forkParkedFiber(
    connectPublisher(config, backend).pipe(
      Effect.retry({
        schedule: retrySchedule,
        while: (error) => error.reason === "control_unavailable",
      }),
      Effect.tapError((error) => Effect.logWarning(error.message)),
    ),
  );
});
