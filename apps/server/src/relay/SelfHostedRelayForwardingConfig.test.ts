// @effect-diagnostics nodeBuiltinImport:off -- Locate the checked-in TLS fixtures with Node's file URL conversion.
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { expect } from "vite-plus/test";

import {
  loadSelfHostedRelayConnectorConfig,
  loadSelfHostedRelayForwardingConfig,
} from "./SelfHostedRelayForwardingConfig.ts";

const environmentId = EnvironmentId.make("env-fixture");
const pin = Array.from({ length: 32 }, () => "ab").join(":");
const listen = (port: number) => ({ host: "127.0.0.1", port });
const pair = { certPath: "chain.pem", keyPath: "private.pem" };
const binding = {
  environmentId,
  publicOrigin: "https://localhost:8443",
  canonicalOrigin: "https://environment.example",
  environmentFingerprint: pin,
  tunnelListen: listen(9444),
  tunnelCaPath: "chain.pem",
  tunnelCertPath: "chain.pem",
  tunnelKeyPath: "private.pem",
};
const manifest = {
  version: 1,
  ingress: { listen: listen(8443), certificates: [{ serverNames: ["localhost"], ...pair }] },
  control: { listen: listen(9443), origin: "https://localhost:9443", ...pair },
  bindings: [binding],
};

const secondBinding = {
  ...binding,
  environmentId: EnvironmentId.make("env-second"),
  publicOrigin: "https://relay-push-test:8443",
  canonicalOrigin: "https://second-environment.example",
  environmentFingerprint: pin.replace(/^ab/u, "ea"),
  tunnelListen: listen(9445),
};
const twoBindings = {
  ...manifest,
  ingress: {
    ...manifest.ingress,
    certificates: [
      ...manifest.ingress.certificates,
      { serverNames: ["relay-push-test"], certPath: "second-cert.pem", keyPath: "second-key.pem" },
    ],
  },
  bindings: [binding, secondBinding],
};
const connector = {
  version: 1,
  environmentId,
  publicOrigin: binding.publicOrigin,
  canonicalOrigin: binding.canonicalOrigin,
  controlOrigin: manifest.control.origin,
  controlCaPath: "chain.pem",
  controlFingerprint: pin,
  publisherCredentialPath: "credential",
  relayHost: "127.0.0.1",
  relayPort: 9444,
  relayServername: "localhost",
  relayFingerprint: pin,
  caPath: "chain.pem",
  ...pair,
};
const credential = `t3-session-1.fixture.0.${"a".repeat(43)}`;

