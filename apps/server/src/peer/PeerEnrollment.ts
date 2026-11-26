// @effect-diagnostics nodeBuiltinImport:off -- Open credential files without blocking on a substituted FIFO.
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeTls from "node:tls";
import * as NodeFSP from "node:fs/promises";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as PeerVerifiedTransport from "./PeerVerifiedTransport.ts";

export const HttpsOrigin = Schema.String.check(
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    return url?.protocol === "https:" && url.origin === value;
  }),
);
export const SpkiSha256 = Schema.String.check(Schema.isPattern(/^[\w-]{42}[AEIMQUYcgkosw048]$/u));

const Enrollments = Schema.Array(
  Schema.Struct({
    environmentId: EnvironmentId,
    canonicalOrigin: HttpsOrigin,
    routes: Schema.NonEmptyArray(
      Schema.Struct({
        origin: HttpsOrigin,
        spkiSha256: SpkiSha256,
        caPem: Schema.optionalKey(Schema.NonEmptyString),
        relayCredentialPath: Schema.optionalKey(Schema.NonEmptyString),
      }),
    ),
  }),
).check(
  Schema.makeFilter((entries) => {
    const environmentIds = new Set<string>();
    const origins = new Set<string>();
    for (const entry of entries) {
      const routes = new Set(entry.routes.map((route) => route.origin));
      if (environmentIds.has(entry.environmentId) || routes.size !== entry.routes.length) {
        return "Peer enrollments must have unique environment IDs and routes.";
      }
      routes.add(entry.canonicalOrigin);
      for (const origin of routes) {
        if (origins.has(origin)) return "A peer origin may only belong to one enrollment.";
        origins.add(origin);
      }
      environmentIds.add(entry.environmentId);
    }
    return true;
  }),
);

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Enrollments), {
  onExcessProperty: "error",
});
class InvalidPeerEnrollment extends Schema.TaggedError<
  InvalidPeerEnrollment,
  { readonly brand: unique symbol }
>()("InvalidPeerEnrollment", {}) {
  override get message() {
    return "Invalid peer enrollment configuration.";
  }
}

const invalidEnrollment = () => new InvalidPeerEnrollment();
const maxCredentialBytes = 1024;

export const readRelayCredential = Effect.fn("PeerEnrollment.readRelayCredential")(function* (
  path: string,
) {
  const posix = (yield* HostProcess.Platform) !== "win32";
  return yield* Effect.tryPromise({
    try: async () => {
      const { constants } = NodeFS;
      const flags = posix ? constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW : "r";
      const pathInfo = await NodeFSP.lstat(path);
      if (!pathInfo.isFile()) throw invalidEnrollment();
      await using file = await NodeFSP.open(path, flags);
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.dev !== pathInfo.dev ||
        info.ino !== pathInfo.ino ||
        info.size === 0 ||
        info.size > maxCredentialBytes ||
        (posix && (info.mode & 0o077) !== 0)
      ) {
        throw invalidEnrollment();
      }

      const bytes = Buffer.alloc(info.size + 1);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      const credential = bytes.toString("latin1", 0, read).replace(/\r?\n$/u, "");
      if (
        read !== info.size ||
        !/^t3-session-1\.[A-Za-z0-9_-]+\.(?:0|[1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/u.test(credential)
      ) {
        throw invalidEnrollment();
      }
      return Redacted.make(credential);
    },
    catch: invalidEnrollment,
  });
});

export const validateCa = Effect.fn("PeerEnrollment.validateCa")(function* (caPem?: string) {
  if (caPem === undefined) return undefined;
  return yield* Effect.try({
    try: () => {
      const certificateBlock =
        /(?:^|\n)-----BEGIN CERTIFICATE-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END CERTIFICATE-----(?=\r?\n|$)/gu;
      const certificates = caPem.match(certificateBlock);
      if (certificates === null || caPem.replace(certificateBlock, "").trim() !== "") {
        throw invalidEnrollment();
      }
      const ca = certificates.map((certificate) =>
        new NodeCrypto.X509Certificate(certificate.trimStart()).toString(),
      );
      NodeTls.createSecureContext({ ca });
      return { ca };
    },
    catch: invalidEnrollment,
  });
});

// Only the launching operator may enroll a credential-bearing route.
export const load = Config.String("T3CODE_PEER_ENROLLMENTS").pipe(
  Config.option,
  Effect.flatMap(Option.match({ onNone: () => Effect.succeed([]), onSome: decode })),
  Effect.flatMap((entries) =>
    Effect.forEach(
      entries,
      Effect.fn("PeerEnrollment.loadEntry")(function* ({
        environmentId,
        canonicalOrigin,
        routes,
      }: (typeof Enrollments.Type)[number]) {
        const enrolledRoutes = yield* Effect.forEach(
          routes,
          ({ origin, spkiSha256, caPem, relayCredentialPath }) =>
            Effect.gen(function* () {
              const tls = yield* validateCa(caPem);
              const relayCredential =
                relayCredentialPath === undefined
                  ? undefined
                  : yield* readRelayCredential(relayCredentialPath);
              return {
                url: origin,
                transport: {
                  canonicalOrigin,
                  ...(relayCredential === undefined ? {} : { relay: true as const }),
                  httpClient: PeerVerifiedTransport.make(
                    { canonicalOrigin, aliasOrigin: origin, spkiSha256, relayCredential },
                    tls,
                  ),
                },
              };
            }),
        );
        return {
          environmentId,
          canonicalOrigin,
          routes: enrolledRoutes,
        };
      }),
    ),
  ),
  Effect.mapError(invalidEnrollment),
  Effect.orDie,
);
