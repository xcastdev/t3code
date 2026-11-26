// @effect-diagnostics nodeBuiltinImport:off -- The ingress validates Node's actual TLS socket and owns the HTTPS listener.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import {
  RELAY_ADMISSION_ACTIVE,
  RELAY_ADMISSION_HEADER,
  RELAY_ADMISSION_PATH,
  RELAY_ADMISSION_RETIRED,
} from "@t3tools/contracts/relay";
import {
  RELAY_BROWSER_TICKETS_PATH,
  RELAY_HOSTED_SESSION_HEADER,
  RELAY_HOSTED_SESSION_PATH,
  RELAY_HOSTED_SESSION_REQUIRED,
  RELAY_HOSTED_WS_PROTOCOL,
  RELAY_HOSTED_WS_PROTOCOL_PREFIX,
  type RelayHostedSessionResponse,
  type RelayHostedTicketResponse,
} from "@t3tools/contracts/selfHostedRelayHosted";
import {
  RelayForwarding,
  type RelayForwardingBinding,
  type RelayForwardingExchange,
} from "@t3tools/relay-core/RelayForwarding";
import {
  hostedCorsHeaders,
  RELAY_BROWSER_COOKIE,
  type RelayHostedForwardingPolicy,
} from "@t3tools/relay-core/RelayTunnelTransport";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { RELAY_MEDIA_DOWNLOAD_HEADER } from "@t3tools/shared/relayMediaDownload";

import {
  HANDLE,
  SESSION_SECONDS,
  SelfHostedRelayBrowserAdmission,
} from "./SelfHostedRelayBrowserAdmission.ts";
import {
  parseRelayJson,
  SelfHostedRelayConfigError,
  type SelfHostedRelayForwardingConfig,
  type SelfHostedRelayListen,
} from "./SelfHostedRelayForwardingConfig.ts";

export const http1Options = {
  ALPNProtocols: ["http/1.1"],
  maxHeaderSize: 16 * 1024,
  headersTimeout: 10_000,
  handshakeTimeout: 10_000,
  connectionsCheckingInterval: 1_000,
};

export const listenHttps = Effect.fn("SelfHostedRelay.listenHttps")(function* (
  server: NodeHttps.Server,
  listen: SelfHostedRelayListen,
) {
  server.maxHeadersCount = 0;
  const sockets = new Set<NodeStream.Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        }),
    ),
  );
  yield* Effect.tryPromise({
    try: async (signal) => {
      server.listen(listen);
      await NodeEvents.EventEmitter.once(server, "listening", { signal });
    },
    catch: () => new SelfHostedRelayConfigError(),
  });
});

function tlsServerName(request: NodeHttp.IncomingMessage): string | undefined {
  if (!(request.socket instanceof NodeTls.TLSSocket)) return undefined;
  const serverName = request.socket.servername;
  return typeof serverName === "string" ? serverName : undefined;
}

