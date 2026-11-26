// @effect-diagnostics nodeBuiltinImport:off -- Provisioning validates TLS material with the same parsers as the Node listeners.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { EnvironmentId } from "@t3tools/contracts";
import { SelfHostedRelayId } from "@t3tools/contracts/selfHostedRelay";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { RelayForwardingBinding } from "@t3tools/relay-core/RelayForwarding";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const MANIFEST_BYTES = 256 * 1024;
const PEM_BYTES = 128 * 1024;
const CREDENTIAL_BYTES = 1024;
const TERMINATOR_TOKEN_BYTES = 64;
const MAX_BINDINGS = 64;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const isDnsName = (host: string): boolean =>
  host.length <= 253 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(host) &&
  URL.parse(`https://${host}`)?.hostname === host &&
  NodeNet.isIP(host) === 0;

const dnsName = Schema.String.check(Schema.makeFilter(isDnsName));
const host = Schema.String.check(
  Schema.makeFilter(
    (value) => isDnsName(value) || (!value.includes("%") && NodeNet.isIP(value) !== 0),
  ),
);
const httpsOrigin = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => {
    const url = URL.parse(value);
    if (url?.protocol !== "https:" || url.origin !== value) return false;
    const hostname = url.hostname;
    return isDnsName(hostname) || NodeNet.isIP(hostname.replace(/^\[(.*)\]$/u, "$1")) !== 0;
  }),
);
const dnsOrigin = httpsOrigin.check(
  Schema.makeFilter((value) => isDnsName(URL.parse(value)?.hostname ?? "")),
);
const port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));
const pin = Schema.String.check(Schema.isPattern(/^(?:[a-fA-F0-9]{2}:){31}[a-fA-F0-9]{2}$/u));
const filePath = Schema.NonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter((value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value)),
);
const identity = Schema.Trimmed.check(
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => !/[\p{Cc}\p{Cs}]/u.test(value)),
).pipe(Schema.decodeTo(EnvironmentId));
const Listen = Schema.Struct({ host, port });
const pemPaths = { certPath: filePath, keyPath: filePath };
const IngressCertificate = Schema.Struct({
  serverNames: Schema.Array(dnsName).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BINDINGS)),
  ...pemPaths,
});
const Binding = Schema.Struct({
  environmentId: identity,
  publicOrigin: dnsOrigin,
  canonicalOrigin: httpsOrigin,
  hostedClientOrigins: Schema.optional(
    Schema.Array(httpsOrigin).check(Schema.isMaxLength(16), Schema.makeFilter(unique)),
  ),
  environmentFingerprint: pin,
  tunnelListen: Listen,
  tunnelCaPath: filePath,
  tunnelCertPath: filePath,
  tunnelKeyPath: filePath,
});
const decodeForwarding = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    ingress: Schema.Struct({
      listen: Listen,
      certificates: Schema.Array(IngressCertificate).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(MAX_BINDINGS),
      ),
    }),
    control: Schema.Struct({ listen: Listen, origin: dnsOrigin, ...pemPaths }),
    hookIngress: Schema.optionalKey(
      Schema.Struct({ listen: Listen, origin: dnsOrigin, ...pemPaths, signingKeyPath: filePath }),
    ),
    bindings: Schema.Array(Binding).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_BINDINGS)),
  }),
  { onExcessProperty: "error" },
);
const decodeConnector = Schema.decodeUnknownSync(
  Schema.Struct({
    version: Schema.Literal(1),
    environmentId: identity,
    publicOrigin: dnsOrigin,
    canonicalOrigin: httpsOrigin,
    controlOrigin: dnsOrigin,
    controlCaPath: filePath,
    controlFingerprint: pin,
    publisherCredentialPath: filePath,
    directTerminatorTokenPath: Schema.optionalKey(filePath),
    hookAuthority: Schema.optionalKey(
      Schema.Struct({
        relayId: SelfHostedRelayId,
        publicKeyPath: filePath,
        hookOrigin: Schema.optionalKey(dnsOrigin),
      }),
    ),
    relayHost: host,
    relayPort: port,
    relayServername: dnsName,
    relayFingerprint: pin,
    caPath: filePath,
    ...pemPaths,
  }),
  { onExcessProperty: "error" },
);

