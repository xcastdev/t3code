// @effect-diagnostics nodeBuiltinImport:off -- Tests inspect a closed SQLite file in a disposable filesystem fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { SelfHostedRelayDeviceId } from "@t3tools/contracts/selfHostedRelay";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import * as RelayRuntime from "./RelayRuntime.ts";

const makeHome = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-relay-runtime-"))),
  (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
);

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function writeRelayDb<A>(home: string, update: (db: NodeSqlite.DatabaseSync) => A): A {
  const writer = new NodeSqlite.DatabaseSync(NodePath.join(home, "relay.sqlite"));
  try {
    return update(writer);
  } finally {
    writer.close();
  }
}

it.effect("keeps an isolated FULL-sync writer and stable identity across scoped shutdown", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    const first = yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const local = yield* relay.localStatus();
      assert.equal(local.state, "uninitialized");
      assert.deepEqual(local.storage, {
        journalMode: "wal",
        synchronous: 2,
        fullfsync: true,
        checkpointFullfsync: true,
      });
      const conflict = yield* Effect.flip(
        RelayRuntime.RelayRuntime.pipe(
          Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })),
        ),
      );
      assert.equal(conflict.reason, "ownership-conflict");
      return yield* relay.bootstrapOwner();
    }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })));

    const files = yield* Effect.promise(() => NodeFSP.readdir(homeDirectory));
    assert.deepEqual(files, ["relay.sqlite"]);
    const reader = new NodeSqlite.DatabaseSync(NodePath.join(homeDirectory, "relay.sqlite"), {
      readOnly: true,
    });
    try {
      const tables = reader.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
      assert.deepEqual(tables.map(({ name }) => name).sort(), [
        "relay_devices",
        "relay_environments",
        "relay_grants",
        "relay_hook_policies",
        "relay_identity",
      ]);
      const persisted = reader.prepare("SELECT session_hash FROM relay_grants").get();
      assert.match(String(persisted?.session_hash), /^[a-f0-9]{64}$/u);
      assert.notEqual(persisted?.session_hash, first.credential);
    } finally {
      reader.close();
    }

    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const status = yield* relay.status(first.credential);
      assert.equal(status.relayId, first.relayId);
      assert.equal(status.state, "ready");
      assert.isFalse(JSON.stringify(status).includes(first.credential));
      const duplicate = yield* Effect.flip(relay.bootstrapOwner());
      assert.equal(duplicate._tag, "RelayRuntimeStateError");
      const recovered = yield* relay.recoverOwner();
      assert.equal(recovered.relayId, first.relayId);
      assert.equal(
        (yield* Effect.flip(relay.status(first.credential)))._tag,
        "RelayAuthenticationError",
      );
      assert.equal((yield* relay.status(recovered.credential)).relayId, first.relayId);
    }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })));
  }),
);

it.effect("fails closed when an existing relay schema has an unsupported version", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    yield* RelayRuntime.RelayRuntime.pipe(
      Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })),
    );
    const writer = new NodeSqlite.DatabaseSync(NodePath.join(homeDirectory, "relay.sqlite"));
    try {
      writer.exec("PRAGMA user_version = 99");
    } finally {
      writer.close();
    }
    const failure = yield* Effect.flip(
      RelayRuntime.RelayRuntime.pipe(
        Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })),
      ),
    );
    assert.equal(failure.reason, "unsupported-version");
  }),
);

