// @effect-diagnostics nodeBuiltinImport:off -- The hook-only listener owns Node's TLS and HTTP parser.
import * as NodeHttps from "node:https";
import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import {
  isSelfHostedRelayHookApplicationHeader,
  SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES,
  SelfHostedRelayHookMethod,
  SelfHostedRelayHookRawTarget,
  SelfHostedRelayHookTarget,
} from "@t3tools/contracts/selfHostedRelayHooks";
import * as Ingress from "@t3tools/relay-core/RelayHookIngress";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  SelfHostedRelayConfigError,
  type SelfHostedRelayForwardingConfig,
} from "./SelfHostedRelayForwardingConfig.ts";
import {
  authorityStatus,
  http1Options,
  listenHttps,
  oneExchange,
  sendStatus,
} from "./SelfHostedRelayIngress.ts";

const matchPublicHook = /^\/api\/hooks\/([^/?]+)\/([^/?]+)\/([^/?]+)(\?.*)?$/u;
const isHookTarget = Schema.is(SelfHostedRelayHookTarget);
const isRawTarget = Schema.is(SelfHostedRelayHookRawTarget);
const isHookMethod = Schema.is(SelfHostedRelayHookMethod);
const encodeResponse = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      outcome: Schema.String,
      deliveryId: Schema.optionalKey(Schema.String),
    }),
  ),
);

function hookTarget(raw: string) {
  const match = matchPublicHook.exec(raw);
  if (match === null) return undefined;
  const [, environment, hook, token, query = ""] = match;
  try {
    const target = {
      environmentId: decodeURIComponent(environment!),
      hookId: decodeURIComponent(hook!),
    };
    const rawTarget = `/api/relay-hooks/${hook}/${token}${query}`;
    const decodedToken = decodeURIComponent(token!);
    if (
      !isHookTarget(target) ||
      !isRawTarget(rawTarget) ||
      decodedToken.length === 0 ||
      decodedToken.length > 256
    )
      return undefined;
    return { ...target, rawTarget };
  } catch {
    return undefined;
  }
}

function applicationHeaders(request: NodeHttp.IncomingMessage): Record<string, string> {
  const nominated = new Set(
    request.headers.connection
      ?.toLowerCase()
      .split(",")
      .map((part) => part.trim()),
  );
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      typeof value === "string" &&
      !nominated.has(name) &&
      isSelfHostedRelayHookApplicationHeader(name)
        ? [[name, value]]
        : [],
    ),
  );
}

const readBody = Effect.fn("SelfHostedRelayHookIngress.readBody")(function* (
  request: NodeHttp.IncomingMessage,
) {
  return yield* Effect.callback<Buffer, 400 | 413>((resume) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off("data", read);
      request.off("end", end);
      request.off("error", fail);
      request.off("close", fail);
    };
    const read = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES) {
        request.pause();
        cleanup();
        return resume(Effect.fail(413));
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resume(Effect.succeed(Buffer.concat(chunks, bytes)));
    };
    const fail = () => {
      cleanup();
      resume(Effect.fail(400));
    };
    if (request.destroyed) return fail();
    request.on("data", read);
    request.once("end", end);
    request.once("error", fail);
    request.once("close", fail);
    return Effect.sync(() => {
      request.pause();
      cleanup();
    });
  }).pipe(
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(408 as const) }),
  );
});

export const start = Effect.fn("SelfHostedRelayHookIngress.start")(function* (
  config: NonNullable<SelfHostedRelayForwardingConfig["hookIngress"]>,
  notify: Effect.Effect<void>,
) {
  const ingress = yield* Ingress.RelayHookIngress;
  const scope = yield* Effect.scope;
  const run = Effect.runForkWith(yield* Effect.context<never>());
  const origin = new URL(config.origin);
  const server = yield* Effect.try({
    try: () =>
      NodeHttps.createServer({
        ...http1Options,
        cert: config.cert,
        key: config.key,
        minVersion: "TLSv1.3",
        requestTimeout: 15_000,
      }),
    catch: () => new SelfHostedRelayConfigError(),
  });
  server.maxConnections = 128;
  const begin = oneExchange();
  const handle = (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
    expectContinue: boolean,
  ) => {
    const exchange = { kind: "http", request, response } as const;
    if (!begin(exchange)) return;
    const invalid = authorityStatus(request, origin);
    if (invalid !== undefined) return sendStatus(exchange, invalid);
    const target = hookTarget(request.url ?? "");
    if (target === undefined) return sendStatus(exchange, 404);
    const method = request.method;
    if (!isHookMethod(method)) return sendStatus(exchange, 405, { allow: "GET, POST, PUT, PATCH" });
    if (Number(request.headers["content-length"] ?? 0) > SELF_HOSTED_RELAY_HOOK_MAX_BODY_BYTES) {
      return sendStatus(exchange, 413);
    }
    if (expectContinue) response.writeContinue();

    run(
      Effect.gen(function* () {
        const body = yield* readBody(request);
        const result = yield* ingress.receive({
          ...target,
          method,
          headers: applicationHeaders(request),
          body,
        });
        if ("deliveryId" in result && result.kind !== "retry") yield* notify;
        const retryAfter = "retryAfter" in result ? result.retryAfter : undefined;
        const payload = {
          outcome: result.kind,
          ...("deliveryId" in result ? { deliveryId: result.deliveryId } : {}),
        };
        yield* Effect.sync(() =>
          sendStatus(
            exchange,
            result.status,
            {
              "content-type": "application/json",
              "x-content-type-options": "nosniff",
              "x-t3-hook-outcome": result.kind,
              ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
            },
            encodeResponse(payload),
          ),
        );
      }).pipe(
        Effect.catch((status) => Effect.sync(() => sendStatus(exchange, status))),
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
  const rejectExpectation = (
    request: NodeHttp.IncomingMessage,
    response: NodeHttp.ServerResponse,
  ) => {
    const exchange = { kind: "http", request, response } as const;
    if (begin(exchange)) sendStatus(exchange, authorityStatus(request, origin) ?? 417);
  };
  server.on("upgrade", rejectUpgrade);
  server.on("connect", rejectUpgrade);
  server.on("request", (request, response) => handle(request, response, false));
  server.on("checkContinue", (request, response) => handle(request, response, true));
  server.on("checkExpectation", rejectExpectation);
  yield* listenHttps(server, config.listen);
});
