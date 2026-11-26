// @effect-diagnostics nodeBuiltinImport:off -- The persistence test copies a closed SQLite database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeSqlite from "node:sqlite";
import { it as effectIt } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as RelayRuntime from "@t3tools/relay-core/RelayRuntime";
import * as Effect from "effect/Effect";
import { expect, it } from "vite-plus/test";

import {
  createRelayOriginRegistry,
  initializeRelayHomeOriginRegistry,
  openRelayHomeOriginRegistry,
  openRelayOriginRegistry,
} from "./RelayOriginRegistry.ts";

const origin = "https://environment.example.test";
const environment = "environment-one";

function setup() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-relay-origins-"));
  return {
    home,
    authority: NodePath.join(home, "origins.sqlite"),
    [Symbol.dispose]: () => NodeFS.rmSync(home, { recursive: true, force: true }),
  };
}

it("keeps an alias retired across reopen even when an earlier authority copy still exists", () => {
  using fixture = setup();
  const snapshot = NodePath.join(fixture.home, "before-retirement.sqlite");
  {
    using registry = createRelayOriginRegistry(fixture.authority);
    registry.register(origin, environment);
    expect(registry.lookup(origin)).toEqual({ status: "active", environmentId: environment });
    expect(() => registry.register(origin, "environment-two")).toThrow();
    registry.register(origin, environment);
  }
  NodeFS.copyFileSync(fixture.authority, snapshot);

  {
    using registry = openRelayOriginRegistry(fixture.authority);
    expect(() => registry.retire(origin, "environment-two")).toThrow();
    registry.retire(origin, environment);
    registry.retire(origin, environment);
  }

  using restoredRuntime = openRelayOriginRegistry(snapshot);
  using authority = openRelayOriginRegistry(fixture.authority);
  expect(restoredRuntime.lookup(origin)).toEqual({ status: "active", environmentId: environment });
  expect(authority.lookup(origin)).toEqual({ status: "retired", environmentId: environment });
  expect(() => authority.register(origin, environment)).toThrow();
  expect(() => authority.register(origin, "environment-two")).toThrow();
  expect(() => createRelayOriginRegistry(fixture.authority)).toThrow();
  expect(authority.lookup("https://new.example.test")).toEqual({ status: "unknown" });
});

it("fails closed without existing origin authority and accepts only canonical HTTPS origins", () => {
  using fixture = setup();
  expect(() => openRelayOriginRegistry(fixture.authority)).toThrow();
  using registry = createRelayOriginRegistry(fixture.authority);
  for (const invalid of [
    "http://environment.example.test",
    "https://environment.example.test/",
    "https://environment.example.test/path",
    "https://someone@environment.example.test",
    "https://environment.example.test?key=not-an-origin",
    "https://ENVIRONMENT.example.test",
  ]) {
    expect(() => registry.register(invalid, environment)).toThrow();
    expect(registry.lookup(invalid)).toEqual({ status: "unknown" });
  }
  expect(() => registry.retire(origin, environment)).toThrow();
  registry.register(origin, environment);
  NodeFS.renameSync(fixture.authority, `${fixture.authority}.lost`);
  expect(() => registry.lookup(origin)).toThrow();
  expect(() => registry.register("https://fresh.example.test", environment)).toThrow();
  {
    using replacement = createRelayOriginRegistry(fixture.authority);
    replacement.register(origin, environment);
    expect(() => registry.lookup(origin)).toThrow();
    expect(() => registry.retire(origin, environment)).toThrow("authority was replaced");
    expect(() => registry.retireEnvironment(environment)).toThrow("authority was replaced");
    expect(replacement.lookup(origin)).toEqual({ status: "active", environmentId: environment });
  }
});

it("permanently retires every registered alias for an environment", () => {
  using fixture = setup();
  const secondAlias = "https://second.example.test";
  const otherOrigin = "https://other.example.test";
  const freshOrigin = "https://fresh.example.test";
  {
    using registry = createRelayOriginRegistry(fixture.authority);
    registry.register(origin, environment);
    registry.register(secondAlias, environment);
    registry.register(otherOrigin, "environment-two");
    registry.retireEnvironment(environment);
    registry.retireEnvironment(environment);
  }
  using registry = openRelayOriginRegistry(fixture.authority);
  for (const alias of [origin, secondAlias]) {
    expect(registry.lookup(alias)).toEqual({ status: "retired", environmentId: environment });
    expect(() => registry.register(alias, environment)).toThrow();
    expect(() => registry.register(alias, "environment-two")).toThrow();
  }
  expect(registry.lookup(otherOrigin)).toEqual({
    status: "active",
    environmentId: "environment-two",
  });
  registry.register(freshOrigin, environment);
  expect(registry.lookup(freshOrigin)).toEqual({ status: "active", environmentId: environment });
});

