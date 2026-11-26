// @effect-diagnostics nodeBuiltinImport:off -- Bind peer credentials to the certificate on the actual HTTPS request.
import * as NodeCrypto from "node:crypto";
import * as NodeHttps from "node:https";
import * as NodeStream from "node:stream";
import * as NodeTls from "node:tls";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

interface PeerAliasBinding {
  readonly canonicalOrigin: string;
  readonly aliasOrigin: string;
  readonly spkiSha256: string;
  readonly relayCredential?: Redacted.Redacted<string> | undefined;
}

const httpsOrigin = (value: string) => {
  const url = URL.parse(value);
  return url?.protocol === "https:" && (value === url.origin || value === `${url.origin}/`)
    ? url.origin
    : undefined;
};

/** An explicitly enrolled alias for canonical peer OAuth and MCP HTTP requests. */
export const make = (
  binding: PeerAliasBinding,
  tls?: Pick<NodeHttps.RequestOptions, "ca">,
): HttpClient.HttpClient => {
  const canonicalOrigin = httpsOrigin(binding.canonicalOrigin);
  const aliasOrigin = httpsOrigin(binding.aliasOrigin);
  const relayCredential = binding.relayCredential;
  const pin = Buffer.from(binding.spkiSha256, "base64url");
  const validPin = pin.length === 32 && pin.toString("base64url") === binding.spkiSha256;
  const checkServerIdentity: typeof NodeTls.checkServerIdentity = (host, certificate) => {
    const hostnameError = NodeTls.checkServerIdentity(host, certificate);
    if (hostnameError !== undefined) return hostnameError;
    const key = new NodeCrypto.X509Certificate(certificate.raw).publicKey;
    const actual = NodeCrypto.createHash("sha256")
      .update(key.export({ type: "spki", format: "der" }))
      .digest();
    if (!actual.equals(pin)) return new Error("Peer alias TLS key mismatch");
  };

  return HttpClient.make((request, logicalUrl, signal) => {
    if (
      !validPin ||
      aliasOrigin === undefined ||
      logicalUrl.origin !== canonicalOrigin ||
      logicalUrl.username !== "" ||
      logicalUrl.password !== ""
    ) {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.InvalidUrlError({
            request,
            description: "Request does not match an enrolled HTTPS peer binding",
          }),
        }),
      );
    }
    const physicalUrl = new URL(aliasOrigin);
    physicalUrl.pathname = logicalUrl.pathname;
    physicalUrl.search = logicalUrl.search;
    const body = request.body;
    if (body._tag !== "Empty" && body._tag !== "Uint8Array") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.EncodeError({
            request,
            description: "Peer alias requests require a buffered body",
          }),
        }),
      );
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => {
        const header = name.toLowerCase();
        return (
          header !== "host" &&
          header !== "expect" &&
          header !== "proxy-authorization" &&
          header !== "forwarded" &&
          !header.startsWith("x-forwarded-")
        );
      }),
    );
    return Effect.tryPromise({
      try: () =>
        new Promise<HttpClientResponse.HttpClientResponse>((resolve, reject) => {
          const exchange = NodeHttps.request(
            physicalUrl,
            {
              agent: false,
              ca: tls?.ca,
              rejectUnauthorized: true,
              checkServerIdentity,
              signal,
              method: request.method,
              headers,
            },
            (reply) => {
              const status = reply.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                reply.destroy();
                reject(new Error(`Peer alias refused HTTP redirect (${status})`));
                return;
              }
              try {
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(reply.headers)) {
                  if (typeof value === "string") responseHeaders.append(name, value);
                  else for (const item of value ?? []) responseHeaders.append(name, item);
                }
                const hasBody = request.method !== "HEAD" && status !== 204 && status !== 205;
                if (!hasBody) reply.resume();
                const source = new Response(
                  hasBody
                    ? NodeStream.Readable.toWeb(reply, { strategy: { highWaterMark: 0 } })
                    : null,
                  { status, headers: responseHeaders },
                );
                resolve(HttpClientResponse.fromWeb(request, source));
              } catch (cause) {
                reply.destroy();
                reject(cause);
              }
            },
          );
          exchange.once("error", reject);
          exchange.once("upgrade", (_response, socket) => {
            socket.destroy();
            reject(new Error("Peer alias refused HTTP upgrade"));
          });
          exchange.once("socket", (socket) => {
            // A fresh socket completes chain, hostname and pin checks before writing HTTP bytes.
            socket.once("secureConnect", () => {
              if (relayCredential !== undefined) {
                exchange.setHeader(
                  "Proxy-Authorization",
                  `Bearer ${Redacted.value(relayCredential)}`,
                );
              }
              exchange.end(body._tag === "Empty" ? undefined : body.body);
            });
          });
        }),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    });
  });
};
