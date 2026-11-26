// @effect-diagnostics nodeBuiltinImport:off -- The fixture keeps real HTTP request bodies open.
import * as NodeHttp from "node:http";
import * as NodeReadline from "node:readline";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { SelfHostedRelayIssuePairingInput } from "@t3tools/contracts/selfHostedRelay";
import type { SelfHostedRelayDirectoryPublication } from "@t3tools/contracts/selfHostedRelayDirectory";
import * as RelayDirectory from "@t3tools/relay-core/RelayDirectory";
import { RelayRuntime, relayRuntimeLayer } from "@t3tools/relay-core/RelayRuntime";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpRouter, HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NetAddress from "effect/net/NetAddress";
import { fetch, type Response } from "undici";

import * as SelfHostedRelayApplication from "./SelfHostedRelayApplication.ts";
import * as SelfHostedRelayDirectoryHttp from "./SelfHostedRelayDirectoryHttp.ts";

const path = "/api/self-hosted-relay/v1";
const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const hint = { kind: "lan", httpBaseUrl: "http://192.168.0.10:4173" } as const;
const frame = (environmentId: EnvironmentId) =>
  JSON.stringify({ version: 1, environmentId, addressHints: [hint] });
const auth = (credential: string) => ({ authorization: `Bearer ${credential}` });

const prepareRelay = Effect.fn("SelfHostedRelayDirectoryHttpTest.prepareRelay")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-directory-http-" });
  const { owner, reader, publisher } = yield* Effect.gen(function* () {
    const relay = yield* RelayRuntime;
    const owner = yield* relay.bootstrapOwner();
    for (const environmentId of [environmentA, environmentB]) {
      yield* relay.enrollEnvironment(owner.credential, {
        version: 1,
        environmentId,
        name: environmentId,
      });
    }
    const pair = Effect.fn("SelfHostedRelayDirectoryHttpTest.pair")(function* (
      subject: SelfHostedRelayIssuePairingInput["subject"],
      permission: "discovery.read" | "environment.publish",
    ) {
      const pairing = yield* relay.issuePairing(owner.credential, {
        version: 1,
        subject,
        scope: {
          permissions: [permission],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
        expiresAt: "2099-01-01T00:00:00Z",
      });
      return yield* relay.redeemPairing(pairing.credential);
    });
    const reader = yield* pair({ kind: "client" }, "discovery.read");
    const publisher = yield* pair(
      { kind: "publisher", environmentId: environmentA },
      "environment.publish",
    );
    return { owner, reader, publisher };
  }).pipe(Effect.provide(relayRuntimeLayer({ homeDirectory })));
  return { homeDirectory, owner, reader, publisher };
});

const setup = Effect.fn("SelfHostedRelayDirectoryHttpTest.setup")(function* () {
  const { homeDirectory, owner, reader, publisher } = yield* prepareRelay();
  let origin = "";
  const logger = Logger.make(({ message }) => {
    origin ||=
      /Self-hosted relay listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(String(message))?.[1] ?? "";
  });
  yield* Layer.build(
    SelfHostedRelayApplication.layer({ homeDirectory, port: 0 }).pipe(
      Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
    ),
  );
  assert.isNotEmpty(origin);
  return { origin, owner, reader, publisher };
});

function publish(origin: string, credential: string, signal?: AbortSignal) {
  const request = NodeHttp.request(`${origin}${path}/directory/publisher`, {
    method: "POST",
    headers: { ...auth(credential), "content-type": "application/x-ndjson" },
    signal,
  });
  const response = new Promise<NodeHttp.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  return { request, response };
}

async function accepted(publisher: ReturnType<typeof publish>) {
  const response = await publisher.response;
  assert.equal(response.statusCode, 200);
  const lines = NodeReadline.createInterface({ input: response, terminal: false })[
    Symbol.asyncIterator
  ]();
  assert.deepEqual(await lines.next(), { value: '{"version":1,"status":"accepted"}', done: false });
  return lines;
}

