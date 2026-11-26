// @effect-diagnostics nodeBuiltinImport:off -- Exercise file modes and symlinks against real temporary files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Redacted from "effect/Redacted";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  loadDesktopRelayCredentials,
  parseRelayHttp,
  parseRelaySocket,
} from "./DesktopRelayPolicy.ts";

const platform = NodePath.sep === "\\" ? "win32" : "linux";
const origin = "https://relay.example:9443";
const enrollment = {
  origin,
  environmentId: "env-1",
  hostname: "relay.example",
  spkiSha256: Buffer.alloc(32).toString("base64"),
  transportRole: "relay",
} as const;
const asset = `${origin}/api/assets/claims.signature/a%2Fb?part=A%2fb+%20&order=2&order=1`;
const http = { url: asset, method: "GET", headers: [], body: false };

effectIt.effect("preserves the signed target and accepts only destination headers", () =>
  Effect.gen(function* () {
    expect(
      parseRelayHttp({
        ...http,
        headers: [
          ["Authorization", "DPoP destination"],
          ["DPoP", "proof"],
          ["Range", "bytes=1-2"],
          ["x-t3-media-download", "sha-256"],
          ["b3", "0123456789abcdef-0123456789abcdef-1"],
          ["x-t3-orchestration-protocol", "2"],
        ],
      })?.target,
    ).toBe("/api/assets/claims.signature/a%2Fb?part=A%2fb+%20&order=2&order=1");
    for (const header of [
      "Origin",
      "Expect",
      "Host",
      "Proxy-Authorization",
      "X-T3-Relay-Session",
      "Cookie",
      "Connection",
    ]) {
      expect(parseRelayHttp({ ...http, headers: [[header, "no"]] })).toBeNull();
    }
    expect(parseRelayHttp({ ...http, method: "POST" })).toBeNull();
    expect(parseRelayHttp({ ...http, headers: [["x-t3-media-download", "sha-512"]] })).toBeNull();
    expect(
      parseRelayHttp({
        ...http,
        url: `${origin}/api/orchestration/shell`,
        headers: [["x-t3-media-download", "sha-256"]],
      }),
    ).toBeNull();
    expect(parseRelayHttp({ ...http, url: `${origin}/api/../api/assets/x/y` })).toBeNull();
    expect(
      parseRelayHttp({
        ...http,
        url: `${origin}/.well-known/t3/relay-browser/tickets`,
        method: "POST",
      }),
    ).toBeNull();
    expect(parseRelayHttp({ ...http, redirect: "follow" })).toBeNull();
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        expect(request.headers.b3).toEqual(expect.any(String));
        const parsed = parseRelayHttp({
          url: url.href,
          method: request.method,
          headers: Object.entries(request.headers),
          body: false,
        });
        expect(parsed?.headers["x-t3-orchestration-protocol"]).toBe("2");
        return HttpClientResponse.fromWeb(request, new Response());
      }),
    );
    yield* client.get(`${origin}/api/orchestration/shell`, {
      headers: { "x-t3-orchestration-protocol": "2" },
    });
  }),
);

it("requires a destination ticket and preserves its upgrade query and protocol offers", () => {
  const socket = {
    kind: "socket",
    url: "wss://relay.example:9443/ws?wsTicket=a%2fb&dpop=abc",
    protocols: ["app.v1", "app.v2"],
  };
  expect(parseRelaySocket(socket)?.target).toBe("/ws?wsTicket=a%2fb&dpop=abc");
  expect(parseRelaySocket({ ...socket, url: "wss://relay.example:9443/ws" })).toBeNull();
  expect(parseRelaySocket({ ...socket, protocols: ["t3-relay.private"] })).toBeNull();
});

it("reads only a private regular file bound to the exact enrolled relay", () => {
  const directory = NodeFS.realpathSync.native(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "desktop-relay-test-")),
  );
  try {
    const credentialFile = NodePath.join(directory, "credential");
    NodeFS.writeFileSync(credentialFile, "private-fixture\n", { mode: 0o600 });
    const config = (fields: object = {}) =>
      JSON.stringify([
        {
          origin,
          environmentId: enrollment.environmentId,
          spkiSha256: enrollment.spkiSha256,
          credentialFile,
          ...fields,
        },
      ]);
    expect(loadDesktopRelayCredentials(config(), [enrollment], platform).get(origin)).toEqual(
      Redacted.make("private-fixture"),
    );
    expect(() =>
      loadDesktopRelayCredentials(config({ environmentId: "other" }), [enrollment], platform),
    ).toThrow("Invalid desktop relay");
    expect(() =>
      loadDesktopRelayCredentials(config({ spkiSha256: "wrong" }), [enrollment], platform),
    ).toThrow("Invalid desktop relay");
    if (platform !== "win32") {
      const link = NodePath.join(directory, "link");
      NodeFS.symlinkSync(credentialFile, link);
      expect(() =>
        loadDesktopRelayCredentials(config({ credentialFile: link }), [enrollment], platform),
      ).toThrow("Invalid desktop relay");
      NodeFS.chmodSync(credentialFile, 0o644);
      expect(() => loadDesktopRelayCredentials(config(), [enrollment], platform)).toThrow(
        "Invalid desktop relay",
      );
    }
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
