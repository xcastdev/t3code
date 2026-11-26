// @effect-diagnostics nodeBuiltinImport:off -- Each relay writer uses a disposable directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as RelayRuntime from "./RelayRuntime.ts";
import * as RelayStore from "./RelayStore.ts";

it.effect(
  "persists scoped hook exposure and retires delivery leases on policy and authority changes",
  () =>
    Effect.gen(function* () {
      const homeDirectory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-relay-hooks-"))),
        (home) => Effect.promise(() => NodeFSP.rm(home, { recursive: true, force: true })),
      );
      yield* RelayRuntime.RelayRuntime.pipe(
        Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory })),
      );
      yield* Effect.sync(() => {
        const writer = new NodeSqlite.DatabaseSync(NodePath.join(homeDirectory, "relay.sqlite"));
        try {
          writer.exec("DROP TABLE relay_hook_policies; PRAGMA user_version = 2");
        } finally {
          writer.close();
        }
      });
      const environmentId = EnvironmentId.make("hook-environment");
      const input = { environmentId, hookId: "task-1" };
      const owner = yield* Effect.scoped(
        Effect.gen(function* () {
          const relay = yield* RelayRuntime.RelayRuntime;
          const owner = yield* relay.bootstrapOwner();
          assert.isNull(yield* relay.authorizeHook(input));
          yield* relay.enrollEnvironment(owner.credential, {
            version: 1,
            environmentId,
            name: "Hooks",
          });
          yield* relay.setHookPolicy(owner.credential, {
            ...input,
            enabled: true,
            holdEnabled: true,
          });
          const mutableTarget = { ...input };
          const held = yield* relay.authorizeHook(mutableTarget);
          mutableTarget.hookId = "other-task";
          assert.isNotNull(held);
          assert.isTrue(held!.holdEnabled);
          yield* relay.setHookPolicy(owner.credential, {
            ...input,
            enabled: true,
            holdEnabled: true,
          });
          const unchanged = yield* relay.authorizeHook(input);
          assert.equal(unchanged!.revision, held!.revision);
          assert.isFalse(held!.signal.aborted);
          const pairing = yield* relay.issuePairing(owner.credential, {
            version: 1,
            subject: { kind: "operator" },
            scope: {
              permissions: ["exposure.write"],
              environments: { kind: "selected", environmentIds: [EnvironmentId.make("other")] },
            },
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
          const other = yield* relay.redeemPairing(pairing.credential);
          assert.equal(
            (yield* Effect.flip(
              relay.setHookPolicy(other.credential, {
                ...input,
                enabled: false,
                holdEnabled: false,
              }),
            ))._tag,
            "RelayAccessDeniedError",
          );
          assert.isFalse(held!.signal.aborted);
          const { sql } = yield* RelayStore.RelayStore;
          assert.equal((yield* Effect.result(sql.reserve))._tag, "Failure");
          const nested = yield* sql.withTransaction(
            Effect.result(
              relay.setHookPolicy(owner.credential, {
                ...input,
                enabled: false,
                holdEnabled: false,
              }),
            ),
          );
          assert.equal(nested._tag, "Failure");
          assert.isFalse(held!.signal.aborted);
          yield* relay.setHookPolicy(owner.credential, {
            ...input,
            enabled: true,
            holdEnabled: false,
          });
          assert.isTrue(held!.signal.aborted);
          const immediate = yield* relay.authorizeHook(input);
          assert.isFalse(immediate!.holdEnabled);
          assert.notEqual(immediate!.revision, held!.revision);
          return owner;
        }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory }))),
      );
      yield* Effect.sync(() => {
        const writer = new NodeSqlite.DatabaseSync(NodePath.join(homeDirectory, "relay.sqlite"));
        try {
          writer.exec(
            "ALTER TABLE relay_hook_policies DROP COLUMN revision; PRAGMA user_version = 3",
          );
        } finally {
          writer.close();
        }
      });
      const migratedRevision = yield* Effect.scoped(
        Effect.gen(function* () {
          const relay = yield* RelayRuntime.RelayRuntime;
          assert.deepEqual(yield* relay.getHookPolicy(owner.credential, input), {
            ...input,
            enabled: true,
            holdEnabled: false,
          });
          const authorization = yield* relay.authorizeHook(input);
          assert.isNotNull(authorization);
          assert.match(authorization!.revision, /^[0-9a-f-]{36}$/u);
          return authorization!.revision;
        }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory }))),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const relay = yield* RelayRuntime.RelayRuntime;
          assert.equal((yield* relay.authorizeHook(input))!.revision, migratedRevision);
          assert.isFalse((yield* relay.getHookPolicy(owner.credential, input))!.holdEnabled);
          const live = yield* relay.authorizeHook(input);
          yield* relay.revokeEnvironment(owner.credential, environmentId);
          assert.isTrue(live!.signal.aborted);
          yield* relay.enrollEnvironment(owner.credential, {
            version: 1,
            environmentId,
            name: "Again",
          });
          assert.isNull(yield* relay.authorizeHook(input));
          yield* relay.setHookPolicy(owner.credential, {
            ...input,
            enabled: true,
            holdEnabled: true,
          });
          const beforeRecovery = yield* relay.authorizeHook(input);
          const recovered = yield* relay.recoverOwner();
          assert.isTrue(beforeRecovery!.signal.aborted);
          assert.isNull(yield* relay.authorizeHook(input));
          yield* relay.setHookPolicy(recovered.credential, {
            ...input,
            enabled: true,
            holdEnabled: false,
          });
          assert.isNotNull(yield* relay.authorizeHook(input));
        }).pipe(Effect.provide(RelayRuntime.relayRuntimeLayer({ homeDirectory }))),
      );
    }),
);