export class SelfHostedRelayConfigError extends Schema.TaggedError<
  SelfHostedRelayConfigError,
  { readonly brand: unique symbol }
>()("SelfHostedRelayConfigError", {}) {
  override get message(): string {
    return "Invalid self-hosted relay configuration.";
  }
}

export type SelfHostedRelayListen = typeof Listen.Type;
interface PemPair {
  readonly cert: Buffer;
  readonly key: Buffer;
}

export interface SelfHostedRelayForwardingConfig {
  readonly ingress: {
    readonly listen: SelfHostedRelayListen;
    readonly certificates: ReadonlyArray<PemPair & { readonly serverNames: readonly string[] }>;
  };
  readonly control: PemPair & {
    readonly listen: SelfHostedRelayListen;
    readonly origin: string;
  };
  readonly bindings: readonly RelayForwardingBinding[];
  readonly hookIngress?: PemPair & {
    readonly listen: SelfHostedRelayListen;
    readonly origin: string;
    readonly signingKey: string;
  };
}

export interface SelfHostedRelayConnectorConfig {
  readonly environmentId: EnvironmentId;
  readonly publicOrigin: string;
  readonly canonicalOrigin: string;
  readonly controlOrigin: string;
  readonly controlCa: Buffer;
  readonly controlFingerprint: string;
  readonly publisherCredential: string;
  readonly directTerminatorToken?: string;
  readonly hookAuthority?: {
    readonly relayId: SelfHostedRelayId;
    readonly publicKey: string;
    readonly hookOrigin?: string;
  };
  readonly relayFingerprint: string;
  readonly relay: PemPair & {
    readonly host: string;
    readonly port: number;
    readonly servername: string;
    readonly ca: Buffer;
  };
}

