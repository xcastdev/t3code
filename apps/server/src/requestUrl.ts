// @effect-diagnostics nodeBuiltinImport:off -- The Node request adapter checks the proof terminator credential synchronously.
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";
import type * as NodeTls from "node:tls";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";
import {
  trustedStaticRelayCanonicalOrigin,
  trustedStaticRelayExternalOrigin,
} from "@t3tools/relay-core/RelayTunnelTransport";

type DirectRelayProof = {
  readonly canonicalOrigin: string;
  readonly terminatorToken: Buffer | undefined;
};

const directRelayProof = new WeakMap<NodeNet.Socket, DirectRelayProof>();

export function bindDirectRelayProof(
  server: NodeNet.Server,
  canonicalOrigin: string,
  terminatorToken: string | undefined,
) {
  const binding = {
    canonicalOrigin,
    terminatorToken: terminatorToken === undefined ? undefined : Buffer.from(terminatorToken),
  };
  const bind = (socket: NodeNet.Socket) => directRelayProof.set(socket, binding);
  server.prependListener("connection", bind);
  return () => {
    server.off("connection", bind);
  };
}

const hasTerminatorToken = (
  header: string | string[] | undefined,
  expected: Buffer | undefined,
) => {
  if (expected === undefined || typeof header !== "string" || header.length !== expected.length) {
    return false;
  }
  const actual = Buffer.from(header);
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
};

// Existing TLS terminators such as Tailscale Serve still supply the scheme in this header.
const directRequestUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(
    request.headers["x-forwarded-proto"] === "https" && request.protocol !== "https"
      ? request.modify({ protocol: "https" })
      : request,
  );

const originUrl = (request: HttpServerRequest.HttpServerRequest, origin: string | undefined) =>
  origin === undefined
    ? directRequestUrl(request)
    : Option.some(new URL(`.${request.url}`, origin));

export const relayExternalOrigin = (request: HttpServerRequest.HttpServerRequest) =>
  trustedStaticRelayExternalOrigin(NodeHttpServerRequest.toIncomingMessage(request)?.socket);

export const requestUrl = (request: HttpServerRequest.HttpServerRequest): Option.Option<URL> => {
  const incoming = NodeHttpServerRequest.toIncomingMessage(request);
  const socket = incoming?.socket;
  const external = trustedStaticRelayExternalOrigin(socket);
  if (external !== undefined || socket === undefined) return originUrl(request, external);

  const proof = directRelayProof.get(socket);
  if (proof === undefined) return directRequestUrl(request);
  if (hasTerminatorToken(incoming.headers["x-t3-proof-terminator-token"], proof.terminatorToken)) {
    return originUrl(request, proof.canonicalOrigin);
  }

  const protocol = (socket as NodeTls.TLSSocket).encrypted ? "https" : "http";
  return HttpServerRequest.toURL(request.modify({ protocol }));
};

export const canonicalRequestUrl = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<URL> => {
  const socket = NodeHttpServerRequest.toIncomingMessage(request)?.socket;
  return originUrl(
    request,
    trustedStaticRelayCanonicalOrigin(socket) ??
      (socket === undefined ? undefined : directRelayProof.get(socket)?.canonicalOrigin),
  );
};
