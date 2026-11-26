import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  SelfHostedRelayDeviceRegistration,
  SelfHostedRelayPairingCredential,
  SelfHostedRelayRuntimeStatus,
  SelfHostedRelaySessionCredential,
} from "@t3tools/contracts/selfHostedRelay";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { fetch } from "undici";

const decodeOwner = Schema.decodeUnknownSync(
  Schema.fromJsonString(SelfHostedRelaySessionCredential),
);
const decodeSession = Schema.decodeUnknownSync(SelfHostedRelaySessionCredential);
const decodePairing = Schema.decodeUnknownSync(SelfHostedRelayPairingCredential);
const decodeStatus = Schema.decodeUnknownSync(SelfHostedRelayRuntimeStatus);
const decodeDevice = Schema.decodeUnknownSync(SelfHostedRelayDeviceRegistration);
const prefix = "/api/self-hosted-relay/v1";

const spawn = Effect.fn("RelayCliTest.spawn")(function* (
  environmentHome: string,
  args: ReadonlyArray<string>,
  preload?: string,
) {
  const path = yield* Path.Path;
  const entrypoint = yield* path.fromFileUrl(new URL("../bin.ts", import.meta.url));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.spawn(
    ChildProcess.make(
      process.execPath,
      [
        ...(preload === undefined
          ? []
          : ["--import", `data:text/javascript,${encodeURIComponent(preload)}`]),
        entrypoint,
        ...args,
      ],
      {
        env: { T3CODE_HOME: environmentHome },
      },
    ),
  );
});

const run = Effect.fn("RelayCliTest.run")(function* (
  environmentHome: string,
  args: ReadonlyArray<string>,
  preload?: string,
) {
  const child = yield* spawn(environmentHome, args, preload);
  return yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      exitCode: child.exitCode,
    },
    { concurrency: "unbounded" },
  );
});

const withServer = Effect.fn("RelayCliTest.withServer")(function* (
  environmentHome: string,
  relayHome: string,
  use: (origin: string, signal: AbortSignal) => Promise<void>,
) {
  const child = yield* spawn(environmentHome, ["relay", "serve", "--home-dir", relayHome]);
  const listening = yield* Deferred.make<string>();
  const logs = yield* child.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.tap((line) => {
      const origin = /Self-hosted relay listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];
      return origin === undefined ? Effect.void : Deferred.succeed(listening, origin);
    }),
    Stream.runCollect,
    Effect.forkScoped,
  );
  const origin = yield* Effect.raceFirst(
    Deferred.await(listening),
    Fiber.join(logs).pipe(
      Effect.flatMap((lines) =>
        Effect.die(new Error(`Relay exited before listening: ${lines.join("\n")}`)),
      ),
    ),
  );
  yield* Effect.promise((signal) => use(origin, signal));
  // This process handle belongs to the child started above.
  yield* child.kill();
  yield* Effect.ignore(child.exitCode);
  return (yield* Fiber.join(logs)).join("\n");
});