export function parseRelayJson(bytes: Buffer): unknown {
  const text = utf8.decode(bytes);
  const document: unknown = JSON.parse(text);
  const nesting: Array<Set<string> | undefined> = [];
  // JSON.parse validates syntax first. Inspect decoded member names before its last-value-wins behavior can hide one.
  for (const [token, member] of text.matchAll(
    /("(?:[^"\\]|\\.)*")\s*:|"(?:[^"\\]|\\.)*"|[{}[\]]/gu,
  )) {
    if (member !== undefined) {
      const keys = nesting.at(-1);
      const name: string = JSON.parse(member);
      if (keys?.has(name)) throw new SelfHostedRelayConfigError();
      keys?.add(name);
    } else if (token === "{" || token === "[") {
      if (nesting.length === 32) throw new SelfHostedRelayConfigError();
      nesting.push(token === "{" ? new Set() : undefined);
    } else if (token === "}" || token === "]") {
      nesting.pop();
    }
  }
  return document;
}

const readBounded = Effect.fn("SelfHostedRelayForwardingConfig.readBounded")(
  function* (path: string, maxBytes: number, access?: "private" | "owner" | "trusted-public") {
    const files = yield* FileSystem.FileSystem;
    const initial = yield* files.stat(path);
    if (initial.type !== "File" || initial.size > BigInt(maxBytes)) {
      return yield* new SelfHostedRelayConfigError();
    }
    const file = yield* files.open(path);
    const info = yield* file.stat;
    if (info.type !== "File" || info.size === 0n || info.size > BigInt(maxBytes)) {
      return yield* new SelfHostedRelayConfigError();
    }
    if (access !== undefined && (yield* HostProcess.Platform) !== "win32") {
      const owner = access === "private" ? undefined : process.geteuid?.();
      const fallbackOwner = access === "trusted-public" && Option.contains(info.uid, 0);
      const disallowedMode = access === "trusted-public" ? 0o022 : 0o077;
      if (
        (info.mode & disallowedMode) !== 0 ||
        (owner !== undefined && !fallbackOwner && !Option.contains(info.uid, owner))
      ) {
        return yield* new SelfHostedRelayConfigError();
      }
    }
    const buffer = Buffer.alloc(Number(info.size) + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = yield* file.read(buffer.subarray(size));
      if (count === 0) break;
      size += count;
    }
    if (size !== Number(info.size)) return yield* new SelfHostedRelayConfigError();
    return buffer.subarray(0, size);
  },
  Effect.scoped,
  Effect.mapError(() => new SelfHostedRelayConfigError()),
);

function parseCertificates(pem: Buffer): NodeCrypto.X509Certificate[] {
  const text = utf8.decode(pem).trim();
  const certificates: NodeCrypto.X509Certificate[] = [];
  let offset = 0;
  for (const match of text.matchAll(
    /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/gu,
  )) {
    if (text.slice(offset, match.index).trim() !== "") throw new SelfHostedRelayConfigError();
    certificates.push(new NodeCrypto.X509Certificate(match[0]));
    offset = match.index + match[0].length;
  }
  if (certificates.length === 0 || text.slice(offset).trim() !== "") {
    throw new SelfHostedRelayConfigError();
  }
  return certificates;
}

function validatePemPair(pair: PemPair, names: readonly string[]): void {
  const [leaf] = parseCertificates(pair.cert);
  const key = utf8.decode(pair.key).trim();
  if (
    !/^-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+-----END \1-----$/u.test(
      key,
    )
  ) {
    throw new SelfHostedRelayConfigError();
  }
  if (
    !leaf ||
    names.some((name) => leaf.checkHost(name, { partialWildcards: false }) === undefined)
  ) {
    throw new SelfHostedRelayConfigError();
  }
  if (!leaf.checkPrivateKey(NodeCrypto.createPrivateKey(pair.key))) {
    throw new SelfHostedRelayConfigError();
  }
  NodeTls.createSecureContext(pair);
}

const readPair = Effect.fn("SelfHostedRelayForwardingConfig.readPair")(function* (
  certPath: string,
  keyPath: string,
  names: readonly string[] = [],
) {
  const cert = yield* readBounded(certPath, PEM_BYTES);
  const key = yield* readBounded(keyPath, PEM_BYTES, "private");
  const pair = { cert, key };
  yield* Effect.try({
    try: () => validatePemPair(pair, names),
    catch: () => new SelfHostedRelayConfigError(),
  });
  return pair;
});

const readCa = Effect.fn("SelfHostedRelayForwardingConfig.readCa")(function* (path: string) {
  const ca = yield* readBounded(path, PEM_BYTES);
  yield* Effect.try({
    try: () => parseCertificates(ca),
    catch: () => new SelfHostedRelayConfigError(),
  });
  return ca;
});

const readHookKey = Effect.fn("SelfHostedRelayForwardingConfig.readHookKey")(function* (
  path: string,
  kind: "private" | "public",
) {
  const bytes = yield* readBounded(
    path,
    PEM_BYTES,
    kind === "private" ? "owner" : "trusted-public",
  );
  return yield* Effect.try({
    try: () => {
      const text = utf8.decode(bytes).trim();
      const label = kind === "private" ? "PRIVATE KEY" : "PUBLIC KEY";
      if (
        !text.startsWith(`-----BEGIN ${label}-----\n`) &&
        !text.startsWith(`-----BEGIN ${label}-----\r\n`)
      )
        throw new SelfHostedRelayConfigError();
      const key =
        kind === "private" ? NodeCrypto.createPrivateKey(text) : NodeCrypto.createPublicKey(text);
      if (key.asymmetricKeyType !== "ed25519") throw new SelfHostedRelayConfigError();
      return kind === "private"
        ? key.export({ type: "pkcs8", format: "pem" }).toString()
        : key.export({ type: "spki", format: "pem" }).toString();
    },
    catch: () => new SelfHostedRelayConfigError(),
  });
});

function unique<T>(items: readonly T[]): boolean {
  return new Set(items).size === items.length;
}

const originPort = (origin: URL) => Number(origin.port || "443");

function listenerConflict(left: SelfHostedRelayListen, right: SelfHostedRelayListen): boolean {
  if (left.port !== right.port) return false;
  const addresses = [left.host, right.host].map((host) => {
    if (NodeNet.isIP(host) === 4) return host;
    if (NodeNet.isIP(host) === 6) return new URL(`https://[${host}]`).hostname.slice(1, -1);
    return undefined;
  });
  const [first, second] = addresses;
  return (
    first === second ||
    addresses.some(
      (address) =>
        address === undefined ||
        address === "0.0.0.0" ||
        address === "::" ||
        address.startsWith("::ffff:"),
    )
  );
}

function validateForwarding(config: ReturnType<typeof decodeForwarding>): void {
  const { ingress, control, bindings, hookIngress } = config;
  const names = ingress.certificates.flatMap(({ serverNames }) => serverNames);
  const listen = [
    ingress.listen,
    control.listen,
    ...(hookIngress ? [hookIngress.listen] : []),
    ...bindings.map((binding) => binding.tunnelListen),
  ];
  if (
    originPort(new URL(control.origin)) !== control.listen.port ||
    (hookIngress !== undefined &&
      (originPort(new URL(hookIngress.origin)) !== hookIngress.listen.port ||
        hookIngress.origin === control.origin ||
        bindings.some(
          ({ publicOrigin, canonicalOrigin }) =>
            publicOrigin === hookIngress.origin || canonicalOrigin === hookIngress.origin,
        ))) ||
    !unique(names) ||
    !unique(bindings.map(({ environmentId }) => environmentId)) ||
    !unique(bindings.map(({ publicOrigin }) => publicOrigin)) ||
    !unique(bindings.map(({ canonicalOrigin }) => canonicalOrigin)) ||
    !unique(bindings.map(({ environmentFingerprint }) => environmentFingerprint.toUpperCase())) ||
    listen.some((left, index) =>
      listen.slice(index + 1).some((right) => listenerConflict(left, right)),
    ) ||
    bindings.some(({ publicOrigin }) => {
      const origin = new URL(publicOrigin);
      return (
        publicOrigin === control.origin ||
        originPort(origin) !== ingress.listen.port ||
        !names.includes(origin.hostname)
      );
    })
  ) {
    throw new SelfHostedRelayConfigError();
  }
}

export const loadSelfHostedRelayForwardingConfig = Effect.fn(
  "SelfHostedRelayForwardingConfig.load",
)(function* (
  manifestPath: string,
): Effect.fn.Return<
  SelfHostedRelayForwardingConfig,
  SelfHostedRelayConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const directory = path.dirname(path.resolve(manifestPath));
  const resolve = (value: string) => path.resolve(directory, value);
  const bytes = yield* readBounded(manifestPath, MANIFEST_BYTES);
  const config = yield* Effect.try({
    try: () => {
      const document = decodeForwarding(parseRelayJson(bytes));
      validateForwarding(document);
      return document;
    },
    catch: () => new SelfHostedRelayConfigError(),
  });

  const certificates = yield* Effect.forEach(
    config.ingress.certificates,
    ({ serverNames, certPath, keyPath }) =>
      readPair(resolve(certPath), resolve(keyPath), serverNames).pipe(
        Effect.map((pair) => ({ ...pair, serverNames })),
      ),
  );
  const { control } = config;
  const controlPair = yield* readPair(resolve(control.certPath), resolve(control.keyPath), [
    new URL(control.origin).hostname,
  ]);
  const bindings = yield* Effect.forEach(
    config.bindings,
    Effect.fn("SelfHostedRelayForwardingConfig.loadBinding")(function* (binding) {
      const ca = yield* readCa(resolve(binding.tunnelCaPath));
      const pair = yield* readPair(resolve(binding.tunnelCertPath), resolve(binding.tunnelKeyPath));
      return {
        environmentId: binding.environmentId,
        publicOrigin: binding.publicOrigin,
        canonicalOrigin: binding.canonicalOrigin,
        hostedClientOrigins: binding.hostedClientOrigins ?? [],
        environmentFingerprint: binding.environmentFingerprint.toUpperCase(),
        tunnelTls: { ...pair, ca },
        listen: binding.tunnelListen,
      } satisfies RelayForwardingBinding;
    }),
  );
  const hooks = config.hookIngress;
  const hookIngress =
    hooks === undefined
      ? undefined
      : {
          ...(yield* readPair(resolve(hooks.certPath), resolve(hooks.keyPath), [
            new URL(hooks.origin).hostname,
          ])),
          signingKey: yield* readHookKey(resolve(hooks.signingKeyPath), "private"),
          listen: hooks.listen,
          origin: hooks.origin,
        };
  return {
    ingress: { listen: config.ingress.listen, certificates },
    control: { ...controlPair, listen: control.listen, origin: control.origin },
    bindings,
    ...(hookIngress === undefined ? {} : { hookIngress }),
  };
});

