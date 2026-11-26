// @effect-diagnostics nodeBuiltinImport:off -- The test owns its SQLite authority and TLS listeners.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { RELAY_ADMISSION_HEADER, RELAY_ADMISSION_PATH } from "@t3tools/contracts/relay";

import { createRelayOriginRegistry, openRelayOriginRegistry } from "./RelayOriginRegistry.ts";
import { makeRelayProofEdge } from "./RelayProofEdge.ts";
import { proofRequest, serveLoopback } from "./fixtures/p1bIngress.testkit.ts";

const tls = {
  cert: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-cert.pem", import.meta.url)),
  key: NodeFS.readFileSync(new URL("../peer/fixtures/localhost-key.pem", import.meta.url)),
  ca: NodeFS.readFileSync(new URL("./fixtures/p1b-ingress-client-cert.pem", import.meta.url)),
};
const publicOrigin = "https://localhost";
const options = {
  publicOrigin,
  canonicalOrigin: "https://environment.test",
  environmentId: "enrolled",
  tunnelTls: tls,
  environmentFingerprint: new NodeCrypto.X509Certificate(tls.ca).fingerprint256,
};
const probe = (url: string) =>
  proofRequest(url, {
    method: "HEAD",
    path: RELAY_ADMISSION_PATH,
    headers: { host: "localhost" },
  });

it.live("refuses to serve a stale origin assignment at the HTTPS edge", () =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-registered-relay-"))),
      (folder) => Effect.sync(() => NodeFS.rmSync(folder, { recursive: true, force: true })),
    );
    const authorityPath = NodePath.join(root, "authority.sqlite");
    {
      using registry = createRelayOriginRegistry(authorityPath);
      registry.register(publicOrigin, options.environmentId);
    }
    const backup = NodePath.join(root, "relay-runtime.sqlite");
    NodeFS.copyFileSync(authorityPath, backup);

    const first = yield* Effect.acquireDisposable(
      Effect.sync(() => makeRelayProofEdge({ ...options, authorityPath })),
    );
    const listener = yield* serveLoopback(NodeHttps.createServer(tls, first.request));
    const active = yield* Effect.promise(() => probe(listener));
    expect(active.status).toBe(204);
    expect(active.headers[RELAY_ADMISSION_HEADER.toLowerCase()]).toBe("active");
    NodeFS.renameSync(authorityPath, `${authorityPath}.unavailable`);
    expect((yield* Effect.promise(() => probe(listener))).status).toBe(404);
    NodeFS.renameSync(`${authorityPath}.unavailable`, authorityPath);
    first.retire();
    {
      using staleRuntime = openRelayOriginRegistry(backup);
      expect(staleRuntime.lookup(publicOrigin).status).toBe("active");
    }

    const retired = yield* Effect.acquireDisposable(
      Effect.sync(() => makeRelayProofEdge({ ...options, authorityPath })),
    );
    const restarted = yield* serveLoopback(NodeHttps.createServer(tls, retired.request));
    const result = yield* Effect.promise(() => probe(restarted));
    expect(result.status).toBe(410);
    expect(result.headers[RELAY_ADMISSION_HEADER.toLowerCase()]).toBe("retired");

    const different = yield* Effect.acquireDisposable(
      Effect.sync(() => makeRelayProofEdge({ ...options, authorityPath, environmentId: "other" })),
    );
    const badAssignment = yield* serveLoopback(NodeHttps.createServer(tls, different.request));
    expect((yield* Effect.promise(() => probe(badAssignment))).status).toBe(404);
  }),
);
