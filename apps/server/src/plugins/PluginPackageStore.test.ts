import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { type PluginId, type PluginManifest, PluginRegistrySnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { attachmentFileExtension, createPendingAttachmentId } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as PluginPackageStore from "./PluginPackageStore.ts";

const isRegistrySnapshot = Schema.is(PluginRegistrySnapshot);

interface ZipMember {
  readonly name: string;
  readonly contents?: string;
  readonly mode?: number;
}

// Stored (uncompressed) zip writer, so tests can build traversal and symlink members.
const zip = (members: ReadonlyArray<ZipMember>): Uint8Array => {
  const locals: Array<Buffer> = [];
  const centrals: Array<Buffer> = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const data = Buffer.from(member.contents ?? "", "utf8");
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((member.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

const manifest = (overrides: Partial<PluginManifest> = {}): PluginManifest => ({
  manifestVersion: 1,
  id: "echo" as PluginId,
  name: "Echo",
  version: "1.0.0",
  hostApi: "1.0",
  author: "T3 Tests",
  ui: { panels: [{ id: "main", title: "Main", entry: "panels/main.html" }], commands: [] },
  backend: {
    entry: "backend/index.cjs",
    operations: [],
    topics: [],
    resources: [],
    prerequisites: [],
  },
  settings: {
    client: [],
    environment: [
      { key: "port", label: "Port", type: "number", default: 8080 },
      { key: "token", label: "Token", type: "secret" },
    ],
  },
  capabilities: [],
  ...overrides,
});

const uiOnlyManifest = (): PluginManifest => {
  const { backend: _backend, ...rest } = manifest();
  return rest;
};

const packageMembers = (pluginManifest: PluginManifest): Array<ZipMember> => [
  { name: "t3-plugin.json", contents: JSON.stringify(pluginManifest) },
  ...(pluginManifest.ui?.panels ?? []).map((panel) => ({
    name: panel.entry,
    contents: `<html>${pluginManifest.version}</html>`,
  })),
  ...(pluginManifest.backend
    ? [{ name: pluginManifest.backend.entry, contents: "module.exports = {};" }]
    : []),
];

const putAttachment = Effect.fn("test.putAttachment")(function* (bytes: Uint8Array) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const extension = attachmentFileExtension("plugin.t3plugin");
  const attachmentId = createPendingAttachmentId(extension);
  yield* fileSystem.writeFile(
    path.join(config.attachmentsDir, `${attachmentId}${extension}`),
    bytes,
  );
  return attachmentId;
});

const baseLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-plugin-store-" })),
  Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
);

const withStore = <A, E, R>(
  body: (store: PluginPackageStore.PluginPackageStore["Service"]) => Effect.Effect<A, E, R>,
  fileSystem?: FileSystem.FileSystem,
) =>
  Effect.gen(function* () {
    const store = yield* PluginPackageStore.PluginPackageStore;
    return yield* body(store);
  }).pipe(
    Effect.provide(
      fileSystem === undefined
        ? PluginPackageStore.layer
        : PluginPackageStore.layer.pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, fileSystem)),
          ),
    ),
  );

const failureReason = <A, E extends { readonly reason: string }>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

const exists = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.exists(filePath);
  });

