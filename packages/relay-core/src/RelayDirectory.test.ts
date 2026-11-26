// @effect-diagnostics nodeBuiltinImport:off -- The test runtime uses a disposable SQLite directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { SelfHostedRelayDirectoryPublication } from "@t3tools/contracts/selfHostedRelayDirectory";
import type { SelfHostedRelayIssuePairingInput } from "@t3tools/contracts/selfHostedRelay";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import * as RelayDirectory from "./RelayDirectory.ts";
import * as RelayRuntime from "./RelayRuntime.ts";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");
const missingEnvironment = EnvironmentId.make("missing-environment");

const lan = { kind: "lan", httpBaseUrl: "http://192.168.0.10:4173" } as const;
const publicHint = { kind: "public", httpBaseUrl: "https://public.example" } as const;

function publication(
  environmentId: EnvironmentId,
  addressHints: SelfHostedRelayDirectoryPublication["addressHints"] = [lan],
): SelfHostedRelayDirectoryPublication {
  return { version: 1, environmentId, addressHints };
}

const testLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-relay-directory-"))),
    (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
  ).pipe(
    Effect.map((homeDirectory) =>
      RelayDirectory.layer.pipe(
        Layer.provideMerge(RelayRuntime.relayRuntimeLayer({ homeDirectory })),
      ),
    ),
  ),
);

const setup = Effect.fn("RelayDirectoryTest.setup")(function* () {
  const relay = yield* RelayRuntime.RelayRuntime;
  const directory = yield* RelayDirectory.RelayDirectory;
  const owner = yield* relay.bootstrapOwner();
  for (const environmentId of [environmentA, environmentB]) {
    yield* relay.enrollEnvironment(owner.credential, {
      version: 1,
      environmentId,
      name: environmentId,
    });
  }
  const pair = Effect.fn("RelayDirectoryTest.pair")(function* (
    subject: SelfHostedRelayIssuePairingInput["subject"],
    permissions: SelfHostedRelayIssuePairingInput["scope"]["permissions"],
    environmentId: EnvironmentId,
  ) {
    const pairing = yield* relay.issuePairing(owner.credential, {
      version: 1,
      subject,
      scope: { permissions, environments: { kind: "selected", environmentIds: [environmentId] } },
      expiresAt: "2099-01-01T00:00:00Z",
    });
    return yield* relay.redeemPairing(pairing.credential);
  });
  const publisher = (environmentId: EnvironmentId) =>
    pair({ kind: "publisher", environmentId }, ["environment.publish"], environmentId);
  const reader = yield* pair({ kind: "client" }, ["discovery.read"], environmentA);
  return { relay, directory, owner, publisher, reader };
});