effectIt.effect(
  "tombstones origins before the relay commit and keeps them retired after relay restore",
  () =>
    Effect.gen(function* () {
      using fixture = setup();
      const relayHome = NodePath.join(fixture.home, "relay");
      const relayDb = NodePath.join(relayHome, "relay.sqlite");
      const authority = NodePath.join(`${relayHome}.origins`, "authority.sqlite");
      const snapshot = NodePath.join(fixture.home, "relay-before-revoke.sqlite");
      const environmentId = EnvironmentId.make(environment);
      const alias = "https://alias.example.test";
      NodeFS.mkdirSync(relayHome, { mode: 0o700 });
      initializeRelayHomeOriginRegistry(relayHome);
      using registry = openRelayHomeOriginRegistry(relayHome);
      if (registry === undefined) throw new Error("Failed to provision origin authority");
      registry.register(origin, environmentId);
      registry.register(alias, environmentId);
      const enrollment = { version: 1, environmentId, name: "Test environment" } as const;
      const publish = { kind: "environment.publish", environmentId } as const;
      const runtime = RelayRuntime.relayRuntimeLayer({
        homeDirectory: relayHome,
        beforeEnvironmentRevoke: (id) =>
          Effect.try({
            try: () => registry.retireEnvironment(id),
            catch: (cause) => new RelayRuntime.RelayStorageError({ reason: "io", cause }),
          }),
      });
      const { owner, publisher } = yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        const owner = yield* relay.bootstrapOwner();
        yield* relay.enrollEnvironment(owner.credential, enrollment);
        const pairing = yield* relay.issuePairing(owner.credential, {
          version: 1,
          subject: { kind: "publisher", environmentId },
          scope: {
            permissions: ["environment.publish"],
            environments: { kind: "selected", environmentIds: [environmentId] },
          },
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
        return { owner, publisher: yield* relay.redeemPairing(pairing.credential) };
      }).pipe(Effect.provide(runtime));

      NodeFS.copyFileSync(relayDb, snapshot);
      NodeFS.renameSync(authority, `${authority}.missing`);
      expect(() => openRelayHomeOriginRegistry(relayHome)).toThrow();
      yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        const live = yield* relay.authorizeLive(publisher.credential, publish);
        expect(
          (yield* Effect.flip(relay.revokeEnvironment(owner.credential, environmentId)))._tag,
        ).toBe("RelayStorageError");
        expect(live.aborted).toBe(true);
      }).pipe(Effect.provide(runtime));
      NodeFS.renameSync(`${authority}.missing`, authority);
      expect(registry.lookup(origin)).toEqual({ status: "active", environmentId });

      {
        using db = new NodeSqlite.DatabaseSync(relayDb);
        db.exec(`
        CREATE TABLE blocked_revoke (
          parent_id TEXT REFERENCES relay_environments (environment_id) DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_revoke_commit AFTER DELETE ON relay_environments BEGIN
          INSERT INTO blocked_revoke VALUES (OLD.environment_id);
        END;
      `);
      }

      yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        const live = yield* relay.authorizeLive(publisher.credential, publish);
        const result = yield* Effect.flip(relay.revokeEnvironment(owner.credential, environmentId));
        expect(result._tag).toBe("RelayStorageError");
        expect(live.aborted).toBe(true);
        for (const retired of [origin, alias]) {
          expect(registry.lookup(retired)).toEqual({ status: "retired", environmentId });
        }
      }).pipe(Effect.provide(runtime));

      {
        using db = new NodeSqlite.DatabaseSync(relayDb);
        expect(
          db.prepare("SELECT environment_id FROM relay_environments").get()?.environment_id,
        ).toBe(environmentId);
        db.exec("DROP TRIGGER fail_revoke_commit; DROP TABLE blocked_revoke;");
      }
      yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        yield* relay.revokeEnvironment(owner.credential, environmentId);
        expect(yield* relay.discoverEnvironments(owner.credential, environmentId)).toEqual([]);
        expect((yield* Effect.flip(relay.authorizeLive(publisher.credential, publish)))._tag).toBe(
          "RelayAuthenticationError",
        );
      }).pipe(Effect.provide(runtime));

      NodeFS.copyFileSync(snapshot, relayDb);
      yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        expect(yield* relay.discoverEnvironments(owner.credential, environmentId)).toHaveLength(1);
        expect(registry.lookup(origin)).toEqual({ status: "retired", environmentId });
        expect(() => registry.register(origin, environmentId)).toThrow("reserved");

        yield* relay.revokeEnvironment(owner.credential, environmentId);
      }).pipe(Effect.provide(runtime));

      const freshOrigin = "https://fresh.example.test";
      registry.register(freshOrigin, environmentId);
      yield* Effect.gen(function* () {
        const relay = yield* RelayRuntime.RelayRuntime;
        yield* relay.enrollEnvironment(owner.credential, enrollment);
        const recovered = yield* relay.recoverOwner();
        expect(yield* relay.discoverEnvironments(recovered.credential, environmentId)).toHaveLength(
          1,
        );
        expect(registry.lookup(freshOrigin)).toEqual({ status: "active", environmentId });
      }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory: relayHome })));
    }),
);