describe("PluginPackageStore", () => {
  it.effect("installs a backend package only with trustBackendAuthor", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const attachmentId = yield* putAttachment(zip(packageMembers(manifest())));
        expect(
          yield* failureReason(
            store.installFromAttachment({ attachmentId, trustBackendAuthor: false }),
          ),
        ).toBe("capability-denied");
        expect((yield* store.snapshot).installed).toEqual([]);

        const { record, replaced } = yield* store.installFromAttachment({
          attachmentId,
          trustBackendAuthor: true,
        });
        expect(replaced).toBe(false);
        expect(record).toMatchObject({ pluginId: "echo", version: "1.0.0", enabled: true });
        const paths = store.paths("echo" as PluginId, "1.0.0");
        expect(yield* exists(`${paths.packageDir}/backend/index.cjs`)).toBe(true);
        expect(yield* exists(paths.dataDir)).toBe(true);
      }),
    ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("installs a UI-only package without it", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const attachmentId = yield* putAttachment(zip(packageMembers(uiOnlyManifest())));
        const { record } = yield* store.installFromAttachment({
          attachmentId,
          trustBackendAuthor: false,
        });
        expect(record.manifest.backend).toBeUndefined();
        expect((yield* store.snapshot).installed.map((item) => item.pluginId)).toEqual(["echo"]);
      }),
    ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("refuses path traversal entries and symlinks in the archive", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const members = packageMembers(manifest());
        for (const archive of [
          [...members, { name: "../escape.txt", contents: "x" }],
          members.map((member) =>
            member.name.endsWith(".html")
              ? { ...member, contents: "/etc/passwd", mode: 0o120777 }
              : member,
          ),
          [...members, { name: "panels/main.html/inner.txt", contents: "x" }],
        ]) {
          const attachmentId = yield* putAttachment(zip(archive));
          expect(
            yield* failureReason(
              store.installFromAttachment({ attachmentId, trustBackendAuthor: true }),
            ),
          ).toBe("invalid-package");
        }
        expect((yield* store.snapshot).installed).toEqual([]);
      }),
    ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("refuses incompatible hostApi before touching the registry", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const attachmentId = yield* putAttachment(
          zip(packageMembers(manifest({ hostApi: "2.0" }))),
        );
        expect(
          yield* failureReason(
            store.installFromAttachment({ attachmentId, trustBackendAuthor: true }),
          ),
        ).toBe("incompatible-host-api");
        expect(yield* exists(`${config.stateDir}/plugins/registry.json`)).toBe(false);
        expect(yield* exists(`${config.stateDir}/plugins/packages/echo`)).toBe(false);
      }),
    ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("refuses a backend package whose manifest entry is missing from the archive", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const attachmentId = yield* putAttachment(
          zip(packageMembers(manifest()).filter((member) => !member.name.endsWith(".cjs"))),
        );
        expect(
          yield* failureReason(
            store.installFromAttachment({ attachmentId, trustBackendAuthor: true }),
          ),
        ).toBe("invalid-package");
      }),
    ).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "uninstall removes registry and package but retains data and lists it under retainedData",
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const attachmentId = yield* putAttachment(zip(packageMembers(manifest())));
          yield* store.installFromAttachment({ attachmentId, trustBackendAuthor: true });
          const paths = store.paths("echo" as PluginId, "1.0.0");
          yield* fileSystem.writeFileString(`${paths.dataDir}/capture.db`, "12345");
          yield* fileSystem.symlink("/nonexistent/t3-plugin-target", `${paths.dataDir}/dangling`);
          yield* store.writeConfig("echo" as PluginId, { port: 9000, token: "s3cret" });

          yield* store.uninstall("echo" as PluginId);
          expect(
            (yield* withStore((reloaded) => reloaded.snapshot)).retainedData.map(
              (entry) => entry.pluginId,
            ),
          ).toEqual(["echo"]);

          const snapshot = yield* store.snapshot;
          expect(snapshot.installed).toEqual([]);
          expect(snapshot.retainedData).toEqual([{ pluginId: "echo", bytes: expect.any(Number) }]);
          expect(snapshot.retainedData[0]!.bytes).toBeGreaterThanOrEqual(5);
          expect(yield* exists(paths.packageDir)).toBe(false);
          expect(yield* fileSystem.readFileString(`${paths.dataDir}/capture.db`)).toBe("12345");
          expect(yield* exists(paths.configPath)).toBe(true);
          expect(yield* failureReason(store.uninstall("echo" as PluginId))).toBe("not-installed");
        }),
      ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("deleteData removes data, config and plugin secrets", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const attachmentId = yield* putAttachment(zip(packageMembers(manifest())));
        yield* store.installFromAttachment({ attachmentId, trustBackendAuthor: true });
        const paths = store.paths("echo" as PluginId, "1.0.0");
        yield* store.writeConfig("echo" as PluginId, { token: "s3cret" });
        expect(Option.isSome(yield* secrets.get("plugin.echo.token"))).toBe(true);

        expect(yield* failureReason(store.deleteData("echo" as PluginId))).toBe("operation-failed");
        yield* store.setEnabled("echo" as PluginId, false);
        yield* store.uninstall("echo" as PluginId);
        yield* store.deleteData("echo" as PluginId);

        expect(yield* exists(paths.dataDir)).toBe(false);
        expect(yield* exists(paths.configPath)).toBe(false);
        expect(Option.isNone(yield* secrets.get("plugin.echo.token"))).toBe(true);
        expect((yield* store.snapshot).retainedData).toEqual([]);
      }),
    ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("stageUpdate validates the new archive without changing the active version", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const pluginId = "echo" as PluginId;
        yield* store.installFromAttachment({
          attachmentId: yield* putAttachment(zip(packageMembers(manifest()))),
          trustBackendAuthor: true,
        });

        expect(
          yield* failureReason(
            store.stageUpdate({
              pluginId,
              attachmentId: yield* putAttachment(
                zip(packageMembers(manifest({ version: "2.0.0", hostApi: "9.0" }))),
              ),
              trustBackendAuthor: true,
            }),
          ),
        ).toBe("incompatible-host-api");
        expect(
          yield* failureReason(
            store.stageUpdate({
              pluginId,
              attachmentId: yield* putAttachment(
                zip(packageMembers(manifest({ id: "other" as PluginId, version: "2.0.0" }))),
              ),
              trustBackendAuthor: true,
            }),
          ),
        ).toBe("invalid-package");

        const staged = yield* store.stageUpdate({
          pluginId,
          attachmentId: yield* putAttachment(zip(packageMembers(manifest({ version: "2.0.0" })))),
          trustBackendAuthor: true,
        });
        expect(staged).toEqual({
          from: "1.0.0",
          to: "2.0.0",
          packageDir: store.paths(pluginId, "2.0.0").packageDir,
        });
        expect((yield* store.snapshot).installed[0]?.version).toBe("1.0.0");

        yield* store.commitVersion(pluginId, "2.0.0");
        yield* store.markFailedUpdate(pluginId, { from: "1.0.0", to: "2.0.0", reason: "boom" });
        const [record] = (yield* store.snapshot).installed;
        expect(record?.version).toBe("2.0.0");
        expect(record?.failedUpdate).toEqual({ from: "1.0.0", to: "2.0.0", reason: "boom" });
        expect(yield* exists(store.paths(pluginId, "1.0.0").packageDir)).toBe(false);
      }),
    ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("registry writes are atomic", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const realFileSystem = yield* FileSystem.FileSystem;
      const registryPath = `${config.stateDir}/plugins/registry.json`;
      let failRegistryRenames = false;
      const fileSystem: FileSystem.FileSystem = {
        ...realFileSystem,
        rename: (from, to) =>
          failRegistryRenames && to === registryPath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                }),
              )
            : realFileSystem.rename(from, to),
      };

      yield* withStore(
        (store) =>
          Effect.gen(function* () {
            yield* store.installFromAttachment({
              attachmentId: yield* putAttachment(zip(packageMembers(manifest()))),
              trustBackendAuthor: true,
            });
            failRegistryRenames = true;
            const exit = yield* Effect.exit(store.setEnabled("echo" as PluginId, false));
            expect(Exit.isFailure(exit)).toBe(true);
            expect((yield* store.snapshot).installed[0]?.enabled).toBe(true);
          }),
        fileSystem,
      );

      const registry = JSON.parse(yield* realFileSystem.readFileString(registryPath));
      expect(registry.plugins).toHaveLength(1);
      expect(registry.plugins[0]).toMatchObject({ pluginId: "echo", enabled: true });

      const reloaded = yield* withStore((store) => store.snapshot);
      expect(isRegistrySnapshot(reloaded)).toBe(true);
      expect(reloaded.installed[0]).toMatchObject({ pluginId: "echo", enabled: true });
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("unreadable registry entries are skipped and the original is backed up", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const pluginsDir = `${config.stateDir}/plugins`;
      const registryPath = `${pluginsDir}/registry.json`;
      yield* withStore((store) =>
        Effect.gen(function* () {
          yield* store.installFromAttachment({
            attachmentId: yield* putAttachment(zip(packageMembers(manifest()))),
            trustBackendAuthor: true,
          });
        }),
      );
      const registry = JSON.parse(yield* fileSystem.readFileString(registryPath));
      const original = JSON.stringify({ ...registry, plugins: [...registry.plugins, { bad: 1 }] });
      yield* fileSystem.writeFileString(registryPath, original);

      yield* withStore((store) =>
        Effect.gen(function* () {
          expect((yield* store.snapshot).installed.map((record) => record.pluginId)).toEqual([
            "echo",
          ]);
          yield* store.setEnabled("echo" as PluginId, false);
        }),
      );
      const backups = (yield* fileSystem.readDirectory(pluginsDir)).filter((name) =>
        name.startsWith("registry.json.corrupt-"),
      );
      expect(backups).toHaveLength(1);
      expect(yield* fileSystem.readFileString(`${pluginsDir}/${backups[0]}`)).toBe(original);

      yield* fileSystem.writeFileString(registryPath, "{not json");
      yield* TestClock.adjust("1 second");
      yield* withStore((store) =>
        Effect.gen(function* () {
          expect((yield* store.snapshot).installed).toEqual([]);
        }),
      );
      expect(
        (yield* fileSystem.readDirectory(pluginsDir)).filter((name) =>
          name.startsWith("registry.json.corrupt-"),
        ),
      ).toHaveLength(2);
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "corrupt saved settings fail reads with operation-failed and deleteData clears them",
    () =>
      withStore((store) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const pluginId = "echo" as PluginId;
          yield* store.installFromAttachment({
            attachmentId: yield* putAttachment(zip(packageMembers(manifest()))),
            trustBackendAuthor: true,
          });
          yield* store.writeConfig(pluginId, { token: "s3cret" });
          const { configPath } = store.paths(pluginId, "1.0.0");
          yield* fileSystem.writeFileString(configPath, "{not json");

          expect(yield* failureReason(store.readConfig(pluginId))).toBe("operation-failed");
          expect(yield* failureReason(store.runtimeConfig(pluginId))).toBe("operation-failed");
          yield* store.setEnabled(pluginId, false);
          yield* store.deleteData(pluginId);
          expect(yield* exists(configPath)).toBe(false);
          expect(Option.isNone(yield* secrets.get("plugin.echo.token"))).toBe(true);
        }),
      ).pipe(Effect.provide(baseLayer)),
  );

  it.effect("config reads never return secret values", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pluginId = "echo" as PluginId;
        yield* store.installFromAttachment({
          attachmentId: yield* putAttachment(zip(packageMembers(manifest()))),
          trustBackendAuthor: true,
        });

        expect(yield* store.readConfig(pluginId)).toEqual({
          values: { port: 8080 },
          secrets: { token: { set: false } },
        });
        yield* store.writeConfig(pluginId, { port: 9000, token: "s3cret" });
        const read = yield* store.readConfig(pluginId);
        expect(read).toEqual({ values: { port: 9000 }, secrets: { token: { set: true } } });
        expect(JSON.stringify(read)).not.toContain("s3cret");
        const { configPath } = store.paths(pluginId, "1.0.0");
        expect(yield* fileSystem.readFileString(configPath)).not.toContain("s3cret");
        expect(yield* store.runtimeConfig(pluginId)).toEqual({
          config: { port: 9000 },
          secrets: { token: "s3cret" },
        });

        expect(yield* failureReason(store.writeConfig(pluginId, { port: "nope" }))).toBe(
          "operation-failed",
        );
        expect(yield* failureReason(store.writeConfig(pluginId, { undeclared: 1 }))).toBe(
          "operation-failed",
        );

        yield* store.writeConfig(pluginId, { token: null, port: null });
        expect(yield* store.readConfig(pluginId)).toEqual({
          values: { port: 8080 },
          secrets: { token: { set: false } },
        });
      }),
    ).pipe(Effect.provide(baseLayer)),
  );
});
