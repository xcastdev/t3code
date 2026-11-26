// @effect-diagnostics nodeBuiltinImport:off -- The proof feeds authenticated sockets through a dedicated HTTP parser.
import * as NodeHttp from "node:http";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { bindDirectRelayProof } from "../requestUrl.ts";
import { connectStaticRelayTunnel } from "@t3tools/relay-core/RelayTunnelTransport";

const ConfigDocument = Schema.Struct({
  environmentId: Schema.NonEmptyString,
  publicOrigin: Schema.NonEmptyString,
  canonicalOrigin: Schema.NonEmptyString,
  relayHost: Schema.NonEmptyString,
  relayPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  relayServername: Schema.NonEmptyString,
  relayFingerprint: Schema.String.check(Schema.isPattern(/^(?:[a-f\d]{2}:){31}[a-f\d]{2}$/iu)),
  caPath: Schema.NonEmptyString,
  certPath: Schema.NonEmptyString,
  keyPath: Schema.NonEmptyString,
  directTerminatorTokenPath: Schema.optionalKey(Schema.NonEmptyString),
});

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ConfigDocument));

export function parseRelayProofEnvironment(document: string, serverHost: string) {
  if (serverHost !== "127.0.0.1" && serverHost !== "::1") {
    throw new Error("The static relay proof requires a loopback T3 listener");
  }

  const parsed = decode(document);
  for (const origin of [parsed.publicOrigin, parsed.canonicalOrigin]) {
    const url = URL.parse(origin);
    if (url?.protocol !== "https:" || url.origin !== origin) {
      throw new Error("The static relay proof requires exact HTTPS origins");
    }
  }

  return parsed;
}

class RelayProofConfigurationError extends Schema.TaggedError<RelayProofConfigurationError>()(
  "RelayProofConfigurationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not configure the static relay proof.";
  }
}

export const attachRelayProofEnvironment = Effect.fn("RelayProofEnvironment.attach")(function* (
  server: NodeHttp.Server,
  input: { readonly host: string; readonly environmentIdPath: string },
) {
  const configPath = yield* Config.String("T3CODE_STATIC_RELAY_PROOF_CONFIG").pipe(Config.option);
  if (Option.isNone(configPath)) return;

  const files = yield* FileSystem.FileSystem;
  const document = yield* files.readFileString(configPath.value);
  const config = yield* Effect.try({
    try: () => parseRelayProofEnvironment(document, input.host),
    catch: (cause) => new RelayProofConfigurationError({ cause }),
  });
  const identity = yield* files.readFileString(input.environmentIdPath);
  if (identity.trim() !== config.environmentId) {
    return yield* new RelayProofConfigurationError({
      cause: new Error("The static relay enrollment belongs to a different environment"),
    });
  }
  const [ca, cert, key] = yield* Effect.all([
    files.readFileString(config.caPath),
    files.readFileString(config.certPath),
    files.readFileString(config.keyPath),
  ]);
  let terminatorToken: string | undefined;
  if (config.directTerminatorTokenPath !== undefined) {
    terminatorToken = (yield* files.readFileString(config.directTerminatorTokenPath)).trim();
    if (!/^[a-f\d]{64}$/u.test(terminatorToken)) {
      return yield* new RelayProofConfigurationError({
        cause: new Error(
          "The direct TLS terminator token must be 32 bytes encoded as lowercase hex",
        ),
      });
    }
  }
  const backend = NodeHttp.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    server.emit("request", request, response);
  });
  backend.on("upgrade", (request, socket, head) => {
    server.emit("upgrade", request, socket, head);
  });

  yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        connectStaticRelayTunnel({
          relay: {
            host: config.relayHost,
            port: config.relayPort,
            servername: config.relayServername,
            ca,
            cert,
            key,
          },
          relayFingerprint: config.relayFingerprint,
          publicOrigin: config.publicOrigin,
          canonicalOrigin: config.canonicalOrigin,
          backend,
        }),
      catch: (cause) => new RelayProofConfigurationError({ cause }),
    }),
    (tunnel) => Effect.sync(() => tunnel.close()),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => bindDirectRelayProof(server, config.canonicalOrigin, terminatorToken)),
    (unbind) => Effect.sync(unbind),
  );
});