it.effect("serializes one-time redemption and revocation and aborts the redeemed live scope", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const owner = yield* relay.bootstrapOwner();
      yield* relay.enrollEnvironment(owner.credential, {
        version: 1,
        environmentId: environmentA,
        name: "A",
      });
      const request = {
        version: 1,
        subject: { kind: "client" },
        scope: {
          permissions: ["status.read", "forward"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      } as const;
      const revokedFirst = yield* relay.issuePairing(owner.credential, request);
      yield* relay.revokePairing(owner.credential, revokedFirst.pairingId);
      assert.equal(
        (yield* Effect.flip(relay.redeemPairing(revokedFirst.credential)))._tag,
        "RelayAuthenticationError",
      );

      const redeemedFirst = yield* relay.issuePairing(owner.credential, request);
      const redemptions = yield* Effect.all(
        [
          Effect.result(relay.redeemPairing(redeemedFirst.credential)),
          Effect.result(relay.redeemPairing(redeemedFirst.credential)),
        ],
        { concurrency: 2 },
      );
      const sessions = redemptions.flatMap((result) =>
        result._tag === "Success" ? [result.success] : [],
      );
      assert.lengthOf(sessions, 1);
      const [session] = sessions;
      assert.isDefined(session);
      const signal = yield* relay.authorizeLive(session.credential, {
        kind: "forward",
        environmentId: environmentA,
      });
      yield* relay.revokePairing(owner.credential, redeemedFirst.pairingId);
      assert.isTrue(signal.aborted);
      assert.equal(
        (yield* Effect.flip(relay.status(session.credential)))._tag,
        "RelayAuthenticationError",
      );

      const raced = yield* relay.issuePairing(owner.credential, request);
      const [redemption] = yield* Effect.all(
        [
          Effect.result(relay.redeemPairing(raced.credential)),
          relay.revokePairing(owner.credential, raced.pairingId),
        ],
        { concurrency: 2 },
      );
      if (redemption._tag === "Success") {
        assert.equal(
          (yield* Effect.flip(relay.authenticate(redemption.success.credential)))._tag,
          "RelayAuthenticationError",
        );
      } else {
        assert.equal(redemption.failure._tag, "RelayAuthenticationError");
      }
    }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })));
  }),
);

it.effect("filters scoped status and discovery without granting forwarding", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const owner = yield* relay.bootstrapOwner();
      yield* relay.enrollEnvironment(owner.credential, {
        version: 1,
        environmentId: environmentA,
        name: "A",
      });
      yield* relay.enrollEnvironment(owner.credential, {
        version: 1,
        environmentId: environmentB,
        name: "B",
      });
      const pairing = yield* relay.issuePairing(owner.credential, {
        version: 1,
        subject: { kind: "client" },
        scope: {
          permissions: ["status.read", "discovery.read"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const reader = yield* relay.redeemPairing(pairing.credential);
      assert.deepEqual(
        (yield* relay.status(reader.credential)).environments.map(({ name }) => name),
        ["A"],
      );
      assert.deepEqual(
        (yield* relay.discoverEnvironments(reader.credential)).map(({ name }) => name),
        ["A"],
      );
      assert.equal(
        (yield* Effect.flip(
          relay.authorizeLive(reader.credential, {
            kind: "forward",
            environmentId: environmentA,
          }),
        ))._tag,
        "RelayAccessDeniedError",
      );
    }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })));
  }),
);

it.effect("rejects damaged persisted authority during startup", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      yield* relay.bootstrapOwner();
    }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })));
    const writer = new NodeSqlite.DatabaseSync(NodePath.join(homeDirectory, "relay.sqlite"));
    try {
      writer.exec("UPDATE relay_grants SET grant_json = '{}'");
    } finally {
      writer.close();
    }
    const failure = yield* Effect.flip(
      RelayRuntime.RelayRuntime.pipe(
        Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })),
      ),
    );
    assert.equal(failure.reason, "invalid-state");
  }),
);