it.effect("authorizes only the publisher's own enrolled environment", () =>
  Effect.gen(function* () {
    const { directory, publisher, reader } = yield* setup();
    const session = yield* publisher(environmentA);
    const unknown = yield* publisher(missingEnvironment);
    for (const [credential, environmentId, failure] of [
      [session.credential, environmentB, "RelayAccessDeniedError"],
      [unknown.credential, missingEnvironment, "RelayAccessDeniedError"],
      [reader.credential, environmentA, "RelayAccessDeniedError"],
      ["invalid", environmentA, "RelayAuthenticationError"],
    ] as const) {
      const error = yield* Effect.flip(
        directory.openPublisher(credential, publication(environmentId)),
      );
      assert.equal(error._tag, failure);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("returns hints only for scoped discovery without granting forwarding", () =>
  Effect.gen(function* () {
    const { relay, directory, owner, publisher, reader } = yield* setup();
    const a = yield* publisher(environmentA);
    const b = yield* publisher(environmentB);
    yield* directory.openPublisher(a.credential, publication(environmentA));
    yield* directory.openPublisher(b.credential, publication(environmentB, [publicHint]));

    assert.deepEqual(yield* directory.discover(reader.credential), {
      version: 1,
      environments: [
        {
          version: 1,
          relayId: owner.relayId,
          environmentId: environmentA,
          name: environmentA,
          addressHints: [lan],
        },
      ],
    });
    assert.equal(
      (yield* Effect.flip(directory.discover(reader.credential, environmentB)))._tag,
      "RelayAccessDeniedError",
    );
    assert.equal(
      (yield* Effect.flip(directory.discover(a.credential)))._tag,
      "RelayAccessDeniedError",
    );
    assert.equal(
      (yield* Effect.flip(
        relay.authorizeLive(reader.credential, { kind: "forward", environmentId: environmentA }),
      ))._tag,
      "RelayAccessDeniedError",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("drops revoked hints and prevents updates from the revoked lease", () =>
  Effect.gen(function* () {
    const { relay, directory, owner, publisher } = yield* setup();
    const session = yield* publisher(environmentA);
    const lease = yield* directory.openPublisher(session.credential, publication(environmentA));
    yield* relay.revokeSession(owner.credential, session.sessionId);
    assert.isTrue(lease.signal.aborted);
    assert.deepEqual(
      (yield* directory.discover(owner.credential, environmentA)).environments[0]?.addressHints,
      [],
    );
    assert.equal(
      (yield* Effect.flip(lease.replace(publication(environmentA, [publicHint]))))._tag,
      "RelayDirectoryPublisherClosedError",
    );
    assert.equal(
      (yield* Effect.flip(directory.openPublisher(session.credential, publication(environmentA))))
        ._tag,
      "RelayAuthenticationError",
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("removes hints on stream close and frees the single publisher slot", () =>
  Effect.gen(function* () {
    const { directory, owner, publisher } = yield* setup();
    const session = yield* publisher(environmentA);
    const initial = publication(environmentA);
    const oldLease = yield* Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* directory.openPublisher(session.credential, initial);
        assert.equal(
          (yield* Effect.flip(directory.openPublisher(session.credential, initial)))._tag,
          "RelayDirectoryPublisherLimitError",
        );
        assert.equal(
          (yield* Effect.flip(lease.replace(publication(environmentB, [publicHint]))))._tag,
          "RelayAccessDeniedError",
        );
        yield* lease.replace(publication(environmentA, [publicHint]));
        assert.deepEqual(
          (yield* directory.discover(owner.credential, environmentA)).environments[0]?.addressHints,
          [publicHint],
        );
        return lease;
      }),
    );
    assert.isTrue(oldLease.signal.aborted);
    assert.deepEqual(
      (yield* directory.discover(owner.credential, environmentA)).environments[0]?.addressHints,
      [],
    );
    yield* directory.openPublisher(session.credential, initial);
    assert.equal(
      (yield* Effect.flip(oldLease.replace(publication(environmentA, [publicHint]))))._tag,
      "RelayDirectoryPublisherClosedError",
    );
    assert.deepEqual(
      (yield* directory.discover(owner.credential, environmentA)).environments[0]?.addressHints,
      [lan],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects publisher-supplied verification and keeps the last valid snapshot", () =>
  Effect.gen(function* () {
    const { directory, owner, publisher } = yield* setup();
    const session = yield* publisher(environmentA);
    const injected = { ...publication(environmentA), credential: "destination-secret" };
    assert.equal(
      (yield* Effect.flip(directory.openPublisher(session.credential, injected)))._tag,
      "RelayInputError",
    );
    const lease = yield* directory.openPublisher(session.credential, publication(environmentA));
    for (const candidate of [
      { ...publicHint, tlsSpki: "publisher-controlled" },
      { ...publicHint, upstreamBinding: "publisher-controlled" },
      { ...publicHint, httpBaseUrl: "https://public.example/?token=secret" },
    ]) {
      assert.equal(
        (yield* Effect.flip(
          lease.replace({ ...publication(environmentA), addressHints: [candidate] }),
        ))._tag,
        "RelayInputError",
      );
    }
    assert.deepEqual(
      (yield* directory.discover(owner.credential, environmentA)).environments[0]?.addressHints,
      [lan],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("caps active publishers relay-wide and admits a new publisher after a slot closes", () =>
  Effect.gen(function* () {
    const { relay, directory, owner, publisher } = yield* setup();
    const first = yield* publisher(environmentA);
    const firstScope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(firstScope, exit));
    yield* directory
      .openPublisher(first.credential, publication(environmentA))
      .pipe(Scope.provide(firstScope));

    for (let index = 1; index < 256; index++) {
      const environmentId = EnvironmentId.make(`capacity-${index}`);
      yield* relay.enrollEnvironment(owner.credential, {
        version: 1,
        environmentId,
        name: environmentId,
      });
      const session = yield* publisher(environmentId);
      yield* directory.openPublisher(session.credential, publication(environmentId));
    }
    const next = yield* publisher(environmentB);
    const error = yield* Effect.flip(
      directory.openPublisher(next.credential, publication(environmentB)),
    );
    assert.equal(error._tag, "RelayDirectoryPublisherLimitError");
    if (error._tag === "RelayDirectoryPublisherLimitError") assert.equal(error.reason, "capacity");

    yield* Scope.close(firstScope, Exit.void);
    yield* directory.openPublisher(next.credential, publication(environmentB));
    assert.deepEqual(
      (yield* directory.discover(owner.credential, environmentB)).environments[0]?.addressHints,
      [lan],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect("does not expose hints published after the discovery authorization snapshot", () =>
  Effect.gen(function* () {
    const { relay, owner, publisher, reader } = yield* setup();
    const session = yield* publisher(environmentA);
    const checked = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const runtime = {
      ...relay,
      discoverEnvironments: (...args: Parameters<typeof relay.discoverEnvironments>) =>
        relay.discoverEnvironments(...args).pipe(
          Effect.tap(() => Deferred.succeed(checked, undefined)),
          Effect.tap(() => Deferred.await(resume)),
        ),
    };
    yield* Effect.gen(function* () {
      const directory = yield* RelayDirectory.RelayDirectory;
      const lease = yield* directory.openPublisher(session.credential, publication(environmentA));
      const discovery = yield* directory.discover(reader.credential).pipe(Effect.forkChild);
      yield* Deferred.await(checked);
      yield* relay.revokeSession(owner.credential, reader.sessionId);
      yield* lease.replace(publication(environmentA, [publicHint]));
      yield* Deferred.succeed(resume, undefined);
      assert.deepEqual((yield* Fiber.join(discovery)).environments[0]?.addressHints, [lan]);
      assert.equal(
        (yield* Effect.flip(directory.discover(reader.credential)))._tag,
        "RelayAuthenticationError",
      );
    }).pipe(
      Effect.provide(
        Layer.fresh(RelayDirectory.layer).pipe(
          Layer.provide(Layer.succeed(RelayRuntime.RelayRuntime, runtime)),
        ),
      ),
    );
  }).pipe(Effect.provide(testLayer)),
);
