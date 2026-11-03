import {
  PluginId,
  PluginInstallRecord,
  PluginManifest,
  type PluginRegistrySnapshot,
  PluginRequestError,
  type PluginSettingField,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { decodePluginManifest, isHostApiCompatible } from "@t3tools/shared/pluginManifest";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { openZipArchive } from "../zipArchive.ts";

const MANIFEST_FILE = "t3-plugin.json";
const PACKAGE_MAX_BYTES = 50 * 1024 * 1024;
const PACKAGE_MAX_ENTRIES = 2048;
const PACKAGE_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 256 * 1024;
const DETAIL_MAX_CHARS = 1024;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;

const SettingValue = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean]);
type SettingValue = typeof SettingValue.Type;

const StoredPlugin = Schema.Struct({
  pluginId: PluginId,
  version: Schema.String,
  enabled: Schema.Boolean,
  failedUpdate: PluginInstallRecord.fields.failedUpdate,
  manifest: PluginManifest,
});
type StoredPlugin = typeof StoredPlugin.Type;

const StoredRegistry = Schema.Struct({
  version: Schema.Literal(1),
  plugins: Schema.Array(Schema.Unknown),
});
const decodeStoredRegistry = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredRegistry));
const decodeStoredPlugin = Schema.decodeUnknownResult(StoredPlugin);

const StoredConfig = Schema.Struct({
  values: Schema.Record(Schema.String, SettingValue),
  secretKeys: Schema.Array(Schema.String),
});
type StoredConfig = typeof StoredConfig.Type;
const decodeStoredConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredConfig));
const EMPTY_CONFIG: StoredConfig = { values: {}, secretKeys: [] };

const isPluginId = Schema.is(PluginId);
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const requestError = (reason: PluginRequestError["reason"], detail?: string) =>
  new PluginRequestError({
    reason,
    ...(detail === undefined ? {} : { detail: detail.slice(0, DETAIL_MAX_CHARS) }),
  });

const decodeManifestText = (text: string) =>
  decodeJsonText(text).pipe(
    Effect.mapError(() => requestError("invalid-package", `${MANIFEST_FILE} is not valid JSON.`)),
    Effect.flatMap((json) => {
      const decoded = decodePluginManifest(json);
      return Result.isFailure(decoded)
        ? Effect.fail(requestError("invalid-package", decoded.failure))
        : Effect.succeed(decoded.success);
    }),
  );

const isSafeEntryName = (name: string) =>
  name.length > 0 &&
  name.length <= 256 &&
  !name.includes("\\") &&
  !name.includes(":") &&
  name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const toRecord = (plugin: StoredPlugin): PluginInstallRecord => ({
  pluginId: plugin.pluginId,
  version: plugin.version,
  name: plugin.manifest.name,
  author: plugin.manifest.author,
  enabled: plugin.enabled,
  status: plugin.enabled ? "stopped" : "disabled",
  ...(plugin.failedUpdate === undefined ? {} : { failedUpdate: plugin.failedUpdate }),
  manifest: plugin.manifest,
});

const settingValueProblem = (field: PluginSettingField, value: SettingValue) => {
  switch (field.type) {
    case "string":
    case "secret":
      return typeof value === "string" ? undefined : `Setting "${field.key}" must be a string.`;
    case "number":
      return typeof value === "number" ? undefined : `Setting "${field.key}" must be a number.`;
    case "boolean":
      return typeof value === "boolean" ? undefined : `Setting "${field.key}" must be a boolean.`;
    case "enum":
      return typeof value === "string" && field.options?.includes(value)
        ? undefined
        : `Setting "${field.key}" must be one of its options.`;
  }
};