export const loadSelfHostedRelayConnectorConfig = Effect.fn(
  "SelfHostedRelayForwardingConfig.loadConnector",
)(function* (
  manifestPath: string,
  environmentId: EnvironmentId,
): Effect.fn.Return<
  SelfHostedRelayConnectorConfig,
  SelfHostedRelayConfigError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const directory = path.dirname(path.resolve(manifestPath));
  const resolve = (value: string) => path.resolve(directory, value);
  const bytes = yield* readBounded(manifestPath, MANIFEST_BYTES);
  const config = yield* Effect.try({
    try: () => decodeConnector(parseRelayJson(bytes)),
    catch: () => new SelfHostedRelayConfigError(),
  });
  if (config.environmentId !== environmentId || config.controlOrigin === config.publicOrigin) {
    return yield* new SelfHostedRelayConfigError();
  }
  const hookOrigin = config.hookAuthority?.hookOrigin;
  if (
    hookOrigin !== undefined &&
    [config.publicOrigin, config.canonicalOrigin, config.controlOrigin].includes(hookOrigin)
  )
    return yield* new SelfHostedRelayConfigError();

  const credential = yield* readBounded(
    resolve(config.publisherCredentialPath),
    CREDENTIAL_BYTES,
    "private",
  );
  const publisherCredential = yield* Effect.try({
    try: () => {
      const token = utf8.decode(credential).replace(/\r?\n$/u, "");
      if (!/^[A-Za-z0-9._~+/-]+=*$/u.test(token)) throw new SelfHostedRelayConfigError();
      return token;
    },
    catch: () => new SelfHostedRelayConfigError(),
  });
  let directTerminatorToken: string | undefined;
  if (config.directTerminatorTokenPath !== undefined) {
    const token = yield* readBounded(
      resolve(config.directTerminatorTokenPath),
      TERMINATOR_TOKEN_BYTES,
      "owner",
    );
    directTerminatorToken = token.toString("latin1");
    if (!/^[a-f0-9]{64}$/u.test(directTerminatorToken)) {
      return yield* new SelfHostedRelayConfigError();
    }
  }
  const controlCa = yield* readCa(resolve(config.controlCaPath));
  const ca = yield* readCa(resolve(config.caPath));
  const pair = yield* readPair(resolve(config.certPath), resolve(config.keyPath));
  const hookAuthority =
    config.hookAuthority === undefined
      ? undefined
      : {
          relayId: config.hookAuthority.relayId,
          publicKey: yield* readHookKey(resolve(config.hookAuthority.publicKeyPath), "public"),
          ...(hookOrigin === undefined ? {} : { hookOrigin }),
        };
  return {
    environmentId: config.environmentId,
    publicOrigin: config.publicOrigin,
    canonicalOrigin: config.canonicalOrigin,
    controlOrigin: config.controlOrigin,
    controlCa,
    controlFingerprint: config.controlFingerprint.toUpperCase(),
    publisherCredential,
    ...(directTerminatorToken === undefined ? {} : { directTerminatorToken }),
    ...(hookAuthority === undefined ? {} : { hookAuthority }),
    relayFingerprint: config.relayFingerprint.toUpperCase(),
    relay: {
      ...pair,
      ca,
      host: config.relayHost,
      port: config.relayPort,
      servername: config.relayServername,
    },
  };
});