it.effect("validates persisted delegation ceilings on restart", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    const layer = RelayRuntime.relayRuntimeLayer({ homeDirectory });
    const { parent, session, expired, revoked } = yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const owner = yield* relay.bootstrapOwner();
      const pairing = yield* relay.issuePairing(owner.credential, {
        version: 1,
        subject: { kind: "client" },
        scope: {
          permissions: ["access.delegate", "status.read"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const parent = yield* relay.redeemPairing(pairing.credential);
      const request = {
        version: 1,
        subject: { kind: "client" },
        scope: {
          permissions: ["status.read"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
        delegation: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
      } as const;
      const child = yield* relay.issuePairing(parent.credential, request);
      const session = yield* relay.redeemPairing(child.credential);
      const expired = yield* relay.issuePairing(parent.credential, {
        ...request,
        expiresAt: "1970-01-01T00:00:01.000Z",
      });
      const revoked = yield* relay.issuePairing(parent.credential, request);
      yield* relay.revokePairing(parent.credential, revoked.pairingId);
      return { parent, session, expired, revoked };
    }).pipe(Effect.provide(layer));

    yield* TestClock.adjust("2 seconds");
    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      assert.equal(
        (yield* relay.authenticate(session.credential)).grant.grantId,
        session.sessionId,
      );
      for (const pairing of [expired, revoked]) {
        assert.equal(
          (yield* Effect.flip(relay.redeemPairing(pairing.credential)))._tag,
          "RelayAuthenticationError",
        );
      }
    }).pipe(Effect.provide(layer));

    const corruptions = [
      { path: "$.scope.permissions", value: ["status.read", "forward"] },
      { path: "$.scope.environments", value: { kind: "all" } },
      { path: "$.scope.environments.environmentIds", value: [environmentA, environmentB] },
      { path: "$.subject.kind", value: "operator", subjectKind: "operator" },
    ] as const;
    for (const corruption of corruptions) {
      const original = writeRelayDb(homeDirectory, (writer) => {
        const row = writer
          .prepare("SELECT grant_json, subject_kind FROM relay_grants WHERE grant_id = ?")
          .get(session.sessionId);
        assert.isDefined(row);
        writer
          .prepare(
            "UPDATE relay_grants SET grant_json = json_set(grant_json, ?, json(?)), subject_kind = ? WHERE grant_id = ?",
          )
          .run(
            corruption.path,
            JSON.stringify(corruption.value),
            "subjectKind" in corruption ? corruption.subjectKind : (row.subject_kind ?? null),
            session.sessionId,
          );
        return row;
      });
      const result = yield* Effect.result(RelayRuntime.RelayRuntime.pipe(Effect.provide(layer)));
      assert.equal(result._tag, "Failure", corruption.path);
      if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid-state");
      writeRelayDb(homeDirectory, (writer) =>
        writer
          .prepare("UPDATE relay_grants SET grant_json = ?, subject_kind = ? WHERE grant_id = ?")
          .run(original.grant_json ?? null, original.subject_kind ?? null, session.sessionId),
      );
    }

    writeRelayDb(homeDirectory, (writer) =>
      writer
        .prepare("UPDATE relay_grants SET parent_grant_id = grant_id WHERE grant_id = ?")
        .run(parent.sessionId),
    );
    const failure = yield* Effect.flip(RelayRuntime.RelayRuntime.pipe(Effect.provide(layer)));
    assert.equal(failure.reason, "invalid-state");
  }),
);