export class PluginPackageStore extends Context.Service<
  PluginPackageStore,
  {
    readonly installFromAttachment: (input: {
      readonly attachmentId: string;
      readonly trustBackendAuthor: boolean;
    }) => Effect.Effect<
      { readonly record: PluginInstallRecord; readonly replaced: false },
      PluginRequestError
    >;
    /** Extracts a new version beside the active one; `commitVersion` activates it. */
    readonly stageUpdate: (input: {
      readonly pluginId: PluginId;
      readonly attachmentId: string;
      readonly trustBackendAuthor: boolean;
    }) => Effect.Effect<
      { readonly from: string; readonly to: string; readonly packageDir: string },
      PluginRequestError
    >;
    readonly commitVersion: (
      pluginId: PluginId,
      version: string,
    ) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    readonly markFailedUpdate: (
      pluginId: PluginId,
      failed: { readonly from: string; readonly to: string; readonly reason: string },
    ) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    /** A later clean start of the version a failed update left behind ends that warning. */
    readonly clearFailedUpdate: (pluginId: PluginId) => Effect.Effect<void, PluginRequestError>;
    readonly setEnabled: (
      pluginId: PluginId,
      enabled: boolean,
    ) => Effect.Effect<PluginInstallRecord, PluginRequestError>;
    /** Keeps `data/`, `config/` and secrets. */
    readonly uninstall: (pluginId: PluginId) => Effect.Effect<void, PluginRequestError>;
    /** Refused while the plugin is installed and enabled. */
    readonly deleteData: (pluginId: PluginId) => Effect.Effect<void, PluginRequestError>;
    /** `status` is "stopped" or "disabled"; the runtime status belongs to the worker supervisor. */
    readonly snapshot: Effect.Effect<PluginRegistrySnapshot>;
    readonly changes: Stream.Stream<PluginRegistrySnapshot>;
    readonly paths: (
      pluginId: PluginId,
      version: string,
    ) => { readonly packageDir: string; readonly dataDir: string; readonly configPath: string };
    readonly readConfig: (pluginId: PluginId) => Effect.Effect<
      {
        readonly values: Readonly<Record<string, SettingValue>>;
        readonly secrets: Readonly<Record<string, { readonly set: boolean }>>;
      },
      PluginRequestError
    >;
    /** `null` clears a value back to its default, or removes a secret. */
    readonly writeConfig: (
      pluginId: PluginId,
      values: Readonly<Record<string, SettingValue | null>>,
    ) => Effect.Effect<void, PluginRequestError>;
    /** Secret values in clear text, only for handing to the plugin's own worker. */
    readonly runtimeConfig: (pluginId: PluginId) => Effect.Effect<
      {
        readonly config: Readonly<Record<string, SettingValue>>;
        readonly secrets: Readonly<Record<string, string>>;
      },
      PluginRequestError
    >;
  }
