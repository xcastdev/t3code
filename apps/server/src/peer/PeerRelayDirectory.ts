import { SelfHostedRelayDirectoryDiscovery } from "@t3tools/contracts/selfHostedRelayDirectory";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as PeerEnrollment from "./PeerEnrollment.ts";
import * as PeerVerifiedTransport from "./PeerVerifiedTransport.ts";

const maxResponseBytes = 1024 * 1024;
const decodeConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      origin: PeerEnrollment.HttpsOrigin,
      spkiSha256: PeerEnrollment.SpkiSha256,
      caPem: Schema.optionalKey(Schema.NonEmptyString),
      credentialPath: Schema.NonEmptyString,
    }),
  ),
  { onExcessProperty: "error" },
);
const decodeDiscovery = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SelfHostedRelayDirectoryDiscovery),
);

const messages = {
  "not-configured": "Peer relay directory lookup is not configured.",
  "invalid-config": "Invalid peer relay directory configuration.",
  "invalid-selector": "Supply an environment ID or exact label.",
  unavailable: "Could not reach the peer relay directory.",
  "timed-out": "Peer relay directory lookup timed out.",
  denied: "Peer relay directory access was denied.",
  "invalid-response": "Invalid peer relay directory response.",
  "not-found": "No matching environment in the peer relay directory.",
  ambiguous: "The peer relay directory label is ambiguous. Use an exact environment ID.",
} as const;

class PeerRelayDirectoryError extends Schema.TaggedError<
  PeerRelayDirectoryError,
  { readonly brand: unique symbol }
>()("PeerRelayDirectoryError", {
  reason: Schema.Literals(Object.keys(messages) as ReadonlyArray<keyof typeof messages>),
}) {
  override get message() {
    return messages[this.reason];
  }
}

const readDiscovery = Effect.fn("PeerRelayDirectory.readDiscovery")(function* (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  relayId: string,
) {
  const response = yield* HttpClient.withScope(client)
    .execute(request)
    .pipe(
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.mapError(() => new PeerRelayDirectoryError({ reason: "unavailable" })),
    );
  if (response.status !== 200) {
    return yield* new PeerRelayDirectoryError({
      reason: response.status === 401 || response.status === 403 ? "denied" : "unavailable",
    });
  }

  const invalidResponse = () => new PeerRelayDirectoryError({ reason: "invalid-response" });
  if (
    response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json" ||
    response.headers["content-range"] !== undefined ||
    Number(response.headers["content-length"]) > maxResponseBytes
  ) {
    return yield* invalidResponse();
  }
  const bytes = new Uint8Array(maxResponseBytes);
  let length = 0;
  yield* Stream.runForEach(response.stream, (chunk) =>
    Effect.suspend(() => {
      if (length + chunk.byteLength > bytes.byteLength) return Effect.fail(invalidResponse());
      bytes.set(chunk, length);
      length += chunk.byteLength;
      return Effect.void;
    }),
  ).pipe(Effect.mapError(invalidResponse));

  const body = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    catch: invalidResponse,
  });
  const discovery = yield* decodeDiscovery(body).pipe(Effect.mapError(invalidResponse));
  const ids = new Set(discovery.environments.map((environment) => environment.environmentId));
  if (
    ids.size !== discovery.environments.length ||
    discovery.environments.some((row) => row.relayId !== relayId || !row.name.isWellFormed())
  ) {
    return yield* invalidResponse();
  }
  return discovery;
});

export const lookup = Effect.fn("PeerRelayDirectory.lookup")(
  function* (selector: string) {
    if (selector.trim() === "")
      return yield* new PeerRelayDirectoryError({ reason: "invalid-selector" });

    const invalidConfig = () => new PeerRelayDirectoryError({ reason: "invalid-config" });
    const input = yield* Config.String("T3CODE_PEER_RELAY_DIRECTORY").pipe(
      Config.option,
      Effect.mapError(invalidConfig),
    );
    if (Option.isNone(input))
      return yield* new PeerRelayDirectoryError({ reason: "not-configured" });
    const config = yield* decodeConfig(input.value).pipe(Effect.mapError(invalidConfig));
    const tls = yield* PeerEnrollment.validateCa(config.caPem).pipe(Effect.mapError(invalidConfig));
    const credential = yield* PeerEnrollment.readRelayCredential(config.credentialPath).pipe(
      Effect.mapError(invalidConfig),
    );
    // This session belongs to the management origin and travels in Authorization.
    const client = PeerVerifiedTransport.make(
      { canonicalOrigin: config.origin, aliasOrigin: config.origin, spkiSha256: config.spkiSha256 },
      tls,
    );
    const request = HttpClientRequest.get(
      `${config.origin}/api/self-hosted-relay/v1/directory`,
    ).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(credential));
    const { environments } = yield* readDiscovery(
      client,
      request,
      Redacted.value(credential).split(".")[1]!,
    ).pipe(Effect.scoped);

    const exact = environments.find((row) => row.environmentId === selector);
    const matches =
      exact === undefined ? environments.filter((row) => row.name === selector) : [exact];
    const [environment] = matches;
    if (environment === undefined)
      return yield* new PeerRelayDirectoryError({ reason: "not-found" });
    if (matches.length > 1) return yield* new PeerRelayDirectoryError({ reason: "ambiguous" });

    return {
      environment,
      candidateOrigins: [
        ...new Set(environment.addressHints.map((hint) => new URL(hint.httpBaseUrl).origin)),
      ],
    };
  },
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () => Effect.fail(new PeerRelayDirectoryError({ reason: "timed-out" })),
  }),
);

export class PeerRelayDirectory extends Context.Service<
  PeerRelayDirectory,
  {
    readonly lookup: typeof lookup;
  }
>()("t3/peer/PeerRelayDirectory") {}

export const layer = Layer.succeed(PeerRelayDirectory, { lookup });
