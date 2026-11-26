// @effect-diagnostics nodeBuiltinImport:off -- The private control listener binds publisher lifetimes to HTTPS connections.
import * as NodeEvents from "node:events";
import type * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeStream from "node:stream";
import { SelfHostedRelayRevokeEnvironmentInput } from "@t3tools/contracts/selfHostedRelay";
import {
  encodeSelfHostedRelayPublisherControlFrame,
  SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER,
  type SelfHostedRelayPublisherControlFrame,
} from "@t3tools/contracts/selfHostedRelayForwarding";
import { RelayForwarding, type RelayForwardingBinding } from "@t3tools/relay-core/RelayForwarding";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  SelfHostedRelayConfigError,
  type SelfHostedRelayForwardingConfig,
} from "./SelfHostedRelayForwardingConfig.ts";
import {
  authorityStatus,
  bearerHeader,
  http1Options,
  listenHttps,
  oneExchange,
  originAdmission,
  sendStatus,
} from "./SelfHostedRelayIngress.ts";

const publisherPath = /^\/api\/self-hosted-relay\/v1\/tunnel\/publisher\/([^/?]+)$/u;
const isEnvironmentId = Schema.is(SelfHostedRelayRevokeEnvironmentInput.fields.environmentId);

function parseEnvironmentId(segment: string) {
  try {
    const id = decodeURIComponent(segment);
    if (isEnvironmentId(id) && id === id.trim() && encodeURIComponent(id) === segment) return id;
  } catch {
    return undefined;
  }
}

const writeFrame = Effect.fn("SelfHostedRelayPublisherHttp.writeFrame")(function* (
  response: NodeHttp.ServerResponse,
  status: SelfHostedRelayPublisherControlFrame["status"],
) {
  yield* Effect.callback<void, "closed">((resume) => {
    if (response.destroyed || response.writableEnded) return resume(Effect.fail("closed"));
    response.write(encodeSelfHostedRelayPublisherControlFrame({ version: 1, status }), (error) =>
      resume(error ? Effect.fail("closed") : Effect.void),
    );
  }).pipe(Effect.timeout("2 seconds"));
});

const leaseAborted = (signal: AbortSignal) =>
  Effect.callback<never, "closed">((resume) => {
    const close = () => resume(Effect.fail("closed"));
    if (signal.aborted) return close();
    const listener = NodeEvents.EventEmitter.addAbortListener(signal, close);
    return Effect.sync(() => listener[Symbol.dispose]());
  });

export const start = Effect.fn("SelfHostedRelayPublisherHttp.start")(function* (
  config: SelfHostedRelayForwardingConfig["control"],
  bindings: readonly RelayForwardingBinding[],
  onReady: Effect.Effect<void> = Effect.void,
) {
  const forwarding = yield* RelayForwarding;
  const scope = yield* Effect.scope;
  const run = Effect.runForkWith(yield* Effect.context<never>());
  const origin = new URL(config.origin);
  const byEnvironment = new Map(bindings.map((binding) => [binding.environmentId, binding]));
  const server = yield* Effect.try({
    try: () =>
      NodeHttps.createServer({
        ...http1Options,
        cert: config.cert,
        key: config.key,
        minVersion: "TLSv1.3",
      }),
    catch: () => new SelfHostedRelayConfigError(),
  });
  const begin = oneExchange();
  const handle = (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const exchange = { kind: "http", request, response } as const;
    if (!begin(exchange)) return;
    const invalid = authorityStatus(request, origin);
    if (invalid !== undefined) return sendStatus(exchange, invalid);

    const segment = publisherPath.exec(request.url ?? "")?.[1];
    if (segment === undefined) return sendStatus(exchange, 404);
    if (request.method !== "POST") return sendStatus(exchange, 405, { allow: "POST" });
    const environmentId = parseEnvironmentId(segment);
    if (
      environmentId === undefined ||
      request.headers["transfer-encoding"] !== undefined ||
      request.headers.expect !== undefined ||
      (request.headers["content-length"] ?? "0") !== "0" ||
      request.headers["proxy-authorization"] !== undefined
    ) {
      return sendStatus(exchange, 400);
    }
    const credential = bearerHeader(request, "authorization");
    if (typeof credential === "number") return sendStatus(exchange, credential);
    const binding = byEnvironment.get(environmentId);
    const pins = request.headersDistinct[SELF_HOSTED_RELAY_PUBLISHER_FINGERPRINT_HEADER];
    if (
      binding === undefined ||
      pins?.length !== 1 ||
      !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(pins[0] ?? "") ||
      pins[0] !== binding.environmentFingerprint
    ) {
      return sendStatus(exchange, 403);
    }

    const closed = Effect.callback<void>((resume) => {
      const onClose = () => resume(Effect.void);
      if (response.destroyed || request.socket.destroyed) return onClose();
      response.once("close", onClose);
      return Effect.sync(() => response.off("close", onClose));
    });
    const publish = Effect.gen(function* () {
      const started = yield* Effect.gen(function* () {
        const lease = yield* forwarding.openPublisher(credential, environmentId);
        if (lease.signal.aborted || response.destroyed || request.socket.destroyed) {
          return yield* Effect.fail("closed" as const);
        }
        response.writeHead(200, {
          "content-type": "application/x-ndjson",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          connection: "close",
        });
        yield* Effect.raceFirst(
          Effect.gen(function* () {
            yield* writeFrame(response, "accepted");
            yield* lease.ready;
            yield* writeFrame(response, "ready");
          }),
          leaseAborted(lease.signal),
        );
        return lease;
      }).pipe(Effect.timeout("12 seconds"));
      yield* onReady;
      yield* Effect.logInfo("Self-hosted relay publisher ready");
      return yield* Effect.raceFirst(
        Effect.sleep("5 seconds").pipe(
          Effect.andThen(writeFrame(response, "heartbeat")),
          Effect.forever,
        ),
        leaseAborted(started.signal),
      );
    }).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Effect.sync(() => {
          if (error === "closed") return sendStatus(exchange, 503);
          switch (error._tag) {
            case "RelayAuthenticationError":
              return sendStatus(exchange, 401);
            case "RelayAccessDeniedError":
              return sendStatus(exchange, 403);
            case "RelayInputError":
              return sendStatus(exchange, 400);
            case "RelayForwardingUnavailableError":
              if (error.reason === "publisher-active") return sendStatus(exchange, 409);
              if (originAdmission(binding) === "retired") return sendStatus(exchange, 403);
              return sendStatus(exchange, 503);
            default:
              return sendStatus(exchange, 503);
          }
        }),
      ),
    );
    run(
      Effect.raceFirst(publish, closed).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!response.writableEnded) response.destroy();
          }),
        ),
        Effect.forkIn(scope),
      ),
    );
  };
  const rejectUpgrade = (
    request: NodeHttp.IncomingMessage,
    socket: NodeStream.Duplex,
    head: Buffer,
  ) => {
    const exchange = { kind: "upgrade", request, socket, head } as const;
    if (begin(exchange)) sendStatus(exchange, authorityStatus(request, origin) ?? 404);
  };
  server.on("request", handle);
  server.on("checkContinue", handle);
  server.on("checkExpectation", handle);
  server.on("upgrade", rejectUpgrade);
  server.on("connect", rejectUpgrade);
  yield* listenHttps(server, config.listen);
});