>()("t3/plugins/PluginPackageStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const root = path.join(serverConfig.stateDir, "plugins");
  const registryPath = path.join(root, "registry.json");
  const packagesRoot = path.join(root, "packages");
  const dataRoot = path.join(root, "data");
  const configRoot = path.join(root, "config");
  const stagingRoot = path.join(root, "staging");

  const paths: PluginPackageStore["Service"]["paths"] = (pluginId, version) => ({
    packageDir: path.join(packagesRoot, pluginId, version),
    dataDir: path.join(dataRoot, pluginId),
    configPath: path.join(configRoot, `${pluginId}.json`),
  });
  const secretName = (pluginId: PluginId, key: string) => `plugin.${pluginId}.${key}`;

  const writeAtomically = (filePath: string, value: unknown) =>
    writeFileStringAtomically({ filePath, contents: `${JSON.stringify(value, null, 2)}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  let registryReadOnly = false;

  yield* fs.remove(stagingRoot, { recursive: true, force: true });
  yield* fs.makeDirectory(stagingRoot, { recursive: true });

  interface LoadedRegistry {
    readonly plugins: ReadonlyArray<StoredPlugin>;
    readonly skipped: number | "all";
  }
  const loaded = yield* fs.readFileString(registryPath).pipe(
    Effect.flatMap(decodeStoredRegistry),
    Effect.map((registry): LoadedRegistry => {
      const plugins: Array<StoredPlugin> = [];
      for (const entry of registry.plugins) {
        const decoded = decodeStoredPlugin(entry);
        if (Result.isSuccess(decoded)) plugins.push(decoded.success);
      }
      return { plugins, skipped: registry.plugins.length - plugins.length };
    }),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed<LoadedRegistry>({ plugins: [], skipped: 0 })
        : Effect.succeed<LoadedRegistry>({ plugins: [], skipped: "all" }),
    ),
  );
  const initialPlugins = loaded.plugins;
  // The next write replaces registry.json, so keep the unreadable original beside it first.
  if (loaded.skipped !== 0) {
    const backupPath = `${registryPath}.corrupt-${yield* Clock.currentTimeMillis}`;
    const backedUp = yield* fs.copyFile(registryPath, backupPath).pipe(Effect.isSuccess);
    yield* Effect.logWarning("Ignoring unreadable plugin registry entries.", {
      registryPath,
      skipped: loaded.skipped,
      ...(backedUp ? { backupPath } : {}),
    });
    if (!backedUp) registryReadOnly = true;
  }

  // The size is a hint, so an entry that cannot be read (a dangling link, a locked dir) counts 0.
  const fileBytes = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((info) => (info.type === "File" ? Number(info.size) : 0)),
      Effect.orElseSucceed(() => 0),
    );

  // Per-file helpers below share their caller's span.
  const directoryBytes = Effect.fnUntraced(function* (directory: string) {
    const names = yield* fs
      .readDirectory(directory, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    let bytes = 0;
    for (const name of names) bytes += yield* fileBytes(path.join(directory, name));
    return bytes;
  });

  const scanRetainedData = Effect.fnUntraced(function* (plugins: ReadonlyArray<StoredPlugin>) {
    const installed = new Set<string>(plugins.map((plugin) => plugin.pluginId));
    const listIds = (directory: string, suffix: string) =>
      fs.readDirectory(directory).pipe(
        Effect.map((names) =>
          names
            .filter((name) => name.endsWith(suffix))
            .map((name) => name.slice(0, name.length - suffix.length)),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
    const ids = new Set([
      ...(yield* listIds(dataRoot, "")),
      ...(yield* listIds(configRoot, ".json")),
    ]);
    const retained: Array<{ pluginId: PluginId; bytes: number }> = [];
    for (const id of [...ids].toSorted()) {
      if (!isPluginId(id) || installed.has(id)) continue;
      const { dataDir, configPath } = paths(id, "");
      const bytes = (yield* directoryBytes(dataDir)) + (yield* fileBytes(configPath));
      retained.push({ pluginId: id, bytes });
    }
    return retained;
  });

  const buildSnapshot = (plugins: ReadonlyArray<StoredPlugin>) =>
    scanRetainedData(plugins).pipe(
      Effect.map((retainedData): PluginRegistrySnapshot => ({
        installed: plugins.map(toRecord),
        retainedData,
      })),
    );

  const stored = yield* Ref.make(initialPlugins);
  const published = yield* SubscriptionRef.make(yield* buildSnapshot(initialPlugins));
  const registryLock = yield* Semaphore.make(1);
  const pluginLocks = yield* KeyedLock.make<PluginId>();

  const publish = Effect.flatMap(Ref.get(stored), buildSnapshot).pipe(
    Effect.flatMap((snapshot) => SubscriptionRef.set(published, snapshot)),
  );

  const updateRegistry = (
    update: (plugins: ReadonlyArray<StoredPlugin>) => ReadonlyArray<StoredPlugin>,
  ) =>
    registryLock.withPermit(
      Effect.gen(function* () {
        if (registryReadOnly) {
          return yield* requestError(
            "operation-failed",
            "The plugin registry could not be read or backed up; fix registry.json and restart.",
          );
        }
        const next = update(yield* Ref.get(stored));
        yield* writeAtomically(registryPath, { version: 1, plugins: next }).pipe(Effect.orDie);
        yield* Ref.set(stored, next);
        yield* publish;
      }),
    );

  const requireInstalled = (pluginId: PluginId) =>
    Ref.get(stored).pipe(
      Effect.flatMap((plugins) => {
        const plugin = plugins.find((candidate) => candidate.pluginId === pluginId);
        return plugin === undefined
          ? Effect.fail(requestError("not-installed"))
          : Effect.succeed(plugin);
      }),
    );

  const replacePlugin = (next: StoredPlugin) =>
    updateRegistry((plugins) =>
      plugins.map((plugin) => (plugin.pluginId === next.pluginId ? next : plugin)),
    ).pipe(Effect.as(toRecord(next)));

  const extractArchive = Effect.fn("PluginPackageStore.extractArchive")(function* (
    archivePath: string,
    target: string,
  ) {
    const archiveInfo = yield* fs.stat(archivePath).pipe(Effect.orDie);
    if (Number(archiveInfo.size) > PACKAGE_MAX_BYTES) {
      return yield* requestError("invalid-package", "The package is larger than 50 MiB.");
    }
    const archive = yield* openZipArchive(archivePath, (detail) =>
      requestError("invalid-package", detail),
    );
    if (archive.entryCount > PACKAGE_MAX_ENTRIES) {
      return yield* requestError("invalid-package", "The package has more than 2048 entries.");
    }
    const files = new Map<string, number>();
    const seen = new Set<string>();
    const parents = new Set<string>();
    let totalBytes = 0;
    for (;;) {
      const entry = yield* archive.next;
      if (entry === null) break;
      const isDirectory = entry.fileName.endsWith("/");
      const name = isDirectory ? entry.fileName.slice(0, -1) : entry.fileName;
      const unixType = (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
      if (!isSafeEntryName(name)) {
        return yield* requestError("invalid-package", `Unsafe archive path "${entry.fileName}".`);
      }
      if (isDirectory) {
        if (unixType !== 0 && unixType !== UNIX_DIRECTORY) {
          return yield* requestError("invalid-package", `Unsupported member "${entry.fileName}".`);
        }
        continue;
      }
      if (
        (unixType !== 0 && unixType !== UNIX_REGULAR_FILE) ||
        (entry.externalFileAttributes & 0x10) !== 0 ||
        (entry.generalPurposeBitFlag & 1) !== 0 ||
        ![0, 8].includes(entry.compressionMethod)
      ) {
        return yield* requestError(
          "invalid-package",
          `Links, encrypted, and unusual members are not allowed ("${name}").`,
        );
      }
      const key = name.toLowerCase();
      if (seen.has(key)) {
        return yield* requestError("invalid-package", `Duplicate archive member "${name}".`);
      }
      const ancestors = key
        .split("/")
        .slice(0, -1)
        .map((_, index, segments) => segments.slice(0, index + 1).join("/"));
      if (parents.has(key) || ancestors.some((ancestor) => seen.has(ancestor))) {
        return yield* requestError(
          "invalid-package",
          `Archive member "${name}" is both a file and a folder.`,
        );
      }
      seen.add(key);
      for (const ancestor of ancestors) parents.add(ancestor);
      totalBytes += entry.uncompressedSize;
      if (totalBytes > PACKAGE_MAX_UNCOMPRESSED_BYTES) {
        return yield* requestError("invalid-package", "The package expands to more than 100 MiB.");
      }
      files.set(name, entry.uncompressedSize);
      const destination = path.join(target, ...name.split("/"));
      yield* fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(Effect.orDie);
      // yauzl's validateEntrySizes fails the read when a member's bytes differ from its header.
      yield* Effect.gen(function* () {
        const readable = yield* archive.streamEntry(entry);
        yield* EffectNodeStream.fromReadable<Uint8Array, PluginRequestError>({
          evaluate: () => readable,
          onError: () => requestError("invalid-package", `Could not read "${name}".`),
        }).pipe(Stream.run(fs.sink(destination, { flag: "wx", mode: 0o600 })));
      }).pipe(Effect.scoped, Effect.catchTags({ PlatformError: (error) => Effect.die(error) }));
    }
    return files;
  });

  const readManifest = Effect.fn("PluginPackageStore.readManifest")(function* (
    packageDir: string,
    files: ReadonlyMap<string, number>,
  ) {
    const manifestBytes = files.get(MANIFEST_FILE);
    if (manifestBytes === undefined) {
      return yield* requestError("invalid-package", `The package has no ${MANIFEST_FILE}.`);
    }
    if (manifestBytes > MANIFEST_MAX_BYTES) {
      return yield* requestError("invalid-package", `${MANIFEST_FILE} is larger than 256 KiB.`);
    }
    const text = yield* fs.readFileString(path.join(packageDir, MANIFEST_FILE)).pipe(Effect.orDie);
    const manifest = yield* decodeManifestText(text);
    if (!isHostApiCompatible(manifest.hostApi)) {
      return yield* requestError(
        "incompatible-host-api",
        `The plugin needs host API ${manifest.hostApi}.`,
      );
    }
    const expected = new Set([MANIFEST_FILE]);
    for (const panel of manifest.ui?.panels ?? []) {
      const bytes = files.get(panel.entry);
      if (bytes === undefined) {
        return yield* requestError("invalid-package", `Panel entry "${panel.entry}" is missing.`);
      }
      if (bytes > MCP_APP_MAX_HTML_BYTES) {
        return yield* requestError("invalid-package", `Panel "${panel.entry}" exceeds 5 MiB.`);
      }
      expected.add(panel.entry);
    }
    if (manifest.backend !== undefined) {
      if (!files.has(manifest.backend.entry)) {
        return yield* requestError(
          "invalid-package",
          `Backend entry "${manifest.backend.entry}" is missing.`,
        );
      }
      expected.add(manifest.backend.entry);
    }
    for (const name of files.keys()) {
      if (!expected.has(name)) {
        return yield* requestError("invalid-package", `Unexpected package file "${name}".`);
      }
    }
    return manifest;
  });

  /** Extracts and validates into a staging directory the caller's scope removes. */
  const preparePackage = Effect.fn("PluginPackageStore.preparePackage")(function* (input: {
    readonly attachmentId: string;
    readonly trustBackendAuthor: boolean;
  }) {
    const archivePath = resolveAttachmentPathById({
      attachmentsDir: serverConfig.attachmentsDir,
      attachmentId: input.attachmentId,
    });
    if (archivePath === null) {
      return yield* requestError("invalid-package", "The uploaded package was not found.");
    }
    const stagingDir = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ directory: stagingRoot }).pipe(Effect.orDie),
      (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.ignore),
    );
    const files = yield* extractArchive(archivePath, stagingDir);
    const manifest = yield* readManifest(stagingDir, files);
    if (manifest.backend !== undefined && !input.trustBackendAuthor) {
      return yield* requestError(
        "capability-denied",
        "Installing a plugin backend requires trusting its author.",
      );
    }
    return { manifest, stagingDir };
  });

  const placePackage = (manifest: PluginManifest, stagingDir: string) => {
    const { packageDir } = paths(manifest.id, manifest.version);
    return Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(packageDir), { recursive: true });
      yield* fs.remove(packageDir, { recursive: true, force: true });
      yield* fs.rename(stagingDir, packageDir);
      return packageDir;
    }).pipe(Effect.orDie);
  };

  const installFromAttachment: PluginPackageStore["Service"]["installFromAttachment"] = Effect.fn(
    "PluginPackageStore.installFromAttachment",
  )(function* (input) {
    const { manifest, stagingDir } = yield* preparePackage(input);
    return yield* pluginLocks.withLock(
      manifest.id,
      Effect.gen(function* () {
        const existing = (yield* Ref.get(stored)).some((plugin) => plugin.pluginId === manifest.id);
        if (existing) {
          return yield* requestError(
            "invalid-package",
            `"${manifest.name}" is already installed. Update it instead.`,
          );
        }
        yield* placePackage(manifest, stagingDir);
        yield* fs
          .makeDirectory(paths(manifest.id, manifest.version).dataDir, { recursive: true })
          .pipe(Effect.orDie);
        const plugin: StoredPlugin = {
          pluginId: manifest.id,
          version: manifest.version,
          enabled: true,
          manifest,
        };
        yield* updateRegistry((plugins) => [...plugins, plugin]);
        return { record: toRecord(plugin), replaced: false as const };
      }),
    );
  }, Effect.scoped);

  const stageUpdate: PluginPackageStore["Service"]["stageUpdate"] = Effect.fn(
    "PluginPackageStore.stageUpdate",
  )(function* (input) {
    const { manifest, stagingDir } = yield* preparePackage(input);
    if (manifest.id !== input.pluginId) {
      return yield* requestError(
        "invalid-package",
        `The package is "${manifest.id}", not "${input.pluginId}".`,
      );
    }
    return yield* pluginLocks.withLock(
      input.pluginId,
      Effect.gen(function* () {
        const current = yield* requireInstalled(input.pluginId);
        if (current.version === manifest.version) {
          return yield* requestError(
            "invalid-package",
            `Version ${manifest.version} is already installed.`,
          );
        }
        const packageDir = yield* placePackage(manifest, stagingDir);
        return { from: current.version, to: manifest.version, packageDir };
      }),
    );
  }, Effect.scoped);

  const commitVersion: PluginPackageStore["Service"]["commitVersion"] = Effect.fn(
    "PluginPackageStore.commitVersion",
  )(function* (pluginId, version) {
    return yield* pluginLocks.withLock(
      pluginId,
      Effect.gen(function* () {
        const current = yield* requireInstalled(pluginId);
        const { packageDir } = paths(pluginId, version);
        const text = yield* fs
          .readFileString(path.join(packageDir, MANIFEST_FILE))
          .pipe(
            Effect.mapError(() =>
              requestError("invalid-package", `Version ${version} is not staged.`),
            ),
          );
        const manifest = yield* decodeManifestText(text);
        if (manifest.version !== version) {
          return yield* requestError("invalid-package", `Version ${version} is not staged.`);
        }
        const { failedUpdate: _previousFailure, ...rest } = current;
        const record = yield* replacePlugin({ ...rest, version, manifest });
        const pluginPackages = path.dirname(packageDir);
        const versions = yield* fs.readDirectory(pluginPackages).pipe(Effect.orDie);
        for (const other of versions) {
          if (other === version) continue;
          yield* fs
            .remove(path.join(pluginPackages, other), { recursive: true, force: true })
            .pipe(Effect.ignore({ log: true }));
        }
        return record;
      }),
    );
  });

  const markFailedUpdate: PluginPackageStore["Service"]["markFailedUpdate"] = Effect.fn(
    "PluginPackageStore.markFailedUpdate",
  )(function* (pluginId, failed) {
    return yield* pluginLocks.withLock(
      pluginId,
      Effect.gen(function* () {
        const current = yield* requireInstalled(pluginId);
        return yield* replacePlugin({
          ...current,
          failedUpdate: { ...failed, reason: failed.reason.slice(0, DETAIL_MAX_CHARS) },
        });
      }),
    );
  });

  const clearFailedUpdate: PluginPackageStore["Service"]["clearFailedUpdate"] = Effect.fn(
    "PluginPackageStore.clearFailedUpdate",
  )(function* (pluginId) {
    yield* pluginLocks.withLock(
      pluginId,
      Effect.gen(function* () {
        const { failedUpdate, ...rest } = yield* requireInstalled(pluginId);
        if (failedUpdate !== undefined && failedUpdate.to === rest.version) {
          yield* replacePlugin(rest);
        }
      }),
    );
  });

  const setEnabled: PluginPackageStore["Service"]["setEnabled"] = Effect.fn(
    "PluginPackageStore.setEnabled",
  )(function* (pluginId, enabled) {
    return yield* pluginLocks.withLock(
      pluginId,
      Effect.gen(function* () {
        const current = yield* requireInstalled(pluginId);
        if (current.enabled === enabled) return toRecord(current);
        return yield* replacePlugin({ ...current, enabled });
      }),
    );
  });

  const uninstall: PluginPackageStore["Service"]["uninstall"] = Effect.fn(
    "PluginPackageStore.uninstall",
  )(function* (pluginId) {
    yield* pluginLocks.withLock(
      pluginId,
      Effect.gen(function* () {
        yield* requireInstalled(pluginId);
        yield* updateRegistry((plugins) =>
          plugins.filter((plugin) => plugin.pluginId !== pluginId),
        );
        yield* fs
          .remove(path.join(packagesRoot, pluginId), { recursive: true, force: true })
          .pipe(Effect.orDie);
      }),
    );
  });

  const readStoredConfig = (pluginId: PluginId) =>
    fs.readFileString(paths(pluginId, "").configPath).pipe(
      Effect.flatMap(decodeStoredConfig),
      Effect.catch((error) =>
        error._tag === "PlatformError" && error.reason._tag === "NotFound"
          ? Effect.succeed(EMPTY_CONFIG)
          : Effect.fail(
              requestError("operation-failed", "The plugin's saved settings could not be read."),
            ),
      ),
    );

  const deleteData: PluginPackageStore["Service"]["deleteData"] = Effect.fn(
    "PluginPackageStore.deleteData",
  )(function* (pluginId) {
    yield* pluginLocks.withLock(
      pluginId,
      Effect.gen(function* () {
        const installed = (yield* Ref.get(stored)).find((plugin) => plugin.pluginId === pluginId);
        if (installed?.enabled) {
          return yield* requestError(
            "operation-failed",
            "Disable or uninstall the plugin before deleting its data.",
          );
        }
        const { dataDir, configPath } = paths(pluginId, "");
        // Unreadable settings must not block deleting them; fall back to the declared secrets.
        const secretKeys = yield* readStoredConfig(pluginId).pipe(
          Effect.map((config) => config.secretKeys),
          Effect.orElseSucceed(() =>
            installed === undefined
              ? []
              : environmentFields(installed).flatMap((field) =>
                  field.type === "secret" ? [field.key] : [],
                ),
          ),
        );
        for (const key of secretKeys) {
          yield* secretStore.remove(secretName(pluginId, key)).pipe(Effect.orDie);
        }
        yield* fs.remove(configPath, { force: true }).pipe(Effect.orDie);
        yield* fs.remove(dataDir, { recursive: true, force: true }).pipe(Effect.orDie);
        if (installed !== undefined) {
          yield* fs.makeDirectory(dataDir, { recursive: true }).pipe(Effect.orDie);
        }
        yield* registryLock.withPermit(publish);
      }),
    );
  });

  const environmentFields = (plugin: StoredPlugin) => plugin.manifest.settings?.environment ?? [];

  const currentValues = (plugin: StoredPlugin, config: StoredConfig) => {
    const values: Record<string, SettingValue> = {};
    for (const field of environmentFields(plugin)) {
      if (field.type === "secret") continue;
      const value = config.values[field.key] ?? field.default;
      if (value !== undefined) values[field.key] = value;
    }
    return values;
  };

  const readConfig: PluginPackageStore["Service"]["readConfig"] = Effect.fn(
    "PluginPackageStore.readConfig",
  )(function* (pluginId) {
    const plugin = yield* requireInstalled(pluginId);
    const config = yield* readStoredConfig(pluginId);
    const secrets: Record<string, { set: boolean }> = {};
    for (const field of environmentFields(plugin)) {
      if (field.type === "secret")
        secrets[field.key] = { set: config.secretKeys.includes(field.key) };
    }
    return { values: currentValues(plugin, config), secrets };
  });

  const writeConfig: PluginPackageStore["Service"]["writeConfig"] = Effect.fn(
    "PluginPackageStore.writeConfig",
  )(function* (pluginId, input) {
    yield* pluginLocks.withLock(
      pluginId,
      Effect.gen(function* () {
        const plugin = yield* requireInstalled(pluginId);
        const fields = new Map(environmentFields(plugin).map((field) => [field.key, field]));
        for (const [key, value] of Object.entries(input)) {
          const field = fields.get(key);
          if (field === undefined) {
            return yield* requestError("operation-failed", `Setting "${key}" is not declared.`);
          }
          const problem = value === null ? undefined : settingValueProblem(field, value);
          if (problem !== undefined) return yield* requestError("operation-failed", problem);
        }
        const config = yield* readStoredConfig(pluginId);
        const values = { ...config.values };
        const secretKeys = new Set(config.secretKeys);
        for (const [key, value] of Object.entries(input)) {
          if (fields.get(key)?.type === "secret") {
            const name = secretName(pluginId, key);
            if (value === null) {
              yield* secretStore.remove(name).pipe(Effect.orDie);
              secretKeys.delete(key);
            } else {
              yield* secretStore
                .set(name, new TextEncoder().encode(String(value)))
                .pipe(Effect.orDie);
              secretKeys.add(key);
            }
          } else if (value === null) {
            delete values[key];
          } else {
            values[key] = value;
          }
        }
        yield* writeAtomically(paths(pluginId, "").configPath, {
          values,
          secretKeys: [...secretKeys].toSorted(),
        }).pipe(Effect.orDie);
      }),
    );
  });

  const runtimeConfig: PluginPackageStore["Service"]["runtimeConfig"] = Effect.fn(
    "PluginPackageStore.runtimeConfig",
  )(function* (pluginId) {
    const plugin = yield* requireInstalled(pluginId);
    const config = yield* readStoredConfig(pluginId);
    const secrets: Record<string, string> = {};
    for (const field of environmentFields(plugin)) {
      if (field.type !== "secret" || !config.secretKeys.includes(field.key)) continue;
      const value = yield* secretStore.get(secretName(pluginId, field.key)).pipe(Effect.orDie);
      if (Option.isSome(value)) secrets[field.key] = new TextDecoder().decode(value.value);
    }
    return { config: currentValues(plugin, config), secrets };
  });

  return PluginPackageStore.of({
    installFromAttachment,
    stageUpdate,
    commitVersion,
    markFailedUpdate,
    clearFailedUpdate,
    setEnabled,
    uninstall,
    deleteData,
    snapshot: SubscriptionRef.get(published),
    changes: SubscriptionRef.changes(published),
    paths,
    readConfig,
    writeConfig,
    runtimeConfig,
  });
});

export const layer = Layer.effect(PluginPackageStore, make);