function assertDiscovery(
  response: Response,
  environmentId: EnvironmentId,
  relayId: string,
  addressHints: SelfHostedRelayDirectoryPublication["addressHints"],
) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.json().then((body) => {
    assert.deepEqual(body, {
      version: 1,
      environments: [{ version: 1, relayId, environmentId, name: environmentId, addressHints }],
    });
  });
}

it.live("shares scoped directory publications and session revocation with the P3 routes", () =>
  Effect.gen(function* () {
    const { origin, owner, reader, publisher } = yield* setup();
    yield* Effect.promise(async (signal) => {
      const stream = publish(origin, publisher.credential, signal);
      stream.request.write(frame(environmentA) + "\n");
      const lines = await accepted(stream);

      const discover = (suffix = "") =>
        fetch(`${origin}${path}/directory${suffix}`, { headers: auth(reader.credential), signal });
      await assertDiscovery(await discover(), environmentA, owner.relayId, [hint]);
      await assertDiscovery(
        await discover("?environmentId=environment-a"),
        environmentA,
        owner.relayId,
        [hint],
      );
      const forbidden = await discover("?environmentId=environment-b");
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await forbidden.json(), { version: 1, error: "access_denied" });
      for (const query of ["%ZZ", "%FF", "%E2%82", "%"]) {
        const invalid = await discover(`?environmentId=${query}`);
        assert.equal(invalid.status, 400);
        assert.deepEqual(await invalid.json(), { version: 1, error: "invalid_request" });
      }
      for (const query of ["%25", "%E2%82%AC"]) {
        assert.equal((await discover(`?environmentId=${query}`)).status, 403);
      }

      const revoke = await fetch(`${origin}${path}/sessions/${publisher.sessionId}`, {
        method: "DELETE",
        headers: auth(owner.credential),
        signal,
      });
      assert.equal(revoke.status, 204);
      assert.isTrue((await lines.next()).done);
      await assertDiscovery(await discover(), environmentA, owner.relayId, []);
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("replaces hints from later frames and withdraws them on an abrupt client disconnect", () =>
  Effect.gen(function* () {
    const { homeDirectory, owner, reader, publisher } = yield* prepareRelay();
    const replaced = yield* Deferred.make<void>();
    const closed = yield* Deferred.make<void>();
    const observed = Layer.effect(
      RelayDirectory.RelayDirectory,
      Effect.gen(function* () {
        const directory = yield* RelayDirectory.RelayDirectory;
        const openPublisher = Effect.fn("SelfHostedRelayDirectoryHttpTest.observePublisher")(
          function* (credential: string, input: unknown) {
            const lease = yield* directory.openPublisher(credential, input);
            lease.signal.addEventListener("abort", () => Deferred.doneUnsafe(closed, Effect.void), {
              once: true,
            });
            return {
              ...lease,
              replace: (input: unknown) =>
                lease.replace(input).pipe(Effect.tap(() => Deferred.succeed(replaced, undefined))),
            };
          },
        );
        return RelayDirectory.RelayDirectory.of({ ...directory, openPublisher });
      }),
    );
    const listener = NodeHttpServer.layerServer(() => NodeHttp.createServer(), {
      host: "127.0.0.1",
      port: 0,
      gracefulShutdownTimeout: 1_000,
    });
    const context = yield* Layer.build(
      HttpRouter.serve(SelfHostedRelayDirectoryHttp.layer, {
        disableLogger: true,
        disableListenLog: true,
      }).pipe(
        Layer.provide(observed),
        Layer.provide(RelayDirectory.layer),
        Layer.provide(relayRuntimeLayer({ homeDirectory })),
        Layer.provideMerge(listener),
      ),
    );
    const { address } = Context.get(context, HttpServer.HttpServer);
    const origin = `http://${NetAddress.formatSocketAddress(address)}`;
    const stream = yield* Effect.acquireRelease(
      Effect.sync(() => publish(origin, publisher.credential)),
      ({ request }) => Effect.sync(() => request.destroy()),
    );
    const discover = Effect.fn("SelfHostedRelayDirectoryHttpTest.discover")(function* (
      hints: SelfHostedRelayDirectoryPublication["addressHints"],
    ) {
      yield* Effect.promise(async (signal) =>
        assertDiscovery(
          await fetch(`${origin}${path}/directory`, { headers: auth(reader.credential), signal }),
          environmentA,
          owner.relayId,
          hints,
        ),
      );
    });
    yield* Effect.promise(async () => {
      stream.request.write(frame(environmentA) + "\n");
      await accepted(stream);
    });
    const replacement = { kind: "public", httpBaseUrl: "https://public.example" } as const;
    yield* Effect.sync(() => {
      stream.request.write(
        JSON.stringify({ version: 1, environmentId: environmentA, addressHints: [replacement] }) +
          "\n",
      );
    });
    yield* Deferred.await(replaced);
    yield* discover([replacement]);
    yield* Effect.sync(() => stream.request.destroy());
    yield* Deferred.await(closed);
    yield* discover([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "rejects a publisher credential for another environment and binds later frames to the first",
  () =>
    Effect.gen(function* () {
      const { origin, owner, reader, publisher } = yield* setup();
      yield* Effect.promise(async (signal) => {
        for (const [credential, status, error] of [
          [publisher.credential, 403, "access_denied"],
          ["bogus-credential", 401, "invalid_credential"],
        ] as const) {
          const rejected = await fetch(`${origin}${path}/directory/publisher`, {
            method: "POST",
            headers: { ...auth(credential), "content-type": "application/x-ndjson" },
            body: frame(environmentB) + "\n",
            signal,
          });
          assert.equal(rejected.status, status);
          assert.deepEqual(await rejected.json(), { version: 1, error });
        }

        const stream = publish(origin, publisher.credential, signal);
        stream.request.write(frame(environmentA) + "\n");
        const lines = await accepted(stream);
        stream.request.write(frame(environmentB) + "\n");
        assert.deepEqual(await lines.next(), {
          value: '{"version":1,"error":"access_denied"}',
          done: false,
        });
        assert.isTrue((await lines.next()).done);
        await assertDiscovery(
          await fetch(`${origin}${path}/directory`, { headers: auth(reader.credential), signal }),
          environmentA,
          owner.relayId,
          [],
        );
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "bounds both initial and later frames by bytes and releases the slot after overflow or EOF",
  () =>
    Effect.gen(function* () {
      const { origin, owner, reader, publisher } = yield* setup();
      yield* Effect.promise(async (signal) => {
        const oversized = "é".repeat(8 * 1024 + 1);
        const rejected = publish(origin, publisher.credential, signal);
        rejected.request.write(oversized.slice(0, 8192));
        rejected.request.write(oversized.slice(8192));
        const rejection = await rejected.response;
        assert.equal(rejection.statusCode, 413);
        let error = "";
        for await (const chunk of rejection) error += String(chunk);
        assert.deepEqual(JSON.parse(error), { version: 1, error: "frame_too_large" });

        const stream = publish(origin, publisher.credential, signal);
        const boundary = frame(environmentA).padEnd(16 * 1024) + "\n";
        stream.request.write(boundary.slice(0, 8192));
        stream.request.write(boundary.slice(8192));
        const lines = await accepted(stream);
        stream.request.write(oversized);
        assert.deepEqual(await lines.next(), {
          value: '{"version":1,"error":"frame_too_large"}',
          done: false,
        });
        assert.isTrue((await lines.next()).done);

        const replacement = publish(origin, publisher.credential, signal);
        replacement.request.write(frame(environmentA) + "\n");
        const next = await accepted(replacement);
        replacement.request.end();
        assert.isTrue((await next.next()).done);
        await assertDiscovery(
          await fetch(`${origin}${path}/directory`, { headers: auth(reader.credential), signal }),
          environmentA,
          owner.relayId,
          [],
        );
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);