const fixture = Effect.fn("SelfHostedRelayForwardingConfigTest.fixture")(function* (
  document: string | Uint8Array,
) {
  const files = yield* FileSystem.FileSystem;
  const directory = yield* files.makeTempDirectoryScoped({ prefix: "t3-relay-config-" });
  const path = `${directory}/manifest.json`;
  const cert = yield* files.readFile(
    NodeURL.fileURLToPath(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
  );
  const key = yield* files.readFile(
    NodeURL.fileURLToPath(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
  );
  yield* files.writeFile(`${directory}/chain.pem`, cert);
  yield* files.writeFile(`${directory}/private.pem`, key);
  yield* files.chmod(`${directory}/private.pem`, 0o600);
  for (const kind of ["cert", "key"]) {
    const pem = yield* files.readFile(
      NodeURL.fileURLToPath(new URL(`./fixtures/relay-push-apns-${kind}.pem`, import.meta.url)),
    );
    yield* files.writeFile(`${directory}/second-${kind}.pem`, pem);
    if (kind === "key") yield* files.chmod(`${directory}/second-${kind}.pem`, 0o600);
  }

  yield* files.writeFileString(`${directory}/credential`, `${credential}\n`);
  yield* files.chmod(`${directory}/credential`, 0o600);
  if (typeof document === "string") yield* files.writeFileString(path, document);
  else yield* files.writeFile(path, document);
  return { path, cert, key, directory };
});

it.effect("loads relative PEM paths and maps the fixed listener into the forwarding binding", () =>
  Effect.gen(function* () {
    const { path, cert, key } = yield* fixture(JSON.stringify(manifest));
    const config = yield* loadSelfHostedRelayForwardingConfig(path);
    expect(config).toEqual({
      ingress: {
        listen: manifest.ingress.listen,
        certificates: [
          { serverNames: ["localhost"], cert: Buffer.from(cert), key: Buffer.from(key) },
        ],
      },
      control: {
        listen: manifest.control.listen,
        origin: manifest.control.origin,
        cert: Buffer.from(cert),
        key: Buffer.from(key),
      },
      bindings: [
        {
          environmentId,
          publicOrigin: binding.publicOrigin,
          canonicalOrigin: binding.canonicalOrigin,
          hostedClientOrigins: [],
          environmentFingerprint: pin.toUpperCase(),
          listen: binding.tunnelListen,
          tunnelTls: { ca: Buffer.from(cert), cert: Buffer.from(cert), key: Buffer.from(key) },
        },
      ],
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("loads distinct aliases, identities, listeners, and publisher pins", () =>
  Effect.gen(function* () {
    const { path } = yield* fixture(JSON.stringify(twoBindings));
    const config = yield* loadSelfHostedRelayForwardingConfig(path);
    expect(config.bindings.map((entry) => entry.publicOrigin)).toEqual([
      binding.publicOrigin,
      secondBinding.publicOrigin,
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "requires a dedicated TLS listener and owner-only Ed25519 signing key for public hooks",
  () =>
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem;
      const hookIngress = {
        listen: listen(9555),
        origin: "https://localhost:9555",
        ...pair,
        signingKeyPath: "hook-signer.pem",
      };
      const { path, directory } = yield* fixture(JSON.stringify({ ...manifest, hookIngress }));
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const privatePath = `${directory}/hook-signer.pem`;
      yield* files.writeFileString(privatePath, privateKey, { mode: 0o600 });
      const load = loadSelfHostedRelayForwardingConfig(path);
      expect((yield* load).hookIngress).toMatchObject({
        listen: hookIngress.listen,
        origin: hookIngress.origin,
        signingKey: privateKey,
      });
      if ((yield* HostProcess.Platform) !== "win32") {
        yield* files.chmod(privatePath, 0o640);
        expect((yield* Effect.result(load))._tag).toBe("Failure");
        yield* files.chmod(privatePath, 0o600);
      }
      yield* files.writeFileString(privatePath, publicKey);
      expect((yield* Effect.result(load))._tag).toBe("Failure");
      yield* files.writeFileString(privatePath, privateKey);
      yield* files.writeFileString(
        path,
        JSON.stringify({
          ...manifest,
          hookIngress: {
            ...hookIngress,
            listen: manifest.control.listen,
            origin: manifest.control.origin,
          },
        }),
      );
      expect((yield* Effect.result(load))._tag).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("loads a pinned relay identity and Ed25519 public key into the connector", () =>
  Effect.gen(function* () {
    const files = yield* FileSystem.FileSystem;
    const relayId = "relay-fixture";
    const hookOrigin = "https://localhost:9555";
    const { path, directory } = yield* fixture(
      JSON.stringify({
        ...connector,
        hookAuthority: { relayId, publicKeyPath: "hook-public.pem", hookOrigin },
      }),
    );
    const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const keyPath = `${directory}/hook-public.pem`;
    yield* files.writeFileString(keyPath, publicKey);
    const load = loadSelfHostedRelayConnectorConfig(path, environmentId);
    expect((yield* load).hookAuthority).toEqual({ relayId, publicKey, hookOrigin });
    if ((yield* HostProcess.Platform) !== "win32") {
      yield* files.chmod(keyPath, 0o664);
      expect((yield* Effect.result(load))._tag).toBe("Failure");
      yield* files.chmod(keyPath, 0o644);
    }
    yield* files.writeFileString(keyPath, privateKey);
    expect((yield* Effect.result(load))._tag).toBe("Failure");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "loads a connector for the initialized environment with a bare publisher credential",
  () =>
    Effect.gen(function* () {
      const { path, cert, key, directory } = yield* fixture(JSON.stringify(connector));
      const config = yield* loadSelfHostedRelayConnectorConfig(path, environmentId);
      expect(config).toEqual({
        environmentId,
        publicOrigin: connector.publicOrigin,
        canonicalOrigin: connector.canonicalOrigin,
        controlOrigin: connector.controlOrigin,
        controlCa: Buffer.from(cert),
        controlFingerprint: pin.toUpperCase(),
        publisherCredential: credential,
        relayFingerprint: pin.toUpperCase(),
        relay: {
          host: connector.relayHost,
          port: connector.relayPort,
          servername: connector.relayServername,
          ca: Buffer.from(cert),
          cert: Buffer.from(cert),
          key: Buffer.from(key),
        },
      });
      const wrongIdentity = yield* Effect.flip(
        loadSelfHostedRelayConnectorConfig(path, EnvironmentId.make("other")).pipe(Effect.asVoid),
      );
      assert.strictEqual(wrongIdentity._tag, "SelfHostedRelayConfigError");
      if ((yield* HostProcess.Platform) !== "win32") {
        const files = yield* FileSystem.FileSystem;
        for (const name of ["credential", "private.pem"]) {
          const filePath = `${directory}/${name}`;
          yield* files.chmod(filePath, 0o644);
          const exposed = yield* Effect.result(
            loadSelfHostedRelayConnectorConfig(path, environmentId),
          );
          assert.equal(exposed._tag, "Failure");
          const windows = yield* loadSelfHostedRelayConnectorConfig(path, environmentId).pipe(
            Effect.provideService(HostProcess.Platform, "win32"),
          );
          assert.equal(windows.publisherCredential, credential);
          yield* files.chmod(filePath, 0o600);
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

const withBinding = (update: Partial<typeof binding> & { hostedClientOrigins?: string[] }) => ({
  ...manifest,
  bindings: [{ ...binding, ...update }],
});

it.effect.each([
  ["malformed JSON", "{"],
  [
    "ambiguous escaped duplicate member",
    JSON.stringify(manifest).replace('"version":1', '"version":2,"versi\\u006fn":1'),
  ],
  [
    "unrecognized nested field",
    JSON.stringify({ ...manifest, control: { ...manifest.control, token: "sensitive-value" } }),
  ],
  ...[
    ["null"],
    ["http://client.example"],
    ["https://*.example"],
    ["https://client.example/path"],
    ["https://user@client.example"],
    ["https://client.example?query"],
    ["https://client.example:443"],
    ["https://client.example", "https://client.example"],
    Array.from({ length: 17 }, (_, index) => `https://client${index}.example`),
  ].map(
    (hostedClientOrigins) =>
      [
        "invalid or unbounded hosted origins",
        JSON.stringify(withBinding({ hostedClientOrigins })),
      ] as const,
  ),
  ["wrong version", JSON.stringify({ ...manifest, version: 2 })],
  ["unsupported UTF-8", Uint8Array.of(0xc0, 0xaf)],
  ["oversized document", JSON.stringify(manifest).padEnd(256 * 1024 + 1)],
  ["non-exact origin", JSON.stringify(withBinding({ publicOrigin: "https://localhost:8443/" }))],
  ["mismatched ingress port", JSON.stringify(withBinding({ publicOrigin: "https://localhost" }))],
  [
    "explicit default port",
    JSON.stringify(withBinding({ canonicalOrigin: "https://environment.example:443" })),
  ],
  [
    "unassigned ingress name",
    JSON.stringify(withBinding({ publicOrigin: "https://alias.example:8443" })),
  ],
  [
    "ingress certificate lacking name coverage",
    JSON.stringify({
      ...withBinding({ publicOrigin: "https://alias.example:8443" }),
      ingress: { ...manifest.ingress, certificates: [{ serverNames: ["alias.example"], ...pair }] },
    }),
  ],
  [
    "duplicate SNI assignment",
    JSON.stringify({
      ...manifest,
      ingress: {
        ...manifest.ingress,
        certificates: [...manifest.ingress.certificates, ...manifest.ingress.certificates],
      },
    }),
  ],
  [
    "control origin with mismatched port",
    JSON.stringify({
      ...manifest,
      control: { ...manifest.control, origin: "https://localhost:9444" },
    }),
  ],
  [
    "control certificate lacking name coverage",
    JSON.stringify({
      ...manifest,
      control: { ...manifest.control, origin: "https://private.example:9443" },
    }),
  ],
  ["ephemeral private tunnel port", JSON.stringify(withBinding({ tunnelListen: listen(0) }))],
  [
    "private listener overlapping control",
    JSON.stringify(withBinding({ tunnelListen: listen(9443) })),
  ],
  [
    "port embedded in listen host",
    JSON.stringify(withBinding({ tunnelListen: { host: "127.0.0.1:22", port: 9444 } })),
  ],
  ["invalid key path", JSON.stringify(withBinding({ tunnelKeyPath: "sensitive-value.pem" }))],
  ["malformed pin", JSON.stringify(withBinding({ environmentFingerprint: "sensitive-value" }))],

  [
    "duplicate environment ID",
    JSON.stringify({ ...twoBindings, bindings: [binding, { ...secondBinding, environmentId }] }),
  ],
  [
    "duplicate public authority",
    JSON.stringify({
      ...twoBindings,
      bindings: [binding, { ...secondBinding, publicOrigin: binding.publicOrigin }],
    }),
  ],
  [
    "duplicate canonical authority",
    JSON.stringify({
      ...twoBindings,
      bindings: [binding, { ...secondBinding, canonicalOrigin: binding.canonicalOrigin }],
    }),
  ],
  [
    "publisher pins equal after normalization",
    JSON.stringify({
      ...twoBindings,
      bindings: [binding, { ...secondBinding, environmentFingerprint: pin.toUpperCase() }],
    }),
  ],
  [
    "TLS key for a different certificate",
    JSON.stringify(withBinding({ tunnelKeyPath: "second-key.pem" })),
  ],
  [
    "unexpected prototype member",
    JSON.stringify(manifest).replace('"version":1', '"__proto__":{"ignored":true},"version":1'),
  ],
] as const)("rejects %s with a sanitized error", ([, document]) =>
  Effect.gen(function* () {
    const { path } = yield* fixture(document);
    const error = yield* Effect.flip(loadSelfHostedRelayForwardingConfig(path).pipe(Effect.asVoid));
    assert.strictEqual(error.message, "Invalid self-hosted relay configuration.");
    expect(JSON.stringify(error)).not.toMatch(/sensitive-value|chain\.pem|manifest\.json|cause/);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  ["whitespace-normalized environment ID", { ...connector, environmentId: " env-fixture " }],
  ["unknown connector field", { ...connector, publisherCredential: "sensitive-value" }],
  ["unpinned control", { ...connector, controlFingerprint: "sensitive-value" }],
  ["invalid tunnel SNI", { ...connector, relayServername: "127.0.0.1" }],
  ["unrecognized private key PEM", { ...connector, keyPath: "credential" }],
])("rejects %s in the separate connector document", ([, document]) =>
  Effect.gen(function* () {
    const { path } = yield* fixture(JSON.stringify(document));
    const error = yield* Effect.flip(
      loadSelfHostedRelayConnectorConfig(path, environmentId).pipe(Effect.asVoid),
    );
    assert.strictEqual(error.message, "Invalid self-hosted relay configuration.");
    expect(JSON.stringify(error)).not.toMatch(/sensitive-value|credential|manifest\.json|cause/);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("loads only a bounded owner-only lowercase hex terminator token", () =>
  Effect.gen(function* () {
    const { path, directory } = yield* fixture(
      JSON.stringify({ ...connector, directTerminatorTokenPath: "terminator-token" }),
    );
    const files = yield* FileSystem.FileSystem;
    const tokenPath = `${directory}/terminator-token`;
    const token = "ab".repeat(32);
    yield* files.writeFileString(tokenPath, token);
    yield* files.chmod(tokenPath, 0o600);
    const load = loadSelfHostedRelayConnectorConfig(path, environmentId);
    expect((yield* load).directTerminatorToken).toBe(token);

    for (const invalid of [
      token.toUpperCase(),
      token.slice(1),
      token.slice(1) + "g",
      token + "\n",
      token.repeat(16),
    ]) {
      yield* files.writeFileString(tokenPath, invalid);
      const error = yield* Effect.flip(load);
      assert.strictEqual(error.message, "Invalid self-hosted relay configuration.");
      expect(JSON.stringify(error)).not.toMatch(/terminator-token|manifest\.json|cause/);
    }
    if ((yield* HostProcess.Platform) !== "win32") {
      yield* files.writeFileString(tokenPath, token);
      yield* files.chmod(tokenPath, 0o640);
      expect((yield* Effect.result(load))._tag).toBe("Failure");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("sanitizes an invalid publisher credential at the file boundary", () =>
  Effect.gen(function* () {
    const { path, directory } = yield* fixture(JSON.stringify(connector));
    const files = yield* FileSystem.FileSystem;
    yield* files.writeFileString(`${directory}/credential`, "sensitive-value\nsecond-line\n");
    const error = yield* Effect.flip(
      loadSelfHostedRelayConnectorConfig(path, environmentId).pipe(Effect.asVoid),
    );
    assert.strictEqual(error.message, "Invalid self-hosted relay configuration.");
    expect(JSON.stringify(error)).not.toMatch(
      /sensitive-value|second-line|credential|manifest\.json|cause/,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