it.effect("keeps device registration separate from administrator-controlled entitlement", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const owner = yield* relay.bootstrapOwner();
      const deviceId = SelfHostedRelayDeviceId.make("device-a");
      const otherDevice = SelfHostedRelayDeviceId.make("device-b");
      const issue = {
        version: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
      } as const;
      const devicePairing = yield* relay.issuePairing(owner.credential, {
        ...issue,
        subject: { kind: "device", deviceId },
        scope: {
          permissions: ["activity.read", "device.manageSelf"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
      });
      const device = yield* relay.redeemPairing(devicePairing.credential);
      const administratorPairing = yield* relay.issuePairing(owner.credential, {
        ...issue,
        subject: { kind: "operator" },
        scope: {
          permissions: ["device.manageEntitlement"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
      });
      const admin = yield* relay.redeemPairing(administratorPairing.credential);
      const input = {
        version: 1,
        deviceId,
        label: "Phone",
        preferences: { notificationsEnabled: true, liveActivitiesEnabled: true },
      } as const;

      const registration = yield* relay.registerDevice(device.credential, input);
      assert.deepEqual(registration, { ...input, relayId: owner.relayId });
      assert.equal(
        (yield* Effect.flip(
          relay.registerDevice(device.credential, { ...input, deviceId: otherDevice }),
        ))._tag,
        "RelayAccessDeniedError",
      );
      const selected = {
        version: 1,
        deviceId,
        environments: { kind: "selected", environmentIds: [environmentA] },
      } as const;
      assert.equal(
        (yield* Effect.flip(relay.setDeviceEntitlement(device.credential, selected)))._tag,
        "RelayAccessDeniedError",
      );
      assert.deepEqual(yield* relay.setDeviceEntitlement(admin.credential, selected), {
        ...selected,
        relayId: owner.relayId,
      });
      yield* relay.setDeviceEntitlement(owner.credential, {
        ...selected,
        environments: { kind: "selected", environmentIds: [environmentA, environmentB] },
      });
      assert.equal(
        (yield* Effect.flip(relay.setDeviceEntitlement(admin.credential, selected)))._tag,
        "RelayAccessDeniedError",
      );
      assert.equal(
        (yield* Effect.flip(relay.revokeDevice(admin.credential, deviceId)))._tag,
        "RelayAccessDeniedError",
      );
      assert.deepEqual(
        yield* relay.getDeviceRegistration(device.credential, deviceId),
        registration,
      );
      yield* relay.revokeDevice(owner.credential, deviceId);
      assert.equal(
        (yield* Effect.flip(relay.getDeviceRegistration(device.credential, deviceId)))._tag,
        "RelayAuthenticationError",
      );
    }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })));
  }),
);