export function authorityStatus(
  request: NodeHttp.IncomingMessage,
  origin: URL,
): 400 | 421 | undefined {
  // Match P1's origin-form and authority checks before looking at any admission state.
  if (request.httpVersion !== "1.1" || !/^\/(?!\/)[^\\#]*$/u.test(request.url ?? "")) return 400;
  const hosts = request.headersDistinct.host;
  if (
    tlsServerName(request) !== origin.hostname ||
    hosts?.length !== 1 ||
    hosts[0]?.toLowerCase() !== origin.host
  ) {
    return 421;
  }
  return undefined;
}

export function bearerHeader(
  request: NodeHttp.IncomingMessage,
  name: "authorization" | "proxy-authorization",
): string | 400 | 401 {
  const values = request.headersDistinct[name];
  if (values === undefined) return 401;
  const [value] = values;
  if (values.length !== 1 || value?.includes(",")) return 400;
  return /^Bearer ([^\s,]{1,512})$/iu.exec(value ?? "")?.[1] ?? 401;
}

export function sendStatus(
  exchange: RelayForwardingExchange,
  status: number,
  headers: NodeHttp.OutgoingHttpHeaders = {},
  body?: string,
): void {
  if (exchange.kind === "upgrade") {
    if (!exchange.socket.destroyed && !exchange.socket.writableEnded) {
      exchange.socket.end(
        `HTTP/1.1 ${status} ${NodeHttp.STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n` +
          Object.entries(headers)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join("") +
          "\r\n",
        () => exchange.socket.destroy(),
      );
    }
    return;
  }
  const { response } = exchange;
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) response.destroy();
  else
    response
      .writeHead(status, { "cache-control": "no-store", connection: "close", ...headers })
      .end(body);
}

export function oneExchange() {
  const used = new WeakSet<NodeNet.Socket>();
  return (exchange: RelayForwardingExchange): boolean => {
    const { socket } = exchange.request;
    if (used.has(socket) || socket.destroyed) {
      socket.destroy();
      return false;
    }
    used.add(socket);
    if (exchange.kind === "upgrade") exchange.socket.pause();
    else exchange.response.shouldKeepAlive = false;
    return true;
  };
}

export function originAdmission(binding: RelayForwardingBinding) {
  try {
    return binding.admission?.() ?? "unknown";
  } catch {
    return "unavailable";
  }
}

const inactiveStatus = { retired: 410, unknown: 404, unavailable: 503 } as const;

const browserPath = "/.well-known/t3/relay-browser";
const sessionPath = `${browserPath}/session`;
const browserHeaders = {
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
};
const bootstrapScript = `
(async () => {
  const ticket = location.hash.slice(1);
  // Give a fresh ticket URL a different document address, even if this POST fails.
  history.replaceState(null, "", "${sessionPath}?bootstrap");
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error();
  const response = await fetch("${sessionPath}", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: ticket,
    mode: "same-origin",
    credentials: "same-origin",
    // Keep the POST Origin while omitting Referer.
    referrerPolicy: "same-origin",
    referrer: "",
    redirect: "error"
  });
  if (response.status !== 204) throw new Error();
  location.replace("/");
})().catch(() => { document.body.textContent = "Relay admission failed."; });
`;
const bootstrapHash = NodeCrypto.createHash("sha256").update(bootstrapScript).digest("base64");
const bootstrapPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="color-scheme" content="dark"><title>Relay admission</title><body><script>${bootstrapScript}</script></body></html>`;

const isBrowserPath = (path: string) => path === browserPath || path.startsWith(`${browserPath}/`);

function reservesBrowserPath(path: string, origin: URL) {
  if (isBrowserPath(path)) return true;
  if (!path.includes("relay-browser") && !path.includes("%")) return false;
  if (isBrowserPath(new URL(path, origin).pathname)) return true;
  try {
    return isBrowserPath(new URL(decodeURIComponent(path), origin).pathname);
  } catch {
    return false;
  }
}

function relayCookie(request: NodeHttp.IncomingMessage): string | 400 | undefined {
  const fields = request.headersDistinct.cookie;
  if (!fields?.some((field) => field.includes(RELAY_BROWSER_COOKIE))) return undefined;
  const relayFields = fields.flatMap((field) =>
    field.split(/[;,]/u).filter((pair) => pair.split("=", 1)[0]?.trim() === RELAY_BROWSER_COOKIE),
  );
  if (relayFields.length === 0) return undefined;
  if (fields.length !== 1 || fields[0]?.includes(",") || relayFields.length !== 1) return 400;
  const pair = relayFields[0]?.trim();
  if (!pair?.startsWith(`${RELAY_BROWSER_COOKIE}=`)) return 400;
  const handle = pair.slice(RELAY_BROWSER_COOKIE.length + 1);
  return HANDLE.test(handle) ? handle : 400;
}

function browserRequestStatus(
  exchange: RelayForwardingExchange,
  origin: URL,
): 400 | 403 | undefined {
  const { request } = exchange;
  const origins = request.headersDistinct.origin ?? [];
  const sites = request.headersDistinct["sec-fetch-site"] ?? [];
  const modes = request.headersDistinct["sec-fetch-mode"] ?? [];
  const destinations = request.headersDistinct["sec-fetch-dest"] ?? [];
  if (
    [origins, sites, modes, destinations].some(
      (values) => values.length > 1 || values[0]?.includes(","),
    )
  )
    return 400;

  const upgrade = exchange.kind === "upgrade";
  const safe = !upgrade && (request.method === "GET" || request.method === "HEAD");
  if ((!safe || origins.length > 0) && origins[0] !== origin.origin) return 403;
  if (
    upgrade &&
    ((modes[0] !== undefined && modes[0] !== "websocket") ||
      (destinations[0] !== undefined && destinations[0] !== "empty"))
  )
    return 403;
  const site = sites[0];
  if (site === undefined || site === "same-origin") return undefined;
  if (safe && site === "none" && modes[0] === "navigate" && destinations[0] === "document")
    return undefined;
  return 403;
}

function emptyRequest(request: NodeHttp.IncomingMessage): boolean {
  const contentLength = request.headersDistinct["content-length"];
  return (
    request.headersDistinct["transfer-encoding"] === undefined &&
    (contentLength === undefined || (contentLength.length === 1 && contentLength[0] === "0"))
  );
}

const httpToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const hasFetchMetadata = (request: NodeHttp.IncomingMessage) =>
  Object.keys(request.headersDistinct).some((name) => name.startsWith("sec-fetch-"));

function hostedOrigin(
  request: NodeHttp.IncomingMessage,
  binding: RelayForwardingBinding,
): string | undefined {
  const origins = request.headersDistinct.origin;
  const origin = origins?.[0];
  return origins?.length === 1 &&
    origin !== undefined &&
    binding.hostedClientOrigins?.includes(origin)
    ? origin
    : undefined;
}

function hostedRequestStatus(
  exchange: RelayForwardingExchange,
  clientOrigin: string | undefined,
  alias: URL,
): 400 | 403 | undefined {
  const { headersDistinct: headers } = exchange.request;
  const values = [
    headers.origin,
    headers["sec-fetch-site"],
    headers["sec-fetch-mode"],
    headers["sec-fetch-dest"],
    headers["sec-fetch-user"],
  ];
  if (values.some((field) => field && (field.length !== 1 || field[0]?.includes(",")))) return 400;
  if (clientOrigin === undefined) return 403;
  const [, site, mode, destination, user] = values.map((field) => field?.[0]);
  const expectedMode = exchange.kind === "upgrade" ? "websocket" : "cors";
  if (
    (mode !== undefined && mode !== expectedMode) ||
    (destination !== undefined && destination !== "empty") ||
    user !== undefined ||
    (site !== undefined &&
      (clientOrigin === alias.origin
        ? site !== "same-origin"
        : site !== "same-site" && site !== "cross-site"))
  )
    return 403;
  return undefined;
}

const forwardingMethods = new Set(["GET", "HEAD", "POST"]);
const forwardingHeaders = new Set([
  RELAY_HOSTED_SESSION_HEADER,
  ORCHESTRATION_PROTOCOL_HEADER,
  "authorization",
  "content-type",
  "dpop",
  "range",
  "if-range",
  RELAY_MEDIA_DOWNLOAD_HEADER,
  "b3",
  "traceparent",
]);
const bootstrapHeaders = new Set(["content-type"]);
const bootstrapMethods = new Set(["POST"]);
const probeMethods = new Set(["HEAD"]);
const noHeaders = new Set<string>();
const preflightVary = "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";

function preflight(
  exchange: RelayForwardingExchange,
  methods: ReadonlySet<string>,
  allowedHeaders: ReadonlySet<string>,
  cors: NodeHttp.OutgoingHttpHeaders,
): void {
  const { request } = exchange;
  const { headersDistinct: headers } = request;
  const respond = (status: number, extra: NodeHttp.OutgoingHttpHeaders = {}) =>
    sendStatus(exchange, status, { ...cors, ...extra });
  if (
    exchange.kind !== "http" ||
    !emptyRequest(request) ||
    headers["proxy-authorization"] !== undefined ||
    headers.authorization !== undefined ||
    headers.dpop !== undefined ||
    headers.cookie !== undefined ||
    headers[RELAY_HOSTED_SESSION_HEADER] !== undefined ||
    headers["sec-websocket-protocol"] !== undefined
  )
    return respond(400);
  const requestedMethod = headers["access-control-request-method"];
  const requestedHeaders = headers["access-control-request-headers"];
  const method = requestedMethod?.[0] ?? "";
  const names =
    requestedHeaders?.[0]
      ?.toLowerCase()
      .split(",")
      .map((name) => name.trim()) ?? [];
  if (
    requestedMethod?.length !== 1 ||
    !httpToken.test(method) ||
    (requestedHeaders?.length ?? 0) > 1 ||
    names.some((name) => !httpToken.test(name)) ||
    new Set(names).size !== names.length
  )
    return respond(400);
  if (!methods.has(method) || names.some((name) => !allowedHeaders.has(name))) return respond(403);
  respond(204, {
    "access-control-allow-methods": method,
    ...(names.length === 0 ? {} : { "access-control-allow-headers": names.join(", ") }),
  });
}

const isReservedProtocol = (protocol: string) =>
  protocol.toLowerCase().startsWith(RELAY_HOSTED_WS_PROTOCOL_PREFIX);

function hostedUpgrade(protocols: ReadonlyArray<string>) {
  let version = false;
  let handle: string | undefined;
  const applicationProtocols: string[] = [];
  for (const protocol of protocols) {
    if (!httpToken.test(protocol)) return undefined;
    if (protocol === RELAY_HOSTED_WS_PROTOCOL && !version) {
      version = true;
    } else if (isReservedProtocol(protocol)) {
      const candidate = protocol.slice(RELAY_HOSTED_WS_PROTOCOL_PREFIX.length);
      if (
        handle !== undefined ||
        !protocol.startsWith(RELAY_HOSTED_WS_PROTOCOL_PREFIX) ||
        !HANDLE.test(candidate)
      )
        return undefined;
      handle = candidate;
    } else {
      applicationProtocols.push(protocol);
    }
  }
  if (
    !version ||
    handle === undefined ||
    new Set(applicationProtocols).size !== applicationProtocols.length
  ) {
    return undefined;
  }
  return { handle, applicationProtocols };
}

const readBody = Effect.fn("SelfHostedRelayIngress.readBody")(function* (
  request: NodeHttp.IncomingMessage,
  maxBytes: number,
) {
  return yield* Effect.callback<Buffer, 400>((resume) => {
    if (request.destroyed) return resume(Effect.fail(400));
    const chunks: Buffer[] = [];
    let bytes = 0;
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cleanup();
        request.pause();
        return resume(Effect.fail(400));
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resume(Effect.succeed(Buffer.concat(chunks, bytes)));
    };
    const close = () => {
      cleanup();
      resume(Effect.fail(400));
    };
    const cleanup = () => {
      request.off("data", data).off("end", end).off("close", close);
    };
    request.on("data", data).once("end", end).once("close", close);
    return Effect.sync(cleanup);
  }).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.fail(408 as const) }));
});

const readTicket = Effect.fn("SelfHostedRelayIngress.readTicket")(function* (
  request: NodeHttp.IncomingMessage,
) {
  const length = request.headersDistinct["content-length"];
  const contentType = request.headersDistinct["content-type"];
  if (
    request.headersDistinct["transfer-encoding"] !== undefined ||
    length?.length !== 1 ||
    length[0] !== "43" ||
    contentType?.length !== 1 ||
    !/^text\/plain(?:; charset=utf-8)?$/iu.test(contentType[0] ?? "")
  )
    return yield* Effect.fail(400 as const);
  const ticket = (yield* readBody(request, 43)).toString();
  if (!HANDLE.test(ticket)) return yield* Effect.fail(400 as const);
  return ticket;
});

const readHostedField = Effect.fn("SelfHostedRelayIngress.readHostedField")(function* (
  request: NodeHttp.IncomingMessage,
  field: "clientOrigin" | "ticket",
) {
  const maxBytes = 1024;
  const headers = request.headersDistinct;
  const type = headers["content-type"];
  const length = headers["content-length"];
  if (
    type?.length !== 1 ||
    !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(type[0] ?? "") ||
    (length !== undefined && (length.length !== 1 || Number(length[0]) > maxBytes)) ||
    emptyRequest(request)
  )
    return yield* Effect.fail(400 as const);

  const bytes = yield* readBody(request, maxBytes);
  return yield* Effect.try({
    try: () => {
      const value = parseRelayJson(bytes);
      if (
        value === null ||
        typeof value !== "object" ||
        Object.keys(value).length !== 1 ||
        !Object.hasOwn(value, field)
      )
        throw new Error();
      const item: unknown = Reflect.get(value, field);
      if (typeof item !== "string") throw new Error();
      return item;
    },
    catch: () => 400 as const,
  });
});

export const start = Effect.fn("SelfHostedRelayIngress.start")(function* (
  config: SelfHostedRelayForwardingConfig["ingress"],
  bindings: readonly RelayForwardingBinding[],
) {
  const forwarding = yield* RelayForwarding;
  const browser = yield* SelfHostedRelayBrowserAdmission;
  const scope = yield* Effect.scope;
  const run = Effect.runForkWith(yield* Effect.context<never>());
  const byName = new Map(
    bindings.map((binding) => [new URL(binding.publicOrigin).hostname, binding]),
  );
  const server = yield* Effect.try({
    try: () => {
      const contexts = new Map<string, NodeTls.SecureContext>();
      for (const certificate of config.certificates) {
        const context = NodeTls.createSecureContext(certificate);
        for (const name of certificate.serverNames) contexts.set(name, context);
      }
      return NodeHttps.createServer({
        ...http1Options,
        ...config.certificates[0],
        SNICallback: (name, callback) => callback(null, contexts.get(name)),
      });
    },
    catch: () => new SelfHostedRelayConfigError(),
  });
  const begin = oneExchange();
  const runBrowserRequest = (
    response: NodeHttp.ServerResponse,
    admission: (signal: AbortSignal) => Effect.Effect<void>,
  ) => {
    if (response.destroyed || response.socket?.destroyed) return;
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    response.once("close", disconnected);
    Fiber.runIn(
      run(
        admission(controller.signal).pipe(
          Effect.ensuring(Effect.sync(() => response.off("close", disconnected))),
        ),
        { signal: controller.signal },
      ),
      scope,
    );
  };
  const dispatch = (exchange: RelayForwardingExchange, unsupported?: number) => {
    if (!begin(exchange)) return;
    const { request } = exchange;
    const serverName = tlsServerName(request);
    const binding = byName.get(serverName ?? "");
    const authority = request.headers.host?.toLowerCase();
    const origin = URL.parse(binding?.publicOrigin ?? `https://${authority ?? ""}`);
    if (origin === null || Number(origin.port || 443) !== config.listen.port) {
      return sendStatus(exchange, 421);
    }
    const invalid = authorityStatus(request, origin);
    if (invalid !== undefined) return sendStatus(exchange, invalid);
    if (unsupported !== undefined) return sendStatus(exchange, unsupported);
    if (binding === undefined) return sendStatus(exchange, 404);

    const path = request.url?.split("?", 1)[0];
    const clientOrigin = hostedOrigin(request, binding);
    const isPreflight =
      request.method === "OPTIONS" &&
      (request.headersDistinct["access-control-request-method"] !== undefined ||
        request.headersDistinct["access-control-request-headers"] !== undefined);
    const vary = isPreflight ? preflightVary : undefined;
    const cors =
      clientOrigin === undefined
        ? vary === undefined
          ? {}
          : { vary }
        : hostedCorsHeaders(clientOrigin, vary);
    const alias = {
      publicOrigin: binding.publicOrigin,
      environmentId: binding.environmentId,
      admission: () => originAdmission(binding) === "active",
    };
    const active = originAdmission(binding);
    if (active === "unavailable" || active === "unknown")
      return sendStatus(exchange, inactiveStatus[active], cors);
    if (path === RELAY_ADMISSION_PATH && !isPreflight) {
      if (exchange.kind !== "http" || request.method !== "HEAD" || request.url !== path) {
        return sendStatus(exchange, 405, { ...cors, allow: "HEAD" });
      }
      const marker = active === "active" ? RELAY_ADMISSION_ACTIVE : RELAY_ADMISSION_RETIRED;
      return sendStatus(exchange, marker.status, {
        ...cors,
        [RELAY_ADMISSION_HEADER]: marker.marker,
      });
    }
    if (active === "retired") return sendStatus(exchange, 410, cors);
    const reserved = path !== undefined && reservesBrowserPath(path, origin);
    if (isPreflight) {
      const status = hostedRequestStatus(exchange, clientOrigin, origin);
      if (status !== undefined) return sendStatus(exchange, status, cors);
      if (path === RELAY_HOSTED_SESSION_PATH && request.url === path)
        return preflight(exchange, bootstrapMethods, bootstrapHeaders, cors);
      if (path === RELAY_ADMISSION_PATH && request.url === path)
        return preflight(exchange, probeMethods, noHeaders, cors);
      if (reserved || path === RELAY_ADMISSION_PATH) return sendStatus(exchange, 404, cors);
      return preflight(exchange, forwardingMethods, forwardingHeaders, cors);
    }

    const proxy = request.headersDistinct["proxy-authorization"] !== undefined;
    const carriers = request.headersDistinct[RELAY_HOSTED_SESSION_HEADER];
    const protocols =
      request.headersDistinct["sec-websocket-protocol"]?.flatMap((value) =>
        value.split(",").map((protocol) => protocol.trim()),
      ) ?? [];
    const offersHosted = protocols.some(isReservedProtocol);
    const statusFor = (error: { readonly _tag: string; readonly reason?: string }) => {
      // Revocation can race with P3 authorization behind the runtime gate.
      const current = originAdmission(binding);
      if (current !== "active") return inactiveStatus[current];
      if (
        error._tag === "RelayAuthenticationError" ||
        (error._tag === "BrowserAdmissionError" && error.reason === "invalid")
      )
        return 401;
      if (error._tag === "RelayAccessDeniedError") return 403;
      return 503;
    };
    if (reserved) {
      const respond = (status: number, headers: NodeHttp.OutgoingHttpHeaders = {}, body?: string) =>
        sendStatus(exchange, status, { ...browserHeaders, ...cors, ...headers }, body);
      if (
        request.url !== path ||
        (path !== sessionPath &&
          path !== RELAY_BROWSER_TICKETS_PATH &&
          path !== RELAY_HOSTED_SESSION_PATH)
      )
        return respond(404);
      if (exchange.kind !== "http") return respond(405);
      if (carriers !== undefined || offersHosted) return respond(400);
      if (path === RELAY_HOSTED_SESSION_PATH) {
        if (request.method !== "POST") return respond(405, { allow: "POST" });
        if (proxy) return respond(400);
        const rejected = hostedRequestStatus(exchange, clientOrigin, origin);
        if (rejected !== undefined || clientOrigin === undefined) return respond(rejected ?? 403);
        runBrowserRequest(exchange.response, (signal) =>
          readHostedField(request, "ticket").pipe(
            Effect.flatMap((ticket) => browser.redeem({ ...alias, clientOrigin }, ticket, signal)),
            Effect.match({
              onFailure: (error) => respond(typeof error === "number" ? error : statusFor(error)),
              onSuccess: ({ handle, expiresAt }) => {
                const current = originAdmission(binding);
                if (current !== "active") return respond(inactiveStatus[current]);
                const response: RelayHostedSessionResponse = { session: handle, expiresAt };
                respond(201, { "content-type": "application/json" }, JSON.stringify(response));
              },
            }),
          ),
        );
        return;
      }

      const cookie = relayCookie(request);
      if (cookie === 400 || (proxy && cookie !== undefined)) return respond(400);
      if (path === RELAY_BROWSER_TICKETS_PATH) {
        if (request.method !== "POST") return respond(405, { allow: "POST" });
        if (request.headersDistinct.origin !== undefined || hasFetchMetadata(request))
          return respond(400);
        const credential = bearerHeader(request, "proxy-authorization");
        if (typeof credential === "number") return respond(credential);
        const audience: Effect.Effect<string | undefined, 400 | 403 | 408> = emptyRequest(request)
          ? Effect.undefined
          : readHostedField(request, "clientOrigin").pipe(
              Effect.filterOrFail(
                (value) => binding.hostedClientOrigins?.includes(value) === true,
                () => 403 as const,
              ),
            );
        runBrowserRequest(exchange.response, (signal) =>
          audience.pipe(
            Effect.flatMap((target) =>
              browser
                .mint(
                  target === undefined ? alias : { ...alias, clientOrigin: target },
                  credential,
                  signal,
                )
                .pipe(Effect.map((issued) => ({ ...issued, target }))),
            ),
            Effect.match({
              onFailure: (error) => respond(typeof error === "number" ? error : statusFor(error)),
              onSuccess: ({ handle, expiresAt, target }) => {
                const current = originAdmission(binding);
                if (current !== "active") return respond(inactiveStatus[current]);
                if (target !== undefined) {
                  const response: RelayHostedTicketResponse = { ticket: handle, expiresAt };
                  return respond(
                    201,
                    { "content-type": "application/json" },
                    JSON.stringify(response),
                  );
                }
                const url = new URL(sessionPath, origin);
                url.hash = handle;
                respond(
                  201,
                  { "content-type": "application/json" },
                  JSON.stringify({ url: url.href }),
                );
              },
            }),
          ),
        );
        return;
      }
      if (proxy) return respond(400);
      if (request.method === "GET") {
        if (!emptyRequest(request)) return respond(400);
        return respond(
          200,
          {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": `${browserHeaders["content-security-policy"]}; script-src 'sha256-${bootstrapHash}'; connect-src 'self'`,
          },
          bootstrapPage,
        );
      }
      if (request.method !== "POST") return respond(405, { allow: "GET, POST" });
      const rejected = browserRequestStatus(exchange, origin);
      if (rejected !== undefined) return respond(rejected);
      runBrowserRequest(exchange.response, (signal) =>
        readTicket(request).pipe(
          Effect.flatMap((ticket) => browser.redeem(alias, ticket, signal)),
          Effect.match({
            onFailure: (error) => respond(typeof error === "number" ? error : statusFor(error)),
            onSuccess: ({ handle }) => {
              const current = originAdmission(binding);
              if (current !== "active") return respond(inactiveStatus[current]);
              respond(204, {
                "set-cookie": `${RELAY_BROWSER_COOKIE}=${handle}; Max-Age=${SESSION_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`,
              });
            },
          }),
        ),
      );
      return;
    }
    const reject = (status: number) => sendStatus(exchange, status, cors);
    let hosted: RelayHostedForwardingPolicy | undefined;
    let handle: string | undefined;
    if (carriers !== undefined || offersHosted) {
      if (proxy || (carriers !== undefined && (offersHosted || exchange.kind === "upgrade")))
        return reject(400);
      const rejected = hostedRequestStatus(exchange, clientOrigin, origin);
      if (rejected !== undefined || clientOrigin === undefined) return reject(rejected ?? 403);
      if (carriers !== undefined) {
        if (carriers.length !== 1 || !HANDLE.test(carriers[0] ?? "")) return reject(400);
        if (!forwardingMethods.has(request.method ?? "")) return reject(405);
        handle = carriers[0];
        hosted = { clientOrigin };
      } else {
        const offer = hostedUpgrade(protocols);
        if (exchange.kind !== "upgrade" || offer === undefined) return reject(400);
        handle = offer.handle;
        hosted = { clientOrigin, applicationProtocols: offer.applicationProtocols };
      }
    } else {
      const cookie = relayCookie(request);
      if (cookie === 400 || (cookie !== undefined && proxy)) return reject(400);
      if (cookie !== undefined) {
        const rejected = browserRequestStatus(exchange, origin);
        if (rejected !== undefined) return reject(rejected);
        handle = cookie;
      } else if (proxy) {
        const origins = request.headersDistinct.origin;
        if (origins !== undefined && (origins.length !== 1 || origins[0]?.includes(",")))
          return reject(400);
        if ((origins !== undefined && origins[0] !== origin.origin) || hasFetchMetadata(request))
          return reject(403);
      }
    }
    const credential = handle ?? bearerHeader(request, "proxy-authorization");
    if (typeof credential === "number") return reject(credential);
    const audience = hosted === undefined ? alias : { ...alias, clientOrigin: hosted.clientOrigin };

    const cancel = new AbortController();
    const disconnected = () => cancel.abort();
    request.socket.once("close", disconnected);
    run(
      Effect.gen(function* () {
        const admission =
          handle === undefined
            ? { credential, signal: undefined }
            : yield* browser.resolve(audience, handle);
        yield* forwarding.forward(admission.credential, binding.environmentId, {
          ...exchange,
          ...(hosted === undefined ? {} : { hosted }),
          signal:
            admission.signal === undefined
              ? cancel.signal
              : AbortSignal.any([cancel.signal, admission.signal]),
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            const status = statusFor(error);
            return hosted !== undefined && status === 401
              ? sendStatus(exchange, status, {
                  ...cors,
                  [RELAY_ADMISSION_HEADER]: RELAY_HOSTED_SESSION_REQUIRED,
                })
              : reject(status);
          }),
        ),
        Effect.ensuring(Effect.sync(() => request.socket.off("close", disconnected))),
        Effect.forkIn(scope),
      ),
    );
  };
  server.on("request", (request, response) => dispatch({ kind: "http", request, response }));
  server.on("checkContinue", (request, response) =>
    dispatch({ kind: "checkContinue", request, response }),
  );
  server.on("checkExpectation", (request, response) =>
    dispatch({ kind: "http", request, response }, 417),
  );
  server.on("upgrade", (request, socket, head) =>
    dispatch({ kind: "upgrade", request, socket, head }),
  );
  server.on("connect", (request, socket, head) =>
    dispatch({ kind: "upgrade", request, socket, head }, 400),
  );
  yield* listenHttps(server, config.listen);
});
