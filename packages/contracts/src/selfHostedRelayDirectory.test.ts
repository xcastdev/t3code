import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import {
  SELF_HOSTED_RELAY_DIRECTORY_MAX_HINTS,
  SELF_HOSTED_RELAY_DIRECTORY_MAX_URL_LENGTH,
  SelfHostedRelayDirectoryDiscovery,
  SelfHostedRelayDirectoryPublication,
} from "./selfHostedRelayDirectory.ts";

const decodePublication = Schema.decodeUnknownSync(SelfHostedRelayDirectoryPublication);
const publication = { version: 1, environmentId: "env-a", addressHints: [] };

it("describes each route kind with a versioned, origin-only address hint", () => {
  const addressHints = [
    { kind: "lan", httpBaseUrl: "http://192.168.0.10:4173/" },
    { kind: "tailnet", httpBaseUrl: "http://dev.example.ts.net" },
    { kind: "vpn", httpBaseUrl: "http://[fd00::1]:4173" },
    { kind: "public", httpBaseUrl: "https://dev.example.com" },
    { kind: "relay", httpBaseUrl: "https://relay.example.com" },
  ];
  expect(decodePublication({ ...publication, addressHints })).toEqual({
    ...publication,
    addressHints,
  });
  const discovery = { version: 1, environments: [] };
  const decodeDiscovery = Schema.decodeUnknownSync(SelfHostedRelayDirectoryDiscovery);
  expect(decodeDiscovery(discovery)).toEqual(discovery);
  expect(() => decodeDiscovery({ ...discovery, version: 2 })).toThrow();
  expect(() => decodePublication({ ...publication, version: 2 })).toThrow();
  expect(() => decodePublication({ ...publication, credential: "secret" })).toThrow();
  expect(() =>
    decodePublication({
      ...publication,
      addressHints: [
        { kind: "public", httpBaseUrl: "https://relay.example.com", tlsSpki: "untrusted" },
      ],
    }),
  ).toThrow();
});

it.each([
  ["lan", "//intranet.example"],
  ["lan", "http://name:secret@intranet.example"],
  ["lan", "http://@intranet.example"],
  ["lan", "http://intranet.example?token=secret"],
  ["lan", "http://intranet.example?"],
  ["lan", "http://intranet.example#secret"],
  ["lan", "http://intranet.example/secret/.."],
  ["lan", "http://intranet.example\\secret"],
  ["lan", "http://intranet.example\n"],
  ["lan", "ftp://intranet.example"],
  ["lan", "http://[gggg::1]"],
  ["public", "http://public.example"],
  ["relay", "http://relay.example"],
])("rejects invalid %s hint %s", (kind, httpBaseUrl) => {
  expect(() =>
    decodePublication({ ...publication, addressHints: [{ kind, httpBaseUrl }] }),
  ).toThrow();
});

it("bounds the hint count and individual URL lengths", () => {
  const addressHints = Array.from(
    { length: SELF_HOSTED_RELAY_DIRECTORY_MAX_HINTS },
    (_, index) => ({ kind: "lan", httpBaseUrl: `http://intranet-${index}.example` }),
  );
  expect(decodePublication({ ...publication, addressHints }).addressHints).toHaveLength(
    SELF_HOSTED_RELAY_DIRECTORY_MAX_HINTS,
  );
  expect(() =>
    decodePublication({ ...publication, addressHints: [...addressHints, addressHints[0]] }),
  ).toThrow();
  expect(() =>
    decodePublication({
      ...publication,
      addressHints: [
        {
          kind: "lan",
          httpBaseUrl: `http://${"a".repeat(SELF_HOSTED_RELAY_DIRECTORY_MAX_URL_LENGTH)}`,
        },
      ],
    }),
  ).toThrow();
});