it.live("requires an explicit relay home even when T3CODE_HOME is set", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-cli-" });
    const environmentHome = path.join(root, "environment");
    const result = yield* run(environmentHome, ["relay", "serve"]);
    assert.notEqual(Number(result.exitCode), 0);
    assert.include(result.stderr + result.stdout, "Missing required flag: --home-dir");
    assert.deepEqual(yield* fs.readDirectory(root), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("dispatches relay serve with leading global flags without importing the full CLI", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-dispatch-" });
    const environmentHome = path.join(root, "environment");
    const failFullCliImport = `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === './binCli.ts') throw new Error('Full CLI imported');
        return nextResolve(specifier, context);
      } });
    `;

    for (const flags of [["--log-level", "debug"], ["--log-level=debug"]]) {
      const result = yield* run(environmentHome, [...flags, "relay", "serve"], failFullCliImport);
      assert.notEqual(Number(result.exitCode), 0);
      assert.notInclude(result.stderr, "Full CLI imported");
      assert.include(result.stderr, "Missing required flag: --home-dir");
    }
    const help = yield* run(environmentHome, ["-h", "true", "relay", "serve"], failFullCliImport);
    assert.equal(Number(help.exitCode), 0, help.stderr);
    assert.include(help.stdout, "Run a standalone self-hosted relay on loopback.");
    assert.deepEqual(yield* fs.readDirectory(root), []);
    const forwarding = yield* run(
      environmentHome,
      [
        "relay",
        "serve",
        "--home-dir",
        path.join(root, "relay"),
        "--forwarding-config",
        path.join(root, "missing.json"),
      ],
      failFullCliImport,
    );
    assert.notEqual(Number(forwarding.exitCode), 0);
    assert.notInclude(forwarding.stderr, "Full CLI imported");
    assert.include(forwarding.stderr, "Invalid self-hosted relay configuration.");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["bootstrap-owner", "recover-owner"])(
  "fails safely when %s cannot write credentials",
  (command) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-output-" });
      const environmentHome = path.join(root, "environment");
      const relayHome = path.join(root, "relay");
      const failStdout = `
      import { Writable } from 'node:stream';
      Object.defineProperty(process, 'stdout', {
        value: new Writable({
          write(chunk, _encoding, callback) {
            queueMicrotask(() => callback(new Error('Private output: ' + chunk)));
          },
        }),
      });
    `;

      if (command === "recover-owner") {
        const bootstrap = yield* run(environmentHome, [
          "relay",
          "bootstrap-owner",
          "--home-dir",
          relayHome,
        ]);
        assert.equal(Number(bootstrap.exitCode), 0, bootstrap.stderr);
      }
      const result = yield* run(
        environmentHome,
        ["relay", command, "--home-dir", relayHome],
        failStdout,
      );
      assert.notEqual(Number(result.exitCode), 0);
      assert.isFalse(/Private output:|t3-session-1\./.test(result.stderr));
      assert.include(result.stderr, "Could not write the owner credential to stdout.");
      assert.equal(result.stdout, "");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("serves scoped management, shuts down, and recovers in a relay-only home", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-lifecycle-" });
    const environmentHome = path.join(root, "environment");
    const relayHome = path.join(root, "relay");
    yield* fs.makeDirectory(relayHome, { mode: 0o700 });
    assert.deepEqual(yield* fs.readDirectory(relayHome), []);

    const uninitialized = yield* withServer(environmentHome, relayHome, async (origin, signal) => {
      const response = await fetch(`${origin}${prefix}/status`, { signal });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { version: 1, error: "invalid_credential" });
    });
    assert.include(uninitialized, "uninitialized");

    const bootstrap = yield* run(environmentHome, [
      "relay",
      "bootstrap-owner",
      "--home-dir",
      relayHome,
    ]);
    assert.equal(Number(bootstrap.exitCode), 0, bootstrap.stderr);
    const owner = decodeOwner(bootstrap.stdout);
    const environmentId = "環".repeat(100);
    const deviceId = "端".repeat(100);
    const environmentRoute = `/environments/${encodeURIComponent(environmentId)}`;
    const deviceRoute = `/devices/${encodeURIComponent(deviceId)}`;
    const expiresAt = DateTime.formatIso(
      DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 300_000),
    );
    const served = yield* withServer(environmentHome, relayHome, async (origin, signal) => {
      const request = (route: string, credential: string, method = "GET", body?: object) =>
        fetch(`${origin}${prefix}${route}`, {
          method,
          signal,
          headers: {
            authorization: `Bearer ${credential}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      for (const route of ["/bootstrap-owner", "/recover-owner"]) {
        const response = await request(route, owner.credential, "POST", { kind: "localOwner" });
        assert.equal(response.status, 404);
      }
      const spoofed = await request("/environments", "unknown", "POST", {
        version: 1,
        environmentId: "test-env",
        name: "Workspace",
      });
      assert.equal(spoofed.status, 401);
      const malformed = await request("/environments", owner.credential, "POST", {
        version: 2,
        environmentId: "test-env",
        name: "Workspace",
      });
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { version: 1, error: "invalid_request" });
      const enrollmentInput = {
        version: 1,
        environmentId,
        name: "Workspace",
      };
      const oversizedEnvironment = await request("/environments", owner.credential, "POST", {
        ...enrollmentInput,
        environmentId: `${environmentId}x`,
      });
      assert.equal(oversizedEnvironment.status, 400);
      assert.deepEqual(await oversizedEnvironment.json(), { version: 1, error: "invalid_request" });
      const enrollment = await request("/environments", owner.credential, "POST", enrollmentInput);
      assert.equal(enrollment.status, 200);
      assert.deepEqual(await enrollment.json(), {
        ...enrollmentInput,
        relayId: owner.relayId,
      });
      const issue = await request("/pairings", owner.credential, "POST", {
        version: 1,
        subject: { kind: "device", deviceId },
        scope: {
          permissions: ["status.read", "device.manageSelf"],
          environments: { kind: "selected", environmentIds: [environmentId] },
        },
        expiresAt,
      });
      assert.equal(issue.status, 200);
      assert.equal(issue.headers.get("cache-control"), "no-store");
      const pairing = decodePairing(await issue.json());
      const redeemed = await request("/pairings/redeem", pairing.credential, "POST");
      assert.equal(redeemed.status, 200);
      const device = decodeSession(await redeemed.json());
      assert.equal((await request("/pairings/redeem", pairing.credential, "POST")).status, 401);

      const denied = await request("/environments", device.credential, "POST", {
        version: 1,
        environmentId: "second-env",
        name: "Unauthorized",
      });
      assert.equal(denied.status, 403);
      const status = await request("/status", device.credential);
      assert.equal(status.status, 200);
      assert.deepEqual(await status.json(), {
        version: 1,
        relayId: owner.relayId,
        state: "ready",
        environments: [{ ...enrollmentInput, relayId: owner.relayId }],
      });

      const registrationInput = {
        version: 1,
        deviceId,
        label: "Test phone",
        preferences: { notificationsEnabled: true, liveActivitiesEnabled: false },
      };
      const oversizedDevice = await request("/devices", device.credential, "POST", {
        ...registrationInput,
        deviceId: `${deviceId}x`,
      });
      assert.equal(oversizedDevice.status, 400);
      assert.deepEqual(await oversizedDevice.json(), { version: 1, error: "invalid_request" });
      const registration = await request("/devices", device.credential, "POST", registrationInput);
      assert.equal(registration.status, 200);
      const deviceRead = await request(deviceRoute, device.credential);
      assert.equal(deviceRead.status, 200);
      assert.deepEqual(
        decodeDevice(await deviceRead.json()),
        decodeDevice(await registration.json()),
      );
      assert.equal((await request("/devices/other", device.credential)).status, 403);
      const entitlement = {
        version: 1,
        deviceId,
        environments: { kind: "selected", environmentIds: [environmentId] },
      };
      assert.equal(
        (await request("/devices/entitlements", device.credential, "POST", entitlement)).status,
        403,
      );
      const granted = await request("/devices/entitlements", owner.credential, "POST", entitlement);
      assert.equal(granted.status, 200);
      assert.deepEqual(await granted.json(), { ...entitlement, relayId: owner.relayId });
      assert.equal(
        (await request(`/pairings/${pairing.pairingId}`, owner.credential, "DELETE")).status,
        204,
      );
      assert.equal((await request("/status", device.credential)).status, 401);
      assert.equal((await request(deviceRoute, owner.credential, "DELETE")).status, 204);
      assert.equal((await request(environmentRoute, owner.credential, "DELETE")).status, 204);
    });
    assert.include(served, "ready");
    assert.notMatch(served, /t3-(?:session|pairing)-1\./);
    assert.notInclude(served, "Workspace");

    const recovery = yield* run(environmentHome, [
      "relay",
      "recover-owner",
      "--home-dir",
      relayHome,
    ]);
    assert.equal(Number(recovery.exitCode), 0, recovery.stderr);
    const recovered = decodeOwner(recovery.stdout);
    assert.equal(recovered.relayId, owner.relayId);
    assert.notEqual(recovered.credential, owner.credential);
    yield* withServer(environmentHome, relayHome, async (origin, signal) => {
      const status = async (credential: string) =>
        fetch(`${origin}${prefix}/status`, {
          signal,
          headers: { authorization: `Bearer ${credential}` },
        });
      assert.equal((await status(owner.credential)).status, 401);
      const response = await status(recovered.credential);
      assert.equal(response.status, 200);
      assert.deepEqual(decodeStatus(await response.json()).environments, []);
    });

    assert.deepEqual(yield* fs.readDirectory(root), ["relay"]);
    assert.deepEqual(yield* fs.readDirectory(relayHome), ["relay.sqlite"]);
    using db = new NodeSqlite.DatabaseSync(path.join(relayHome, "relay.sqlite"), {
      readOnly: true,
    });
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
    assert.isTrue(tables.some(({ name }) => name === "relay_identity"));
    assert.isTrue(
      tables.every(({ name }) => typeof name === "string" && name.startsWith("relay_")),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("provisions and retires origins in an isolated authority under the relay home lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relay-origin-cli-" });
    const environmentHome = path.join(root, "environment");
    const relayHome = path.join(root, "relay");
    const authorityDirectory = `${relayHome}.origins`;
    const authority = path.join(authorityDirectory, "authority.sqlite");
    const alias = "https://origin.example.test";
    const command = (operation: string, ...args: string[]) =>
      run(environmentHome, ["relay", "origin", operation, "--home-dir", relayHome, ...args]);
    const operands = ["--origin", alias, "--environment-id", "environment-one"];
    const expectSuccess = (result: { exitCode: unknown; stderr: string; stdout: string }) => {
      assert.equal(Number(result.exitCode), 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.notMatch(result.stderr, /t3-(?:session|pairing)-1\./);
    };

    assert.notEqual(Number((yield* command("register", ...operands)).exitCode), 0);
    assert.isFalse(yield* fs.exists(authorityDirectory));
    expectSuccess(yield* command("init"));
    assert.notEqual(Number((yield* command("init")).exitCode), 0);
    expectSuccess(yield* command("register", ...operands));
    expectSuccess(yield* command("register", ...operands));

    const { RelayRuntime, relayRuntimeLayer } = yield* Effect.promise(
      () => import("@t3tools/relay-core/RelayRuntime"),
    );
    yield* RelayRuntime.pipe(
      Effect.andThen(command("retire", ...operands)),
      Effect.map((result) => {
        assert.notEqual(Number(result.exitCode), 0);
        assert.include(result.stderr, "This relay home is in use.");
      }),
      Effect.provide(relayRuntimeLayer({ homeDirectory: relayHome })),
    );

    expectSuccess(yield* command("retire", ...operands));
    assert.notEqual(Number((yield* command("register", ...operands)).exitCode), 0);
    assert.isFalse(yield* fs.exists(environmentHome));

    {
      using db = new NodeSqlite.DatabaseSync(authority, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
      assert.deepEqual(
        tables.map(({ name }) => name),
        ["relay_origins"],
      );
      assert.deepEqual(
        db
          .prepare("SELECT origin, environment_id, retired FROM relay_origins")
          .all()
          .map((row) => ({ ...row })),
        [{ origin: alias, environment_id: "environment-one", retired: 1 }],
      );
    }

    yield* fs.remove(authority);
    assert.notEqual(Number((yield* command("init")).exitCode), 0);
    assert.notEqual(Number((yield* command("register", ...operands)).exitCode), 0);
    assert.isFalse(yield* fs.exists(authority));
  }).pipe(Effect.provide(NodeServices.layer)),
);