it.effect("binds device registration to its issuing authority across pairing races", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    const layer = RelayRuntime.relayRuntimeLayer({ homeDirectory });
    const bound = yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const owner = yield* relay.bootstrapOwner();
      const issue = { version: 1, expiresAt: "2099-01-01T00:00:00.000Z" } as const;
      const operatorFor = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
        const pairing = yield* relay.issuePairing(owner.credential, {
          ...issue,
          subject: { kind: "operator" },
          scope: {
            permissions: ["access.manage", "access.delegate", "device.manageSelf"],
            environments: { kind: "selected", environmentIds: [environmentId] },
          },
        });
        return yield* relay.redeemPairing(pairing.credential);
      });
      const operatorA = yield* operatorFor(environmentA);
      const operatorB = yield* operatorFor(environmentB);
      const entitledId = SelfHostedRelayDeviceId.make("device-entitled");
      const unbound = yield* relay.issuePairing(operatorA.credential, {
        ...issue,
        subject: { kind: "device", deviceId: entitledId },
        scope: {
          permissions: ["device.manageSelf"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
      });
      yield* relay.setDeviceEntitlement(owner.credential, {
        version: 1,
        deviceId: entitledId,
        environments: { kind: "selected", environmentIds: [environmentB] },
      });
      assert.equal(
        (yield* Effect.flip(relay.redeemPairing(unbound.credential)))._tag,
        "RelayAuthenticationError",
      );

      const deviceId = SelfHostedRelayDeviceId.make("device-race");
      const request = (environmentId: EnvironmentId) =>
        ({
          ...issue,
          subject: { kind: "device", deviceId },
          scope: {
            permissions: ["device.manageSelf", "access.delegate"],
            environments: { kind: "selected", environmentIds: [environmentId] },
          },
        }) as const;
      const pairingA = yield* relay.issuePairing(operatorA.credential, request(environmentA));
      const pairingB = yield* relay.issuePairing(operatorB.credential, request(environmentB));
      const results = yield* Effect.forEach(
        [pairingA, pairingB],
        (pairing) => Effect.result(relay.redeemPairing(pairing.credential)),
        { concurrency: 2 },
      );
      const [winner] = results.flatMap((result, index) =>
        result._tag === "Success" ? [{ session: result.success, index }] : [],
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.isDefined(winner);
      const [resultA, resultB] = results;
      const loser = winner.index === 0 ? resultB : resultA;
      assert.isDefined(loser);
      assert.equal(loser._tag, "Failure");
      if (loser._tag === "Failure") assert.equal(loser.failure._tag, "RelayAuthenticationError");

      const [issuer, otherIssuer] =
        winner.index === 0 ? [operatorA, operatorB] : [operatorB, operatorA];
      const [environment, otherEnvironment] =
        winner.index === 0 ? [environmentA, environmentB] : [environmentB, environmentA];
      const registration = yield* relay.registerDevice(winner.session.credential, {
        version: 1,
        deviceId,
        label: "Paired phone",
        preferences: { notificationsEnabled: true, liveActivitiesEnabled: true },
      });
      assert.equal(
        (yield* Effect.flip(relay.issuePairing(otherIssuer.credential, request(otherEnvironment))))
          ._tag,
        "RelayAccessDeniedError",
      );
      const anotherIssuer = yield* operatorFor(environment);
      assert.equal(
        (yield* Effect.flip(relay.issuePairing(anotherIssuer.credential, request(environment))))
          ._tag,
        "RelayAccessDeniedError",
      );
      const delegated = yield* relay.issuePairing(winner.session.credential, {
        ...request(environment),
        delegation: true,
      });
      const child = yield* relay.redeemPairing(delegated.credential);
      yield* relay.revokeSession(issuer.credential, winner.session.sessionId);
      assert.equal(
        (yield* Effect.flip(relay.getDeviceRegistration(child.credential, deviceId)))._tag,
        "RelayAuthenticationError",
      );
      const replacementPairing = yield* relay.issuePairing(issuer.credential, request(environment));
      const replacement = yield* relay.redeemPairing(replacementPairing.credential);
      return {
        registration,
        replacement,
        otherIssuer,
        otherRequest: request(otherEnvironment),
      };
    }).pipe(Effect.provide(layer));

    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      assert.deepEqual(
        yield* relay.getDeviceRegistration(
          bound.replacement.credential,
          bound.registration.deviceId,
        ),
        bound.registration,
      );
      assert.equal(
        (yield* Effect.flip(relay.issuePairing(bound.otherIssuer.credential, bound.otherRequest)))
          ._tag,
        "RelayAccessDeniedError",
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "migrates an existing device binding and preserves registration through owner recovery",
  () =>
    Effect.gen(function* () {
      const homeDirectory = yield* makeHome;
      const layer = RelayRuntime.relayRuntimeLayer({ homeDirectory });
      const deviceId = SelfHostedRelayDeviceId.make("existing-device");
      const request = {
        version: 1,
        subject: { kind: "device", deviceId },
        scope: {
          permissions: ["device.manageSelf"],
          environments: { kind: "selected", environmentIds: [environmentA] },
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      } as const;
      const { device, registration } = yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        const owner = yield* relay.bootstrapOwner();
        yield* relay.setDeviceEntitlement(owner.credential, {
          version: 1,
          deviceId,
          environments: { kind: "all" },
        });
        const pairing = yield* relay.issuePairing(owner.credential, request);
        const device = yield* relay.redeemPairing(pairing.credential);
        const registration = yield* relay.registerDevice(device.credential, {
          version: 1,
          deviceId,
          label: "Existing phone",
          preferences: { notificationsEnabled: true, liveActivitiesEnabled: true },
        });
        return { device, registration };
      }).pipe(Effect.provide(layer));

      writeRelayDb(homeDirectory, (writer) =>
        writer.exec(
          "DROP TABLE relay_hook_policies; ALTER TABLE relay_devices DROP COLUMN binding_grant_id; PRAGMA user_version = 1",
        ),
      );
      const replacement = yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        assert.deepEqual(
          yield* relay.getDeviceRegistration(device.credential, deviceId),
          registration,
        );
        const owner = yield* relay.recoverOwner();
        assert.equal(
          (yield* Effect.flip(relay.authenticate(device.credential)))._tag,
          "RelayAuthenticationError",
        );
        const pairing = yield* relay.issuePairing(owner.credential, request);
        return yield* relay.redeemPairing(pairing.credential);
      }).pipe(Effect.provide(layer));

      yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        assert.deepEqual(
          yield* relay.getDeviceRegistration(replacement.credential, deviceId),
          registration,
        );
        assert.deepEqual(
          (yield* relay.authenticate(replacement.credential)).grant.scope,
          request.scope,
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "revokes delegated publisher sessions and prevents their return after enrollment and restart",
  () =>
    Effect.gen(function* () {
      const homeDirectory = yield* makeHome;
      const retired: string[] = [];
      const layer = RelayRuntime.relayRuntimeLayer({
        homeDirectory,
        beforeEnvironmentRevoke: (environmentId) =>
          Effect.sync(() => {
            retired.push(environmentId);
          }),
      });
      const result = yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        const owner = yield* relay.bootstrapOwner();
        const enrollment = { version: 1, environmentId: environmentA, name: "A" } as const;
        yield* relay.enrollEnvironment(owner.credential, enrollment);
        const publisherRequest = {
          version: 1,
          subject: { kind: "publisher", environmentId: environmentA },
          scope: {
            permissions: [
              "access.delegate",
              "environment.publish",
              "environment.tunnel",
              "status.read",
            ],
            environments: { kind: "selected", environmentIds: [environmentA] },
          },
          expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;
        const published = yield* relay.issuePairing(owner.credential, publisherRequest);
        const publisher = yield* relay.redeemPairing(published.credential);
        assert.equal(
          (yield* Effect.flip(relay.status(publisher.credential)))._tag,
          "RelayAccessDeniedError",
        );
        const delegated = yield* relay.issuePairing(publisher.credential, {
          ...publisherRequest,
          delegation: true,
          scope: {
            ...publisherRequest.scope,
            permissions: ["environment.publish"],
          },
        });
        const child = yield* relay.redeemPairing(delegated.credential);
        const publish = { kind: "environment.publish", environmentId: environmentA } as const;
        const signal = yield* relay.authorizeLive(child.credential, publish);
        assert.equal(
          (yield* Effect.flip(relay.revokeEnvironment("invalid", environmentA)))._tag,
          "RelayAuthenticationError",
        );
        assert.equal(
          (yield* Effect.flip(relay.revokeEnvironment(publisher.credential, environmentA)))._tag,
          "RelayAccessDeniedError",
        );
        assert.deepEqual(retired, []);
        const nextPairing = yield* relay.issuePairing(owner.credential, publisherRequest);
        const next = yield* relay.redeemPairing(nextPairing.credential);
        yield* relay.revokeSession(owner.credential, next.sessionId);
        assert.deepEqual(retired, []);
        assert.isFalse(signal.aborted);
        yield* relay.revokeEnvironment(owner.credential, environmentA);
        assert.deepEqual(retired, [environmentA]);
        assert.isTrue(signal.aborted);
        yield* relay.enrollEnvironment(owner.credential, enrollment);
        assert.equal(
          (yield* Effect.flip(relay.authorizeLive(child.credential, publish)))._tag,
          "RelayAuthenticationError",
        );

        const replacementPairing = yield* relay.issuePairing(owner.credential, publisherRequest);
        const replacement = yield* relay.redeemPairing(replacementPairing.credential);
        return {
          owner,
          child,
          replacement,
          publish,
          live: yield* relay.authorizeLive(replacement.credential, publish),
        };
      }).pipe(Effect.provide(layer));
      assert.isTrue(result.live.aborted);

      yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        assert.equal((yield* relay.status(result.owner.credential)).relayId, result.owner.relayId);
        assert.equal(
          (yield* Effect.flip(relay.authorizeLive(result.child.credential, result.publish)))._tag,
          "RelayAuthenticationError",
        );
        assert.isFalse(
          (yield* relay.authorizeLive(result.replacement.credential, result.publish)).aborted,
        );
      }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })));
    }),
);

it.effect("retires ambiguous legacy device grants without stranding unrelated authority", () =>
  Effect.gen(function* () {
    const homeDirectory = yield* makeHome;
    const layer = RelayRuntime.relayRuntimeLayer({ homeDirectory });
    const deviceId = SelfHostedRelayDeviceId.make("ambiguous-device");
    const otherId = SelfHostedRelayDeviceId.make("other-device");
    const issue = { version: 1, expiresAt: "2099-01-01T00:00:00.000Z" } as const;
    const request = (id: typeof deviceId, environmentId = environmentA) =>
      ({
        ...issue,
        subject: { kind: "device", deviceId: id },
        scope: {
          permissions: ["device.manageSelf", "access.delegate"],
          environments: { kind: "selected", environmentIds: [environmentId] },
        },
      }) as const;
    const saved = yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      const owner = yield* relay.bootstrapOwner();
      const operators = yield* Effect.forEach([environmentA, environmentB], (environmentId) =>
        relay
          .issuePairing(owner.credential, {
            ...issue,
            subject: { kind: "operator" },
            scope: {
              permissions: [
                "access.manage",
                "device.manageSelf",
                "access.delegate",
                "device.manageEntitlement",
              ],
              environments: { kind: "selected", environmentIds: [environmentId] },
            },
          })
          .pipe(Effect.flatMap((pairing) => relay.redeemPairing(pairing.credential))),
      );
      const devices = yield* Effect.forEach([deviceId, otherId], (id, index) =>
        relay
          .issuePairing(
            operators[index]!.credential,
            request(id, index === 0 ? environmentA : environmentB),
          )
          .pipe(Effect.flatMap((pairing) => relay.redeemPairing(pairing.credential))),
      );
      const childPairing = yield* relay.issuePairing(devices[1]!.credential, {
        ...request(otherId, environmentB),
        delegation: true,
      });
      const child = yield* relay.redeemPairing(childPairing.credential);
      const unrelatedPairing = yield* relay.issuePairing(owner.credential, {
        ...issue,
        subject: { kind: "client" },
        scope: { permissions: ["status.read"], environments: { kind: "all" } },
      });
      return {
        devices: [...devices, child],
        operators,
        unrelated: yield* relay.redeemPairing(unrelatedPairing.credential),
      };
    }).pipe(Effect.provide(layer));
    writeRelayDb(homeDirectory, (writer) => {
      writer
        .prepare(
          "UPDATE relay_grants SET subject_id = ?, grant_json = json_set(grant_json, '$.subject.deviceId', ?) WHERE subject_kind = 'device' AND subject_id = ?",
        )
        .run(deviceId, deviceId, otherId);
      writer.prepare("DELETE FROM relay_devices WHERE device_id = ?").run(otherId);
      writer.exec(
        "DROP TABLE relay_hook_policies; ALTER TABLE relay_devices DROP COLUMN binding_grant_id; PRAGMA user_version = 1",
      );
    });
    yield* Effect.gen(function* () {
      const relay = yield* RelayRuntime.RelayRuntime;
      assert.equal((yield* relay.status(saved.unrelated.credential)).state, "ready");
      for (const device of saved.devices) {
        assert.equal(
          (yield* Effect.flip(relay.authenticate(device.credential)))._tag,
          "RelayAuthenticationError",
        );
      }
      for (const [index, operator] of saved.operators.entries()) {
        const revoked = yield* Effect.result(relay.revokeDevice(operator.credential, deviceId));
        assert.equal(revoked._tag, "Failure");
        if (revoked._tag === "Failure")
          assert.equal(revoked.failure._tag, "RelayAccessDeniedError");
        assert.equal(
          (yield* Effect.flip(
            relay.issuePairing(
              operator.credential,
              request(deviceId, index === 0 ? environmentA : environmentB),
            ),
          ))._tag,
          "RelayAccessDeniedError",
        );
      }
      const owner = yield* relay.recoverOwner();
      const pairing = yield* relay.issuePairing(owner.credential, request(deviceId));
      const replacement = yield* relay.redeemPairing(pairing.credential);
      assert.equal(
        (yield* relay.authenticate(replacement.credential)).grant.subject.kind,
        "device",
      );
    }).pipe(Effect.provide(layer));
  }),
);
